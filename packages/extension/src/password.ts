import type { AxNode } from '@t3-tab/protocol';

const INSPECT_BATCH_SIZE = 25;

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
 * Removes secret values before the AX tree crosses the extension boundary, and returns the nodes to send.
 *
 * A node is redacted when it is a field the reader prints a value for (textbox, searchbox, combobox, spinbutton,
 * slider) that `inspect` flags, or any node of any role whose value is a run of password bullets, which is how the
 * browser shows a password input's value whatever role the page gave it. Bullet values are handled without a DOM round
 * trip; the remaining fields are inspected in bounded batches. A field that cannot be inspected is redacted rather than
 * risking a leak. A redacted node loses its value and its children, because the bullets the browser draws for a
 * password sit in a text child that would show the value's length.
 */
export async function redactPasswordValues(
  nodes: AxNode[],
  inspect: InspectFields,
  batchSize = INSPECT_BATCH_SIZE,
): Promise<AxNode[]> {
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
  const gone = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
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
  return gone.size === 0 ? nodes : nodes.filter((node) => !gone.has(node.id));
}
