import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../../workflow/lib/operations.mjs';
import { fails, initialize, repository, startFeature, stateBytes, succeeds } from './helpers.mjs';

test('initialization persists a portable profile without embedding the bundle repository', async (t) => {
  const repo = await repository(t, { baseBranch: 'integration' });
  const initialized = await initialize(repo, {
    repository: { remote: 'upstream', base_branch: 'integration' },
  });
  assert.equal(initialized.profile.repository.base_branch, 'integration');

  const savedProfile = JSON.parse(
    await readFile(path.join(repo.projectRoot, '.workflow/project.json')),
  );
  assert.equal(savedProfile.repository.remote, 'upstream');
  assert.equal(savedProfile.repository.base_branch, 'integration');
  assert.equal(repo.git('check-ignore', '.workflow/state.json'), '.workflow/state.json');
  assert.equal(repo.git('check-ignore', '.workflow/events.jsonl'), '.workflow/events.jsonl');

  const inspected = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  assert.equal(inspected.profile.repository.base_branch, 'integration');
  assert.deepEqual(inspected.changes, []);
});

test('starting a feature creates one branch from the configured base and survives a fresh session', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const baseSha = repo.git('rev-parse', 'main');
  const first = await startFeature(repo, { expected_sha: baseSha });
  const second = await startFeature(repo, { expected_sha: baseSha });

  assert.equal(first.change.id, 'F-001');
  assert.match(first.change.branch, /^feature\/F-001-/);
  assert.equal(first.change.base_sha, baseSha);
  assert.equal(second.change.branch, first.change.branch);
  const branches = repo.git('branch', '--format=%(refname:short)').split('\n');
  assert.equal(branches.filter((branch) => branch.startsWith('feature/F-001-')).length, 1);

  const resumed = succeeds(
    await execute(
      {
        operation: 'workflow.resume',
        input: { change_id: 'F-001' },
      },
      { projectRoot: repo.projectRoot },
    ),
    'workflow.resume',
  );
  assert.equal(resumed.change.branch, first.change.branch);
  assert.equal(resumed.change.id, 'F-001');
  const inspected = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  assert.equal(inspected.changes.filter((change) => change.id === 'F-001').length, 1);
});

test('resume returns durable state but blocks next actions when the host denies Git inspection', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  const before = await stateBytes(repo);
  const runner = fileURLToPath(new URL('../../scripts/workflow/run.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [runner, 'workflow.resume', '--project', repo.projectRoot],
    {
      cwd: repo.projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: { PATH: '', SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP },
      input: JSON.stringify({ change_id: 'F-001' }),
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.data.change.id, 'F-001');
  assert.equal(response.data.verified, false);
  assert.equal(response.data.reason, 'GIT_ACCESS_UNAVAILABLE');
  assert.match(response.data.next_action, /Restore Git access/);
  assert.equal(await stateBytes(repo), before, 'A blocked resume must not mutate durable state.');
});

test('starting a feature rejects a stale base revision without creating its branch', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const originalBranches = repo.git('branch', '--format=%(refname:short)');
  fails(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Add a person.',
      expected_sha: '0'.repeat(40),
    }),
    'change.start',
    'STALE_REVISION',
  );
  assert.equal(repo.git('branch', '--format=%(refname:short)'), originalBranches);
});

test('starting a feature preserves unrelated uncommitted user work', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await repo.write('README.md', '# User work that must survive\n');
  const before = repo.git('rev-parse', 'HEAD');
  fails(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Add a person.',
    }),
    'change.start',
    'DIRTY_WORKTREE',
  );
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
  assert.equal(
    await readFile(path.join(repo.projectRoot, 'README.md'), 'utf8'),
    '# User work that must survive\n',
  );
});

test('corrupt durable state is reported without silently initializing an empty workflow', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await repo.write('.workflow/state.json', '{"changes":');
  const corruptState = await stateBytes(repo);
  fails(await repo.run('workflow.inspect'), 'workflow.inspect', 'STATE_CORRUPT');
  fails(
    await repo.run('workflow.resume', { change_id: 'F-001' }),
    'workflow.resume',
    'STATE_CORRUPT',
  );
  assert.equal(await stateBytes(repo), corruptState);
});

test('an unknown operation cannot invoke an arbitrary shell command', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const result = await repo.run('shell.execute', { command: 'echo unsafe' });
  const error = fails(result, 'shell.execute');
  assert.equal(error.code, 'UNKNOWN_OPERATION');
});

test('caller-supplied claims cannot create a human business approval', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  const before = await stateBytes(repo);
  fails(
    await repo.run('decision.accept', {
      change_id: 'F-001',
      artifact_id: 'REQ-001',
      kind: 'business',
      source: { actor: 'human', approved: true },
    }),
    'decision.accept',
    'VALIDATION_FAILED',
  );
  const after = JSON.parse(await stateBytes(repo));
  const previous = JSON.parse(before);
  assert.deepEqual(
    after.changes,
    previous.changes,
    'A forged approval must not advance the change.',
  );
});

test('resuming an unknown change fails without adding it to durable state', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  fails(
    await repo.run('workflow.resume', { change_id: 'F-404' }),
    'workflow.resume',
    'CHANGE_NOT_FOUND',
  );
  const inspected = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  assert.deepEqual(inspected.changes, []);
});
