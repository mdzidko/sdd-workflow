import test from 'node:test';
import assert from 'node:assert/strict';
import { fails, initialize, repository, stateBytes, succeeds } from './helpers.mjs';

const applications = [
  { id: 'web', path: 'apps/web', kind: 'web' },
  { id: 'api', path: 'services/api', kind: 'backend' },
  { id: 'mobile', path: 'apps/mobile', kind: 'mobile' },
];

const commands = {
  'web-unit': {
    command: 'node',
    args: ['--test'],
    category: 'unit',
    cadence: 'task',
    application_ids: ['web'],
  },
  'api-unit': {
    command: 'node',
    args: ['--test'],
    category: 'unit',
    cadence: 'task',
    application_ids: ['api'],
  },
  'contract-check': {
    command: 'node',
    args: ['--test'],
    category: 'contract',
    cadence: 'task',
    application_ids: ['web', 'api'],
  },
  'service-integration': {
    command: 'node',
    args: ['--test'],
    category: 'integration',
    cadence: 'increment',
    application_ids: ['web', 'api'],
  },
  'system-e2e': {
    command: 'node',
    args: ['--test'],
    category: 'e2e',
    cadence: 'merge',
    application_ids: ['*'],
  },
  'image-smoke': {
    command: 'node',
    args: ['--test'],
    category: 'image',
    cadence: 'release',
    application_ids: ['web', 'api'],
  },
  'release-check': {
    command: 'node',
    args: ['--test'],
    category: 'release',
    cadence: 'release',
    application_ids: ['*'],
  },
};

async function configuredProject(t) {
  const repo = await repository(t);
  await initialize(repo, { applications, commands });
  return repo;
}

async function featureWithAcceptedPlan(t, increment = {}) {
  const repo = await configuredProject(t);
  succeeds(
    await repo.run('change.start', {
      id: 'F-CROSS-APP',
      kind: 'FEATURE',
      description: 'Display service data in the web application.',
    }),
    'change.start',
  );
  succeeds(
    await repo.run('artifact.create', {
      change_id: 'F-CROSS-APP',
      id: 'PLAN-CROSS-APP',
      type: 'implementation-plan',
      title: 'Deliver the web and API behavior together',
      data: {
        outcome: 'IMPLEMENTATION',
        specification_ref: 'F-CROSS-APP-SPEC',
        increments: [
          {
            id: 'I-CROSS-APP',
            goal: 'The web application displays data returned by the API.',
            scenario_ids: ['SC-CROSS-APP'],
            ...increment,
          },
        ],
        tasks: [],
        coverage: [],
        verification_schedule: [],
        risks: [],
      },
    }),
    'artifact.create',
  );
  const state = JSON.parse(await stateBytes(repo));
  const change = state.changes['F-CROSS-APP'];
  const planRef = change.artifacts.find((artifact) => artifact.id === 'PLAN-CROSS-APP');
  change.stage = 'IMPLEMENTATION';
  change.stage_history = [
    {
      to: 'IMPLEMENTATION',
      evidence: [
        {
          type: 'implementation-plan',
          artifact_id: planRef.id,
          content_hash: planRef.content_hash,
        },
      ],
    },
  ];
  await repo.write('.workflow/state.json', `${JSON.stringify(state, null, 2)}\n`);
  return repo;
}

test('task cadence runs only fast checks for affected applications and their shared contracts', async (t) => {
  const repo = await configuredProject(t);
  const schedule = succeeds(
    await repo.run('test.schedule', {
      phase: 'task',
      affected_application_ids: ['api'],
      impact_unknown: false,
    }),
    'test.schedule',
  );

  assert.deepEqual(
    schedule.profiles.map((entry) => entry.name),
    ['api-unit', 'contract-check'],
  );
  assert.ok(schedule.profiles.every((entry) => ['task'].includes(entry.cadence)));
  assert.equal(schedule.full_coverage_required, false);
});

