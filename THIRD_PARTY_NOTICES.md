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

<!-- Entry format:
## Project name

- Source: repository URL and file path
- Revision: commit or release
- Licence: SPDX identifier and copyright notice
- Local files: paths copied or adapted
- Changes: what changed
-->
