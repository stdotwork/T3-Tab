# AGENTS.md

T3-Tab exposes the user's own signed-in Chromium browser as MCP tools for coding agents (Claude Code,
Codex, T3 Code threads and any MCP client), and adds a side panel that starts and continues real agent
sessions, through T3 Code or directly. It never runs its own agent loop: the agent the user picks does the
work, with the browser tools injected.

## Layout

- `packages/extension` — the WXT Manifest V3 Chromium extension, including its service worker and side panel.
- `packages/server` — the Node.js/TypeScript background program.
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
`pnpm e2e` launches Playwright's Chromium with that built extension.

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
