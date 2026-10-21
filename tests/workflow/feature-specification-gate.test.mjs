import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fails, initialize, repository, startFeature, succeeds } from './helpers.mjs';

const apiUrl = 'https://api.example.test';
const github = {
  owner: 'example-org',
  name: 'project-x',
  api_url: apiUrl,
  required_reviewers: ['human-reviewer'],
  automation_logins: ['workflow-bot[bot]'],
  required_checks: ['workflow-ci / verify'],
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('a feature leaves requirements only after valid scenario coverage and current human approval', async (t) => {
  let pull;
  let headSha;
  let headRef;
  const reviews = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (init.method === 'GET' && parsed.pathname.endsWith('/pulls')) return response([]);
    if (init.method === 'POST' && parsed.pathname.endsWith('/pulls')) {
      pull = {
        number: 42,
        html_url: 'https://github.example.test/example-org/project-x/pull/42',
        state: 'open',
        draft: true,
        head: { ref: headRef, sha: headSha, repo: { full_name: 'example-org/project-x' } },
        base: { ref: 'main', sha: 'base-sha', repo: { full_name: 'example-org/project-x' } },
        user: { login: 'change-author', type: 'User' },
      };
      return response(pull, 201);
    }
    if (init.method === 'POST' && parsed.pathname.endsWith('/ready_for_review')) {
      pull.draft = false;
      return response(pull);
    }
    if (init.method === 'PUT' && parsed.pathname.endsWith('/pulls/42/merge')) {
      const body = JSON.parse(init.body);
      if (body.sha !== headSha) return response({ merged: false }, 409);
      pull.state = 'closed';
      pull.merged = true;
      pull.merge_commit_sha = 'd'.repeat(40);
      return response({ merged: true, sha: pull.merge_commit_sha });
    }
    if (parsed.pathname.endsWith('/pulls/42/reviews')) return response(reviews);
    if (parsed.pathname.endsWith('/check-runs'))
      return response({
        total_count: 1,
        check_runs: [
          {
            id: 9,
            name: 'workflow-ci / verify',
            head_sha: headSha,
            status: 'completed',
            conclusion: 'success',
          },
        ],
      });
    if (parsed.pathname.endsWith('/status'))
      return response({ sha: headSha, state: 'success', statuses: [] });
    if (parsed.pathname.endsWith('/pulls/42')) {
      pull.head.sha = headSha;
      return response(pull);
    }
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };

  const repo = await repository(t, {
    context: { env: { GH_TOKEN: 'fixture-token', GITHUB_API_URL: apiUrl }, fetchImpl },
  });
  const remote = await mkdtemp(path.join(tmpdir(), 'codex-workflow-feature-gate-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', remote], { windowsHide: true });
  repo.git('remote', 'add', 'origin', remote);
  await repo.write(
    'src/person-name.mjs',
    'export function normalizePersonName(value) {\n  return value;\n}\n',
  );
  repo.git('add', 'src/person-name.mjs');
  repo.git('commit', '-m', 'feat: add person name normalization');
  repo.git('push', '-u', 'origin', 'main');
  await initialize(repo, {
    github,
    commands: {
      focused: {
        command: process.execPath,
        args: ['--test', fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url))],
        timeout_ms: 2_000,
      },
      expected_red: {
        command: process.execPath,
        args: ['--test', 'tests/profile-name.test.mjs'],
        timeout_ms: 2_000,
      },
    },
  });
  const started = await startFeature(repo);
  headRef = started.change.branch;

  const requirementsData = JSON.parse(
    await readFile(
      new URL('../../workflow/bundle/contracts/examples/requirements.valid.json', import.meta.url),
      'utf8',
    ),
  ).data;
  const scenariosData = JSON.parse(
    await readFile(
      new URL('../../workflow/bundle/contracts/examples/scenarios.valid.json', import.meta.url),
      'utf8',
    ),
  ).data;
  const requirements = succeeds(
    await repo.run('artifact.create', {
      change_id: 'F-001',
      id: 'REQS-001',
      type: 'requirements',
      title: 'Feature requirements',
      data: requirementsData,
    }),
    'artifact.create',
  );
  const scenarios = succeeds(
    await repo.run('artifact.create', {
      change_id: 'F-001',
      id: 'SCENARIOS-001',
      type: 'scenarios',
      title: 'Feature scenarios',
      data: scenariosData,
    }),
    'artifact.create',
  );
  await repo.write('README.md', '# Specification reviewed\n');
  const paths = [
    requirements.path,
    requirements.markdown_path,
    scenarios.path,
    scenarios.markdown_path,
    'README.md',
  ];
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-SPECIFICATION',
        role: 'sdlc_spec_author',
        depends_on: [],
        paths,
        verification_profiles: ['focused'],
        outputs: ['Requirements and scenarios with complete stable-ID coverage.'],
      },
    }),
    'task.prepare',
  );
  const checkpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-SPECIFICATION',
      paths,
      message: 'docs(F-001): specify feature behavior',
    }),
    'change.checkpoint',
  );
  headSha = checkpoint.commit_sha;
  succeeds(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure');
  const specificationRun = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  ).run;
  const specificationResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-SPECIFICATION',
      run_ids: [specificationRun.id],
    }),
    'task.record_result',
  );

  const specCheck = succeeds(
    await repo.run('spec.validate', {
      requirements_path: requirements.path,
      scenarios_path: scenarios.path,
    }),
    'spec.validate',
  );
  assert.equal(specCheck.valid, true);
  const missingApproval = succeeds(
    await repo.run('stage.inspect', { change_id: 'F-001' }),
    'stage.inspect',
  );
  assert.equal(missingApproval.transition.supported, true);
  assert.equal(missingApproval.transition.to, 'PLANNING');
  assert.equal(missingApproval.transition.ready, false);

  const requirementPending = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQS-001' }),
    'decision.ingest',
  );
  const scenarioPending = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'SCENARIOS-001' }),
    'decision.ingest',
  );
  assert.equal(requirementPending.status, 'AWAITING_HUMAN');
  assert.equal(scenarioPending.status, 'AWAITING_HUMAN');
  reviews.push({
    id: 1,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: `Specification accepted.\n${requirementPending.required_marker}\n${scenarioPending.required_marker}\n${specificationResult.task.result.review_marker}`,
  });
  for (const artifact_id of ['REQS-001', 'SCENARIOS-001']) {
    const decision = succeeds(
      await repo.run('decision.ingest', { change_id: 'F-001', artifact_id }),
      'decision.ingest',
    );
    assert.equal(decision.status, 'APPROVED');
  }
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-SPECIFICATION' }),
    'review.resolve',
  );

  const gate = succeeds(await repo.run('stage.inspect', { change_id: 'F-001' }), 'stage.inspect');
  assert.equal(gate.transition.ready, true);
  const state = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  fails(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      expected_stage: 'REQUIREMENTS',
      expected_revision: state.revision - 1,
      to: 'PLANNING',
    }),
    'stage.advance',
    'STALE_REVISION',
  );
  const advanced = succeeds(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      expected_stage: 'REQUIREMENTS',
      expected_revision: state.revision,
      to: 'PLANNING',
    }),
    'stage.advance',
  );
  assert.equal(advanced.change.stage, 'PLANNING');
  const planData = {
    specification_ref: 'REQS-001 + SCENARIOS-001',
    increments: [
      {
        id: 'I-001',
        goal: 'Normalize surrounding whitespace from a person name.',
        scenario_ids: ['SC-001'],
      },
      {
        id: 'I-002',
        goal: 'Preserve the normalized name in the person display.',
        scenario_ids: ['SC-001'],
      },
    ],
    tasks: [
      {
        id: 'T-TESTS',
        increment_id: 'I-001',
        role: 'test_author',
        depends_on: [],
        paths: ['tests/profile-name.test.mjs'],
        scenario_ids: ['SC-001'],
        outputs: ['A readable test requires trimming surrounding whitespace.'],
        verification_profiles: ['expected_red'],
      },
      {
        id: 'T-IMPLEMENT',
        increment_id: 'I-001',
        role: 'implementer',
        depends_on: ['T-TESTS'],
        paths: ['src/person-name.mjs'],
        scenario_ids: ['SC-001'],
        outputs: ["Trim surrounding whitespace from a person's name."],
        verification_profiles: ['focused'],
      },
      {
        id: 'T-TESTS-2',
        increment_id: 'I-002',
        role: 'test_author',
        depends_on: ['T-IMPLEMENT'],
        paths: ['tests/profile-name.test.mjs'],
        scenario_ids: ['SC-001'],
        outputs: ['A readable test verifies the normalized name in the person display.'],
        verification_profiles: ['expected_red'],
      },
      {
        id: 'T-IMPLEMENT-2',
        increment_id: 'I-002',
        role: 'implementer',
        depends_on: ['T-TESTS-2'],
        paths: ['src/person-name.mjs'],
        scenario_ids: ['SC-001'],
        outputs: ['Preserve the normalized value in the person display.'],
        verification_profiles: ['focused'],
      },
    ],
    coverage: [{ scenario_id: 'SC-001', increment_id: 'I-001' }],
    verification_schedule: [{ profile: 'expected_red', trigger: 'test task' }],
    risks: [],
  };
  const plan = succeeds(
    await repo.run('artifact.create', {
      change_id: 'F-001',
      id: 'PLAN-001',
      type: 'implementation-plan',
      title: 'Reviewed vertical implementation plan',
      data: planData,
    }),
    'artifact.create',
  );
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-PLAN',
        role: 'sdlc_planner',
        depends_on: [],
        paths: [plan.path, plan.markdown_path],
        verification_profiles: ['focused'],
        outputs: ['A small vertical plan covering each accepted scenario.'],
      },
    }),
    'task.prepare',
  );
  const planCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-PLAN',
      paths: [plan.path, plan.markdown_path],
      message: 'docs(F-001): plan the accepted feature increment',
    }),
    'change.checkpoint',
  );
  headSha = planCheckpoint.commit_sha;
  const planningRun = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  ).run;
  const planningResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-PLAN',
      run_ids: [planningRun.id],
    }),
    'task.record_result',
  );
  const pendingPlan = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'PLAN-001' }),
    'decision.ingest',
  );
  assert.equal(pendingPlan.status, 'AWAITING_HUMAN');
  const unapprovedPlanGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'F-001' }),
    'stage.inspect',
  );
  assert.equal(unapprovedPlanGate.transition.ready, false);
  const unapprovedPlanState = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  fails(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      expected_stage: 'PLANNING',
      expected_revision: unapprovedPlanState.revision,
      to: 'IMPLEMENTATION',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
  reviews.push({
    id: 2,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: `${pendingPlan.required_marker}\n${planningResult.task.result.review_marker}`,
  });
  const planApproval = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'PLAN-001' }),
    'decision.ingest',
  );
  assert.equal(planApproval.status, 'APPROVED');
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-PLAN' }),
    'review.resolve',
  );
  const planGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'F-001' }),
    'stage.inspect',
  );
  assert.equal(planGate.transition.to, 'IMPLEMENTATION');
  assert.equal(planGate.transition.ready, true);
  const planState = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const implementationStage = succeeds(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      expected_stage: 'PLANNING',
      expected_revision: planState.revision,
      to: 'IMPLEMENTATION',
    }),
    'stage.advance',
  );
  assert.equal(implementationStage.change.stage, 'IMPLEMENTATION');
  fails(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-TESTS',
        role: 'sdlc_test_author',
        increment_id: 'I-001',
        scenario_ids: ['SC-001'],
        depends_on: [],
        paths: ['tests/profile-name.test.mjs'],
        verification_profiles: ['expected_red'],
        outputs: ['A different test outcome than the reviewed plan.'],
      },
    }),
    'task.prepare',
    'PLAN_MISMATCH',
  );
  await repo.write(
    'tests/profile-name.test.mjs',
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { normalizePersonName } from '../src/person-name.mjs';",
      '',
      'test("trims whitespace from a person name", () => {',
      "  assert.equal(normalizePersonName(' Ada '), 'Ada');",
      '});',
      '',
    ].join('\n'),
  );
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-TESTS',
        role: 'sdlc_test_author',
        increment_id: 'I-001',
        scenario_ids: ['SC-001'],
        depends_on: [],
        paths: ['tests/profile-name.test.mjs'],
        verification_profiles: ['expected_red'],
        outputs: ['A readable test requires trimming surrounding whitespace.'],
      },
    }),
    'task.prepare',
  );
  const redCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-TESTS',
      paths: ['tests/profile-name.test.mjs'],
      message: 'test(F-001): specify person name trimming',
    }),
    'change.checkpoint',
  );
  headSha = redCheckpoint.commit_sha;
  const redRun = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'expected_red' }),
    'tests.run',
  ).run;
  assert.equal(redRun.classification, 'ASSERTION_FAILURE');
  succeeds(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: redRun.id,
      phase: 'RED',
      expected_failure: {
        test_id: 'trims whitespace from a person name',
        message: 'Expected values to be strictly equal',
      },
    }),
    'tdd.record',
  );
  const redResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-TESTS',
      run_ids: [redRun.id],
    }),
    'task.record_result',
  );
  const blockedImplementation = succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-IMPLEMENT',
        role: 'sdlc_implementer',
        increment_id: 'I-001',
        scenario_ids: ['SC-001'],
        depends_on: ['T-TESTS'],
        paths: ['src/person-name.mjs'],
        verification_profiles: ['focused'],
        outputs: ["Trim surrounding whitespace from a person's name."],
      },
    }),
    'task.prepare',
  );
  assert.equal(blockedImplementation.task.state, 'WAITING_DEPENDENCY');
  fails(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-IMPLEMENT',
      paths: ['src/person-name.mjs'],
      message: 'feat(F-001): trim person names',
    }),
    'change.checkpoint',
    'TDD_REQUIRED',
  );
  reviews.push({
    id: 2,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: redResult.task.result.review_marker,
  });
  const testReview = succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-TESTS' }),
    'review.resolve',
  );
  assert.deepEqual(testReview.unblocked_task_ids, ['T-IMPLEMENT']);
  reviews.push({
    id: 3,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'CHANGES_REQUESTED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: redResult.task.result.review_marker,
  });
  const revokedTestReview = succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-TESTS' }),
    'review.resolve',
  );
  assert.equal(revokedTestReview.accepted, false);
  assert.deepEqual(revokedTestReview.blocked_task_ids, ['T-IMPLEMENT']);
  reviews.push({
    id: 4,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: redResult.task.result.review_marker,
  });
  const restoredTestReview = succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-TESTS' }),
    'review.resolve',
  );
  assert.equal(restoredTestReview.review.status, 'ACCEPTED');
  assert.deepEqual(restoredTestReview.unblocked_task_ids, ['T-IMPLEMENT']);
  const implementationReady = succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-IMPLEMENT',
        role: 'sdlc_implementer',
        increment_id: 'I-001',
        scenario_ids: ['SC-001'],
        depends_on: ['T-TESTS'],
        paths: ['src/person-name.mjs'],
        verification_profiles: ['focused'],
        outputs: ["Trim surrounding whitespace from a person's name."],
      },
    }),
    'task.prepare',
  );
  assert.equal(implementationReady.task.state, 'READY');
  await repo.write(
    'src/person-name.mjs',
    'export function normalizePersonName(value) {\n  return value.trim();\n}\n',
  );
  const implementationCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-IMPLEMENT',
      paths: ['src/person-name.mjs'],
      message: 'feat(F-001): trim person names',
    }),
    'change.checkpoint',
  );
  headSha = implementationCheckpoint.commit_sha;
  const greenRun = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  ).run;
  assert.equal(greenRun.classification, 'PASS');
  const implementationResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-IMPLEMENT',
      run_ids: [greenRun.id],
    }),
    'task.record_result',
  );
  assert.equal(implementationResult.task.state, 'WAITING_REVIEW');
  const incompleteIncrement = succeeds(
    await repo.run('increment.inspect', { change_id: 'F-001' }),
    'increment.inspect',
  );
  assert.equal(incompleteIncrement.ready, false);
  assert.ok(incompleteIncrement.missing.some((item) => item.reason === 'task_review_incomplete'));
  fails(
    await repo.run('increment.advance', {
      change_id: 'F-001',
      increment_id: 'I-001',
      expected_revision: incompleteIncrement.state_revision,
    }),
    'increment.advance',
    'GATE_BLOCKED',
  );
  reviews.push({
    id: 5,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: implementationResult.task.result.review_marker,
  });
  const implementationReview = succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-IMPLEMENT' }),
    'review.resolve',
  );
  assert.equal(implementationReview.task.state, 'DONE');
  fails(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-TESTS-2',
        role: 'sdlc_test_author',
        increment_id: 'I-002',
        scenario_ids: ['SC-001'],
        depends_on: ['T-IMPLEMENT'],
        paths: ['tests/profile-name.test.mjs'],
        verification_profiles: ['expected_red'],
        outputs: ['A readable test verifies the normalized name in the person display.'],
      },
    }),
    'task.prepare',
    'INCREMENT_BLOCKED',
  );
  const completeIncrement = succeeds(
    await repo.run('increment.inspect', { change_id: 'F-001' }),
    'increment.inspect',
  );
  assert.equal(completeIncrement.ready, true);
  const incrementAdvanced = succeeds(
    await repo.run('increment.advance', {
      change_id: 'F-001',
      increment_id: 'I-001',
      expected_revision: completeIncrement.state_revision,
    }),
    'increment.advance',
  );
  assert.equal(incrementAdvanced.completed, true);
  const nextIncrement = succeeds(
    await repo.run('increment.inspect', { change_id: 'F-001' }),
    'increment.inspect',
  );
  assert.equal(nextIncrement.increment.id, 'I-002');
  assert.equal(nextIncrement.ready, false);
  const secondIncrementTask = succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-TESTS-2',
        role: 'sdlc_test_author',
        increment_id: 'I-002',
        scenario_ids: ['SC-001'],
        depends_on: ['T-IMPLEMENT'],
        paths: ['tests/profile-name.test.mjs'],
        verification_profiles: ['expected_red'],
        outputs: ['A readable test verifies the normalized name in the person display.'],
      },
    }),
    'task.prepare',
  );
  assert.equal(secondIncrementTask.task.state, 'READY');
  await repo.write(
    'tests/profile-name.test.mjs',
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { normalizePersonName } from '../src/person-name.mjs';",
      '',
      'test("trims whitespace from a person name", () => {',
      "  assert.equal(normalizePersonName(' Ada '), 'Ada');",
      '});',
      '',
      'test("normalizes canonically equivalent names", () => {',
      "  assert.equal(normalizePersonName('e\\u0301'), '\\u00e9');",
      '});',
      '',
    ].join('\n'),
  );
  const secondRedCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-TESTS-2',
      paths: ['tests/profile-name.test.mjs'],
      message: 'test(F-001): cover canonical Unicode names',
    }),
    'change.checkpoint',
  );
  headSha = secondRedCheckpoint.commit_sha;
  const secondRedRun = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'expected_red' }),
    'tests.run',
  ).run;
  assert.equal(secondRedRun.classification, 'ASSERTION_FAILURE');
  succeeds(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: secondRedRun.id,
      phase: 'RED',
      expected_failure: {
        test_id: 'normalizes canonically equivalent names',
        message: 'Expected values to be strictly equal',
      },
    }),
    'tdd.record',
  );
  const secondRedResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-TESTS-2',
      run_ids: [secondRedRun.id],
    }),
    'task.record_result',
  );
  reviews.push({
    id: 6,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: secondRedResult.task.result.review_marker,
  });
  const secondTestReview = succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-TESTS-2' }),
    'review.resolve',
  );
  assert.equal(secondTestReview.task.state, 'DONE');
  const secondImplementerTask = succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-IMPLEMENT-2',
        role: 'sdlc_implementer',
        increment_id: 'I-002',
        scenario_ids: ['SC-001'],
        depends_on: ['T-TESTS-2'],
        paths: ['src/person-name.mjs'],
        verification_profiles: ['focused'],
        outputs: ['Preserve the normalized value in the person display.'],
      },
    }),
    'task.prepare',
  );
  assert.equal(secondImplementerTask.task.state, 'READY');
  await repo.write(
    'src/person-name.mjs',
    "export function normalizePersonName(value) {\n  return value.trim().normalize('NFC');\n}\n",
  );
  const secondImplementationCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-IMPLEMENT-2',
      paths: ['src/person-name.mjs'],
      message: 'feat(F-001): normalize canonical Unicode names',
    }),
    'change.checkpoint',
  );
  headSha = secondImplementationCheckpoint.commit_sha;
  const secondGreenRun = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  ).run;
  assert.equal(secondGreenRun.classification, 'PASS');
  succeeds(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: secondGreenRun.id,
      phase: 'GREEN',
    }),
    'tdd.record',
  );
  const secondImplementationResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-IMPLEMENT-2',
      run_ids: [secondGreenRun.id],
    }),
    'task.record_result',
  );
  const awaitingImplementationReview = succeeds(
    await repo.run('increment.inspect', { change_id: 'F-001' }),
    'increment.inspect',
  );
  assert.equal(awaitingImplementationReview.ready, false);
  fails(
    await repo.run('increment.advance', {
      change_id: 'F-001',
      increment_id: 'I-002',
      expected_revision: awaitingImplementationReview.state_revision,
    }),
    'increment.advance',
    'GATE_BLOCKED',
  );
  reviews.push({
    id: 7,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: secondImplementationResult.task.result.review_marker,
  });
  const secondImplementationReview = succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-IMPLEMENT-2' }),
    'review.resolve',
  );
  assert.equal(secondImplementationReview.task.state, 'DONE');
  const secondIncrementReady = succeeds(
    await repo.run('increment.inspect', { change_id: 'F-001' }),
    'increment.inspect',
  );
  assert.equal(secondIncrementReady.ready, true);
  const secondIncrementAdvanced = succeeds(
    await repo.run('increment.advance', {
      change_id: 'F-001',
      increment_id: 'I-002',
      expected_revision: secondIncrementReady.state_revision,
    }),
    'increment.advance',
  );
  assert.equal(secondIncrementAdvanced.completed, true);
  reviews.push({
    id: 8,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'CHANGES_REQUESTED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: secondImplementationResult.task.result.review_marker,
  });
  const integrationGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'F-001' }),
    'stage.inspect',
  );
  assert.equal(integrationGate.transition.to, 'INTEGRATION');
  assert.equal(integrationGate.transition.ready, true);
  const integrationState = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  fails(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      expected_stage: 'IMPLEMENTATION',
      expected_revision: integrationState.revision,
      to: 'INTEGRATION',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
  reviews.push({
    id: 9,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: secondImplementationResult.task.result.review_marker,
  });
  const refreshedIntegrationState = succeeds(
    await repo.run('workflow.inspect'),
    'workflow.inspect',
  );
  const integrationStage = succeeds(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      expected_stage: 'IMPLEMENTATION',
      expected_revision: refreshedIntegrationState.revision,
      to: 'INTEGRATION',
    }),
    'stage.advance',
  );
  assert.equal(integrationStage.change.stage, 'INTEGRATION');
  const pendingIntegrationDecision = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'PLAN-001' }),
    'decision.ingest',
  );
  assert.equal(pendingIntegrationDecision.status, 'AWAITING_HUMAN');
  reviews.push({
    id: 10,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: pendingIntegrationDecision.required_marker,
  });
  const integrationDecision = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'PLAN-001' }),
    'decision.ingest',
  );
  assert.equal(integrationDecision.status, 'APPROVED');
  const readyPullRequest = succeeds(
    await repo.run('pr.mark_ready', { change_id: 'F-001' }),
    'pr.mark_ready',
  );
  assert.equal(readyPullRequest.head_sha, headSha);
  assert.equal(readyPullRequest.ci.all_passed, true);
  const mergedFeature = succeeds(
    await repo.run('change.squash_merge', { change_id: 'F-001' }),
    'change.squash_merge',
  );
  assert.equal(mergedFeature.merged, true);
  assert.equal(mergedFeature.merge_method, 'squash');
  assert.equal(mergedFeature.head_sha, headSha);
  assert.equal(mergedFeature.merge_commit_sha, 'd'.repeat(40));
  const completionGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'F-001' }),
    'stage.inspect',
  );
  assert.equal(completionGate.transition.to, 'COMPLETE');
  assert.equal(completionGate.transition.ready, true);
  assert.deepEqual(completionGate.transition.missing, []);
});

