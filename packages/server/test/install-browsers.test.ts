import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nativeHostBrowsers } from '../src/install.js';

let home: string;
const env = { PATH: '' };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 't3-tab-browsers-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('which browsers `native-host install` serves', () => {
  it('serves the one asked for, found or not', async () => {
    expect(await nativeHostBrowsers('brave', home, env)).toEqual({ browsers: ['brave'], found: true });
  });

  it('serves every browser found when none is asked for', async () => {
    await mkdir(join(home, '.config', 'google-chrome'), { recursive: true });
    await mkdir(join(home, '.config', 'BraveSoftware', 'Brave-Browser'), { recursive: true });
    expect(await nativeHostBrowsers(undefined, home, env)).toEqual({ browsers: ['chrome', 'brave'], found: true });
    await mkdir(join(home, '.config', 'chromium'), { recursive: true });
    expect((await nativeHostBrowsers(undefined, home, env)).browsers).toEqual(['chromium', 'chrome', 'brave']);
  });

  it('falls back to Chromium, and says none was found, when there is nothing to find', async () => {
    expect(await nativeHostBrowsers(undefined, home, env)).toEqual({ browsers: ['chromium'], found: false });
  });
});
