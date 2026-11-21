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
- `e2e/` — the Playwright end-to-end harness.
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
```

`pnpm build` writes the Chromium extension to `packages/extension/.output/chrome-mv3`.
The built server is `packages/server/dist/cli.js`; `node_modules/.bin/t3-tab` runs it after installation.
`pnpm e2e` launches headless Playwright Chromium with that built extension, starts the real native host and
two MCP clients, and checks the loopback link and the browser tools against a local test site (a form,
links and a section that appears on a click): `tabs`, `read` with its diff, `find` and ref subtrees, and
`screenshot`, `act` and `run_js`. It also checks session tab groups, socket-bound session ids, tab sharing,
read and action prompts, cross-origin navigation and `window.open`, restricted pages, password redaction
and a regex timeout. Existing tool checks run with the site still set to ask and the harness answering
prompts with Allow once. The action run fills and submits the
test form, checks a stale ref after navigation, evaluates page JavaScript and waits past the extension
worker's idle timeout before another `status` call. It prints each reply and its size. Every process it
starts uses a temporary HOME and XDG directories.

## CLI

Build before running the CLI:

```sh
pnpm exec t3-tab daemon
pnpm exec t3-tab native-host install --browser chromium
pnpm exec t3-tab native-host install --browser chrome
pnpm exec t3-tab native-host install --browser brave
pnpm exec t3-tab mcp
```

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
same tab do not take each other's diffs.

`act` resolves refs to backend DOM node ids, runs its steps through Chrome DevTools Protocol input and DOM
commands, and settles after every step by waiting for network, DOM and layout activity to stay quiet. A
navigation invalidates refs held from before it. `run_js` evaluates an expression or async function body in
the page for cases the structured tools do not cover. The extension sends a WebSocket ping every 20 seconds
while the daemon is connected so Chrome does not stop its service worker.

`find` matches case-insensitive literal text by default. Passing `regex: true` opts into a regular
expression of at most 200 characters; it runs in a worker that is terminated after 500 ms. Every text box
is inspected in bounded batches; password values are removed before the accessibility tree leaves the
extension and render as `value=<redacted>`.

## Sessions and permissions

The daemon issues each session id and binds it to the control connection that registered it; tool requests
on another socket, or with another id, are refused. Tabs a session opens go into its own Chromium tab
group. It can list and use only tabs in that group or tabs the owner shares from the side panel.

Site permissions are stored per HTTP(S) origin: `ask` by default, or `allow`. Each session also records the
origins approved for each tab by opening it, reading it, acting on it, or sharing it. A tab commit to a
different origin clears those approvals; `read` and `screenshot` then show a `read` prompt, while `act` and
`run_js` keep prompting for action. `window.open` tabs from a session are kept in that session group without
inheriting origin approval. A prompt names its tab id and title; it can time out or be declined, and one
session may have at most three waiting prompts. The side panel keeps prompt rows stable and enables new
buttons after 500 ms.

Membership, restricted-page and approved-origin checks run again after every permission wait and before
every `act` step. `run_js` checks the origin both before evaluation and inside the evaluated context. A tab
that moves while approval is pending or between steps is refused until its new origin is approved. Site
setting writes are serialised.

Every browser tool refuses `chrome:`, `brave:`, `edge:`, `devtools:`, `chrome-extension:`,
`view-source:`, the Chrome Web Store and other non-HTTP(S) pages. The side panel's plain permissions view
is in `packages/extension/entrypoints/sidepanel`; its sharing and prompt calls live in
`packages/extension/src/panel.ts`, and the policy is in `permissions.ts`, `sessions.ts` and `tabs.ts`.

## CI

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Pull requests and pushes to `main` | Installs Node.js 26.13.1 and pnpm 12.21.0 with a frozen lockfile, then runs type check, lint, unit tests, build and the Chromium end-to-end harness. |

## Reference projects

Much of this project is drawn from existing work: Browsentic, Playwriter, T3 Code, Playwright MCP and
others. Copy code only from openly licensed projects; keep their licence and copyright notices, mark copied
files as changed, and list each source in `THIRD_PARTY_NOTICES.md`. Claude in Chrome and the Codex Chrome
plugin are proprietary: study their behaviour and tool design, never copy their code.

## Checks

- Every change: type check, lint and unit tests.
- Before merge: the end-to-end run (Chromium with the extension loaded, driving a local test page through
  the real tools).
- When the tools or page reading change: the token benchmark, with its results in the PR.

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
