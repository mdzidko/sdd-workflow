import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fails, initialize, repository, startFeature, succeeds } from './helpers.mjs';
import { hash } from '../../workflow/lib/support.mjs';

const apiUrl = 'https://api.example.test';
const github = {
  owner: 'example-org',
  name: 'project-x',
  api_url: apiUrl,
  required_reviewers: ['human-reviewer'],
  automation_logins: ['workflow-bot[bot]'],
  required_checks: ['workflow-ci / verify'],
};

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function pullRequest(headSha) {
  return {
    number: 42,
    html_url: 'https://github.example.test/example-org/project-x/pull/42',
    state: 'open',
    draft: true,
    head: {
      ref: 'feature/F-001-allow-adding-a-person',
      sha: headSha,
      repo: { full_name: 'example-org/project-x' },
    },
    base: { ref: 'main', sha: '8aa0a', repo: { full_name: 'example-org/project-x' } },
    user: { login: 'change-author', type: 'User' },
  };
}

async function reviewableTask(
  t,
  {
    reviewsFor = () => [],
    reviewHeaders = {},
    ciConclusion = 'success',
    includeArtifact = false,
    includeSecondArtifact = false,
  } = {},
) {
  let pull;
  let headSha;
  let mergeCalls = 0;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (init.method === 'GET' && parsed.pathname.endsWith('/pulls')) return response([]);
    if (init.method === 'POST' && parsed.pathname.endsWith('/pulls')) {
      pull = pullRequest(headSha);
      return response(pull, 201);
    }
    if (init.method === 'POST' && parsed.pathname.endsWith('/ready_for_review')) {
      pull.draft = false;
      return response(pull);
    }
    if (init.method === 'PUT' && parsed.pathname.endsWith('/pulls/42/merge')) {
      mergeCalls += 1;
      const body = JSON.parse(init.body);
      if (body.sha !== headSha) return response({ merged: false }, 409);
      pull.state = 'closed';
      pull.draft = false;
      pull.merged = true;
      pull.merge_commit_sha = 'b'.repeat(40);
      return response({
        merged: true,
        sha: pull.merge_commit_sha,
        message: 'Pull Request successfully merged',
      });
    }
    if (parsed.pathname.endsWith('/pulls/42/reviews'))
      return response(reviewsFor(headSha), 200, reviewHeaders);
    if (parsed.pathname.endsWith('/check-runs'))
      return response({
        total_count: 1,
        check_runs: [
          {
            id: 9,
            name: 'workflow-ci / verify',
            head_sha: headSha,
            status: 'completed',
            conclusion: ciConclusion,
          },
        ],
      });
    if (parsed.pathname.endsWith('/status'))
      return response({ sha: headSha, state: ciConclusion, statuses: [] });
    if (parsed.pathname.endsWith('/pulls/42')) return response(pull);
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const repo = await repository(t, {
    context: { env: { GH_TOKEN: 'fixture-token', GITHUB_API_URL: apiUrl }, fetchImpl },
  });
  const remote = await mkdtemp(path.join(tmpdir(), 'codex-workflow-github-review-'));
  t.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(remote, { recursive: true, force: true })),
  );
  execFileSync('git', ['init', '--bare', remote], { windowsHide: true });
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '-u', 'origin', 'main');
  const passingFixture = fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url));
  await initialize(repo, {
    github,
    commands: {
      focused: { command: process.execPath, args: ['--test', passingFixture], timeout_ms: 2_000 },
    },
  });
  await startFeature(repo);
  const artifact = includeArtifact
    ? succeeds(
        await repo.run('artifact.create', {
          change_id: 'F-001',
          id: 'REQ-001',
          type: 'requirements',
          title: 'Feature requirements',
          data: { requirements: [{ id: 'R-001', description: 'A person can be added.' }] },
        }),
        'artifact.create',
      )
    : null;
  const secondArtifact = includeSecondArtifact
    ? succeeds(
        await repo.run('artifact.create', {
          change_id: 'F-001',
          id: 'SCENARIOS-001',
          type: 'scenarios',
          title: 'Feature scenarios',
          data: {
            scenarios: [
              {
                id: 'SC-001',
                requirement_ids: ['R-001'],
                given: 'A user is adding a person.',
                when: 'The user saves the person.',
                then: 'The person is available.',
              },
            ],
            requirement_coverage: [{ requirement_id: 'R-001', scenario_ids: ['SC-001'] }],
            decisions: [],
            unknowns: [],
          },
        }),
        'artifact.create',
      )
    : null;
  await repo.write('src/person.mjs', 'export const person = "Ada";\n');
  const ownedPaths = [
    'src/person.mjs',
    ...(artifact ? [artifact.path, artifact.markdown_path] : []),
    ...(secondArtifact ? [secondArtifact.path, secondArtifact.markdown_path] : []),
  ];
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-001',
        role: 'sdlc_documentation_author',
        depends_on: [],
        paths: ownedPaths,
        verification_profiles: ['focused'],
        outputs: ['A person can be represented.'],
      },
    }),
    'task.prepare',
  );
  const run = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  ).run;
  const checkpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-001',
      paths: ownedPaths,
      message: 'feat(F-001): add person',
    }),
    'change.checkpoint',
  );
  const recorded = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      run_ids: [run.id],
    }),
    'task.record_result',
  );
  headSha = checkpoint.commit_sha;
  succeeds(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure');
  return {
    repo,
    task: recorded.task,
    headSha,
    artifact,
    secondArtifact,
    setHeadSha(nextHead) {
      headSha = nextHead;
      if (pull) pull.head.sha = nextHead;
    },
    mergeCallCount: () => mergeCalls,
  };
}

