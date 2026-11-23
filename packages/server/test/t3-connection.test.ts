import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { confirmedFetch } from '../src/agents/t3-connection.js';

describe('the checked connection to T3', () => {
  async function listening(host: string, handler: Parameters<typeof createServer>[1]): Promise<{ port: number; close(): Promise<void> }> {
    const server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('The test server has no TCP address');
    return {
      port: address.port,
      close: async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  /** A real separate process listening on loopback, so its start time in `/proc` is the moment it was spawned. */
  async function serverProcess(): Promise<{ pid: number; origin: string; requests(): number; stop(): void }> {
    const script =
      "require('http').createServer((q,r)=>{process.stdout.write('request\\n');r.end('answered')})" +
      ".listen(0,'127.0.0.1',function(){process.stdout.write('port '+this.address().port+'\\n')})";
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    const port = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const found = /^port (\d+)$/m.exec(output);
        if (found !== null) resolve(Number(found[1]));
      });
    });
    return {
      pid: child.pid as number,
      origin: `http://127.0.0.1:${port}`,
      requests: () => output.split('\n').filter((line) => line === 'request').length,
      stop: () => child.kill('SIGKILL'),
    };
  }

  it('sends nothing to a process that started 1.5 seconds after the recorded start', async () => {
    // Above the at most 1.01 s by which the start time read from /proc can come out early.
    const recorded = Date.now() - 1_500;
    const server = await serverProcess();
    try {
      const send = confirmedFetch(server.origin, { pid: server.pid, startedAt: recorded });
      await expect(send(`${server.origin}/check`)).rejects.toThrow('could not confirm');
      expect(server.requests()).toBe(0);
    } finally {
      server.stop();
    }
  });

  it('accepts a process whose record was written right after it started', async () => {
    const server = await serverProcess();
    try {
      const response = await confirmedFetch(server.origin, { pid: server.pid, startedAt: Date.now() })(`${server.origin}/check`);
      expect(await response.text()).toBe('answered');
      expect(server.requests()).toBe(1);
    } finally {
      server.stop();
    }
  });

  // T3 with no host set listens on every address and records 127.0.0.1, so its side of the connection is IPv4-mapped.
  it.each([
    ['every address, reached over 127.0.0.1', '::', 'http://127.0.0.1'],
    ['the IPv6 loopback address', '::1', 'http://[::1]'],
    ['127.0.0.1, reached as localhost', '127.0.0.1', 'http://localhost'],
  ])('accepts this process listening on %s', async (_name, host, base) => {
    const server = await listening(host, (_request, response) => response.end('answered'));
    try {
      const origin = `${base}:${server.port}`;
      const response = await confirmedFetch(origin, { pid: process.pid, startedAt: Date.now() })(`${origin}/check`);
      expect(await response.text()).toBe('answered');
    } finally {
      await server.close();
    }
  });

  it('refuses a redirect and another origin', async () => {
    let requests = 0;
    const elsewhere = await listening('127.0.0.1', (_request, response) => {
      requests += 1;
      response.end('followed');
    });
    const server = await listening('127.0.0.1', (_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/stolen` });
      response.end();
    });
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const send = confirmedFetch(origin, { pid: process.pid, startedAt: Date.now() });
      await expect(send(`${origin}/mcp`, { headers: { authorization: 'Bearer generated-at-runtime' } })).rejects.toThrow('redirect');
      await expect(send(`http://127.0.0.1:${elsewhere.port}/mcp`)).rejects.toThrow('could not confirm');
      expect(requests).toBe(0);
    } finally {
      await server.close();
      await elsewhere.close();
    }
  });
});
