import { axString, VALUE_ROLES } from './ax';

const INSPECT_BATCH_SIZE = 25;
/** What stands in a name for the part of it that came from a hidden field. */
const HIDDEN = '<redacted>';
/** A value shorter than this is only replaced as a whole word, so a one-digit PIN does not cut every name that has the digit. */
const MIN_SUBSTRING = 4;

type RawNode = Record<string, unknown>;

function looksMaskedValue(value: string): boolean {
  return value !== '' && /^•+$/.test(value);
}

/**
 * Says for each field, by DOM node id, whether its value must not be read: a password input (by its `type`, whatever its
 * ARIA role), a field a style masks (`-webkit-text-security`), or one that asks the browser to treat it as a secret by its
 * `autocomplete` (`current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`), which also covers a password
 * field a show-password toggle turned into plain text. Answers come in the order asked; `undefined` is a field that could not be checked.
 */
export type InspectFields = (backendIds: number[]) => Promise<Array<boolean | undefined>>;

/**
 * Removes secret values from the raw accessibility tree before it is trimmed and leaves the extension, and returns the
 * nodes to keep.
 *
 * A node is redacted when it is a field the reader prints a value for (textbox, searchbox, combobox, spinbutton, slider)
 * that `inspect` flags, or any node of any role whose value is a run of password bullets, which is how the browser shows a
 * password input's value whatever role the page gave it. Bullet values are handled without a DOM round trip; the other
 * fields are inspected in bounded batches. A field that cannot be inspected is redacted rather than risking a leak. A
 * redacted node loses its value and its children, because the bullets the browser draws for a password are a text child
 * that would show the value's length.
 *
 * The browser also puts a field's value into other names: the button, link, heading or cell around the field (names from
 * content), and any element an `aria-labelledby`, a script's `ariaLabelledByElements` or a `<label for>` ties to the
 * field or to something around it. The tree says which nodes a name was built from (`relatedNodes` of its sources), so a
 * name built from a field, or from an element around one, has the value replaced by `<redacted>`, or is replaced whole
 * when the value is not found in it or a node it was built from is not in the tree. Values are taken whole, before any cut.
 */
