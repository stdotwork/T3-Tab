import { readFile } from 'node:fs/promises';

import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import {
  addClaudeServer,
  addCodexServer,
  removeClaudeServer,
  removeCodexServer,
  type McpCommand,
} from '../src/install-config.js';

const command: McpCommand = {
  command: '/home/owner/.nvm/versions/node/v26.13.1/bin/node',
  args: ['/home/owner/src/t3-tab/packages/server/dist/cli.js', 'mcp'],
};

const codexFixture = await readFile(new URL('./fixtures/codex-config.toml', import.meta.url), 'utf8');
const claudeFixture = await readFile(new URL('./fixtures/claude-config.json', import.meta.url), 'utf8');

const codexEntry = `[mcp_servers.t3-tab]
command = "/home/owner/.nvm/versions/node/v26.13.1/bin/node"
args = ["/home/owner/src/t3-tab/packages/server/dist/cli.js", "mcp"]
`;

describe('Claude Code config editing', () => {
  it('keeps every existing key and adds one stdio server', () => {
    const updated = addClaudeServer(claudeFixture, command);

    expect(JSON.parse(updated)).toEqual({
      projects: { '/work': { allowedTools: ['Read'] } },
      mcpServers: {
        other: { type: 'stdio', command: 'other-mcp', args: [] },
        't3-tab': {
          type: 'stdio',
          command: command.command,
          args: command.args,
          env: {},
        },
      },
    });
    expect(addClaudeServer(updated, command)).toBe(updated);
  });

  it('removes only its server and leaves the rest of the file', () => {
    const source = addClaudeServer(
      `${JSON.stringify({ projects: { keep: true }, mcpServers: { other: { command: 'other' } } }, null, 2)}\n`,
      command,
    );

    expect(JSON.parse(removeClaudeServer(source))).toEqual({
      projects: { keep: true },
      mcpServers: { other: { command: 'other' } },
    });
  });

  it('refuses to replace a non-object mcpServers value', () => {
    expect(() => addClaudeServer('{"mcpServers": []}\n', command)).toThrow('mcpServers must be an object');
  });
});

describe('Codex config editing', () => {
  it('adds one TOML table without reordering or dropping comments and servers', () => {
    const updated = addCodexServer(codexFixture, command);

    expect(updated).toBe(`${codexFixture}\n${codexEntry}`);
    expect(addCodexServer(updated, command)).toBe(updated);
    expect(updated.match(/^\[mcp_servers\.t3-tab\]$/gm)).toHaveLength(1);
  });

  it('replaces its old table in place and removes its nested tables', () => {
    const source = `# before
[first]
value = 1

# old t3-tab
[mcp_servers.t3-tab]
command = "/old/node"
args = ["/old/cli.js", "mcp"]

[mcp_servers.t3-tab.env]
OLD = "yes"

# after
[last]
value = 2
`;

    const updated = addCodexServer(source, command);

    expect(updated).toBe(`# before
[first]
value = 1

${codexEntry}
# after
[last]
value = 2
`);
  });

  it('removes only its table and nested tables', () => {
    const source = addCodexServer(codexFixture, command);
    const nested = source.replace(
      '\n[ui]',
      '\n[mcp_servers.t3-tab.env]\nOLD = "yes"\n\n[ui]',
    );

    expect(removeCodexServer(nested)).toBe(codexFixture);
  });

  it('escapes paths as TOML strings', () => {
    const updated = addCodexServer('', {
      command: '/path/with "quotes"/node',
      args: ['/path/with \\ backslash/cli.js', 'mcp'],
    });

    expect(updated).toContain('command = "/path/with \\"quotes\\"/node"');
    expect(updated).toContain('args = ["/path/with \\\\ backslash/cli.js", "mcp"]');
  });

  it('escapes ASCII DEL so the generated TOML parses with smol-toml', () => {
    const updated = addCodexServer('', {
      command: '/path/with\u007fdel/node',
      args: ['/path/with\u007fdel/cli.js', 'mcp'],
    });

    expect(parseToml(updated)).toEqual({
      mcp_servers: {
        't3-tab': {
          command: '/path/with\u007fdel/node',
          args: ['/path/with\u007fdel/cli.js', 'mcp'],
        },
      },
    });
  });
});
