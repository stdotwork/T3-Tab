# Head-to-head benchmark

T3-Tab's browser tools against other browser MCP servers, on the same fixed pages (`bench/pages.mjs`) and the
same tasks, with no model in the loop. For each tool the harness starts its MCP server, sends a fixed sequence
of calls (below), and counts what a model would be sent: the `tools/list` payload, every call's arguments, every
reply's text and every image. It also reads the page itself to see whether the task's end state was reached.

```sh
pnpm build                       # T3-Tab's extension and daemon (the other tools are devDependencies)
pnpm bench:compare               # every tool, one run, prints the tables
pnpm bench:compare --runs 2      # repeat the run and report how far the numbers moved
pnpm bench:compare --tools t3tab,pw   # only these tools (ids below)
pnpm bench:compare --out dir     # write the results elsewhere (default bench/compare/results, ignored by git)
```

It writes `latest.json` (every number, every step), `latest.md` (the tables) and `latest.replies.txt` (every
reply, for reading what each tool says) to the results folder. A run takes about a minute and a half per run.
It needs network access once: dev-browser's launcher downloads its 96 MB native binary on its first command
(pnpm does not run its install script), and the harness triggers that itself.

## What is measured

- **Definitions**: `JSON.stringify(tools/list)`, in characters and `o200k_base` tokens (the `gpt-tokenizer`
  estimate `pnpm bench` uses; Claude's own tokenizer differs by a few percent).
- **Per task**: the number of calls, tokens (call arguments + reply text + images, an image counting as
  width x height / 750), and wall time from the first call to the last reply.
- **Reached**: after the last call the harness evaluates the page over the browser's debugging port, whatever
  the tool said. `form`: the "Welcome Ada Lovelace (ada@example.com)" line is on the page and the country is
  Brazil. `hidden`: the details section is shown. `navigate`: the tab is on `/products/3`. The `long*` tasks
  are about information, so they pass when the sentence with "sixty requests per minute" was in what the agent
  was sent. `screenshot` passes when an image of known size came back (or a path to one).
- **Warm-up**: each tool runs the whole task list once unmeasured first, so the first task does not pay for a
  server that connects to its browser on the first call.
- **Setup is not counted**: starting the server and, for Playwriter, its one `session_new` call.

Every tool gets a new temporary `HOME` and XDG folders and its own browser. The plain browsers start with
`--disable-extensions`: this machine registers Claude in Chrome system-wide (`/usr/share/chromium/extensions`), and a
Chromium with a new profile installs it from the web store and, a few seconds in, opens a claude.ai sign-in tab that a tool
would list. T3-Tab runs as `pnpm bench` runs it
(built extension in headless Chromium, the real daemon, the site set to `allow`). Every other tool is attached
over the debugging port to a plain headless Chromium (the same binary, a 1600x1000 window, nothing else attached),
which lets the harness check the page without trusting the tool; none of them is given a fixed viewport, so each
takes the screenshot it takes by default. The tools' sandboxes, prompts and permission models differ and are not
measured. T3-Tab asks for no permission here because the site is set to `allow`.

## The call sequences

Each task opens its own page first, so opening counts in every task. A sequence is what a capable agent would
send with that tool, using refs from the tool's own replies. Where a tool's action reply does not show the outcome,
the sequence ends with the cheapest read that does, so every sequence ends knowing whether it worked.

| Id | Tool (pinned) | How it runs |
| --- | --- | --- |
| `t3tab` | T3-Tab (this checkout) | `t3-tab mcp` over the built extension |
| `pw` | `@playwright/mcp` 0.0.86 | `--cdp-endpoint`; default capabilities and snapshot mode (an action's reply links to a snapshot file; only `browser_snapshot` returns it inline) |
| `pw-none` | `@playwright/mcp` 0.0.86 | the same with `--snapshot-mode none` |
| `dt` | `chrome-devtools-mcp` 1.14.0 | `--browserUrl`; default tools |
| `dt-slim` | `chrome-devtools-mcp` 1.14.0 | `--slim`: `navigate`, `evaluate`, `screenshot` only |
| `ab` | `agent-browser` 0.45.0 | `agent-browser mcp`, default `core` profile, `AGENT_BROWSER_CDP` |
| `db` | `dev-browser` 1.0.0 | `dev-browser mcp --connect`: five tools, one of which runs a script |
| `pwr` | `playwriter` 0.12.0 | one `execute` tool; `session_new` with `direct` attaches to the shared Chromium (the extension path needs a click on each tab, which cannot run headless, so the relay and the Playwright code are what is measured, not the extension) |

Not run, definitions only (listed at the top of the report): Browser MCP 2.5.0 needs its Chrome Web Store
extension, which a headless run cannot install; its server lists its tools without a browser, so only that size is
measured. The Codex Chrome plugin is proprietary and has one REPL tool whose definition is not on disk; what is
read (read-only) is its `docs/api.json` schema, which an agent reads on demand and is not comparable to a
`tools/list`. Claude in Chrome's definitions are built inside the `claude` binary as code, not as one readable
list, so they were not measured. None of the three was driven.

Calls, in order (`R` = reads of the tool's own snapshot to find a ref):

| Task | T3-Tab | Playwright MCP | chrome-devtools-mcp |
| --- | --- | --- | --- |
| `form` | `tabs open` → `read` → `act` (fill, fill, select, click) | `browser_navigate` → `browser_snapshot` → `browser_fill_form` (three fields) → `browser_click` → `browser_snapshot` | `new_page` → `take_snapshot` → `fill_form` (three fields) → `click` → `take_snapshot` |
| `hidden` | `tabs open` → `read` → `act` (click) | `browser_navigate` → `browser_snapshot` → `browser_click` → `browser_snapshot` | `new_page` → `take_snapshot` → `click` → `take_snapshot` |
| `navigate` | `tabs open` → `read` → `act` (click the link) | same four calls | same four calls |
| `long` | `tabs open` → `read {find}` | `browser_navigate` → `browser_find {text}` | `new_page` → `take_snapshot` (no search tool) |
| `long-full` | `tabs open` → `read {all}` | `browser_navigate` → `browser_snapshot` | `new_page` → `take_snapshot` |
| `long-js` | `tabs open` → `run_js` | `browser_navigate` → `browser_evaluate` | `new_page` → `evaluate_script` |
| `screenshot` | `tabs open` → `screenshot` | `browser_navigate` → `browser_take_screenshot` | `new_page` → `take_screenshot` |

| Task | dt `--slim` | agent-browser | dev-browser | Playwriter |
| --- | --- | --- | --- | --- |
| `form` | `navigate` → `evaluate` (list the controls) → `evaluate` (fill, submit, return the page's tail) | `agent_browser_open` → `agent_browser_snapshot` → `agent_browser_fill` x2 → `agent_browser_select` → `agent_browser_click` → `agent_browser_read` | `dev_browser_run` (goto, snapshot) → `dev_browser_run` (fill, fill, select, click, snapshot diff) | `execute` (new page, goto, `snapshot()`) → `execute` (fill, fill, selectOption, click, `snapshot()` as a diff) |
| `hidden` | `navigate` → `evaluate` (page text) → `evaluate` (click the button, return the page's tail) | `agent_browser_open` → `agent_browser_snapshot` → `agent_browser_click` → `agent_browser_read` | `dev_browser_run` (goto, snapshot) → `dev_browser_run` (click, snapshot diff) | `execute` (new page, snapshot) → `execute` (click, snapshot diff) |
| `navigate` | `navigate` → `evaluate` (list the links) → `navigate` to the link's address → `evaluate` (page text) | `agent_browser_open` → `agent_browser_snapshot` → `agent_browser_click` → `agent_browser_read` | `dev_browser_run` (goto, snapshot) → `dev_browser_run` (click, wait, snapshot) | `execute` (new page, snapshot) → `execute` (click, wait for load, snapshot) |
| `long` | `navigate` → `evaluate` (filter the page text) | `agent_browser_open` → `agent_browser_read {filter}` | `dev_browser_run` (goto, `snapshot()`; no search) | `execute` (new page, `snapshot({ search })`) |
| `long-full` | `navigate` → `evaluate {document.body.innerText}` | `agent_browser_open` → `agent_browser_read` | `dev_browser_run` (goto, `snapshot()`) | `execute` (new page, `snapshot()`) |
| `long-js` | `navigate` → `evaluate` (filter the page text) | `agent_browser_open` → `agent_browser_eval` | `dev_browser_run` (goto, `page.evaluate`) | `execute` (new page, `page.evaluate`) |
| `screenshot` | `navigate` → `screenshot` (answers with a file path, not an image; the path's PNG is counted as an image) | `agent_browser_open` → `agent_browser_screenshot` (jpeg) | `dev_browser_run` (goto, `page.shot()`) | `execute` (new page, `screenshotWithAccessibilityLabels()`) |

`long-js` and the slim `long` use one line of JavaScript over the page's text (`document.body.innerText`,
filtered for "rate limit"), so no markup is assumed; the sequences that need a ref take it from the tool's own
snapshot, and nothing is looked up in `bench/pages.mjs`.

The sequences live in `adapters.mjs`, one object per tool; changing one changes the numbers.

## Reading the results

- Tokens are for a whole task, so a tool that answers an action with a tiny reply but needs a read after it
  (Playwright MCP, chrome-devtools-mcp) is charged for that read; a tool whose action reply shows what changed
  (T3-Tab, and Playwriter and dev-browser through a snapshot diff) is not.
- The pages are small. A real page makes full snapshots larger, which widens the gap for tools that return one
  per step and leaves a diff-based tool nearly unchanged.
- The page server answers `/favicon.ico` with a 404, so every page logs one console error. Playwright MCP
  prints a `Console:` line and a link for it on every reply; the other tools do not. A real site logs more.
- Token counts move by a few tokens between runs (a random port is in every URL, and temporary file names too);
  call counts and results do not move. Times move by tens of milliseconds.
- These are one agent's scripted calls on four small pages, not a measure of how well a model uses a tool.
