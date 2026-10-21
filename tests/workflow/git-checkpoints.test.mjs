import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fails, git, initialize, repository, startFeature, succeeds } from './helpers.mjs';

test('a task checkpoint commits only owned paths and preserves unrelated local edits', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  await repo.write('src/person.mjs', 'export const personName = "Anna";\n');
  await repo.write('README.md', '# Unrelated user edit\n');
  const baseSha = repo.git('rev-parse', 'HEAD');
  const checkpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-001',
      paths: ['src/person.mjs'],
      message: 'feat(F-001): store the person name',
      push: false,
      expected_sha: baseSha,
    }),
    'change.checkpoint',
  );
  assert.equal(checkpoint.commit_sha, repo.git('rev-parse', 'HEAD'));
  assert.notEqual(checkpoint.commit_sha, baseSha);
  assert.equal(
    repo.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'),
    'src/person.mjs',
  );
  assert.equal(repo.git('show', 'HEAD:README.md'), '# Example project');
  assert.equal(
    await readFile(path.join(repo.projectRoot, 'README.md'), 'utf8'),
    '# Unrelated user edit\n',
  );
});

test('a no-file task checkpoint does not create an empty commit', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  const before = repo.git('rev-parse', 'HEAD');
  const checkpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-REVIEW',
      paths: [],
      message: 'review(F-001): confirm the task scope',
      push: false,
    }),
    'change.checkpoint',
  );
  assert.equal(checkpoint.no_changes, true);
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
});

test('a checkpoint rejects a stale revision without staging or committing its paths', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  await repo.write('src/person.mjs', 'export const personName = "Anna";\n');
  const before = repo.git('rev-parse', 'HEAD');
  fails(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-001',
      paths: ['src/person.mjs'],
      message: 'feat(F-001): store a person',
      push: false,
      expected_sha: '0'.repeat(40),
    }),
    'change.checkpoint',
    'STALE_REVISION',
  );
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
  assert.equal(repo.git('diff', '--cached', '--name-only'), '');
});

test('checkpoint rejects an unrelated staged file instead of committing it accidentally', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  await repo.write('src/person.mjs', 'export const personName = "Anna";\n');
  await repo.write('README.md', '# Unrelated staged work\n');
  repo.git('add', 'README.md');
  const before = repo.git('rev-parse', 'HEAD');
  fails(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-001',
      paths: ['src/person.mjs'],
      message: 'feat(F-001): store a person',
      push: false,
    }),
    'change.checkpoint',
    'STAGED_CHANGES_CONFLICT',
  );
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'README.md');
});

test('retrying a failed push publishes the existing checkpoint instead of creating a second commit', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const feature = await startFeature(repo);
  const remoteParent = await mkdtemp(path.join(tmpdir(), 'workflow-remote-test-'));
  t.after(() => rm(remoteParent, { recursive: true, force: true }));
  const remotePath = path.join(remoteParent, 'remote.git');
  repo.git('remote', 'add', 'origin', remotePath);
  await repo.write('src/person.mjs', 'export const personName = "Anna";\n');
  const before = repo.git('rev-parse', 'HEAD');
  const request = {
    change_id: 'F-001',
    task_id: 'T-001',
    paths: ['src/person.mjs'],
    message: 'feat(F-001): store a person',
    push: true,
  };

  fails(await repo.run('change.checkpoint', request), 'change.checkpoint', 'PUSH_FAILED');
  const locallyCommitted = repo.git('rev-parse', 'HEAD');
  assert.notEqual(locallyCommitted, before, 'The local commit survives the failed push.');

  git(remoteParent, 'init', '--bare', remotePath);
  const retried = succeeds(await repo.run('change.checkpoint', request), 'change.checkpoint');
  assert.equal(retried.commit_sha, locallyCommitted);
  assert.equal(repo.git('rev-parse', 'HEAD'), locallyCommitted);
  assert.equal(repo.git('rev-list', '--count', `${before}..HEAD`), '1');
  assert.equal(
    git(remotePath, 'rev-parse', `refs/heads/${feature.change.branch}`),
    locallyCommitted,
  );
});
