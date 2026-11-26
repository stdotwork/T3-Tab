import { axString, VALUE_ROLES } from './ax';
import { addressForms, collapse, HIDDEN, matcher, MIN_SUBSTRING, shortScrubber, type Matcher } from './secret-text';

const INSPECT_BATCH_SIZE = 25;
/** The most nodes inside hidden or ignored content one read looks into; names built from what is left are hidden whole. */
const MAX_IGNORED_INSPECTED = 1_000;
/** The time the analysis of one read may take before every text that holds a known value is hidden whole instead. */
const DEFAULT_BUDGET_MS = 1_500;

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
  /** The time the analysis may take, in milliseconds, before the fallback hides every text that holds a known value. */
  budgetMs?: number;
  /** An error that must stop the read instead of being taken for a field that could not be checked. */
  rethrow?: (error: unknown) => boolean;
  /** Values the page holds in secret fields, found without a node (hidden fields and fields in closed content too). */
  pageSecrets?: Iterable<string>;
  /** Values seen in secret fields of this tab earlier. */
  remembered?: Iterable<string>;
  /** Told the values (of four characters or more) the read looked for, for the tab to remember. */
  onSecrets?: (needles: string[]) => void;
}

class BudgetExceeded extends Error {}

/**
 * Removes secret values from the raw accessibility tree before it is trimmed and leaves the extension, and returns the
 * nodes to keep.
 *
 * Every node that holds a value, and every field the reader prints a value for (textbox, searchbox, combobox, spinbutton,
 * slider), is checked with `inspect`: whatever its role, a field that is a password input, masked, or marked secret by its
 * `autocomplete` has its value removed (the line renders as `value=<redacted>`, with no length) and loses its children,
 * which hold the bullets the browser draws. A run of password bullets as a value is redacted without asking. A field that
 * cannot be checked is redacted too, and its value is looked for like a secret's. The nodes inside any element a name was
 * built from that the tree leaves out as ignored (hidden, `aria-hidden`, a closed dialog) are checked as well, since a name
 * still holds what is in them. The page's own list of secret values (`pageSecrets`) adds the values of fields no name was
 * built from.
 *
 * The browser puts a field's value into other names, so each secret is followed. The tree says which nodes a name was built
 * from (`relatedNodes` of its sources): a name built from a hidden field, or from an element around one, and any name built
 * from such a name, is replaced whole when the value cannot be found in it, and the names above it built from content are
 * too. Every value of four characters or more is then taken out of every name, value, address and line of text on the page,
 * whatever its case, also when the page split it over several elements. Shorter values are replaced only as whole words in
 * the names tied to their field. Values are taken whole, before any cut.
 *
 * Everything after the checks runs under a time budget: past it, every text that holds a known value is hidden whole, and
 * past a second budget every name built from content.
 */
