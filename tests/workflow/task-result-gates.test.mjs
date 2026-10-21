import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fails, initialize, repository, startFeature, succeeds } from './helpers.mjs';

async function preparedTask(t, { push = true, checkpointTask = true } = {}) {
  const repo = await repository(t);
  const bareRemote = await mkdtemp(path.join(tmpdir(), 'codex-workflow-remote-'));
  t.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(bareRemote, { recursive: true, force: true })),
  );
  execFileSync('git', ['init', '--bare', bareRemote], { windowsHide: true });
  repo.git('remote', 'add', 'origin', bareRemote);
  repo.git('push', '-u', 'origin', 'main');
  const passingFixture = fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url));
  await initialize(repo, {
    commands: {
      focused: {
        command: process.execPath,
        args: ['--test', passingFixture],
        timeout_ms: 2_000,
      },
      unplanned: {
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeout_ms: 2_000,
      },
    },
  });
  await startFeature(repo);
  await repo.write('src/person.mjs', 'export const isValidPerson = (name) => Boolean(name);\n');
  const prepared = succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-001',
        role: 'sdlc_documentation_author',
        depends_on: [],
        paths: ['src/person.mjs'],
        verification_profiles: ['focused'],
        outputs: ['A named person passes basic validation.'],
      },
    }),
    'task.prepare',
  );
  const run = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  ).run;
  const checkpoint = checkpointTask
    ? succeeds(
        await repo.run('change.checkpoint', {
          change_id: 'F-001',
          task_id: 'T-001',
          paths: ['src/person.mjs'],
          message: 'feat(F-001): implement valid person check',
          push,
        }),
        'change.checkpoint',
      )
    : null;
  return { repo, prepared: prepared.task, run, checkpoint };
}

test('a task result becomes review-ready only after fresh verification and its pushed scoped checkpoint', async (t) => {
  const { repo, run, checkpoint } = await preparedTask(t);
  const recorded = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      run_ids: [run.id],
    }),
    'task.record_result',
  );

  assert.equal(recorded.task.state, 'WAITING_REVIEW');
  assert.equal(recorded.task.result.status, 'WAITING_REVIEW');
  assert.equal(recorded.task.result.checkpoint_sha, checkpoint.commit_sha);
  assert.deepEqual(recorded.task.result.run_ids, [run.id]);
  assert.notEqual(recorded.task.state, 'DONE');
  const retry = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      run_ids: [run.id],
    }),
    'task.record_result',
  );
  assert.equal(retry.already_recorded, true);
});

test('a passing test run without a matching committed checkpoint cannot advance task review', async (t) => {
  const { repo, run } = await preparedTask(t, { checkpointTask: false });
  fails(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      run_ids: [run.id],
    }),
    'task.record_result',
    'CHECKPOINT_REQUIRED',
  );
});

test('a local-only checkpoint remains pending and cannot make the task review-ready', async (t) => {
  const { repo, run } = await preparedTask(t, { push: false });
  fails(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      run_ids: [run.id],
    }),
    'task.record_result',
    'PUSH_PENDING',
  );
});

test('verification becomes stale after an owned source edit, even when a prior checkpoint exists', async (t) => {
  const { repo, run } = await preparedTask(t);
  await repo.write('src/person.mjs', 'export const isValidPerson = () => true;\n');
  fails(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      run_ids: [run.id],
    }),
    'task.record_result',
    'STALE_REVISION',
  );
});

test('a passing profile outside the reviewed task plan cannot be added as completion evidence', async (t) => {
  const { repo, run } = await preparedTask(t);
  const unplannedRun = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'unplanned' }),
    'tests.run',
  ).run;
  fails(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      run_ids: [run.id, unplannedRun.id],
    }),
    'task.record_result',
    'INVALID_TASK_RESULT',
  );
});
