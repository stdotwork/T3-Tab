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
that the extension opened its welcome tab on install and that the tab's one button copies the command it shows and
opens the real side panel on that tab (read over the DevTools protocol, since Playwright does not list side panels):
the new-thread screen with the setup card and no setup screen or Start, where a task typed before the helper exists
waits with Send off; that the panel's helper state goes from missing to connected with no reload and the background
program started by the browser, and that the side panel's setup card then goes by itself with the typed task kept, and
Send turns on when the helper found Claude Code or Codex (with neither, the screen says no agent was found and Send
stays off); that Add for Claude Code writes an entry naming the installed launcher and that entry's `mcp` server
sees the browser, that running `setup` again over a daemon of another version stops it and the browser reconnects
to a new one, that `uninstall` removes the helper folder, manifest, state and agent entry and stops the daemon,
that `scripts/install-test-build.sh` (through a `file://` address) installs the same helper, and that a browser
started with its own `--user-data-dir` finds it once `setup` names that folder. Then `e2e/checks-real-use.mjs` runs in a headless Chromium only the extension debugs, because Playwright answers
dialogs itself and makes hidden tabs act focused: dialogs, background input, another extension's frame
(`e2e/fixtures/frame-injector`), `run_js` parsing, plain-text diffs, image refs, same-origin frames, and password inputs under other ARIA roles and text fields masked by `-webkit-text-security` staying redacted in `read`, `find`, a diff and an `act` reply, with the names built from them (a button, link, heading, label, `aria-labelledby` and a script's `ariaLabelledByElements`, open and closed shadow roots, 205 referrers), a 260-character value, show-password toggles by `autocomplete`, a short value that must not scrub other names, secrets in hidden, `aria-hidden`, `display:none`, `visibility:hidden` and closed-dialog content, fields under the roles link, checkbox and switch, a secret passed on through a label and a button, one echoed in the page's text, split over one element per character, upper-cased or taken from a hidden field no name was built from, a password a GET form puts in the address (the reply header and `tabs list` leave it out), and a page of 3,000 masked fields with 200 buttons named from them read in bounded time. `e2e/checks-agent-tools.mjs`, in such a browser too, checks that `tabs open` asks before anything loads and opens behind the owner's tab, that its reply carries the page (drawn by script too) and is the baseline of the next `read`, that `read` and `goto` with a url open a tab in an empty session behind the same prompt and take `find`, that `read` with the address of a tab the session has reads that tab without loading it again and opens a new tab for any other address, leaving the first where it was, that a load's reply leaves out a page too long for it (a page of long text without reading it) and a page a redirect took to an unapproved origin and names a dialog the page opened, that every tool works on that hidden tab, redirects, `find` past a display cut, link addresses, key spellings, `goto`, `back`, `forward` and a `reload` that never resends a form, the `depth` mark, and that an action leaves no global in the page. Then it launches headless Playwright Chromium with that built extension, starts the real native host and
two MCP clients, and checks the loopback link and the browser tools against a local test site (a form,
links and a section that appears on a click): `tabs`, `read` with its diff, `find` and ref subtrees, and
`screenshot`, `act` and `run_js`. It also checks session tab groups, socket-bound session ids, tab sharing,
read and action prompts, cross-origin navigation and `window.open`, restricted pages, password redaction
and a regex timeout. It also checks the review fixes: a read-only site grant that act, run_js and open
still prompt past, a `run_js` escape expression, a screenshot and a key press that land on a page that
changed, popups opened by the owner and by a session tab, member tabs shown only by origin until approved,
a cross-origin iframe left out of `read`, and prompt buttons locked when rows shift. Three act prompts are answered
from the panel's own card: Enter allows once and Escape declines (each after the same key typed in the composer
answered nothing), and the More menu's "Always allow everything on this site" sets the site to `allow`. Other tool
checks run with the site still set to ask and the harness answering prompts with Allow once. The action run fills and submits the
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
out, ends each row in its provider's logo (none when T3 lists no such provider) and names no machine, and the threads button carries a dot only while a thread waits on the owner's answer or approval. The composer
keeps the paperclip, model, mic and send in that order at 320, 360 and 400 px with no access row under it; without T3 there is no mic and the model chip names the agent, never "Default"; a PDF for a direct run is named and holds the message; a pasted image is attached; a PNG
dragged over the heading shows the whole-panel drop overlay, is attached when dropped there and
reaches the fake Claude Code as an image block, while a file dropped on Settings is refused; Settings has a 28 px
color scheme row, T3 Code's built-in theme with T3's shared theme ignored, and a theme menu with swatches, Create
theme and Add theme, and each theme's actions beside it; and with T3's config handed to the panel, the access level is chosen in
the model picker. The layout check (`e2e/checks-layout.mjs`, measuring with `e2e/ink.mjs`) walks the new-thread
screen (direct, with no mic, and T3, with the mic, with and without a project), the model and project pickers, the thread list, a thread, a T3
thread waiting on an approval (at its work-log row and above the composer), a running thread (its composer's Stop at the size of the icons beside it), three browser prompts on the new-thread
screen (one a `goto` on another tab), the new-thread screen's setup card (helper missing) and Connect row (T3 Code
running, not connected) drawn on the headless panel, Settings and a theme sheet at 320, 360 and 400 px in light and dark (and the sheet opened from each scheme, which must open on that scheme's tab with every panel role unchanged and its fields painted with the panel's surface and border), and measures visible ink (SVG strokes and fills, text glyphs
on their baseline, painted boxes), never padding boxes. It fails when a bar's or the composer row's first and last
controls sit at ink distances from its edges more than 1 px apart, when the composer's send circle is not as far from
the frame's foot as from its side, when the composer's controls are not one size or their ink (and the model chip's
logo and words) is off one centre line, when its text does not start on the paperclip's ink, when the hero's project
line is off the heading's ink centre, when one bar's icons, or the composer row's glyphs, are drawn at different
sizes or stroke weights, when an approval card's ink is over 160 px tall or its three answers are not on one row of
one-line 28 px buttons inside it, when the setup card or the Connect row is not in the composer's column between the
heading and the composer, cuts off any of its content, or is over 260 px tall (the Connect row: over 42 px or more than
one line), or when browser prompts on the new-thread screen move its heading or composer or cover the composer. Every screen it walks must draw the one top bar (`Bar` in `Frame.tsx`, marked `data-bar`), and at
each width and scheme the bars of all those screens must agree within 1 px (0.25 px for strokes): height, first and last
ink insets, icon size and stroke, the thread toggle's ink, and the breadcrumb's start and baseline.
`e2e/checks-approval-keys.mjs` then, on the headless panel with the panel's answers recorded,
checks that a T3 approval under a browser prompt is locked when the prompt goes (a second click and an Enter at once
answer nothing) and takes no keys at all, only a click; that an Enter held through the change of card answers nothing
until released; that Enter answers nothing while a popover is open; that showing the panel again locks its cards; that a
card scrolled out of the prompt list takes no key; that a T3 approval without `accept` or `decline` draws only More;
that one T3 cannot take an answer for (not `live`) has its answers disabled and says why; that Escape on another control
does nothing; that T3's warning shows on its answer; and that a `goto` card names its address, its tab and that it is
another tab. It renders the panel from that state and, when
`T3_TAB_E2E_SCREENSHOT` names a file, saves a screenshot there. It prints each reply and its size. Every
process it starts uses a temporary HOME and XDG directories without the caller's `T3CODE_*` and `T3_TAB_*`
variables, `t3` is pinned to the fake through `T3_TAB_T3`, and every browser is headless, with a short temporary folder of its own, because Chromium aborts when its socket path gets too long. Last of all it stops the daemon (`e2e/checks-reconnect.mjs`) and checks that an MCP client that was already running gets a new session on its next call, is told once that the earlier one ended, and that `status` reports each state of its link.

