# Design decisions (v1)

This document records the lasting design decisions, tradeoffs and scope boundaries for T3-Tab v1.
For current behaviour, module paths and commands, see [AGENTS.md](../AGENTS.md).

## What T3-Tab is and is not

- **No built-in agent loop.** T3-Tab exposes the user's own signed-in Chromium browser as Model
  Context Protocol (MCP) tools and adds a side panel that starts and continues real coding-agent
  sessions. T3-Tab never runs a model itself: the agent the user picks does the reasoning, with the
  browser tools injected, and delegation stays in T3 Code (an app that manages coding-agent
  threads). Building a custom agent loop or embedding T3 Code's web UI inside the side panel was
  rejected so T3-Tab stays small and works with every provider T3 Code supports.
- **Reach T3 Code threads via user-level MCP config.** The panel's Add buttons (and `t3-tab setup
  --agents`, or `t3-tab install` from a checkout) register `t3-tab mcp` in Claude Code
  (`~/.claude.json`) and Codex (`~/.codex/config.toml`), preferring `claude mcp add` and `codex mcp add`
  and falling back to non-destructive file edits. From the installed helper the entry runs the helper's
  launcher, so it names no checkout and no Node path. T3 Code threads load those user-level configs, so the same setup
  serves both T3 threads and standalone CLI sessions without changing T3 Code.
- **Four-package TypeScript workspace.** `packages/extension` holds the browser service worker and
  side panel; `packages/server` is one Node.js CLI providing the background daemon, Chrome native
  host and stdio MCP server; `packages/helper` bundles that CLI into the one file users install;
  `packages/protocol` holds the versioned message types shared between them. Keeping page reading, ref tracking, diffs and agent process management in Node keeps the
  extension small and easy to unit-test.

## Browser target and reference boundaries

- **Chromium first, Firefox later.** v1 targets Chromium-based browsers (Chromium, Chrome, Brave,
  Edge and Vivaldi). The extension is built with WXT (a WebExtension build framework) so Firefox support can
  be added later without rewriting the extension.
- **Behavioural reference only for proprietary tools.** The permission model—per-site prompts,
  confirmation for risky actions, session tab groups and explicit tab sharing—follows Claude in
  Chrome's behaviour. Proprietary products (Claude in Chrome and the Codex Chrome plugin) are
  studied for behaviour and tool design only; their code is never copied. Code adapted from openly
  licensed projects keeps its licence and copyright notices and is listed in
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). T3-Tab is licensed under Apache-2.0.

## MCP tools and token budget

- **One core tool set for every model.** Every MCP client receives the same five tools: `tabs`,
  `read`, `screenshot`, `act` and `run_js`. MCP identifies the client rather than the model,
  so per-model tool profiles were rejected. Rarer actions are left to optional future tool packs to
  keep prompt overhead small. A `status` tool (connected browsers and their tab counts) was dropped:
  agents almost never called it, its tab count covered the owner's unshared tabs too, and what an
  agent needs from it comes back in tool replies anyway (no browser connected, and why, in the
  error; a restarted session in the first reply after it).
- **The listed schemas are lean; the checks are not.** Claude Code sends every tool definition on
  every model request, so `tools/list` leaves out what the server checks on each call anyway (the
  JSON Schema dialect, lengths, ranges, item counts, the refusal of unknown step fields) and two
  `read` parameters no agent was seen to use (`regex`, `depth`), which calls may still pass. Every
  call is still checked against the full shape, in the MCP server and again in the daemon.
- **Accessibility-tree reading with short refs.** `read` fetches the Chrome DevTools Protocol (CDP)
  accessibility tree (`Accessibility.getFullAXTree`) instead of raw HTML or DOM dumps. By default
  it returns interactive elements with short refs (`e1`, `e2`, ...) held in the daemon and
  invalidated when the tab's document is replaced, headings, and the page's text. Text is held to a
  budget (4,000 characters, and never more than the cap leaves after the elements), the text of live
  regions and dialogs first, and a reply says what it left out and how to get it, so an agent sees an
  error message, a list or a table row without a second read or a screenshot. Links in running prose are written into
  its line (`[name](e12)`) instead of a line each, and when the elements would leave the text no room, long lists of
  links or buttons (sidebars, menus, footers, file tables) fold to one line with a count and a ref that lists them,
  those around the content first; a page that is mostly links keeps them. A page whose default view is still over 7,000
  characters (a news site, a long article, a repository page) is sent as an outline instead: headings, landmarks,
  fields, everything inside a form (its errors too), the buttons beside a field, live regions and dialogs, the first 40
  links and the first 1,500 characters of the main text, with one line saying what it left out and that `find`, a ref
  read or `read` with `full` gets the rest. Measured on saved pages it is a fifth to a half of the view (a Hacker News
  item 6,515 → 1,272 tokens), and it is sent only when it is at most three quarters of it. Since a form is kept whole, a
  page wrapped in one form (ASP.NET WebForms) or with a large form is never outlined: it loses nothing, only the saving.
  The threshold is 7,000 and not lower because near it an outline saves little and an answer in the text it drops costs
  a whole extra request (a docs page at 6,270 characters did, at 6,000). Loads keep their own rule; `full`, a ref read,
  `depth`, `all`, `find` and diffs are never outlined, and the diff baseline still holds the whole page. Replies are
  capped at 12,000 characters. Password
  field values are stripped before the tree leaves the extension and rendered as `value=<redacted>`
  so neither the value nor its length leaks.
- **Literal search by default, bounded regex opt-in.** `find` does case-insensitive literal
  matching in-process. Passing `regex: true` (at most 200 characters) runs in a worker terminated
  after 500 ms so a slow pattern cannot stall the shared daemon.
- **Line diffs and short repeat headers.** After the first read of a tab, `read` and `act` return a
  line diff, falling back to full text when at least half of the lines changed or the diff is no
  shorter. Semantic ref-keyed diffs were rejected for v1 unless measurements show line diffs fall
  short. Each MCP server process keeps its own diff baseline so two agents reading the same tab do
  not consume each other's diffs. Repeat replies whose title and URL have not changed print only
  `tab <id>` instead of repeating both.
- **Flat batched `act` steps with settle waits.** `act` runs a batch of steps (`click`, `type`,
  `fill`, `press`, `select`, `scroll`, `hover`, `wait`) on one tab, waits for network, DOM and
  layout activity to settle after each step, and returns the resulting page diff. Steps use one flat
  object schema (`{ action, ref, text, ... }`) rather than a tagged union of per-action schemas:
  flattening cut the `act` tool definition by more than half while one server-side validator still
  rejects missing, extra or out-of-range fields and converts to the protocol's nested step format.
  `run_js` is the escape hatch for page checks and actions the structured tools do not cover.
- **Downscaled JPEG screenshots and iframe boundaries.** `screenshot` captures JPEG downscaled to a
  1280 px long edge by default to limit image token cost. `read` returns the main frame and
  same-origin child frames only, replacing cross-origin frames with `frame omitted: <origin>`.
  Screenshots are not filtered for iframes because CDP captures the rendered viewport.
- **Token measurements enforced in CI.** `pnpm bench` runs the real tools over fixed local pages,
  measuring character counts, estimated `o200k_base` text tokens, JPEG bytes and estimated image
  tokens. CI fails if any metric exceeds `bench/budget.json`.

## Extension-to-daemon link

- **Loopback daemon with a random token and free-port fallback.** The daemon listens only on
  `127.0.0.1` (default port 8765, falling back to any free loopback port when 8765 is taken unless
  a port was explicitly requested) and writes its port and random bearer token to `daemon.json`
  (mode `0600` under `$XDG_STATE_HOME/t3-tab/` or `~/.local/state/t3-tab/`). Falling back to a free
  port was chosen over failing hard on 8765 because every client reads the port from `daemon.json`.
- **Native messaging bootstrap and a separate extension token.** Chrome native messaging (Chromium's
  mechanism for an extension to start a registered local helper process, `t3-tab native-host`) hands
  the extension the daemon's port and its own random token from `extension.json` (mode `0600`).
  This avoids manual pairing codes. The daemon grants the browser role only when both the extension
  token and the extension's `Origin` match, so an MCP client holding `daemon.json` cannot connect as
  the extension.
- **Keepalive and strict protocol versioning.** The extension pings the WebSocket every 20 seconds
  while connected so Chromium does not stop the idle Manifest V3 service worker mid-session. The
  extension, native host and daemon require an exact `PROTOCOL_VERSION` match; a mismatch closes
  the link and the panel says which side is behind (see "Installing the helper").

## Installing the helper

- **The product is installed from the extension store plus one command.** A store extension cannot write a
  native host manifest, so the part that lives on the machine (the helper: native host, daemon and MCP server)
  is one command that runs from any folder, `npx t3-tab@latest setup`, shown in the panel with a copy button.
  Native-host products do the same through their own CLI or app (Claude Code, 1Password, KeePassXC); MCP products
  run `npx <package>@latest`. No git checkout, no repository, no administrator rights.
- **npm package `t3-tab`, bundled into one file.** `packages/helper` bundles the server and all its
  dependencies into `dist/cli.js`, so the package has no dependencies and starts fast under `npx`. `setup`
  copies that file into a per-user folder (`~/.local/share/t3-tab`, `~/Library/Application Support/T3-Tab`,
  `%LOCALAPPDATA%\T3-Tab`) and writes two launchers next to it: one the native host manifest names, one agents'
  MCP entries name. The launchers run the file with the Node that ran `setup` and fall back to `node` on PATH if
  that Node moved. The npx cache is never referenced, because it can be cleared at any time.
  Alternatives rejected: `npx t3-tab@latest mcp` in every agent entry (starts slower, needs the network on each
  launch, and the browser's native host cannot use it); a self-updating binary from `curl | sh` (needs a release
  pipeline per platform, and Node is already needed for the agents' own tools).
- **Updating is running the command again.** It replaces the file, rewrites the launchers and registrations, and
  stops a running background program that is from another version (`daemon.json` records the helper version) so
  the browser starts the new one. A helper that updated itself from the browser's launch would run downloaded
  code without being asked, so it does not. When the two sides disagree, the helper or the extension names the
  one that is behind (its protocol version is older); the panel then shows the command, or points to the
  browser's extensions page. Agents that were using the old background program need restarting.
- **Registration covers every Chromium-family browser found, and running browsers with their own profile.**
  Linux and macOS: a manifest in the browser's profile folder (Linux honours `XDG_CONFIG_HOME`); Windows: an HKCU
  registry key per browser pointing at one manifest. A browser started with `--user-data-dir` reads
  `<that folder>/NativeMessagingHosts` instead of its usual folder, so `setup` also registers in the profile
  folder of every browser process it finds running (from `/proc` or `ps`) and takes `--user-data-dir <folder>`.
  This was the cause of the helper shown as missing on a machine where the manifest and launcher worked by hand.
- **No reload or restart is needed.** Chromium reads the manifest again each time the extension asks for the
  native host, which the panel makes every three seconds while the helper is missing (checked in headless
  Chromium: a manifest written after the browser started was used on the next attempt). The panel's step needs
  no button, and the browser starts the background program through the native host whenever it is not running.
- **One extension ID.** The manifest `key` gives an unpacked build the same ID on every machine. The native host
  manifest and the daemon accept a list of IDs: the key's, and `STORE_EXTENSION_ID` in
  `packages/protocol/src/index.ts`, which stays empty until the store listing exists (the store assigns its own
  ID; its dashboard shows a public key to put in `EXTENSION_KEY`, after which both are the same). Filling in the
  constant is the only change needed.
- **Uninstall is one command and removes what install added.** Setup records every file and registry key it wrote
  in `install.json`; `uninstall` removes those, the usual locations, agent entries and the state folder, and
  leaves other products' native host manifests alone. Naming an agent (`--claude`, `--codex`) removes only that
  agent's entry, because the other agent and the browser still use the helper.
- **Test browsers are left alone.** Setup also serves browsers running with their own `--user-data-dir`, but not
  headless ones or profiles under a temporary folder, which belong to test runs. A folder the user names is always
  served.
- **Until the package is published, the panel shows a test command.** One constant (`HELPER_CHANNEL` in
  `packages/extension/src/helper-command.ts`) chooses between the product command and a script that downloads
  the packed helper from a GitHub prerelease and runs the same `setup`. Plain `npx <tarball url>` was rejected for
  the test build because `npx` caches by address and would not fetch a refreshed file. Windows has no test
  script yet; the product command works there.

## Permissions and trust model

- **Threat boundary.** T3-Tab protects the browser from websites, other local OS users and remote
  machines. It does **not** protect the browser from programs running as the same OS user (including
  coding agents), which can already read the user's home folder, browser profile, T3 data and `0600`
  state files (`daemon.json`, `extension.json`) or run `t3-tab native-host`.
- **`scripting` and `<all_urls>` to survive other extensions' frames.** Chromium detaches
  `chrome.debugger` from a tab as soon as a frame of another extension starts loading in it, and no
  DevTools setting stops that, so a password manager's autofill menu made login pages unusable.
  T3-Tab asks for `scripting` with host access and uses it for one fixed function that points those
  frames at `about:blank`, which also blanks that extension's menu on a tab an agent is using.
  `debugger` already reaches every page, so this adds no reach, but it is a wider declared permission.
- **Dialogs are answered through `act`.** Enter accepts, Escape dismisses and `type` fills a prompt,
  so the tool schema did not grow. A dialog from a frame of another origin shows no text and can
  only be dismissed.
- **Opening a page asks first, and does not take the owner's tab.** The prompt names the address and nothing is
  fetched or run until the owner says yes, because a page loaded before the answer has already used their cookies. The
  page opens behind the tab they are on, so the side panel stays in view for the answer. A hidden page gets no animation
  frames, so it counts as visible until it has settled and for a screenshot, then goes back to hidden; the reply waits
  for the first frames, not for the page to settle, then carries the page. A redirect to
  another origin keeps the tab, unapproved, rather than failing: the approval covers only the origin asked for.
- **A load replies with the page.** Agents followed every `open` with a `read`, and some called `read`, `goto` or `act`
  before opening any tab and were refused, each a model request that re-reads the whole context. So `open`, `goto`,
  `back`, `forward` and `reload` reply with what `read` would show (or the lines a `find` matches), and `read` and `goto`
  with an address open a tab when the session has none. The page is in the reply only where a `read` would need no
  prompt, and, for a load Full access let through, only while T3 still confirms the mode after the read; the
  empty-session path asks the same `open` prompt before anything loads. A load now also takes the accessibility fetch,
  which the `read` it replaces took anyway. It does not wait for the page to go quiet: a page that never does (a poll, an
  animation) would hold every load for the whole wait. A page that moved while it was read is read once more if that
  first read was quick, so a load does at most two reads. Models send a `read` or `find` with the load in the same turn,
  before they see its reply, so a page over 4,000 characters is left out of the load's reply and comes with that read (a
  page whose text alone is longer is not even read for the load), and a `read` with `full` right after a load that
  showed the page says it is unchanged instead of resending it. The same holds after an `act` whose reply was the whole
  page (a new screen): models send `full` with an action as they do with a load. It holds only when the agent got that
  very reply: an outline, a diff or a reply cut short for opened tabs showed less, so `full` then sends the whole view.
  The `tabs` description says a load replies with "the page", not "a short page": with "short", Haiku asked for `full`
  with the load and after every action, and paid for each page twice.
- **An action says what it did, so no read follows it.** A click that opened a tab used to reply "No changes", and the
  agent then listed tabs and read the new one. Now an `act` reply names every tab its steps opened that joined the
  session, as a load's reply shows a tab: by origin and `[needs approval]` until the session may read it, and the first
  one it may read with its page, under a load's rules (size, the Full access re-check, redaction). Full access counts
  there only on the origin the batch was let through for, as it covers only the origin a load asked for; another origin
  needs its site setting. The tab stays unapproved, and the session's current tab stays the one it acted on. `act` also
  takes `find`, so the reply is the matching lines, as `read` with `find`. It does not take page JavaScript: a script
  stays a `run_js` call, so an agent client's rule that asks before `run_js`, and a thread's approval label for `act`,
  keep their meaning.
- **`read` with an address never moves a tab.** It reads a tab of the session already at that address, or opens a new
  one, asking as `open` does. Going to the address in the current tab would load the owner's shared tab elsewhere, or
  load a page again and lose what was typed into it, from a call that reads like a read. Moving a tab stays with `tabs
  goto`, which says it moves one. A tab the session may not read yet is not reused, so the prompt that comes up does not
  tell the agent where that tab is.
- **A session has a current tab.** With tabs opening in the background, the tab in front no longer says what the agent
  is working on. Calls that name no tab use the last one the session opened, switched to or was handed. The owner moving
  between tabs does not change it, so an action cannot land on a tab the agent did not mean.
- **Moving a tab follows the rules for opening one.** `goto` asks like `open` every time unless the site is allowed,
  including on the same origin: the agent chooses the address, and a GET can change things, so a read grant or an earlier
  approval does not cover it. `back`, `forward` and `reload` revisit what the tab has shown and ask only for an origin
  the session holds no approval for there. `reload` never resends a form: the browser's own reload would, without asking.
- **Socket-bound sessions and tab groups.** The daemon issues each session id and binds it to the
  control socket that registered it; requests on another socket or with another id are refused.
  Tabs a session opens go into its own Chromium tab group. A session can list and use only tabs in
  that group or tabs explicitly shared from the side panel. A popup opened from a session's tab
  joins its group without inheriting origin approval; popups from user tabs are left alone.
- **Per-site permissions and per-tab origin approvals.** Site settings are stored per HTTP(S)
  origin as `ask` (default), `read` (read and screenshot without prompting; never open, act or
  `run_js`), or `allow` (all four). Sessions also record approved origins per tab. Committing a tab
  to another origin clears those approvals rather than treating group membership as lasting access;
  unapproved member tabs show only their origin and `[needs approval]` in `tabs`.
- **Checks around waits, actions, scripts and screenshots.** Membership, restricted-page (`chrome:`,
  `brave:`, `edge:`, `devtools:`, `chrome-extension:`, `view-source:`, Chrome Web Store and other
  non-HTTP(S) pages) and approved-origin checks run again after every prompt wait and before every
  `act` step:
  - `run_js` runs only in the main frame's JavaScript context pinned by `uniqueContextId` after the
    browser confirms that context's origin matches the approved one.
  - `screenshot` records the document epoch and URL before capture and discards the image if either
    changed.
  - `act` stops a batch if a step other than `wait` leaves the page on another origin (checked after
    input and again after settling). CDP input cannot target a single document, so input that
    reached a navigating page is reported rather than prevented.
- **Prompt UI safeguards.** Prompts name the tab id and title, keep arrival order, cap waiting
  prompts at three per session, accept messages only from the real side-panel sender, and lock
  buttons for 500 ms when a prompt appears or rows shift above it.
- **Agents that reach for the tools by themselves get a collapsed tab group, not a window of their own.** A session not
  started from the side panel (an MCP client of the owner's own, a T3 thread not started from the panel) has its tabs
  in its tab group in the owner's window, created collapsed; panel-started sessions keep an expanded group. A separate
  window for those agents was studied and rejected:
  - On Wayland (the default session on GNOME and KDE, and the only one on Hyprland and Sway) a new window always shows
    up: it cannot be created minimized or without focus, and tiling desktops fit it into the owner's workspace.
  - Chromium refuses a window placed off screen.
  - The agent's own clicks raise a window whose agent tab is in front, taking focus from the owner (measured on X11 and
    KDE; Windows and macOS do the same in Chromium's code).
  - Keeping the agent's tabs as background tabs of that window stops the raising, but then they are throttled exactly
    like background tabs in the owner's window, so the window gains nothing and still sits in the taskbar or Dock.
  A collapsed group behaves the same on every platform, never moves or focuses a window, and keeps tool behaviour as it
  was. A panel-launched agent that opens a tab before it claims its tabs is taken for self-started until the claim
  arrives, and its group then expands once. Worth revisiting only if Chromium lets a hidden page draw without being the
  front tab of a window, or stops focusing a window on injected mouse presses.

## Side-panel sessions

- **The panel is a small T3 client.** With T3 Code present, the panel holds its own client session and T3 starts and
  runs its threads; without T3, the picked provider runs directly and feeds the same thread view. This replaces the
  older read-only sign-in, which is removed, and the `t3 thread` polling below, which stays in the daemon unused by
  the panel. The panel does not load T3's web app: it is its own small client that reuses T3's theme code.
- **T3's Full access counts as yes for browser requests, while T3 confirms it.** A Full access thread can already run
  any command as the owner, so asking again adds nothing. The extension asks T3 for the thread's mode with
  `t3 thread show --json --messages 0 <threadId>` when a request needs a prompt, rather than trusting a flag the panel set,
  so it holds with the panel closed and fails to a normal prompt when T3 cannot answer. A yes counts for two seconds, on a monotonic
  clock, from when its read started, and a request passes only at a moment when all the session's threads have a live yes, so two
  seconds is the longest a request can pass after any of them leaves Full access. A request waits at most five seconds
  for that, then prompts, and a read stuck for five seconds no longer blocks a fresh one. A pass records no
  origin approval, so reads and tab titles follow the live mode as well. Other requests show in both the side panel and the agent's thread, and the first answer
  counts.
- **Full access covers every T3 thread, identified by its process.** A thread the owner runs in T3 should not get browser
  prompts just because the panel did not start it. T3 puts `T3CODE_THREAD_ID` in the environment of a thread's provider
  processes. The daemon believes it only when the process holding the control socket carries one valid id and its parent
  chain reaches the recorded T3 server, avoids the daemon, and names no other thread. Tradeoff: an agent started by hand in
  a T3 terminal counts as that terminal's thread, and a program running as the owner could still forge its environment.
  Such a program is already outside the trust model. The live per-request mode check is unchanged.
- **The side panel stays on the tab it was opened on.** A window-wide panel followed the owner to every tab and made "this
  tab" ambiguous. Each tab now opens its own panel and keeps its own draft, project and screen. A thread keeps running when
  the owner moves away; other tabs' new-thread screens list it, and permission cards from other tabs say so.
- **The panel lines up what people see, not boxes.** The first and last controls of every bar and of the composer's
  row sit with their visible ink on the screen's 12 px gutter, and the hero's lines centre on the heading's ink. The
  panel measures this when it lays out (`useInkAlign` and `useInkCentre`), so a new control needs no numbers of its
  own; sizes come from shared tokens (one control size, one gap, one icon scale, one type scale).
- **The composer row is one size on one centre line.** Paperclip and mic sit in tinted 32 px circles that mirror the
  32 px send circle, the model chip is a 32 px pill, every glyph is 16 px at one 1.5 px stroke, and every control's
  ink (and the chip's logo and words) is centred on one line. The circles sit 12 px from the frame at the sides and
  the foot, where the chips and the text start. Standing the controls on one baseline instead left the small glyphs
  hanging below the send circle's middle; T3 Code's own row at the panel's width (32 px ghost buttons with 18 px icons,
  a 36 px send) puts its paperclip twice as far from the edge as send, so the panel does not copy it.
- **The thread list follows T3's sidebar.** Rows carry T3's project avatar, status or time, title, the machine and the
  provider; hovering offers T3's snooze presets and Settle (Wake and Un-settle on the shelves), sent as T3's own client
  sends them. The Working, Snoozed and Settled shelves sit at the foot of the list as in T3. T3's custom snooze time is
  left out; its presets, including the owner's own list from T3's settings, are offered.
- **Appearance settings are compact.** T3's Settings shows the color scheme as three large preview cards and themes as a
  grid of cards; in a side panel that pushed everything else off screen, so the panel uses one segmented row for the
  scheme and one select-style menu for the theme, as T3 uses for its other settings, with the current theme's actions
  in a menu beside it.
- **The panel does not follow T3's theme** until T3's plugin system offers a supported way: T3 keeps the desktop's theme
  in the app window's own storage, and clients cannot set the environment theme.
- **Files can be dropped anywhere on a screen with a composer.** As in T3's workspace drop, a file dragged over the
  new-thread screen or a thread shows a dashed overlay over the whole panel and goes to the composer; on other screens a
  drop is refused so the panel never opens the file in its place.
- **A new tab starts in no project.** That is T3's Scratch project. The default can be changed in Settings to the last used
  project or a fixed one. A pick made on a tab holds for that tab only.
- **T3 credentials travel on checked connections.** The daemon spends the pairing credential and sends token renewals
  and WebSocket ticket requests through its process check. The panel signs their proofs, so its key stays in the
  browser. The WebSocket itself is opened by the browser and cannot be checked, which is an accepted gap.
- **Two routes from the panel.** With T3 connected, the panel talks to T3 directly over its WebSocket. For setup, T3
  session requests, direct runs and tab sharing it talks to the extension service worker, which relays to the daemon
  where needed. Direct-run conversations live in daemon memory and end when the daemon stops.
- **T3 Code threads via CLI polling (older route, unused by the panel).** The daemon starts, continues and follows threads with
  `t3 thread start|send|show --json`, polling `show` every 3 seconds while active and slowing up to
  30 seconds while waiting on an answer (stopping after 6 hours). `t3` is located via `T3_TAB_T3`,
  `PATH` and standard install folders, or T3's runtime launchers and versions directories. Polling
  was chosen over streaming for v1; moving to T3's `/mcp` incremental reads is deferred.
- **Isolated direct runs.** When T3 Code is stopped or missing, the panel runs Claude Code
  (`claude -p`) or Codex (`codex exec`) directly, one process per turn resumed with the session id
  printed by the CLI. Direct runs expose **only** T3-Tab's browser tools: built-in shell, file, web
  search, hook and plugin tools are disabled, and Codex runs with `--ignore-user-config` and
  `sandbox_mode="read-only"`. Leaving read-only local file tools enabled was rejected because an
  agent able to read private files and drive a browser could exfiltrate them to a website. Work
  that needs the repository belongs in a T3 Code thread.
- **Direct Codex custom provider carryover.** While a direct Codex run ignores the user's
  `config.toml`, T3-Tab carries over only the active top-level `model_provider`, its `model` (unless
  overridden) and that single `[model_providers.<name>]` table so users on custom providers do not
  fall back to OpenAI. Profiles and other config sections are not read. Bearer tokens and static
  HTTP headers move into child process environment variables (`env_key` and `env_http_headers`),
  never onto the command line; credentials that have no route off the command line fail clearly
  instead of falling back.
- **One-time claim codes for tab handoff.** Starting a session shares the active tab (or its
  user-created tab group) via a random, single-use, expiring, route-bound claim code issued by the
  extension:
  - Direct runs pass the code in a `0600` file (`t3-tab mcp --claim-file <path>`) that the MCP
    server deletes as it reads it, keeping the code out of command lines, environment variables and
    prompt text. Each resumed turn gets a new code reflecting tabs still shared.
  - T3 Code threads include a claim line in their first message asking the agent to call `tabs` with
    `{"claim": "<code>"}` (hidden in the panel). Passing the code in the message was chosen over
    matching sessions by environment variables because T3 starts MCP servers from its own config
    with no cross-provider env-var hook. The code works once and expires after 10 minutes, so the
    copy left in T3's transcript cannot share tabs again.
- **The read-only OAuth sign-in to T3 `/mcp` is removed.** It existed to list projects and models before the panel had
  its own T3 session, and it was about a tenth of the helper's bundle. The daemon deletes the token an older version
  left. T3 provides no client self-revoke, so that grant stays in T3's Settings → Sharing & access until it expires,
  at most 30 days after it was made.

- **The panel looks and works like T3 Code.** It has a new-thread screen, a thread view, and a thread list and settings
  behind icons. It is React, styled only from T3's theme roles, so any T3 theme applies in full. Waiting permission and
  question cards sit above the composer, because that is where the owner is already looking. Prompts can come from any
  MCP session, so the Threads screen also lists every connected session, named by its thread.
- **One approval card, in T3 Code's anatomy.** Browser prompts and a T3 thread's approvals use one card: what is asked,
  where, then Decline, the primary answer and More on one row, as T3 orders them. It stays small (at most 160 px) so the
  conversation stays in view. The lasting browser choice lives under More, stated in full, rather than as a third button:
  at 320 px three buttons whose labels say what they grant do not fit on one row, and T3 also keeps its lasting answer
  under More. A T3 approval is drawn at its work-log row, where T3 draws it, and falls back above the composer when that
  row is not shown. A T3 approval draws only the answers T3 offers, and none unless T3 says the provider can still take
  one. It is answered by click only, as in T3's own client. On browser prompts Enter answers with the primary answer and
  Escape declines, only when no field has focus and nothing covers the panel, only on the first prompt fully on screen,
  and only with a press that began after that card became keyed, so a key meant for the composer, a card the owner
  cannot see or a double press never answers a card. All of a screen's cards share one lock list, so a card answered
  above another locks the one that moves, and every card is locked again when the panel is shown after being hidden.
- **The panel does little while idle.** Changes reach it through a message from the worker, stored-state events and tab
  events, and its timers are only a safety net. Markdown and Settings load on first use. It adds nothing a website can
  see: no content script, no web-accessible resource and no page change.
- **No Remove button for an agent in the panel.** Removing means editing the owner's Claude Code or Codex configuration,
  which the panel never does itself. It shows the command that removes the entry instead.
- **T3-Tab has its own icon.** A browser window with a pointer. T3 Code's mark is used only where the panel names T3 Code.

## How it is checked

- **One end-to-end seam backed by unit tests.** `pnpm e2e` launches headless Playwright Chromium
  with the built extension, real native host, real daemon and real MCP clients against a local test
  site, an install of the packed helper into a temporary home from a folder outside the repository (into a
  browser that is already running, with no reload), plus fake `t3`, `claude` and `codex` CLIs for side-panel
  sessions. Unit tests (`pnpm test`, Vitest) cover page reading, diffs, refs, permissions, agent
  config installation, Codex provider parsing and T3 connection checks underneath.
- **Temporary HOME for config and agent tests.** Every test that touches `~/.claude`, `~/.codex`,
  T3 settings or launched agents uses a temporary `HOME` and XDG directories, never live user
  configuration.
- **No desktop browser runs.** Automated browser checks run headless or on another machine, never on
  the user's desktop display.

## Not in v1

- Remote machines, and listeners on anything but loopback.
- Firefox support.
- T3-Tab plugins, or adopting T3 Code's plugin system.
- Direct runners beyond Claude Code and Codex (such as pi).
- Loading T3 Code's web UI inside the side panel.
- Persisting side-panel conversation history across daemon restarts.
- Per-model tool profiles or on-demand tool packs.
- Cross-product token benchmarks against Claude in Chrome or the Codex Chrome plugin (v1 benchmarks
  T3-Tab against its own budget).
- Publishing to browser web stores or npm (the install is built and packed for it, and waits for the owner).
