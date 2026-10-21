import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateArtifact } from '../../workflow/lib/contracts.mjs';

const SHA = /^[a-f0-9]{40}$/;

export function createEvaluationReport({
  runId,
  runAttempt,
  changeId,
  evaluatorSha,
  candidateSha,
  candidateVersion,
  result,
}) {
  if (!/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(runAttempt)))
    throw new Error('Evaluation run and attempt IDs must be numeric.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(changeId ?? ''))
    throw new Error('Evaluation change ID must be a portable identifier.');
  if (!SHA.test(evaluatorSha ?? '') || !SHA.test(candidateSha ?? ''))
    throw new Error('Evaluator and candidate identities must be exact commit SHAs.');
  if (!['success', 'failure', 'skipped', 'not-run'].includes(result))
    throw new Error('Evaluation result is not recognized.');
  if (typeof candidateVersion !== 'string' || !candidateVersion.trim())
    throw new Error('Candidate version must be reported.');
  return {
    schema_version: '1',
    type: 'evaluation-report',
    id: `EVAL-${runId}-${runAttempt}`,
    change_id: changeId,
    title: 'Workflow candidate evaluation',
    status: 'recorded',
    data: {
      baseline_version: 'pinned-workflow-evaluator',
      candidate_version: candidateVersion,
      scenarios: ['format:check', 'check', 'test'],
      correctness: { checks_result: result },
      interventions: {
        evaluator_sha: evaluatorSha,
        evaluator_run_attempt: Number(runAttempt),
        candidate_sha: candidateSha,
      },
      duration: {},
      cost: {},
      limitations: [
        'This report is test evidence only. It does not authorize activation or migration.',
      ],
    },
  };
}

async function main() {
  const outputPath = path.resolve(process.argv[2]);
  const candidateDirectory = path.resolve(process.argv[3]);
  const candidateManifest = JSON.parse(
    await fs.readFile(path.join(candidateDirectory, 'workflow/bundle/manifest.json'), 'utf8'),
  );
  const report = createEvaluationReport({
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    changeId: process.env.CHANGE_ID,
    evaluatorSha: process.env.EVALUATOR_SHA,
    candidateSha: process.env.CANDIDATE_SHA,
    candidateVersion: candidateManifest.bundle_version,
    result: process.env.CHECK_RESULT || 'not-run',
  });
  await validateArtifact(report);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
