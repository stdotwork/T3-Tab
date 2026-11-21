# AGENTS.md

T3-Tab exposes the user's own signed-in Chromium browser as MCP tools for coding agents (Claude Code,
Codex, T3 Code threads and any MCP client), and adds a side panel that starts and continues real agent
sessions, through T3 Code or directly. It never runs its own agent loop: the agent the user picks does the
work, with the browser tools injected.

## Layout

- `packages/extension` — the WXT Manifest V3 Chromium extension, including its service worker and side panel.
- `packages/server` — the Node.js/TypeScript daemon, Chrome native host and stdio MCP server. The
  `t3-tab` binary in `dist/cli.js` provides all three commands.
- `packages/protocol` — the versioned types shared by the extension and background program.
- `e2e/` — the Playwright end-to-end harness; `e2e/harness.mjs` holds the setup the end-to-end run and the
  benchmark share (temporary HOME, headless Chromium with the extension, MCP clients).
- `bench/` — the token benchmark, its fixed pages and its budget.
- `.github/workflows/ci.yml` — the pull request and `main` checks.

## Commands

Run these from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm e2e
pnpm bench
```

`pnpm build` writes the Chromium extension to `packages/extension/.output/chrome-mv3`.
The built server is `packages/server/dist/cli.js`; `node_modules/.bin/t3-tab` runs it after installation.
`pnpm e2e` launches headless Playwright Chromium with that built extension, starts the real native host and
two MCP clients, and checks the loopback link and the browser tools against a local test site (a form,
links and a section that appears on a click): `tabs`, `read` with its diff, `find` and ref subtrees, and
`screenshot`, `act` and `run_js`. It also checks session tab groups, socket-bound session ids, tab sharing,
read and action prompts, cross-origin navigation and `window.open`, restricted pages, password redaction
and a regex timeout. It also checks the review fixes: a read-only site grant that act, run_js and open
still prompt past, a `run_js` escape expression, a screenshot and a key press that land on a page that
changed, popups opened by the owner and by a session tab, member tabs shown only by origin until approved,
a cross-origin iframe left out of `read`, and prompt buttons locked when rows shift. Existing tool checks
run with the site still set to ask and the harness answering prompts with Allow once. The action run fills and submits the
test form, checks a stale ref after navigation, evaluates page JavaScript and waits past the extension
worker's idle timeout before another `status` call. It checks the install command through direct config
edits, `--print`, a second install, uninstall and, when both agent CLIs are available, their CLI path and
`mcp list` output. It prints each reply and its size. Every process it starts uses a temporary HOME and XDG
directories, and every browser is headless.

`pnpm bench` (after `pnpm build`) measures what an agent is sent, in characters and estimated tokens: the
`tools/list` payload (total and per tool) and each tool reply on four fixed tasks over three local pages
(`bench/pages.mjs`): fill and submit a form, open a hidden section, follow a link, and search a longer page
with `find`, a ref subtree, `all` and a screenshot (text part, JPEG bytes and size, estimated image tokens).
It drives the real tools through `e2e/harness.mjs` the way the end-to-end run does, with the bench site
set to `allow` so no prompt waits. It prints a markdown table and writes `bench/results/latest.json` (not
committed) and the replies it measured to `bench/results/latest.replies.txt`. Text tokens are an estimate:
the `o200k_base` encoding from the `gpt-tokenizer` package, not the tokenizer of any one model; an image is
estimated as width x height / 750. `pnpm bench --compare before.json` adds the change from an earlier
results file. The run fails when a number is over its limit in `bench/budget.json`, when a measured number
has no limit, or when a limit measures nothing. `pnpm bench --update-budget` rewrites the limits from the
current run (the measured number plus 5%, plus 40% for JPEG bytes, which vary with fonts); commit that
change only on purpose and give the reason in the PR. `pnpm bench --check results.json` judges a saved
results file without a browser. Changing `bench/pages.mjs` changes every number, so redo the budget with it.

## CLI

Build before running the CLI:

```sh
pnpm exec t3-tab install
pnpm exec t3-tab install --claude --codex --browser chromium
pnpm exec t3-tab install --print
pnpm exec t3-tab uninstall
pnpm exec t3-tab uninstall --claude --codex
pnpm exec t3-tab daemon
pnpm exec t3-tab native-host install --browser chromium
pnpm exec t3-tab native-host install --browser chrome
pnpm exec t3-tab native-host install --browser brave
pnpm exec t3-tab mcp
```

`install` registers `t3-tab mcp` as a user-level stdio MCP server for Claude Code in `~/.claude.json` and
Codex in `~/.codex/config.toml`. When neither `--claude` nor `--codex` is given, it registers every agent
whose CLI or config it finds. When `--browser` is omitted, it installs the native host for every Chromium,
Chrome or Brave installation it finds. It uses `claude mcp add` or `codex mcp add` when that CLI is on PATH,
and otherwise edits the config file directly. The registered command uses absolute paths to the running Node
binary and built `dist/cli.js`, so it works from any working directory. Running `install` again leaves one
entry. `install --print` describes the same changes without writing anything. `uninstall` removes the
`t3-tab` entries, plus the native host manifests and launcher; `--claude` and `--codex` limit it to those
agents.

`daemon` listens on `127.0.0.1:8765` by default. Set `T3_TAB_PORT` or pass `--port <number>` to change the
port. Its random token is stored in `$XDG_STATE_HOME/t3-tab/daemon.json` with mode `0600`, falling back to
`$HOME/.local/state/t3-tab/daemon.json`. `native-host` is normally started by Chromium, not by hand. `mcp`
serves the `status`, `tabs`, `read`, `screenshot`, `act` and `run_js` tools over stdio and starts the daemon
when needed.

## Page tools

`read` builds its text in the daemon from the accessibility tree the extension fetches over
`chrome.debugger` (`Accessibility.getFullAXTree`), trimmed in the extension to what the reader prints
(`packages/extension/src/ax.ts`). The reader is in `packages/server/src/reader`: `format.ts` turns the
tree into lines with refs, `refs.ts` keeps a ref stable for an element until the tab's document is
replaced, `smart-diff.ts` is the line diff, `find.ts` the search, and `page.ts` puts a reply together and
caps it at 12,000 characters. Diff baselines are kept per MCP server process, so two agents reading the
same tab do not take each other's diffs. A reply starts with `tab <id>: <title> — <url>`; when the session
last saw that same title and address for the tab, it starts with `tab <id>` alone.

`act` takes its steps as flat objects, `{ "action": "fill", "ref": "e7", "text": "Ada" }`, with the fields
`ref`, `text`, `key`, `dx`, `dy` and `ms` (`packages/server/src/tool-schemas.ts`): the schema the agent reads
is one object so the tool definition stays small, and `convertStep` there refuses a step that is missing a
field its action needs, carries one it does not take, or is out of range, then turns the step into the
nested form the extension runs (`ActStep` in `packages/protocol`). It resolves refs to backend DOM node ids,
runs its steps through Chrome DevTools Protocol input and DOM commands, and settles after every step by
waiting for network, DOM and layout activity to stay quiet. A navigation invalidates refs held from before
it. `run_js` evaluates an expression or async function body in the page for cases the structured tools do
not cover. The extension sends a WebSocket ping every 20 seconds while the daemon is connected so Chrome
does not stop its service worker.

`read` returns the main frame's document and same-origin child frames only. A child frame of another
origin, or one the browser cannot name, is left out with one line `frame omitted: <origin>` in its place
(`restrictToOriginFrames` in `packages/extension/src/ax.ts`). In Chromium 159 (checked headless) `Accessibility.getFullAXTree`
does not return child-frame content at all, so for now the filter only adds those lines. Screenshots are
not filtered for iframes.

`find` matches case-insensitive literal text by default. Passing `regex: true` opts into a regular
expression of at most 200 characters; it runs in a worker that is terminated after 500 ms. Every text box
is inspected in bounded batches; password values are removed before the accessibility tree leaves the
extension and render as `value=<redacted>`.

## Sessions and permissions

The daemon issues each session id and binds it to the control connection that registered it; tool requests
on another socket, or with another id, are refused. Tabs a session opens go into its own Chromium tab
group. It can list and use only tabs in that group or tabs the owner shares from the side panel.

Site permissions are stored per HTTP(S) origin: `ask` by default, `read` or `allow`. `read` lets sessions
read the site without a prompt and never covers opening, acting or `run_js`; `allow` covers all four. A read
prompt's lasting choice sets `read`; the lasting choice of an open, act or `run_js` prompt sets `allow`.
Every prompt and site button says what it grants. Each session also records the origins approved for each
tab by opening it, reading it, acting on it, or sharing it. A tab commit to a different origin clears those
approvals; `read` and `screenshot` then show a `read` prompt, while `act` and `run_js` keep prompting for
action. `tabs list`, `switch` and `open` show only the origin and `[needs approval]` for a member tab whose
current origin the session has not approved (and the site is not set to `read` or `allow`). A tab opened
from a tab of a session, through `chrome.webNavigation.onCreatedNavigationTarget`, joins that session's
group without inheriting origin approval; a tab opened from any other tab, such as one of the owner's own,
is left alone. A prompt names its tab id and title; it can time out or be declined, and one session may
have at most three waiting prompts. The side panel keeps prompt rows stable and disables a prompt's buttons
for 500 ms when it appears and again whenever a row is removed or inserted above another.

Membership, restricted-page and approved-origin checks run again after every permission wait and before
every `act` step. `run_js` runs only in the main frame's JavaScript context after the browser reports that
context's origin as the approved one, pinned by `uniqueContextId` (`mainWorldContext` in
`packages/extension/src/cdp.ts`), so a navigation that replaced the page makes the call fail; the
agent's text is never part of a check. A screenshot records the document epoch and address before the
capture and discards the image if either changed. An `act` batch stops if a document from another origin
replaces the page during a `type`, `press` or `scroll` step that has no ref; a new document on the approved
origin, such as the page a `press Enter` submits to, is fine. A tab that moves while approval is pending or between
steps is refused until its new origin is approved. Site setting writes are serialised.

Every browser tool refuses `chrome:`, `brave:`, `edge:`, `devtools:`, `chrome-extension:`,
`view-source:`, the Chrome Web Store and other non-HTTP(S) pages. The side panel's plain permissions view
is in `packages/extension/entrypoints/sidepanel`; its sharing and prompt calls live in
`packages/extension/src/panel.ts`, and the policy is in `permissions.ts`, `sessions.ts` and `tabs.ts`.

## CI

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Pull requests and pushes to `main` | Installs Node.js 26.13.1 and pnpm 12.21.0 with a frozen lockfile, then runs type check, lint, unit tests, build, the Chromium end-to-end harness and the token benchmark (its table goes to the job summary). |

## Reference projects

Much of this project is drawn from existing work: Browsentic, Playwriter, T3 Code, Playwright MCP and
others. Copy code only from openly licensed projects; keep their licence and copyright notices, mark copied
files as changed, and list each source in `THIRD_PARTY_NOTICES.md`. Claude in Chrome and the Codex Chrome
plugin are proprietary: study their behaviour and tool design, never copy their code.

## Checks

- Every change: type check, lint and unit tests.
- Before merge: the end-to-end run (Chromium with the extension loaded, driving a local test page through
  the real tools).
- When the tools or page reading change: the token benchmark (`pnpm bench`), with its results in the PR
  and the change from the base branch's numbers. CI runs it and fails when a number is over its budget.

Browser checks run headless or on another machine, never on the owner's desktop display.

Tests that touch agent configuration (`~/.claude`, `~/.codex`, T3's settings) or start agents run with a
temporary `HOME` and XDG folders, never against the machine's live configuration.

## What agents may do

Create branches, push them and open PRs. Ask first before touching the user's live browser profile beyond
test tabs, changing their T3, Claude or Codex configuration, or publishing to a web store or npm.

## How changes flow

- `main` is the only long-lived branch. Work on a task branch and open a PR against `main`.
- One concern per PR. A change in behaviour goes in its own PR, and the PR title says so.
- Commit messages and PR titles use Conventional Commits, scoped by part once parts exist, for example
  `feat(extension): ...` or `ci: ...`. Repo-wide docs use `docs: ...`.
- Open PRs ready for review, not as drafts. The owner reviews and merges.
- Licence: Apache-2.0 (`LICENSE`).

## Private

If `.private/AGENTS.md` exists, read it too: it holds the owner's private instructions and notes. Keep the
owner's messages, machine names, addresses, model routes and research notes out of this repo, its commits,
branches and PRs. Confirmed plans, decisions and major tradeoffs are written up in `docs/` in plain terms.