`e2e/panel-flow.mjs` (not part of `pnpm e2e`, because it needs a real agent login) walks the panel from first open to
finished threads against a real throwaway T3 and again with T3 absent, and saves each screen at 400 px in light and
dark to the folder named by `T3_TAB_FLOW_SHOTS`.

`pnpm captures` (after `pnpm build`, with `T3_TAB_CAPTURES_DIR` naming an output folder; not part of `pnpm e2e`) renders every panel view at 400 x 800 in light and dark from one fixed shopping scenario with the e2e fakes and the product's `npx t3-tab@latest setup` command, and writes it three ways: `panel/` as drawn, `framed/` on one browser-window frame with the product's and T3 Code's names masked (for blind rating beside other products), `framed-named/` on the same frame unmasked, and the welcome tab as a 1280 x 800 browser tab in `welcome/` (`e2e/captures.mjs`).

`pnpm bench` (after `pnpm build`) measures what an agent is sent, in characters and estimated tokens: the
`tools/list` payload (total and per tool) and each tool reply on four fixed tasks over three local pages
(`bench/pages.mjs`): fill and submit a form, open a hidden section, follow a link, and search a longer page
with `read` given its address and `find`, then with `find`, a ref subtree, `all` and a screenshot (text part, JPEG bytes and size, estimated image tokens).
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

