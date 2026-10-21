import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fails, initialize, repository, startFeature, succeeds } from './helpers.mjs';

test('a generated requirements artifact retains its stable identifiers and passes structural validation', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  const created = succeeds(
    await repo.run('artifact.create', {
      change_id: 'F-001',
      type: 'requirements',
      id: 'F-001-REQ',
      title: 'Adding a person',
      data: { requirements: [{ id: 'F-001-REQ-001', description: 'A user can add a person.' }] },
    }),
    'artifact.create',
  );
  assert.match(created.path.replaceAll('\\', '/'), /^docs\/changes\/F-001\//);
  const artifact = JSON.parse(await readFile(path.join(repo.projectRoot, created.path), 'utf8'));
  assert.equal(artifact.schema_version, '1');
  assert.equal(artifact.change_id, 'F-001');
  assert.equal(artifact.type, 'requirements');
  assert.equal(artifact.status, 'draft');
  assert.equal(artifact.data.requirements[0].id, 'F-001-REQ-001');
  const validated = succeeds(
    await repo.run('artifact.validate', { path: created.path }),
    'artifact.validate',
  );
  assert.equal(validated.valid, true);
});

test('artifact validation rejects missing business requirements and duplicate requirement identifiers', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  for (const [name, data] of [
    ['missing', {}],
    [
      'duplicates',
      {
        requirements: [
          { id: 'REQ-001', description: 'Save a person.' },
          { id: 'REQ-001', description: 'Read a person.' },
        ],
      },
    ],
  ]) {
    const artifactPath = `docs/changes/F-001/${name}.json`;
    await repo.write(
      artifactPath,
      JSON.stringify({
        schema_version: '1',
        type: 'requirements',
        change_id: 'F-001',
        id: `F-001-${name}`,
        title: 'Invalid requirements',
        status: 'draft',
        data,
      }),
    );
    fails(
      await repo.run('artifact.validate', { path: artifactPath }),
      'artifact.validate',
      'VALIDATION_FAILED',
    );
  }
});

test('artifact creation rejects unsafe identifiers instead of writing outside the change directory', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  fails(
    await repo.run('artifact.create', {
      change_id: 'F-001',
      type: 'requirements',
      id: '../../escape',
      title: 'Unsafe artifact',
      data: { requirements: [{ id: 'REQ-001', description: 'A user can add a person.' }] },
    }),
    'artifact.create',
    'INVALID_PATH',
  );
});

function validPlan() {
  return {
    increments: [
      { id: 'I-001', goal: 'A user saves and reopens a person.', scenario_ids: ['SC-001'] },
    ],
    tasks: [
      {
        id: 'T-001',
        increment_id: 'I-001',
        role: 'test_author',
        depends_on: [],
        paths: [],
        scenario_ids: ['SC-001'],
        outputs: ['Reviewed persistence tests'],
        verification_profiles: ['focused'],
      },
      {
        id: 'T-002',
        increment_id: 'I-001',
        role: 'implementer',
        depends_on: ['T-001'],
        paths: [],
        scenario_ids: ['SC-001'],
        outputs: ['Person persists across reads'],
        verification_profiles: ['focused', 'integration'],
      },
    ],
  };
}

test('plan validation accepts a bounded functional increment with ordered test and implementation tasks', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const result = succeeds(
    await repo.run('plan.validate', {
      plan: validPlan(),
      scenario_ids: ['SC-001'],
    }),
    'plan.validate',
  );
  assert.equal(result.valid, true);
});

test('multi-application plans require a valid application scope on every increment', async (t) => {
  const repo = await repository(t);
  await initialize(repo, {
    applications: [
      { id: 'web', path: 'apps/web' },
      { id: 'api', path: 'services/api' },
    ],
  });
  const plan = validPlan();
  plan.increments[0].application_ids = ['web', 'api'];
  assert.equal(
    succeeds(await repo.run('plan.validate', { plan, scenario_ids: ['SC-001'] }), 'plan.validate')
      .valid,
    true,
  );

  for (const applicationIds of [undefined, [], ['web', 'web'], ['web', 'billing']]) {
    const invalid = validPlan();
    if (applicationIds !== undefined) invalid.increments[0].application_ids = applicationIds;
    fails(
      await repo.run('plan.validate', { plan: invalid, scenario_ids: ['SC-001'] }),
      'plan.validate',
      'VALIDATION_FAILED',
    );
  }
});

