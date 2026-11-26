import { describe, expect, it } from 'vitest';

import { CONNECT_T3_BY_ITSELF, shouldConnectByItself } from '../entrypoints/sidepanel/lib/t3-connect';

const when = (input: Partial<Parameters<typeof shouldConnectByItself>[0]>): boolean =>
  shouldConnectByItself({ enabled: true, found: 'running', status: 'off', tried: false, ...input });

describe('connecting to T3 Code without a click', () => {
  it('is off until the owner decides it, so the panel waits for Connect', () => {
    expect(CONNECT_T3_BY_ITSELF).toBe(false);
    expect(when({ enabled: CONNECT_T3_BY_ITSELF })).toBe(false);
  });

  it('when on, connects once T3 is found running and the panel holds no session', () => {
    expect(when({})).toBe(true);
  });

  it('when on, does not connect to a T3 that is stopped, missing or not checked yet', () => {
    expect(when({ found: 'stopped' })).toBe(false);
    expect(when({ found: 'missing' })).toBe(false);
    expect(when({ found: undefined })).toBe(false);
  });

  it('when on, leaves a session that is connected, connecting or reconnecting alone', () => {
    expect(when({ status: 'ready' })).toBe(false);
    expect(when({ status: 'connecting' })).toBe(false);
    expect(when({ status: 'lost' })).toBe(false);
  });

  it('when on, tries only once per panel, so a failed pairing or a Disconnect is not retried in a loop', () => {
    expect(when({ tried: true })).toBe(false);
  });
});
