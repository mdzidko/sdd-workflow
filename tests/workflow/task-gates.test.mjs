import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fails, initialize, repository, startFeature, stateBytes, succeeds } from './helpers.mjs';

function implementationTask(overrides = {}) {
  return {
    id: 'T-001',
    role: 'sdlc_documentation_author',
    depends_on: [],
    paths: ['src/person.mjs'],
    verification_profiles: ['focused'],
    outputs: ['A valid person can be saved.'],
    ...overrides,
  };
}

async function preparedChange(t) {
  const repo = await repository(t);
  const passingFixture = fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url));
  await initialize(repo, {
    commands: {
      focused: { command: process.execPath, args: ['--test', passingFixture], timeout_ms: 2_000 },
    },
  });
  await startFeature(repo);
  return repo;
}

async function preparedRedTest(t) {
  const repo = await repository(t);
  const remote = await mkdtemp(path.join(tmpdir(), 'codex-workflow-red-review-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', remote], { windowsHide: true });
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '-u', 'origin', 'main');
  const redFixture = fileURLToPath(new URL('./fixtures/failing-assertion.mjs', import.meta.url));
  await initialize(repo, {
    commands: {
      expected_red: {
        command: process.execPath,
        args: ['--test', redFixture],
        timeout_ms: 2_000,
      },
    },
  });
  await startFeature(repo);
  await repo.write('README.md', '# Reviewed failing test first\n');
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-TESTS',
        role: 'sdlc_test_author',
        depends_on: [],
        paths: ['README.md'],
        verification_profiles: ['expected_red'],
        outputs: ['A regression assertion for cyclic parent relationships.'],
      },
    }),
    'task.prepare',
  );
  succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-TESTS',
      paths: ['README.md'],
      message: 'test(F-001): add cycle regression assertion',
    }),
    'change.checkpoint',
  );
  const run = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'expected_red' }),
    'tests.run',
  ).run;
  return { repo, run };
}

async function preparedNoFileMaintenance(t, outcome = 'NO_FILE') {
  const repo = await repository(t);
  const passingFixture = fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url));
  await initialize(repo, {
    commands: {
      focused: { command: process.execPath, args: ['--test', passingFixture], timeout_ms: 2_000 },
    },
  });
  succeeds(
    await repo.run('change.start', {
      id: 'M-NO-FILE',
      kind: 'MAINTENANCE',
      description: 'Confirm that the requested behavior already exists.',
    }),
    'change.start',
  );
  const taskAuthor = {
    id: 'T-NO-FILE-TEST',
    increment_id: 'I-NO-FILE',
    role: 'test_author',
    depends_on: [],
    paths: [],
    scenario_ids: ['SC-NO-FILE'],
    outputs: ['Run and review the existing behavior checks.'],
    verification_profiles: ['focused'],
  };
  const implementer = {
    id: 'T-NO-FILE-VERIFY',
    increment_id: 'I-NO-FILE',
    role: 'implementer',
    depends_on: [taskAuthor.id],
    paths: [],
    scenario_ids: ['SC-NO-FILE'],
    outputs: ['Confirm that no source change is required.'],
    verification_profiles: ['focused'],
  };
  const plan = {
    outcome,
    no_file_rationale: 'The current behavior already satisfies the accepted scenario.',
    increments: [
      {
        id: 'I-NO-FILE',
        goal: 'Verify the accepted behavior without changing application files.',
        scenario_ids: ['SC-NO-FILE'],
      },
    ],
    tasks: [taskAuthor, implementer],
  };
  const planned = succeeds(
    await repo.run('plan.validate', { plan, scenario_ids: ['SC-NO-FILE'] }),
    'plan.validate',
  );
  assert.equal(planned.valid, true);
  succeeds(
    await repo.run('artifact.create', {
      change_id: 'M-NO-FILE',
      id: 'PLAN-NO-FILE',
      type: 'implementation-plan',
      title: 'Verify the existing behavior without file changes',
      data: {
        ...plan,
        specification_ref: 'REQ-NO-FILE',
        coverage: [{ scenario_id: 'SC-NO-FILE', task_ids: [taskAuthor.id, implementer.id] }],
        verification_schedule: [{ phase: 'task', profiles: ['focused'] }],
        risks: [],
      },
    }),
    'artifact.create',
  );
  const run = succeeds(
    await repo.run('tests.run', { change_id: 'M-NO-FILE', profile: 'focused' }),
    'tests.run',
  ).run;
  const state = JSON.parse(await stateBytes(repo));
  const change = state.changes['M-NO-FILE'];
  const planRef = change.artifacts.find((entry) => entry.id === 'PLAN-NO-FILE');
  change.stage = 'IMPLEMENTATION';
  change.stage_history = [
    {
      to: 'IMPLEMENTATION',
      evidence: [
        {
          type: 'implementation-plan',
          artifact_id: 'PLAN-NO-FILE',
          content_hash: planRef.content_hash,
        },
      ],
    },
  ];
  change.tasks[taskAuthor.id] = {
    ...taskAuthor,
    definition: taskAuthor,
    state: 'DONE',
    review: {
      status: 'ACCEPTED',
      provider: 'workflow_verification',
      reviewer: 'automated_checks',
    },
    result: { verification_mode: 'GREEN', run_ids: [run.id] },
  };
  await repo.write('.workflow/state.json', `${JSON.stringify(state, null, 2)}\n`);
  return { repo, implementer };
}

