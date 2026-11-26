import { axString, VALUE_ROLES } from './ax';

const INSPECT_BATCH_SIZE = 25;
/** The most nodes inside hidden or ignored content one read looks into; names built from what is left are hidden whole. */
const MAX_IGNORED_INSPECTED = 1_000;
/** What stands in a name for the part of it that came from a hidden field. */
const HIDDEN = '<redacted>';
/** A value shorter than this is only replaced as a whole word, in names tied to its field; it is not searched for page-wide. */
const MIN_SUBSTRING = 4;

type RawNode = Record<string, unknown>;

/** What the page says about one field: whether it holds a secret, and the value it really holds. */
export interface FieldAnswer {
  secret: boolean;
  value?: string | undefined;
}

/**
 * Asks about fields by DOM node id, in the order given: a password input (by its `type`, whatever its ARIA role), a field a
 * style masks (`-webkit-text-security`), or one whose `autocomplete` marks a secret (`current-password`, `new-password`,
 * `one-time-code`, `cc-number`, `cc-csc`), with the value the field holds. `undefined` is a field that could not be checked.
 */
export type InspectFields = (backendIds: number[]) => Promise<Array<FieldAnswer | undefined>>;

export interface RedactionOptions {
  batchSize?: number;
  maxIgnored?: number;
  /** An error that must stop the read instead of being taken for a field that could not be checked. */
  rethrow?: (error: unknown) => boolean;
}

interface Taint {
  needles: Set<string>;
  /** The name is replaced whole when no value is found in it. */
  whole: boolean;
  /** The name holds something hidden that cannot be told apart. */
  opaque: boolean;
}

/**
 * Removes secret values from the raw accessibility tree before it is trimmed and leaves the extension, and returns the
 * nodes to keep.
 *
 * Every node that holds a value, and every field the reader prints a value for (textbox, searchbox, combobox, spinbutton,
 * slider), is checked with `inspect`: whatever its role, a field that is a password input, masked, or marked secret by its
 * `autocomplete` has its value removed (the line renders as `value=<redacted>`, with no length) and loses its children, which
 * hold the bullets the browser draws. A run of password bullets as a value is redacted without asking. A field that cannot
 * be checked is redacted too, and its value is looked for like a secret's. The nodes inside any element a name was built
 * from that the tree leaves out as ignored (hidden, `aria-hidden`, a closed dialog) are checked as well, since a name still
 * holds what is in them.
 *
 * The browser puts a field's value into other names, so each secret is followed wherever it can have gone: into the names
 * of the elements around the field (built from content), and into every name whose sources list the field or an element
 * around it (`aria-labelledby`, a script's `ariaLabelledByElements`, `<label for>`). A name that took in a hidden value
 * passes it on in the same two ways, until nothing new is reached. In each such name the value is replaced by `<redacted>`,
 * or the name is replaced whole when the value is not found in it or a node it was built from is not in the tree.
 *
 * Last, as a net for paths not modelled, every value of four characters or more is replaced in every name, value and
 * address on the page. Values are taken whole, before any cut.
 */