function approval(task, headSha, overrides = {}) {
  return {
    id: 70,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date(Date.parse(task.result.at) + 60_000).toISOString(),
    body: task.result.review_marker,
    ...overrides,
  };
}

test('review resolution requires an authenticated allowlisted approval on the exact task checkpoint', async (t) => {
  let currentTask;
  const { repo, task, headSha } = await reviewableTask(t, {
    reviewsFor: () => [approval(currentTask, headSha)],
  });
  currentTask = task;

  const result = succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
  );
  assert.equal(result.task.state, 'DONE');
  assert.equal(result.review.reviewer, 'human-reviewer');
  assert.equal(result.review.head_sha, headSha);
  assert.equal(result.review.result_marker, task.result.review_marker);
});

test('changes requested starts a bounded repair loop and blocks after three reviewed attempts', async (t) => {
  let currentTask;
  let currentHead;
  let reviewId = 80;
  const harness = await reviewableTask(t, {
    reviewsFor: () => [
      approval(currentTask, currentHead, {
        id: reviewId,
        state: 'CHANGES_REQUESTED',
      }),
    ],
  });
  currentTask = harness.task;
  currentHead = harness.headSha;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      const source = `export const person = "Ada"; // review revision ${attempt}\n`;
      await harness.repo.write('src/person.mjs', source);
      const run = succeeds(
        await harness.repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
        'tests.run',
      ).run;
      const checkpoint = succeeds(
        await harness.repo.run('change.checkpoint', {
          change_id: 'F-001',
          task_id: 'T-001',
          paths: ['src/person.mjs'],
          message: `fix(F-001): address review attempt ${attempt}`,
        }),
        'change.checkpoint',
      );
      harness.setHeadSha(checkpoint.commit_sha);
      const recorded = succeeds(
        await harness.repo.run('task.record_result', {
          change_id: 'F-001',
          task_id: 'T-001',
          run_ids: [run.id],
        }),
        'task.record_result',
      );
      currentTask = recorded.task;
      currentHead = checkpoint.commit_sha;
      reviewId += 1;
      assert.equal(currentTask.result.review_attempt, attempt);
    }

    const resolved = succeeds(
      await harness.repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
      'review.resolve',
    );
    assert.equal(resolved.task.review_attempts, attempt);
    assert.equal(resolved.exhausted, attempt === 3);
    assert.equal(resolved.task.state, attempt === 3 ? 'BLOCKED' : 'CHANGES_REQUESTED');
    assert.equal(resolved.task.result.status, attempt === 3 ? 'BLOCKED' : 'CHANGES_REQUESTED');
  }

  fails(
    await harness.repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-001',
      run_ids: [currentTask.result.run_ids[0]],
    }),
    'task.record_result',
    'TASK_NOT_READY',
  );
});

