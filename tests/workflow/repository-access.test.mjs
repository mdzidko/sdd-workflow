import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fails, initialize, repository, succeeds } from './helpers.mjs';

test('search returns bounded source-linked matches and read retrieves selected lines at the same revision', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await repo.write(
    'src/people.mjs',
    'export const personName = "Anna";\nexport const personAge = 30;\n// person lookup\n',
  );
  repo.git('add', 'src/people.mjs');
  repo.git('commit', '-m', 'Add source context fixture');
  const searched = succeeds(
    await repo.run('repo.search', { query: 'person', limit: 2 }),
    'repo.search',
  );
  assert.equal(searched.matches.length, 2);
  assert.equal(searched.truncated, true);
  assert.equal(searched.revision, repo.git('rev-parse', 'HEAD'));
  for (const match of searched.matches) {
    assert.equal(match.path.replaceAll('\\', '/'), 'src/people.mjs');
    assert.ok(Number.isInteger(match.line) && match.line > 0);
    assert.match(match.text, /person/);
  }

  const selected = succeeds(
    await repo.run('repo.read', {
      path: 'src/people.mjs',
      start_line: 2,
      end_line: 2,
      max_chars: 100,
    }),
    'repo.read',
  );
  assert.equal(selected.content.trim(), 'export const personAge = 30;');
  assert.equal(selected.start_line, 2);
  assert.equal(selected.end_line, 2);
  assert.equal(selected.revision, searched.revision);
});

test('repository reads reject traversal, absolute paths, and protected workflow state', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  for (const unsafePath of [
    '../outside.txt',
    path.resolve(repo.projectRoot, '..', 'outside.txt'),
    '.workflow/state.json',
    '.git/config',
  ]) {
    fails(await repo.run('repo.read', { path: unsafePath }), 'repo.read');
  }
});

test('search and read do not expose secret files or environment credentials', async (t) => {
  const secret = 'workflow-test-secret-9f0c1d';
  const repo = await repository(t, { context: { env: { ...process.env, GH_TOKEN: secret } } });
  await initialize(repo);
  await repo.write('.env', `API_TOKEN=${secret}\n`);
  fails(await repo.run('repo.read', { path: '.env' }), 'repo.read');
  const searched = await repo.run('repo.search', { query: secret });
  succeeds(searched, 'repo.search');
  assert.equal(JSON.stringify(searched).includes(secret), false);
  assert.equal(JSON.stringify(await repo.run('workflow.inspect')).includes(secret), false);
});

test('repository reads and searches cannot follow a directory link outside the project', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const outside = await mkdtemp(path.join(tmpdir(), 'workflow-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'private.txt'), 'outside-only-content');
  try {
    await symlink(
      outside,
      path.join(repo.projectRoot, 'linked-outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`Host cannot create the fixture directory link: ${error.code}`);
      return;
    }
    throw error;
  }
  fails(await repo.run('repo.read', { path: 'linked-outside/private.txt' }), 'repo.read');
  const searched = succeeds(
    await repo.run('repo.search', { query: 'outside-only-content' }),
    'repo.search',
  );
  assert.deepEqual(searched.matches, []);
});