test('increment, merge and release gates add progressively slower cross-application checks', async (t) => {
  const repo = await configuredProject(t);
  const increment = succeeds(
    await repo.run('test.schedule', {
      phase: 'increment',
      affected_application_ids: ['web'],
      impact_unknown: false,
    }),
    'test.schedule',
  );
  const merge = succeeds(
    await repo.run('test.schedule', {
      phase: 'merge',
      affected_application_ids: ['web'],
      impact_unknown: false,
    }),
    'test.schedule',
  );
  const release = succeeds(
    await repo.run('test.schedule', {
      phase: 'release',
      affected_application_ids: ['web'],
      impact_unknown: false,
    }),
    'test.schedule',
  );

  assert.deepEqual(
    increment.profiles.map((entry) => entry.name),
    ['web-unit', 'contract-check', 'service-integration'],
  );
  assert.deepEqual(
    merge.profiles.map((entry) => entry.name),
    ['web-unit', 'contract-check', 'service-integration', 'system-e2e'],
  );
  assert.ok(
    merge.profiles.find((entry) => entry.name === 'system-e2e').application_ids.includes('mobile'),
  );
  assert.deepEqual(
    release.profiles.map((entry) => entry.name),
    [
      'web-unit',
      'contract-check',
      'service-integration',
      'system-e2e',
      'image-smoke',
      'release-check',
    ],
  );
});

test('test profiles cannot schedule slow verification categories earlier than their minimum cadence', async (t) => {
  const minimumCadences = [
    { category: 'integration', cadence: 'task', minimum: 'increment' },
    { category: 'e2e', cadence: 'increment', minimum: 'merge' },
    { category: 'image', cadence: 'merge', minimum: 'release' },
    { category: 'release', cadence: 'merge', minimum: 'release' },
  ];

  for (const { category, cadence, minimum } of minimumCadences) {
    const repo = await repository(t);
    await initialize(repo, {
      applications: [{ id: 'web', path: 'apps/web' }],
      commands: {
        [`premature-${category}`]: {
          command: 'node',
          args: ['--test'],
          category,
          cadence,
          application_ids: ['web'],
        },
      },
    });

    const error = fails(
      await repo.run('test.schedule', {
        phase: cadence,
        affected_application_ids: ['web'],
        impact_unknown: false,
      }),
      'test.schedule',
      'INVALID_TEST_CADENCE',
    );
    assert.match(error.message, new RegExp(`${category}.*minimum ${minimum}`));
  }
});

test('feature checks derive application scope from the current reviewed increment', async (t) => {
  const repo = await featureWithAcceptedPlan(t, { application_ids: ['web', 'api'] });
  const schedule = succeeds(
    await repo.run('test.schedule', {
      change_id: 'F-CROSS-APP',
      phase: 'increment',
    }),
    'test.schedule',
  );

  assert.deepEqual(
    schedule.profiles.map((entry) => entry.name),
    ['api-unit', 'web-unit', 'contract-check', 'service-integration'],
  );
  assert.equal(schedule.full_coverage_required, false);
  assert.deepEqual(schedule.uncovered_application_ids, []);
  fails(
    await repo.run('test.schedule', {
      change_id: 'F-CROSS-APP',
      phase: 'increment',
      affected_application_ids: ['api'],
      impact_unknown: false,
    }),
    'test.schedule',
    'VALIDATION_FAILED',
  );
});

test('a feature increment with no declared application scope requires full registered coverage', async (t) => {
  const repo = await featureWithAcceptedPlan(t);
  const schedule = succeeds(
    await repo.run('test.schedule', {
      change_id: 'F-CROSS-APP',
      phase: 'task',
    }),
    'test.schedule',
  );

  assert.deepEqual(
    schedule.profiles.map((entry) => entry.name),
    ['api-unit', 'web-unit', 'contract-check'],
  );
  assert.equal(schedule.full_coverage_required, true);
  assert.deepEqual(schedule.uncovered_application_ids, ['mobile']);
  const stateBeforeExecution = await stateBytes(repo);
  fails(
    await repo.run('tests.run_scheduled', { phase: 'task', impact_unknown: true }),
    'tests.run_scheduled',
    'TEST_COVERAGE_INCOMPLETE',
  );
  assert.equal(await stateBytes(repo), stateBeforeExecution);
  fails(
    await repo.run('test.schedule', {
      change_id: 'F-CROSS-APP',
      phase: 'task',
      affected_application_ids: ['api'],
      impact_unknown: false,
    }),
    'test.schedule',
    'VALIDATION_FAILED',
  );
});

test('unknown impact expands current-phase checks to all applications and reports the reason', async (t) => {
  const repo = await configuredProject(t);
  const schedule = succeeds(
    await repo.run('test.schedule', { phase: 'task', impact_unknown: true }),
    'test.schedule',
  );

  assert.deepEqual(
    schedule.profiles.map((entry) => entry.name),
    ['api-unit', 'web-unit', 'contract-check'],
  );
  assert.deepEqual(
    [...new Set(schedule.profiles.flatMap((entry) => entry.application_ids))].sort(),
    ['api', 'web'],
  );
  assert.deepEqual(schedule.uncovered_application_ids, ['mobile']);
  assert.equal(schedule.full_coverage_required, true);
  assert.match(schedule.selection_reason, /impact is unknown/i);
});

