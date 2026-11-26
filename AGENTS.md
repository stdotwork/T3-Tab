# AGENTS.md

T3-Tab exposes the user's own signed-in Chromium browser as MCP tools for coding agents (Claude Code,
Codex, T3 Code threads and any MCP client), and adds a side panel that starts and continues real agent
sessions, through T3 Code or directly. It never runs its own agent loop: the agent the user picks does the
work, with the browser tools injected.

## Layout

- `packages/extension` — the WXT Manifest V3 Chromium extension, including its service worker and side panel.
- `packages/server` — the Node.js/TypeScript daemon, Chrome native host and stdio MCP server. The
  `t3-tab` binary in `dist/cli.js` provides all three commands, plus `setup` and `uninstall`.
- `packages/helper` — the npm package `t3-tab` (not published yet): `build.mjs` bundles the server and its
  dependencies into one file, `dist/cli.js`, which is what users install (below).
- `scripts/` — `install-test-build.sh` (installs the packed helper from a GitHub prerelease, the stand-in for npm
  until the package is published) and `publish-test-build.sh` (refreshes that prerelease from a checkout).
- `packages/protocol` — the versioned types shared by the extension and background program.
- `docs/decisions.md` — lasting v1 design decisions, tradeoffs and out-of-scope boundaries.
- `e2e/` — the Playwright end-to-end harness; `e2e/harness.mjs` holds the setup the end-to-end run and the
  benchmark share (temporary HOME, headless Chromium with the extension, MCP clients).
- `bench/` — the token benchmark, its fixed pages and its budget; `bench/compare` (T3-Tab against other browser MCP
  servers, scripted calls) and `bench/agent` (the same, with a real model in the loop).
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
pnpm bench:compare
pnpm bench:agent
```

`pnpm build` writes the Chromium extension to `packages/extension/.output/chrome-mv3` and the packed helper's
bundle to `packages/helper/dist/cli.js`.
The built server is `packages/server/dist/cli.js`; `node_modules/.bin/t3-tab` runs it after installation. That is
the developer path; users get the helper from `t3-tab setup` (see "Installing the helper").
`pnpm e2e` first installs the helper the way a user does (`e2e/checks-product-install.mjs`): `npm pack` of
`packages/helper`, then `npx --package <tarball> t3-tab setup` run from a temporary folder outside the repository
with a temporary HOME, into a headless Chromium that is already running with the extension and no helper. It checks
that the panel's helper state goes from missing to connected with no reload and the background program started by
the browser, that Add for Claude Code writes an entry naming the installed launcher and that entry's `mcp` server
sees the browser, that running `setup` again over a daemon of another version stops it and the browser reconnects
to a new one, that `uninstall` removes the helper folder, manifest, state and agent entry and stops the daemon,
that `scripts/install-test-build.sh` (through a `file://` address) installs the same helper, and that a browser
started with its own `--user-data-dir` finds it once `setup` names that folder. Then `e2e/checks-real-use.mjs` runs in a headless Chromium only the extension debugs, because Playwright answers
dialogs itself and makes hidden tabs act focused: dialogs, background input, another extension's frame
(`e2e/fixtures/frame-injector`), `run_js` parsing, plain-text diffs, image refs and same-origin frames. `e2e/checks-agent-tools.mjs`, in such a browser too, checks that `tabs open` asks before anything loads and opens behind the owner's tab, that every tool works on that hidden tab, redirects, `find` past a display cut, link addresses, key spellings, `goto`, `back`, `forward` and a `reload` that never resends a form, the `depth` mark, and that an action leaves no global in the page. Then it launches headless Playwright Chromium with that built extension, starts the real native host and
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
reads it, is continued with `t3 thread send` and polled with `t3 thread show`; a made-up claim code and a
used one are refused; T3 stopped and T3 missing are reported; direct Claude Code and Codex runs start with
their isolating flags, read the tab, and are resumed with the session id they printed and a new claim code;
Full access is confirmed with a fake T3 per request with no live panel, and an unbound claim, a lowered mode or a stopped T3 prompts; a tab the owner unshares during a direct turn is not shared with the next turn, and neither is one removed
between turns with the conversation's Remove button; a missing, world-readable or replaced claim file warns in
the conversation and in the agent's first tool reply. The thread list, given T3 threads as one shell snapshot, shows T3's
sidebar sections in T3's order (pinned, active, then the Working, Snoozed and Settled shelves), leaves archived threads
out, and the threads button carries a dot only while a thread waits on the owner's answer or approval. The composer
keeps the paperclip, model, mic and send in that order at 320, 360 and 400 px with no access row under it; the mic says why it cannot record without T3; a PDF for a direct run is named and holds the message; a pasted image is attached; a PNG
dragged over the heading shows the whole-panel drop overlay, is attached when dropped there and
reaches the fake Claude Code as an image block, while a file dropped on Settings is refused; Settings has a 28 px
color scheme row, T3 Code's built-in theme with T3's shared theme ignored, and a theme menu with swatches, Create
theme and Add theme, and each theme's actions beside it; and with T3's config handed to the panel, the access level is chosen in
the model picker. The layout check (`e2e/checks-layout.mjs`, measuring with `e2e/ink.mjs`) walks the new-thread
screen (direct and T3, with and without a project), the model and project pickers, the thread list, a thread, Settings
and a theme sheet at 320, 360 and 400 px in light and dark, and measures visible ink (SVG strokes and fills, text glyphs
on their baseline, painted boxes), never padding boxes. It fails when a bar's or the composer row's first and last
controls sit at ink distances from its edges more than 1 px apart, when the composer's send circle is not as far from
the frame's foot as from its side, when the composer's controls are not one size or their ink (and the model chip's
logo and words) is off one centre line, when its text does not start on the paperclip's ink, when the hero's project
line is off the heading's ink centre, or when one bar's icons, or the composer row's glyphs, are drawn at different
sizes or stroke weights. It renders the panel from that state and, when
`T3_TAB_E2E_SCREENSHOT` names a file, saves a screenshot there. It prints each reply and its size. Every
process it starts uses a temporary HOME and XDG directories without the caller's `T3CODE_*` and `T3_TAB_*`
variables, `t3` is pinned to the fake through `T3_TAB_T3`, and every browser is headless, with a short temporary folder of its own, because Chromium aborts when its socket path gets too long. Last of all it stops the daemon (`e2e/checks-reconnect.mjs`) and checks that an MCP client that was already running gets a new session on its next call, is told once that the earlier one ended, and that `status` reports each state of its link.

