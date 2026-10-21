import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fails, initialize, repository, startFeature, succeeds } from './helpers.mjs';

async function preparedRun(t, fixture, timeout = 2_000) {
  const repo = await repository(t);
  const fixturePath = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
  await initialize(repo, {
    commands: {
      focused: { command: process.execPath, args: ['--test', fixturePath], timeout_ms: timeout },
    },
  });
  await startFeature(repo);
  const data = succeeds(
    await repo.run('tests.run', { profile: 'focused', change_id: 'F-001' }),
    'tests.run',
  );
  return { repo, run: data.run };
}

test('a real failing assertion can certify RED only with its observed test identity and assertion message', async (t) => {
  const { repo, run } = await preparedRun(t, 'failing-assertion.mjs');
  assert.equal(run.classification, 'ASSERTION_FAILURE');
  assert.notEqual(run.exit_code, 0);
  assert.ok(run.id);
  const recorded = succeeds(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'RED',
      expected_failure: {
        test_id: 'rejects a parent relationship that creates a cycle',
        message: 'A cyclic parent relationship must be rejected.',
      },
    }),
    'tdd.record',
  );
  assert.equal(recorded.evidence.phase, 'RED');
  assert.equal(recorded.evidence.run_id, run.id);
});

test('RED rejects an unrelated assertion identity and a missing expected-failure explanation', async (t) => {
  const { repo, run } = await preparedRun(t, 'failing-assertion.mjs');
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'RED',
    }),
    'tdd.record',
    'INVALID_TDD_EVIDENCE',
  );
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'RED',
      expected_failure: {
        test_id: 'stores a person successfully',
        message: 'A cyclic parent relationship must be rejected.',
      },
    }),
    'tdd.record',
    'INVALID_TDD_EVIDENCE',
  );
});

test('a missing dependency is classified as infrastructure failure and cannot certify RED', async (t) => {
  const { repo, run } = await preparedRun(t, 'infrastructure-failure.mjs');
  assert.equal(run.classification, 'INFRASTRUCTURE_FAILURE');
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'RED',
      expected_failure: { test_id: 'infrastructure-failure.mjs', message: 'Cannot find module' },
    }),
    'tdd.record',
    'INVALID_TDD_EVIDENCE',
  );
});

test('a passing test run can certify GREEN but cannot certify RED', async (t) => {
  const { repo, run } = await preparedRun(t, 'passing-test.mjs');
  assert.equal(run.classification, 'PASS');
  assert.equal(run.exit_code, 0);
  const recorded = succeeds(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'GREEN',
    }),
    'tdd.record',
  );
  assert.equal(recorded.evidence.phase, 'GREEN');
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'RED',
      expected_failure: { test_id: 'stores the supplied person name', message: 'missing behavior' },
    }),
    'tdd.record',
    'INVALID_TDD_EVIDENCE',
  );
});

test('an unregistered test profile fails instead of executing caller-supplied commands', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  fails(
    await repo.run('tests.run', { profile: 'unregistered', command: process.execPath }),
    'tests.run',
    'TEST_PROFILE_NOT_FOUND',
  );
});

test('GREEN evidence cannot certify a source tree changed after the test run', async (t) => {
  const { repo, run } = await preparedRun(t, 'passing-test.mjs');
  await repo.write('README.md', '# Source tree changed after verification\n');
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: run.id,
      phase: 'GREEN',
    }),
    'tdd.record',
    'STALE_REVISION',
  );
});
