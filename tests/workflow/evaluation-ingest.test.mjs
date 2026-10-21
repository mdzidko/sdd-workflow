import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluationReport } from '../../scripts/workflow/evaluation-report.mjs';
import { fails, initialize, repository, succeeds } from './helpers.mjs';

const github = {
  owner: 'example-org',
  name: 'project-x',
  api_url: 'https://api.example.test',
};

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipReport(report) {
  const name = Buffer.from('evaluation/evaluation-report.json');
  const contents = Buffer.from(JSON.stringify(report));
  const checksum = crc32(contents);
  const local = Buffer.alloc(30 + name.length + contents.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  contents.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

test('evaluation import binds a retained Actions report to the current workflow candidate', async (t) => {
  const evaluatorSha = 'a'.repeat(40);
  let candidateBranch;
  let candidateSha;
  let runConclusion = 'success';
  let reportArchive;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/pulls/7'))
      return new Response(
        JSON.stringify({
          number: 7,
          html_url: 'https://github.com/example-org/project-x/pull/7',
          state: 'open',
          draft: true,
          head: {
            ref: candidateBranch,
            sha: candidateSha,
            repo: { full_name: 'example-org/project-x' },
          },
          base: {
            ref: 'main',
            sha: 'b'.repeat(40),
            repo: { full_name: 'example-org/project-x' },
          },
          user: { login: 'author' },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    if (parsed.pathname.endsWith('/actions/runs/88'))
      return new Response(
        JSON.stringify({
          id: 88,
          event: 'workflow_dispatch',
          status: 'completed',
          conclusion: runConclusion,
          head_branch: 'main',
          head_sha: evaluatorSha,
          run_attempt: 2,
          path: '.github/workflows/workflow-evaluate.yml',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    if (parsed.pathname.endsWith('/branches/main'))
      return new Response(JSON.stringify({ commit: { sha: evaluatorSha } }), {
        headers: { 'content-type': 'application/json' },
      });
    if (parsed.pathname.endsWith('/actions/runs/88/artifacts'))
      return new Response(
        JSON.stringify({
          total_count: 1,
          artifacts: [
            {
              id: 99,
              name: 'workflow-evaluation-88-2',
              expired: false,
              size_in_bytes: reportArchive.length,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    if (parsed.pathname.endsWith('/actions/artifacts/99/zip'))
      return new Response(null, {
        status: 302,
        headers: { location: 'https://artifact.example.test/download' },
      });
    if (parsed.hostname === 'artifact.example.test') {
      assert.equal(
        options.headers?.Authorization,
        undefined,
        'GitHub credentials must not follow the signed redirect.',
      );
      return new Response(reportArchive, { headers: { 'content-type': 'application/zip' } });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const repo = await repository(t, {
    context: {
      env: { GH_TOKEN: 'fixture-token', GITHUB_API_URL: github.api_url },
      fetchImpl,
    },
  });
  await initialize(repo, {
    repository: { remote: 'origin', base_branch: 'main' },
    github: {
      ...github,
      required_reviewers: ['reviewer'],
      automation_logins: ['workflow-bot[bot]'],
    },
  });
  const { change } = succeeds(
    await repo.run('change.start', {
      id: 'W-001',
      kind: 'WORKFLOW_CHANGE',
      description: 'Import trusted candidate evaluation reports',
    }),
    'change.start',
  );
  candidateBranch = change.branch;
  await repo.write(
    'workflow/bundle/manifest.json',
    `${JSON.stringify({ bundle_version: '0.2.0' }, null, 2)}\n`,
  );
  repo.git('add', 'workflow/bundle/manifest.json');
  repo.git('commit', '-m', 'Add workflow candidate manifest');
  candidateSha = repo.git('rev-parse', 'HEAD');
  reportArchive = zipReport(
    createEvaluationReport({
      runId: '88',
      runAttempt: '2',
      changeId: change.id,
      evaluatorSha,
      candidateSha,
      candidateVersion: '0.2.0',
      result: 'success',
    }),
  );
  const stateFile = `${repo.projectRoot}/.workflow/state.json`;
  const { readFile, writeFile } = await import('node:fs/promises');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.changes['W-001'].stage = 'EVALUATION';
  state.changes['W-001'].pull_request = { number: 7 };
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const imported = succeeds(
    await repo.run('evaluation.ingest', { change_id: 'W-001', run_id: 88 }),
    'evaluation.ingest',
  );
  assert.equal(imported.evaluation.candidate_sha, candidateSha);
  assert.equal(imported.evaluation.evaluator_sha, evaluatorSha);
  assert.equal(imported.evaluation.run_attempt, 2);
  runConclusion = 'failure';
  fails(
    await repo.run('evaluation.ingest', { change_id: 'W-001', run_id: 88 }),
    'evaluation.ingest',
    'EVALUATION_RUN_UNTRUSTED',
  );
  runConclusion = 'success';
  const gate = succeeds(await repo.run('stage.inspect', { change_id: 'W-001' }), 'stage.inspect');
  assert.equal(gate.transition.ready, true);
  assert.equal(gate.transition.evidence[0].type, 'trusted_candidate_evaluation');

  const changed = await readFile(`${repo.projectRoot}/${imported.evaluation.report_path}`, 'utf8');
  await writeFile(
    `${repo.projectRoot}/${imported.evaluation.report_path}`,
    changed.replace('0.2.0', '0.3.0'),
  );
  const invalidated = succeeds(
    await repo.run('stage.inspect', { change_id: 'W-001' }),
    'stage.inspect',
  );
  assert.equal(invalidated.transition.ready, false);
  assert.ok(
    invalidated.transition.missing.some(
      (item) => item.reason === 'trusted_candidate_evaluation_stale_or_invalid',
    ),
  );
  await writeFile(`${repo.projectRoot}/${imported.evaluation.report_path}`, changed);
  const currentGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'W-001' }),
    'stage.inspect',
  );
  assert.equal(currentGate.transition.ready, true);
  const workflow = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const advanced = succeeds(
    await repo.run('stage.advance', {
      change_id: 'W-001',
      expected_stage: 'EVALUATION',
      expected_revision: workflow.revision,
      to: 'INTEGRATION',
    }),
    'stage.advance',
  );
  assert.equal(advanced.change.stage, 'INTEGRATION');
});
