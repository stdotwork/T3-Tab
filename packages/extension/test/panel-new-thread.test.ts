import { describe, expect, it } from 'vitest';

import { compactModelName } from '../entrypoints/sidepanel/lib/model-short-name';
import { LAST_PROJECT, NO_PROJECT, pickableProjects, resolveProject } from '../entrypoints/sidepanel/lib/new-thread';
import type { Project } from '../entrypoints/sidepanel/lib/t3-client';

const alpha: Project = { id: 'alpha', title: 'Alpha', workspaceRoot: '/work/alpha' };
const beta: Project = { id: 'beta', title: 'Beta', workspaceRoot: '/work/beta' };
const scratch: Project = { id: 'scratch', title: 'Scratch', workspaceRoot: '/t3/scratch' };

const resolve = (input: Partial<Parameters<typeof resolveProject>[0]>): Project | undefined =>
  resolveProject({ projects: [alpha, beta], tabChoice: undefined, defaultProject: NO_PROJECT, lastProject: undefined, noProjectAvailable: true, ...input });

describe('the project a new thread starts in', () => {
  it('starts a new tab in no project by default, even with a project used before', () => {
    expect(resolve({ lastProject: 'alpha' })).toBeUndefined();
  });

  it('follows the default the owner set', () => {
    expect(resolve({ defaultProject: 'beta' })).toBe(beta);
    expect(resolve({ defaultProject: LAST_PROJECT, lastProject: 'alpha' })).toBe(alpha);
    expect(resolve({ defaultProject: LAST_PROJECT })).toBeUndefined();
  });

  it("keeps this tab's own pick over the default, including no project", () => {
    expect(resolve({ tabChoice: 'beta', defaultProject: 'alpha' })).toBe(beta);
    expect(resolve({ tabChoice: NO_PROJECT, defaultProject: 'alpha' })).toBeUndefined();
  });

  it('treats a removed project as no project', () => {
    expect(resolve({ tabChoice: 'gone' })).toBeUndefined();
  });

  it('uses the first project when this T3 has no Scratch project', () => {
    expect(resolve({ noProjectAvailable: false })).toBe(alpha);
    expect(resolve({ noProjectAvailable: false, projects: [] })).toBeUndefined();
  });

  it("lists T3's Scratch project only as the no-project row", () => {
    expect(pickableProjects([alpha, scratch], '/t3/scratch')).toEqual([alpha]);
    expect(pickableProjects([alpha, scratch], undefined)).toEqual([alpha, scratch]);
  });
});

describe('compact model names', () => {
  it("prefers T3's own short name", () => {
    expect(compactModelName({ name: 'Claude Opus 5.5', shortName: 'Opus 5.5' }, 'claudeAgent')).toBe('Opus 5.5');
  });

  it('drops the family the logo already shows', () => {
    expect(compactModelName({ name: 'Claude Haiku 5.5' }, 'claudeAgent')).toBe('Haiku 5.5');
    expect(compactModelName({ name: 'Gemini 3.8 Flash' }, 'antigravity')).toBe('3.8 Flash');
    expect(compactModelName({ name: 'GPT-5.2-Codex' }, 'codex')).toBe('5.2 Codex');
  });

  it('keeps the family where the logo does not show it', () => {
    expect(compactModelName({ name: 'Gemini 3.8 Flash' }, 'opencode')).toBe('Gemini 3.8 Flash');
  });

  it('drops a vendor prefix', () => {
    expect(compactModelName({ name: 'Anthropic: Claude Sonnet 5.5' }, 'opencode')).toBe('Sonnet 5.5');
  });
});
