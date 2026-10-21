import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

const foundations = [
  [
    'product-charter',
    'Product charter',
    {
      problem: 'People need a shared place for family history.',
      users: [],
      goals: [],
      success_measures: [],
      assumptions: [],
    },
  ],
  [
    'mvp-map',
    'MVP map',
    { capabilities: [], priorities: [], dependencies: [], exclusions: [], completion_criteria: [] },
  ],
  ['constraints', 'Constraints', { requirements: [], limitations: [], unresolved_questions: [] }],
];
const architectureTypes = [
  'architecture',
  'application-inventory',
  'contract-inventory',
  'implementation-standards',
  'test-standards',
  'delivery-strategy',
];

async function exampleArtifactData(type) {
  const contents = await readFile(
    new URL(`../../workflow/bundle/contracts/examples/${type}.valid.json`, import.meta.url),
    'utf8',
  );
  return JSON.parse(contents).data;
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('project initialization advances only with validated artifacts and current authenticated decisions', async (t) => {
  let pull;
  let headSha;
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
      pull.merge_commit_sha = 'f'.repeat(40);
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
  const remote = await mkdtemp(path.join(tmpdir(), 'codex-workflow-stage-'));
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
  const started = succeeds(
    await repo.run('change.start', {
      id: 'INIT-001',
      kind: 'PROJECT_INIT',
      description: 'Initialize this project.',
    }),
    'change.start',
  );
  const headRef = started.change.branch;

  const initialState = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const blocked = fails(
    await repo.run('stage.advance', {
      change_id: 'INIT-001',
      expected_stage: 'FOUNDATIONS',
      expected_revision: initialState.revision,
      to: 'ARCHITECTURE',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
  assert.deepEqual(
    blocked.details.gate.missing.map((item) => item.reason),
    ['artifact_missing', 'artifact_missing', 'artifact_missing'],
  );

  const artifactRefs = [];
  const decisionMarkers = [];
  for (let index = 0; index < foundations.length; index += 1) {
    const [type, title, data] = foundations[index];
    const artifact = succeeds(
      await repo.run('artifact.create', {
        change_id: 'INIT-001',
        id: `INIT-${index + 1}`,
        type,
        title,
        data,
      }),
      'artifact.create',
    );
    artifactRefs.push({ ...artifact, id: artifact.artifact.id, type: artifact.artifact.type });
  }
  await repo.write('README.md', '# Initialized project\n');
  const paths = ['README.md', ...artifactRefs.flatMap((item) => [item.path, item.markdown_path])];
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'INIT-001',
      task: {
        id: 'T-FOUNDATIONS',
        role: 'spec_author',
        depends_on: [],
        paths,
        verification_profiles: ['focused'],
        outputs: ['Accepted product foundations.'],
      },
    }),
    'task.prepare',
  );
  const checkpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'INIT-001',
      task_id: 'T-FOUNDATIONS',
      paths,
      message: 'docs(INIT-001): define product foundations',
    }),
    'change.checkpoint',
  );
  headSha = checkpoint.commit_sha;
  succeeds(await repo.run('pr.ensure', { change_id: 'INIT-001' }), 'pr.ensure');
  const foundationRun = succeeds(
    await repo.run('tests.run', { change_id: 'INIT-001', profile: 'focused' }),
    'tests.run',
  ).run;
  const foundationResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'INIT-001',
      task_id: 'T-FOUNDATIONS',
      run_ids: [foundationRun.id],
    }),
    'task.record_result',
  );

  for (let index = 0; index < artifactRefs.length; index += 1) {
    const artifact = artifactRefs[index];
    const pending = succeeds(
      await repo.run('decision.ingest', {
        change_id: 'INIT-001',
        artifact_id: artifact.id,
      }),
      'decision.ingest',
    );
    assert.equal(pending.status, 'AWAITING_HUMAN');
    decisionMarkers.push(pending.required_marker);
  }
  reviews.push({
    id: 1,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: `Approved.\n${decisionMarkers.join('\n')}\n${foundationResult.task.result.review_marker}`,
  });
  for (const artifact of artifactRefs) {
    const accepted = succeeds(
      await repo.run('decision.ingest', {
        change_id: 'INIT-001',
        artifact_id: artifact.id,
      }),
      'decision.ingest',
    );
    assert.equal(accepted.status, 'APPROVED');
  }

  const originalArtifact = await readFile(
    path.join(repo.projectRoot, artifactRefs[0].path),
    'utf8',
  );
  await repo.write(artifactRefs[0].path, `${JSON.stringify({ type: 'product-charter' })}\n`);
  const changedGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'INIT-001' }),
    'stage.inspect',
  );
  assert.equal(changedGate.transition.ready, false);
  assert.equal(changedGate.transition.missing[0].reason, 'artifact_invalid');
  await repo.write(artifactRefs[0].path, originalArtifact);
  succeeds(
    await repo.run('artifact.validate', { path: artifactRefs[0].path }),
    'artifact.validate',
  );
  const gate = succeeds(
    await repo.run('stage.inspect', { change_id: 'INIT-001' }),
    'stage.inspect',
  );
  assert.equal(gate.transition.ready, true, JSON.stringify(gate.transition));
  const state = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  fails(
    await repo.run('stage.advance', {
      change_id: 'INIT-001',
      expected_stage: 'FOUNDATIONS',
      to: 'ARCHITECTURE',
      expected_revision: state.revision - 1,
    }),
    'stage.advance',
    'STALE_REVISION',
  );
  await repo.write('README.md', '# Initialized project with a newer reviewable revision\n');
  repo.git('add', 'README.md');
  repo.git('commit', '-m', 'docs: update initialization notes');
  repo.git('push', 'origin', started.change.branch);
  headSha = repo.git('rev-parse', 'HEAD');
  const staleApproval = fails(
    await repo.run('stage.advance', {
      change_id: 'INIT-001',
      expected_stage: 'FOUNDATIONS',
      to: 'ARCHITECTURE',
      expected_revision: state.revision,
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
  assert.ok(
    staleApproval.details.gate.missing.every((item) =>
      ['authenticated_approval_stale', 'authenticated_approval_missing'].includes(item.reason),
    ),
    JSON.stringify(staleApproval.details.gate),
  );
  reviews.push({
    id: 10,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: `Reapproved for current PR head.\n${decisionMarkers.join('\n')}\n${foundationResult.task.result.review_marker}`,
  });
  for (const artifact of artifactRefs) {
    const accepted = succeeds(
      await repo.run('decision.ingest', {
        change_id: 'INIT-001',
        artifact_id: artifact.id,
      }),
      'decision.ingest',
    );
    assert.equal(accepted.status, 'APPROVED');
  }
  succeeds(
    await repo.run('review.resolve', { change_id: 'INIT-001', task_id: 'T-FOUNDATIONS' }),
    'review.resolve',
  );
  const refreshedState = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const advanced = succeeds(
    await repo.run('stage.advance', {
      change_id: 'INIT-001',
      expected_stage: 'FOUNDATIONS',
      to: 'ARCHITECTURE',
      expected_revision: refreshedState.revision,
    }),
    'stage.advance',
  );
  assert.equal(advanced.change.stage, 'ARCHITECTURE');
  const retry = succeeds(
    await repo.run('stage.advance', {
      change_id: 'INIT-001',
      expected_stage: 'FOUNDATIONS',
      expected_revision: (await repo.run('workflow.inspect')).data.revision,
      to: 'ARCHITECTURE',
    }),
    'stage.advance',
  );
  assert.equal(retry.already_advanced, true);

  const architectureRefs = [];
  for (let index = 0; index < architectureTypes.length; index += 1) {
    const type = architectureTypes[index];
    const artifact = succeeds(
      await repo.run('artifact.create', {
        change_id: 'INIT-001',
        id: `ARCH-${index + 1}`,
        type,
        title: `Accepted ${type}`,
        data: await exampleArtifactData(type),
      }),
      'artifact.create',
    );
    architectureRefs.push({ ...artifact, id: artifact.artifact.id, type });
  }
  const architecturePaths = architectureRefs.flatMap((item) => [item.path, item.markdown_path]);
  succeeds(
    await repo.run('task.prepare', {
      change_id: 'INIT-001',
      task: {
        id: 'T-ARCHITECTURE',
        role: 'architect',
        depends_on: [],
        paths: architecturePaths,
        verification_profiles: ['focused'],
        outputs: ['Reviewed system architecture and delivery standards.'],
      },
    }),
    'task.prepare',
  );
  const architectureCheckpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'INIT-001',
      task_id: 'T-ARCHITECTURE',
      paths: architecturePaths,
      message: 'docs(INIT-001): define application architecture',
    }),
    'change.checkpoint',
  );
  headSha = architectureCheckpoint.commit_sha;
  const architectureRun = succeeds(
    await repo.run('tests.run', { change_id: 'INIT-001', profile: 'focused' }),
    'tests.run',
  ).run;
  const architectureResult = succeeds(
    await repo.run('task.record_result', {
      change_id: 'INIT-001',
      task_id: 'T-ARCHITECTURE',
      run_ids: [architectureRun.id],
    }),
    'task.record_result',
  );

  const architectureMarkers = [];
  for (const artifact of architectureRefs) {
    const pending = succeeds(
      await repo.run('decision.ingest', {
        change_id: 'INIT-001',
        artifact_id: artifact.id,
      }),
      'decision.ingest',
    );
    assert.equal(pending.status, 'AWAITING_HUMAN');
    architectureMarkers.push(pending.required_marker);
  }
  reviews.push({
    id: 20,
    user: { login: 'human-reviewer', type: 'User' },
    state: 'APPROVED',
    commit_id: headSha,
    submitted_at: new Date().toISOString(),
    body: `Architecture approved.\n${architectureMarkers.join('\n')}\n${architectureResult.task.result.review_marker}`,
  });
  for (const artifact of architectureRefs) {
    const accepted = succeeds(
      await repo.run('decision.ingest', {
        change_id: 'INIT-001',
        artifact_id: artifact.id,
      }),
      'decision.ingest',
    );
    assert.equal(accepted.status, 'APPROVED');
  }
  succeeds(
    await repo.run('review.resolve', { change_id: 'INIT-001', task_id: 'T-ARCHITECTURE' }),
    'review.resolve',
  );
  const architectureGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'INIT-001' }),
    'stage.inspect',
  );
  assert.equal(architectureGate.transition.ready, true);
  const architectureState = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const bootstrapping = succeeds(
    await repo.run('stage.advance', {
      change_id: 'INIT-001',
      expected_stage: 'ARCHITECTURE',
      expected_revision: architectureState.revision,
      to: 'BOOTSTRAP',
    }),
    'stage.advance',
  );
  assert.equal(bootstrapping.change.stage, 'BOOTSTRAP');
  const mergeGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'INIT-001' }),
    'stage.inspect',
  );
  assert.equal(mergeGate.transition.ready, false);
  assert.deepEqual(mergeGate.transition.missing, ['verified_squash_merge']);
  const ready = succeeds(
    await repo.run('pr.mark_ready', { change_id: 'INIT-001' }),
    'pr.mark_ready',
  );
  assert.equal(ready.head_sha, headSha);
  assert.equal(ready.ci.all_passed, true);
  const merged = succeeds(
    await repo.run('change.squash_merge', { change_id: 'INIT-001' }),
    'change.squash_merge',
  );
  assert.equal(merged.merged, true);
  assert.equal(merged.merge_method, 'squash');
  assert.equal(merged.merge_commit_sha, 'f'.repeat(40));
  const completionGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'INIT-001' }),
    'stage.inspect',
  );
  assert.equal(completionGate.transition.to, 'COMPLETE');
  assert.equal(completionGate.transition.ready, true);
  const completeState = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const completed = succeeds(
    await repo.run('stage.advance', {
      change_id: 'INIT-001',
      expected_stage: 'BOOTSTRAP',
      expected_revision: completeState.revision,
      to: 'COMPLETE',
    }),
    'stage.advance',
  );
  assert.equal(completed.change.stage, 'COMPLETE');
});

test('stage inspection reports unsupported feature policy and arbitrary transitions fail closed', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await repo.run('change.start', {
    id: 'F-001',
    kind: 'FEATURE',
    description: 'Add a searchable family member directory.',
  });
  const inspection = succeeds(
    await repo.run('stage.inspect', { change_id: 'F-001' }),
    'stage.inspect',
  );
  assert.equal(inspection.transition.supported, true);
  assert.equal(inspection.transition.ready, false);
  fails(
    await repo.run('stage.advance', {
      change_id: 'F-001',
      expected_stage: 'INTAKE',
      to: 'SPECIFICATION',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
});
