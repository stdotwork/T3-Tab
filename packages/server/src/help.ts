// What `t3-tab --help` prints. This file imports nothing, so asking for help loads no other part of the program.

const BROWSERS = 'chromium|chrome|brave|edge|vivaldi';

const TOP = `t3-tab: gives your coding agents your own browser as MCP tools.

Usage: t3-tab <command> [options]

Commands:
  setup         Install the helper for this user and link it to your browser (what \`npx t3-tab@latest setup\` runs)
  uninstall     Remove the helper, its browser link and its state
  daemon        Run the background program in the foreground (the browser starts it by itself)
  native-host   The browser link; the browser starts it
  mcp           The MCP server an agent runs, on stdio
  version       Print the version

Developers working from a checkout also have \`install\`.
Run \`t3-tab <command> --help\` for a command's options.
`;

const COMMANDS: Record<string, string> = {
  setup: `Usage: t3-tab setup [options]

Installs T3-Tab in your own folder and registers its browser link in every Chromium-family browser it finds
(${BROWSERS.replaceAll('|', ', ')}). A browser that is already open finds it without a reload.

Options:
  --browser <${BROWSERS}>
                      Link only this browser; repeat for more. Use it when none is found.
  --user-data-dir <folder>
                      Also link the browser that uses this profile folder; repeat for more. Browsers running headless or
                      from a temporary folder are skipped unless you name their folder here.
  --agents            Also add T3-Tab to Claude Code and Codex, when found.
  --print             Say what would be done and change nothing.
  -h, --help          Show this help.

Exits 1 when no browser link was written.
`,
  uninstall: `Usage: t3-tab uninstall [--claude] [--codex]

With no option, removes everything setup added: agent entries, browser links, the helper and its state, and stops the
background program. With --claude or --codex, removes only that agent's entry and keeps all the rest.

Options:
  --claude      Remove only the Claude Code entry.
  --codex       Remove only the Codex entry.
  -h, --help    Show this help.
`,
  install: `Usage: t3-tab install [options]

For developers working from a checkout: registers this checkout's \`t3-tab mcp\` with Claude Code and Codex, and the native
host with the browsers found. Users run \`t3-tab setup\` instead.

Options:
  --claude, --codex   Register only these agents (default: every agent found).
  --browser <${BROWSERS}>
                      Register only this browser (default: every browser found).
  --print             Say what would be done and change nothing.
  -h, --help          Show this help.
`,
  daemon: `Usage: t3-tab daemon [--port <1-65535>]

Runs the background program in the foreground, on 127.0.0.1 (default port 8765, or T3_TAB_PORT). The browser starts it by
itself, so you rarely need this.

Options:
  --port <number>   The port to listen on.
  -h, --help        Show this help.
`,
  'native-host': `Usage: t3-tab native-host [install [--browser <${BROWSERS}>]]

With no argument, runs the browser link on stdin and stdout; the browser starts it, not you.
\`native-host install\` registers it for the browsers found, or the one named (developers working from a checkout).

Options:
  -h, --help   Show this help.
`,
  mcp: `Usage: t3-tab mcp [--claim-file <path>]

The MCP server an agent runs over stdio. It starts the background program when needed. Agents are set up to run this for
you (\`t3-tab setup --agents\`).

Options:
  --claim-file <path>   A file holding a one-use claim code for tabs shared from the side panel (the panel passes it).
  -h, --help            Show this help.
`,
  version: `Usage: t3-tab version

Prints the version.
`,
};

/** The help text for these arguments, or undefined when they do not ask for help. */
export function helpFor(args: readonly string[]): string | undefined {
  const [command, ...rest] = args;
  if (command === undefined) return undefined;
  if (command === '--help' || command === '-h') return TOP;
  if (command === 'help') {
    if (rest[0] === undefined) return TOP;
    return Object.hasOwn(COMMANDS, rest[0]) ? COMMANDS[rest[0]] : undefined;
  }
  const own = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (own !== undefined && rest.some((argument) => argument === '--help' || argument === '-h')) return own;
  return undefined;
}
