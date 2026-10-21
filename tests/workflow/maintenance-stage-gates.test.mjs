import test from 'node:test';
import assert from 'node:assert/strict';
import { fails, initialize, repository, succeeds } from './helpers.mjs';

test('maintenance enters the reviewed requirements and planning flow', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  succeeds(
    await repo.run('change.start', {
      id: 'M-001',
      kind: 'MAINTENANCE',
      description: 'Upgrade the HTTP client dependency.',
    }),
    'change.start',
  );

  const route = succeeds(await repo.run('change.route', { change_id: 'M-001' }), 'change.route');
  assert.equal(route.advisory_only, true);
  assert.match(route.sequence[0], /classify/i);

  const gate = succeeds(await repo.run('stage.inspect', { change_id: 'M-001' }), 'stage.inspect');
  assert.equal(gate.transition.supported, true);
  assert.equal(gate.transition.from, 'REQUIREMENTS');
  assert.equal(gate.transition.to, 'PLANNING');
  assert.deepEqual(gate.transition.missing.map(({ type }) => type).sort(), [
    'impact-map',
    'requirements',
    'scenarios',
  ]);

  fails(
    await repo.run('task.prepare', {
      change_id: 'M-001',
      task: {
        id: 'T-MAINTAIN',
        role: 'implementer',
        depends_on: [],
        paths: [],
        verification_profiles: [],
        outputs: ['Upgrade the HTTP client dependency.'],
      },
    }),
    'task.prepare',
    'GATE_BLOCKED',
  );
  fails(
    await repo.run('increment.inspect', { change_id: 'M-001' }),
    'increment.inspect',
    'GATE_BLOCKED',
  );
});

test('maintenance rejects an impact map that omits a configured application', async (t) => {
  const repo = await repository(t);
  await initialize(repo, {
    applications: [
      { id: 'web', path: 'apps/web', kind: 'web' },
      { id: 'api', path: 'services/api', kind: 'backend' },
    ],
  });
  succeeds(
    await repo.run('change.start', {
      id: 'M-IMPACT-MAP',
      kind: 'MAINTENANCE',
      description: 'Update the HTTP client dependency.',
    }),
    'change.start',
  );
  succeeds(
    await repo.run('artifact.create', {
      change_id: 'M-IMPACT-MAP',
      id: 'IMPACT-MAP',
      type: 'impact-map',
      title: 'Dependency update impact',
      data: {
        applications: [
          {
            application_id: 'web',
            impact: 'AFFECTED',
            rationale: 'The client is used by the web app.',
          },
        ],
        contracts: [],
        data_changes: [],
        exclusions: [],
        compatibility: [],
      },
    }),
    'artifact.create',
  );

  const gate = succeeds(
    await repo.run('stage.inspect', { change_id: 'M-IMPACT-MAP' }),
    'stage.inspect',
  );
  assert.equal(gate.transition.ready, false);
  assert.ok(
    gate.transition.missing.some(
      (item) => item.type === 'impact-map' && item.reason === 'artifact_invalid',
    ),
  );
});
