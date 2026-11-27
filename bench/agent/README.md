# Agent benchmark

`bench/compare` sends each browser tool a fixed sequence of calls and counts what comes back. This benchmark puts a
real model in the loop: Claude Code (headless, `claude -p --output-format stream-json`) is given one browser tool server
at a time, no built-in tools, and a goal on a local page. It measures what the run costs end to end, including what the
model writes, the retries and wrong turns, the JavaScript it has to author for tools that take code, and whether the task
was actually done.

```sh
pnpm build                                  # T3-Tab's extension and daemon
pnpm bench:agent                            # every tool, every local task, 5 repeats, Haiku 5.5, 2 runs at a time
pnpm bench:agent --sites real               # the same on the frozen held-out public-site tasks
pnpm bench:agent --tools t3tab,dt-slim --tasks form,login --repeats 1 --label try
pnpm bench:agent --model claude-sonnet-5-5 --repeats 1 --label sonnet --tasks login,wizard,table
```

Options: `--sites` (`local`, the default, or `real`), `--tools`, `--tasks` (ids below), `--model`, `--repeats` (default 5),
`--concurrency` (default 2: the most browsers at once),
`--label` (the results folder under `bench/agent/results/`), `--max-turns` (60) and `--timeout-min` (12), which only stop
a run that is stuck (a run they stop is a failure), `--fresh` (forget the runs already in the folder; without it a repeated
command only does the runs that are missing) and `--report-only` (make the tables again from the runs in the folder and run nothing). Results go to `bench/agent/results/<label>/` (ignored by git): `runs.jsonl`,
`results.json`, `results.md`, and `transcripts/<tool>__<task>__<n>.jsonl` (the raw stream) and `.md` (readable). The label
defaults to the model's name, with `-real` added for `--sites real`.

## How a run goes

