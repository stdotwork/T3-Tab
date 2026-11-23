# T3-Tab

T3-Tab gives your coding agents (Claude Code, Codex, T3 Code threads and any MCP client) your own signed-in
Chromium browser as tools, and adds a side panel where you start and continue agent sessions. It never runs a
model itself: the agent you pick does the work.

## Install

1. **Add the extension** to Chrome, Chromium, Brave, Edge or Vivaldi from the browser's extension store, then
   open the T3-Tab side panel.
2. **Run the one command the panel shows**, in a terminal, from any folder:

   ```sh
   npx t3-tab@latest setup
   ```

   It installs the T3-Tab helper for your user and registers it with every Chromium-family browser it finds.
   The helper is the part that has to live on your machine: it connects the browser to your agents. The panel finds
   it by itself a few seconds later, with no reload and no browser restart, and starts it whenever it is needed.
3. **Add your agents** with the buttons in the panel's setup screen (Claude Code, Codex), and connect T3 Code if
   you use it.

The command needs **Node.js 20 or newer**. Without it, `npx` fails with "command not found"; install Node from
<https://nodejs.org> and run the command again. Nothing is installed system-wide and no administrator rights are
needed.

To update the helper, run the same command again. When the extension and the helper are out of step, the panel
says which one is behind: for the helper it shows the command, for the extension it points to the browser's
extensions page.

### Remove it

```sh
npx t3-tab@latest uninstall
```

This removes everything setup added: the helper folder, the browser registrations, the Claude Code and Codex
entries and the helper's saved state, and stops the background program. Remove the extension from the browser's
extensions page.

### Where things go

| System | Helper folder | Browser registration |
| --- | --- | --- |
| Linux | `~/.local/share/t3-tab` (`$XDG_DATA_HOME` if set) | A manifest in each browser's profile folder, `NativeMessagingHosts/` |
| macOS | `~/Library/Application Support/T3-Tab` | The same, under `~/Library/Application Support/<browser>` |
| Windows | `%LOCALAPPDATA%\T3-Tab` | A key under `HKCU\Software\<browser>\NativeMessagingHosts` |

Only Linux has been run. The macOS and Windows paths are written and unit-tested but have not been run on
those systems.

A browser started with its own `--user-data-dir` reads native host manifests from that folder only. `setup`
finds such browsers while they are running; for one that is not running, pass its folder:
`npx t3-tab@latest setup --user-data-dir <folder>`.

## Developing from a checkout

This is the developer path, not how users install it.

```sh
pnpm install --frozen-lockfile
pnpm build            # the extension in packages/extension/.output/chrome-mv3, the helper in packages/helper/dist
```

Load `packages/extension/.output/chrome-mv3` in the browser as an unpacked extension (its ID is the same as the
store build's). Then either install the helper the way a user would,

```sh
npx --package "$(cd packages/helper && npm pack --silent --pack-destination /tmp)" t3-tab setup
```

or run the checkout directly, which registers the built `dist/cli.js` instead of a copy:

```sh
pnpm exec t3-tab install      # agents and browsers; --print shows what it would do
pnpm exec t3-tab uninstall
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm e2e`, `pnpm bench`. See `AGENTS.md`.

### Trying the helper before it is on npm

`scripts/install-test-build.sh` downloads the packed helper from the `helper-test-build` GitHub prerelease and runs
its `setup`; `scripts/publish-test-build.sh` refreshes that prerelease from the checkout.

## Licence

Apache-2.0, see `LICENSE`.
