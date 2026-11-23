import type { AxNode } from '@t3-tab/protocol';

/** Longest name kept for one node. The reader cuts what it prints; `find` searches all of this. */
const MAX_NAME = 8_000;
/** Once a page has sent this much name text, further names keep only `MIN_NAME` characters. */
const MAX_PAGE_TEXT = 2_000_000;
const MIN_NAME = 300;
const MAX_VALUE = 200;
const MAX_URL = 500;
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
  'url',
]);

/** What the browser says about one frame of the page. */
export interface FrameInfo {
  origin: string | undefined;
  loaderId?: string | undefined;
}

export interface FramePolicy {
  /** The approved origin of the main frame's document; only frames of this origin are kept. */
  origin: string;
  mainFrameId: string;
  frames: ReadonlyMap<string, FrameInfo>;
  /** The origin of the frame an `<iframe>` element holds, when its tree is not part of the page's. */
  ownerOrigin(backendId: number): Promise<string | undefined>;
}

const MAX_FRAME_LOOKUPS = 50;

/**
 * Restricts a raw accessibility tree to the main frame's document and the same-origin child frames below
 * it. A child frame of another origin, or one the browser cannot name, is dropped with everything in it,
 * and one line `frame omitted: <origin>` takes its place. Nodes the root does not reach are dropped.
 */
export async function restrictToOriginFrames(raw: unknown, policy: FramePolicy): Promise<unknown[]> {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of raw.slice(0, MAX_NODES)) {
    if (typeof item !== 'object' || item === null) continue;
    const node = item as Record<string, unknown>;
    if (typeof node.nodeId === 'string') byId.set(node.nodeId, node);
  }
  const first = raw.find((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).nodeId === 'string');
  if (first === undefined) return [];

  const kept: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const stack: Record<string, unknown>[] = [first];
  let omitted = 0;
  let lookups = 0;
  let overflow = 0;
  let overflowParent: Record<string, unknown> | undefined;
  const marker = (text: string): Record<string, unknown> => ({
    nodeId: `frame-omitted-${(omitted += 1)}`,
    ignored: false,
    role: { type: 'role', value: 'group' },
    name: { type: 'computedString', value: text },
    childIds: [],
  });

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined || typeof node.nodeId !== 'string' || seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    const childIds = Array.isArray(node.childIds) ? node.childIds.filter((id): id is string => typeof id === 'string') : [];
    const keptIds: string[] = [];
    const toVisit: Record<string, unknown>[] = [];
    const extra: Record<string, unknown>[] = [];
    for (const id of childIds) {
      const child = byId.get(id);
      if (child === undefined) continue;
      const frameId = typeof child.frameId === 'string' ? child.frameId : undefined;
      if (frameId !== undefined && frameId !== policy.mainFrameId && policy.frames.get(frameId)?.origin !== policy.origin) {
        extra.push(marker(`frame omitted: ${originLabel(policy.frames.get(frameId)?.origin)}`));
        continue;
      }
      keptIds.push(id);
      toVisit.push(child);
    }
    if (childIds.length === 0 && axString(node.role) === 'Iframe' && typeof node.backendDOMNodeId === 'number') {
      if (lookups < MAX_FRAME_LOOKUPS) {
        lookups += 1;
        const origin = await policy.ownerOrigin(node.backendDOMNodeId);
        if (origin !== policy.origin) extra.push(marker(`frame omitted: ${originLabel(origin)}`));
      } else {
        overflow += 1;
        overflowParent = node;
      }
    }
    node.childIds = [...keptIds, ...extra.map((mark) => mark.nodeId as string)];
    kept.push(node, ...extra);
    // The stack pops last in first out; push in reverse so the nodes are visited in document order.
    stack.push(...toVisit.reverse());
  }
  if (overflow > 0 && overflowParent !== undefined) {
    const more = marker(`${overflow} more frames omitted`);
    overflowParent.childIds = [more.nodeId as string];
    kept.push(more);
  }
  return kept;
}

function originLabel(origin: string | undefined): string {
  return origin === undefined || origin === '' || origin === 'null' || origin === '://' ? 'unknown origin' : origin;
}

/**
 * Trims the nodes of `Accessibility.getFullAXTree` to what the page reader uses, so a large page
 * stays small on the link to the background program. Ignored nodes keep only their children.
 */
export function slimAxNodes(raw: unknown): AxNode[] {
  if (!Array.isArray(raw)) return [];
  const nodes: AxNode[] = [];
  let textLeft = MAX_PAGE_TEXT;
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
    const role = axString(node.role);
    // The same text again, split at line wraps; the reader never prints these.
    if (role === 'InlineTextBox') continue;
    const name = cut(axString(node.name), Math.max(MIN_NAME, Math.min(MAX_NAME, textLeft)));
    textLeft -= name.length;
    const slim: AxNode = { id: node.nodeId, role, name, children };
    const value = cut(axString(node.value), MAX_VALUE);
    if (value !== '') slim.value = value;
    if (typeof node.backendDOMNodeId === 'number') slim.backendId = node.backendDOMNodeId;
    const props = slimProps(node.properties);
    if (props !== undefined) {
      // Only a link's address is printed, and it is cut like any other text.
      if (role.toLowerCase() !== 'link') delete props.url;
      else if (typeof props.url === 'string') props.url = cut(props.url, MAX_URL);
      if (Object.keys(props).length > 0) slim.props = props;
    }
    nodes.push(slim);
  }
  return nodes;
}

/** Text at most `max` characters long, its last one a mark when anything was cut. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
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