async function preparedNoFileMaintenanceWithReviews(t) {
  const reviews = [];
  let pull;
  let headSha;
  let headRef;
  const apiUrl = 'https://api.example.test';
  const response = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (init.method === 'GET' && parsed.pathname.endsWith('/pulls'))
      return response(pull ? [pull] : []);
    if (init.method === 'POST' && parsed.pathname.endsWith('/pulls')) {
      pull = {
        number: 42,
        html_url: 'https://github.example.test/example-org/project-x/pull/42',
        state: 'open',
        draft: false,
        head: {
          ref: headRef,
          sha: headSha,
          repo: { full_name: 'example-org/project-x' },
        },
        base: {
          ref: 'main',
          sha: 'base-sha',
          repo: { full_name: 'example-org/project-x' },
        },
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
      pull.merge_commit_sha = 'c'.repeat(40);
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
  const remote = await mkdtemp(path.join(tmpdir(), 'codex-workflow-maintenance-review-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', remote], { windowsHide: true });
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '-u', 'origin', 'main');
  const passingFixture = fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url));
  await initialize(repo, {
    github: {
      owner: 'example-org',
      name: 'project-x',
      api_url: apiUrl,
      required_reviewers: ['human-reviewer'],
      automation_logins: ['workflow-bot[bot]'],
      required_checks: ['workflow-ci / verify'],
    },
    commands: {
      focused: { command: process.execPath, args: ['--test', passingFixture], timeout_ms: 2_000 },
    },
  });
  const started = succeeds(
    await repo.run('change.start', {
      id: 'M-REVIEWED-NO-FILE',
      kind: 'MAINTENANCE',
      description: 'Confirm that the requested behavior already exists.',
    }),
    'change.start',
  );
  headRef = started.change.branch;
  const taskAuthor = {
    id: 'T-NO-FILE-TEST',
    increment_id: 'I-NO-FILE',
    role: 'test_author',
    depends_on: [],
    paths: [],
    scenario_ids: ['SC-NO-FILE'],
    outputs: ['Run and review the existing behavior checks.'],
    verification_profiles: ['focused'],
  };
  const implementer = {
    id: 'T-NO-FILE-VERIFY',
    increment_id: 'I-NO-FILE',
    role: 'implementer',
    depends_on: [taskAuthor.id],
    paths: [],
    scenario_ids: ['SC-NO-FILE'],
    outputs: ['Confirm that no source change is required.'],
    verification_profiles: ['focused'],
  };
  const plan = {
    outcome: 'NO_FILE',
    no_file_rationale: 'The current behavior already satisfies the accepted scenario.',
    increments: [
      {
        id: 'I-NO-FILE',
        goal: 'Verify the accepted behavior without changing application files.',
        scenario_ids: ['SC-NO-FILE'],
      },
    ],
    tasks: [taskAuthor, implementer],
  };
  succeeds(
    await repo.run('plan.validate', { plan, scenario_ids: ['SC-NO-FILE'] }),
    'plan.validate',
  );
  const artifact = succeeds(
    await repo.run('artifact.create', {
      change_id: 'M-REVIEWED-NO-FILE',
      id: 'PLAN-NO-FILE',
      type: 'implementation-plan',
      title: 'Verify the existing behavior without file changes',
      data: {
        ...plan,
        specification_ref: 'REQ-NO-FILE',
        coverage: [{ scenario_id: 'SC-NO-FILE', task_ids: [taskAuthor.id, implementer.id] }],
        verification_schedule: [{ phase: 'task', profiles: ['focused'] }],
        risks: [],
      },
    }),
    'artifact.create',
  );
  const planTask = {
    id: 'T-NO-FILE-PLAN',
    role: 'sdlc_planner',
    depends_on: [],
    paths: [artifact.path, artifact.markdown_path],
    verification_profiles: ['focused'],
    outputs: ['A reviewed incremental no-file maintenance plan.'],
  };
  succeeds(
    await repo.run('task.prepare', { change_id: 'M-REVIEWED-NO-FILE', task: planTask }),
    'task.prepare',
  );
  const planRun = succeeds(
    await repo.run('tests.run', {
      change_id: 'M-REVIEWED-NO-FILE',
      profile: 'focused',
    }),
    'tests.run',
  ).run;
  const planCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'M-REVIEWED-NO-FILE',
      task_id: planTask.id,
      paths: planTask.paths,
      message: 'docs(M-REVIEWED-NO-FILE): record no-file plan',
    }),
    'change.checkpoint',
  );
  headSha = planCheckpoint.commit_sha;
  const planResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'M-REVIEWED-NO-FILE',
      task_id: planTask.id,
      run_ids: [planRun.id],
    }),
    'task.record_result',
  );
  succeeds(await repo.run('pr.ensure', { change_id: 'M-REVIEWED-NO-FILE' }), 'pr.ensure');
  reviews.push({
    id: 1,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: planResult.task.result.review_marker,
  });
  succeeds(
    await repo.run('review.resolve', {
      change_id: 'M-REVIEWED-NO-FILE',
      task_id: planTask.id,
    }),
    'review.resolve',
  );

  const state = JSON.parse(await stateBytes(repo));
  const change = state.changes['M-REVIEWED-NO-FILE'];
  const planRef = change.artifacts.find((entry) => entry.id === 'PLAN-NO-FILE');
  change.stage = 'IMPLEMENTATION';
  change.stage_history = [
    {
      to: 'IMPLEMENTATION',
      evidence: [
        {
          type: 'implementation-plan',
          artifact_id: 'PLAN-NO-FILE',
          content_hash: planRef.content_hash,
        },
      ],
    },
  ];
  await repo.write('.workflow/state.json', `${JSON.stringify(state, null, 2)}\n`);
  return {
    repo,
    taskAuthor,
    implementer,
    headSha,
    reviews,
    confirmUserMerge() {
      pull.state = 'closed';
      pull.merged = true;
      pull.merge_commit_sha = 'c'.repeat(40);
    },
    approve(task) {
      reviews.push({
        id: reviews.length + 1,
        user: { login: 'human-reviewer', type: 'User' },
        state: 'APPROVED',
        commit_id: headSha,
        submitted_at: new Date().toISOString(),
        body: task.result.review_marker,
      });
    },
    approveDecision(marker) {
      reviews.push({
        id: reviews.length + 1,
        user: { login: 'human-reviewer', type: 'User' },
        state: 'APPROVED',
        commit_id: headSha,
        submitted_at: new Date().toISOString(),
        body: marker,
      });
    },
  };
}

