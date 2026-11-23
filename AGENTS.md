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
- `docs/decisions.md` — lasting v1 design decisions, tradeoffs and out-of-scope boundaries.
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
`mcp list` output. The `daemon.json` token sent with the extension's `Origin` is refused. It then checks side-panel sessions (`e2e/panel-sessions.mjs`) with fake `t3`, `claude`
and `codex` commands (`e2e/fakes/`) first on the daemon's PATH, which record their arguments and drive the
real `t3-tab mcp` server: a T3 thread started with project, provider and model claims the owner's tab and
reads it, is continued with `t3 thread send` and polled with `t3 thread show`; the sign-in to a fake T3
environment (`e2e/fakes/t3-server.mjs`, T3's OAuth and `/mcp` answers, recorded in the temporary T3 home's
`server-runtime.json`) refuses a forged answer and a full-access grant, keeps a read-only one in a 0600 file,
lists T3's projects and models through the panel's request API, starts a thread with listed values and signs out, and no file,
panel reply, command argument or environment but the credential file holds a token; a made-up claim code and a
used one are refused; T3 stopped and T3 missing are reported; direct Claude Code and Codex runs start with
their isolating flags, read the tab, and are resumed with the session id they printed and a new claim code;
Full access is confirmed with a fake T3 per request with no live panel, and an unbound claim, a lowered mode or a stopped T3 prompts; a tab the owner unshares during a direct turn is not shared with the next turn, and neither is one removed
between turns with the conversation's Remove button; a missing, world-readable or replaced claim file warns in
the conversation and in the agent's first tool reply. It renders the panel from that state and, when
`T3_TAB_E2E_SCREENSHOT` names a file, saves a screenshot there. It prints each reply and its size. Every
process it starts uses a temporary HOME and XDG directories without the caller's `T3CODE_*` and `T3_TAB_*`
variables, `t3` is pinned to the fake through `T3_TAB_T3`, and every browser is headless.

`e2e/panel-flow.mjs` (not part of `pnpm e2e`, because it needs a real agent login) walks the panel from first open to
finished threads against a real throwaway T3 and again with T3 absent, and saves each screen at 400 px in light and
dark to the folder named by `T3_TAB_FLOW_SHOTS`.

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
`$HOME/.local/state/t3-tab/daemon.json`. The extension has its own random token in `extension.json` in the same
folder, also `0600`, which the native host passes to the extension. The daemon gives the extension role only to that
token together with the extension's `Origin`, so an MCP client using the `daemon.json` token cannot connect as the
extension. Any program running as the owner can read either file or run `t3-tab native-host` to get the extension
token. `native-host` is normally started by Chromium, not by hand. `mcp`
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

T3-Tab protects the browser from websites and from other users or machines. It does not protect it from programs
running as the owner, which can already read the owner's home folder, browser profile and T3's own data.

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
group without inheriting origin approval; a tab opened from any other tab, such as one of the owner's own
(shared or not), is left alone. A prompt names its tab id and title; it can time out or be declined, and one session may
have at most three waiting prompts. The side panel keeps prompt rows stable and disables a prompt's buttons
for 500 ms when it appears and again whenever a row is removed or inserted above another.

Membership, restricted-page and approved-origin checks run again after every permission wait and before
every `act` step. `run_js` runs only in the main frame's JavaScript context after the browser reports that
context's origin as the approved one, pinned by `uniqueContextId` (`mainWorldContext` in
`packages/extension/src/cdp.ts`), so a navigation that replaced the page makes the call fail; the
agent's text is never part of a check. A screenshot records the document epoch and address before the
capture and discards the image if either changed. An `act` batch stops if a document from another origin
replaced the page during a step other than `wait`, checked after the step's input and again after it
settles, so a page that came and went is caught too; a new document on the approved origin, such as the
page a `press Enter` submits to, is fine. CDP input cannot be aimed at one document, so input that reached
such a page is reported, not prevented. A tab that moves while approval is pending or between
steps is refused until its new origin is approved. Site setting writes are serialised.

