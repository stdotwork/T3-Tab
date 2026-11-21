const CONTEXT_LINES = 1;
const MAX_MATCHES = 20;
const MAX_QUERY_LENGTH = 200;

export interface FindResult {
  text: string;
  matches: number;
}

/**
 * The lines of a read that match `query`, each with a little context. The query is a
 * case-insensitive regular expression; one that does not parse is searched for as plain text.
 */
export function findLines(lines: string[], query: string): FindResult {
  const pattern = compile(query.slice(0, MAX_QUERY_LENGTH));
  const matching: number[] = [];
  lines.forEach((line, index) => {
    if (pattern.test(line)) matching.push(index);
  });
  if (matching.length === 0) return { text: `No matches for ${JSON.stringify(query)}.`, matches: 0 };

  const shown = matching.slice(0, MAX_MATCHES);
  const out: string[] = [];
  let previousEnd = -1;
  for (const index of shown) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + CONTEXT_LINES);
    if (previousEnd >= 0 && start > previousEnd + 1) out.push('--');
    for (let line = Math.max(start, previousEnd + 1); line <= end; line += 1) out.push(lines[line] ?? '');
    previousEnd = Math.max(previousEnd, end);
  }
  if (matching.length > shown.length) {
    out.push(`(${matching.length - shown.length} more matches; narrow the query)`);
  }
  return { text: out.join('\n'), matches: matching.length };
}

function compile(query: string): RegExp {
  try {
    return new RegExp(query, 'i');
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}
