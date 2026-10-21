import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { initialize, repository, startFeature, succeeds } from './helpers.mjs';

const apps = [
  { id: 'api', path: 'services/api', kind: 'backend' },
  { id: 'web', path: 'apps/web', kind: 'web' },
];

async function configuredProject(t, { firstFixture = 'passing-test.mjs' } = {}) {
  const repo = await repository(t);
  const pass = fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url));
  const fail = fileURLToPath(new URL('./fixtures/failing-assertion.mjs', import.meta.url));
  const first = fileURLToPath(new URL(`./fixtures/${firstFixture}`, import.meta.url));
  await initialize(repo, {
    applications: apps,
    commands: {
      'api-unit': {
        command: process.execPath,
        args: ['--test', first],
        timeout_ms: 2_000,
        category: 'unit',
        cadence: 'task',
        application_ids: ['api'],
      },
      'api-contract': {
        command: process.execPath,
        args: ['--test', pass],
        timeout_ms: 2_000,
        category: 'contract',
        cadence: 'task',
        application_ids: ['api'],
      },
      'system-e2e': {
        command: process.execPath,
        args: ['--test', pass],
        timeout_ms: 2_000,
        category: 'e2e',
        cadence: 'merge',
        application_ids: ['*'],
      },
    },
  });
  return { repo, fail };
}

test('scheduled tests execute in policy order and persist every current-phase result', async (t) => {
  const { repo } = await configuredProject(t);
  await startFeature(repo);
  const executed = succeeds(
    await repo.run('tests.run_scheduled', {
      phase: 'task',
      affected_application_ids: ['api'],
      impact_unknown: false,
      change_id: 'F-001',
    }),
    'tests.run_scheduled',
  );

  assert.equal(executed.complete, true);
  assert.equal(executed.passed, true);
  assert.deepEqual(
    executed.results.map((entry) => entry.profile),
    ['api-unit', 'api-contract'],
  );
  assert.ok(executed.results.every((entry) => entry.classification === 'PASS' && entry.run_id));
  assert.equal(executed.results.length, Object.keys(executed.runs_by_id).length);
});

test('a failing fast check stops later profiles and preserves an incomplete schedule report', async (t) => {
  const { repo } = await configuredProject(t, { firstFixture: 'failing-assertion.mjs' });
  const executed = succeeds(
    await repo.run('tests.run_scheduled', {
      phase: 'task',
      affected_application_ids: ['api'],
      impact_unknown: false,
    }),
    'tests.run_scheduled',
  );

  assert.equal(executed.complete, false);
  assert.equal(executed.passed, false);
  assert.deepEqual(
    executed.results.map((entry) => entry.profile),
    ['api-unit'],
  );
  assert.equal(executed.stop_reason, 'ASSERTION_FAILURE');
  assert.deepEqual(executed.not_run_profiles, ['api-contract']);
});