test('task preparation records bounded ownership, dependencies and required verification without declaring completion', async (t) => {
  const repo = await preparedChange(t);
  const prepared = succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: implementationTask(),
    }),
    'task.prepare',
  );
  assert.equal(prepared.task.id, 'T-001');
  assert.equal(prepared.task.state, 'READY');
  assert.deepEqual(prepared.task.paths, ['src/person.mjs']);
  assert.deepEqual(prepared.task.verification_profiles, ['focused']);
});

test('task preparation rejects a missing prerequisite instead of scheduling disconnected work', async (t) => {
  const repo = await preparedChange(t);
  fails(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: implementationTask({ depends_on: ['T-404'] }),
    }),
    'task.prepare',
    'VALIDATION_FAILED',
  );
});

test('a reviewed no-file maintenance plan accepts GREEN verification and records no empty commit', async (t) => {
  const { repo, implementer } = await preparedNoFileMaintenance(t);
  const prepared = succeeds(
    await repo.run('task.prepare', { change_id: 'M-NO-FILE', task: implementer }),
    'task.prepare',
  );
  assert.equal(prepared.task.state, 'READY');
  const before = repo.git('rev-parse', 'HEAD');
  const checkpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'M-NO-FILE',
      task_id: implementer.id,
      paths: [],
      message: 'chore(M-NO-FILE): verify no maintenance changes are needed',
    }),
    'change.checkpoint',
  );
  assert.equal(checkpoint.no_changes, true);
  assert.equal(repo.git('rev-parse', 'HEAD'), before);
  const green = succeeds(
    await repo.run('tests.run', { change_id: 'M-NO-FILE', profile: 'focused' }),
    'tests.run',
  ).run;
  assert.equal(green.classification, 'PASS');
  const state = JSON.parse(await stateBytes(repo));
  const change = state.changes['M-NO-FILE'];
  change.tasks[implementer.id] = {
    ...implementer,
    definition: implementer,
    state: 'DONE',
    review: { status: 'ACCEPTED', reviewer: 'fixture-reviewer' },
    result: { verification_mode: 'GREEN', run_ids: [green.id] },
  };
  await repo.write('.workflow/state.json', `${JSON.stringify(state, null, 2)}\n`);
  const increment = succeeds(
    await repo.run('increment.inspect', { change_id: 'M-NO-FILE' }),
    'increment.inspect',
  );
  assert.equal(increment.ready, true);
  assert.deepEqual(increment.missing, []);
});

