import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type ServerHandle } from '../src/index.js';

let server: ServerHandle | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
});

describe('background server', () => {
  it('serves a response on a loopback port and closes cleanly', async () => {
    server = await startServer();

    expect(new URL(server.url).hostname).toBe('127.0.0.1');
    const response = await fetch(server.url);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    await server.close();
    server = undefined;
  });
});
