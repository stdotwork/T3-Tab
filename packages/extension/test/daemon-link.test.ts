import { PROTOCOL_MISMATCH, PROTOCOL_VERSION } from '@t3-tab/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  askDaemon,
  daemonLinkState,
  noteDaemonClose,
  noteDaemonProblem,
  sendPromptNotice,
  setDaemonConnector,
  setDaemonSocket,
} from '../src/daemon-link';

afterEach(() => {
  setDaemonSocket(undefined);
  noteDaemonClose(1000, '');
  setDaemonConnector(() => undefined);
});

/** A socket that is open and records what is sent. */
function openSocket(): { socket: WebSocket; sent: string[] } {
  const sent: string[] = [];
  return { socket: { readyState: WebSocket.OPEN, send: (data: string) => void sent.push(data) } as unknown as WebSocket, sent };
}

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

describe('the helper state the panel asks for', () => {
  it('is connected while the link is open', async () => {
    setDaemonSocket(openSocket().socket);
    expect(await daemonLinkState(0)).toEqual({ connected: true });
  });

  it('answers with no link at all, tries to connect, and says what is wrong', async () => {
    const connector = vi.fn();
    setDaemonConnector(connector);
    expect(await daemonLinkState(0)).toEqual({
      connected: false,
      error: 'T3-Tab is not connected to its background program. Run `t3-tab install`, then reopen the browser.',
    });
    expect(connector).toHaveBeenCalled();
    noteDaemonProblem(new Error('Specified native messaging host not found.'));
    expect(await daemonLinkState(0)).toEqual({ connected: false, error: 'Specified native messaging host not found.' });
  });

  it('flags a version mismatch, whether the link was closed for it or the native host reported it', async () => {
    noteDaemonClose(1008, PROTOCOL_MISMATCH);
    expect(await daemonLinkState(0)).toEqual({ connected: false, error: PROTOCOL_MISMATCH, protocolMismatch: true });
    noteDaemonClose(1000, '');
    noteDaemonProblem(new Error('Native host protocol mismatch'));
    expect(await daemonLinkState(0)).toEqual({ connected: false, error: PROTOCOL_MISMATCH, protocolMismatch: true });
  });

  it('forgets the problem once a link opens', async () => {
    noteDaemonProblem(new Error('Native host has exited.'));
    setDaemonSocket(openSocket().socket);
    setDaemonSocket(undefined);
    expect((await daemonLinkState(0)).error).toMatch(/not connected/);
  });
});

describe('telling the background program about a prompt', () => {
  const closed = { type: 'browser.promptClosed', protocolVersion: PROTOCOL_VERSION, promptId: 'p' } as const;

  it('sends it over the open link, and drops it when there is none', () => {
    const { socket, sent } = openSocket();
    setDaemonSocket(socket);
    sendPromptNotice(closed);
    expect(sent.map((message) => JSON.parse(message))).toEqual([closed]);
    setDaemonSocket(undefined);
    expect(() => sendPromptNotice(closed)).not.toThrow();
    expect(sent).toHaveLength(1);
  });
});