test('a no-file maintenance increment requires current GREEN evidence for both tasks', async (t) => {
  const { repo, taskAuthor, implementer, headSha } =
    await preparedNoFileMaintenanceWithReviews(t);

  const preparedTest = succeeds(
    await repo.run('task.prepare', { change_id: 'M-REVIEWED-NO-FILE', task: taskAuthor }),
    'task.prepare',
  );
  assert.equal(preparedTest.task.state, 'READY');
  const testCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'M-REVIEWED-NO-FILE',
      task_id: taskAuthor.id,
      paths: [],
      message: 'test(M-REVIEWED-NO-FILE): verify existing behavior',
    }),
    'change.checkpoint',
  );
  assert.equal(testCheckpoint.no_changes, true);
  assert.equal(testCheckpoint.commit_sha, headSha);
  const testRun = succeeds(
    await repo.run('tests.run', {
      change_id: 'M-REVIEWED-NO-FILE',
      profile: 'focused',
    }),
    'tests.run',
  ).run;
  const testResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'M-REVIEWED-NO-FILE',
      task_id: taskAuthor.id,
      run_ids: [testRun.id],
    }),
    'task.record_result',
  );
  assert.equal(testResult.task.state, 'DONE');
  assert.equal(testResult.task.result.verification_mode, 'GREEN');

  const preparedImplementation = succeeds(
    await repo.run('task.prepare', {
      change_id: 'M-REVIEWED-NO-FILE',
      task: implementer,
    }),
    'task.prepare',
  );
  assert.equal(preparedImplementation.task.state, 'READY');
  const implementationCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'M-REVIEWED-NO-FILE',
      task_id: implementer.id,
      paths: [],
      message: 'chore(M-REVIEWED-NO-FILE): confirm no change is needed',
    }),
    'change.checkpoint',
  );
  assert.equal(implementationCheckpoint.no_changes, true);
  const implementationRun = succeeds(
    await repo.run('tests.run', {
      change_id: 'M-REVIEWED-NO-FILE',
      profile: 'focused',
    }),
    'tests.run',
  ).run;
  const implementationResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'M-REVIEWED-NO-FILE',
      task_id: implementer.id,
      run_ids: [implementationRun.id],
    }),
    'task.record_result',
  );
  assert.equal(implementationResult.task.state, 'DONE');
  assert.equal(implementationResult.task.result.verification_mode, 'GREEN');
  assert.equal(implementationResult.task.review.provider, 'workflow_verification');
  const increment = succeeds(
    await repo.run('increment.inspect', { change_id: 'M-REVIEWED-NO-FILE' }),
    'increment.inspect',
  );
  assert.equal(increment.ready, true);
  assert.deepEqual(increment.missing, []);
});