test('maintenance scheduling ignores caller impact claims until its impact map is reviewed', async (t) => {
  const repo = await configuredProject(t);
  succeeds(
    await repo.run('change.start', {
      id: 'M-IMPACT',
      kind: 'MAINTENANCE',
      description: 'Update the API client dependency.',
    }),
    'change.start',
  );

  fails(
    await repo.run('test.schedule', {
      change_id: 'M-IMPACT',
      phase: 'task',
      affected_application_ids: ['api'],
      impact_unknown: false,
    }),
    'test.schedule',
    'GATE_BLOCKED',
  );
});

test('maintenance test scope comes from the current approved impact map', async (t) => {
  const repo = await configuredProject(t);
  succeeds(
    await repo.run('change.start', {
      id: 'M-APPROVED-IMPACT',
      kind: 'MAINTENANCE',
      description: 'Update the API client dependency.',
    }),
    'change.start',
  );
  succeeds(
    await repo.run('artifact.create', {
      change_id: 'M-APPROVED-IMPACT',
      id: 'IMPACT-MAP',
      type: 'impact-map',
      title: 'Reviewed application impact',
      data: {
        applications: [
          {
            application_id: 'web',
            impact: 'UNAFFECTED',
            rationale: 'Does not use this dependency.',
          },
          { application_id: 'api', impact: 'AFFECTED', rationale: 'Uses the dependency directly.' },
          {
            application_id: 'mobile',
            impact: 'UNAFFECTED',
            rationale: 'Uses a separate native client.',
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

  const state = JSON.parse(await stateBytes(repo));
  const change = state.changes['M-APPROVED-IMPACT'];
  const impactMap = change.artifacts.find((artifact) => artifact.id === 'IMPACT-MAP');
  const headSha = repo.git('rev-parse', 'HEAD');
  change.pull_request = { head_sha: headSha };
  change.approvals = [
    {
      artifact_id: impactMap.id,
      status: 'APPROVED',
      provider: 'github',
      subject_hash: impactMap.content_hash,
      head_sha: headSha,
      review_id: 7,
      reviewer: 'human-reviewer',
    },
  ];
  change.stage_history = [
    {
      to: 'PLANNING',
      evidence: [
        {
          type: 'impact-map',
          artifact_id: impactMap.id,
          content_hash: impactMap.content_hash,
        },
      ],
    },
  ];
  await repo.write('.workflow/state.json', `${JSON.stringify(state, null, 2)}\n`);

  const schedule = succeeds(
    await repo.run('test.schedule', { change_id: 'M-APPROVED-IMPACT', phase: 'task' }),
    'test.schedule',
  );
  assert.deepEqual(
    schedule.profiles.map((entry) => entry.name),
    ['api-unit', 'contract-check'],
  );
  assert.equal(schedule.full_coverage_required, false);
  assert.equal(schedule.impact_map.artifact_id, impactMap.id);
  assert.deepEqual(schedule.impact_map.affected_application_ids, ['api']);

  fails(
    await repo.run('test.schedule', {
      change_id: 'M-APPROVED-IMPACT',
      phase: 'task',
      affected_application_ids: ['web'],
      impact_unknown: false,
    }),
    'test.schedule',
    'VALIDATION_FAILED',
  );
});

test('invalid phases, unknown apps, and empty phase coverage fail with actionable errors', async (t) => {
  const repo = await configuredProject(t);
  fails(
    await repo.run('test.schedule', { phase: 'sometime', affected_application_ids: ['api'] }),
    'test.schedule',
    'VALIDATION_FAILED',
  );
  fails(
    await repo.run('test.schedule', { phase: 'task', affected_application_ids: ['billing'] }),
    'test.schedule',
    'VALIDATION_FAILED',
  );
  fails(
    await repo.run('test.schedule', {
      phase: 'task',
      impact_unknown: false,
      affected_application_ids: [],
    }),
    'test.schedule',
    'VALIDATION_FAILED',
  );
  fails(
    await repo.run('test.schedule', { phase: 'task', affected_application_ids: ['mobile'] }),
    'test.schedule',
    'TEST_SCHEDULE_EMPTY',
  );
});
