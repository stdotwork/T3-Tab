import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// An older T3-Tab kept a read-only T3 sign-in token in this file, written through a temporary copy named like the second.
const CREDENTIAL_FILE = 't3-credential.json';
const TEMPORARY_FILE = /^t3-credential\.json\.[0-9a-f]{16}\.tmp$/;

/**
 * Deletes what that older sign-in left in the state folder: the token file and any temporary copy a crash left. Nothing
 * reads them any more. Only regular files directly in the folder with exactly those names are touched. Best effort: a
 * file that cannot be deleted is skipped, and the number deleted is returned.
 */
export async function removeStaleT3Credentials(stateDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return 0;
  }
  const stale = names.filter((name) => name === CREDENTIAL_FILE || TEMPORARY_FILE.test(name));
  const removed = await Promise.all(
    stale.map(async (name) => {
      const path = join(stateDir, name);
      try {
        if (!(await lstat(path)).isFile()) return false;
        await unlink(path);
        return true;
      } catch {
        return false;
      }
    }),
  );
  return removed.filter(Boolean).length;
}
