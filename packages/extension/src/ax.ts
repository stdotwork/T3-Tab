import type { AxNode } from '@t3-tab/protocol';

const MAX_NAME = 300;
const MAX_VALUE = 200;
const MAX_NODES = 60_000;
/** The only accessibility properties the reader prints. */
const KEPT_PROPS = new Set([
  'checked',
  'disabled',
  'expanded',
  'selected',
  'pressed',
  'required',
  'readonly',
  'invalid',
  'level',
]);

/**
 * Trims the nodes of `Accessibility.getFullAXTree` to what the page reader uses, so a large page
 * stays small on the link to the background program. Ignored nodes keep only their children.
 */
export function slimAxNodes(raw: unknown): AxNode[] {
  if (!Array.isArray(raw)) return [];
  const nodes: AxNode[] = [];
  for (const item of raw.slice(0, MAX_NODES)) {
    if (typeof item !== 'object' || item === null) continue;
    const node = item as Record<string, unknown>;
    if (typeof node.nodeId !== 'string') continue;
    const children = Array.isArray(node.childIds)
      ? node.childIds.filter((child): child is string => typeof child === 'string')
      : [];
    if (node.ignored === true) {
      nodes.push({ id: node.nodeId, role: '', name: '', ignored: true, children });
      continue;
    }
    const slim: AxNode = {
      id: node.nodeId,
      role: axString(node.role),
      name: axString(node.name).slice(0, MAX_NAME),
      children,
    };
    const value = axString(node.value).slice(0, MAX_VALUE);
    if (value !== '') slim.value = value;
    if (typeof node.backendDOMNodeId === 'number') slim.backendId = node.backendDOMNodeId;
    const props = slimProps(node.properties);
    if (props !== undefined) slim.props = props;
    nodes.push(slim);
  }
  return nodes;
}

function axString(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const inner = (value as Record<string, unknown>).value;
  return typeof inner === 'string' ? inner : typeof inner === 'number' ? String(inner) : '';
}

function slimProps(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!Array.isArray(value)) return undefined;
  const props: Record<string, string | number | boolean> = {};
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const property = item as Record<string, unknown>;
    if (typeof property.name !== 'string' || !KEPT_PROPS.has(property.name)) continue;
    if (typeof property.value !== 'object' || property.value === null) continue;
    const inner = (property.value as Record<string, unknown>).value;
    if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') {
      props[property.name] = inner;
    }
  }
  return Object.keys(props).length === 0 ? undefined : props;
}