export async function redactPasswordValues(
  raw: unknown[],
  inspect: InspectFields,
  batchSize = INSPECT_BATCH_SIZE,
): Promise<unknown[]> {
  const nodes = raw.filter((item): item is RawNode => typeof item === 'object' && item !== null);
  const roleOf = (node: RawNode): string => axString(node.role).toLowerCase();
  /** Confirmed secrets: their values are what to look for in other names. */
  const confirmed = new Set<RawNode>();
  /** Fields hidden because they could not be checked; nothing is looked for in names from them. */
  const unchecked = new Set<RawNode>();
  const needInspection: RawNode[] = [];
  for (const node of nodes) {
    if (node.ignored === true) continue;
    if (looksMaskedValue(axString(node.value))) confirmed.add(node);
    else if (VALUE_ROLES.has(roleOf(node))) {
      if (typeof node.backendDOMNodeId === 'number') needInspection.push(node);
      else unchecked.add(node);
    }
  }
  for (let start = 0; start < needInspection.length; start += batchSize) {
    const batch = needInspection.slice(start, start + batchSize);
    let flagged: Array<boolean | undefined> | undefined;
    try {
      flagged = await inspect(batch.map((node) => node.backendDOMNodeId as number));
    } catch {
      // Fail closed: a field we cannot classify never carries its value into the reader.
    }
    batch.forEach((node, index) => {
      const answer = flagged?.[index];
      if (answer === true) confirmed.add(node);
      else if (answer !== false) unchecked.add(node);
    });
  }
  const hidden = new Set<RawNode>([...confirmed, ...unchecked]);
  if (hidden.size === 0) return raw;

  const byNodeId = new Map<string, RawNode>();
  const byBackendId = new Map<number, RawNode>();
  const parents = new Map<string, RawNode>();
  for (const node of nodes) {
    if (typeof node.nodeId === 'string') byNodeId.set(node.nodeId, node);
    if (typeof node.backendDOMNodeId === 'number') byBackendId.set(node.backendDOMNodeId, node);
    for (const child of childIds(node)) if (!parents.has(child) && typeof node.nodeId === 'string') parents.set(child, node);
  }

  // Taken before the values are removed: what each confirmed secret looks like in other names.
  const needleOf = new Map<RawNode, string>();
  for (const node of confirmed) {
    const needle = collapse(axString(node.value));
    if (needle !== '') needleOf.set(node, needle);
  }
  // The nodes around each hidden field, and by DOM id the fields below each node.
  const above = new Map<RawNode, Set<RawNode>>();
  const fieldsBelow = new Map<number, Set<RawNode>>();
  for (const field of hidden) {
    for (let node: RawNode | undefined = field; node !== undefined; node = parents.get(String(node.nodeId))) {
      if (node !== field) above.set(node, (above.get(node) ?? new Set()).add(field));
      if (typeof node.backendDOMNodeId === 'number') {
        fieldsBelow.set(node.backendDOMNodeId, (fieldsBelow.get(node.backendDOMNodeId) ?? new Set()).add(field));
      }
    }
  }

  // One decision per name, made on the unscrubbed tree, applied in one pass.
  const plans = new Map<RawNode, { needles: Set<string>; whole: boolean }>();
  const plan = (node: RawNode): { needles: Set<string>; whole: boolean } => {
    let entry = plans.get(node);
    if (entry === undefined) plans.set(node, (entry = { needles: new Set(), whole: false }));
    return entry;
  };
  for (const [node, fields] of above) {
    if (node.ignored === true) continue;
    for (const field of fields) {
      const needle = needleOf.get(field);
      if (needle !== undefined) plan(node).needles.add(needle);
    }
  }
  for (const node of nodes) {
    if (node.ignored === true) continue;
    for (const related of relatedNodeIds(node)) {
      const under = fieldsBelow.get(related);
      if (under === undefined) {
        // A node the tree does not hold: it may be, or hold, a hidden field, so the name cannot be trusted.
        if (!byBackendId.has(related)) plan(node).whole = true;
        continue;
      }
      for (const field of under) {
        // The label around a field is not part of the field's own name; a field that names itself is.
        if (field === node && related !== node.backendDOMNodeId) continue;
        const entry = plan(node);
        entry.whole = true;
        const needle = needleOf.get(field);
        if (needle !== undefined) entry.needles.add(needle);
      }
    }
  }

  const gone = new Set<string>();
  for (const field of hidden) {
    const stack = [...childIds(field)];
    while (stack.length > 0) {
      const id = stack.pop();
      const child = id === undefined ? undefined : byNodeId.get(id);
      if (id === undefined || child === undefined || gone.has(id)) continue;
      gone.add(id);
      stack.push(...childIds(child));
    }
    delete field.value;
    field.childIds = [];
    field.t3Password = true;
  }
  for (const [node, { needles, whole }] of plans) {
    const name = typeof node.name === 'object' && node.name !== null ? (node.name as RawNode) : undefined;
    const text = axString(name);
    if (name === undefined || text === '') continue;
    const scrubbed = replaceNeedles(collapse(text), needles);
    const next = scrubbed !== undefined ? scrubbed : whole ? HIDDEN : undefined;
    if (next !== undefined) node.name = { ...name, value: next };
  }
  return gone.size === 0 ? raw : raw.filter((item) => typeof item !== 'object' || item === null || !gone.has(String((item as RawNode).nodeId)));
}

function childIds(node: RawNode): string[] {
  return Array.isArray(node.childIds) ? node.childIds.filter((id): id is string => typeof id === 'string') : [];
}

/** The DOM ids of every node a name was built from, by any of its sources that the browser did not set aside. */
function relatedNodeIds(node: RawNode): number[] {
  const name = node.name as { sources?: unknown } | undefined;
  if (!Array.isArray(name?.sources)) return [];
  const ids: number[] = [];
  for (const source of name.sources as RawNode[]) {
    if (typeof source !== 'object' || source === null || source.superseded === true) continue;
    for (const key of ['attributeValue', 'nativeSourceValue', 'value']) {
      const related = (source[key] as { relatedNodes?: unknown } | undefined)?.relatedNodes;
      if (!Array.isArray(related)) continue;
      for (const item of related as RawNode[]) if (typeof item?.backendDOMNodeId === 'number') ids.push(item.backendDOMNodeId);
    }
  }
  return ids;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The name with each needle replaced in one pass (longest first), or `undefined` when none was found. */
function replaceNeedles(name: string, needles: Set<string>): string | undefined {
  if (needles.size === 0) return undefined;
  const parts = [...needles]
    .sort((a, b) => b.length - a.length)
    .map((needle) => {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return needle.length >= MIN_SUBSTRING ? escaped : `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
    });
  const scrubbed = name.replace(new RegExp(parts.join('|'), 'gu'), HIDDEN);
  return scrubbed === name ? undefined : scrubbed;
}
