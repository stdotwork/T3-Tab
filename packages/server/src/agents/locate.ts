import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Finds the agent CLIs the side panel can run. The daemon is often started by the browser's native host, whose
 * PATH is the desktop session's and may lack the folders a terminal adds, so a few usual install folders are
 * searched after PATH.
 */
export async function findExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of [...pathDirectories(env), ...usualDirectories(env)]) {
    const candidate = join(directory, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Finds the `t3` command. In order: `T3_TAB_T3` when set, `t3` on PATH or in the usual folders, the launchers T3
 * records in `<T3 home>/runtime/launchers`, `<T3 home>/runtime/bin/t3`, the desktop app's `<T3 home>/bin/t3`, and
 * the newest fully installed `<T3 home>/runtime/versions/<v>/t3`.
 * The T3 home is `T3CODE_HOME`, or `~/.t3`. Only these paths are read, never T3's data or settings.
 */
export async function findT3(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const override = env.T3_TAB_T3?.trim();
  if (override !== undefined && override !== '') return (await isExecutable(override)) ? override : undefined;
  const onPath = await findExecutable('t3', env);
  if (onPath !== undefined) return onPath;
  const runtime = join(t3Home(env), 'runtime');
  const launchers = await readFile(join(runtime, 'launchers'), 'utf8').catch(() => '');
  for (const launcher of launchers.split(/\r?\n/)) {
    if (isAbsolute(launcher) && (await isExecutable(launcher))) return launcher;
  }
  const bin = join(runtime, 'bin', 't3');
  if (await isExecutable(bin)) return bin;
  // T3 Code's desktop app writes its CLI launcher here.
  const desktop = join(t3Home(env), 'bin', 't3');
  if (await isExecutable(desktop)) return desktop;
  return await newestVersion(join(runtime, 'versions'));
}

/** T3 Code's home folder: `T3CODE_HOME`, or `~/.t3`. */
export function t3Home(env: NodeJS.ProcessEnv): string {
  return env.T3CODE_HOME?.trim() || join(homeOf(env), '.t3');
}

async function newestVersion(versionsDir: string): Promise<string | undefined> {
  const names = await readdir(versionsDir).catch(() => [] as string[]);
  const installed: Array<{ path: string; mtime: number; name: string }> = [];
  for (const name of names) {
    const path = join(versionsDir, name, 't3');
    if (!(await isExecutable(path))) continue;
    // A version still downloading has no marker yet.
    const marker = await stat(join(versionsDir, name, '.install-complete')).catch(() => undefined);
    if (marker !== undefined) installed.push({ path, mtime: marker.mtimeMs, name });
  }
  installed.sort((left, right) => compareVersions(right.name, left.name) || right.mtime - left.mtime);
  return installed[0]?.path;
}

/** Compares dotted versions such as `0.1.11-nightly.20261119.4928` part by part, numbers as numbers. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(/[.-]/);
  const b = right.split(/[.-]/);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? '';
    const y = b[index] ?? '';
    if (x === y) continue;
    const nx = /^\d+$/.test(x) ? Number(x) : undefined;
    const ny = /^\d+$/.test(y) ? Number(y) : undefined;
    if (nx !== undefined && ny !== undefined) return nx - ny;
    return x < y ? -1 : 1;
  }
  return 0;
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '').split(delimiter).filter((directory) => isAbsolute(directory));
}

function usualDirectories(env: NodeJS.ProcessEnv): string[] {
  const home = homeOf(env);
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'share', 'mise', 'shims'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ];
}

function homeOf(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim();
  return home === undefined || home === '' ? homedir() : home;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