test('feature planning remains blocked when scenarios do not cover registered requirements', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  const requirementsData = JSON.parse(
    await readFile(
      new URL('../../workflow/bundle/contracts/examples/requirements.valid.json', import.meta.url),
      'utf8',
    ),
  ).data;
  const scenariosData = JSON.parse(
    await readFile(
      new URL('../../workflow/bundle/contracts/examples/scenarios.valid.json', import.meta.url),
      'utf8',
    ),
  ).data;
  scenariosData.scenarios[0].requirement_ids = ['REQ-UNKNOWN'];
  const requirements = succeeds(
    await repo.run('artifact.create', {
      change_id: 'F-001',
      id: 'REQS-001',
      type: 'requirements',
      title: 'Feature requirements',
      data: requirementsData,
    }),
    'artifact.create',
  );
  const scenarios = succeeds(
    await repo.run('artifact.create', {
      change_id: 'F-001',
      id: 'SCENARIOS-001',
      type: 'scenarios',
      title: 'Feature scenarios',
      data: scenariosData,
    }),
    'artifact.create',
  );
  const paths = [requirements.path, scenarios.path];
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-SPECIFICATION',
        role: 'sdlc_spec_author',
        depends_on: [],
        paths,
        verification_profiles: [],
        outputs: ['A schema-valid but cross-reference-invalid specification.'],
      },
    }),
    'task.prepare',
  );
  succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-SPECIFICATION',
      paths,
      message: 'docs(F-001): add incomplete scenario coverage',
      push: false,
    }),
    'change.checkpoint',
  );
  const gate = succeeds(await repo.run('stage.inspect', { change_id: 'F-001' }), 'stage.inspect');
  assert.equal(gate.transition.ready, false);
  assert.ok(
    gate.transition.missing.some((item) => item.reason === 'specification_coverage_invalid'),
  );
  const state = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  fails(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      expected_stage: 'REQUIREMENTS',
      expected_revision: state.revision,
      to: 'PLANNING',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
});
