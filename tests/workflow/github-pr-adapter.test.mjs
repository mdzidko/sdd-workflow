import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fails, initialize, repository, startFeature, succeeds } from './helpers.mjs';

const repositoryConfig = {
  owner: 'example-org',
  name: 'project-x',
  api_url: 'https://api.example.test',
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

function pullRequest(headSha, overrides = {}) {
  return {
    number: 42,
    html_url: 'https://github.example.test/example-org/project-x/pull/42',
    state: 'open',
    draft: false,
    head: {
      ref: 'feature/F-001-allow-adding-a-person',
      sha: headSha,
      repo: { full_name: 'example-org/project-x' },
    },
    base: { ref: 'main', sha: '8aa0a', repo: { full_name: 'example-org/project-x' } },
    user: { login: 'workflow-bot[bot]', type: 'Bot' },
    ...overrides,
  };
}

async function pushedChange(t, { token = 'fixture-token', fetchImpl, sleepImpl } = {}) {
  const repo = await repository(t, {
    context: {
      env: {
        GITHUB_API_URL: repositoryConfig.api_url,
        ...(token ? { GH_TOKEN: token } : {}),
      },
      fetchImpl,
      sleepImpl,
    },
  });
  const bareRemote = await mkdtemp(path.join(tmpdir(), 'codex-workflow-github-'));
  t.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(bareRemote, { recursive: true, force: true })),
  );
  execFileSync('git', ['init', '--bare', bareRemote], { windowsHide: true });
  repo.git('remote', 'add', 'origin', bareRemote);
  repo.git('push', '-u', 'origin', 'main');
  await initialize(repo, {
    github: repositoryConfig,
  });
  await startFeature(repo);
  await repo.write('src/person.mjs', 'export const person = "Ada";\n');
  const checkpoint = succeeds(
    await repo.run('change.checkpoint', {
      change_id: 'F-001',
      task_id: 'T-001',
      paths: ['src/person.mjs'],
      message: 'feat(F-001): add person',
    }),
    'change.checkpoint',
  );
  return { repo, checkpoint };
}

async function configuredCiChange(t, { checkStatus, sleepImpl } = {}) {
  let currentPull;
  let headSha;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (init.method === 'GET' && parsed.pathname.endsWith('/pulls')) return response([]);
    if (init.method === 'POST' && parsed.pathname.endsWith('/pulls')) {
      currentPull = pullRequest(headSha);
      return response(currentPull, 201);
    }
    if (parsed.pathname.endsWith('/pulls/42')) return response(currentPull);
    if (parsed.pathname.endsWith('/check-runs'))
      return response({
        total_count: 1,
        check_runs: [
          {
            id: 9,
            name: 'workflow-ci / verify',
            head_sha: headSha,
            status: checkStatus === 'pending' ? 'in_progress' : 'completed',
            conclusion: checkStatus === 'pending' ? null : checkStatus,
          },
        ],
      });
    if (parsed.pathname.endsWith('/status'))
      return response({ sha: headSha, state: checkStatus, statuses: [] });
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const prepared = await pushedChange(t, { fetchImpl, sleepImpl });
  headSha = prepared.checkpoint.commit_sha;
  await prepared.repo.run('pr.ensure', { change_id: 'F-001' });
  return prepared.repo;
}