test('a chat-approved no-file maintenance increment waits for the user to merge without an empty commit', async (t) => {
  const { repo, taskAuthor, implementer, confirmUserMerge, headSha } =
    await preparedNoFileMaintenanceWithReviews(t);

  for (const task of [taskAuthor, implementer]) {
    succeeds(
      await repo.run('task.prepare', { change_id: 'M-REVIEWED-NO-FILE', task }),
      'task.prepare',
    );
    const checkpoint = succeeds(
      await repo.run('change.checkpoint', {
        change_id: 'M-REVIEWED-NO-FILE',
        task_id: task.id,
        paths: [],
        message: `chore(M-REVIEWED-NO-FILE): verify ${task.id}`,
      }),
      'change.checkpoint',
    );
    assert.equal(checkpoint.no_changes, true);
    assert.equal(checkpoint.commit_sha, headSha);
    const run = succeeds(
      await repo.run('tests.run', {
        change_id: 'M-REVIEWED-NO-FILE',
        profile: 'focused',
      }),
      'tests.run',
    ).run;
    const result = succeeds(
      await repo.run('task.record_result', {
        change_id: 'M-REVIEWED-NO-FILE',
        task_id: task.id,
        run_ids: [run.id],
      }),
      'task.record_result',
    );
    assert.equal(result.task.result.verification_mode, 'GREEN');
    assert.equal(result.task.state, 'DONE');
  }

  const inspected = succeeds(
    await repo.run('increment.inspect', { change_id: 'M-REVIEWED-NO-FILE' }),
    'increment.inspect',
  );
  assert.equal(inspected.ready, true);
  succeeds(
    await repo.run('increment.advance', {
      change_id: 'M-REVIEWED-NO-FILE',
      increment_id: inspected.increment.id,
      expected_revision: inspected.state_revision,
    }),
    'increment.advance',
  );
  const transition = succeeds(
    await repo.run('stage.inspect', { change_id: 'M-REVIEWED-NO-FILE' }),
    'stage.inspect',
  );
  succeeds(
    await repo.run('stage.advance', {
      change_id: 'M-REVIEWED-NO-FILE',
      expected_stage: transition.stage,
      expected_revision: transition.transition.state_revision,
      to: 'INTEGRATION',
    }),
    'stage.advance',
  );

  const decision = succeeds(
    await repo.accept('M-REVIEWED-NO-FILE', 'PLAN-NO-FILE'),
    'decision.accept',
  );
  assert.equal(decision.approval.status, 'APPROVED');
  assert.equal((await repo.run('pr.ensure', { change_id: 'M-REVIEWED-NO-FILE' })).data.pull_request.draft, false);
  const pendingMerge = fails(
    await repo.run('change.confirm_merge', { change_id: 'M-REVIEWED-NO-FILE' }),
    'change.confirm_merge',
    'MERGE_PENDING',
  );
  assert.match(pendingMerge.message, /has not been merged/i);
  confirmUserMerge();
  const merged = succeeds(
    await repo.run('change.confirm_merge', { change_id: 'M-REVIEWED-NO-FILE' }),
    'change.confirm_merge',
  );
  assert.equal(merged.merged, true);
  assert.equal(merged.merge_method, 'user');
  assert.equal(merged.head_sha, headSha);
  const complete = succeeds(
    await repo.run('stage.inspect', { change_id: 'M-REVIEWED-NO-FILE' }),
    'stage.inspect',
  );
  assert.equal(complete.transition.to, 'COMPLETE');
  assert.equal(complete.transition.ready, true);
});

test('a normal maintenance plan cannot use GREEN-only evidence to bypass TDD', async (t) => {
  const { repo, implementer } = await preparedNoFileMaintenance(t, 'IMPLEMENTATION');
  fails(
    await repo.run('task.prepare', { change_id: 'M-NO-FILE', task: implementer }),
    'task.prepare',
    'TDD_REQUIRED',
  );
});

