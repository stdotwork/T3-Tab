// Plumbing for the head-to-head benchmark: an MCP client over stdio, a headless Chromium that is only
// reachable over its debugging port (so no tool shares a browser with another and the harness can read the
// page state independently of whatever the tool says), and the end-state probe.
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';

import { jpegSize, sleep } from '../../e2e/harness.mjs';

const execFileAsync = promisify(execFile);

/** One MCP server on stdio. `env` replaces the child's environment on top of the caller's. */
export async function connectServer({ command, args, env, cwd }) {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    env: { ...process.env, ...env },
    stderr: 'pipe',
  });
  const stderr = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: 't3-tab-compare', version: '1.0.0' });
  await client.connect(transport, { timeout: 120_000 });
  return { client, stderr };
}

/** Pixel size of a PNG (its IHDR chunk), a JPEG, or a WebP (VP8 or VP8L lossy/lossless header). */
export function imageSize(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  const jpeg = jpegSize(bytes);
  if (jpeg !== undefined) return jpeg;
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return undefined;
}

/** Headless Chromium that only opens a debugging port; nothing attaches to it but the tool under test. */
export async function launchChromium({ profileDir, env }) {
  const browser = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      // The same window the T3-Tab run uses, so every tool sees the same viewport.
      '--window-size=1600,1000',
      'about:blank',
    ],
    { env, stdio: 'ignore' },
  );
  const close = async () => {
    if (browser.exitCode !== null) return;
    const exited = new Promise((resolve) => browser.once('exit', resolve));
    browser.kill('SIGTERM');
    await Promise.race([exited, sleep(3_000)]);
    if (browser.exitCode === null) browser.kill('SIGKILL');
  };
  try {
    let port;
    for (let attempt = 0; attempt < 150 && port === undefined; attempt += 1) {
      port = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8').then(
        (content) => content.split('\n')[0],
        () => undefined,
      );
      if (port === undefined) await sleep(100);
    }
    if (port === undefined) throw new Error('Chromium did not report a debugging port');
    return { port: Number(port), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** What the harness reads from a page to decide whether a task reached its end state. */
export const STATE_EXPRESSION = `(() => ({
  path: location.pathname,
  result: [...document.querySelectorAll('main p')].map((p) => p.textContent).find((t) => t.startsWith('Welcome ')) ?? null,
  country: document.querySelector('select[name=country]')?.value ?? null,
  detailsHidden: document.getElementById('details')?.hidden ?? null,
}))()`;

/** The state of every page of a browser whose URL is on `site`, read over a short-lived CDP connection each. */
export async function pageStates(port, site) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const states = [];
  for (const target of targets) {
    if (target.type !== 'page' || !target.url.startsWith(site)) continue;
    states.push(await evaluateOver(target.webSocketDebuggerUrl, STATE_EXPRESSION).catch(() => undefined));
  }
  return states.filter((state) => state !== undefined);
}

async function evaluateOver(url, expression) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`Could not connect to ${url}`));
  });
  try {
    return await new Promise((resolve, reject) => {
      socket.onmessage = (message) => {
        const reply = JSON.parse(message.data);
        if (reply.id !== 1) return;
        if (reply.result?.exceptionDetails !== undefined) reject(new Error(reply.result.exceptionDetails.text));
        else resolve(reply.result?.result?.value);
      };
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally {
    socket.close();
  }
}

/** Process ids whose command line contains `fragment`. */
export async function pidsMatching(fragment) {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args=']);
  return stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null && match[2].includes(fragment) && Number(match[1]) !== process.pid)
    .map((match) => Number(match[1]));
}

/** The process id listening on a loopback TCP port, if any. */
export async function listenerOf(port) {
  const { stdout } = await execFileAsync('ss', ['-ltnpH', `sport = :${port}`]).catch(() => ({ stdout: '' }));
  const match = /pid=(\d+)/.exec(stdout);
  return match === null ? undefined : Number(match[1]);
}

export function kill(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/** Group 1 of `pattern` in `text`, or a failure that shows the text: a scripted call needs what an earlier reply named. */
export function grab(text, pattern, what) {
  const match = pattern.exec(text);
  if (match === null) throw new Error(`Could not find ${what ?? pattern} in:\n${text.slice(0, 1500)}`);
  return match[1];
}
