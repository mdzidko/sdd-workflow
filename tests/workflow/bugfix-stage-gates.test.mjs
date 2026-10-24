import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fails, initialize, repository, succeeds } from './helpers.mjs';

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

async function startBugfix(repo) {
  await initialize(repo);
  succeeds(
    await repo.run('change.start', {
      id: 'B-001',
      kind: 'BUGFIX',
      description: 'Correct the profile date display',
    }),
    'change.start',
  );
}

async function defectData() {
  return JSON.parse(
    await readFile(
      new URL('../../workflow/bundle/contracts/examples/defect-report.valid.json', import.meta.url),
      'utf8',
    ),
  ).data;
}

test('a bugfix cannot enter implementation without a reviewed test-first reproduction', async (t) => {
  const repo = await repository(t);
  await startBugfix(repo);
  succeeds(
    await repo.run('artifact.create', {
      change_id: 'B-001',
      id: 'DEFECT-001',
      type: 'defect-report',
      title: 'Profile date is off by one day',
      data: {
        ...(await defectData()),
        expected: 'Display the selected calendar date.',
        observed: 'Display the previous calendar date.',
        reproduction_steps: ['Open a profile in UTC+01:00.', 'Select 2026-10-20.'],
      },
    }),
    'artifact.create',
  );

  const inspected = succeeds(
    await repo.run('stage.inspect', { change_id: 'B-001' }),
    'stage.inspect',
  );
  assert.equal(inspected.transition.supported, true);
  assert.equal(inspected.transition.ready, false);
  assert.ok(
    inspected.transition.missing.some((item) => item.reason === 'reproduced_red_test_missing'),
  );
  fails(
    await repo.run('task.prepare', {
      change_id: 'B-001',
      task: {
        id: 'T-IMPLEMENT',
        role: 'sdlc_implementer',
        depends_on: [],
        paths: ['README.md'],
        verification_profiles: [],
        outputs: ['Correct the reproduced profile date defect.'],
      },
    }),
    'task.prepare',
    'GATE_BLOCKED',
  );

  const state = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  fails(
    await repo.run('stage.advance', {
      change_id: 'B-001',
      expected_stage: 'REPRODUCTION',
      expected_revision: state.revision,
      to: 'IMPLEMENTATION',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
});

test('a defect report with no reproduction steps is rejected by the bugfix stage gate', async (t) => {
  const repo = await repository(t);
  await startBugfix(repo);
  succeeds(
    await repo.run('artifact.create', {
      change_id: 'B-001',
      id: 'DEFECT-001',
      type: 'defect-report',
      title: 'Unreproducible report',
      data: { ...(await defectData()), reproduction_steps: [] },
    }),
    'artifact.create',
  );

  const inspected = succeeds(
    await repo.run('stage.inspect', { change_id: 'B-001' }),
    'stage.inspect',
  );
  assert.equal(inspected.transition.ready, false);
  assert.ok(inspected.transition.missing.some((item) => item.reason === 'artifact_invalid'));
});

test('a reproduced RED regression test and chat acceptance advance a bugfix to implementation', async (t) => {
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
        draft: false,
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
      pull.merge_commit_sha = 'e'.repeat(40);
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

  const redFixture = path.join('tests', 'profile-date.test.mjs');
  const repo = await repository(t, {
    context: { env: { GH_TOKEN: 'fixture-token', GITHUB_API_URL: apiUrl }, fetchImpl },
  });
  const remote = await mkdtemp(path.join(tmpdir(), 'codex-workflow-bugfix-gate-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', remote], { windowsHide: true });
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '-u', 'origin', 'main');
  await initialize(repo, {
    github,
    commands: {
      expected_red: {
        command: process.execPath,
        args: ['--test', redFixture],
        timeout_ms: 2_000,
      },
      focused: {
        command: process.execPath,
        args: ['--test', redFixture],
        timeout_ms: 2_000,
      },
    },
  });
  succeeds(
    await repo.run('change.start', {
      id: 'B-002',
      kind: 'BUGFIX',
      description: 'Correct the profile date display',
    }),
    'change.start',
  );
  headRef = 'fix/B-002-correct-the-profile-date-display';
  succeeds(
    await repo.run('artifact.create', {
      change_id: 'B-002',
      id: 'DEFECT-002',
      type: 'defect-report',
      title: 'Profile date is off by one day',
      data: {
        ...(await defectData()),
        expected: 'Display the selected calendar date.',
        observed: 'Display the previous calendar date.',
        reproduction_steps: ['Open a profile in UTC+01:00.', 'Select 2026-10-20.'],
      },
    }),
    'artifact.create',
  );
  await repo.write(
    'src/date-label.mjs',
    'export function formatDateLabel(value) {\n  const date = new Date(`${value}T00:00:00.000Z`);\n  date.setUTCDate(date.getUTCDate() - 1);\n  return date.toISOString().slice(0, 10);\n}\n',
  );
  await repo.write(
    redFixture,
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatDateLabel } from '../src/date-label.mjs';\n\ntest('shows the selected calendar date', () => {\n  assert.equal(formatDateLabel('2026-10-20'), '2026-10-20');\n});\n",
  );
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'B-002',
      task: {
        id: 'T-RED',
        role: 'sdlc_test_author',
        depends_on: [],
        paths: [
          'src/date-label.mjs',
          redFixture,
          'docs/changes/B-002/DEFECT-002.json',
          'docs/changes/B-002/DEFECT-002.md',
        ],
        verification_profiles: ['expected_red'],
        outputs: ['A readable regression test reproduces the incorrect profile date.'],
      },
    }),
    'task.prepare',
  );
  const checkpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'B-002',
      task_id: 'T-RED',
      paths: [
        'src/date-label.mjs',
        redFixture,
        'docs/changes/B-002/DEFECT-002.json',
        'docs/changes/B-002/DEFECT-002.md',
      ],
      message: 'test(B-002): reproduce selected date display defect',
    }),
    'change.checkpoint',
  );
  headSha = checkpoint.commit_sha;
  succeeds(await repo.run('pr.ensure', { change_id: 'B-002' }), 'pr.ensure');
  const run = succeeds(
    await repo.run('tests.run', { change_id: 'B-002', profile: 'expected_red' }),
    'tests.run',
  ).run;
  assert.equal(run.classification, 'ASSERTION_FAILURE');
  succeeds(
    await repo.run('tdd.record', {
      change_id: 'B-002',
      run_id: run.id,
      phase: 'RED',
      expected_failure: {
        test_id: 'shows the selected calendar date',
        message: 'Expected values to be strictly equal',
      },
    }),
    'tdd.record',
  );
  const result = succeeds(
    await repo.run('task.record_result', {
      change_id: 'B-002',
      task_id: 'T-RED',
      run_ids: [run.id],
    }),
    'task.record_result',
  );
  assert.equal(result.task.state, 'DONE');
  let state = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  fails(
    await repo.run('stage.advance', {
      change_id: 'B-002',
      expected_stage: 'REPRODUCTION',
      expected_revision: state.revision,
      to: 'IMPLEMENTATION',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
  const rejectedIntentRoute = succeeds(
    await repo.run('change.route', { change_id: 'B-002' }),
    'change.route',
  );
  assert.ok(
    rejectedIntentRoute.sequence.some((step) =>
      /intent is ambiguous or requested behavior differs, return to feature specification/i.test(
        step,
      ),
    ),
  );
  const intent = succeeds(await repo.accept('B-002', 'DEFECT-002'), 'decision.accept');
  assert.equal(intent.approval.status, 'APPROVED');
  state = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const advanced = succeeds(
    await repo.run('stage.advance', {
      change_id: 'B-002',
      expected_stage: 'REPRODUCTION',
      expected_revision: state.revision,
      to: 'IMPLEMENTATION',
    }),
    'stage.advance',
  );
  assert.equal(advanced.change.stage, 'IMPLEMENTATION');
  assert.ok(advanced.transition.evidence.some((item) => item.type === 'verified_red_test'));
  assert.ok(advanced.transition.evidence.some((item) => item.type === 'authenticated_decision'));
  fails(
    await repo.run('task.prepare', {
      change_id: 'B-002',
      task: {
        id: 'T-IMPLEMENT-WITHOUT-RED',
        role: 'sdlc_implementer',
        depends_on: [],
        paths: ['src/date-label.mjs'],
        verification_profiles: ['expected_red'],
        outputs: ['Correct the profile date.'],
      },
    }),
    'task.prepare',
    'TDD_REQUIRED',
  );
  const implementationTask = succeeds(
    await repo.run('task.prepare', {
      change_id: 'B-002',
      task: {
        id: 'T-IMPLEMENT',
        role: 'sdlc_implementer',
        depends_on: ['T-RED'],
        paths: ['src/date-label.mjs'],
        verification_profiles: ['focused'],
        outputs: ['Display the selected profile date correctly.'],
      },
    }),
    'task.prepare',
  );
  assert.equal(implementationTask.task.state, 'READY');
  await repo.write(
    'src/date-label.mjs',
    'export function formatDateLabel(value) {\n  return value;\n}\n',
  );
  const implementationCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'B-002',
      task_id: 'T-IMPLEMENT',
      paths: ['src/date-label.mjs'],
      message: 'fix(B-002): display the selected profile date',
    }),
    'change.checkpoint',
  );
  headSha = implementationCheckpoint.commit_sha;
  const green = succeeds(
    await repo.run('tests.run', { change_id: 'B-002', profile: 'focused' }),
    'tests.run',
  ).run;
  assert.equal(green.classification, 'PASS');
  succeeds(
    await repo.run('tdd.record', {
      change_id: 'B-002',
      run_id: green.id,
      phase: 'GREEN',
    }),
    'tdd.record',
  );
  const implementationResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'B-002',
      task_id: 'T-IMPLEMENT',
      run_ids: [green.id],
    }),
    'task.record_result',
  );
  assert.equal(implementationResult.task.state, 'DONE');

  const completion = succeeds(
    await repo.run('stage.inspect', { change_id: 'B-002' }),
    'stage.inspect',
  );
  assert.equal(completion.transition.to, 'COMPLETE');
  assert.equal(completion.transition.ready, false);
  assert.deepEqual(completion.transition.missing, ['manual_merge_confirmation']);
  pull.state = 'closed';
  pull.merged = true;
  pull.merge_commit_sha = 'e'.repeat(40);
  const merged = succeeds(
    await repo.run('change.confirm_merge', { change_id: 'B-002' }),
    'change.confirm_merge',
  );
  assert.equal(merged.merged, true);
  assert.equal(merged.merge_method, 'user');
  assert.equal(merged.merge_commit_sha, 'e'.repeat(40));
  const verifiedCompletion = succeeds(
    await repo.run('stage.inspect', { change_id: 'B-002' }),
    'stage.inspect',
  );
  assert.equal(verifiedCompletion.transition.ready, true);
  state = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const completed = succeeds(
    await repo.run('stage.advance', {
      change_id: 'B-002',
      expected_stage: 'IMPLEMENTATION',
      expected_revision: state.revision,
      to: 'COMPLETE',
    }),
    'stage.advance',
  );
  assert.equal(completed.change.stage, 'COMPLETE');
});