test('bots, the change author, and non-allowlisted reviewers cannot complete a task', async (t) => {
  let currentTask;
  let currentHead;
  const { repo, task, headSha } = await reviewableTask(t, {
    reviewsFor: () => [
      approval(currentTask, currentHead, { user: { login: 'workflow-bot[bot]', type: 'Bot' } }),
      approval(currentTask, currentHead, {
        id: 71,
        user: { login: 'change-author', type: 'User' },
      }),
      approval(currentTask, currentHead, { id: 72, user: { login: 'stranger', type: 'User' } }),
    ],
  });
  currentTask = task;
  currentHead = headSha;

  fails(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
    'REVIEW_REQUIRED',
  );
});

test('approval is rejected when it targets another commit or lacks the task result marker', async (t) => {
  let currentTask;
  let currentHead;
  const { repo, task, headSha } = await reviewableTask(t, {
    reviewsFor: () => [
      approval(currentTask, 'old-revision'),
      approval(currentTask, currentHead, { id: 71, body: 'Looks good.' }),
    ],
  });
  currentTask = task;
  currentHead = headSha;

  fails(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
    'REVIEW_REQUIRED',
  );
});

test('a later human changes-requested review revokes that reviewer approval', async (t) => {
  let currentTask;
  let currentHead;
  const { repo, task, headSha } = await reviewableTask(t, {
    reviewsFor: () => [
      approval(currentTask, currentHead),
      approval(currentTask, currentHead, {
        id: 71,
        state: 'CHANGES_REQUESTED',
        submitted_at: new Date(Date.parse(currentTask.result.at) + 120_000).toISOString(),
      }),
    ],
  });
  currentTask = task;
  currentHead = headSha;

  const rejected = succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
  );
  assert.equal(rejected.task.state, 'CHANGES_REQUESTED');
  assert.equal(rejected.task.result.status, 'CHANGES_REQUESTED');
  assert.equal(rejected.accepted, false);
});

test('a newer changes-requested review revokes task acceptance before PR readiness', async (t) => {
  let reviews = [];
  const { repo, task, headSha } = await reviewableTask(t, {
    reviewsFor: () => reviews,
  });
  reviews = [approval(task, headSha)];
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
  );
  reviews = [
    approval(task, headSha, {
      id: 71,
      state: 'CHANGES_REQUESTED',
      submitted_at: new Date(Date.parse(task.result.at) + 120_000).toISOString(),
    }),
  ];

  fails(
    await repo.run('pr.mark_ready', { change_id: 'F-001' }),
    'pr.mark_ready',
    'REVIEW_REQUIRED',
  );
  const resumed = succeeds(
    await repo.run('workflow.resume', { change_id: 'F-001' }),
    'workflow.resume',
  );
  assert.equal(resumed.change.tasks['T-001'].state, 'CHANGES_REQUESTED');
});

test('incomplete paginated reviews cannot authorize task completion', async (t) => {
  let currentTask;
  let currentHead;
  const { repo, task, headSha } = await reviewableTask(t, {
    reviewsFor: () => [approval(currentTask, currentHead)],
    reviewHeaders: { link: '<https://api.example.test/page-2>; rel="next"' },
  });
  currentTask = task;
  currentHead = headSha;

  fails(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
    'GITHUB_LIST_INCOMPLETE',
  );
});