export async function redactPasswordValues(
  raw: unknown[],
  inspect: InspectFields,
  options: RedactionOptions = {},
): Promise<unknown[]> {
  const batchSize = options.batchSize ?? INSPECT_BATCH_SIZE;
  const budget = options.budgetMs ?? DEFAULT_BUDGET_MS;
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
  const parentOf = (node: RawNode): RawNode | undefined => parents.get(String(node.nodeId));

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
  // One walk over the whole tree, whatever the number of sources, so nested sources cost nothing extra. Past the cap, the
  // names built from what was not looked into cannot be trusted: every source is then marked unseen.
  const visited = new Set<RawNode>();
  let capped = false;
  for (const target of relatedBy.keys()) {
    const start = byBackendId.get(target);
    if (start === undefined || visited.has(start)) continue;
    const stack = [start];
    while (stack.length > 0 && !capped) {
      const at = stack.pop();
      if (at === undefined || visited.has(at)) continue;
      visited.add(at);
      if (at.ignored === true && backendOf(at) !== undefined) {
        if (ignoredInside.length >= limit) {
          capped = true;
          break;
        }
        ignoredInside.push(at);
      }
      for (const child of childIds(at)) {
        const next = byNodeId.get(child);
        if (next !== undefined) stack.push(next);
      }
    }
    if (capped) break;
  }
  if (capped) for (const target of relatedBy.keys()) unseen.add(target);

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
  const extra = new Set<string>();
  for (const value of [...(options.pageSecrets ?? []), ...(options.remembered ?? [])]) {
    const needle = collapse(value);
    if (needle !== '') extra.add(needle);
  }
  const trouble = unseen.size > 0 && (fields.size > 0 || ignoredFailed);
  if (fields.size === 0 && extra.size === 0 && !trouble) return raw;

  // The values to look for: those of four characters or more in any text, shorter ones in the names tied to their field.
  const long = new Set<string>();
  const shortOf = new Map<RawNode, string[]>();
  const allShort = new Set<string>();
  const sort = (needle: string, field?: RawNode): void => {
    if (needle.length >= MIN_SUBSTRING) long.add(needle);
    else if (field !== undefined) {
      shortOf.set(field, [...(shortOf.get(field) ?? []), needle]);
      allShort.add(needle);
    }
  };
  for (const [field, needles] of fields) for (const needle of needles) sort(needle, field);
  for (const needle of extra) sort(needle);
  options.onSecrets?.([...long]);

  // 2. The secrets' own lines.
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
  const result = (): unknown[] =>
    gone.size === 0 ? raw : raw.filter((item) => typeof item !== 'object' || item === null || !gone.has(String((item as RawNode).nodeId)));

  // 3. The text that took a hidden value in, under a time budget.
  const live = nodes.filter((node) => node.ignored !== true && !gone.has(String(node.nodeId)));
  const text = textOf(live, nodes, byNodeId, parents);
  const net = matcher(long);
  const address = matcher(addressForms(long));
  const shortNames = allShort;
  const shortAll = shortScrubber(shortNames);
  const started = performance.now();
  let ticks = 0;
  const tick = (): void => {
    if ((ticks += 1) % 128 === 0 && performance.now() - started > budget) throw new BudgetExceeded();
  };
  try {
    if (budget <= 0) throw new BudgetExceeded();
    scrubFollowing();
    scrubEverywhere(net, address, live, text, tick);
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    hideEverything(net, address, shortAll, live, text, budget);
  }
  return result();

  /** The names built from a hidden field, from what it sits in, or from such a name, and what sits above those. */
  function scrubFollowing(): void {
    const nameCache = new Map<RawNode, string>();
    const nameOf = (node: RawNode): string => {
      let cached = nameCache.get(node);
      if (cached === undefined) nameCache.set(node, (cached = collapse(axString(node.name))));
      return cached;
    };
    const knownIn = new Map<RawNode, boolean>();
    const holdsNeedle = (node: RawNode): boolean => {
      let known = knownIn.get(node);
      if (known === undefined) {
        const name = nameOf(node);
        known = net.has(name) || (shortNames.size > 0 && shortAll(name) !== undefined);
        knownIn.set(node, known);
      }
      return known;
    };
    const hasContentsSource = (node: RawNode): boolean => {
      const sources = (node.name as { sources?: unknown } | undefined)?.sources;
      return (
        Array.isArray(sources) &&
        (sources as RawNode[]).some((source) => typeof source === 'object' && source !== null && source.superseded !== true && source.type === 'contents')
      );
    };

    // Which names took something in, by structure: a node, and whether its name holds no value we know of.
    const tainted = new Map<RawNode, boolean>();
    const queue: RawNode[] = [];
    const taint = (node: RawNode): void => {
      if (tainted.has(node) || node.ignored === true || nameOf(node) === '') return;
      tainted.set(node, !holdsNeedle(node));
      queue.push(node);
    };
    const expanded = new Set<RawNode>();
    const expandRelations = (source: RawNode): void => {
      for (let around: RawNode | undefined = source; around !== undefined; around = parentOf(around)) {
        tick();
        if (expanded.has(around)) break;
        let skipped = false;
        const backend = backendOf(around);
        if (backend !== undefined) {
          for (const named of relatedBy.get(backend) ?? []) {
            // The label around a field is not part of the field's own name; a field that names itself is.
            if (named === source && backend !== backendOf(source)) skipped = true;
            else taint(named);
          }
        }
        if (!skipped) expanded.add(around);
      }
    };
    const climbed = new Set<RawNode>();
    const expandContent = (source: RawNode): void => {
      for (let above = parentOf(source); above !== undefined; above = parentOf(above)) {
        tick();
        if (climbed.has(above)) break;
        climbed.add(above);
        if (hasContentsSource(above)) taint(above);
      }
    };
    for (const [field, needles] of fields) if (needles.size > 0) expandRelations(field);
    for (const [target, named] of relatedBy) {
      if (!byBackendId.has(target) || (trouble && unseen.has(target))) {
        for (const node of named) {
          if (!tainted.has(node) && node.ignored !== true && nameOf(node) !== '') {
            tainted.set(node, true);
            queue.push(node);
          }
        }
      }
    }
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      expandRelations(next);
      if (tainted.get(next) === true) expandContent(next);
    }
    // Short values: the names around a field that holds one, as a whole word.
    const shortAbove = new Map<RawNode, Set<string>>();
    if (shortNames.size > 0) {
      for (const [field, needles] of shortOf) {
        for (let above = parentOf(field); above !== undefined; above = parentOf(above)) {
          tick();
          if (above.ignored === true || nameOf(above) === '') continue;
          const hit = needles.filter((needle) => shortScrubber([needle])(nameOf(above)) !== undefined);
          if (hit.length > 0) shortAbove.set(above, new Set([...(shortAbove.get(above) ?? []), ...hit]));
        }
      }
    }

    for (const node of live) {
      tick();
      if (isText(node)) continue;
      const name = nameOf(node);
      if (name === '') continue;
      const opaque = tainted.has(node);
      let scrubbed = net.scrub(name);
      const shorts = opaque ? shortNames : shortAbove.get(node);
      if (shorts !== undefined && shorts.size > 0) scrubbed = (shorts === shortNames ? shortAll : shortScrubber(shorts))(scrubbed ?? name) ?? scrubbed;
      if (scrubbed === undefined && opaque) scrubbed = HIDDEN;
      if (scrubbed !== undefined) setName(node, scrubbed);
    }
    // A line of text that was itself built from a hidden field is hidden whole when no value is found in it.
    for (const [node] of tainted) {
      if (!isText(node)) continue;
      const name = nameOf(node);
      const scrubbed = net.scrub(name) ?? (shortNames.size > 0 ? shortAll(name) : undefined) ?? HIDDEN;
      setName(node, scrubbed);
    }
  }

  function isText(node: RawNode): boolean {
    return roleOf(node) === 'statictext';
  }
}