test('PR ensure creates a ready PR from a pushed task checkpoint and refreshes it idempotently', async (t) => {
  const requests = [];
  let currentHead;
  let currentPull;
  const fetchImpl = async (url, init) => {
    requests.push({
      url: String(url),
      method: init.method,
      body: init.body,
      authorization: init.headers.Authorization,
    });
    if (init.method === 'GET' && String(url).includes('/pulls?')) return response([]);
    if (init.method === 'POST') {
      currentPull = pullRequest(currentHead);
      return response(currentPull, 201);
    }
    if (init.method === 'GET' && String(url).endsWith('/pulls/42')) return response(currentPull);
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const { repo, checkpoint } = await pushedChange(t, { fetchImpl });
  currentHead = checkpoint.commit_sha;
  currentPull = pullRequest(checkpoint.commit_sha);

  const created = succeeds(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure');
  assert.equal(created.pull_request.number, 42);
  assert.equal(created.pull_request.draft, false);
  assert.ok(requests.every((request) => request.authorization === 'Bearer fixture-token'));
  assert.doesNotMatch(JSON.stringify(created), /fixture-token/);
  assert.equal(JSON.parse(requests[1].body).draft, false);
  assert.match(JSON.parse(requests[1].body).body, /F-001/);

  const refreshed = succeeds(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure');
  assert.equal(refreshed.pull_request.number, 42);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
});

test('PR ensure adopts the sole matching open PR and refuses ambiguous duplicates', async (t) => {
  const requests = [];
  let existing;
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method });
    if (init.method === 'GET' && String(url).includes('/pulls?')) return response(existing);
    if (init.method === 'GET' && String(url).endsWith('/pulls/42')) return response(existing[0]);
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const { repo, checkpoint } = await pushedChange(t, { fetchImpl });
  existing = [pullRequest(checkpoint.commit_sha)];
  const adoptionResult = await repo.run('pr.ensure', { change_id: 'F-001' });
  assert.deepEqual(requests, [{ url: requests[0]?.url, method: 'GET' }]);
  const adopted = succeeds(adoptionResult, 'pr.ensure');
  assert.equal(adopted.pull_request.number, 42);

  const duplicate = pullRequest(checkpoint.commit_sha, { number: 43 });
  existing = [existing[0], duplicate];
  fails(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure', 'PR_AMBIGUOUS');
});

test('GitHub operations fail closed without a configured token and do not call the API', async (t) => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return response([]);
  };
  const { repo } = await pushedChange(t, { token: '', fetchImpl });

  fails(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure', 'GITHUB_NOT_CONFIGURED');
  assert.equal(requests, 0);
});

test('configured GitHub API URLs must use HTTPS before the bearer token is sent', async (t) => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return response([]);
  };
  const { repo } = await pushedChange(t, { fetchImpl });
  const profilePath = path.join(repo.projectRoot, '.workflow', 'project.json');
  const fs = await import('node:fs/promises');
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  profile.github.api_url = 'http://api.example.test';
  await fs.writeFile(profilePath, JSON.stringify(profile));

  fails(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure', 'GITHUB_CONFIG_INVALID');
  assert.equal(requests, 0);
});

test('profile API host normalization accepts an equivalent trailing slash', async (t) => {
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET' && String(url).includes('/pulls?')) return response([]);
    if (init.method === 'POST') return response(pullRequest(currentHead), 201);
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const { repo } = await pushedChange(t, { fetchImpl });
  const currentHead = repo.git('rev-parse', 'HEAD');
  const profilePath = path.join(repo.projectRoot, '.workflow', 'project.json');
  const fs = await import('node:fs/promises');
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  profile.github.api_url = `${repositoryConfig.api_url}/`;
  await fs.writeFile(profilePath, JSON.stringify(profile));

  const result = succeeds(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure');
  assert.equal(result.pull_request.head_sha, currentHead);
});

test('pull request links from the API must use HTTPS', async (t) => {
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET' && String(url).includes('/pulls?')) return response([]);
    if (init.method === 'POST')
      return response(
        pullRequest('head-sha', { html_url: 'http://attacker.invalid/pull/42' }),
        201,
      );
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const { repo } = await pushedChange(t, { fetchImpl });

  fails(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure', 'PR_IDENTITY_MISMATCH');
});

test('a previously closed matching pull request is not silently recreated', async (t) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method });
    if (init.method === 'GET' && String(url).includes('/pulls?'))
      return response([pullRequest('head-sha', { state: 'closed' })]);
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const { repo } = await pushedChange(t, { fetchImpl });

  fails(await repo.run('pr.ensure', { change_id: 'F-001' }), 'pr.ensure', 'PR_CLOSED');
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
});

