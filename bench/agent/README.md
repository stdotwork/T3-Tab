# Agent benchmark

`bench/compare` sends each browser tool a fixed sequence of calls and counts what comes back. This benchmark puts a
real model in the loop: Claude Code (headless, `claude -p --output-format stream-json`) is given one browser tool server
at a time, no built-in tools, and a goal on a local page. It measures what the run costs end to end, including what the
model writes, the retries and wrong turns, the JavaScript it has to author for tools that take code, and whether the task
was actually done.

```sh
pnpm build                                  # T3-Tab's extension and daemon
pnpm bench:agent                            # every tool, every task, 3 repeats, Haiku 5.5, 2 runs at a time
pnpm bench:agent --tools t3tab,dt-slim --tasks form,login --repeats 1 --label try
pnpm bench:agent --model claude-sonnet-5-5 --repeats 1 --label sonnet --tasks login,wizard,table
```

Options: `--tools`, `--tasks` (ids below), `--model`, `--repeats`, `--concurrency` (default 2: the most browsers at once),
`--label` (the results folder under `bench/agent/results/`), `--max-turns` (60) and `--timeout-min` (12), which only stop
a run that is stuck (a run they stop is a failure), `--fresh` (forget the runs already in the folder; without it a repeated
command only does the runs that are missing). Results go to `bench/agent/results/<label>/` (ignored by git): `runs.jsonl`,
`results.json`, `results.md`, and `transcripts/<tool>__<task>__<n>.jsonl` (the raw stream) and `.md` (readable).

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

## What it does not show

Three repeats of ten tasks per tool is a small sample and a model's runs differ; read medians and the transcripts, not one
number. The pages are small and local. A task goal is the same text for every tool, so a tool whose strength is a longer,
tool-specific instruction is not helped by one. Prices are what the stream reports (`total_cost_usd`, list prices of the
proxy's model route).