/** The values, addresses and every line of text on the page, with the values taken out, also when split over elements. */
function scrubEverywhere(
  net: Matcher,
  address: Matcher,
  live: RawNode[],
  text: RawNode[],
  tick: () => void,
): void {
  for (const node of live) {
    tick();
    if (typeof node.value === 'object' && node.value !== null) {
      const value = axString(node.value);
      const scrubbed = value === '' ? undefined : net.scrub(collapse(value));
      if (scrubbed !== undefined) node.value = { ...(node.value as RawNode), value: scrubbed };
    }
    if (Array.isArray(node.properties)) {
      node.properties = (node.properties as RawNode[]).map((property) => {
        if (property?.name !== 'url' || typeof property.value !== 'object' || property.value === null) return property;
        const url = axString(property.value);
        const scrubbed = url === '' ? undefined : address.scrub(url);
        return scrubbed === undefined ? property : { ...property, value: { ...(property.value as RawNode), value: scrubbed } };
      });
    }
  }
  scrubText(net, text, tick);
}

/**
 * The page's text, as a stream: the lines of text in document order joined with nothing between, so a value the page split
 * over elements (a span per character, the first letters in a `<b>`) is found, and every line it covers loses that part.
 */
function scrubText(net: Matcher, text: RawNode[], tick: () => void): void {
  const pieces = text.map((node) => axString(node.name).replace(/\s+/g, ' '));
  const stream = pieces.join('');
  const found = net.ranges(stream);
  if (found.length === 0) return;
  let range = 0;
  let from = 0;
  text.forEach((node, index) => {
    tick();
    const piece = pieces[index] ?? '';
    const start = from;
    const end = from + piece.length;
    from = end;
    let out = '';
    let at = start;
    let changed = false;
    while (range < found.length) {
      const [rangeStart, rangeEnd] = found[range] ?? [0, 0];
      if (rangeEnd <= start) {
        range += 1;
        continue;
      }
      if (rangeStart >= end) break;
      changed = true;
      out += piece.slice(at - start, Math.max(rangeStart, start) - start);
      if (rangeStart >= start) out += HIDDEN;
      at = Math.min(rangeEnd, end);
      if (rangeEnd <= end) range += 1;
      else break;
    }
    if (changed) setName(node, out + piece.slice(at - start));
  });
}