Users add the extension from the browser's store and run one command from any folder: `npx t3-tab@latest setup`.
On a fresh install (`runtime.onInstalled` with reason `install`) the extension opens a tab of its own, `welcome.html`,
whose one button, "Copy the command and open T3-Tab", copies the command and opens the side panel on that tab, so the
owner does not have to find the toolbar icon, which the browser keeps under the puzzle piece until it is pinned. The
browser opens a side panel only from a user gesture: called from the service worker with none, `sidePanel.open` fails
with "may only be called in response to a user gesture", so `onInstalled` cannot open the panel itself; from a click on
the extension's own page it opens, also after an `await` of 200 ms (checked in headless Chromium; a `--load-extension`
browser counts every launch as an install, so every test browser gets the tab). The panel opens on
the new-thread screen; while the helper is not connected, one setup card above the composer says why, shows the command
with a copy button and the live state, and the composer stays usable: a task typed meanwhile is kept, Send waits, and the
card goes by itself once the helper connects (`SetupCard` in `Setup.tsx`; there is no setup screen and no Start). The
command is held in `packages/extension/src/helper-command.ts`, with the test command the prototype build shows until the
package is published, behind one constant, `HELPER_CHANNEL`. It needs Node.js
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
- `uninstall` (also from the installed `t3-tab`) first removes every registration in `install.json` and the usual places and
  the native host launcher, so the browser can no longer start the helper, then stops the daemon, removes agent entries, the
  helper folder, stops a daemon that started in between, and removes the state folder; a manifest that is not T3-Tab's is
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
hit is shown in the setup card and in the helper row of Settings → Connections (`helperNote` in `Setup.tsx`, from
`HelperState` in `daemon-link.ts`): a native
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
each) and drops the line-wrap boxes the reader never prints; the reader prints a line of text up to 1,000 and a name up to 160, and `find` searches all of it
and prints a window around the match. A run of text longer than a line is split into lines of up to 1,000 between its pieces
(text nodes, links, text-level elements); only one piece longer than a line is cut. `find` prints a matching line up to
320 characters whole (a longer one around its match) and a context line up to 120 (a longer one keeps its start). Every cut ends in `…`. A link shows its address (`→ /path`, relative on its own
site) when another link of the same name goes elsewhere, when it has no name, when it is the element a `ref` read asks
for, and in `find`. With `depth`, an element with more inside ends in `…`.

`tabs` also moves a tab: `goto` with a `url`, `back`, `forward` and `reload`. `goto` asks like `open` does. `back`,
`forward` and `reload` revisit a page the tab has shown, so they ask only for an origin the session holds no approval
for on that tab. The browser's reload resends a form's POST without asking, so unless the debugger saw the document come
from a GET, `reload` fetches the address with a new GET (`location.replace`, which keeps the history).

A load (`open`, `goto`, `back`, `forward`, `reload`) replies with the page as `read` would show it, header first (`Opened
tab <id> [current]: <title> — <url>`, with `Redirected from <origin>.` under it when a redirect landed on an origin the
session may read), and that reply is the tab's diff baseline for the MCP server process, as a `read` is; with `find` it
replies with the matching lines instead. A page whose view is over `LOAD_REPLY_MAX` (4,000 characters, `page.ts`) is left
out of a load's reply, which says how long it is and sets no baseline: agents send a `read` (or a `find`) in the same turn
as the load, before they see its reply, and that read then gets the page once. So a load without `find` first asks the
page how much text it shows (`innerText`, `pageTextLength` in `settle.ts`), and a page with more than `LOAD_REPLY_MAX`
characters of it is not read for the load at all (`skipReadOver` and `textLength` in the protocol); the reply says how
much text it has. A `read` with `full` right after a load
reply that showed the whole page (within 5 seconds, `LOAD_REPEAT_MS`), with nothing changed, says so instead of sending it
again (once; the next one is whole). The extension reads the page in the same request (`describeLanding` in
`requests.ts`) as soon as the new document has loaded and drawn its first frames, without waiting for it to go quiet. If
the page moved while it was read (its content, layout or document per `settleSnapshot`, not only its network traffic) and
that read ended within `LOAD_REREAD_MS` (100 ms), it is read once more after the first read ended, and that read is the
answer; a page that never stops moving costs at most that and one more read. A move within the same document (a fragment)
or a dialog that opened on load is read once. It reads only where a `read` would pass without a prompt: the origin the
load was approved for, or one the session already holds on that tab or the owner lets it read. A load that went through
on T3's Full access carries the page only if T3 still confirms the mode once the page was read; otherwise the reply says
to read the tab. A redirect to any other origin replies as before, with the origin only and how to ask; a page that could
not be read (a dialog opened on load, say) replies with the tab and the reason.