export async function redactPasswordValues(
  raw: unknown[],
  inspect: InspectFields,
  options: RedactionOptions = {},
): Promise<unknown[]> {
  const batchSize = options.batchSize ?? INSPECT_BATCH_SIZE;
  const nodes = raw.filter((item): item is RawNode => typeof item === 'object' && item !== null);
  const roleOf = (node: RawNode): string => axString(node.role).toLowerCase();
  const backendOf = (node: RawNode): number | undefined => (typeof node.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined);

  const byNodeId = new Map<string, RawNode>();
  const byBackendId = new Map<number, RawNode>();
  const parents = new Map<string, RawNode>();
  for (const node of nodes) {
    if (typeof node.nodeId === 'string') byNodeId.set(node.nodeId, node);
    const backend = backendOf(node);
    if (backend !== undefined) byBackendId.set(backend, node);
    for (const child of childIds(node)) if (!parents.has(child) && typeof node.nodeId === 'string') parents.set(child, node);
  }
  const chainOf = (node: RawNode): RawNode[] => {
    const chain: RawNode[] = [];
    for (let at: RawNode | undefined = node; at !== undefined && chain.length < 10_000; at = parents.get(String(at.nodeId))) chain.push(at);
    return chain;
  };

  // The nodes some name was built from, by DOM id.
  const relatedBy = new Map<number, Set<RawNode>>();
  for (const node of nodes) {
    if (node.ignored === true) continue;
    for (const related of relatedNodeIds(node)) relatedBy.set(related, (relatedBy.get(related) ?? new Set()).add(node));
  }

  // 1. Every field whose value could be a secret, and the content hidden inside what names were built from.
  const candidates: RawNode[] = [];
  for (const node of nodes) {
    if (node.ignored === true) continue;
    if (axString(node.value) !== '' || VALUE_ROLES.has(roleOf(node))) candidates.push(node);
  }
  const ignoredInside: RawNode[] = [];
  const unseen = new Set<number>();
  const limit = options.maxIgnored ?? MAX_IGNORED_INSPECTED;
  const seenIgnored = new Set<RawNode>();
  for (const target of relatedBy.keys()) {
    const start = byBackendId.get(target);
    if (start === undefined) continue;
    const stack = [start];
    const visited = new Set<RawNode>();
    while (stack.length > 0) {
      const at = stack.pop();
      if (at === undefined || visited.has(at)) continue;
      visited.add(at);
      if (at.ignored === true && backendOf(at) !== undefined && !seenIgnored.has(at)) {
        if (ignoredInside.length >= limit) {
          unseen.add(target);
          break;
        }
        seenIgnored.add(at);
        ignoredInside.push(at);
      }
      for (const child of childIds(at)) {
        const next = byNodeId.get(child);
        if (next !== undefined) stack.push(next);
      }
    }
  }

  const answers = new Map<RawNode, FieldAnswer | undefined>();
  /** Asks about the nodes; true when a batch could not be asked. */
  const askAbout = async (list: RawNode[]): Promise<boolean> => {
    let failed = false;
    for (let start = 0; start < list.length; start += batchSize) {
      const batch = list.slice(start, start + batchSize);
      let result: Array<FieldAnswer | undefined> | undefined;
      try {
        result = await inspect(batch.map((node) => backendOf(node) ?? -1));
      } catch (error) {
        if (options.rethrow?.(error) === true) throw error;
        failed = true;
      }
      batch.forEach((node, index) => answers.set(node, result?.[index]));
    }
    return failed;
  };
  await askAbout(candidates.filter((node) => backendOf(node) !== undefined));
  // What is inside a name's sources but out of sight is checked too; if that cannot be done, those names cannot be trusted.
  const ignoredFailed = await askAbout(ignoredInside);
  if (ignoredFailed) for (const target of relatedBy.keys()) unseen.add(target);

  /** Hidden fields by node, with the values to look for in other text. */
  const fields = new Map<RawNode, Set<string>>();
  /** The ones whose value is removed from the output. */
  const removed = new Set<RawNode>();
  const addField = (node: RawNode, ...values: Array<string | undefined>): void => {
    const needles = fields.get(node) ?? new Set<string>();
    for (const value of values) {
      const needle = value === undefined ? '' : collapse(value);
      if (needle !== '') needles.add(needle);
    }
    fields.set(node, needles);
  };
  for (const node of candidates) {
    const answer = answers.get(node);
    const value = axString(node.value);
    if (looksMaskedValue(value) || answer?.secret === true) {
      addField(node, value, answer?.value);
      removed.add(node);
    } else if (answer === undefined && VALUE_ROLES.has(roleOf(node))) {
      // Fail closed: a field we cannot classify never carries its value into the reader.
      addField(node, value);
      removed.add(node);
    }
  }
  for (const node of ignoredInside) {
    const answer = answers.get(node);
    if (answer?.secret === true) addField(node, answer.value);
  }
  const trouble = unseen.size > 0 && (fields.size > 0 || ignoredFailed);
  if (fields.size === 0 && !trouble) return raw;

  // 2. Follow each secret into the names that took it in, until nothing new is reached.
  const taints = new Map<RawNode, Taint>();
  const queue: Array<{ node: RawNode; needles: Set<string>; opaque: boolean }> = [];
  const hasContentsSource = (node: RawNode): boolean => {
    const sources = (node.name as { sources?: unknown } | undefined)?.sources;
    return (
      Array.isArray(sources) &&
      (sources as RawNode[]).some((source) => typeof source === 'object' && source !== null && source.superseded !== true && source.type === 'contents')
    );
  };
  const nameOf = (node: RawNode): string => collapse(axString(node.name));
  const taint = (node: RawNode, needles: Set<string>, whole: boolean, opaque: boolean): void => {
    if (node.ignored === true || nameOf(node) === '') return;
    let entry = taints.get(node);
    if (entry === undefined) taints.set(node, (entry = { needles: new Set(), whole: false, opaque: false }));
    const before = `${entry.needles.size}${entry.whole}${entry.opaque}`;
    for (const needle of needles) entry.needles.add(needle);
    if (whole) entry.whole = true;
    if (opaque || (entry.whole && replaceNeedles(nameOf(node), entry.needles) === undefined)) entry.opaque = true;
    if (before !== `${entry.needles.size}${entry.whole}${entry.opaque}`) queue.push({ node, needles: entry.needles, opaque: entry.opaque });
  };
  const emit = (source: RawNode, needles: Set<string>, opaque: boolean): void => {
    if (needles.size === 0 && !opaque) return;
    // Names built from content hold what is inside them.
    for (const above of chainOf(source).slice(1)) {
      if (above.ignored === true || nameOf(above) === '') continue;
      if (needles.size > 0 && replaceNeedles(nameOf(above), needles) !== undefined) taint(above, needles, false, false);
      else if (opaque && hasContentsSource(above)) taint(above, needles, true, true);
    }
    // Names built from the node, or from an element around it.
    for (const around of chainOf(source)) {
      const backend = backendOf(around);
      if (backend === undefined) continue;
      for (const named of relatedBy.get(backend) ?? []) {
        // The label around a field is not part of the field's own name; a field that names itself is.
        if (named === source && backend !== backendOf(source)) continue;
        taint(named, needles, true, opaque);
      }
    }
  };
  for (const [node, needles] of fields) emit(node, needles, false);
  // A node a name was built from is not in the tree, or what is inside it was not checked: that name cannot be trusted.
  for (const [target, named] of relatedBy) {
    if (!byBackendId.has(target) || (trouble && unseen.has(target))) for (const node of named) taint(node, new Set(), true, true);
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) emit(next.node, next.needles, next.opaque);

  // 3. Apply: the secrets' own lines, then the names that took one in.
  const gone = new Set<string>();
  for (const field of removed) {
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
  const setName = (node: RawNode, text: string): void => {
    const name = typeof node.name === 'object' && node.name !== null ? (node.name as RawNode) : {};
    node.name = { ...name, value: text };
  };
  for (const [node, entry] of taints) {
    const scrubbed = replaceNeedles(nameOf(node), entry.needles);
    if (scrubbed !== undefined) setName(node, scrubbed);
    else if (entry.whole) setName(node, HIDDEN);
  }

  // 4. The net: a value of four characters or more does not stay in any name, value or address on the page.
  const longNeedles = new Set<string>();
  for (const needles of fields.values()) for (const needle of needles) if (needle.length >= MIN_SUBSTRING) longNeedles.add(needle);
  if (longNeedles.size > 0) {
    const net = scrubber(longNeedles);
    for (const node of nodes) {
      if (node.ignored === true) continue;
      const name = nameOf(node);
      const scrubbedName = name === '' ? undefined : net(name);
      if (scrubbedName !== undefined) setName(node, scrubbedName);
      if (typeof node.value === 'object' && node.value !== null) {
        const text = axString(node.value);
        const scrubbedValue = text === '' ? undefined : net(collapse(text));
        if (scrubbedValue !== undefined) node.value = { ...(node.value as RawNode), value: scrubbedValue };
      }
      if (Array.isArray(node.properties)) {
        node.properties = (node.properties as RawNode[]).map((property) => {
          if (property?.name !== 'url' || typeof property.value !== 'object' || property.value === null) return property;
          const text = axString(property.value);
          const scrubbedUrl = text === '' ? undefined : net(text);
          return scrubbedUrl === undefined ? property : { ...property, value: { ...(property.value as RawNode), value: scrubbedUrl } };
        });
      }
    }
  }
  return gone.size === 0 ? raw : raw.filter((item) => typeof item !== 'object' || item === null || !gone.has(String((item as RawNode).nodeId)));
}

function looksMaskedValue(value: string): boolean {
  return value !== '' && /^•+$/.test(value);
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

/**
 * The text with each needle replaced in one pass (longest first), around any marker already in it, or `undefined` when
 * none was found. A needle shorter than `MIN_SUBSTRING` is replaced only as a whole word.
 */
function replaceNeedles(text: string, needles: Set<string>): string | undefined {
  if (needles.size === 0) return undefined;
  const parts = [...needles]
    .sort((a, b) => b.length - a.length)
    .map((needle) => {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return needle.length >= MIN_SUBSTRING ? escaped : `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
    });
  const pattern = new RegExp(parts.join('|'), 'gu');
  const scrubbed = text
    .split(HIDDEN)
    .map((segment) => segment.replace(pattern, HIDDEN))
    .join(HIDDEN);
  return scrubbed === text ? undefined : scrubbed;
}

/**
 * A function that replaces each needle (all of `MIN_SUBSTRING` characters or more) found in a text, longest first and never
 * inside a marker, or returns `undefined` when none is found. It looks each position up by its first characters, so a page of
 * tens of thousands of names and hundreds of values costs one pass over the text, not one pass per value.
 */
function scrubber(needles: Set<string>): (text: string) => string | undefined {
  const byStart = new Map<string, string[]>();
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    const key = needle.slice(0, MIN_SUBSTRING);
    byStart.set(key, [...(byStart.get(key) ?? []), needle]);
  }
  return (text) => {
    let out = '';
    let changed = false;
    for (let at = 0; at < text.length; ) {
      if (text.startsWith(HIDDEN, at)) {
        out += HIDDEN;
        at += HIDDEN.length;
        continue;
      }
      const match = byStart.get(text.slice(at, at + MIN_SUBSTRING))?.find((needle) => text.startsWith(needle, at));
      if (match === undefined) {
        out += text[at];
        at += 1;
      } else {
        out += HIDDEN;
        at += match.length;
        changed = true;
      }
    }
    return changed ? out : undefined;
  };
}