test('a pull request becomes ready only after every task is reviewed and current CI passes', async (t) => {
  let currentTask;
  let currentHead;
  const { repo, task, headSha } = await reviewableTask(t, {
    reviewsFor: () => [approval(currentTask, currentHead)],
  });
  currentTask = task;
  currentHead = headSha;

  fails(
    await repo.run('pr.mark_ready', { change_id: 'F-001' }),
    'pr.mark_ready',
    'TASKS_INCOMPLETE',
  );
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
  );
  const ready = succeeds(await repo.run('pr.mark_ready', { change_id: 'F-001' }), 'pr.mark_ready');
  assert.equal(ready.pull_request.draft, false);
  assert.equal(ready.head_sha, headSha);
  assert.equal(ready.ci.all_passed, true);
});

test('accepted task reviews remain valid across later task checkpoints on the same PR branch', async (t) => {
  const reviews = [];
  const harness = await reviewableTask(t, { reviewsFor: () => reviews });
  const { repo, task: firstTask, headSha: firstHead, setHeadSha } = harness;
  reviews.push(approval(firstTask, firstHead));
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: firstTask.id }),
    'review.resolve',
  );

  await repo.write('src/formatting.mjs', 'export const formatPerson = (name) => name.trim();\n');
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-002',
        role: 'sdlc_documentation_author',
        depends_on: [firstTask.id],
        paths: ['src/formatting.mjs'],
        verification_profiles: ['focused'],
        outputs: ['A whitespace-padded display name is formatted consistently.'],
      },
    }),
    'task.prepare',
  );
  const run = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  ).run;
  const checkpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-002',
      paths: ['src/formatting.mjs'],
      message: 'feat(F-001): format person display name',
    }),
    'change.checkpoint',
  );
  setHeadSha(checkpoint.commit_sha);
  const secondTask = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-002',
      run_ids: [run.id],
    }),
    'task.record_result',
  ).task;
  reviews.push(approval(secondTask, checkpoint.commit_sha));
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: secondTask.id }),
    'review.resolve',
  );

  const ready = succeeds(await repo.run('pr.mark_ready', { change_id: 'F-001' }), 'pr.mark_ready');
  assert.equal(ready.head_sha, checkpoint.commit_sha);
  assert.equal(ready.pull_request.draft, false);

  reviews.push(
    approval(firstTask, firstHead, {
      id: 71,
      state: 'CHANGES_REQUESTED',
      submitted_at: new Date(Date.parse(firstTask.result.at) + 120_000).toISOString(),
    }),
  );
  fails(
    await repo.run('pr.mark_ready', { change_id: 'F-001' }),
    'pr.mark_ready',
    'REVIEW_REQUIRED',
  );
  const resumed = succeeds(
    await repo.run('workflow.resume', { change_id: 'F-001' }),
    'workflow.resume',
  );
  assert.equal(resumed.change.tasks[firstTask.id].state, 'CHANGES_REQUESTED');
});

test('a failing required CI check prevents a pull request becoming ready', async (t) => {
  let currentTask;
  let currentHead;
  const { repo, task, headSha } = await reviewableTask(t, {
    ciConclusion: 'failure',
    reviewsFor: () => [approval(currentTask, currentHead)],
  });
  currentTask = task;
  currentHead = headSha;
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
  );

  fails(await repo.run('pr.mark_ready', { change_id: 'F-001' }), 'pr.mark_ready', 'CI_NOT_PASSING');
});

