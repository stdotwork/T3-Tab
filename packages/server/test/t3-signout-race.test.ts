import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { approveInBrowser, startFakeT3, type FakeT3 } from '../../../e2e/fakes/t3-server.mjs';
import type { T3Environment } from '../src/agents/t3-environment.js';

/** Lets a test hold a credential write at its start, and tells it when a sign-out's delete has run. */
const files = {
  holdWrite: undefined as Promise<void> | undefined,
  writeReached: undefined as (() => void) | undefined,
  deleted: undefined as (() => void) | undefined,
};
vi.mock('../src/agents/t3-credential.js', async (original) => {
  const actual = await original<typeof import('../src/agents/t3-credential.js')>();
  return {
    ...actual,
    writeCredential: async (...args: Parameters<typeof actual.writeCredential>) => {
      files.writeReached?.();
      await files.holdWrite;
      await actual.writeCredential(...args);
    },
    deleteCredential: async (...args: Parameters<typeof actual.deleteCredential>) => {
      await actual.deleteCredential(...args);
      files.deleted?.();
    },
  };
});

const { T3Access } = await import('../src/agents/t3-access.js');
const { credentialPath } = await import('../src/agents/t3-credential.js');
const { t3EnvironmentAt } = await import('../src/agents/t3-environment.js');

let fake: FakeT3 | undefined;
let directory: string | undefined;
let access: InstanceType<typeof T3Access> | undefined;

afterEach(async () => {
  access?.close();
  access = undefined;
  files.holdWrite = undefined;
  files.writeReached = undefined;
  files.deleted = undefined;
  await fake?.close();
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

function signal(): { promise: Promise<void>; fire: () => void } {
  let fire: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

/** A sign-in against the fake T3. `onRequest` runs after each answer from T3 and may hold it back. */
async function start(
  onRequest: (url: string, init: RequestInit | undefined) => Promise<void> = async () => undefined,
  beforeFind: () => Promise<void> = async () => undefined,
): Promise<{ access: InstanceType<typeof T3Access>; stateDir: string }> {
  fake = await startFakeT3();
  directory = await mkdtemp(join(tmpdir(), 't3-tab-signout-race-'));
  const origin = fake.origin;
  const findEnvironment = async (): Promise<T3Environment> => {
    await beforeFind();
    const environment = t3EnvironmentAt(origin, { pid: process.pid, startedAt: Date.now() });
    return {
      ...environment,
      fetch: async (url, init) => {
        const response = await environment.fetch(url, init);
        await onRequest(String(url), init);
        return response;
      },
    };
  };
  access = new T3Access({ env: {}, stateDir: directory, findEnvironment });
  return { access, stateDir: directory };
}

async function expectNoCredential(current: InstanceType<typeof T3Access>, stateDir: string): Promise<void> {
  await expect(stat(credentialPath(stateDir))).rejects.toThrow('ENOENT');
  expect((await current.view()).state).toBe('signed-out');
}

describe('sign-out during a sign-in', () => {
  it('deletes the credential after a write that was already under way', async () => {
    const { access: current, stateDir } = await start();
    const reached = signal();
    const release = signal();
    const deleted = signal();
    files.writeReached = reached.fire;
    files.holdWrite = release.promise;
    files.deleted = deleted.fire;

    const approving = approveInBrowser((await current.signIn()).url, 'read-only');
    await reached.promise;
    const signingOut = current.signOut();
    // The delete must wait for the write. On correct code this bound always runs out; it can never fail the test falsely.
    const deletedEarly = await Promise.race([
      deleted.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(deletedEarly).toBe(false);
    release.fire();
    await deleted.promise;
    await approving;
    await signingOut;

    await expectNoCredential(current, stateDir);
  });

  it('writes nothing when the sign-out finished while T3 was answering with the token', async () => {
    const tokenAnswered = signal();
    const release = signal();
    const { access: current, stateDir } = await start(async (url) => {
      if (!url.endsWith('/oauth/mcp/token')) return;
      tokenAnswered.fire();
      await release.promise;
    });
    const deleted = signal();
    files.deleted = deleted.fire;

    const approving = approveInBrowser((await current.signIn()).url, 'read-only');
    await tokenAnswered.promise;
    await current.signOut();
    await deleted.promise;
    release.fire();
    const landed = await approving;

    expect(landed.status).toBe(400);
    await expectNoCredential(current, stateDir);
  });

  it.each(['finding T3', 'discovery', 'registration'] as const)('keeps nothing when the owner signs out during %s', async (step) => {
    const blocked = signal();
    const release = signal();
    let redirectUri: string | undefined;
    const hold = async (): Promise<void> => {
      blocked.fire();
      await release.promise;
    };
    const { access: current, stateDir } = await start(
      async (url, init) => {
        if (step === 'discovery' && url.endsWith('/.well-known/oauth-protected-resource/mcp')) await hold();
        if (step === 'registration' && url.endsWith('/oauth/mcp/register')) {
          redirectUri = (JSON.parse(init?.body as string) as { redirect_uris: string[] }).redirect_uris[0];
          await hold();
        }
      },
      async () => {
        if (step === 'finding T3') await hold();
      },
    );

    const signingIn = current.signIn();
    await blocked.promise;
    await current.signOut();
    release.fire();

    // Whatever the sign-in answers, the owner going on to approve it must not bring the credential back.
    const outcome = await signingIn.then(
      (value) => value,
      (error: unknown) => error as Error,
    );
    if (!(outcome instanceof Error)) await approveInBrowser(outcome.url, 'read-only');

    await expectNoCredential(current, stateDir);
    // A cancelled sign-in gives the panel no approval page to open and leaves no listener behind.
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('This sign-in was replaced or cancelled.');
    if (redirectUri !== undefined) await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it('lets a newer sign-in finish when it replaces one still being set up', async () => {
    const blocked = signal();
    const release = signal();
    let finds = 0;
    const { access: current, stateDir } = await start(undefined, async () => {
      finds += 1;
      if (finds > 1) return;
      blocked.fire();
      await release.promise;
    });

    const replaced = current.signIn();
    await blocked.promise;
    const { url } = await current.signIn();
    release.fire();

    await expect(replaced).rejects.toThrow('This sign-in was replaced or cancelled.');
    expect((await approveInBrowser(url, 'read-only')).status).toBe(200);
    expect((await stat(credentialPath(stateDir))).isFile()).toBe(true);
    expect((await current.view()).state).toBe('signed-in');
  });
});