`e2e/panel-flow.mjs` (not part of `pnpm e2e`, because it needs a real agent login) walks the panel from first open to
finished threads against a real throwaway T3 and again with T3 absent, and saves each screen at 400 px in light and
dark to the folder named by `T3_TAB_FLOW_SHOTS`.

`pnpm captures` (after `pnpm build`, with `T3_TAB_CAPTURES_DIR` naming an output folder; not part of `pnpm e2e`) renders every panel view at 400 x 800 in light and dark from one fixed shopping scenario with the e2e fakes and the product's `npx t3-tab@latest setup` command, and writes it three ways: `panel/` as drawn, `framed/` on one browser-window frame with the product's and T3 Code's names masked (for blind rating beside other products), `framed-named/` on the same frame unmasked (`e2e/captures.mjs`).

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

`pnpm bench:compare` and `pnpm bench:agent` (after `pnpm build`) set T3-Tab against `chrome-devtools-mcp` (default and
`--slim`), Playwright MCP, agent-browser and Playwriter; neither is part of CI or `pnpm test`, and each has a README in its folder.
`bench:compare` sends each tool a fixed call sequence, no model, and counts what comes back. `bench:agent` runs a real model
(headless Claude Code, Haiku 5.5 by default, one MCP server and no built-in tools, a temporary HOME) on ten local tasks, or with
`--sites real` on the frozen held-out set of eight public-site tasks (`bench/agent/real-tasks.mjs`: change a task only because
its site changed, never to suit a tool; needs network and keeps the rate low). Success is checked from the page or a known answer,
never from the model's words. Every run is also measured net of a no-tool baseline run on the same task, so a tool is judged on
tool-attributable tokens (a run's tokens minus the input of the baseline's first request, not the baseline's whole run: with no tools the model improvises and Claude Code continues it, so a whole baseline run makes several requests and its total moves by thousands of tokens) and model requests, as the geometric mean over tasks of
per-task ratios against T3-Tab with a 90% bootstrap interval; `--repeats` defaults to 5. It needs a model route in the
environment (`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, or `CLAUDE_CODE_OAUTH_TOKEN`) and spends real quota: run it
with a small `--repeats`, `--tools` and `--tasks` while developing. The other tools' browsers start with `--disable-extensions`,
because this machine registers Claude in Chrome system-wide and a browser with a new profile would install it.

## Installing the helper

Users add the extension from the browser's store and run one command from any folder: `npx t3-tab@latest setup`
(the panel shows it with a copy button; `packages/extension/src/helper-command.ts` holds it, with the test command
the prototype build shows until the package is published, behind one constant, `HELPER_CHANNEL`). It needs Node.js
20 or newer; without it the shell reports `npx` or `node` not found and the panel keeps showing the command.
`setup` runs from the bundled file (an unbundled build refuses; `__T3_TAB_VERSION__` is set only by the bundler):

- It copies the bundle to the per-user helper folder (`helperLayout` in `packages/server/src/helper-layout.ts`:
  `$XDG_DATA_HOME` or `~/.local/share/t3-tab` on Linux, `~/Library/Application Support/T3-Tab` on macOS,
  `%LOCALAPPDATA%\T3-Tab` on Windows) and writes the launchers `t3-tab` and `native-host` (`.cmd` on Windows) that run it
  with the Node that ran `setup`, or `node` on PATH if that one is gone. `install.json` records the version and
  everything `setup` wrote.
- It registers the native host for every browser it finds (`install-native-host.ts`): Chromium, Chrome, Brave, Edge
  and Vivaldi. Linux and macOS write `NativeMessagingHosts/com.t3tab.native.json` in the browser's profile folder
  (Linux honours `XDG_CONFIG_HOME`), and also in the profile folder of a browser process running with its own
  `--user-data-dir`, which a browser reads instead of its usual folder (`runningProfiles`: `/proc` on Linux, `ps` on
  macOS). Browsers running headless and profiles under a temporary folder are test browsers and are skipped;
  `--user-data-dir <folder>` names a folder to serve whatever it is, running or not. Windows adds an HKCU key per browser
  (`Software\<vendor>\NativeMessagingHosts\com.t3tab.native`, through `reg.exe`) pointing at one manifest file in the
  helper folder. The manifest allows `EXTENSION_IDS` (the manifest `key`'s ID, plus `STORE_EXTENSION_ID` once set in
  `packages/protocol/src/index.ts`).
- It stops a running daemon whose `daemon.json` shows another helper or protocol version (after an authenticated
  health check, so a reused process number is never signalled), so the browser's next connection starts the new one.
- `--agents` also adds T3-Tab to Claude Code and Codex when found; the panel's Add buttons do the same one agent at
  a time (`Setup.addAgent`). The entry is the launcher with `mcp` (`mcpCommand`), or Node and the installed file on
  Windows, never a checkout path or the npx cache. `--print` describes without writing.
- `uninstall` (also from the installed `t3-tab`) stops the daemon, removes agent entries, every registration in
  `install.json` and the usual places, the helper folder and the state folder; a manifest that is not T3-Tab's is
  left alone. With `--claude` or `--codex` it removes only those agents' entries and keeps the rest, which the other
  agent and the browser still use.
- With no browser link written, `setup` says how to name one (`--browser`, `--user-data-dir`) and exits 1. `--help`,
  `-h` and `help` print usage and exit 0, for the program and for each command.

A browser reads the native host manifest again on every `sendNativeMessage`, so a helper installed while the browser
runs is found without a reload (checked in headless Chromium, in the end-to-end run). The panel asks every three
seconds while the helper is missing; the browser starts the daemon through the native host. The panel's helper state
says why it is missing (`HelperProblem` in `daemon-link.ts`): not registered, registered for another extension ID,
the native host stopped, or the helper or the extension is behind (the side that sees the other's newer or older
protocol version says so), and shows the command or a pointer to the extensions page accordingly.

**The panel and the service worker can be different builds.** An unpacked extension's panel files are read from disk
each time the panel opens, but its service worker keeps the code it started with until the extension is reloaded (the
daemon link's 20-second ping keeps it alive), so after a rebuild a new panel can talk to an old worker. Both carry
`BUILD_ID` (`src/build-id.ts`, set per build by `wxt.config.ts`; `T3_TAB_BUILD_ID` fixes it). The panel asks the worker
`panel.build` first (`checkWorkerBuild` in `lib/store.ts`). A different ID, or a worker too old to know the request
(it answers `Invalid panel request`), makes the panel write `t3tab.workerReload` (its build ID and the time) to
`chrome.storage.local` and call `chrome.runtime.reload()`, which closes the panel; opening it again finds the new worker.
The write comes first and a reload already tried for the same panel build in the last five minutes is not repeated, so
it cannot loop: the panel then says the extension is still an old build and to reload it on the extensions page. A
failed request (the worker restarting) is asked again later and reloads nothing. Whatever the helper connection last
hit is shown in the helper row (`helperNote` in `Setup.tsx`, from `HelperState` in `daemon-link.ts`): a native
messaging error, a `native.error` from the host, or a WebSocket that never opened or was closed, with its code and
reason (`noteSocketClosed`), each with its one action; "Run this in a terminal" appears only when the browser reports
no helper registered, and "Connecting" while no attempt has failed yet. `e2e/checks-stale-worker.mjs` swaps the files
under a running browser, covers a worker too old to answer and a reload that does not help, and renders each error.
Headless Chromium cannot bring back a `--load-extension` extension after `chrome.runtime.reload()`, so there the
panel's call is recorded and the browser is restarted on the same profile without its cached worker script; the real
call was not exercised in headless Chromium, and whether a real side panel comes back by itself after it was not checked.

The macOS and Windows registrations are written and unit-tested (`helper-install.test.ts`) but have not been run
on those systems. Linux was run, with Node 26.13.1 only.

## CLI

The developer path, from a checkout. Build before running the CLI:

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

`setup` is what users run (see above); from a checkout it refuses, because only the bundle can be copied.
`install` registers `t3-tab mcp` as a user-level stdio MCP server for Claude Code in `~/.claude.json` and
Codex in `$CODEX_HOME/config.toml` (`~/.codex/config.toml` when `CODEX_HOME` is unset), with a 330-second
`tool_timeout_sec`, because a browser prompt can wait longer than Codex's 60-second default. When neither `--claude`
nor `--codex` is given, it registers every agent whose CLI or config it finds. When `--browser` is omitted, it installs
the native host for every Chromium, Chrome, Brave, Edge or Vivaldi installation it finds. It uses `claude mcp add` or `codex mcp add` when that CLI is on PATH,
and otherwise edits the config file directly. The registered command uses absolute paths to the running Node
binary and built `dist/cli.js`, so it works from any working directory. Running `install` again leaves one
entry. `install --print` describes the same changes, including running profiles, without writing anything. `uninstall`
removes the `t3-tab` entries, plus the helper, native host manifests and state; `--claude` and `--codex` limit it to
those agents' entries.

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

Text is cut for display, never for search. The extension keeps each name up to 8,000 characters (2 MB a page, then 300
each) and drops the line-wrap boxes the reader never prints; the reader prints up to 300, and `find` searches all of it
and prints a window around the match. Every cut ends in `…`. A link shows its address (`→ /path`, relative on its own
site) when another link of the same name goes elsewhere, when it has no name, when it is the element a `ref` read asks
for, and in `find`. With `depth`, an element with more inside ends in `…`.

`tabs` also moves a tab: `goto` with a `url`, `back`, `forward` and `reload`. `goto` asks like `open` does. `back`,
`forward` and `reload` revisit a page the tab has shown, so they ask only for an origin the session holds no approval
for on that tab. The browser's reload resends a form's POST without asking, so unless the debugger saw the document come
from a GET, `reload` fetches the address with a new GET (`location.replace`, which keeps the history).

A call that names no tab uses the session's current tab, marked `[current]`: the last it opened, switched to or was
handed by the owner, else the tab in front, else its first. The owner moving between tabs does not change it, so an
action cannot land on a tab the agent did not mean.

`act` takes its steps as flat objects, `{ "action": "fill", "ref": "e7", "text": "Ada" }`, with the fields
`ref`, `text`, `key`, `dx`, `dy` and `ms` (`packages/server/src/tool-schemas.ts`): the schema the agent reads
is one object so the tool definition stays small, and `convertStep` there refuses a step that is missing a
field its action needs, carries one it does not take, or is out of range, then turns the step into the
nested form the extension runs (`ActStep` in `packages/protocol`). It resolves refs to backend DOM node ids,
runs its steps through Chrome DevTools Protocol input and DOM commands, and settles after a click, a key press, a
scroll, a hover, a wait and the last step by waiting for network, DOM and layout activity to stay quiet. A `fill`, `type` or
`select` between other steps does not settle on its own: the batch settles once before the next step of the kinds above. The
settle ends after 150 ms of quiet, so a check the page runs within about 150 ms of the field change (a short debounce) is in
before the click, and a longer one may not be: the agent adds a `wait` step, which the `act` description says. A field step settles at once when a document was
replaced or a request began while it ran, and the stale-ref error then names that step. A navigation invalidates refs held from before
it. `run_js` evaluates an expression or async function body in the page for cases the structured tools do
not cover. The extension sends a WebSocket ping every 20 seconds while the daemon is connected so Chrome
does not stop its service worker.

`read` returns the main frame's document and same-origin child frames. `Accessibility.getFullAXTree` does not
include child-frame content, so `addSameOriginFrames` (`packages/extension/src/page.ts`) fetches each child frame of
the approved origin, up to 20, walking down only through such frames, and drops one that navigated during the fetch.
A child frame of another origin, or one the browser cannot name (a sandboxed frame), is left out with one line
`frame omitted: <origin>` in its place (`restrictToOriginFrames` in `packages/extension/src/ax.ts`). Screenshots are
not filtered for iframes.

With `all`, images are listed with a ref, named or not, so they can be hovered or clicked. The default view leaves
plain text out but still tracks it: a read or `act` whose only change is plain text replies `Text changed since the
last read:` with that diff, and a reply about changed elements adds up to 10 lines of `New text:`.
An `act` reply leaves out what the batch itself set: a changed line whose only change is the value a `fill`, a `type` with a
ref or a `select` gave it (`packages/server/src/reader/echo.ts`) is settled against the earlier read, so it is not a change, and
the reply names those refs on one line (`Set e7, e8, e10.`). A line the page changed in any other way, or to another value
(a mask, a rejected option, an `invalid` flag), and any line it cannot match to the step, stays in the reply.

**JavaScript dialogs.** A dialog pauses the page, so every command that reaches it would hang. `cdp.ts` tracks
`Page.javascriptDialogOpening` and fails such commands at once with a notice naming the dialog. `act` answers it:
`press Enter` accepts, `press Escape` dismisses (in any of the usual spellings), and a `type` step without a ref holds a prompt's text until Enter.
A step that opens a dialog counts as done, so the same batch can answer it. Answers run one at a time per tab and
are refused if another dialog replaced the one checked; the browser's command names no dialog, so a replacement in
the instant before it lands cannot be caught. A dialog from a frame of another origin
is named by origin only and can only be dismissed. `tabs open` attaches the debugger on `about:blank` before loading
the page, because a dialog opened before the debugger attached cannot be answered through it; on a tab the owner
already had open, the tool says to ask the owner to answer it.

**Background tabs.** Chromium never acknowledges wheel input on a hidden page and holds mouse input for seconds, so
an `act` batch on a hidden tab turns on `Emulation.setFocusEmulationEnabled` while its steps run and off afterwards.
So do a screenshot and a load through `tabs`, because a hidden page gets no animation frames and would stay blank if it
renders from script. A load replies after the first two frames and holds the tab visible until the page settles. The page sees itself as visible and focused for that long.
A tab the owner cannot see (not the active tab of its window, or in a window that is minimised, `visibility.ts`;
a window that is merely not in focus is still on screen) that has been in the background for a few seconds can ignore the mouse wheel and draw no frame. There a
wheel scroll reads the scroll position of the page and of the elements under the pointer (`scroll.ts`, in T3-Tab's own
world) before and after, and the step fails with a reason when nothing moved although the page or one of them had room. The
reading stops at a scroller that overflows on the wheel's axis and whose `overscroll-behavior` keeps the wheel, and treats a page with `overflow` hidden or clipped
as having no room; a page at its end or one that does not scroll is not an error. In a tab the owner can see a scroll is never
failed, because a page may take the wheel itself. A screenshot of a tab the owner cannot see gives up after 3 seconds
(a `CommandTimeoutError` for `Page.captureScreenshot`) and says the tab is in the background; a tab the owner can see keeps the
browser's 15 second limit. The messages do not tell the agent to `tabs switch`, which moves the owner's view.
The settle probe runs in an isolated world (`privateWorld` in `cdp.ts`), so its observer and counter are not on the page.

**Other extensions' frames.** Chromium drops `chrome.debugger` from a tab, and refuses to attach, while any frame in
it belongs to another extension, such as a password manager's autofill menu; blocking the frame's request does not
prevent it. `clearForeignFrames` (`foreign-frames.ts`) points those frames at `about:blank`, including inside closed
shadow roots, and the debugger attaches again. This is the only use of the `scripting` permission and `<all_urls>`
host access, and it runs only while the tab is on the origin the running tool call was approved for. Refs stay valid
after a reattach only when the main document's loader id is unchanged and `chrome.webNavigation` saw no top-frame
commit in between. Input that was in flight when the debugger dropped is not sent again.

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

`tabs open` asks first, for the requested address: nothing is created, fetched or run until the owner says yes. Then
the page loads in a new tab behind the one the owner is on, with the debugger attached on `about:blank` first. If a
redirect takes it to another origin, the tab stays in the session's group unapproved, and the reply names the origin and
says to read it to ask for access; an origin that is already allowed just carries on.

When the control connection closes (the daemon stopped or restarted), that session is over: the daemon forgot
it, with its tab group, approvals and shared tabs. An MCP server does not resume it. A call that was in flight
fails, and the next tool call starts a new session on a new connection, through `ensureDaemon`, which restarts
the daemon if needed; if that fails, the error says why and the call after it tries again. The first browser
tool reply after that says the earlier session ended and that its tabs and approvals are gone, so the agent
opens tabs again or asks the owner to share one. A claim code, and a claim-file report, go with the first
registration that succeeds and are never sent again, because a code works once: a direct run's new session
starts without the owner's tabs. The new session id is bound to its new socket like any other. `status` adds
one line for the MCP server's own link: connected, not started yet, or ended (the next browser tool call
starts a new session); its other lines still come from a one-shot connection, so on its own they say nothing
about this link.

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
(shared or not), is left alone. A prompt names its site and its tab's title, or, for a page being opened (which has no tab yet), the address it would load; it can time out or be declined, and one session may
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
`packages/extension/entrypoints/sidepanel` (React: first-run setup, a new-thread screen, the thread view, and the
thread list and settings behind icons, coloured only from T3's theme roles); its sharing and prompt calls live in
`packages/extension/src/panel.ts`, and the policy is in `permissions.ts`, `sessions.ts` and `tabs.ts`. The extension's icon
is T3-Tab's own: `packages/extension/icon-source.svg`, rendered to `public/icons/`. T3 Code's mark appears only on the row
that names T3 Code.

The panel loads the markdown renderer and Settings when they are first needed. It asks the worker on a timer only as a
safety net: the worker's `panel.changed` message, `chrome.storage.onChanged` and tab events bring changes at once. The
timers are 5 seconds for prompts and sessions, 10 seconds for the helper (3 while it is missing or a screen shows setup
details), 15 seconds for the list of direct runs (1.5 while one runs) and one minute for the agent and T3 checks. An open
direct run is fetched every 400 ms only while it runs. A hidden panel slows every timer to at least 15 seconds, or 5 for a
missing helper.

The panel belongs to the tab it was opened on (`panel-tab.ts`). The worker turns the manifest's window-wide panel off, and
the toolbar button calls `chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html?tabId=<id>', enabled: true })` and
`open` for that tab, so other tabs show no panel until the owner opens one there. The tab chip is always that tab. Each
tab's panel keeps its draft, its project and the screen it was on in session storage, removed when the tab closes.
Opened on a tab a thread holds, the panel shows that thread. Opened on any other tab it shows a new thread, with the
threads working elsewhere listed above the composer, each saying whether it is working or needs the owner; a permission
card for another tab says so and has a Go to tab button.

The tab chip shows what the next message shares before it is sent: the tab, or the whole tab group when the owner made
that group. In a thread, a tab waiting for the next message is outlined and says so, and a tab already shared is filled.
The Threads screen starts with "Using the browser": every connected agent session, named by its T3 thread when it has one
and otherwise by its agent, with its shared tabs and a control for the current tab. That control is left out on a page
that cannot be shared. A green dot on the Threads button says at least one session is connected.

A thread shows why a turn failed, using T3's failure message or the direct run's error. Follow-ups queued in a T3 thread
are listed above the composer, where they can be removed; after a Stop, T3 holds them and the first has a Send now button.
A direct run cannot queue, so its composer says to wait and keeps Stop visible. Approval cards name what is asked (a
command, a file read, a file change or a permission) and show the command or path. In a question card, keys 1 to 9 choose
an option unless the owner is typing, and Enter in the answer box moves on or submits. Browser steps name the action and
site, and never the text typed into a field.

A new tab's thread starts in no project, which is T3's Scratch project (`projects.ensureScratch`), and Settings can change
that default to the last used project or a fixed one. Settings has two pages: General (default project when T3 is connected, Connections
folded away, appearance) and Sites. Sites lists this tab's site and the sites with a grant, since a site left on `ask`
is the same as one never seen, and the last requests Full access let through.

A permission prompt shows as a card in the side panel and, when the agent's client supports MCP form elicitation,
in the thread the agent runs in. The first answer counts and closes the other. An accepted question allows that one
request; site-wide grants are made only in the side panel. `claude -p` and `codex exec` cancel these questions, so a
direct run asks in the side panel only.

T3's Full access counts as yes for a browser request only while T3 itself confirms it (`t3-full-access.ts`), for any T3
thread, started from the panel or not. T3 sets `T3CODE_THREAD_ID` for the provider processes of a thread, and the MCP
servers they start inherit it. When an MCP server registers it sends its pid, and the daemon accepts its thread
(`agents/t3-thread-identity.ts`) only if that process holds the connection's socket, carries exactly one valid id, and its
parent chain reaches the T3 server recorded in `server-runtime.json` (not started after its record) without passing through
the daemon and without any process naming a different thread. A process with no id does not break the chain, because
Codex's shared app-server has none. So a command an agent starts with another thread's id is refused, since its own shell
names the real one, and a direct run from the panel never counts. Anything else, and every platform but Linux, means no
thread and normal prompts.

This widens what Full access reaches. A process in a T3 terminal also carries that thread's id, so an agent the owner
starts there counts as that thread. The check stops a mislabelled command, not a program running as the owner that rewrites
its own environment, which is outside T3-Tab's trust model as before. It names the thread only; the mode is still T3's
answer per request.

When a request needs a prompt, the extension asks the daemon, which runs `t3 thread show --json --messages 0 <threadId>` for
the session's proven thread and every thread its claims are bound to; that works with the side panel closed. If each of them
reports `full-access`, the request goes through with no card, writes no site setting and is listed in
`autoAllowed`. A session holding a direct run's grant never counts, and a claim not bound yet counts only alongside a proven
thread. A yes counts for two seconds on a monotonic clock from when its read started, and a request is allowed only at a moment when every
thread the session holds has such a yes; a thread that lapsed while another answered is read again. So after any of its
threads leaves Full access, a session's request can pass for at most two seconds, and a late answer never allows the request
waiting on it. A request waits at most five seconds for all of them to be live together, then prompts. Requests share one
read per thread until that read is five seconds old; after that the next request starts a fresh `t3` command, and an
abandoned read that answers later cannot overwrite a newer answer. The daemon ends a stuck command after 30 seconds, so a
hung T3 can hold about seven of them per thread while requests keep arriving. A pass from
Full access records no origin approval, so reads, screenshots and the title in `tabs` follow the live mode too, and the tab
shows `[needs approval]` again once the thread leaves it. An Allow once still records its approval for the tab. No proven
thread and no bound claim, a direct run's claim, another mode, a stopped T3 or no answer within five seconds all mean a normal prompt. Every
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
  on the socket. The same holds for the two other connections the browser opens to T3: an attachment upload and the
  voice socket (below). Disconnect drops the session and revokes it through `t3.unpair`. The `t3 thread` polling below remains in
  the daemon, but the panel no longer uses it.
- **The composer.** The bottom row is T3's: the paperclip at the left end, then the model, the mic and send, every
  control 32 px and the row 8 px from the box's edges. The access level (runtime mode) is in the model picker's footer, as
  in T3; a running T3 thread's model chip opens the same footer, and a change there is sent at once with
  `thread.runtime-mode.set`.
- **Attachments.** Paperclip, paste and drop add files. Files dragged anywhere over a screen with a composer (the
  new-thread screen and a thread) show T3's whole-workspace drop overlay and go to that composer; on any other screen a
  drop does nothing. For a T3 thread each file is uploaded the way T3's own composer
  does it: `attachments.createUploadUrl` over the socket signs a ten-minute upload address, the bytes are POSTed there
  (the address is the only credential), and the message carries the returned ids; a launch with uploads also sends the
  thread id T3 files them under. PNG, JPEG, GIF and WebP up to 10 MB go as images, anything else up to 50 MB as a file.
  A direct run takes PNG, JPEG, GIF and WebP only, up to 5 MB each and 6 MB a message (`lib/attachments.ts`, checked again
  in `agents/images.ts`). Any other file is shown as one that cannot go to that agent and holds the message until it is
  removed; nothing is dropped silently.
- **Dictation.** The mic records 16 kHz mono PCM in an audio worklet (`public/pcm-capture.js`) and streams it to T3's
  `/ws/voice`, where T3 transcribes it on this machine with the model chosen in its Settings → Voice, the same route T3's
  composer takes. The media ticket and `GET /api/voice/status` go through the daemon's `t3.session` like the RPC ticket.
  Without T3 connected, without T3's `voiceTranscription` capability or without a downloaded voice model, the button says
  so instead of recording. A side panel cannot show the browser's microphone prompt, so the first press opens
  `microphone.html` in a tab, where the browser asks once for the extension; after that the panel records without asking.
  Nothing uses the browser's Web Speech service.
- **Themes.** Settings shows the color scheme as one segmented row and the theme as one menu (every theme with its
  light and dark swatches, then Create theme and Add theme); edit, duplicate, export and remove for the current theme
  sit in a menu beside it. A fresh install uses T3 Code's built-in theme with the System scheme. The panel does not
  follow T3's theme, and a stored "follow T3 Code" choice from an earlier version, or a theme that is gone, falls back
  to that default (`known` in `lib/theme.ts`). T3 theme files can be imported. The owner's themes can be
  edited, and any theme can be duplicated with all its colours and both of its modes. A name already in use gets a number
  instead of replacing that theme. A change reaches panels open on other tabs through `chrome.storage.onChanged`. Custom
  CSS goes through T3's own filter, which removes rules that load remote files.
- **Adding the tools to the owner's agents.** Add in setup registers `t3-tab mcp` for the owner's own Claude Code and Codex
  sessions; threads started in the panel do not need it. The panel has no Remove button, so it never edits agent configuration
  itself. Connections shows the command that removes the entry: `claude mcp remove -s user t3-tab` or
  `codex mcp remove t3-tab` (or `t3-tab uninstall --claude` / `--codex`).

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
  no command that lists projects, providers or models, so on this route they are given as text.
- **Every request to T3 is checked.** The address comes from `<T3 home>/userdata/server-runtime.json` (only `origin`,
  `pid` and `startedAt`; its server must be alive, and the address a loopback `http` one). Every request opens its own
  connection and is sent on it only after `/proc/net/tcp{,6}` and `/proc/<pid>/fd` show that the recorded pid accepted
  that connection and that the process did not start after T3's `startedAt` (`t3-connection.ts`). That comparison has no
  tolerance: the start time read from `/proc` is rounded down by at most 1.01 s, so a process started less than that
  after the record can still pass, and a forward wall-clock step after T3 started can refuse T3 until it restarts. A
  backward wall-clock step makes processes look as if they started earlier, so a process that reused T3's recorded pid
  could pass the start-time check; it still has to hold the accepted connection, and programs running as the owner are
  outside T3-Tab's trust model anyway. Where there is no `/proc` (any platform but Linux), T3-Tab sends nothing.
- **The older T3 sign-in is gone.** T3-Tab used to sign in to T3's `/mcp` for its project and model lists and keep a
  read-only token in `t3-credential.json`. When the daemon starts it deletes that file and any temporary copy of it
  (`agents/stale-t3-credential.ts`). T3 offers a client no way to revoke itself, so such a grant stays listed in T3's
  Settings → Sharing & access until it expires, at most 30 days after it was made.
- **Finding `t3`.** `T3_TAB_T3` when set (and then only it), else `t3` on PATH or in the usual install
  folders, else the launchers listed in `<T3 home>/runtime/launchers`, else `<T3 home>/runtime/bin/t3`, else
  the desktop app's launcher `<T3 home>/bin/t3`, else the newest fully installed
  `<T3 home>/runtime/versions/<version>/t3`; the T3 home is `T3CODE_HOME` or `~/.t3`. Whether T3 is running
  comes from `t3 thread list --json --project /`: a running server answers that no project matches, a stopped
  one that it is not running. The panel shows "not found" or "not running" and then offers the direct runs.
- **Direct runs.** The message goes on stdin, the folder defaults to the home folder, and each turn is one
  process, continued with the session id the CLI printed. Images go with a turn as the CLI takes them: Claude Code gets
  `--input-format stream-json` and one user message line with the text and a base64 image block per image; Codex gets
  `--image=<file>` for each, written to a `0600` file in a private folder under the state folder and removed when the turn
  ends. The agent gets T3-Tab's tools and no others:
  - Claude Code: `claude -p [--input-format stream-json] --output-format stream-json --verbose --restricted --setting-sources ""
    --strict-mcp-config --mcp-config <T3-Tab only> --tools "" --allowedTools mcp__t3-tab --permission-mode
    dontAsk --disable-slash-commands [--model <m>] [--resume <session>]`. User, project and local settings and
    their hooks are not loaded, there are no built-in tools, and anything not allowed is denied without a
    prompt. The login is untouched. Organization-managed settings still apply, and a `CLAUDE.md` in the folder
    is still read as text.
  - Codex: `codex exec [resume] --json --skip-git-repo-check --ignore-user-config --ignore-rules --disable
    <feature>… -c approval_policy="never" -c sandbox_mode="read-only" -c web_search="disabled" -c
    mcp_servers.t3-tab.*=… [--image=<file>…] [-m <m>] [<session>] -`. `$CODEX_HOME/config.toml` is ignored while the login there
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
    the new session has no tabs until the owner shares one from the Threads screen.
  - The panel hides the claim line and replaces any code of the conversation in replies, titles and errors.
  - Each conversation's view lists the tabs it holds, each with a Remove button, and says which tabs the next
    message will share. Remove works between direct turns, when no session is connected: the tab leaves the
    conversation's later codes and any of its sessions still connected.

  The session that claims gets the tabs shared as the panel's "Share current tab" does: a tab still on the
  origin it showed at start is shared with that origin approved, and a tab that moved is shared unapproved.
  Every prompt, site setting and check above still applies, and the owner can unshare from the Threads screen or the
  conversation's view. A
  code the extension did not issue is refused.
- **Versions.** The extension, native host and daemon must speak the same `PROTOCOL_VERSION`. On a mismatch
  the link closes with a reason that says which side is behind (`mismatchReason` in the protocol package): when
  the helper is, the panel shows the setup command (running it updates the helper, no reload); when the extension is,
  it points to the browser's extensions page.

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
  and the change from the base branch's numbers. CI runs it and fails when a number is over its budget. For a change
  meant to make agents cheaper, also `pnpm bench:agent` (local, then `--sites real`).

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