test('business decision ingestion waits for and then records an authenticated artifact-bound PR review', async (t) => {
  let currentTask;
  let currentHead;
  let decisionMarker;
  const { repo, task, headSha, artifact } = await reviewableTask(t, {
    includeArtifact: true,
    reviewsFor: () =>
      decisionMarker ? [approval(currentTask, currentHead, { body: decisionMarker })] : [],
  });
  currentTask = task;
  currentHead = headSha;

  const forged = await repo.run('decision.ingest', {
    change_id: 'F-001',
    artifact_id: 'REQ-001',
    decision: 'APPROVED',
    actor: 'human-reviewer',
  });
  assert.equal(forged.ok, false, 'Caller-supplied actor and decision claims are not authority.');
  const awaiting = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  assert.equal(awaiting.status, 'AWAITING_HUMAN');
  assert.match(awaiting.required_marker, /artifact=REQ-001/);
  assert.ok(awaiting.required_marker.includes(`content=${hash(artifact.artifact)} -->`));

  decisionMarker = awaiting.required_marker;
  const accepted = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  assert.equal(accepted.status, 'APPROVED');
  assert.equal(accepted.decision.reviewer, 'human-reviewer');
  assert.equal(accepted.decision.head_sha, headSha);
  const retried = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  assert.equal(retried.already_ingested, true);
});

test('business decision ingestion records an authenticated rejection for the exact artifact', async (t) => {
  let currentTask;
  let currentHead;
  let decisionMarker;
  const { repo, task, headSha } = await reviewableTask(t, {
    includeArtifact: true,
    reviewsFor: () =>
      decisionMarker
        ? [
            approval(currentTask, currentHead, {
              body: decisionMarker,
              state: 'CHANGES_REQUESTED',
            }),
          ]
        : [],
  });
  currentTask = task;
  currentHead = headSha;
  const awaiting = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  decisionMarker = awaiting.required_marker;

  const rejected = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.decision.reviewer, 'human-reviewer');
});

test('business decision ingestion refuses an artifact changed after registration', async (t) => {
  const { repo, artifact } = await reviewableTask(t, { includeArtifact: true });
  await repo.write(artifact.path, `${JSON.stringify({ changed: true })}\n`);

  fails(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
    'STALE_ARTIFACT',
  );
});

test('business decision ingestion requires the exact artifact to be published in the PR head', async (t) => {
  const { repo } = await reviewableTask(t);
  await repo.run('artifact.create', {
    change_id: 'F-001',
    id: 'REQ-001',
    type: 'requirements',
    title: 'Feature requirements',
    data: { requirements: [{ id: 'R-001', description: 'A person can be added.' }] },
  });

  fails(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
    'DECISION_SUBJECT_NOT_PUBLISHED',
  );
});

test('a newer non-decision review supersedes a stored artifact approval', async (t) => {
  let reviews = [];
  const { repo, task, headSha } = await reviewableTask(t, {
    includeArtifact: true,
    reviewsFor: () => reviews,
  });
  const awaiting = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  reviews = [approval(task, headSha, { body: awaiting.required_marker })];
  const accepted = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  assert.equal(accepted.status, 'APPROVED');
  reviews = [
    approval(task, headSha, {
      id: 71,
      state: 'COMMENTED',
      body: 'I am still reviewing this decision.',
      submitted_at: new Date(Date.parse(task.result.at) + 180_000).toISOString(),
    }),
  ];

  const superseded = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  assert.equal(superseded.status, 'AWAITING_HUMAN');
  assert.equal(superseded.previous_decision_invalidated, true);
});

