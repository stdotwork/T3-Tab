import { describe, expect, it } from 'vitest';

import { CONNECT_T3_BY_ITSELF, failureNote, shouldConnectByItself } from '../entrypoints/sidepanel/lib/t3-connect';

const when = (input: Partial<Parameters<typeof shouldConnectByItself>[0]>): boolean =>
  shouldConnectByItself({ enabled: true, found: 'running', status: 'off', tried: false, ...input });

describe('connecting to T3 Code without a click', () => {
  it('is on, so the panel connects without a click', () => {
    expect(CONNECT_T3_BY_ITSELF).toBe(true);
    expect(when({ enabled: CONNECT_T3_BY_ITSELF })).toBe(true);
  });

  it('connects once T3 is found running and the panel holds no session', () => {
    expect(when({})).toBe(true);
  });

  it('stays quiet if the switch is turned off', () => {
    expect(when({ enabled: false })).toBe(false);
  });

  it('does not connect to a T3 that is stopped, missing or not checked yet', () => {
    expect(when({ found: 'stopped' })).toBe(false);
    expect(when({ found: 'missing' })).toBe(false);
    expect(when({ found: undefined })).toBe(false);
  });

  it('leaves a session that is connected, connecting or reconnecting alone', () => {
    expect(when({ status: 'ready' })).toBe(false);
    expect(when({ status: 'connecting' })).toBe(false);
    expect(when({ status: 'lost' })).toBe(false);
  });

  it('tries only once per panel, so a failed pairing or a Disconnect is not retried in a loop', () => {
    expect(when({ tried: true })).toBe(false);
  });

  it('shows no error text for a failed attempt the owner did not ask for, and shows it for a click', () => {
    const message = 'Error: worker.evaluate: Error: fake t3 supports only `thread`';
    expect(failureNote({ automatic: true, message })).toBeUndefined();
    expect(failureNote({ automatic: false, message })).toBe(message);
  });
});