`read` with a `url` never moves or reloads a tab. A tab of the session already at that address (the fragment aside; only
the tab it names, when it names one), whose page the session may read without a prompt, is read as any `read` reads it
(a diff when there is a baseline) and becomes the current tab. Otherwise the address opens in a new tab behind the
owner's, asking as `open` does, and the reply is that load's (`tabs.open` with `reuse` in the protocol). A tab the
session may not read yet does not count, so which prompt comes up says nothing about where that tab is. A `ref` does not
go with a `url`. Moving a tab is left to `tabs goto`. A `goto` that names no tab, in a session with no tab, opens one
(`opened` in the result), asking as `open` does, so `read {url}` and `tabs goto` work from an empty session; every other
tool says in one line how to get a tab (`NO_TAB_MESSAGE` in the protocol package).

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

The default view shows the page's text as well as its elements and headings (`format.ts`): paragraphs, list items, and
a table row of text cells as one line with its cells apart by `|`. A link inside running text (its parent holds text of
its own) is written into that line as `[name](e12)`, with the ref its own line would carry (and its address, `[name](e12 →
/path)`, only where its name is ambiguous, in `find` too), when the line is prose: it does not start with a link, and the letters and digits outside its links are at least as many
as those in its links. Otherwise (a story line on a news site, a menu with `|` between its links, a product's link and
the line about it) the links print on lines of their own as before, between the text around them. Text lines and headings
escape `[`, `]` and `\` with a backslash (a link's name inside its mark too), so a page that writes `[Cancel](e3)` or names
a link `Continue](e3)` cannot pass for a mark; a printed text line is a JSON string, so the escape shows doubled
(`\\[Cancel\\](e3)`), and `LINK_MARK` in `format.ts` finds the real marks. In `find`, a matching line also carries
the address of every link written into it, so a search for an address finds a link in text; the lines beside it do not. The text of a block is run together while it fits on
one 1,000-character line: with no space added where it flows as one line (the parent holds text of its own, or both
pieces are text-level elements such as `<em>` or `<sub>`), because Chromium keeps the real spaces of inline text in the
text (`$<span>1,284</span>.50` is `"$1,284.50"`); with a space between boxes side by side, such as flex items or block
`<div>`s, which Chromium gives no space between (`"Price $5"`); a line break is a space. Each node's text is built once
and never past a line, so a page of many small text nodes (highlighted code) reads in time proportional to its size.
Separators with no letter or digit (`|`, `(`) and icon-font glyphs are left out, and so is text inside a field that only
repeats the field's value (an editable combobox's text). A live region (`alert`, `status`, `log` or `aria-live`) and a
dialog always print; an `alert` or `status` that says one short thing is one line with no ref, `alert "Incorrect
username or password."`, and an empty one prints nothing. Text is held to `TEXT_BUDGET` (4,000 characters, `page.ts`)
and gets only the room the 12,000-character cap leaves after every element and heading, so text never pushes an element
past the cut. Within it, the text of live regions and dialogs comes first (a `log` from its newest entry back, others from
their start), then the page's `main` or `article`, then the rest. What is left out is said in one last line, `(N text
lines left out, M characters, K links in them: find searches them, read a ref for one part, all for the whole page)`
(the links part only when there are some), which stays even when the reply is cut; the whole reply, notes included, stays within the cap. A `ref` read and `all` have no text budget,
only the cap. The diff baseline holds every line, text left out included; a diff's text lines are held to the same
budget and to the room its other lines leave, live-region and dialog lines (judged on both sides of the diff) first, with
the same kind of note. With `all`, images are also listed with a ref, named or not, so they can be hovered or clicked.

Long lists of links or buttons give way to the page's text (`renderView` and `collapseGroups` in `format.ts`). A group is
the outermost node below the page whose lines hold at least 8 links, buttons, menu items, tabs, options, tree items or
disclosure triangles, no heading, field, live region or dialog, and no more characters of text than of elements: a
sidebar, a menu bar, a footer, a table of files, a browser-compatibility table. When the default view's elements and
`TEXT_BUDGET` characters of its text (or all of it, if less) would not fit under the cap with the notes' room, groups fold
to one line each until they do: first those around the content (in a `navigation`, `banner`, `contentinfo` or
`complementary` landmark, or outside `main` and `article` on a page that has one), then the rest, largest first. A group
in the content folds only when at least 1,000 characters of text lie outside it, so a page that is mostly its links (a
news site's stories, search results) keeps them, and a cut at the cap still shows the first. The folded line is the
group's own line, or a ref for its node, then the count and the first names: `e14 navigation "Docs sidebar" (66 links, 5
buttons; read e14): "Getting Started", "Installation", …`, and the last name too when it moves on (`Next`, `More`, `Older`,
`»`). The text a folded list held counts in the note on what was left out. Reading that ref lists them with the refs they already had, and
`find` searches them. Only the default view of a whole page folds; a `ref` read, `depth`, `all`, `find` and diffs do not,
and the diff baseline holds every line.
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
renders from script. A load holds the tab visible from before it starts until the page settles (at most 4 seconds), which goes on after its reply. The page sees itself as visible and focused for that long.
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
expression of at most 200 characters; it runs in a worker that is terminated after 500 ms.

**Redacted fields** (`packages/extension/src/password.ts`, called from `readPage` on the raw tree, before `slimAxNodes` trims
it). Every node that holds a value, and every field the reader prints a value for (textbox, searchbox, combobox, spinbutton,
slider), is checked, whatever its ARIA role: one `DOM.resolveNode` each into T3-Tab's own isolated world, so a page cannot change
what `type`, `autocomplete` or `getComputedStyle` answer, then one `Runtime.callFunctionOn` per batch of 25, which also reads
the value the field really holds. The value is removed and the line renders as `value=<redacted>`, with no length, when the field is:
- a password input (the check is the element's `type`, not its role);
- masked by `-webkit-text-security` (a PIN or card number in `type=text`, set on the field or inherited);
- or marked by its `autocomplete` as a secret: `current-password`, `new-password`, `one-time-code`, `cc-number` or `cc-csc`
  (any token of the attribute). This also catches a password field a show-password toggle turned into `type=text`, and costs
  the agent the value of such a field when it is plain text on purpose (decided: safety over convenience). **A show-password
  toggle on a password field that has no `autocomplete` attribute is not covered**: once it is `type=text` nothing marks it.

A run of password bullets as a value is redacted under any role without asking (a `button`, for one), and a redacted node loses
its children, because the bullets the browser draws for a password are a text child that would show the length. A field that
cannot be checked (the browser could not resolve it, or the batch failed) is redacted too, and its value is looked for like a
secret's; a dialog that opens during the read stops the read instead. When the private world was destroyed by a navigation, it
is made again and the batch asked once more. `slimAxNodes` keeps a node's value only for the roles the reader prints one for, so
no other role's value leaves the extension. A standalone script making the calls of the first version of this check in
headless Chromium (median of 5 alternating runs, Chromium 159, Node 26.12) took 12 ms instead of 9 ms for 30 fields, 80 ms
instead of 58 ms for 260, and 0.76 s instead of 0.57 s for 3,000, against the old `DOM.describeNode` per field, next to 0.5 s,
0.9 s and 4.6 s to fetch the accessibility trees of those pages (the shipped code was not timed on its own). `find`, diffs and
the `act` reply are built from the same lines, so they show nothing a read does not.

**Names and text that took a hidden value in.** The browser puts a field's value into other elements' names, and a page can echo
it in its text, so each secret is followed wherever it can have gone, with the value taken whole from the raw tree before any
cut. The analysis (`redactPasswordValues`) does each step once for the whole page, so what it costs follows the size of the tree
and of the values, not their product:
- *Which values.* The fields the checks above found, the values of the hidden fields inside what names were built from, and the
  page's own list: before the tree is read, one `Runtime.evaluate` in T3-Tab's world (`COLLECT_SECRETS` in `page.ts`) lists the
  value of every input and textarea that is a password input, marked by `autocomplete` or masked, in the document, open shadow
  roots and same-origin frames, **hidden fields included whether or not a name was built from them** (up to 3,000 values, at
  most 5,000 fields asked about their style, 200,000 elements). A failed call leaves that list empty and the read goes on.
  The values seen in a tab are also remembered for it (`rememberSecrets` in `secret-text.ts`, memory of the extension's worker:
  400 values a tab, 30 minutes, dropped when the tab closes or the worker restarts), so a later read of the same tab, whose
  form is gone, still hides them.
- *Where a name came from.* Each source of a name that the browser did not set aside carries the nodes it was built from
  (`relatedNodes` with `backendDOMNodeId`, under `attributeValue` for `aria-labelledby` and a script's `ariaLabelledByElements`
  and under `nativeSourceValue` for `<label for>`). A name built from a hidden field, or from a node that is an ancestor of one
  in the tree (a `LabelText`, a shadow host, an ignored wrapper), is cleaned of the values, and becomes `<redacted>` whole when
  none is found in it or a node it was built from is not in the tree. A field's own label around it is not part of its name;
  a field that names itself is. A name built from content (a button, link, heading, cell or tab around the field, a
  `fieldset`'s legend) is treated the same way, for every ancestor of the field that holds it.
- *Hidden content.* The tree marks hidden, `aria-hidden`, `display:none`, `visibility:hidden` and closed-dialog content as
  ignored and gives its nodes no role or value, yet a name built from it still holds what is in it. So the ignored nodes inside
  any element some name was built from (up to 1,000 a read, in one walk of the tree) are checked as well. If there are more, or
  the check fails, the names built from them are hidden whole, when the page holds a secret or the check failed.
- *It travels.* A name that took a secret in passes it on the same two ways, to the names above it built from content and to the
  names whose sources list it or an element around it. Each node is expanded once (not once per value), so a form of thousands of
  fields named by hundreds of buttons costs one pass. A name that had to be hidden whole, because no value could be found in it,
  is passed on as unknown: the names above it that are built from content are hidden whole.
- *The net.* Every value of four characters or more, including the value the field really holds and not only the bullets the
  tree shows, is replaced in every name, value, link address and line of text on the page, tied to a field or not, so a path not
  modelled cannot print a secret the extension knows. The matcher (`matcher` in `secret-text.ts`) is an Aho-Corasick automaton:
  one pass over a text whatever the number of values or how alike they start, case-insensitive (a page that upper-cases its text
  is caught), overlapping matches joined into one marker, never inside a marker; a value over 256 characters is found by its
  first 256 and then hidden as far as the text follows it. **Text is matched as a stream**: the lines of text of the page in
  document order are joined with nothing between, as the reader joins sibling text, so a value a page wrote one element per
  character, or with its first letters in a `<b>`, is found, and every line it covers loses its part (the first keeps the
  marker, the rest go empty). This also joins text across blocks, so two separate lines that together spell a value are hidden
  too (a rare false positive, on purpose). A link address is also matched in the forms an address holds a value:
  as it is, `encodeURIComponent`, `encodeURI` and with `+` for a space. A value of fewer than four characters is replaced only
  as a whole word and never in plain text, only in names tied to a hidden field (the names that took a value in, and those
  around the field that holds it; in a tied name every short value of the page is looked for, not only its own field's).
- *Title and address.* The tab's title and address come from the browser, not the tree, and a form that sends a password in
  its address (a GET login) puts it in both, in the header of every later reply and in `tabs list`. `scrubReported` takes the
  tab's remembered values out of the title and address (in their address forms) in `readPage`, `tabInfo` (`tabs list`,
  `open`, `switch`) and the dialog branch of `act`. Before a `click` or a `press` step, `act` collects the page's secret values
  again (`rememberPageSecrets`), so a form the owner filled after the last read and that a click sends is covered.
- *The budget.* The steps after the checks run under a time budget of 1.5 s (`budgetMs`). Past it, the analysis stops and
  every name, value, link address and line of text that holds a value the extension knows (or a run of two or more password
  bullets) is hidden whole, and past a second budget every name built from content or from other nodes is hidden whole. The
  fallback never reads a text more than once.
Measured: a stub inspector and synthetic trees in the unit tests (Node 26.12, vitest, one run each, tree building included):
3,000 masked fields in a form with 200 buttons named from it, 0.59 s; groups 500 deep with 20 fields each, 0.15 s; 30 deep with
300 each, 0.10 s. The version before took 29 to 31 s on shapes like those (as a review measured them, with its own stub). In headless Chromium (`e2e/checks-real-use.mjs`, one
run, wall time of the `read` call) the real 3,000-field, 200-button page read in 3.4 s, 12,083 characters, and `tabs list`
answered straight after; the version before did not answer within 25 s.
Not covered: a show-password toggle on a field with no `autocomplete` attribute (above); `aria-describedby` (a description is not
part of the tree the reader gets, so it never leaves the extension); a name or text that holds the value in another form than
the field showed it (the match is the value with its whitespace collapsed, in any case, with the encoded forms in addresses
only); a secret that is in none of the ways above a field's value, such as one a script types into plain text or builds from
other values; a field masked another way (a text input drawn as dots by a script or a font), and the bullets a masked field
outside the value roles draws as text (its length); a secret field inside a closed shadow root that no name was built from
(the page's list cannot reach it; the checks above reach it only through the tree) and fields past the caps above; secrets of
a tab after the extension's worker restarted or 30 minutes passed (the memory is gone; the tab's address from before then
shows as the browser reports it); `run_js`, which is the agent's own code; and a screenshot, which shows what the page draws.

## Sessions and permissions

T3-Tab protects the browser from websites and from other users or machines. It does not protect it from programs
running as the owner, which can already read the owner's home folder, browser profile and T3's own data.

The daemon issues each session id and binds it to the control connection that registered it; tool requests
on another socket, or with another id, are refused. Tabs a session opens go into its own Chromium tab
group. It can list and use only tabs in that group or tabs the owner shares from the side panel.

`tabs open` asks first, for the requested address: nothing is created, fetched or run until the owner says yes. Then
the page loads in a new tab behind the one the owner is on, with the debugger attached on `about:blank` first. If a
redirect takes it to another origin, the tab stays in the session's group unapproved, and the reply names the origin and
says to read it to ask for access; an origin that is already allowed just carries on. `read` with a url that no readable
tab of the session shows, and `tabs goto` with a url in a session that has no tab, ask the same `open` prompt, with no
tab named, before anything is created.

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
for 500 ms when it appears, again whenever a row is removed or inserted above another, whenever it becomes the card
Enter and Escape answer, and when the panel is shown again after it was hidden. A thread's T3 approval is in the same
lock list as the browser prompts (after them), so a prompt answered above it locks it too.

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
`packages/extension/entrypoints/sidepanel` (React: a new-thread screen, which carries the setup card until the helper
connects, the thread view, and the
thread list and settings behind icons, coloured only from T3's theme roles);
every screen has the same top bar in T3's anatomy (`Bar` in `Frame.tsx`): T3's sidebar toggle, which opens and closes
the thread list, then a breadcrumb, then the screen's icons (New thread and Settings), or, on Settings and its sheets,
the breadcrumb (`Settings / General`) and Close, as T3's settings have. T3 Code's built-in theme is painted as T3's app
paints it, not as its palette file lists it: in dark a black canvas with the thread list on the card surface, so the list
sits lighter than the canvas in dark and darker in light (`T3_CODE_PAINTED_DARK` in `lib/theme.ts`); its sharing and prompt calls live in
`packages/extension/src/panel.ts`, and the policy is in `permissions.ts`, `sessions.ts` and `tabs.ts`. The extension's icon
is T3-Tab's own: `packages/extension/icon-source.svg`, rendered to `public/icons/`. T3 Code's mark appears only on the row
that names T3 Code.

The panel bundles Inter Variable's Latin and Latin-ext faces only (`entrypoints/sidepanel/inter.css`); text in another script
is drawn by the system's fonts through the `--font-sans` fallbacks. The panel loads the markdown renderer and Settings when they are first needed. It asks the worker on a timer only as a
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
The Threads screen is T3's sidebar: the search row, then the threads, each row ending in its provider's logo. Under it, where
T3's sidebar keeps its own status, "Using the browser" lists every connected agent session in one slim row, named by its T3
thread when it has one and otherwise by its agent, with how many tabs it holds and a toggle that shares the current tab
with it. The toggle is left out on a page that cannot be shared. A green dot on the Threads button says at least one
session is connected.

A thread shows why a turn failed, using T3's failure message or the direct run's error. Follow-ups queued in a T3 thread
are listed above the composer, where they can be removed; after a Stop, T3 holds them and the first has a Send now button.
A direct run cannot queue, so its composer says to wait and keeps Stop visible.

Browser prompts and a T3 thread's approvals share one card (`Approval.tsx`, built from `approval-model.ts`) in T3 Code's
anatomy: a line saying what is asked (who asks, the action and the site, or the command or path T3 asks about), then
the address a prompt would load or T3's reason, then the tab it is about by its title (`in "<title>"` under an
address, as for `goto`, `back`, `forward` and `reload`), then Decline, the primary answer (the once answer or Approve)
and More, in T3's order on one row. More holds the other answers with what each grants: for a browser prompt the
lasting choice and Manage sites, for T3 its own (such as Always allow this session and Cancel), with T3's warning on an
answer shown as T3 shows it. A T3 approval draws only the answers T3 offers: with no `accept` there is no primary
answer, with no `decline` no Decline; with no options at all it offers T3's own defaults. Unless T3 reports the request's
`responseCapability` as `live`, its answers are disabled and the card says, in T3's words, that the provider process is
gone. A card about another tab says so and has a Go to tab button.

The cards of a screen share one `ApprovalStack`: their locks are one list. Only browser prompts take keys: a T3 approval
is answered by click, as in T3's own client. Enter (the primary answer) and Escape (Decline) answer only the keyed
card, the first browser prompt that is at least 98% on screen (an `IntersectionObserver`, so a card scrolled out of the
prompt list is never answered). A key answers only a press that began after that card became keyed: an Enter or Escape
still held from before the change answers nothing until it is released. Keys never act while a popover, menu or dialog
is open, from a text field (the composer included), during composition, with a modifier, held down, or while the card
is locked; Enter on a button is that button's own, and Escape declines only from the panel's body or from inside the
card. The keyed card shows the two keys, hidden below 360 px. A T3 approval is drawn at its row in the running work log, as T3 does, and above the composer when that
row is not among the last eight steps shown; browser prompts sit above the composer, and on the new-thread screen they
float over the hero's lower part so nothing moves. In a question card, keys 1 to 9 choose
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

- **The panel's T3 session.** While T3 runs on this machine and the panel holds no session, the new-thread screen shows
  one row, "T3 Code is running", with Connect (Settings → Connections has the same button). Every Connect goes through
  `connectT3` in `lib/t3-connect.ts`; `CONNECT_T3_BY_ITSELF` there, off until the owner decides it, would make the panel
  connect once per panel page with no click. Connect signs a DPoP proof and calls the daemon's `t3.pair`. The daemon checks that the
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
- **The composer.** The bottom row is T3's: the paperclip at the left end, then the model, the mic and send (Stop in its
  place while a turn runs, drawn at the same 16 px as the other icons), every control 32 px and the row 8 px from the
  box's edges. A direct run whose model is the agent's own default names the agent on the chip ("Claude Code"), not
  "Default", since T3-Tab never learns which model that is. A running turn's header reads "Working…" until its first full
  second, then "Working for 7s" in whole seconds, as T3's timer counts; it never shows "0.0s". The access level (runtime mode) is in the model picker's footer, as
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
  As in T3's composer, the mic is not drawn where it cannot work: T3 not connected, no `voiceTranscription` capability, a
  voice status that says unsupported (asked once when T3 connects, so a refused one never appears), or a page that cannot
  record. A downloaded voice model that is missing keeps the button, as T3 opens its setup there: pressing it says where
  to download one. A blocked microphone keeps it too, and says how to allow it. A side panel cannot show the browser's microphone prompt, so the first press opens
  `microphone.html` in a tab, where the browser asks once for the extension; after that the panel records without asking.
  Nothing uses the browser's Web Speech service.
- **Themes.** Settings shows the color scheme as one segmented row and the theme as one menu (every theme with its
  light and dark swatches, then Create theme and Add theme); edit, duplicate, export and remove for the current theme
  sit in a menu beside it. A fresh install uses T3 Code's built-in theme with the System scheme. The panel does not
  follow T3's theme, and a stored "follow T3 Code" choice from an earlier version, or a theme that is gone, falls back
  to that default (`known` in `lib/theme.ts`). The theme sheet (Create, Duplicate and Edit) opens on the scheme the panel is
  drawn in and in the panel's own palette: a new theme starts as a copy of the theme in use for that scheme (`currentPalette`
  in `lib/theme.ts`), so the sheet looks the same a moment after it opens as before, and picking a new Canvas or Accent is
  what makes the other colours from the two seeds. While it is open the whole panel previews the draft, as T3's editor does:
  its Light and Dark tabs preview those schemes, and closing it brings the saved theme back. T3 theme files can be imported. The owner's themes can be
  edited, and any theme can be duplicated with all its colours and both of its modes. A name already in use gets a number
  instead of replacing that theme. A change reaches panels open on other tabs through `chrome.storage.onChanged`. Custom
  CSS goes through T3's own filter, which removes rules that load remote files.
- **Adding the tools to the owner's agents.** Add in Settings → Connections registers `t3-tab mcp` for the owner's own Claude Code and Codex
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
