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
- **Reach T3 Code threads via user-level MCP config.** `t3-tab install` registers `t3-tab mcp` in
  Claude Code (`~/.claude.json`) and Codex (`~/.codex/config.toml`) using absolute paths to Node
  and the built CLI, preferring `claude mcp add` and `codex mcp add` and falling back to
  non-destructive file edits. T3 Code threads load those user-level configs, so the same setup
  serves both T3 threads and standalone CLI sessions without changing T3 Code.
- **Three-package TypeScript workspace.** `packages/extension` holds the browser service worker and
  side panel; `packages/server` is one Node.js CLI providing the background daemon, Chrome native
  host and stdio MCP server; `packages/protocol` holds the versioned message types shared between
  them. Keeping page reading, ref tracking, diffs and agent process management in Node keeps the
  extension small and easy to unit-test.

## Browser target and reference boundaries

- **Chromium first, Firefox later.** v1 targets Chromium-based browsers (Chromium, Chrome and
  Brave). The extension is built with WXT (a WebExtension build framework) so Firefox support can
  be added later without rewriting the extension.
- **Behavioural reference only for proprietary tools.** The permission model—per-site prompts,
  confirmation for risky actions, session tab groups and explicit tab sharing—follows Claude in
  Chrome's behaviour. Proprietary products (Claude in Chrome and the Codex Chrome plugin) are
  studied for behaviour and tool design only; their code is never copied. Code adapted from openly
  licensed projects keeps its licence and copyright notices and is listed in
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). T3-Tab is licensed under Apache-2.0.

## MCP tools and token budget

- **One core tool set for every model.** Every MCP client receives the same six tools: `status`,
  `tabs`, `read`, `screenshot`, `act` and `run_js`. MCP identifies the client rather than the model,
  so per-model tool profiles were rejected. Rarer actions are left to optional future tool packs to
  keep prompt overhead small.
- **Accessibility-tree reading with short refs.** `read` fetches the Chrome DevTools Protocol (CDP)
  accessibility tree (`Accessibility.getFullAXTree`) instead of raw HTML or DOM dumps. By default
  it returns interactive elements only, with short refs (`e1`, `e2`, ...) held in the daemon and
  invalidated when the tab's document is replaced. Replies are capped at 12,000 characters. Password
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
  the link and prompts the user to rebuild and reload.

## Permissions and trust model

- **Threat boundary.** T3-Tab protects the browser from websites, other local OS users and remote
  machines. It does **not** protect the browser from programs running as the same OS user (including
  coding agents), which can already read the user's home folder, browser profile, T3 data and `0600`
  state files (`daemon.json`, `extension.json`, `t3-credential.json`) or run `t3-tab native-host`.
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

## Side-panel sessions

- **The panel is a small T3 client.** With T3 Code present, the panel holds its own client session and T3 starts and
  runs its threads; without T3, the picked provider runs directly and feeds the same thread view. This replaces the
  read-only sign-in as the panel's route to T3 and the `t3 thread` polling below, which stay in the daemon unused by
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
- **Optional read-only OAuth sign-in to T3 `/mcp` (older route, no longer shown in the panel).** Because the `t3` CLI has no command to list
  projects, providers or models, the panel uses typed text fields unless the user signs in once to
  the local T3 server's `/mcp` endpoint via OAuth 2.0 authorization code with Proof Key for Code
  Exchange (`PKCE`, `S256`) and dynamic client registration. T3-Tab stores the token in
  `t3-credential.json` (mode `0600`) only when T3 grants exact `orchestration:read` scope,
  discarding broader grants, and uses it only for `t3_project_list` and `orchestrator_capabilities`.
  On Linux, every request verifies via `/proc` that the recorded T3 pid owns the accepted loopback
  socket and started before `startedAt`; platforms without `/proc` send nothing and keep typed
  fields. T3 issues no refresh tokens (a sign-in lasts 30 days) and provides no client self-revoke
  endpoint, so Sign out deletes the local file and instructs the user to revoke T3-Tab in T3's
  Settings → Sharing & access.

- **Inbox layout for the panel.** The panel's home lists waiting permission prompts first, across
  every session, then conversations with their status, the current tab and connected sessions.
  A conversation, the new-conversation form and settings (T3 sign-in and site permissions) open as
  their own views. Prompts can come from any MCP session, not only from panel conversations, so a
  layout built around one open conversation (as in Claude in Chrome) would show them in the wrong
  place, and a tabbed layout would hide them; both were tried in a prototype and rejected.
- **One set of design tokens, no UI framework.** All panel styling comes from CSS custom properties
  in `tokens.css` (light and dark, one accent, a 4 px spacing scale, focus ring, reduced motion),
  so a theme can later replace the tokens without touching prompt wording or buttons. The panel is
  plain TypeScript: about 39 KB of script (11 KB gzip), first render with real state in about 6 ms
  headless. Prompt and site button labels come only from `prompt-choices.ts`.

## How it is checked

- **One end-to-end seam backed by unit tests.** `pnpm e2e` launches headless Playwright Chromium
  with the built extension, real native host, real daemon and real MCP clients against a local test
  site, plus fake `t3`, `claude` and `codex` CLIs and a fake T3 OAuth/`/mcp` server for side-panel
  sessions. Unit tests (`pnpm test`, Vitest) cover page reading, diffs, refs, permissions, agent
  config installation, Codex provider parsing and T3 sign-in checks underneath.
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
- Publishing to browser web stores or npm.
