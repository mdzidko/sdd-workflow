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
const candidateSha = 'b'.repeat(40);

function response(body, status = 200, headers = {}) {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function candidateRun(overrides = {}) {
  return {
    id: 700,
    workflow_id: 99,
    name: 'Publish and verify image candidates',
    path: '.github/workflows/publish-candidates.yml@refs/heads/main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    head_sha: candidateSha,
    run_attempt: 1,
    ...overrides,
  };
}

const artifacts = {
  total_count: 1,
  artifacts: [{ id: 801, name: 'verified-candidate-set', expired: false, size_in_bytes: 512 }],
};
const validJobs = {
  total_count: 3,
  jobs: [
    { id: 1, name: 'discover', status: 'completed', conclusion: 'success' },
    { id: 2, name: 'publish (api)', status: 'completed', conclusion: 'success' },
    { id: 3, name: 'verify-candidate-set', status: 'completed', conclusion: 'success' },
  ],
};

async function mergedChange(
  t,
  { run = candidateRun(), jobs = validJobs, artifactList = artifacts } = {},
) {
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/actions/runs/700')) return response(run);
    if (parsed.pathname.endsWith('/actions/runs/700/artifacts')) return response(artifactList);
    if (parsed.pathname.endsWith('/actions/runs/700/jobs')) return response(jobs);
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
    merge_commit_sha: candidateSha,
    merge_method: 'squash',
    merged_at: new Date().toISOString(),
    recovered: false,
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { repo, statePath };
}

async function publish(repo, statePath) {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  return repo.run('images.publish', {
    change_id: 'F-001',
    run_id: 700,
    expected_revision: state.revision,
  });
}

test('image publication records only a successful candidate run from the exact merged source', async (t) => {
  const { repo, statePath } = await mergedChange(t);
  const publication = succeeds(await publish(repo, statePath), 'images.publish');

  assert.equal(publication.status, 'PUBLISHED');
  assert.equal(publication.candidate.run_id, 700);
  assert.equal(publication.candidate.artifact_id, 801);
  assert.equal(publication.candidate.source_sha, candidateSha);
  const retry = succeeds(await publish(repo, statePath), 'images.publish');
  assert.equal(retry.already_recorded, true);
});

test('image verification records complete matrix and exact-digest acceptance evidence', async (t) => {
  const { repo, statePath } = await mergedChange(t);
  succeeds(await publish(repo, statePath), 'images.publish');
  let state = JSON.parse(await readFile(statePath, 'utf8'));

  const verification = succeeds(
    await repo.run('images.verify', {
      change_id: 'F-001',
      run_id: 700,
      expected_revision: state.revision,
    }),
    'images.verify',
  );
  assert.equal(verification.status, 'VERIFIED');
  assert.deepEqual(verification.verification.evidence, [
    'complete_image_matrix',
    'exact_digest_pull',
    'compose_system_acceptance',
  ]);
  state = JSON.parse(await readFile(statePath, 'utf8'));
  const retry = succeeds(
    await repo.run('images.verify', {
      change_id: 'F-001',
      run_id: 700,
      expected_revision: state.revision,
    }),
    'images.verify',
  );
  assert.equal(retry.already_recorded, true);
});

test('candidate publication rejects a run from another source SHA', async (t) => {
  const { repo, statePath } = await mergedChange(t, {
    run: candidateRun({ head_sha: 'c'.repeat(40) }),
  });

  fails(await publish(repo, statePath), 'images.publish', 'IMAGE_RUN_UNTRUSTED');
  assert.equal(
    JSON.parse(await readFile(statePath, 'utf8')).changes['F-001'].image_candidate,
    undefined,
  );
});

test('image verification refuses a successful run with a missing digest acceptance job', async (t) => {
  const { repo, statePath } = await mergedChange(t, {
    jobs: {
      total_count: 2,
      jobs: [
        { id: 1, name: 'discover', status: 'completed', conclusion: 'success' },
        { id: 2, name: 'publish (api)', status: 'completed', conclusion: 'success' },
      ],
    },
  });
  succeeds(await publish(repo, statePath), 'images.publish');
  const state = JSON.parse(await readFile(statePath, 'utf8'));

  fails(
    await repo.run('images.verify', {
      change_id: 'F-001',
      run_id: 700,
      expected_revision: state.revision,
    }),
    'images.verify',
    'IMAGE_VERIFICATION_FAILED',
  );
  assert.equal(
    JSON.parse(await readFile(statePath, 'utf8')).changes['F-001'].image_verification,
    undefined,
  );
});
