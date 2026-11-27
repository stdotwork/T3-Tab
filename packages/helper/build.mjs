// Bundles the server (daemon, native host, MCP server and the setup command) with all its dependencies into one file,
// `dist/cli.js`. That file is the whole npm package: `setup` copies it into the user's own folder, so nothing depends on
// the npx cache, a checkout or node_modules afterwards.
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
const out = join(here, 'dist', 'cli.js');

const bundle = await rolldown({
  input: join(here, '..', 'server', 'src', 'cli.ts'),
  platform: 'node',
  logLevel: 'warn',
  resolve: {
    alias: { '@t3-tab/protocol': join(here, '..', 'protocol', 'src', 'index.ts') },
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
  transform: { target: 'node20', define: { __T3_TAB_VERSION__: JSON.stringify(version) } },
});
await mkdir(dirname(out), { recursive: true });
await bundle.write({
  file: out,
  format: 'esm',
  // Some dependencies are CommonJS and call require().
  banner: "import { createRequire as __t3tabCreateRequire } from 'node:module';\nconst require = __t3tabCreateRequire(import.meta.url);",
  minify: false,
  sourcemap: false,
});
await chmod(out, 0o755);
console.log(`t3-tab ${version}: wrote ${out}`);