test('CI inspection binds every required check to the current pull request head', async (t) => {
  let currentPull;
  let headSha;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (init.method === 'GET' && parsed.pathname.endsWith('/pulls')) return response([]);
    if (init.method === 'POST') {
      currentPull = pullRequest(headSha);
      return response(currentPull, 201);
    }
    if (parsed.pathname.endsWith('/pulls/42')) return response(currentPull);
    if (parsed.pathname.endsWith(`/commits/${headSha}/check-runs`))
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
    if (parsed.pathname.endsWith(`/commits/${headSha}/status`))
      return response({ sha: headSha, state: 'success', statuses: [] });
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const { repo, checkpoint } = await pushedChange(t, { fetchImpl });
  headSha = checkpoint.commit_sha;
  await repo.run('pr.ensure', { change_id: 'F-001' });

  const inspected = succeeds(await repo.run('ci.inspect', { change_id: 'F-001' }), 'ci.inspect');
  assert.equal(inspected.head_sha, headSha);
  assert.equal(inspected.all_passed, true);
  assert.deepEqual(inspected.checks, [
    { name: 'workflow-ci / verify', state: 'SUCCESS', evidence: ['check_run:9'] },
  ]);
});

test('CI inspection fails closed when a check belongs to a different head revision', async (t) => {
  let currentPull;
  let headSha;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (init.method === 'GET' && parsed.pathname.endsWith('/pulls')) return response([]);
    if (init.method === 'POST') {
      currentPull = pullRequest(headSha);
      return response(currentPull, 201);
    }
    if (parsed.pathname.endsWith('/pulls/42')) return response(currentPull);
    if (parsed.pathname.endsWith('/check-runs'))
      return response({
        total_count: 1,
        check_runs: [
          {
            id: 9,
            name: 'workflow-ci / verify',
            head_sha: 'old-head',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      });
    if (parsed.pathname.endsWith('/status'))
      return response({ sha: headSha, state: 'success', statuses: [] });
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const { repo, checkpoint } = await pushedChange(t, { fetchImpl });
  headSha = checkpoint.commit_sha;
  await repo.run('pr.ensure', { change_id: 'F-001' });

  fails(await repo.run('ci.inspect', { change_id: 'F-001' }), 'ci.inspect', 'STALE_REVISION');
});

test('CI await polls pending checks and returns only after every required check passes', async (t) => {
  let currentPull;
  let headSha;
  let attempts = 0;
  let delays = 0;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (init.method === 'GET' && parsed.pathname.endsWith('/pulls')) return response([]);
    if (init.method === 'POST' && parsed.pathname.endsWith('/pulls')) {
      currentPull = pullRequest(headSha);
      return response(currentPull, 201);
    }
    if (parsed.pathname.endsWith('/pulls/42')) return response(currentPull);
    if (parsed.pathname.endsWith('/check-runs')) {
      attempts += 1;
      const complete = attempts > 1;
      return response({
        total_count: 1,
        check_runs: [
          {
            id: 9,
            name: 'workflow-ci / verify',
            head_sha: headSha,
            status: complete ? 'completed' : 'in_progress',
            conclusion: complete ? 'success' : null,
          },
        ],
      });
    }
    if (parsed.pathname.endsWith('/status'))
      return response({ sha: headSha, state: 'pending', statuses: [] });
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const { repo, checkpoint } = await pushedChange(t, {
    fetchImpl,
    sleepImpl: async () => {
      delays += 1;
    },
  });
  headSha = checkpoint.commit_sha;
  await repo.run('pr.ensure', { change_id: 'F-001' });

  const result = succeeds(
    await repo.run('ci.await', {
      change_id: 'F-001',
      timeout_ms: 2_000,
      poll_interval_ms: 1,
    }),
    'ci.await',
  );
  assert.equal(result.state, 'SUCCESS');
  assert.equal(result.head_sha, headSha);
  assert.equal(result.attempts, 2);
  assert.equal(result.inspection.all_passed, true);
  assert.equal(delays, 1);
});

test('CI await reports a required check failure without waiting for the timeout', async (t) => {
  const repo = await configuredCiChange(t, { checkStatus: 'failure' });

  fails(
    await repo.run('ci.await', { change_id: 'F-001', timeout_ms: 5_000, poll_interval_ms: 1 }),
    'ci.await',
    'CI_FAILED',
  );
});

test('CI await stops polling when its bounded timeout expires', async (t) => {
  const repo = await configuredCiChange(t, {
    checkStatus: 'pending',
    sleepImpl: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds + 10)),
  });

  fails(
    await repo.run('ci.await', { change_id: 'F-001', timeout_ms: 1, poll_interval_ms: 1 }),
    'ci.await',
    'CI_TIMEOUT',
  );
});
