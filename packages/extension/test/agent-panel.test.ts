import type { AgentsStatus } from '@t3-tab/protocol';
import { describe, expect, it } from 'vitest';

import { defaultVia, shareLine, statusLine } from '../entrypoints/sidepanel/agent';

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