- A new temporary `HOME` and XDG folders, a new task site (a small HTTP server whose state is read afterwards), a new
  browser, and a new `claude -p` for every run. The model route is the one in the caller's environment
  (`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, a local proxy, or `CLAUDE_CODE_OAUTH_TOKEN`), the same way
  `e2e/panel-flow.mjs` reaches Haiku; nothing in the machine's own `~/.claude` or `~/.config` is read or written, and the
  caller's `CLAUDE*`, `CODEX*`, `T3CODE_*` and `T3_TAB_*` variables are removed.
- `claude -p --tools "" --strict-mcp-config --mcp-config <one server> --allowedTools mcp__<server> --permission-mode dontAsk
  --setting-sources "" --disable-slash-commands --no-session-persistence`, with `ENABLE_TOOL_SEARCH=false` so every tool
  definition is sent up front. Claude Code's own system prompt is part of every run's cost, the same for every tool.
- The prompt is the goal, one line asking for `DONE: <answer>`, and nothing about the tool. The one exception is Playwriter:
  its extension path needs a click on each tab, which a headless run cannot do, so the prompt says where the browser is and
  to use `session_new`'s `direct` option.
- Success is checked after the run, from the page or the site, not from the model's words: the page's own state read over
  the browser's debugging port (`form`, `hidden`, `navigate`), what the site's server saw (`login`, `wizard`, `confirm`,
  `newtab`), and, where the point of the task is the answer, the final text against the expected value (`search`,
  `loadmore`, `table`, and the code or balance asked for in `login`, `wizard`, `newtab`).
- Numbers come from the stream: tool calls (every `tool_use`), turns (`num_turns`), input tokens (`input_tokens` +
  `cache_read_input_tokens` + `cache_creation_input_tokens`, from the result's `usage`), output tokens, `total_cost_usd`,
  and wall time from starting `claude` to its exit. The first model call of a run writes the prompt cache and is the most
  expensive; it is reported (`First call of a run`) and left in the totals.

## What it reports

Raw tokens include everything Claude Code sends whatever the browser tool is (its system prompt, the task, the answer), so a
tool is judged on what it adds:

- **No-tool baseline.** The tool `none` runs Claude Code with no MCP server and no tools on every task with the same prompt,
  and runs whenever any tool does. A run's **tool-attributable tokens** are its tokens minus the baseline's number for that
  task (never below 1): the median input of the baseline runs' first request, which is Claude Code's own system prompt and
  the task, about 3,450 tokens and the same for every tool. The baseline's whole run is not used, because with no tools the
  model improvises tool calls and their replies, and Claude Code continues it after the output cap, so a baseline run
  makes two or more requests and its total moves by thousands of tokens. (It is shown in the report for reference, and its
  output is capped with `CLAUDE_CODE_MAX_OUTPUT_TOKENS=512` so that it ends.) A baseline run that does not finish in two minutes
  (a stalled model request) is tried again, up to three times, and one that never finishes is left out of the tables.
- **Model requests.** The API responses of a run (the stream's distinct assistant message ids), next to the number of tool
  calls. Every request re-reads the whole context, so a tool that needs fewer of them is cheaper in a way a token count of its
  replies does not show. (Claude Code can make requests the stream does not show; none is counted.)
- **Per-task medians, then a geometric mean.** For each competitor and metric (tool-attributable tokens, model requests, total
  tokens, cost, time): per task, T3-Tab's median over the repeats divided by the tool's; then the geometric mean of those ratios
  over the tasks, with a 90% interval from 2,000 bootstrap resamples (the runs of every task cell are resampled with
  replacement, the baseline's too; the generator is seeded, so a table made from the same runs is the same). Below 1.00x, T3-Tab
  used less. A failed run counts with what it spent, and success is shown next to the ratios, not folded into them.
- **Median tool latency** over every tool call of every run: the time between a call and its reply in the stream. Calls
  sent in one message run one after another, so each later one's latency includes the wait for those before it, and tools
  differ in what one call does (a T3-Tab `act` settles and reads the page back; a script call does neither), so this number
  does not compare tools on its own. Beside it:
- **Median tool-busy time per run**: the union of a run's call spans, so the time calls of one message share counts once
  (`busyMs` in `stats.mjs`; recorded as `toolBusyMs`. A run recorded before that gets it from its transcript in the
  folder, if the transcript is still there; otherwise the run is left out of this median.)
- **Median wall time per run**: from starting `claude` to its exit, model time included (the same runs' `Time` above).

`stats.mjs` has the arithmetic and `stats.test.mjs` its unit tests (they run with `pnpm test`).

## Tools

The servers are started the way `bench/compare` starts them (same packages, same pinned versions).

| Id | Server |
| --- | --- |
| `t3tab` | T3-Tab (this checkout): built extension in a headless Chromium that only the extension debugs, the real daemon, the task site set to `allow` |
| `dt-slim` | `chrome-devtools-mcp --slim` (navigate, evaluate, screenshot) |
| `dt` | `chrome-devtools-mcp`, default tools |
| `pw` | `@playwright/mcp`, default capabilities and snapshot mode |
| `ab` | `agent-browser mcp`, default core profile |
| `pwr` | `playwriter`, through its relay with `session_new {direct}` |
| `none` | the baseline above: no server, no tools |

The other tools are attached with their debugging-port options to a plain headless Chromium started with
`--disable-extensions`: this machine registers Claude in Chrome system-wide (`/usr/share/chromium/extensions`), and a
Chromium with a new profile installs it and opens a claude.ai sign-in tab a few seconds in, which a tool lists and a model
trips over. dev-browser is in `bench/compare` and not here.

## Tasks

`pages/index.mjs` serves the four pages of `pnpm bench` (`bench/pages.mjs`, unchanged) and the new ones.

| Id | Goal |
| --- | --- |
| `form` | Fill the sign-up form (name, email, country) and submit it. (from `pnpm bench`) |
| `hidden` | Expand the collapsed Details section and name the link in it. (from `pnpm bench`) |
| `navigate` | Open the page of the product "Day pack". (from `pnpm bench`) |
| `search` | Read the rate limit per token off a long guide. (from `pnpm bench`) |
| `login` | Sign in as maria; try the old password first, the site rejects it, then the right one; report the balance. |
| `wizard` | Four-step registration wizard with validation and a review step; report the confirmation code. |
| `loadmore` | Entry #58 of an activity log that shows ten entries and a "Load more" button; report its reference code. |
| `confirm` | Delete one project of four; the site asks with a JavaScript `confirm` dialog. |
| `table` | A table filled in by script after a delay; add up the West rows of Q3. |
| `newtab` | Open a document whose link has `target="_blank"` and report the code word on it. |

## Held-out real sites

`--sites real` runs `real-tasks.mjs` instead of the local tasks: eight tasks on public sites that are built for or tolerate light
automated use. They are frozen, so that a gain that only fits the local pages shows up here as none; a task changes only
because its site changed, and then every tool's runs on it are redone. Success is checked by the harness, from the page
(an expression run in every page of the task's origins over the debugging port) or against an answer that does not change.
T3-Tab's per-site setting is `allow` for the task's origins, as it is for the local site, so no prompt waits. Nothing logs in, and
a run makes a few plain page loads; runs are shuffled and two at a time, so no site gets a burst.

| Id | Site | Goal |
| --- | --- | --- |
| `books` | books.toscrape.com | Open the Mystery category (two pages) and give the title and price of the last book on page 2. |
| `quotes` | quotes.toscrape.com | Count the Albert Einstein quotes on pages 1 to 3. |
| `dynamic` | the-internet.herokuapp.com | Start the dynamic loading example 2 and report the text that appears. |
| `prompt` | the-internet.herokuapp.com | Answer a JavaScript prompt with a given text and report the result line. |
| `combobox` | w3.org WAI-ARIA Authoring Practices | Choose Wyoming in the list-autocomplete combobox example. |
| `todomvc` | todomvc.com (React) | Add three todos, complete the second, leave the others active. |
| `wikipedia` | en.wikipedia.org | Find how many houses the Great Fire of London destroyed, as the article states it. |
| `hn` | news.ycombinator.com, paulgraham.com | Follow a frozen 2013 item's link to the essay and name the company whose founders invented the "Collison installation". |

A site that is down or rate-limiting fails the runs that touch it. A task seen to do that carries `flaky` in `real-tasks.mjs`
and is marked in the report; it stays in the set.

## What it does not show

A few repeats of ten tasks per tool is a small sample and a model's runs differ; read the intervals and the transcripts, not one
number. The pages are small and local. A task goal is the same text for every tool, so a tool whose strength is a longer,
tool-specific instruction is not helped by one. Prices are what the stream reports (`total_cost_usd`, list prices of the
proxy's model route).