test('squash merge requires all human gates and uses GitHub expected-head concurrency', async (t) => {
  let reviews = [];
  const { repo, task, headSha, artifact, setHeadSha, mergeCallCount } = await reviewableTask(t, {
    includeArtifact: true,
    includeSecondArtifact: true,
    reviewsFor: () => reviews,
  });
  const pendingDecision = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  reviews = [
    approval(task, headSha, {
      body: `${task.result.review_marker}\n${pendingDecision.required_marker}`,
    }),
  ];
  succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
  );

  await repo.write('README.md', '# A second reviewed feature task\n');
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'F-001',
      task: {
        id: 'T-002',
        role: 'sdlc_documentation_author',
        depends_on: ['T-001'],
        paths: ['README.md'],
        verification_profiles: ['focused'],
        outputs: ['Document the feature example.'],
      },
    }),
    'task.prepare',
  );
  const secondRun = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  ).run;
  const secondCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-002',
      paths: ['README.md'],
      message: 'docs(F-001): document the feature example',
    }),
    'change.checkpoint',
  );
  setHeadSha(secondCheckpoint.commit_sha);
  const secondTaskResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'F-001',
      task_id: 'T-002',
      run_ids: [secondRun.id],
    }),
    'task.record_result',
  );
  const pendingCurrentDecision = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'SCENARIOS-001' }),
    'decision.ingest',
  );
  assert.equal(pendingCurrentDecision.status, 'AWAITING_HUMAN');
  reviews.push(
    approval(secondTaskResult.task, secondCheckpoint.commit_sha, {
      id: 71,
      body: `${secondTaskResult.task.result.review_marker}\n${pendingCurrentDecision.required_marker}`,
      submitted_at: new Date(Date.parse(secondTaskResult.task.result.at) + 120_000).toISOString(),
    }),
  );
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-002' }),
    'review.resolve',
  );
  const currentDecision = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'SCENARIOS-001' }),
    'decision.ingest',
  );
  assert.equal(currentDecision.status, 'APPROVED');
  assert.equal(currentDecision.decision.head_sha, secondCheckpoint.commit_sha);
  succeeds(await repo.run('pr.mark_ready', { change_id: 'F-001' }), 'pr.mark_ready');

  const merged = succeeds(
    await repo.run('change.squash_merge', { change_id: 'F-001' }),
    'change.squash_merge',
  );
  assert.equal(merged.merged, true);
  assert.equal(merged.merge_commit_sha, 'b'.repeat(40));
  assert.equal(merged.head_sha, secondCheckpoint.commit_sha);
  const retried = succeeds(
    await repo.run('change.squash_merge', { change_id: 'F-001' }),
    'change.squash_merge',
  );
  assert.equal(retried.already_merged, true);
  assert.equal(mergeCallCount(), 1);
  assert.equal(artifact.artifact.id, 'REQ-001');
});

test('squash merge remains blocked without a current approved business decision', async (t) => {
  let reviews = [];
  const { repo, task, headSha } = await reviewableTask(t, {
    includeArtifact: true,
    reviewsFor: () => reviews,
  });
  const pendingDecision = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  reviews = [approval(task, headSha, { body: task.result.review_marker })];
  assert.ok(pendingDecision.required_marker);
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
  );
  succeeds(await repo.run('pr.mark_ready', { change_id: 'F-001' }), 'pr.mark_ready');

  fails(
    await repo.run('change.squash_merge', { change_id: 'F-001' }),
    'change.squash_merge',
    'DECISION_REQUIRED',
  );
});

test('squash merge rechecks task reviews after the pull request is ready', async (t) => {
  let reviews = [];
  const { repo, task, headSha, mergeCallCount } = await reviewableTask(t, {
    includeArtifact: true,
    reviewsFor: () => reviews,
  });
  const pendingDecision = succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  reviews = [
    approval(task, headSha, {
      body: `${task.result.review_marker}\n${pendingDecision.required_marker}`,
    }),
  ];
  succeeds(
    await repo.run('decision.ingest', { change_id: 'F-001', artifact_id: 'REQ-001' }),
    'decision.ingest',
  );
  succeeds(
    await repo.run('review.resolve', { change_id: 'F-001', task_id: 'T-001' }),
    'review.resolve',
  );
  succeeds(await repo.run('pr.mark_ready', { change_id: 'F-001' }), 'pr.mark_ready');

  reviews = [
    approval(task, headSha, {
      id: 71,
      state: 'CHANGES_REQUESTED',
      submitted_at: new Date(Date.parse(task.result.at) + 120_000).toISOString(),
    }),
  ];
  fails(
    await repo.run('change.squash_merge', { change_id: 'F-001' }),
    'change.squash_merge',
    'REVIEW_REQUIRED',
  );
  assert.equal(mergeCallCount(), 0);
});
