import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fails,
  git,
  initialize,
  repository,
  startFeature,
  stateBytes,
  succeeds,
} from './helpers.mjs';

const checkpointInput = {
  change_id: 'F-001',
  task_id: 'T-001',
  paths: ['src/person.mjs'],
  message: 'feat(F-001): save a person',
  push: false,
};

async function featureRepository(t, options) {
  const repo = await repository(t, options);
  await initialize(repo);
  const started = await startFeature(repo);
  return { ...repo, change: started.change };
}

async function runProfile(t, command, context) {
  const repo = await repository(t, { context });
  await initialize(repo, { commands: { focused: command } });
  await startFeature(repo);
  const result = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  );
  return { repo, run: result.run };
}

test('retrying a completed checkpoint after a new owned edit rejects the changed task revision', async (t) => {
  const repo = await featureRepository(t);
  await repo.write('src/person.mjs', 'export const personName = "Anna";\n');
  const first = succeeds(await repo.run('change.checkpoint', checkpointInput), 'change.checkpoint');
  await repo.write('src/person.mjs', 'export const personName = "Jan";\n');
  fails(
    await repo.run('change.checkpoint', checkpointInput),
    'change.checkpoint',
    'CHECKPOINT_CONFLICT',
  );
  assert.equal(repo.git('rev-parse', 'HEAD'), first.commit_sha);
  assert.equal(
    await readFile(path.join(repo.projectRoot, 'src/person.mjs'), 'utf8'),
    'export const personName = "Jan";\n',
  );
});

test('a local-only checkpoint can subsequently publish its existing commit without duplicating it', async (t) => {
  const repo = await featureRepository(t);
  const remoteParent = await mkdtemp(path.join(tmpdir(), 'workflow-publish-retry-'));
  t.after(() => rm(remoteParent, { recursive: true, force: true }));
  const remote = path.join(remoteParent, 'remote.git');
  git(remoteParent, 'init', '--bare', remote);
  repo.git('remote', 'add', 'origin', remote);
  await repo.write('src/person.mjs', 'export const personName = "Anna";\n');
  const first = succeeds(await repo.run('change.checkpoint', checkpointInput), 'change.checkpoint');
  const published = succeeds(
    await repo.run('change.checkpoint', { ...checkpointInput, push: true }),
    'change.checkpoint',
  );
  assert.equal(published.commit_sha, first.commit_sha);
  assert.equal(repo.git('rev-parse', 'HEAD'), first.commit_sha);
  const advertised = repo.git('ls-remote', 'origin', `refs/heads/${repo.change.branch}`);
  assert.equal(
    advertised.split(/\s+/)[0],
    first.commit_sha,
    'The existing checkpoint must actually be published.',
  );
});

test('recovery of a prepared checkpoint refuses an index containing unrelated staged work', async (t) => {
  const repo = await featureRepository(t);
  await repo.write('src/person.mjs', 'export const personName = "Anna";\n');
  succeeds(await repo.run('change.checkpoint', checkpointInput), 'change.checkpoint');
  const state = JSON.parse(await stateBytes(repo));
  const receipt = Object.values(state.receipts).find((candidate) => candidate.task_id === 'T-001');
  assert.ok(receipt, 'The actual operation must have persisted its checkpoint receipt.');
  // Model a crash before commit, retaining all receipt integrity metadata.
  repo.git('reset', '--mixed', receipt.before_sha);
  receipt.prepared = true;
  delete receipt.commit_sha;
  await repo.write('.workflow/state.json', JSON.stringify(state));
  await repo.write('README.md', '# Unrelated staged user work\n');
  repo.git('add', 'README.md');
  const before = repo.git('rev-parse', 'HEAD');

  fails(
    await repo.run('change.checkpoint', checkpointInput),
    'change.checkpoint',
    'CHECKPOINT_CONFLICT',
  );
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
  assert.equal(repo.git('diff', '--cached', '--name-only'), 'README.md');
});

test('Git pathspec syntax cannot expand checkpoint ownership to unrelated files', async (t) => {
  const repo = await featureRepository(t);
  await repo.write('src/person.mjs', 'export const personName = "Anna";\n');
  await repo.write('README.md', '# Unrelated user work\n');
  const before = repo.git('rev-parse', 'HEAD');
  fails(
    await repo.run('change.checkpoint', { ...checkpointInput, paths: [':(top)*'] }),
    'change.checkpoint',
    'INVALID_PATH',
  );
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
  assert.equal(repo.git('diff', '--cached', '--name-only'), '');
});

