import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateArtifact } from '../../workflow/lib/contracts.mjs';

test('candidate evaluation is manually dispatched from the integration branch with read-only access', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/workflow-evaluate.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /WORKFLOW_REF" != "refs\/heads\/\$EXPECTED_BASE_BRANCH"/);
  assert.match(workflow, /candidate_sha/);
  assert.match(workflow, /change_id/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /evaluation-report\.json/);
  assert.match(workflow, /does not activate/i);
  assert.match(
    workflow,
    /ref: \$\{\{ vars\.WORKFLOW_BASE_BRANCH \|\| github\.event\.repository\.default_branch \}\}[\s\S]*?path: evaluator/,
  );
  assert.doesNotMatch(workflow, /pull_request:|packages:\s*write|contents:\s*write|secrets\./);
});

test('candidate evaluation reports exact immutable identities and cannot grant activation', async () => {
  const { createEvaluationReport } = await import('../../scripts/workflow/evaluation-report.mjs');
  const report = createEvaluationReport({
    runId: '123',
    runAttempt: '2',
    changeId: 'W-TEST-1',
    evaluatorSha: 'a'.repeat(40),
    candidateSha: 'b'.repeat(40),
    candidateVersion: '0.2.0',
    result: 'success',
  });
  assert.equal((await validateArtifact(report)).valid, true);
  assert.equal(report.type, 'evaluation-report');
  assert.equal(report.data.interventions.evaluator_sha, 'a'.repeat(40));
  assert.equal(report.id, 'EVAL-123-2');
  assert.equal(report.change_id, 'W-TEST-1');
  assert.equal(report.data.interventions.evaluator_run_attempt, 2);
  assert.equal(report.data.interventions.candidate_sha, 'b'.repeat(40));
  assert.match(report.data.limitations.join(' '), /does not authorize activation or migration/i);
  assert.throws(
    () =>
      createEvaluationReport({
        runId: '123',
        runAttempt: '1',
        changeId: 'W-TEST-1',
        evaluatorSha: 'main',
        candidateSha: 'b'.repeat(40),
        candidateVersion: '0.2.0',
        result: 'success',
      }),
    /exact commit SHAs/,
  );
});
