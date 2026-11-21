import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { approveInBrowser, startFakeT3, type FakeT3 } from '../../../e2e/fakes/t3-server.mjs';

/** Holds every credential write at its start until the test lets it go, so a sign-out can land in the middle. */
const gate = { reached: undefined as (() => void) | undefined, release: undefined as (() => void) | undefined };
vi.mock('../src/agents/t3-credential.js', async (original) => {
  const actual = await original<typeof import('../src/agents/t3-credential.js')>();
  return {
    ...actual,
    writeCredential: async (...args: Parameters<typeof actual.writeCredential>) => {
      gate.reached?.();
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      await actual.writeCredential(...args);
    },
  };
});

const { T3Access } = await import('../src/agents/t3-access.js');
const { credentialPath } = await import('../src/agents/t3-credential.js');
const { t3EnvironmentAt } = await import('../src/agents/t3-environment.js');

let fake: FakeT3 | undefined;
let directory: string | undefined;

afterEach(async () => {
  await fake?.close();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

describe('sign-out during a sign-in', () => {
  it('leaves no credential when the owner signs out while the sign-in is being written', async () => {
    fake = await startFakeT3();
    directory = await mkdtemp(join(tmpdir(), 't3-tab-signout-race-'));
    const origin = fake.origin;
    const access = new T3Access({
      env: {},
      stateDir: directory,
      findEnvironment: async () => t3EnvironmentAt(origin, { pid: process.pid, startedAt: Date.now() }),
    });
    try {
      const writing = new Promise<void>((resolve) => {
        gate.reached = resolve;
      });
      const approving = approveInBrowser((await access.signIn()).url, 'read-only');
      await writing;
      const signingOut = access.signOut();
      // Let the sign-out run as far as it can before the write goes on.
      await new Promise((resolve) => setTimeout(resolve, 50));
      gate.release?.();
      await approving;
      await signingOut;
      await expect(stat(credentialPath(directory))).rejects.toThrow();
      expect((await access.view()).state).toBe('signed-out');
    } finally {
      access.close();
    }
  });
});
