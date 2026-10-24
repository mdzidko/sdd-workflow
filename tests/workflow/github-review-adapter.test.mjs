import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fails, initialize, repository, startFeature, succeeds } from './helpers.mjs';

const apiUrl = 'https://api.example.test';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function acceptedArtifactProject(t, { fetchImpl = async () => response([]) } = {}) {
  const repo = await repository(t, {
    context: { env: { GH_TOKEN: 'fixture-token', GITHUB_API_URL: apiUrl }, fetchImpl },
  });
  const remote = await mkdtemp(path.join(tmpdir(), 'codex-workflow-chat-approval-'));
  t.after(() =>
    import('node:fs/promises').then(({ rm }) => rm(remote, { recursive: true, force: true })),
  );
  execFileSync('git', ['init', '--bare', remote], { windowsHide: true });
  repo.git('remote', 'add', 'origin', remote);
  repo.git('push', '-u', 'origin', 'main');
  const fixture = fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url));
  await initialize(repo, {
    github: {
      owner: 'example-org',
      name: 'project-x',
      api_url: apiUrl,
      required_checks: ['workflow-ci / verify'],
    },
    commands: {
      focused: { command: process.execPath, args: ['--test', fixture], timeout_ms: 2_000 },
    },
  });
  await startFeature(repo);
  await repo
    .run('artifact.create', {
      change_id: 'F-001',
      id: 'REQ-001',
      type: 'requirements',
      title: 'Feature requirements',
      data: { requirements: [{ id: 'R-001', description: 'A person can be added.' }] },
    })
    .then((result) => succeeds(result, 'artifact.create'));
  return repo;
}

test('business acceptance is recorded from chat against the inspected artifact revision', async (t) => {
  const repo = await acceptedArtifactProject(t);
  const result = succeeds(await repo.accept('F-001', 'REQ-001'), 'decision.accept');

  assert.equal(result.approval.status, 'APPROVED');
  assert.equal(result.approval.provider, 'codex_chat');
  assert.equal(result.approval.reviewer, 'user');
  const inspection = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  assert.equal(inspection.changes[0].approvals[0].status, 'APPROVED');
});

test('chat acceptance rejects missing decisions and stale artifact content', async (t) => {
  const repo = await acceptedArtifactProject(t);
  const inspection = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const reference = inspection.changes[0].artifacts.find((item) => item.id === 'REQ-001');

  fails(
    await repo.run('decision.accept', {
      change_id: 'F-001',
      artifact_id: 'REQ-001',
      expected_revision: inspection.revision,
      expected_content_hash: reference.content_hash,
    }),
    'decision.accept',
    'VALIDATION_FAILED',
  );

  await repo.write(reference.path, `${JSON.stringify({ schema_version: '1', changed: true })}\n`);
  fails(
    await repo.run('decision.accept', {
      change_id: 'F-001',
      artifact_id: 'REQ-001',
      decision: 'APPROVED',
      expected_revision: inspection.revision,
      expected_content_hash: reference.content_hash,
    }),
    'decision.accept',
    'STALE_ARTIFACT',
  );
});

test('a rejection in chat records REJECTED against the exact current artifact', async (t) => {
  const repo = await acceptedArtifactProject(t);
  const rejected = succeeds(await repo.accept('F-001', 'REQ-001', 'REJECTED'), 'decision.accept');
  assert.equal(rejected.approval.status, 'REJECTED');
  assert.equal(rejected.approval.provider, 'codex_chat');
});
