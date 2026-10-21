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

function response(body, status = 200) {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mergedChange(t, { deleteBranchOnMerge = true, remoteBranchAbsent = true } = {}) {
  let branch;
  let headSha;
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/pulls/42')) return response(pullRequest);
    if (parsed.pathname === '/repos/example-org/project-x')
      return response({ delete_branch_on_merge: deleteBranchOnMerge });
    if (parsed.pathname.includes('/git/ref/heads/'))
      return remoteBranchAbsent
        ? response(null, 404)
        : response({ ref: `refs/heads/${branch}`, object: { sha: headSha } });
    throw new Error(`Unexpected API request: ${init.method} ${url}`);
  };
  const repo = await repository(t, {
    context: { env: { GH_TOKEN: 'fixture-token', GITHUB_API_URL: apiUrl }, fetchImpl },
  });
  await initialize(repo, { github });
  const started = await startFeature(repo);
  branch = started.change.branch;
  await repo.write('src/person.mjs', 'export const person = "Ada";\n');
  repo.git('add', 'src/person.mjs');
  repo.git('commit', '-m', 'feat(F-001): add person');
  headSha = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', 'main');
  await repo.write('merge-marker.txt', 'squash merge is on base\n');
  repo.git('add', 'merge-marker.txt');
  repo.git('commit', '-m', 'feat(F-001): merge person');
  const mergeCommitSha = repo.git('rev-parse', 'HEAD');

  const pullRequest = {
    number: 42,
    html_url: 'https://github.example.test/example-org/project-x/pull/42',
    state: 'closed',
    draft: false,
    merged: true,
    merge_commit_sha: mergeCommitSha,
    head: {
      ref: branch,
      sha: headSha,
      repo: { full_name: 'example-org/project-x' },
    },
    base: { ref: 'main', sha: mergeCommitSha, repo: { full_name: 'example-org/project-x' } },
    user: { login: 'change-author', type: 'User' },
  };
  const statePath = path.join(repo.projectRoot, '.workflow', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const change = state.changes['F-001'];
  change.pull_request = {
    number: 42,
    url: pullRequest.html_url,
    state: 'closed',
    draft: false,
    head_ref: branch,
    head_sha: headSha,
    base_ref: 'main',
    base_sha: mergeCommitSha,
    merged: true,
    merge_commit_sha: mergeCommitSha,
    author_login: 'change-author',
  };
  change.merge_receipt = {
    pull_request_number: 42,
    head_sha: headSha,
    merge_commit_sha: mergeCommitSha,
    merge_method: 'squash',
    merged_at: new Date().toISOString(),
    recovered: false,
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { repo, branch, headSha, mergeCommitSha };
}

test('cleanup removes only the unchanged local branch after GitHub confirms squash merge and remote deletion', async (t) => {
  const { repo, branch, headSha, mergeCommitSha } = await mergedChange(t);
  await repo.write('local-notes.txt', 'unsaved user work stays untouched\n');
  const statePath = path.join(repo.projectRoot, '.workflow', 'state.json');
  const revision = JSON.parse(await readFile(statePath, 'utf8')).revision;

  const result = succeeds(
    await repo.run('change.cleanup', { change_id: 'F-001', expected_revision: revision }),
    'change.cleanup',
  );

  assert.equal(result.cleanup.remote_branch_status, 'AUTO_DELETED_AFTER_MERGE');
  assert.equal(result.cleanup.local_branch_deleted, true);
  assert.equal(result.cleanup.head_sha, headSha);
  assert.equal(result.cleanup.merge_commit_sha, mergeCommitSha);
  assert.equal(repo.git('branch', '--list', branch).trim(), '');
  assert.equal(
    await readFile(path.join(repo.projectRoot, 'local-notes.txt'), 'utf8'),
    'unsaved user work stays untouched\n',
  );
  const retryState = JSON.parse(await readFile(statePath, 'utf8'));
  const retry = succeeds(
    await repo.run('change.cleanup', {
      change_id: 'F-001',
      expected_revision: retryState.revision,
    }),
    'change.cleanup',
  );
  assert.equal(retry.already_cleaned, true);
});

test('cleanup preserves the local branch when automatic remote deletion is not enabled', async (t) => {
  const { repo, branch } = await mergedChange(t, { deleteBranchOnMerge: false });
  const statePath = path.join(repo.projectRoot, '.workflow', 'state.json');
  const revision = JSON.parse(await readFile(statePath, 'utf8')).revision;

  fails(
    await repo.run('change.cleanup', { change_id: 'F-001', expected_revision: revision }),
    'change.cleanup',
    'CLEANUP_POLICY_REQUIRED',
  );
  assert.equal(
    repo.git('show-ref', '--verify', '--hash', `refs/heads/${branch}`),
    JSON.parse(await readFile(statePath, 'utf8')).changes['F-001'].merge_receipt.head_sha,
  );
});

test('cleanup waits for GitHub automatic deletion before removing the local branch', async (t) => {
  const { repo, branch, headSha } = await mergedChange(t, { remoteBranchAbsent: false });
  const statePath = path.join(repo.projectRoot, '.workflow', 'state.json');
  const revision = JSON.parse(await readFile(statePath, 'utf8')).revision;

  fails(
    await repo.run('change.cleanup', { change_id: 'F-001', expected_revision: revision }),
    'change.cleanup',
    'CLEANUP_PENDING',
  );
  assert.equal(repo.git('for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`), headSha);
});

test('cleanup refuses to remove a local branch that moved after merge', async (t) => {
  const { repo, branch } = await mergedChange(t);
  repo.git('checkout', branch);
  await repo.write('post-merge-work.txt', 'preserve this work\n');
  repo.git('add', 'post-merge-work.txt');
  repo.git('commit', '-m', 'wip: preserve later branch work');
  repo.git('checkout', 'main');
  const statePath = path.join(repo.projectRoot, '.workflow', 'state.json');
  const revision = JSON.parse(await readFile(statePath, 'utf8')).revision;

  fails(
    await repo.run('change.cleanup', { change_id: 'F-001', expected_revision: revision }),
    'change.cleanup',
    'LOCAL_BRANCH_CHANGED',
  );
  assert.notEqual(repo.git('branch', '--list', branch).trim(), '');
});
