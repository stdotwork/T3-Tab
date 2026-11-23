import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { helpFor } from '../src/help.js';

const COMMANDS = ['setup', 'uninstall', 'install', 'daemon', 'native-host', 'mcp', 'version'];

describe('t3-tab --help', () => {
  it('prints the command list for --help, -h and help, and for none of the other top-level words', () => {
    const top = helpFor(['--help']);
    expect(top).toContain('Usage: t3-tab <command>');
    for (const command of COMMANDS.filter((name) => name !== 'install')) expect(top).toContain(`  ${command} `);
    expect(helpFor(['-h'])).toBe(top);
    expect(helpFor(['help'])).toBe(top);
    expect(helpFor([])).toBeUndefined();
    expect(helpFor(['--version'])).toBeUndefined();
    expect(helpFor(['frobnicate'])).toBeUndefined();
  });

  it('prints each command its own usage, by --help, -h or `help <command>`', () => {
    for (const command of COMMANDS) {
      const own = helpFor([command, '--help']);
      expect(own, command).toMatch(new RegExp(`^Usage: t3-tab ${command}\\b`));
      expect(helpFor([command, '-h'])).toBe(own);
      expect(helpFor(['help', command])).toBe(own);
    }
    expect(helpFor(['native-host', 'install', '--help'])).toBe(helpFor(['native-host', '--help']));
    expect(helpFor(['help', 'frobnicate'])).toBeUndefined();
    expect(helpFor(['help', 'constructor'])).toBeUndefined();
  });

  it('names what setup needs when no browser is found, and every browser it accepts', () => {
    const setup = helpFor(['setup', '--help']);
    expect(setup).toContain('--browser <chromium|chrome|brave|edge|vivaldi>');
    expect(setup).toContain('--user-data-dir <folder>');
    expect(setup).toContain('Exits 1 when no browser link was written');
  });

  it('leaves real arguments alone', () => {
    expect(helpFor(['setup', '--print'])).toBeUndefined();
    expect(helpFor(['mcp', '--claim-file', '/tmp/x'])).toBeUndefined();
    expect(helpFor(['uninstall', '--claude'])).toBeUndefined();
  });

  it('imports nothing, so asking for help loads no other part of the program', async () => {
    const source = await readFile(new URL('../src/help.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\b|\brequire\(|\bimport\(/m);
  });
});