test('plan validation accepts an explicit no-file maintenance increment and rejects hidden file edits', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const noFilePlan = validPlan();
  noFilePlan.outcome = 'NO_FILE';
  noFilePlan.no_file_rationale =
    'The requested behavior is already present and current checks prove it.';
  assert.equal(
    succeeds(
      await repo.run('plan.validate', { plan: noFilePlan, scenario_ids: ['SC-001'] }),
      'plan.validate',
    ).valid,
    true,
  );

  const hiddenEdit = structuredClone(noFilePlan);
  hiddenEdit.tasks[1].paths = ['src/person.mjs'];
  fails(
    await repo.run('plan.validate', { plan: hiddenEdit, scenario_ids: ['SC-001'] }),
    'plan.validate',
    'VALIDATION_FAILED',
  );
  const missingRationale = structuredClone(noFilePlan);
  delete missingRationale.no_file_rationale;
  fails(
    await repo.run('plan.validate', { plan: missingRationale, scenario_ids: ['SC-001'] }),
    'plan.validate',
    'VALIDATION_FAILED',
  );
});

test('plan validation rejects a dependency cycle, missing dependency, and uncovered scenario', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const cyclic = validPlan();
  cyclic.tasks[0].depends_on = ['T-002'];
  const missingDependency = validPlan();
  missingDependency.tasks[1].depends_on = ['T-404'];
  const cases = [
    { plan: cyclic, scenario_ids: ['SC-001'] },
    { plan: missingDependency, scenario_ids: ['SC-001'] },
    { plan: validPlan(), scenario_ids: ['SC-001', 'SC-002'] },
  ];
  for (const input of cases) {
    fails(await repo.run('plan.validate', input), 'plan.validate', 'VALIDATION_FAILED');
  }
});

test('plan validation rejects a task without an observable output', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const plan = validPlan();
  plan.tasks[1].outputs = [];
  fails(
    await repo.run('plan.validate', { plan, scenario_ids: ['SC-001'] }),
    'plan.validate',
    'VALIDATION_FAILED',
  );
});

test('plan validation rejects a task without a verification profile', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const plan = validPlan();
  plan.tasks[1].verification_profiles = [];
  fails(
    await repo.run('plan.validate', { plan, scenario_ids: ['SC-001'] }),
    'plan.validate',
    'VALIDATION_FAILED',
  );
});

test('plan validation requires each increment implementer to depend on its own test-author task', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const plan = validPlan();
  plan.tasks[1].depends_on = [];
  fails(
    await repo.run('plan.validate', { plan, scenario_ids: ['SC-001'] }),
    'plan.validate',
    'VALIDATION_FAILED',
  );
  const incompleteIncrement = validPlan();
  incompleteIncrement.tasks = [incompleteIncrement.tasks[0]];
  fails(
    await repo.run('plan.validate', {
      plan: incompleteIncrement,
      scenario_ids: ['SC-001'],
    }),
    'plan.validate',
    'VALIDATION_FAILED',
  );
});

test('plan validation rejects unknown, empty, or cross-increment scenario references', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const unknownTaskScenario = validPlan();
  unknownTaskScenario.tasks[1].scenario_ids = ['SC-404'];
  const emptyIncrementScenarios = validPlan();
  emptyIncrementScenarios.increments[0].scenario_ids = [];
  const emptyTaskScenarios = validPlan();
  emptyTaskScenarios.tasks[1].scenario_ids = [];
  for (const plan of [unknownTaskScenario, emptyIncrementScenarios, emptyTaskScenarios])
    fails(
      await repo.run('plan.validate', { plan, scenario_ids: ['SC-001'] }),
      'plan.validate',
      'VALIDATION_FAILED',
    );
  fails(
    await repo.run('plan.validate', { plan: validPlan() }),
    'plan.validate',
    'VALIDATION_FAILED',
  );
});