/** The lines of text of the page in document order: the nodes the reader prints as plain text. */
function textOf(live: RawNode[], all: RawNode[], byNodeId: Map<string, RawNode>, parents: Map<string, RawNode>): RawNode[] {
  const liveSet = new Set(live);
  const lines: RawNode[] = [];
  const seen = new Set<RawNode>();
  // Walk from every node nothing is above, in the order the browser lists them, so each subtree reads in document order.
  for (const root of all) {
    if (typeof root.nodeId === 'string' && parents.has(root.nodeId)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || seen.has(node)) continue;
      seen.add(node);
      if (liveSet.has(node) && axString(node.role).toLowerCase() === 'statictext' && axString(node.name) !== '') lines.push(node);
      const kids = childIds(node);
      for (let index = kids.length - 1; index >= 0; index -= 1) {
        const next = byNodeId.get(kids[index] ?? '');
        if (next !== undefined) stack.push(next);
      }
    }
  }
  // Anything left (a cycle with no root) goes last.
  for (const node of live) if (!seen.has(node) && axString(node.role).toLowerCase() === 'statictext' && axString(node.name) !== '') lines.push(node);
  return lines;
}

/**
 * The fallback when the analysis ran out of time: every name, value, address and line of text that holds a value we know of
 * is hidden whole, and past a second budget so is every name built from content. It reads each text once.
 */
function hideEverything(
  net: Matcher,
  address: Matcher,
  short: (text: string) => string | undefined,
  live: RawNode[],
  text: RawNode[],
  budget: number,
): void {
  const started = performance.now();
  // Bullets are what the browser draws for a password it did not give a name or a value to: they stand for a secret as well.
  const holds = (value: string): boolean => net.has(value) || short(value) !== undefined || /•{2,}/.test(value);
  let blank = false;
  let count = 0;
  for (const node of live) {
    count += 1;
    if (count % 256 === 0 && performance.now() - started > Math.max(budget, 1)) blank = true;
    const name = axString(node.name);
    if (name !== '' && (blank ? hasSource(node) : holds(collapse(name)))) setName(node, HIDDEN);
    if (typeof node.value === 'object' && node.value !== null) {
      const value = axString(node.value);
      if (value !== '' && holds(collapse(value))) node.value = { ...(node.value as RawNode), value: HIDDEN };
    }
    if (Array.isArray(node.properties)) {
      node.properties = (node.properties as RawNode[]).map((property) => {
        if (property?.name !== 'url' || typeof property.value !== 'object' || property.value === null) return property;
        return address.has(axString(property.value)) ? { ...property, value: { ...(property.value as RawNode), value: HIDDEN } } : property;
      });
    }
  }
  scrubText(net, text, () => undefined);
}

/** Whether the browser built the node's name from its content or from other nodes. */
function hasSource(node: RawNode): boolean {
  const sources = (node.name as { sources?: unknown } | undefined)?.sources;
  return (
    Array.isArray(sources) &&
    (sources as RawNode[]).some(
      (source) => typeof source === 'object' && source !== null && source.superseded !== true && (source.type === 'contents' || source.type === 'relatedElement'),
    )
  );
}

function setName(node: RawNode, text: string): void {
  const name = typeof node.name === 'object' && node.name !== null ? (node.name as RawNode) : {};
  node.name = { ...name, value: text };
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
