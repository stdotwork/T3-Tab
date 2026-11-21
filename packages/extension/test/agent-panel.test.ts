import type { AgentsStatus } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import { accessText, choice, defaultVia, shareLine, statusLine } from '../entrypoints/sidepanel/agent';

const running: AgentsStatus = { t3: { state: 'running' } };

describe('defaultVia', () => {
  it('prefers a running T3, then Claude Code, then Codex, then T3', () => {
    expect(defaultVia({ t3: { state: 'running' }, claude: '/c', codex: '/x' })).toBe('t3');
    expect(defaultVia({ t3: { state: 'stopped' }, claude: '/c', codex: '/x' })).toBe('claude');
    expect(defaultVia({ t3: { state: 'missing' }, codex: '/x' })).toBe('codex');
    expect(defaultVia({ t3: { state: 'missing' } })).toBe('t3');
  });
});

describe('statusLine', () => {
  it('says T3 is running', () => {
    expect(statusLine(running, 't3')).toBe('T3 Code is running.');
  });

  it('offers the direct CLIs that exist when T3 is not usable', () => {
    expect(statusLine({ t3: { state: 'missing' }, claude: '/c', codex: '/x' }, 't3')).toBe(
      'T3 Code was not found. You can run Claude Code or Codex directly instead.',
    );
    expect(statusLine({ t3: { state: 'stopped' }, codex: '/x' }, 't3')).toBe('T3 Code is not running. You can run Codex directly instead.');
    expect(statusLine({ t3: { state: 'stopped' } }, 't3')).toBe('T3 Code is not running.');
  });

  it('shows the error detail, or a fallback', () => {
    expect(statusLine({ t3: { state: 'error', detail: 'boom' } }, 't3')).toBe('T3 Code did not answer: boom.');
    expect(statusLine({ t3: { state: 'error' } }, 't3')).toBe('T3 Code did not answer: unknown error.');
  });

  it('adds a note when the chosen direct CLI is missing', () => {
    expect(statusLine(running, 'claude')).toBe('T3 Code is running. Claude Code was not found on this machine.');
    expect(statusLine({ ...running, codex: '/x' }, 'codex')).toBe('T3 Code is running.');
  });
});

describe('shareLine', () => {
  it('describes none, one, and several tabs', () => {
    expect(shareLine([])).toBe('No current tab to share.');
    expect(shareLine([{ id: 4, title: 'Home' } as never])).toBe('Shares tab 4 "Home"');
    expect(shareLine([{ id: 4, title: '' } as never])).toBe('Shares tab 4 "(untitled)"');
    expect(shareLine([{ id: 4, title: 'A' }, { id: 5, title: 'B' }] as never)).toBe('Shares 2 tabs of this tab group, starting with tab 4 "A"');
  });
});

describe('accessText', () => {
  it('offers the sign-in, and passes on why the lists are missing', () => {
    expect(accessText({ state: 'signed-out' })).toBe(
      'Sign in to T3 Code once to pick projects and models from its lists. T3-Tab asks for read-only access.',
    );
    expect(accessText({ state: 'signed-out', detail: 'The sign-in was declined in T3 Code.' })).toBe(
      'The sign-in was declined in T3 Code. Sign in to T3 Code once to pick projects and models from its lists. T3-Tab asks for read-only access.',
    );
    expect(accessText({ state: 'signing-in', environment: 'http://127.0.0.1:3773' })).toBe(
      'Approve T3-Tab in the T3 Code tab that opened, and choose Read only.',
    );
  });

  it('says where T3-Tab is signed in, until when, and what the lists hold', () => {
    const catalog = {
      projects: [{ id: 'p1', title: 'Demo', workspaceRoot: '/w' }],
      providers: [{ instanceId: 'claudeAgent', name: 'Claude', models: [{ id: 'a' }, { id: 'b' }] }],
      fetchedAt: 1,
    };
    expect(accessText({ state: 'signed-in', environment: 'http://127.0.0.1:3773', expiresAt: Date.UTC(2026, 11, 21), catalog })).toBe(
      'Signed in to T3 Code at http://127.0.0.1:3773 (read only) until 2026-12-21. 1 projects, 2 models listed.',
    );
    expect(accessText({ state: 'signed-in', detail: 'T3 Code is not running. Type the project and model instead.' })).toBe(
      'Signed in to T3 Code (read only). T3 Code is not running. Type the project and model instead.',
    );
  });
});

describe('choice', () => {
  it('reads a project id and a provider instance with its model from the list values', () => {
    expect(choice('p:proj-demo', `m:${JSON.stringify(['claudeAgent', 'claude-haiku-5-5'])}`)).toEqual({
      project: 'proj-demo',
      provider: 'claudeAgent',
      model: 'claude-haiku-5-5',
    });
  });

  it('gives neither provider nor model for the project default or a typed entry', () => {
    expect(choice('p:x', 'default')).toEqual({ project: 'x' });
    expect(choice('typed', 'typed')).toEqual({});
    expect(choice('p:x', 'm:not json')).toEqual({ project: 'x' });
  });
});
