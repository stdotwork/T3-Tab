# Third-party notices

T3-Tab is Apache-2.0 licensed. Files copied or adapted from another project are listed here.

## Playwriter

- Source: https://github.com/remorses/playwriter, `playwriter/src/diff-utils.ts`
- Revision: `cde94d02752cc0f5f2b9227eafddaafb9ea105b1`
- Licence: MIT, Copyright (c) 2026 Tommy D. Rossi (the full notice is at the top of the local file)
- Local files: `packages/server/src/reader/smart-diff.ts`
- Changes: one line of context instead of three; hunks start with a bare `@@` instead of file headers
  and line ranges; "No newline at end of file" markers are left out; the `label` option is removed.
  The line diff that falls back to the full text when at least half of the lines changed, or when the
  diff is no shorter than the text, is Playwriter's.

## T3 Code

- Source: https://github.com/pingdotgg/t3code, `apps/server/src/auth/McpOAuth.ts` (`redirectMatches`) and
  `apps/server/src/mcp/McpHttpServer.ts` (the `/mcp` 401 answer)
- Revision: `c90b67859a6d85fc957f9ffe25ba95113c6479d3`
- Licence: MIT, Copyright (c) 2026 T3 Tools Inc. (noted at the top of the local file)
- Local files: `e2e/fakes/t3-server.mjs`, the end-to-end run's fake T3 environment
- Changes: rewritten in plain JavaScript without Effect; the rest of the fake is T3-Tab's own and only
  imitates T3's answers.

## Lucide

- Source: https://github.com/lucide-icons/lucide, icon path data (`alert-circle`, `arrow-left`, `arrow-up`, `chevron-right`, `globe`, `log-in`, `log-out`, `plus`, `refresh-cw`, `settings`, `shield-alert`, `x`)
- Revision: `0.344.0` (`a0aa1326828256ec68ed0a5c8fb3706e67f553e4`, verified exact match for all 12 icon SVGs)
- Licence: ISC, Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022 (the full notice is at the top of the local file).
- Local files: `packages/extension/entrypoints/sidepanel/icons.ts`
- Changes: extracted only the 12 needed icon path definitions into a minimal inline SVG DOM helper with zero runtime dependencies.

<!-- Entry format:
## Project name

- Source: repository URL and file path
- Revision: commit or release
- Licence: SPDX identifier and copyright notice
- Local files: paths copied or adapted
- Changes: what changed
-->