test('case variants of protected paths remain inaccessible on case-insensitive hosts', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await repo.write('.env', 'PRIVATE_SETTING=do-not-read\n');
  for (const protectedPath of ['.WORKFLOW/state.json', '.GIT/config', '.ENV']) {
    fails(await repo.run('repo.read', { path: protectedPath }), 'repo.read', 'INVALID_PATH');
  }
});

test('an arbitrary successful program without executed tests cannot certify GREEN', async (t) => {
  const { repo, run } = await runProfile(t, {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeout_ms: 2_000,
  });
  assert.equal(run.exit_code, 0);
  fails(
    await repo.run('tdd.record', { change_id: 'F-001', run_id: run.id, phase: 'GREEN' }),
    'tdd.record',
    'INVALID_TDD_EVIDENCE',
  );
});

test('printed assertion-looking text without an actual test report cannot certify RED', async (t) => {
  const { repo, run } = await runProfile(t, {
    command: process.execPath,
    args: [
      '-e',
      'console.log("not ok fake-cycle-test ERR_ASSERTION cyclic relationship rejected"); process.exit(1);',
    ],
    timeout_ms: 2_000,
  });
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'RED',
      expected_failure: { test_id: 'fake-cycle-test', message: 'cyclic relationship rejected' },
    }),
    'tdd.record',
    'INVALID_TDD_EVIDENCE',
  );
});

test('a real Node test runner with no registered tests cannot certify GREEN', async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/empty-test.mjs', import.meta.url));
  const { repo, run } = await runProfile(t, {
    command: process.execPath,
    args: ['--test', fixture],
    timeout_ms: 2_000,
  });
  assert.equal(run.exit_code, 0);
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'GREEN',
    }),
    'tdd.record',
    'INVALID_TDD_EVIDENCE',
  );
});

test('a test suite containing only skipped tests cannot certify GREEN', async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/skipped-test.mjs', import.meta.url));
  const { repo, run } = await runProfile(t, {
    command: process.execPath,
    args: ['--test', fixture],
    timeout_ms: 2_000,
  });
  assert.equal(run.exit_code, 0);
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'GREEN',
    }),
    'tdd.record',
    'INVALID_TDD_EVIDENCE',
  );
});

test('changing a tracked source file larger than two MiB invalidates recorded GREEN evidence', async (t) => {
  const repo = await repository(t);
  const fixture = fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url));
  await initialize(repo, {
    commands: {
      focused: { command: process.execPath, args: ['--test', fixture], timeout_ms: 2_000 },
    },
  });
  await repo.write('src/large-data.mjs', `// ${'a'.repeat(2 * 1024 * 1024)}\n`);
  repo.git('add', 'src/large-data.mjs');
  repo.git('commit', '-m', 'Add large tracked source fixture');
  await startFeature(repo);
  const result = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  );
  assert.equal(result.run.classification, 'PASS');
  await repo.write('src/large-data.mjs', `// ${'b'.repeat(2 * 1024 * 1024)}\n`);
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: result.run.id,
      phase: 'GREEN',
    }),
    'tdd.record',
    'STALE_REVISION',
  );
});

test('test output credentials are redacted before durable run evidence is written', async (t) => {
  const secret = 'workflow-persisted-secret-89af24';
  const { repo, run } = await runProfile(
    t,
    {
      command: process.execPath,
      args: ['-e', `console.log(${JSON.stringify(secret)})`],
      timeout_ms: 2_000,
    },
    { env: { ...process.env, API_TOKEN: secret } },
  );
  assert.equal(JSON.stringify(run).includes(secret), false);
  assert.equal(
    (await stateBytes(repo)).includes(secret),
    false,
    'Authoritative evidence must not retain raw credentials.',
  );
});

test('initialization does not overwrite corrupt existing state while retrying setup', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await repo.write('.workflow/state.json', '{"changes":');
  fails(await repo.run('workflow.init'), 'workflow.init', 'STATE_CORRUPT');
  assert.equal(await stateBytes(repo), '{"changes":');
});

test('a profile-only interrupted initialization is reported explicitly without inventing empty workflow state', async (t) => {
  const repo = await repository(t);
  const profile = JSON.stringify({
    repository: { remote: 'origin', base_branch: 'main' },
    applications: [],
    commands: {},
  });
  await repo.write('.workflow/project.json', profile);
  fails(await repo.run('workflow.init'), 'workflow.init', 'INITIALIZATION_INCOMPLETE');
  assert.equal(
    await readFile(path.join(repo.projectRoot, '.workflow/project.json'), 'utf8'),
    profile,
  );
  await assert.rejects(readFile(path.join(repo.projectRoot, '.workflow/state.json')), {
    code: 'ENOENT',
  });
});
