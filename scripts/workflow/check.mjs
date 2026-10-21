import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const ignored = new Set(['.git', '.workflow', '.workflow-runtime', 'node_modules']);
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else files.push(target);
  }
}
await walk(root);
let failed = false;
for (const file of files) {
  if (file.endsWith('.mjs')) {
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (checked.status !== 0) {
      console.error(checked.stderr || checked.error?.message);
      failed = true;
    }
  }
  if (file.endsWith('.json')) {
    try {
      JSON.parse(await readFile(file, 'utf8'));
    } catch {
      console.error(`Invalid JSON: ${path.relative(root, file)}`);
      failed = true;
    }
  }
}
console.log(JSON.stringify({ ok: !failed, files_checked: files.length }));
process.exitCode = failed ? 1 : 0;
