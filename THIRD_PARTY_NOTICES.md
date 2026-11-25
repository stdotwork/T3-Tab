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

### T3 Code: the side panel

- Source: https://github.com/pingdotgg/t3code
- Revision: `fb23f12f1f`
- Licence: MIT, Copyright (c) 2026 T3 Tools Inc. (noted at the top of each copied file)
- Local files: `packages/extension/src/t3/theme-palettes.ts` (`packages/shared/src/themePalettes.ts`),
  `theme-css-rules.ts` (`packages/shared/src/themeCss.ts`), `theme-css.ts` (`apps/web/src/themeCss.ts`) and
  `theme-palette.ts` (the colour, parsing and file functions of `apps/web/src/themePalette.ts`); `packages/extension/entrypoints/sidepanel/lib/model-short-name.ts`
  (`packages/provider-core/src/modelShortName.ts`); the provider logos in
  `packages/extension/entrypoints/sidepanel/lib/provider-logos.ts` (the packaged icons of the cursor, grok, fx, opencode,
  kiro, muse and pi clients, `openRouterIcon` in `packages/client-runtime/src/providerClients.ts`, and the bundled marks
  in `apps/web/src/components/Icons.tsx`, with their colours from `apps/web/src/components/chat/ProviderInstanceIcon.tsx`)
- Changes: import paths; message formatting without `gt-react`; `pipe` without Effect; the stored-theme and Atom code is
  left out. The panel's components, styles and WebSocket client are T3-Tab's own, written against T3 Code's public
  protocol and modelled on its interface. The provider logos are gathered into one data file, with the path data copied
  unchanged (the kiro mark's path is the join of four of T3's constants). `Icons.tsx` labels its brand marks from Simple
  Icons (CC0) with a comment above its OpenRouter, Ollama and Anthropic marks; the Ollama and Anthropic logos here come
  from that group, and the OpenRouter logo here comes from `providerClients.ts` instead. The T3 Code mark in
  `packages/extension/entrypoints/sidepanel/ui.tsx` (`T3Mark`) is the glyph path of T3 Code's `assets/prod/logo.svg`,
  changed to a rounder background drawn in the active theme's colours. It names T3 Code on the setup and connection rows
  and is not T3-Tab's icon. `ProjectAvatar`, `projectInitials` and `projectHue` in the same file follow T3 Code's
  `ProjectMonogram` (its letters, its hash over the same eighteen Tailwind hues, and its SVG text), `SendArrow` in
  `Composer.tsx` is the path of T3 Code's composer send glyph, and `lib/snooze.ts` follows the presets, labels and times
  of T3 Code's `threadSettled` module; all are rewritten from T3 Code's built client (nightly 0.1.12, 2026-11-24).

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
