// Prints one line per tool call of the runs that match, for reading where a run spent its tokens and time:
//   node bench/agent/moments.mjs <results folder> <tool> <task> [run]
// Each line: the call's name and arguments, how long the tool took to answer, the size of the reply, and its start.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [folder, tool, task, rep] = process.argv.slice(2);
if (folder === undefined || tool === undefined || task === undefined) throw new Error('usage: moments.mjs <results folder> <tool> <task> [run]');
for (const run of rep === undefined ? [1, 2, 3] : [rep]) {
  const lines = (await readFile(join(folder, 'transcripts', `${tool}__${task}__${run}.jsonl`), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  if (lines.length === 0) continue;
  const events = lines.map((line) => JSON.parse(line));
  const started = new Map();
  const rows = [];
  let usageSeen = 0;
  for (const event of events) {
    if (event.type === 'assistant') {
      for (const block of event.message.content ?? []) {
        if (block.type === 'tool_use') started.set(block.id, { at: Date.parse(event.timestamp), name: block.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, ''), input: JSON.stringify(block.input), outputTokens: event.message.usage?.output_tokens });
      }
    } else if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const call = started.get(block.tool_use_id);
        if (call === undefined) continue;
        const content = Array.isArray(block.content) ? block.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n') : String(block.content ?? '');
        rows.push({ ...call, ms: Date.parse(event.timestamp) - call.at, chars: content.length, error: block.is_error === true, head: content.slice(0, 110).replace(/\n/g, ' ') });
      }
    }
    if (event.type === 'result') usageSeen = event.usage?.output_tokens ?? 0;
  }
  console.log(`--- ${tool} ${task} #${run}: ${rows.length} calls, ${usageSeen} output tokens`);
  for (const row of rows) console.log(`${String(row.ms).padStart(6)} ms ${String(row.chars).padStart(6)} ch${row.error ? ' ERR' : '    '} ${row.name} ${row.input.slice(0, 200)}\n          -> ${row.head}`);
}