test('a test-author task completes automatically only with evidenced behavioral RED', async (t) => {
  const { repo, run } = await preparedRedTest(t);
  assert.equal(run.classification, 'ASSERTION_FAILURE');
  assert.equal(run.failed_tests.length, 1);

  fails(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-IMPLEMENTER',
        role: 'implementer',
        depends_on: [],
        paths: ['README.md'],
        verification_profiles: ['expected_red'],
        outputs: ['The cycle is rejected.'],
      },
    }),
    'task.prepare',
    'GATE_BLOCKED',
  );

  fails(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-TESTS',
      run_ids: [run.id],
    }),
    'task.record_result',
    'INVALID_TDD_EVIDENCE',
  );
  succeeds(
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
  const result = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-TESTS',
      run_ids: [run.id],
    }),
    'task.record_result',
  );
  assert.equal(result.task.state, 'DONE');
  assert.equal(result.task.result.verification_mode, 'EXPECTED_RED');
  assert.deepEqual(result.task.result.expected_red_run_ids, [run.id]);
  assert.equal(result.task.review.provider, 'workflow_verification');
});

test('task ownership cannot escape the target repository', async (t) => {
  const repo = await preparedChange(t);
  fails(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: implementationTask({ paths: ['../outside.mjs'] }),
    }),
    'task.prepare',
    'INVALID_PATH',
  );
});

test('a worker completion claim without evidence cannot mark a task DONE', async (t) => {
  const repo = await preparedChange(t);
  succeeds(
    await repo.run('task.prepare', { change_id: 'F-001', task: implementationTask() }),
    'task.prepare',
  );
  fails(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      status: 'DONE',
      evidence: [],
    }),
    'task.record_result',
    'GATE_BLOCKED',
  );
  const resumed = succeeds(
    await repo.run('workflow.resume', { change_id: 'F-001' }),
    'workflow.resume',
  );
  assert.notEqual(resumed.change.tasks['T-001'].state, 'DONE');
});

test('a real passing run alone cannot replace the task checkpoint and independent review', async (t) => {
  const repo = await preparedChange(t);
  succeeds(
    await repo.run('task.prepare', { change_id: 'F-001', task: implementationTask() }),
    'task.prepare',
  );
  const tested = succeeds(
    await repo.run('tests.run', { profile: 'focused', change_id: 'F-001' }),
    'tests.run',
  );
  assert.equal(tested.run.classification, 'PASS');
  fails(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      status: 'DONE',
      evidence: [{ run_id: tested.run.id }],
    }),
    'task.record_result',
    'GATE_BLOCKED',
  );
});

test('review request records a distinct reviewer role without treating the request as accepted review', async (t) => {
  const repo = await preparedChange(t);
  succeeds(
    await repo.run('task.prepare', { change_id: 'F-001', task: implementationTask() }),
    'task.prepare',
  );
  const requested = succeeds(
    await repo.run('review.request', {
      change_id: 'F-001',
      task_id: 'T-001',
      reviewer_role: 'implementation_reviewer',
    }),
    'review.request',
  );
  assert.equal(requested.review.task_id, 'T-001');
  assert.equal(requested.review.reviewer_role, 'implementation_reviewer');
  assert.notEqual(requested.review.reviewer_role, implementationTask().role);
  fails(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      status: 'DONE',
      evidence: [],
    }),
    'task.record_result',
    'GATE_BLOCKED',
  );
});

test('implementation cannot start before specification approval and reviewed test evidence', async (t) => {
  const repo = await preparedChange(t);
  fails(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      to: 'IMPLEMENTATION',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
  const resumed = succeeds(
    await repo.run('workflow.resume', { change_id: 'F-001' }),
    'workflow.resume',
  );
  assert.equal(resumed.change.stage, 'REQUIREMENTS');
});

test('caller-supplied approval objects cannot bypass an implementation stage gate', async (t) => {
  const repo = await preparedChange(t);
  fails(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      to: 'IMPLEMENTATION',
      approvals: [{ actor: 'human', approved: true, kind: 'business' }],
      reviewed_tests: true,
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
});

test('reusing a change ID for a different description fails without replacing its original intent', async (t) => {
  const repo = await preparedChange(t);
  fails(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Delete every person instead.',
    }),
    'change.start',
    'CHANGE_CONFLICT',
  );
  const resumed = succeeds(
    await repo.run('workflow.resume', { change_id: 'F-001' }),
    'workflow.resume',
  );
  assert.equal(resumed.change.description, 'Allow adding a person.');
});
