import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
const sourceSha = 'b'.repeat(40);
const dispatchSha = 'c'.repeat(40);
const version = '1.2.3-rc.1';
const tag = `v${version}`;
const sourceRunId = 700;
const releaseRunId = 900;
const protectedEnvironment = {
  name: 'workflow-release',
  protection_rules: [
    {
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{ type: 'User', reviewer: { id: 5, login: 'release-approver' } }],
    },
  ],
};

function response(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function successfulReleaseRun(overrides = {}) {
  return {
    id: releaseRunId,
    workflow_id: 101,
    name: 'Publish release from verified image candidate',
    display_title: `Publish release ${tag} from candidate run ${sourceRunId}`,
    path: '.github/workflows/publish-release.yml@refs/heads/main',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: dispatchSha,
    run_attempt: 1,
    ...overrides,
  };
}

async function verifiedCandidate(
  t,
  {
    releaseRun = successfulReleaseRun(),
    releaseCommitSha = sourceSha,
    workflowRuns = [],
    manifestSourceSha = sourceSha,
    releaseEnvironment = structuredClone(protectedEnvironment),
  } = {},
) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    requests.push({ url: parsed, method: init.method, body: init.body });
    if (parsed.hostname === 'assets.example.test')
      return new Response(
        JSON.stringify({
          schema_version: '1',
          version,
          tag,
          prerelease: true,
          source_sha: manifestSourceSha,
          source_run_id: String(sourceRunId),
          images: [
            {
              image_id: 'api',
              image: 'ghcr.io/example-org/project-x/api',
              digest: `sha256:${'d'.repeat(64)}`,
              reference: `ghcr.io/example-org/project-x/api@sha256:${'d'.repeat(64)}`,
              service: 'api',
            },
          ],
          migrations: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    if (parsed.pathname.endsWith('/branches/main'))
      return response({ commit: { sha: dispatchSha } });
    if (parsed.pathname.endsWith('/environments/workflow-release'))
      return response(releaseEnvironment);
    if (parsed.pathname.endsWith('/actions/workflows/publish-release.yml/runs'))
      return response({ total_count: workflowRuns.length, workflow_runs: workflowRuns });
    if (parsed.pathname.endsWith('/actions/workflows/publish-release.yml/dispatches'))
      return response(null, 204);
    if (parsed.pathname.endsWith(`/actions/runs/${releaseRunId}`)) return response(releaseRun);
    if (parsed.pathname.endsWith(`/releases/tags/${encodeURIComponent(tag)}`))
      return response({
        tag_name: tag,
        draft: false,
        prerelease: true,
        html_url: `https://github.example.test/example-org/project-x/releases/tag/${tag}`,
        body: `Release ${tag}\n\nSource commit: ${sourceSha}\nVerified candidate workflow run: ${sourceRunId}\n`,
        assets: [{ id: 990, name: 'release-manifest.json', state: 'uploaded', size: 512 }],
      });
    if (parsed.pathname.endsWith('/releases/assets/990'))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://assets.example.test/manifest' },
      });
    if (parsed.pathname.endsWith(`/git/ref/tags/${encodeURIComponent(tag)}`))
      return response({
        ref: `refs/tags/${tag}`,
        object: { type: 'commit', sha: releaseCommitSha },
      });
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const repo = await repository(t, {
    context: { env: { GH_TOKEN: 'fixture-token', GITHUB_API_URL: apiUrl }, fetchImpl },
  });
  await initialize(repo, { github });
  await startFeature(repo);
  const statePath = path.join(repo.projectRoot, '.workflow', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const change = state.changes['F-001'];
  change.pull_request = { number: 42 };
  change.merge_receipt = {
    pull_request_number: 42,
    head_sha: 'a'.repeat(40),
    merge_commit_sha: sourceSha,
    merge_method: 'squash',
    merged_at: new Date().toISOString(),
    recovered: false,
  };
  change.image_candidate = {
    run_id: sourceRunId,
    run_attempt: 1,
    artifact_id: 801,
    source_sha: sourceSha,
  };
  change.image_verification = {
    run_id: sourceRunId,
    run_attempt: 1,
    artifact_id: 801,
    source_sha: sourceSha,
    evidence: ['complete_image_matrix', 'exact_digest_pull', 'compose_system_acceptance'],
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { repo, statePath, requests, releaseEnvironment };
}

async function releaseInput(repo, statePath, extra = {}) {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  return repo.run('release.publish', {
    change_id: 'F-001',
    source_run_id: sourceRunId,
    version,
    expected_revision: state.revision,
    ...extra,
  });
}

test('release publication dispatches the protected workflow from the integration branch', async (t) => {
  const { repo, statePath, requests } = await verifiedCandidate(t);

  const firstResult = await releaseInput(repo, statePath);
  assert.equal(
    firstResult.ok,
    true,
    JSON.stringify({
      error: firstResult.error,
      requests: requests.map((item) => `${item.method} ${item.url.pathname}`),
    }),
  );
  const dispatched = firstResult.data;

  assert.equal(dispatched.status, 'AWAITING_HUMAN');
  assert.equal(dispatched.dispatch.tag, tag);
  const dispatchRequest = requests.find((item) => item.method === 'POST');
  assert.ok(dispatchRequest);
  assert.deepEqual(JSON.parse(dispatchRequest.body), {
    ref: 'main',
    inputs: { source_run_id: String(sourceRunId), source_sha: sourceSha, version },
  });
  assert.equal((await releaseInput(repo, statePath)).data.status, 'AWAITING_HUMAN');
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
});

test('release publication records only the exact successful protected workflow result', async (t) => {
  const { repo, statePath } = await verifiedCandidate(t);
  succeeds(await releaseInput(repo, statePath), 'release.publish');

  const completed = succeeds(
    await releaseInput(repo, statePath, { release_run_id: releaseRunId }),
    'release.publish',
  );
  assert.equal(completed.status, 'PUBLISHED');
  assert.equal(completed.release.tag, tag);
  assert.equal(completed.release.source_sha, sourceSha);
  assert.equal(completed.release.source_run_id, sourceRunId);
  assert.equal(completed.release.release_run_id, releaseRunId);
  assert.equal(completed.release.manifest_asset_id, 990);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const retry = succeeds(
    await repo.run('release.publish', {
      change_id: 'F-001',
      source_run_id: sourceRunId,
      version,
      expected_revision: state.revision,
    }),
    'release.publish',
  );
  assert.equal(retry.already_published, true);
});

test('release dispatch retry adopts the exact existing workflow run instead of dispatching twice', async (t) => {
  const existing = successfulReleaseRun({ status: 'in_progress', conclusion: null });
  const { repo, statePath, requests } = await verifiedCandidate(t, { workflowRuns: [existing] });

  const result = succeeds(await releaseInput(repo, statePath), 'release.publish');

  assert.equal(result.status, 'AWAITING_HUMAN');
  assert.equal(result.dispatch.release_run_id, releaseRunId);
  assert.equal(result.dispatch.reconciled, true);
  assert.equal(requests.filter((item) => item.method === 'POST').length, 0);
});

test('release dispatch does not trust an unreceipted completed run as human-approved', async (t) => {
  const { repo, statePath, requests } = await verifiedCandidate(t, {
    workflowRuns: [successfulReleaseRun()],
  });

  const result = succeeds(await releaseInput(repo, statePath), 'release.publish');

  assert.equal(result.status, 'AWAITING_HUMAN');
  assert.equal(result.already_dispatched, undefined);
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
});

test('release publication waits while the protected environment is pending human review', async (t) => {
  const { repo, statePath } = await verifiedCandidate(t, {
    releaseRun: successfulReleaseRun({ status: 'in_progress', conclusion: null }),
  });
  succeeds(await releaseInput(repo, statePath), 'release.publish');

  const pending = succeeds(
    await releaseInput(repo, statePath, { release_run_id: releaseRunId }),
    'release.publish',
  );
  assert.equal(pending.status, 'AWAITING_HUMAN');
  assert.equal(pending.run_status, 'in_progress');
  assert.equal(
    JSON.parse(await readFile(statePath, 'utf8')).changes['F-001'].release_receipt,
    undefined,
  );
});

test('release publication rejects a tag that points to another source commit', async (t) => {
  const { repo, statePath } = await verifiedCandidate(t, { releaseCommitSha: 'd'.repeat(40) });
  succeeds(await releaseInput(repo, statePath), 'release.publish');

  fails(
    await releaseInput(repo, statePath, { release_run_id: releaseRunId }),
    'release.publish',
    'RELEASE_TAG_MISMATCH',
  );
});

test('release dispatch requires a protected environment with a human reviewer and no self-review', async (t) => {
  const { repo, statePath, requests } = await verifiedCandidate(t, {
    releaseEnvironment: { name: 'workflow-release', protection_rules: [] },
  });

  fails(await releaseInput(repo, statePath), 'release.publish', 'RELEASE_ENVIRONMENT_REQUIRED');
  assert.equal(
    requests.some((item) => item.method === 'POST'),
    false,
  );
});

test('release publication refuses to record success after the human approval policy changes', async (t) => {
  const { repo, statePath, releaseEnvironment } = await verifiedCandidate(t);
  succeeds(await releaseInput(repo, statePath), 'release.publish');
  releaseEnvironment.protection_rules[0].reviewers = [
    { type: 'User', reviewer: { id: 6, login: 'different-reviewer' } },
  ];

  fails(
    await releaseInput(repo, statePath, { release_run_id: releaseRunId }),
    'release.publish',
    'RELEASE_ENVIRONMENT_CHANGED',
  );
});

test('release publication validates the downloaded digest manifest against the verified candidate', async (t) => {
  const { repo, statePath } = await verifiedCandidate(t, { manifestSourceSha: 'e'.repeat(40) });
  succeeds(await releaseInput(repo, statePath), 'release.publish');

  fails(
    await releaseInput(repo, statePath, { release_run_id: releaseRunId }),
    'release.publish',
    'RELEASE_MANIFEST_MISMATCH',
  );
});
