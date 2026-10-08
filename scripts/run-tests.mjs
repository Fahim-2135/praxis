// Node 20 does not expand globs in `node --test`, so list the files here.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('test', { recursive: true })
  .map((f) => String(f).split(String.fromCharCode(92)).join('/'))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => `test/${f}`);
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
