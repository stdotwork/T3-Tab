import type { AxNode } from '@t3-tab/protocol';

const INSPECT_BATCH_SIZE = 25;
/** What stands in a name for the part of it that came from a hidden field. */
const HIDDEN = '<redacted>';

/** The roles whose value the reader prints. Whatever else an element is, its value never reaches the reader. */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'textfield']);

function looksMaskedValue(value: string | undefined): boolean {
  return value !== undefined && value !== '' && /^•+$/.test(value);
}

/**
 * Says for each element, by DOM node id, whether its value must not be read: a password input (by its `type`, whatever
 * its ARIA role), or a field a style masks (`-webkit-text-security`). Answers come in the order asked.
 */
export type InspectFields = (backendIds: number[]) => Promise<boolean[]>;

/**
 * The DOM node ids of the elements that take their name from one of the given fields without containing it: those an
 * `aria-labelledby` points at the field or at something around it, and the control a label around the field belongs to.
 */
export type NamedFrom = (backendIds: number[]) => Promise<number[]>;

export interface RedactionOptions {
  batchSize?: number;
  namedFrom?: NamedFrom;
}

/**
 * Removes secret values before the AX tree crosses the extension boundary, and returns the nodes to send.
 *
 * A node is redacted when it is a field the reader prints a value for (textbox, searchbox, combobox, spinbutton,
 * slider) that `inspect` flags, or any node of any role whose value is a run of password bullets, which is how the
 * browser shows a password input's value whatever role the page gave it. Bullet values are handled without a DOM round
 * trip; the remaining fields are inspected in bounded batches. A field that cannot be inspected is redacted rather than
 * risking a leak. A redacted node loses its value and its children, because the bullets the browser draws for a
 * password sit in a text child that would show the value's length.
 *
 * The browser also puts a field's value into the names of other elements: of the button, link, heading or cell the
 * field sits in (names come from content), of an element an `aria-labelledby` or a label ties to it. In each such
 * name the value is replaced by `<redacted>`, or the whole name is when it cannot be told apart.
 */
export async function redactPasswordValues(
  nodes: AxNode[],
  inspect: InspectFields,
  options: RedactionOptions = {},
): Promise<AxNode[]> {
  const batchSize = options.batchSize ?? INSPECT_BATCH_SIZE;
  const redacted: AxNode[] = [];
  const needInspection: AxNode[] = [];
  for (const node of nodes) {
    if (node.ignored === true) continue;
    if (looksMaskedValue(node.value)) redacted.push(node);
    else if (VALUE_ROLES.has(node.role.toLowerCase())) {
      if (node.backendId === undefined) redacted.push(node);
      else needInspection.push(node);
    }
  }
  for (let start = 0; start < needInspection.length; start += batchSize) {
    const batch = needInspection.slice(start, start + batchSize);
    let flagged: boolean[] | undefined;
    try {
      flagged = await inspect(batch.map((node) => node.backendId ?? -1));
    } catch {
      // Fail closed: a field we cannot classify never carries its value into the reader.
    }
    batch.forEach((node, index) => {
      if (flagged?.[index] !== false) redacted.push(node);
    });
  }
  if (redacted.length === 0) return nodes;

  // What each secret looked like in other names, taken before the value is removed.
  const secrets = redacted.flatMap((node) => {
    const needle = needleFor(node.value);
    return needle === undefined ? [] : [{ node, needle }];
  });
  const needles = [...new Set(secrets.map((secret) => secret.needle))];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map<string, AxNode>();
  for (const node of nodes) for (const child of node.children) if (!parents.has(child)) parents.set(child, node);

  const gone = new Set<string>();
  for (const node of redacted) {
    const stack = [...node.children];
    while (stack.length > 0) {
      const id = stack.pop();
      const child = id === undefined ? undefined : byId.get(id);
      if (id === undefined || child === undefined || gone.has(id)) continue;
      gone.add(id);
      stack.push(...child.children);
    }
    delete node.value;
    node.children = [];
    node.props = { ...node.props, password: true };
  }

  if (secrets.length > 0) {
    // Names that come from content: the elements around the field.
    for (const { node, needle } of secrets) {
      for (let up = parents.get(node.id); up !== undefined; up = parents.get(up.id)) scrub(up, [needle], false);
      scrub(node, [needle], false);
    }
    // Names that come from a field named by reference: found in the page, since the tree does not say where a name came from.
    let named: number[] | undefined;
    const backendIds = secrets.flatMap(({ node }) => (node.backendId === undefined ? [] : [node.backendId]));
    if (options.namedFrom !== undefined && backendIds.length > 0) {
      try {
        named = await options.namedFrom(backendIds);
      } catch {
        named = undefined;
      }
    }
    if (named === undefined) {
      // Fail closed: wherever a name carries a secret, it goes, whether or not it was meant to.
      for (const node of nodes) scrub(node, needles, false);
    } else {
      const wanted = new Set(named);
      for (const node of nodes) if (node.backendId !== undefined && wanted.has(node.backendId)) scrub(node, needles, true);
    }
  }
  return gone.size === 0 ? nodes : nodes.filter((node) => !gone.has(node.id));
}

/** The text of a value as it appears in a name: whitespace collapsed, and a value the extension cut without its mark. */
function needleFor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = collapse(value.endsWith('…') ? value.slice(0, -1) : value);
  return text === '' ? undefined : text;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Replaces each needle found in the node's name; with `wholeName`, a name that holds none of them is replaced entire. */
function scrub(node: AxNode, needles: string[], wholeName: boolean): void {
  if (node.ignored === true || node.name === '' || needles.length === 0) return;
  const name = collapse(node.name);
  // One pass, longest first, so a short value inside a longer one and the marker itself are never matched again.
  const pattern = new RegExp(
    [...needles]
      .sort((a, b) => b.length - a.length)
      .map((needle) => needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'g',
  );
  const scrubbed = name.replace(pattern, HIDDEN);
  if (scrubbed !== name) node.name = scrubbed;
  else if (wholeName) node.name = HIDDEN;
}