Every browser tool refuses `chrome:`, `brave:`, `edge:`, `devtools:`, `chrome-extension:`,
`view-source:`, the Chrome Web Store and other non-HTTP(S) pages. The side panel lives in
`packages/extension/entrypoints/sidepanel` (React: first-run setup, a new-thread home, the thread view, and the
thread list and settings behind icons, coloured only from T3's theme roles); its sharing and prompt calls live in
`packages/extension/src/panel.ts`, and the policy is in `permissions.ts`, `sessions.ts` and `tabs.ts`.

A permission prompt shows as a card in the side panel and, when the agent's client supports MCP form elicitation,
in the thread the agent runs in. The first answer counts and closes the other. An accepted question allows that one
request; site-wide grants are made only in the side panel. `claude -p` and `codex exec` cancel these questions, so a
direct run asks in the side panel only.

T3's Full access counts as yes for a browser request only while T3 itself confirms it (`t3-full-access.ts`). When a request
needs a prompt, the extension asks the daemon, which runs `t3 thread show --json --messages 0 <threadId>` for the thread the
session's claim is bound to; that works with the side panel closed. If every grant the session holds is bound to a T3 thread
and each thread reports `full-access`, the request goes through with no card, writes no site setting and is listed in
`autoAllowed`. A yes counts for two seconds from when its read started, and a request is allowed only at a moment when every
thread the session holds has such a yes; a thread that lapsed while another answered is read again. So after any of its
threads leaves Full access, a session's request can pass for at most two seconds, and a late answer never allows the request
waiting on it. A request waits at most five seconds for all of them to be live together, then prompts. Requests share one
read per thread until that read is five seconds old; after that the next request starts a fresh `t3` command, and an
abandoned read that answers later cannot overwrite a newer answer. A pass from
Full access records no origin approval, so reads, screenshots and the title in `tabs` follow the live mode too, and the tab
shows `[needs approval]` again once the thread leaves it. An Allow once still records its approval for the tab. An unbound
claim, a direct run's claim, another mode, a stopped T3 or no answer within five seconds all mean a normal prompt. Every
other check still runs. Withdrawing a claim no thread was bound to also takes back the tabs an agent got through it.

## Side panel sessions

The side panel starts and continues agents with the owner's tabs; T3-Tab never runs a model. When T3 Code is
connected the panel is a T3 client and T3 starts and runs every thread. When it is not, the picked provider runs
directly through the daemon and feeds the same thread view.

- **The panel's T3 session.** Connect signs a DPoP proof and calls the daemon's `t3.pair`. The daemon checks that the
  recorded T3 process owns the listener, mints a five-minute pairing credential with `t3 auth pairing create`, and spends
  it at T3's `/oauth/token` itself, so the credential never reaches the extension. The result is a DPoP-bound session with
  T3's default client scopes, the same access T3's own apps get. The signing key is non-extractable and stays in the
  extension's IndexedDB; the token is in `chrome.storage.local`, renewed by T3 for up to 30 days. Renewal and WebSocket
  tickets go through the daemon's `t3.session`, which sends them with `confirmedFetch` and sends nothing when T3 now runs at
  another address than the stored one; the panel then asks the owner to connect again. Those requests are checked on
  Linux only, as `confirmedFetch` is, so Connect is unavailable elsewhere.
- **The WebSocket is not checked.** The browser opens the panel's one socket to T3's `/ws`
  (`entrypoints/sidepanel/lib/t3-rpc.ts`, `t3-client.ts`), so no process check covers it. A process that took T3's port
  between the ticket request and the socket could receive that ticket and its one-use proof, and whatever the panel sends
  on the socket. Disconnect drops the session and revokes it through `t3.unpair`. The read-only sign-in and the `t3 thread`
  polling below remain in the daemon, but the panel no longer uses them.
- **Themes.** The panel follows T3's active theme by default. T3 theme files can be imported, and any theme can be
  edited; custom CSS goes through T3's own filter, which removes rules that load remote files.

For direct runs and the older routes, the panel asks the extension's service worker, which passes the request over
its link to the daemon (`browser.daemonRequest`, answered with `daemon.reply`). The daemon keeps those conversations
in memory (`packages/server/src/agents/`), so they end when it stops.

- **T3 Code threads through the CLI (older route, not used by the panel).** The daemon runs `t3 thread start --json [--provider <instance> --model <slug>]
  <project> -`, `t3 thread send --json <thread> -` and `t3 thread show --json --messages 20 <thread>`, with
  the message on stdin, and polls `show` every 3 seconds until the run it started reaches a terminal status.
  A run waiting on an answer stays followed, polled less often up to every 30 seconds. `idle` and `completed`
  show as done; `failed`, `interrupted`, `cancelled` and `rolled_back` show as failed with a fixed sentence for
  that status, because `t3 thread show --json` prints no failure reason (the reason stays in T3 Code); a
  status T3-Tab does not know stays followed. After 6 hours T3-Tab stops following and shows that as a failure,
  though the thread may still be running in T3. Each `t3 thread` command signs in to T3
  for a moment, so the panel checks T3's state at most once a minute unless the owner reopens the panel. The project is
  a T3 project id or a folder inside one; provider and model are optional (both or neither). The `t3` CLI has
  no command that lists projects, providers or models; the panel picks them from lists once T3-Tab is signed
  in to T3 (below), and otherwise takes them as text. Choosing "Type…" in a list brings the text fields back.
- **Signing in to T3 for the lists (older route, no longer shown in the panel).** The `panel.t3SignIn` request signs the daemon in to the
  local T3 environment's `/mcp` endpoint the way T3's outside agents do (`packages/server/src/agents/t3-access.ts`):
  OAuth metadata, dynamic client registration as "T3-Tab", and the authorization code flow with PKCE (S256).
  The address comes from `<T3 home>/userdata/server-runtime.json` (only `origin`, `pid` and `startedAt`; its server
  must be alive, and the address a loopback `http` one). The extension opens T3's approval page in a normal tab; the owner
  approves there and picks the access level. When T3 asks for a sign-in code there, the owner creates one in T3 Code under
  Settings → Sharing & access, and the panel says so while the sign-in waits. T3 sends the answer to a one-use listener on `127.0.0.1` that
  checks `state` and `iss` (T3's metadata must promise `iss`, and an answer without it is refused) and closes after
  one answer. T3-Tab keeps the sign-in only when T3 granted exactly
  `orchestration:read` (T3's "Read only"); anything broader is not stored, and the panel asks the owner to
  revoke it in T3 and sign in again. The token is stored only in `t3-credential.json` in T3-Tab's state folder
  (next to `daemon.json`, written as a new 0600 file and renamed into place), sent only to that environment's
  `/mcp` with redirects refused, and used only for `t3_project_list` and `orchestrator_capabilities`
  (`t3-catalog.ts`). T3-Tab never hands it to the extension, the panel, logs, error messages, agents, or a
  command's arguments or environment. Like every file in the owner's home, the 0600 file is still readable by any
  program running as the owner, coding agents included; the sign-in is read-only and ends after 30 days.
  A sign-out cancels a sign-in at any stage, and writing the file and signing out run one at a time, so a sign-out
  during a sign-in leaves no credential. Every request to T3 opens its own connection and is sent on it only after
  `/proc/net/tcp{,6}` and `/proc/<pid>/fd` show that the recorded pid accepted that connection and that the process
  did not start after T3's `startedAt` (`t3-connection.ts`). That comparison has no tolerance: the start time read
  from `/proc` is rounded down by at most 1.01 s, so a process started less than that after the record can still
  pass, and a forward wall-clock step after T3 started can refuse T3 until it restarts. A backward wall-clock step
  makes processes look as if they started earlier, so a process that reused T3's recorded pid could pass the
  start-time check; it still has to hold the accepted connection, and programs running as the owner are outside
  T3-Tab's trust model anyway. Where there is no `/proc` (any platform but Linux),
  T3-Tab sends nothing, so the sign-in and the lists are unavailable and the project and model are typed instead.
  T3 issues no refresh tokens and offers a client no way to revoke itself: a
  sign-in lasts 30 days, a refused token is deleted, and "Sign out" deletes the file and any temporary copy a crash left (the
  daemon also removes those when it starts) and tells the owner to
  revoke T3-Tab in T3's Settings → Sharing & access to end it there at once. The lists are fetched on sign-in,
  when the panel opens, and on "Reload lists"; after a failure, at most once a minute. Threads still start and
  continue through `t3 thread`.
- **Finding `t3`.** `T3_TAB_T3` when set (and then only it), else `t3` on PATH or in the usual install
  folders, else the launchers listed in `<T3 home>/runtime/launchers`, else `<T3 home>/runtime/bin/t3`, else
  the desktop app's launcher `<T3 home>/bin/t3`, else the newest fully installed
  `<T3 home>/runtime/versions/<version>/t3`; the T3 home is `T3CODE_HOME` or `~/.t3`. Whether T3 is running
  comes from `t3 thread list --json --project /`: a running server answers that no project matches, a stopped
  one that it is not running. The panel shows "not found" or "not running" and then offers the direct runs.
- **Direct runs.** The message goes on stdin, the folder defaults to the home folder, and each turn is one
  process, continued with the session id the CLI printed. The agent gets T3-Tab's tools and no others:
  - Claude Code: `claude -p --output-format stream-json --verbose --restricted --setting-sources ""
    --strict-mcp-config --mcp-config <T3-Tab only> --tools "" --allowedTools mcp__t3-tab --permission-mode
    dontAsk --disable-slash-commands [--model <m>] [--resume <session>]`. User, project and local settings and
    their hooks are not loaded, there are no built-in tools, and anything not allowed is denied without a
    prompt. The login is untouched. Organization-managed settings still apply, and a `CLAUDE.md` in the folder
    is still read as text.
  - Codex: `codex exec [resume] --json --skip-git-repo-check --ignore-user-config --ignore-rules --disable
    <feature>… -c approval_policy="never" -c sandbox_mode="read-only" -c web_search="disabled" -c
    mcp_servers.t3-tab.*=… [-m <m>] [<session>] -`. `$CODEX_HOME/config.toml` is ignored while the login there
    still works, which also leaves a project's `.codex/config.toml` untrusted and unapplied. The disabled
    features are the shell, image viewing, apps, plugins, hooks, sub-agents, browser and computer use, image
    generation, goals, memories and web search; `--disable` stops the run if Codex no longer knows a name. Codex
    0.166.0 keeps `unified_exec` on whatever the flag says, and registers no shell tool while `shell_tool` is off,
    so `shell_tool` is the setting that removes the shell. The
    `t3-tab` entry sets its command, arguments, enabled state, tool list, approval and a 330-second tool
    timeout (T3-Tab itself waits up to 310). System-level Codex config (`/etc/codex`) still applies. Nothing
    else in the owner's `config.toml` applies to these runs except the active custom provider, its model and
    that one `[model_providers.<name>]` table (`codex-provider.ts`), passed as `-c` settings with any bearer token
    or static header moved to environment variables of the Codex process only, never onto its command line.
- **Stopping a run.** Direct runs and `t3` commands run in their own process group. A timeout or daemon
  shutdown sends SIGTERM to the group and, 5 seconds later, SIGKILL to whatever is left of it, even if the
  group's first process has already exited. It then waits for the process to close. The conversation shows as
  failed with the reason. Once shutdown starts, no new `t3` command or direct turn is started.
- **The owner's tabs.** Start shares the current tab, or every tab of its group when the owner made that
  group (not a session's). The extension issues a random claim code for those tabs (`claims.ts`, kept in
  `chrome.storage.session`) and the daemon only passes it on. A code works once: redeeming it reserves it for
  one session in a serialized step with the expiry check, shares all its tabs in one storage write, then deletes
  it. If that fails, the shares are taken back and the code can be tried again until it expires; a reservation
  whose worker stopped lapses after 30 seconds. A code works only by the route it was issued for, so a direct
  run's code is refused through the `tabs` tool.
  - A direct run's code lasts up to an hour. Each turn gets a new one, for the tabs still shared with that
    conversation: a tab the owner unshared is left out. The daemon writes it to a `0600` file in a private
    folder under its state folder and passes only the path (`t3-tab mcp --claim-file <path>`). The MCP server
    reads and deletes the file, and the daemon removes the folder when the turn ends. The code is never in a
    command line, an environment variable or the agent's context. If a claim fails, the conversation shows a
    warning and the tool call still runs without the tabs. If the MCP server cannot use the file (missing, readable
    by others, another owner, not a regular file, or no valid code), it reports that to the daemon, the
    conversation shows a warning, and the agent's first browser tool reply says it has no shared tabs.
  - A T3 thread's agent starts its MCP servers from its own config, so the code has to be in its first message,
    in a line asking it to call `tabs` with `{"claim": "<code>"}`. That message stays in T3's stored transcript.
    The code there is harmless once used, and it expires after 10 minutes if it is not. If the provider restarts,
    the new session has no tabs until the owner shares one from the session list.
  - The panel hides the claim line and replaces any code of the conversation in replies, titles and errors.
  - Each conversation's view lists the tabs it holds, each with a Remove button, and says which tabs the next
    message will share. Remove works between direct turns, when no session is connected: the tab leaves the
    conversation's later codes and any of its sessions still connected.

  The session that claims gets the tabs shared as the panel's "Share current tab" does: a tab still on the
  origin it showed at start is shared with that origin approved, and a tab that moved is shared unapproved.
  Every prompt, site setting and check above still applies, and the owner can unshare from the session list or the
  conversation's view. A
  code the extension did not issue is refused.
- **Versions.** The extension, native host and daemon must speak the same `PROTOCOL_VERSION`. On a mismatch
  the link closes and the panel says to rebuild, run `t3-tab install` and reload the extension.

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
