import { PROTOCOL_MISMATCH } from '@t3-tab/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { askDaemon, noteDaemonClose, setDaemonSocket } from '../src/daemon-link';

afterEach(() => {
  setDaemonSocket(undefined);
  noteDaemonClose(1000, '');
});

describe('a daemon of another protocol version', () => {
  it.each(['Invalid protocol message', PROTOCOL_MISMATCH])('tells the owner to update when it closes with %j', async (reason) => {
    noteDaemonClose(1008, reason);
    await expect(askDaemon('agents.list', {})).rejects.toThrow('different versions');
  });

  it('keeps the plain message for another kind of close', async () => {
    noteDaemonClose(1008, 'Invalid tab count');
    await expect(askDaemon('agents.list', {})).rejects.toThrow('not connected');
  }, 8_000);
});
