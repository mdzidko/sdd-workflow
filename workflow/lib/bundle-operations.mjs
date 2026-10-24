import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { bundleRoot, validateArtifact, validatePlan } from './contracts.mjs';
import {
  atomicWrite,
  fingerprint,
  git,
  hash,
  identifier,
  posix,
  requireValue,
  safePath,
  sourceFiles,
  WorkflowError,
} from './support.mjs';
import {
  findChange,
  inspectOperationLock,
  load,
  readJson,
  recoverOperationLock,
  recoverRecoveryGuard,
  save,
  stateFile,
} from './state.mjs';
import { registerGithubOperations } from './github-operations.mjs';
import { registerDeploymentOperations } from './deployment-operations.mjs';
import { registerDeliveryGithubOperations } from './delivery-github-operations.mjs';

const testAuthorRoles = new Set(['test_author', 'sdlc_test_author']);
const implementerRoles = new Set(['implementer', 'sdlc_implementer']);
const planDrivenKinds = new Set(['FEATURE', 'MAINTENANCE', 'WORKFLOW_CHANGE']);

function dockerProbe(context, projectRoot, args) {
  try {
    const options = {
      cwd: projectRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      env: { ...process.env, ...(context.env ?? {}) },
    };
    const result = context.dockerRunner
      ? context.dockerRunner('docker', args, options)
      : spawnSync('docker', args, options);
    if (result.error || result.status !== 0) return null;
    return (result.stdout ?? '').trim();
  } catch {
    return null;
  }
}

function reportedVersion(value) {
  const match = /^(?:v)?(\d+\.\d+(?:\.\d+){0,2})$/.exec(value ?? '');
  return match?.[1] ?? null;
}

function canonicalRole(role) {
  return role?.startsWith('sdlc_') ? role.slice('sdlc_'.length) : role;
}

export async function acceptedFeaturePlan(projectRoot, change) {
  const acceptance = [...(change.stage_history ?? [])]
    .reverse()
    .find((transition) => transition.to === 'IMPLEMENTATION')
    ?.evidence?.find((item) => item.type === 'implementation-plan');
  requireValue(acceptance, 'GATE_BLOCKED', 'No reviewed implementation plan is recorded.');
  const ref = change.artifacts.find((artifact) => artifact.id === acceptance.artifact_id);
  requireValue(ref, 'GATE_BLOCKED', 'The reviewed implementation plan reference is missing.');
  const artifact = await readJson(await safePath(projectRoot, ref.path));
  requireValue(
    hash(artifact) === acceptance.content_hash && ref.content_hash === acceptance.content_hash,
    'PLAN_STALE',
    'The reviewed implementation plan changed after planning was accepted.',
  );
  return { acceptance, ref, artifact, plan: artifact.data };
}

async function validateMaintenanceImpactMap(projectRoot, artifact) {
  const { profile } = await load(projectRoot);
  const applications = profile.applications ?? [];
  const entries = artifact.data.applications;
  requireValue(
    Array.isArray(entries) && entries.length === applications.length,
    'VALIDATION_FAILED',
    'A maintenance impact map must classify every configured application exactly once.',
  );
  const seen = new Set();
  for (const entry of entries) {
    requireValue(
      entry &&
        typeof entry.application_id === 'string' &&
        ['AFFECTED', 'UNAFFECTED', 'UNKNOWN'].includes(entry.impact) &&
        typeof entry.rationale === 'string' &&
        entry.rationale.trim().length > 0 &&
        applications.some((application) => application.id === entry.application_id) &&
        !seen.has(entry.application_id),
      'VALIDATION_FAILED',
      'Each impact-map application needs a configured application_id, AFFECTED/UNAFFECTED/UNKNOWN impact, and a rationale.',
    );
    seen.add(entry.application_id);
  }
  return {
    affected_application_ids: entries
      .filter((entry) => entry.impact === 'AFFECTED')
      .map((entry) => entry.application_id),
    unknown_application_ids: entries
      .filter((entry) => entry.impact === 'UNKNOWN')
      .map((entry) => entry.application_id),
  };
}

function missingIncrementTaskEvidence(change, state, plannedTasks, noFileOutcome = false) {
  return plannedTasks.flatMap((planned) => {
    const task = change.tasks[planned.id];
    if (!task || task.state !== 'DONE' || task.review?.status !== 'ACCEPTED')
      return [{ task_id: planned.id, reason: 'task_review_incomplete' }];
    if (
      testAuthorRoles.has(task.role) &&
      !(noFileOutcome
        ? hasReviewedGreenEvidence(change, task, state)
        : hasReviewedRedEvidence(change, task, state))
    )
      return [{ task_id: planned.id, reason: 'reviewed_red_evidence_missing' }];
    if (
      implementerRoles.has(task.role) &&
      (task.result?.verification_mode !== 'GREEN' ||
        !task.result.run_ids.some(
          (runId) =>
            state.runs[runId]?.change_id === change.id &&
            state.runs[runId]?.classification === 'PASS',
        ))
    )
      return [{ task_id: planned.id, reason: 'green_evidence_missing' }];
    return [];
  });
}

function hasReviewedRedEvidence(change, task, state) {
  const runIds = task?.result?.expected_red_run_ids;
  return (
    testAuthorRoles.has(task?.role) &&
    task.state === 'DONE' &&
    task.review?.status === 'ACCEPTED' &&
    task.review?.provider === 'workflow_verification' &&
    task.result?.verification_mode === 'EXPECTED_RED' &&
    Array.isArray(runIds) &&
    runIds.length > 0 &&
    runIds.every((runId) => {
      const run = state.runs[runId];
      return (
        task.result.run_ids.includes(runId) &&
        run?.change_id === change.id &&
        run.classification === 'ASSERTION_FAILURE' &&
        change.evidence.some((item) => item.phase === 'RED' && item.run_id === runId)
      );
    })
  );
}

function hasReviewedGreenEvidence(change, task, state) {
  const runIds = task?.result?.run_ids;
  return (
    testAuthorRoles.has(task?.role) &&
    task.state === 'DONE' &&
    task.review?.status === 'ACCEPTED' &&
    task.review?.provider === 'workflow_verification' &&
    task.result?.verification_mode === 'GREEN' &&
    Array.isArray(runIds) &&
    runIds.length > 0 &&
    runIds.every((runId) => {
      const run = state.runs[runId];
      return run?.change_id === change.id && run.classification === 'PASS';
    })
  );
}

async function treeFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    requireValue(
      !entry.isSymbolicLink(),
      'INSTALL_CONFLICT',
      'Bundle sources must not contain symbolic links.',
    );
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await treeFiles(file)));
    else result.push(file);
  }
  return result;
}

async function manifest() {
  return JSON.parse(await fs.readFile(path.join(bundleRoot, 'manifest.json'), 'utf8'));
}

async function inventory() {
  const output = new Map();
  for (const resource of (await manifest()).resources) {
    const source = await safePath(bundleRoot, resource.source, { protectedAccess: true });
    const files = resource.kind === 'directory' ? await treeFiles(source) : [source];
    for (const file of files)
      output.set(
        posix(
          resource.kind === 'directory'
            ? path.join(resource.destination, path.relative(source, file))
            : resource.destination,
        ),
        file,
      );
  }
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  for (const directory of ['workflow/lib', 'workflow/bundle']) {
    for (const file of await treeFiles(path.join(sourceRoot, directory)))
      output.set(posix(path.relative(sourceRoot, file)), file);
  }
  output.set('scripts/workflow/run.mjs', path.join(sourceRoot, 'scripts/workflow/run.mjs'));
  return [...output].map(([destination, source]) => ({ destination, source }));
}

async function bundleIdentity() {
  const bundleManifest = await manifest();
  const files = await inventory();
  const contents = await Promise.all(
    files.map(async ({ destination, source }) => ({
      path: destination,
      sha256: hash(await fs.readFile(source)),
    })),
  );
  contents.sort((left, right) => left.path.localeCompare(right.path));
  return {
    manifest: bundleManifest,
    manifest_hash: hash({ bundle_version: bundleManifest.bundle_version, files: contents }),
    files: contents,
  };
}

async function prepareBundleInstallation(projectRoot) {
  let installed = null;
  try {
    installed = JSON.parse(
      await fs.readFile(await stateFile(projectRoot, 'installed-bundle.json'), 'utf8'),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const candidate = await bundleIdentity();
  requireValue(
    installed === null ||
      (installed.bundle_version === candidate.manifest.bundle_version &&
        installed.manifest_hash === candidate.manifest_hash),
    'BUNDLE_VERSION_CONFLICT',
    'The installed workflow bundle has a different immutable identity. Use the separately reviewed migration and activation process; no files were changed.',
  );
  const files = await inventory();
  const writes = [];
  for (const item of files) {
    const destination = await safePath(projectRoot, item.destination, { protectedAccess: true });
    const bytes = await fs.readFile(item.source);
    try {
      requireValue(
        (await fs.readFile(destination)).equals(bytes),
        'INSTALL_CONFLICT',
        `Existing file differs: ${item.destination}. No bundle files were overwritten.`,
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      writes.push({ destination, bytes, relativePath: item.destination });
    }
  }
  return { candidate, files, writes };
}

async function writeBundleInstallation(projectRoot, plan) {
  for (const item of plan.writes) await atomicWrite(item.destination, item.bytes);
  const record = {
    bundle_version: plan.candidate.manifest.bundle_version,
    manifest_hash: plan.candidate.manifest_hash,
    installed_at: new Date().toISOString(),
    files: plan.files.map((item) => item.destination),
    requires_reload: true,
    native_invocation_verified: false,
  };
  await atomicWrite(
    await stateFile(projectRoot, 'installed-bundle.json'),
    JSON.stringify(record, null, 2) + '\n',
  );
  return { ...record, written_files: plan.writes.length };
}

function insidePath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

async function ensureWorkflowStateIgnored(projectRoot, env) {
  const excludePath = path.resolve(
    projectRoot,
    git(projectRoot, ['rev-parse', '--git-path', 'info/exclude'], { env }),
  );
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  let content = '';
  try {
    content = await fs.readFile(excludePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!content.split(/\r?\n/).includes('.workflow/'))
    await fs.appendFile(
      excludePath,
      `${content.endsWith('\n') || content.length === 0 ? '' : '\n'}.workflow/\n`,
    );
}

function setupStatus(projectRoot, env) {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...(env ?? {}) },
  });
  requireValue(
    !result.error && result.status === 0,
    'GIT_FAILED',
    'Could not inspect the target repository status.',
  );
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(
      (line) =>
        !['.workflow/operation.lock', '.workflow/setup.pending.json'].includes(line.slice(3)),
    )
    .join('\n');
}

const setupCommitPaths = [
  '.agents/skills',
  '.codex/agents',
  'workflow/lib',
  'workflow/bundle',
  'scripts/workflow/run.mjs',
];

function setupOwnedStatus(status) {
  const allowed = setupCommitPaths.map((item) => `${item}/`);
  allowed.push('scripts/workflow/run.mjs');
  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .every((line) => {
      const file = line.slice(3).replace(/^"|"$/g, '');
      return allowed.some((prefix) => file === prefix || file.startsWith(prefix));
    });
}

const initializationTransitions = {
  FOUNDATIONS: {
    next: 'ARCHITECTURE',
    artifact_types: ['product-charter', 'mvp-map', 'constraints'],
  },
  ARCHITECTURE: {
    next: 'BOOTSTRAP',
    artifact_types: [
      'architecture',
      'application-inventory',
      'contract-inventory',
      'implementation-standards',
      'test-standards',
      'delivery-strategy',
    ],
  },
  BOOTSTRAP: { next: 'COMPLETE', artifact_types: [] },
};

const featureTransitions = {
  REQUIREMENTS: { next: 'PLANNING', artifact_types: ['requirements', 'scenarios'] },
  PLANNING: { next: 'IMPLEMENTATION', artifact_types: ['implementation-plan'] },
  IMPLEMENTATION: { next: 'INTEGRATION', artifact_types: [] },
  INTEGRATION: { next: 'COMPLETE', artifact_types: [] },
};
const workflowChangeTransitions = {
  ...featureTransitions,
  IMPLEMENTATION: { next: 'EVALUATION', artifact_types: [] },
  EVALUATION: { next: 'INTEGRATION', artifact_types: [] },
};
const bugfixTransitions = {
  REPRODUCTION: { next: 'IMPLEMENTATION', artifact_types: ['defect-report'] },
  IMPLEMENTATION: { next: 'COMPLETE', artifact_types: [] },
};

async function inspectInitializationTransition(projectRoot, change, state) {
  const transition = initializationTransitions[change.stage];
  if (!transition) return { supported: false, stage: change.stage };
  if (transition.next === 'COMPLETE') {
    const merge = change.merge_receipt;
    const merged =
      ['user', 'squash'].includes(merge?.merge_method) &&
      /^[a-f0-9]{40}$/i.test(merge.merge_commit_sha ?? '') &&
      /^[a-f0-9]{40}$/i.test(merge.head_sha ?? '') &&
      merge.recovered !== true;
    return {
      supported: true,
      from: change.stage,
      to: transition.next,
      ready: merged,
      missing: merged ? [] : ['manual_merge_confirmation'],
      evidence: merged ? [{ type: 'merge_receipt', sha: merge.merge_commit_sha }] : [],
      artifact_types: [],
      decision_artifact_types: [],
    };
  }

  const missing = [];
  const evidence = [];
  for (const type of transition.artifact_types) {
    const refs = change.artifacts.filter((artifact) => artifact.type === type);
    const ref = refs.at(-1);
    if (!ref) {
      missing.push({ type, reason: 'artifact_missing' });
      continue;
    }
    let artifact;
    try {
      artifact = await readJson(await safePath(projectRoot, ref.path));
      await validateArtifact(artifact);
    } catch (error) {
      missing.push({
        type,
        artifact_id: ref.id,
        reason: 'artifact_invalid',
        validation_code: error.code ?? 'VALIDATION_FAILED',
      });
      continue;
    }
    const contentHash = hash(artifact);
    if (contentHash !== ref.content_hash) {
      missing.push({ type, artifact_id: ref.id, reason: 'artifact_changed' });
      continue;
    }
    const decision = change.approvals.find((candidate) => candidate.artifact_id === ref.id);
    if (
      !decision ||
      decision.status !== 'APPROVED' ||
      decision.provider !== 'codex_chat' ||
      decision.subject_hash !== contentHash ||
      typeof decision.reviewer !== 'string'
    ) {
      missing.push({
        type,
        artifact_id: ref.id,
        subject_hash: contentHash,
        reason: decision?.status === 'REJECTED' ? 'user_rejected' : 'chat_approval_missing',
      });
      continue;
    }
    evidence.push({
      type,
      artifact_id: ref.id,
      content_hash: contentHash,
      reviewer: decision.reviewer,
      decided_at: decision.decided_at,
    });
  }
  return {
    supported: true,
    from: change.stage,
    to: transition.next,
    ready: missing.length === 0,
    missing,
    evidence,
    artifact_types: transition.artifact_types,
    decision_artifact_types: transition.artifact_types,
    state_revision: state.revision,
  };
}

async function inspectFeatureTransition(projectRoot, change, state, validateSpecification) {
  const transitions =
    change.kind === 'WORKFLOW_CHANGE' ? workflowChangeTransitions : featureTransitions;
  const registeredTransition = transitions[change.stage];
  const transition =
    change.kind === 'MAINTENANCE' && change.stage === 'REQUIREMENTS'
      ? {
          ...registeredTransition,
          artifact_types: [...registeredTransition.artifact_types, 'impact-map'],
        }
      : registeredTransition;
  if (!transition)
    return {
      supported: false,
      stage: change.stage,
      reason: 'No feature transition policy is registered for this stage yet.',
    };
  if (change.kind === 'WORKFLOW_CHANGE' && change.stage === 'EVALUATION') {
    const missing = [];
    const evidence = [];
    const evaluation = change.evaluation;
    if (!evaluation?.report_path || !/^[a-f0-9]{40}$/.test(change.pull_request?.head_sha ?? ''))
      missing.push({ reason: 'trusted_candidate_evaluation_missing' });
    else {
      try {
        const report = await readJson(
          await safePath(projectRoot, evaluation.report_path, { protectedAccess: true }),
        );
        const valid = await validateArtifact(report);
        if (
          !valid.valid ||
          hash(report) !== evaluation.report_hash ||
          report.id !== evaluation.report_id ||
          report.id !== `EVAL-${evaluation.run_id}-${evaluation.run_attempt}` ||
          report.change_id !== change.id ||
          report.status !== 'recorded' ||
          report.data?.correctness?.checks_result !== 'success' ||
          report.data?.interventions?.candidate_sha !== change.pull_request.head_sha ||
          report.data?.interventions?.candidate_sha !== evaluation.candidate_sha ||
          report.data?.interventions?.evaluator_sha !== evaluation.evaluator_sha ||
          report.data?.interventions?.evaluator_run_attempt !== evaluation.run_attempt ||
          report.data?.candidate_version !== evaluation.candidate_version
        )
          missing.push({ reason: 'trusted_candidate_evaluation_stale_or_invalid' });
        else
          evidence.push({
            type: 'trusted_candidate_evaluation',
            run_id: evaluation.run_id,
            run_attempt: evaluation.run_attempt,
            candidate_sha: evaluation.candidate_sha,
            evaluator_sha: evaluation.evaluator_sha,
            report_hash: evaluation.report_hash,
          });
      } catch {
        missing.push({ reason: 'trusted_candidate_evaluation_unavailable' });
      }
    }
    return {
      supported: true,
      from: change.stage,
      to: transition.next,
      ready: missing.length === 0,
      missing,
      evidence,
      artifact_types: [],
      decision_artifact_types: [],
      state_revision: state.revision,
    };
  }
  if (change.stage === 'IMPLEMENTATION') {
    const { plan } = await acceptedFeaturePlan(projectRoot, change);
    const completed = new Set(change.completed_increment_ids ?? []);
    const missing = plan.increments.flatMap((increment) => {
      if (!completed.has(increment.id))
        return [{ increment_id: increment.id, reason: 'increment_incomplete' }];
      return missingIncrementTaskEvidence(
        change,
        state,
        plan.tasks.filter((task) => task.increment_id === increment.id),
        change.kind === 'MAINTENANCE' && plan.outcome === 'NO_FILE',
      ).map((item) => ({ increment_id: increment.id, ...item }));
    });
    return {
      supported: true,
      from: change.stage,
      to: transition.next,
      ready: missing.length === 0,
      missing,
      evidence: [...completed].map((increment_id) => ({
        type: 'completed_increment',
        increment_id,
      })),
      review_task_ids: plan.tasks
        .map((task) => task.id)
        .filter((task_id) =>
          ['DONE', 'WAITING_REVIEW', 'CHANGES_REQUESTED'].includes(change.tasks[task_id]?.state),
        ),
      artifact_types: [],
      decision_artifact_types: [],
      state_revision: state.revision,
    };
  }
  if (change.stage === 'INTEGRATION') {
    const merge = change.merge_receipt;
    const merged =
      ['user', 'squash'].includes(merge?.merge_method) &&
      /^[a-f0-9]{40}$/i.test(merge.merge_commit_sha ?? '') &&
      /^[a-f0-9]{40}$/i.test(merge.head_sha ?? '') &&
      merge.recovered !== true;
    return {
      supported: true,
      from: change.stage,
      to: transition.next,
      ready: merged,
      missing: merged ? [] : ['manual_merge_confirmation'],
      evidence: merged ? [{ type: 'merge_receipt', sha: merge.merge_commit_sha }] : [],
      artifact_types: [],
      decision_artifact_types: [],
      state_revision: state.revision,
    };
  }
  const missing = [];
  const evidence = [];
  const artifacts = {};
  for (const type of transition.artifact_types) {
    const ref = change.artifacts.filter((artifact) => artifact.type === type).at(-1);
    if (!ref) {
      missing.push({ type, reason: 'artifact_missing' });
      continue;
    }
    try {
      const artifact = await readJson(
        await safePath(projectRoot, ref.path, {
          protectedAccess: ref.path.startsWith('.workflow-runtime/'),
        }),
      );
      await validateArtifact(artifact);
      if (artifact.type !== type || artifact.change_id !== change.id)
        throw new WorkflowError(
          'VALIDATION_FAILED',
          'Artifact identity does not match its registration.',
        );
      if (hash(artifact) !== ref.content_hash) {
        missing.push({ type, artifact_id: ref.id, reason: 'artifact_changed' });
        continue;
      }
      if (type === 'impact-map' && change.kind === 'MAINTENANCE')
        await validateMaintenanceImpactMap(projectRoot, artifact);
      artifacts[type] = { ref, artifact };
    } catch (error) {
      missing.push({
        type,
        artifact_id: ref.id,
        reason: 'artifact_invalid',
        validation_code: error.code ?? 'VALIDATION_FAILED',
      });
    }
  }
  if (change.stage === 'REQUIREMENTS' && Object.keys(artifacts).length === 2) {
    try {
      await validateSpecification({
        requirements_path: artifacts.requirements.ref.path,
        scenarios_path: artifacts.scenarios.ref.path,
      });
    } catch (error) {
      missing.push({ reason: 'specification_coverage_invalid', validation_code: error.code });
    }
  }
  if (change.stage === 'PLANNING' && artifacts['implementation-plan']) {
    const specification = {};
    for (const type of ['requirements', 'scenarios']) {
      const ref = change.artifacts.filter((artifact) => artifact.type === type).at(-1);
      if (!ref) {
        missing.push({ type, reason: 'approved_specification_missing' });
        continue;
      }
      try {
        const artifact = await readJson(await safePath(projectRoot, ref.path));
        await validateArtifact(artifact);
        if (
          artifact.type !== type ||
          artifact.change_id !== change.id ||
          hash(artifact) !== ref.content_hash
        )
          throw new WorkflowError('VALIDATION_FAILED', 'The accepted specification changed.');
        specification[type] = { ref, artifact };
      } catch (error) {
        missing.push({
          type,
          artifact_id: ref.id,
          reason: 'approved_specification_invalid',
          validation_code: error.code ?? 'VALIDATION_FAILED',
        });
      }
    }
    if (specification.requirements && specification.scenarios) {
      try {
        await validateSpecification({
          requirements_path: specification.requirements.ref.path,
          scenarios_path: specification.scenarios.ref.path,
        });
        const plan = artifacts['implementation-plan'].artifact.data;
        requireValue(
          change.kind === 'MAINTENANCE' || plan.outcome !== 'NO_FILE',
          'VALIDATION_FAILED',
          'Only a MAINTENANCE plan can declare a NO_FILE outcome.',
        );
        requireValue(
          typeof plan.specification_ref === 'string' &&
            plan.specification_ref.trim() &&
            Array.isArray(plan.coverage) &&
            plan.coverage.length > 0 &&
            Array.isArray(plan.verification_schedule) &&
            plan.verification_schedule.length > 0 &&
            Array.isArray(plan.risks),
          'VALIDATION_FAILED',
          'The implementation plan needs specification references, scenario coverage, a verification schedule, and a risk list.',
        );
        const { profile } = await load(projectRoot);
        validatePlan(
          plan,
          specification.scenarios.artifact.data.scenarios.map((scenario) => scenario.id),
          (profile.applications ?? []).map((application) => application.id),
        );
        evidence.push({
          type: 'plan_coverage',
          artifact_id: artifacts['implementation-plan'].ref.id,
          increments: plan.increments.length,
          tasks: plan.tasks.length,
          scenarios: specification.scenarios.artifact.data.scenarios.length,
        });
      } catch (error) {
        missing.push({
          reason: 'implementation_plan_invalid',
          validation_code: error.code ?? 'VALIDATION_FAILED',
        });
      }
    }
  }
  for (const type of transition.artifact_types) {
    const artifactEntry = artifacts[type];
    if (!artifactEntry) continue;
    const { ref, artifact } = artifactEntry;
    const decision = change.approvals.find((candidate) => candidate.artifact_id === ref.id);
    if (
      !decision ||
      decision.status !== 'APPROVED' ||
      decision.provider !== 'codex_chat' ||
      decision.subject_hash !== hash(artifact) ||
      typeof decision.reviewer !== 'string'
    ) {
      missing.push({
        type,
        artifact_id: ref.id,
        subject_hash: hash(artifact),
        reason: decision?.status === 'REJECTED' ? 'user_rejected' : 'chat_approval_missing',
      });
      continue;
    }
    evidence.push({
      type,
      artifact_id: ref.id,
      content_hash: hash(artifact),
      reviewer: decision.reviewer,
      decided_at: decision.decided_at,
    });
  }
  return {
    supported: true,
    from: change.stage,
    to: transition.next,
    ready: missing.length === 0,
    missing,
    evidence,
    artifact_types: transition.artifact_types,
    decision_artifact_types: transition.artifact_types,
    state_revision: state.revision,
  };
}

async function inspectBugfixTransition(projectRoot, change, state) {
  const transition = bugfixTransitions[change.stage];
  if (!transition)
    return {
      supported: false,
      stage: change.stage,
      reason: 'No defect transition policy is registered for this stage yet.',
    };
  if (transition.next === 'COMPLETE') {
    const merge = change.merge_receipt;
    const merged =
      ['user', 'squash'].includes(merge?.merge_method) &&
      /^[a-f0-9]{40}$/i.test(merge.merge_commit_sha ?? '') &&
      /^[a-f0-9]{40}$/i.test(merge.head_sha ?? '') &&
      merge.recovered !== true;
    return {
      supported: true,
      from: change.stage,
      to: transition.next,
      ready: merged,
      missing: merged ? [] : ['manual_merge_confirmation'],
      evidence: merged ? [{ type: 'merge_receipt', sha: merge.merge_commit_sha }] : [],
      artifact_types: [],
      decision_artifact_types: [],
      review_task_ids: [],
      state_revision: state.revision,
    };
  }
  const missing = [];
  const evidence = [];
  const ref = change.artifacts.filter((artifact) => artifact.type === 'defect-report').at(-1);
  if (!ref) missing.push({ type: 'defect-report', reason: 'artifact_missing' });
  else {
    try {
      const artifact = await readJson(
        await safePath(projectRoot, ref.path, {
          protectedAccess: ref.path.startsWith('.workflow-runtime/'),
        }),
      );
      await validateArtifact(artifact);
      requireValue(
        artifact.type === 'defect-report' &&
          artifact.change_id === change.id &&
          typeof artifact.data.expected === 'string' &&
          artifact.data.expected.trim() &&
          typeof artifact.data.observed === 'string' &&
          artifact.data.observed.trim() &&
          Array.isArray(artifact.data.reproduction_steps) &&
          artifact.data.reproduction_steps.length > 0,
        'VALIDATION_FAILED',
        'A defect report must identify expected and observed behavior plus reproduction steps.',
      );
      const contentHash = hash(artifact);
      if (contentHash !== ref.content_hash)
        missing.push({ type: ref.type, artifact_id: ref.id, reason: 'artifact_changed' });
      else {
        evidence.push({ type: ref.type, artifact_id: ref.id, content_hash: ref.content_hash });
        const decision = change.approvals.find((candidate) => candidate.artifact_id === ref.id);
        const chatDecision = decision?.provider === 'codex_chat';
        if (
          !decision ||
          decision.status !== 'APPROVED' ||
          decision.subject_hash !== contentHash ||
          !chatDecision ||
          typeof decision.reviewer !== 'string'
        ) {
          missing.push({
            type: ref.type,
            artifact_id: ref.id,
            subject_hash: contentHash,
            reason: decision?.status === 'REJECTED' ? 'user_rejected' : 'chat_approval_missing',
          });
        } else {
          evidence.push({
            type: 'authenticated_decision',
            artifact_id: ref.id,
            content_hash: contentHash,
            provider: decision.provider,
            reviewer: decision.reviewer,
            decided_at: decision.decided_at,
          });
        }
      }
      if (
        contentHash === ref.content_hash &&
        artifact.data.already_fixed_deployment_id !== undefined
      ) {
        const noFile = await inspectAlreadyFixedDeployment(projectRoot, artifact, state);
        const combinedMissing = [...missing, ...noFile.missing];
        return {
          supported: true,
          from: change.stage,
          to: 'COMPLETE',
          ready: combinedMissing.length === 0,
          missing: combinedMissing,
          evidence: noFile.missing.length ? evidence : [...evidence, ...noFile.evidence],
          artifact_types: [],
          decision_artifact_types: ['defect-report'],
          review_task_ids: [],
          state_revision: state.revision,
        };
      }
    } catch (error) {
      missing.push({
        type: 'defect-report',
        artifact_id: ref.id,
        reason: 'artifact_invalid',
        validation_code: error.code ?? 'VALIDATION_FAILED',
      });
    }
  }

  const testTasks = Object.values(change.tasks).filter(
    (task) =>
      ['test_author', 'sdlc_test_author'].includes(task.role) &&
      task.result?.verification_mode === 'EXPECTED_RED' &&
      Array.isArray(task.result.expected_red_run_ids) &&
      task.result.expected_red_run_ids.length > 0,
  );
  const acceptedTest = testTasks.find((task) => {
    if (
      task.state !== 'DONE' ||
      task.review?.status !== 'ACCEPTED' ||
      task.review?.provider !== 'workflow_verification'
    )
      return false;
    if (!task.result.expected_red_run_ids.every((runId) => task.result.run_ids.includes(runId)))
      return false;
    return task.result.expected_red_run_ids.every((runId) => {
      const run = state.runs[runId];
      return (
        run?.change_id === change.id &&
        run.classification === 'ASSERTION_FAILURE' &&
        change.evidence.some((item) => item.phase === 'RED' && item.run_id === runId)
      );
    });
  });
  if (!acceptedTest)
    missing.push({
      reason: testTasks.length ? 'reviewed_red_test_missing' : 'reproduced_red_test_missing',
    });
  else
    evidence.push({
      type: 'verified_red_test',
      task_id: acceptedTest.id,
      checkpoint_sha: acceptedTest.result.checkpoint_sha,
      verification_provider: acceptedTest.review.provider,
      run_ids: acceptedTest.result.expected_red_run_ids,
    });
  const reviewCandidate =
    acceptedTest ??
    testTasks.find((task) => ['WAITING_REVIEW', 'CHANGES_REQUESTED'].includes(task.result?.status));
  return {
    supported: true,
    from: change.stage,
    to: transition.next,
    ready: missing.length === 0,
    missing,
    evidence,
    artifact_types: transition.artifact_types,
    decision_artifact_types: ['defect-report'],
    review_task_ids: reviewCandidate ? [reviewCandidate.id] : [],
    state_revision: state.revision,
  };
}

async function inspectAlreadyFixedDeployment(projectRoot, artifact, state) {
  const data = artifact.data;
  const deployment = state.receipts.deployments?.[data.already_fixed_deployment_id];
  const missing = [];
  const evidence = [];
  if (!deployment) {
    missing.push({
      reason: 'verified_deployment_missing',
      deployment_id: data.already_fixed_deployment_id,
    });
    return { missing, evidence };
  }
  if (
    deployment.status !== 'VERIFIED' ||
    typeof deployment.verified_at !== 'string' ||
    !Number.isFinite(Date.parse(deployment.verified_at))
  )
    missing.push({ reason: 'deployment_not_verified', deployment_id: deployment.id });
  if (
    !Array.isArray(data.affected_versions) ||
    !data.affected_versions.includes(deployment.release_version)
  )
    missing.push({
      reason: 'deployment_version_mismatch',
      deployment_id: deployment.id,
      release_version: deployment.release_version,
    });
  if (
    !/^[a-f0-9]{40,64}$/i.test(deployment.source_sha ?? '') ||
    !Array.isArray(deployment.image_references) ||
    deployment.image_references.length === 0 ||
    !deployment.image_references.every((reference) => /@sha256:[a-f0-9]{64}$/i.test(reference))
  )
    missing.push({ reason: 'immutable_deployment_identity_missing', deployment_id: deployment.id });
  if (
    !Array.isArray(deployment.migrations) ||
    deployment.migrations.some((migration) => migration.status !== 'PASSED')
  )
    missing.push({ reason: 'deployment_migrations_incomplete', deployment_id: deployment.id });

  const { profile } = await load(projectRoot);
  const verificationProfiles = profile.delivery?.compose?.verification_profiles ?? [];
  const verification = (deployment.verification_runs ?? []).find(
    (entry) =>
      entry.profile &&
      entry.classification === 'PASS' &&
      verificationProfiles.includes(entry.profile),
  );
  const run = verification && state.runs[verification.run_id];
  if (!run) {
    missing.push({ reason: 'deployment_verification_run_missing', deployment_id: deployment.id });
  } else {
    if (
      verification.classification !== 'PASS' ||
      run.classification !== 'PASS' ||
      run.profile !== verification.profile ||
      run.test_adapter !== 'node-test-tap' ||
      run.test_count <= 0 ||
      run.executed_test_count <= 0 ||
      run.source_fingerprint !== run.current_fingerprint ||
      !Array.isArray(run.test_identities) ||
      !run.test_identities.includes(data.already_fixed_test_id)
    )
      missing.push({
        reason: 'named_system_test_not_verified',
        deployment_id: deployment.id,
        test_id: data.already_fixed_test_id,
        run_id: verification.run_id,
      });
    else
      evidence.push({
        type: 'verified_no_file_deployment',
        deployment_id: deployment.id,
        release_version: deployment.release_version,
        source_sha: deployment.source_sha,
        image_references: deployment.image_references,
        test_profile: verification.profile,
        test_run_id: verification.run_id,
        test_id: data.already_fixed_test_id,
        verified_at: deployment.verified_at,
      });
  }
  return { missing, evidence };
}

export function registerBundleOperations(handlers) {
  handlers['workflow.lock.inspect'] = async (_input, { projectRoot }) =>
    inspectOperationLock(projectRoot);

  handlers['workflow.lock.recover'] = async (input, { projectRoot }) => {
    if (input.expected_recovery_lock_id !== undefined) {
      requireValue(
        typeof input.expected_recovery_lock_id === 'string' &&
          /^[a-f0-9]{64}$/.test(input.expected_recovery_lock_id),
        'VALIDATION_FAILED',
        'Supply the exact recovery lock ID returned by workflow.lock.inspect.',
      );
      return recoverRecoveryGuard(projectRoot, input.expected_recovery_lock_id);
    }
    requireValue(
      typeof input.expected_lock_id === 'string' && /^[a-f0-9]{64}$/.test(input.expected_lock_id),
      'VALIDATION_FAILED',
      'Supply the exact lock ID returned by workflow.lock.inspect.',
    );
    return recoverOperationLock(projectRoot, input.expected_lock_id);
  };

  handlers['change.route'] = async (input, { projectRoot }) => {
    const { state } = await load(projectRoot);
    const change = findChange(state, input.change_id);
    const routes = {
      PROJECT_INIT: {
        route: 'initialization',
        sequence: [
          'Define product purpose, users, measurable outcomes, MVP boundary, assumptions, and constraints.',
          'Obtain explicit product acceptance before proposing architecture.',
          'Define system architecture, application layout, contracts, implementation and test standards, and delivery strategy.',
          'Obtain explicit architecture acceptance before repository bootstrap.',
          'Bootstrap only approved foundations, then verify fresh-checkout and recovery journeys.',
        ],
        human_gates: ['product_acceptance', 'architecture_acceptance', 'manual_pr_merge'],
        no_file_completion: false,
      },
      BUGFIX: {
        route: 'defect',
        sequence: [
          'Compare the report with accepted requirements, current behavior, and known plans.',
          'If intent is ambiguous or requested behavior differs, return to feature specification.',
          'Record expected and observed behavior, environment, impact, and reproduction steps.',
          'Reproduce on the identified source revision and environment before implementation.',
          'If the target deployment already contains the fix, verify that exact deployment and close with evidence without an empty commit.',
          'Author a behavioral regression test and verify its assertion failure against the unfixed behavior before implementation.',
          'Implement through task checkpoints and current verification; the user accepts business decisions in chat and merges the PR manually.',
        ],
        human_gates: [
          'business_intent_acceptance_when_expected_behavior_is_not_already_approved',
          'manual_pr_merge',
        ],
        no_file_completion: true,
      },
      MAINTENANCE: {
        route: 'maintenance',
        sequence: [
          'Classify the requested maintenance and compare it with accepted product and architecture constraints.',
          'Build an impact map for applications, shared contracts, data, security, compatibility, and delivery.',
          'Write requirements and Given/When/Then scenarios for the requested outcome; document exclusions and why omitted applications or checks cannot be affected.',
          'Obtain current chat acceptance of the requirements and scenarios, then accept a scenario-covered incremental plan in chat.',
          'Implement file-changing tasks with evidenced behavioral RED and current GREEN checks; an explicit NO_FILE plan needs current GREEN evidence for both test-author and implementer tasks.',
          'Use the impact-selected verification schedule; unknown impact requires broader application and system checks.',
          'Complete planned checks, then let the user review and merge the ready PR manually. Confirm the GitHub merge before completion. Retain evidence for verified no-ops and never create an empty commit.',
        ],
        human_gates: ['scope_or_architecture_acceptance_if_changed', 'manual_pr_merge'],
        no_file_completion: true,
      },
      FEATURE: {
        route: 'feature',
        sequence: [
          'Retrieve bounded project context from the user description.',
          'Specify requirements and scenarios, then obtain the user’s business acceptance in chat.',
          'Plan small cross-application vertical increments and obtain the user’s plan acceptance in chat before test authoring.',
        ],
        human_gates: ['business_specification_acceptance', 'manual_pr_merge'],
        no_file_completion: false,
      },
      WORKFLOW_CHANGE: {
        route: 'workflow_change',
        sequence: [
          'Pin and inspect the currently active workflow version.',
          'Specify and plan the workflow change using the pinned version; obtain required user acceptance in chat.',
          'Evaluate the candidate and let the user review and merge its PR without activating it.',
          'Migrate existing changes only through a separately approved and verified migration.',
        ],
        human_gates: [
          'workflow_change_acceptance',
          'manual_pr_merge',
          'explicit_activation',
          'migration_approval_when_required',
        ],
        no_file_completion: true,
      },
    };
    const route = routes[change.kind];
    requireValue(route, 'VALIDATION_FAILED', `No route is registered for ${change.kind}.`);
    return {
      change_id: change.id,
      kind: change.kind,
      stage: change.stage,
      status: change.status,
      ...route,
      advisory_only: true,
      gate_authority: 'none',
      next_action: route.sequence[0],
      reference: 'workflow/bundle/skills/sdlc-workflow/references/routes.md',
    };
  };

  handlers['bundle.inspect'] = async (_input, { projectRoot }) => {
    let installed = null;
    try {
      installed = JSON.parse(
        await fs.readFile(await stateFile(projectRoot, 'installed-bundle.json'), 'utf8'),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const candidate = await bundleIdentity();
    return {
      manifest: candidate.manifest,
      manifest_hash: candidate.manifest_hash,
      file_count: candidate.files.length,
      installation_required: !installed,
      installed,
      candidate_matches_installed:
        installed === null ||
        (installed.bundle_version === candidate.manifest.bundle_version &&
          installed.manifest_hash === candidate.manifest_hash),
      native_invocation_verified: false,
    };
  };

  handlers['bundle.install'] = async (_input, { projectRoot }) => {
    const plan = await prepareBundleInstallation(projectRoot);
    const record = await writeBundleInstallation(projectRoot, plan);
    return {
      ...record,
      message:
        'Reload the Codex client, invoke $sdlc-workflow, and verify native specialist discovery separately.',
    };
  };

  handlers['workflow.setup'] = async (input, { projectRoot, env = process.env }) => {
    requireValue(
      Object.keys(input).every((key) => key === 'base_branch') &&
        (input.base_branch === undefined || typeof input.base_branch === 'string'),
      'VALIDATION_FAILED',
      'workflow.setup accepts only an optional base_branch string.',
    );
    const sourceRoot = await fs.realpath(path.resolve(bundleRoot, '../..'));
    const plan = await prepareBundleInstallation(projectRoot);
    const receiptPath = await stateFile(projectRoot, 'setup-receipt.json');
    let receipt = null;
    try {
      receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (receipt) {
      const installedRuntimeRoot = samePath(sourceRoot, projectRoot);
      requireValue(
        installedRuntimeRoot ||
          (!insidePath(sourceRoot, projectRoot) && !insidePath(projectRoot, sourceRoot)),
        'INVALID_TARGET',
        'Select a separate target folder outside the workflow source repository.',
      );
      requireValue(
        receipt.manifest_hash === plan.candidate.manifest_hash &&
          receipt.bundle_version === plan.candidate.manifest.bundle_version,
        'BUNDLE_VERSION_CONFLICT',
        'This project was set up with another workflow bundle identity. Use the reviewed migration process before updating it.',
      );
      return {
        ...receipt,
        mode: 'ALREADY_SETUP',
        requires_reload: true,
        native_invocation_verified: false,
        remote_created: false,
      };
    }
    requireValue(
      !insidePath(sourceRoot, projectRoot) && !insidePath(projectRoot, sourceRoot),
      'INVALID_TARGET',
      'Select a separate target folder outside the workflow source repository.',
    );

    const pendingPath = await stateFile(projectRoot, 'setup.pending.json');
    let pending = null;
    try {
      pending = JSON.parse(await fs.readFile(pendingPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const gitRoot = git(projectRoot, ['rev-parse', '--show-toplevel'], { allowFailure: true, env });
    const isGitRepository = gitRoot.status === 0;
    if (isGitRepository) {
      const actualRoot = await fs.realpath(gitRoot.stdout.trim());
      requireValue(
        actualRoot === projectRoot,
        'INVALID_TARGET',
        'Select the Git repository root as the target folder.',
      );
    }

    const currentBranch = isGitRepository
      ? git(projectRoot, ['symbolic-ref', '--short', 'HEAD'], { allowFailure: true, env })
      : null;
    const branchName =
      input.base_branch ??
      (isGitRepository && currentBranch.status === 0 ? currentBranch.stdout.trim() : 'main');
    requireValue(
      branchName &&
        git(projectRoot, ['check-ref-format', '--branch', branchName], { allowFailure: true, env })
          .status === 0,
      'INVALID_BRANCH',
      'The setup base_branch must be a valid local Git branch name.',
    );
    if (isGitRepository)
      requireValue(
        currentBranch.status === 0 && currentBranch.stdout.trim() === branchName,
        'BASE_BRANCH_MISMATCH',
        'Switch the target repository to its intended integration branch or pass that checked-out branch as base_branch.',
      );

    const setupStatusBefore = isGitRepository ? setupStatus(projectRoot, env) : '';
    if (pending) {
      requireValue(
        pending.manifest_hash === plan.candidate.manifest_hash &&
          pending.bundle_version === plan.candidate.manifest.bundle_version &&
          pending.base_branch === branchName,
        'SETUP_RECOVERY_CONFLICT',
        'A pending setup belongs to different bundle or branch inputs. No files were changed.',
      );
      requireValue(
        setupOwnedStatus(setupStatusBefore),
        'DIRTY_WORKTREE',
        'Setup recovery found changes outside workflow-owned files. Preserve them and resolve the target repository state before retrying.',
      );
    } else if (isGitRepository) {
      requireValue(
        setupStatusBefore === '',
        'DIRTY_WORKTREE',
        'Commit or preserve all existing changes before installing the workflow into this repository.',
      );
    } else {
      const entries = await fs.readdir(projectRoot, { withFileTypes: true });
      const unrelated = [];
      for (const entry of entries) {
        if (entry.name !== '.workflow') {
          unrelated.push(entry.name);
          continue;
        }
        const stateEntries = await fs.readdir(path.join(projectRoot, entry.name));
        for (const stateEntry of stateEntries)
          if (!['operation.lock', 'setup.pending.json'].includes(stateEntry))
            unrelated.push(path.join('.workflow', stateEntry));
      }
      requireValue(
        unrelated.length === 0,
        'TARGET_NOT_GIT',
        'The selected folder is not a Git repository and is not empty. Choose an empty folder or an existing Git repository.',
      );
      requireValue(
        !pending,
        'SETUP_RECOVERY_CONFLICT',
        'A pending setup cannot be resumed because the selected folder no longer has its Git repository.',
      );
    }

    const authorIdentity = git(projectRoot, ['var', 'GIT_AUTHOR_IDENT'], {
      allowFailure: true,
      env,
    });
    const committerIdentity = git(projectRoot, ['var', 'GIT_COMMITTER_IDENT'], {
      allowFailure: true,
      env,
    });
    requireValue(
      authorIdentity.status === 0 && committerIdentity.status === 0,
      'GIT_IDENTITY_REQUIRED',
      'Configure Git author and committer name/email before setup so the workflow installation can be recorded in local history.',
    );

    const pendingRecord = pending ?? {
      schema_version: '1',
      bundle_version: plan.candidate.manifest.bundle_version,
      manifest_hash: plan.candidate.manifest_hash,
      base_branch: branchName,
      created_local_repository: !isGitRepository,
      started_at: new Date().toISOString(),
    };
    if (!pending) await atomicWrite(pendingPath, JSON.stringify(pendingRecord, null, 2) + '\n');

    if (!isGitRepository) {
      git(projectRoot, ['init'], { env });
      git(projectRoot, ['symbolic-ref', 'HEAD', `refs/heads/${branchName}`], { env });
    }
    await ensureWorkflowStateIgnored(projectRoot, env);
    const installed = await writeBundleInstallation(projectRoot, plan);
    const statusAfterInstall = setupStatus(projectRoot, env);
    requireValue(
      setupOwnedStatus(statusAfterInstall),
      'DIRTY_WORKTREE',
      'Installation detected changes outside its owned paths; no commit was created.',
    );
    git(projectRoot, ['add', '--', ...setupCommitPaths], { env });
    const staged = git(projectRoot, ['diff', '--cached', '--quiet'], { allowFailure: true, env });
    requireValue(
      staged.status === 0 || staged.status === 1,
      'GIT_FAILED',
      'Could not inspect the staged workflow installation.',
    );
    if (staged.status === 1)
      git(projectRoot, ['commit', '-m', 'chore(workflow): initialize project workflow'], { env });

    const head = git(projectRoot, ['rev-parse', 'HEAD'], { allowFailure: true, env });
    requireValue(
      head.status === 0,
      'GIT_FAILED',
      'The workflow files are installed, but the initial local commit could not be verified.',
    );
    const finalStatus = setupStatus(projectRoot, env);
    requireValue(
      finalStatus === '',
      'DIRTY_WORKTREE',
      'The setup commit was created, but the target worktree is not clean. Inspect it before continuing.',
    );
    const setupReceipt = {
      schema_version: '1',
      bundle_version: plan.candidate.manifest.bundle_version,
      manifest_hash: plan.candidate.manifest_hash,
      base_branch: branchName,
      initial_commit: head.stdout.trim(),
      created_local_repository: pendingRecord.created_local_repository,
      committed_paths: setupCommitPaths,
      installed_files: installed.files.length,
      requires_reload: true,
      native_invocation_verified: false,
      remote_created: false,
    };
    await atomicWrite(receiptPath, JSON.stringify(setupReceipt, null, 2) + '\n');
    await fs.rm(pendingPath, { force: true });
    return {
      ...setupReceipt,
      mode: pending
        ? 'RESUMED_SETUP'
        : isGitRepository
          ? 'EXISTING_REPOSITORY'
          : 'NEW_LOCAL_PROJECT',
      written_files: installed.written_files,
      next_action:
        'Open the target folder in Codex, reload if required, verify entry-skill and specialist discovery, then begin project-specific Stage 0.',
    };
  };

  handlers['bundle.preflight'] = async (_input, context) => {
    const inspected = await handlers['bundle.inspect']({}, context);
    return {
      ready: false,
      configured: !inspected.installation_required,
      checks: [
        {
          id: 'bundle_identity',
          status: inspected.candidate_matches_installed ? 'MATCHED' : 'CONFLICT',
          message: inspected.candidate_matches_installed
            ? 'The operation sources match the installed immutable bundle identity.'
            : 'Installed files and operation sources have different identities; migration is required.',
        },
        {
          id: 'bundle_files',
          status: inspected.installation_required ? 'MISSING' : 'PRESENT',
          message: 'File presence is separate from active client discovery.',
        },
        {
          id: 'native_invocation',
          status: 'UNVERIFIED',
          message:
            'Invoke the installed skill and a native specialist after client reload; filesystem inspection cannot certify this.',
        },
        {
          id: 'permission_boundary',
          status: 'UNVERIFIED',
          message:
            'This local state store is not an authorization boundary against an unrestricted same-user process.',
        },
        {
          id: 'external_integrations',
          status: 'UNVERIFIED',
          message:
            'GitHub, GHCR, Docker, and authenticated human decisions require separate configured live verification.',
        },
      ],
    };
  };

  handlers['workflow.doctor'] = async (_input, context) => {
    const { projectRoot, env = process.env } = context;
    const checks = [];
    const add = (id, status, message) => checks.push({ id, status, message });
    const inspected = await handlers['bundle.inspect']({}, context);
    add(
      'bundle_identity',
      inspected.candidate_matches_installed ? 'READY' : 'BLOCKED',
      inspected.candidate_matches_installed
        ? `Bundle ${inspected.manifest.bundle_version} matches its installed content identity.`
        : 'Installed bundle content differs from the current operations; use the reviewed migration path.',
    );
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    add(
      'node_runtime',
      nodeMajor >= 22 ? 'READY' : 'BLOCKED',
      `Node.js ${process.versions.node} is ${nodeMajor >= 22 ? 'supported' : 'below the required major version 22'}.`,
    );
    try {
      const { profile } = await load(projectRoot);
      const locks = await inspectOperationLock(projectRoot);
      const activeLockStatus = locks.operation_lock.status;
      const recoveryLockStatus = locks.recovery_lock.status;
      const lockStatus =
        activeLockStatus === 'ABSENT' && recoveryLockStatus === 'ABSENT'
          ? 'READY'
          : activeLockStatus === 'ACTIVE' || recoveryLockStatus === 'ACTIVE'
            ? 'BUSY'
            : 'OPERATOR_ACTION_REQUIRED';
      add(
        'operation_locks',
        lockStatus,
        lockStatus === 'READY'
          ? 'No operation or recovery lock is present.'
          : `Operation lock is ${activeLockStatus}; recovery lock is ${recoveryLockStatus}. Inspect before retrying mutations.`,
      );
      const base = git(
        projectRoot,
        ['show-ref', '--verify', `refs/heads/${profile.repository.base_branch}`],
        {
          allowFailure: true,
        },
      );
      add(
        'project_profile',
        base.status === 0 ? 'READY' : 'BLOCKED',
        base.status === 0
          ? `The configured integration branch ${profile.repository.base_branch} exists.`
          : 'The configured integration branch is missing from the local repository.',
      );
      const githubConfigured =
        typeof profile.github?.owner === 'string' &&
        typeof profile.github?.name === 'string' &&
        Array.isArray(profile.github.required_checks) &&
        profile.github.required_checks.length > 0;
      add(
        'github_configuration',
        githubConfigured
          ? env.GH_TOKEN || env.GITHUB_TOKEN
            ? 'CONFIGURED'
            : 'BLOCKED'
          : 'NOT_CONFIGURED',
        githubConfigured
          ? env.GH_TOKEN || env.GITHUB_TOKEN
            ? 'Repository and check references are configured; live authentication and policy remain unverified.'
            : 'GitHub profile is present, but no protected process token is available.'
          : 'Configure repository identity and required checks before GitHub acceptance.',
      );
      if (!profile.delivery?.compose) {
        add(
          'docker_delivery',
          'NOT_REQUIRED',
          'No Compose delivery target is configured for this project.',
        );
      } else {
        const engineVersion = reportedVersion(
          dockerProbe(context, projectRoot, ['info', '--format', '{{.ServerVersion}}']),
        );
        const composeVersion = reportedVersion(
          dockerProbe(context, projectRoot, ['compose', 'version', '--short']),
        );
        const ready = engineVersion !== null && composeVersion !== null;
        add(
          'docker_delivery',
          ready ? 'READY' : 'BLOCKED',
          ready
            ? `Docker Engine ${engineVersion} and Docker Compose ${composeVersion} respond locally; target access and disposable-data policy still require acceptance.`
            : 'A configured Compose target requires a responding Docker Engine and Docker Compose v2 plugin; the local probe failed or timed out.',
        );
      }
    } catch (error) {
      if (error.code !== 'NOT_INITIALIZED') throw error;
      add(
        'project_profile',
        'NOT_CONFIGURED',
        'Initialize the repository with a reviewed project profile.',
      );
      add(
        'operation_locks',
        'NOT_CONFIGURED',
        'Initialize the repository before inspecting workflow locks.',
      );
      add(
        'github_configuration',
        'NOT_CONFIGURED',
        'GitHub checks require a configured project profile.',
      );
      add(
        'docker_delivery',
        'NOT_REQUIRED',
        'No Compose delivery target is configured for this project.',
      );
    }
    add(
      'codex_discovery',
      'UNVERIFIED',
      'Reload the selected Codex client and invoke the entry skill plus a native specialist to verify runtime discovery.',
    );
    add(
      'permission_boundary',
      'UNVERIFIED',
      'Verify that protected state, human decisions, credentials, activation, and merge cannot be forged through worker output or direct shell access.',
    );
    add(
      'live_integrations',
      'UNVERIFIED',
      'Mocked adapter tests do not certify live GitHub, GHCR, Actions, or Docker behavior.',
    );
    return {
      ready: checks.every((check) => check.status === 'READY' || check.status === 'NOT_REQUIRED'),
      bundle_version: inspected.manifest.bundle_version,
      bundle_hash: inspected.manifest_hash,
      checks,
      secret_values_returned: false,
    };
  };

  handlers['context.prepare'] = async (input, context) => {
    const { profile, state } = await load(context.projectRoot);
    const change = findChange(state, input.change_id);
    const terms = change.description
      .split(/\W+/)
      .filter((term) => term.length > 3)
      .slice(0, 4);
    const references = [];
    for (const term of terms)
      references.push(
        ...(await handlers['repo.search']({ query: term, limit: 5 }, context)).matches,
      );
    return {
      change,
      applications: profile.applications,
      sources: references,
      source_policy:
        'Approved intent, implemented behavior, and future plans must be assessed separately.',
      unknowns: [
        'Resolve missing business decisions from the selected source material; do not infer acceptance from code.',
      ],
    };
  };
  handlers['context.refresh'] = handlers['context.prepare'];
  handlers['tests.find'] = async (input, { projectRoot }) => ({
    paths: (await sourceFiles(projectRoot))
      .filter((file) => /(?:test|spec)/i.test(file) && (!input.query || file.includes(input.query)))
      .slice(0, 100),
  });

  handlers['test.schedule'] = async (input, { projectRoot }) => {
    const { profile, state } = await load(projectRoot);
    const phases = ['task', 'increment', 'merge', 'release'];
    const categories = ['unit', 'contract', 'integration', 'e2e', 'image', 'release'];
    const categoryOrder = new Map(categories.map((category, index) => [category, index]));
    const minimumCadence = new Map([
      ['unit', 'task'],
      ['contract', 'task'],
      ['integration', 'increment'],
      ['e2e', 'merge'],
      ['image', 'release'],
      ['release', 'release'],
    ]);
    requireValue(
      phases.includes(input.phase),
      'VALIDATION_FAILED',
      'Select task, increment, merge, or release as the verification phase.',
    );
    requireValue(
      input.impact_unknown === undefined || typeof input.impact_unknown === 'boolean',
      'VALIDATION_FAILED',
      'impact_unknown must be a boolean.',
    );
    const apps = profile.applications;
    const appById = new Map();
    for (const app of apps) {
      requireValue(
        app &&
          typeof app === 'object' &&
          typeof app.id === 'string' &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(app.id) &&
          typeof app.path === 'string' &&
          app.path.length > 0 &&
          !appById.has(app.id),
        'VALIDATION_FAILED',
        'Each application needs a unique stable ID and project-relative path.',
      );
      await safePath(projectRoot, app.path);
      appById.set(app.id, app);
    }
    let impactUnknown =
      input.impact_unknown ??
      (!Array.isArray(input.affected_application_ids) ||
        input.affected_application_ids.length === 0);
    let requestedApps = input.affected_application_ids ?? [];
    let impactEvidence;
    if (input.change_id !== undefined) {
      const change = findChange(state, input.change_id);
      if (change.kind === 'MAINTENANCE') {
        const ref = change.artifacts.filter((item) => item.type === 'impact-map').at(-1);
        requireValue(
          ref,
          'GATE_BLOCKED',
          'Maintenance test selection requires an accepted impact map.',
        );
        const artifact = await readJson(await safePath(projectRoot, ref.path));
        await validateArtifact(artifact);
        requireValue(
          hash(artifact) === ref.content_hash && artifact.change_id === change.id,
          'GATE_BLOCKED',
          'The maintenance impact map changed after registration.',
        );
        const decision = change.approvals.find((entry) => entry.artifact_id === ref.id);
        const acceptedTransition = (change.stage_history ?? []).some(
          (entry) =>
            entry.to === 'PLANNING' &&
            entry.evidence?.some(
              (item) =>
                item.type === 'impact-map' &&
                item.artifact_id === ref.id &&
                item.content_hash === ref.content_hash,
            ),
        );
        requireValue(
          acceptedTransition &&
            decision?.status === 'APPROVED' &&
            decision.provider === 'codex_chat' &&
            decision.subject_hash === ref.content_hash &&
            typeof decision.reviewer === 'string',
          'GATE_BLOCKED',
          'Maintenance test selection requires the current human-approved impact map.',
        );
        const classification = await validateMaintenanceImpactMap(projectRoot, artifact);
        const selectedApplications = classification.affected_application_ids;
        const unknownApplications = classification.unknown_application_ids;
        requireValue(
          input.affected_application_ids === undefined ||
            (Array.isArray(input.affected_application_ids) &&
              input.affected_application_ids.every((id) => typeof id === 'string')),
          'VALIDATION_FAILED',
          'Affected application IDs must be a string array.',
        );
        if (
          input.affected_application_ids !== undefined &&
          JSON.stringify([...input.affected_application_ids].sort()) !==
            JSON.stringify([...selectedApplications].sort())
        )
          throw new WorkflowError(
            'VALIDATION_FAILED',
            'Affected applications are derived from the accepted maintenance impact map.',
          );
        if (
          input.impact_unknown !== undefined &&
          input.impact_unknown !==
            (unknownApplications.length > 0 || selectedApplications.length === 0)
        )
          throw new WorkflowError(
            'VALIDATION_FAILED',
            'Unknown impact is derived from the accepted maintenance impact map.',
          );
        requestedApps = selectedApplications;
        impactUnknown = unknownApplications.length > 0 || selectedApplications.length === 0;
        impactEvidence = {
          artifact_id: ref.id,
          content_hash: ref.content_hash,
          affected_application_ids: selectedApplications,
          unknown_application_ids: unknownApplications,
        };
      } else if (
        ['FEATURE', 'WORKFLOW_CHANGE'].includes(change.kind) &&
        change.stage === 'IMPLEMENTATION' &&
        ['task', 'increment'].includes(input.phase)
      ) {
        const { plan } = await acceptedFeaturePlan(projectRoot, change);
        requireValue(
          Array.isArray(plan.increments),
          'GATE_BLOCKED',
          'The reviewed implementation plan does not contain increments.',
        );
        const completed = new Set(change.completed_increment_ids ?? []);
        const increment = plan.increments.find((item) => !completed.has(item.id));
        const declaredApps = increment?.application_ids;
        const knownApps = Array.isArray(declaredApps) && declaredApps.length > 0;
        if (knownApps)
          requireValue(
            new Set(declaredApps).size === declaredApps.length &&
              declaredApps.every((id) => typeof id === 'string' && appById.has(id)),
            'GATE_BLOCKED',
            `The reviewed increment ${increment.id} contains an invalid application scope.`,
          );
        const expectedApps = knownApps ? declaredApps : [];
        const unknownScope = !increment || !knownApps;
        requireValue(
          input.affected_application_ids === undefined ||
            (Array.isArray(input.affected_application_ids) &&
              JSON.stringify([...input.affected_application_ids].sort()) ===
                JSON.stringify([...expectedApps].sort())),
          'VALIDATION_FAILED',
          'Feature test scope is derived from the current reviewed increment; caller-supplied application scope does not match.',
        );
        requireValue(
          input.impact_unknown === undefined || input.impact_unknown === unknownScope,
          'VALIDATION_FAILED',
          'Feature impact certainty is derived from the current reviewed increment.',
        );
        requestedApps = expectedApps;
        impactUnknown = unknownScope;
      }
    }
    requireValue(
      Array.isArray(requestedApps) &&
        requestedApps.every((id) => typeof id === 'string' && appById.has(id)),
      'VALIDATION_FAILED',
      'Affected application IDs must exist in the project catalog.',
    );
    requireValue(
      impactUnknown || requestedApps.length > 0,
      'VALIDATION_FAILED',
      'Provide affected application IDs or explicitly declare the impact unknown.',
    );
    const affected = new Set(impactUnknown ? appById.keys() : requestedApps);
    const phaseIndex = phases.indexOf(input.phase);
    const selected = [];
    for (const [name, command] of Object.entries(profile.commands)) {
      if (!['cadence', 'category', 'application_ids'].some((key) => Object.hasOwn(command, key)))
        continue;
      requireValue(
        phases.includes(command.cadence) &&
          categories.includes(command.category) &&
          Array.isArray(command.application_ids) &&
          command.application_ids.length > 0,
        'VALIDATION_FAILED',
        `Test profile ${name} needs a supported cadence, category, and application_ids.`,
      );
      requireValue(
        phases.indexOf(command.cadence) >= phases.indexOf(minimumCadence.get(command.category)),
        'INVALID_TEST_CADENCE',
        `Test profile ${name} schedules ${command.category} checks before their minimum ${minimumCadence.get(command.category)} cadence.`,
      );
      const profileApps = command.application_ids;
      requireValue(
        (profileApps.includes('*') && profileApps.length === 1) ||
          (new Set(profileApps).size === profileApps.length &&
            profileApps.every((id) => typeof id === 'string' && appById.has(id))),
        'VALIDATION_FAILED',
        `Test profile ${name} references an unknown application or mixes the system-wide marker with application IDs.`,
      );
      if (phases.indexOf(command.cadence) > phaseIndex) continue;
      const scope = profileApps.includes('*')
        ? [...appById.keys()]
        : profileApps.filter((id) => affected.has(id));
      if (scope.length === 0) continue;
      selected.push({
        name,
        category: command.category,
        cadence: command.cadence,
        application_ids: scope,
      });
    }
    selected.sort(
      (left, right) =>
        phases.indexOf(left.cadence) - phases.indexOf(right.cadence) ||
        categoryOrder.get(left.category) - categoryOrder.get(right.category) ||
        left.name.localeCompare(right.name),
    );
    requireValue(
      selected.length > 0,
      'TEST_SCHEDULE_EMPTY',
      `No registered test profiles cover the ${input.phase} phase and affected applications.`,
    );
    const coveredApps = new Set(selected.flatMap((entry) => entry.application_ids));
    const uncoveredApps = [...affected].filter((id) => !coveredApps.has(id));
    return {
      phase: input.phase,
      profiles: selected,
      full_coverage_required: impactUnknown,
      uncovered_application_ids: uncoveredApps,
      impact_map: impactEvidence,
      selection_reason: impactUnknown
        ? 'The impact is unknown; include all registered applications and current-phase test profiles.'
        : 'Selected test profiles by affected applications and configured cadence.',
      cadence_order: phases,
    };
  };

  handlers['tests.run_scheduled'] = async (input, context) => {
    const schedule = await handlers['test.schedule'](input, context);
    if (schedule.uncovered_application_ids.length > 0)
      throw new WorkflowError(
        'TEST_COVERAGE_INCOMPLETE',
        'Scheduled checks do not cover every affected application; no tests were executed.',
        {
          phase: schedule.phase,
          uncovered_application_ids: schedule.uncovered_application_ids,
        },
      );
    const results = [];
    for (const profile of schedule.profiles) {
      const result = await handlers['tests.run'](
        { profile: profile.name, change_id: input.change_id },
        context,
      );
      results.push({
        profile: profile.name,
        category: profile.category,
        cadence: profile.cadence,
        application_ids: profile.application_ids,
        run_id: result.run.id,
        classification: result.run.classification,
        test_count: result.run.test_count,
        executed_test_count: result.run.executed_test_count,
      });
      if (result.run.classification !== 'PASS') break;
    }
    const complete = results.length === schedule.profiles.length;
    const finalResult = results.at(-1);
    return {
      phase: schedule.phase,
      complete,
      passed: complete && results.every((entry) => entry.classification === 'PASS'),
      results,
      runs_by_id: Object.fromEntries(
        results.map(({ run_id, classification }) => [run_id, classification]),
      ),
      not_run_profiles: schedule.profiles.slice(results.length).map((entry) => entry.name),
      stop_reason: complete ? null : (finalResult?.classification ?? 'NO_RUNS_COMPLETED'),
      uncovered_application_ids: schedule.uncovered_application_ids,
      full_coverage_required: schedule.full_coverage_required,
    };
  };

  handlers['spec.validate'] = async (input, context) => {
    const requirements = JSON.parse(
      await fs.readFile(await safePath(context.projectRoot, input.requirements_path), 'utf8'),
    );
    const scenarios = JSON.parse(
      await fs.readFile(await safePath(context.projectRoot, input.scenarios_path), 'utf8'),
    );
    await handlers['artifact.validate']({ path: input.requirements_path }, context);
    await handlers['artifact.validate']({ path: input.scenarios_path }, context);
    requireValue(
      requirements.type === 'requirements' &&
        scenarios.type === 'scenarios' &&
        requirements.change_id === scenarios.change_id,
      'VALIDATION_FAILED',
      'Validate requirements and scenarios for the same change.',
    );
    const ids = new Set(requirements.data.requirements.map((item) => item.id));
    const covered = new Set();
    for (const scenario of scenarios.data.scenarios) {
      for (const id of scenario.requirement_ids) {
        requireValue(
          ids.has(id),
          'VALIDATION_FAILED',
          'A scenario references an unknown requirement.',
        );
        covered.add(id);
      }
    }
    requireValue(
      [...ids].every((id) => covered.has(id)),
      'VALIDATION_FAILED',
      'Every requirement needs scenario coverage.',
    );
    return {
      valid: true,
      business_accepted: false,
      semantic_review_required: true,
      content_hash: hash({ requirements, scenarios }),
    };
  };

  handlers['task.prepare'] = async (input, { projectRoot, ...context }) => {
    let { state, profile } = await load(projectRoot);
    let change = findChange(state, input.change_id);
    const task = input.task;
    requireValue(
      task && typeof task === 'object',
      'VALIDATION_FAILED',
      'A task envelope is required.',
    );
    identifier(task.id);
    if (change.kind === 'BUGFIX' && implementerRoles.has(task.role))
      requireValue(
        change.stage === 'IMPLEMENTATION',
        'GATE_BLOCKED',
        'A bugfix implementation task cannot be prepared before the reviewed reproduction gate advances to IMPLEMENTATION.',
      );
    if (planDrivenKinds.has(change.kind) && implementerRoles.has(task.role))
      requireValue(
        change.stage === 'IMPLEMENTATION',
        'GATE_BLOCKED',
        'Feature implementation tasks require a validated, reviewed implementation plan.',
      );
    requireValue(
      typeof task.role === 'string' &&
        ['depends_on', 'paths', 'verification_profiles', 'outputs'].every((key) =>
          Array.isArray(task[key]),
        ) &&
        task.outputs.length > 0,
      'VALIDATION_FAILED',
      'A task needs role, ownership, dependencies, outputs, and verification profiles.',
    );
    for (const relative of task.paths) await safePath(projectRoot, relative);
    requireValue(
      task.depends_on.every((id) => change.tasks[id]),
      'VALIDATION_FAILED',
      'Task dependencies must already exist.',
    );
    let reviewedRedDependency = false;
    let reviewedNoFileDependency = false;
    let noFileOutcome = false;
    if (planDrivenKinds.has(change.kind) && change.stage === 'IMPLEMENTATION') {
      const { plan } = await acceptedFeaturePlan(projectRoot, change);
      requireValue(
        change.kind === 'MAINTENANCE' || plan.outcome !== 'NO_FILE',
        'GATE_BLOCKED',
        'Only a reviewed MAINTENANCE plan can declare a NO_FILE outcome.',
      );
      noFileOutcome = change.kind === 'MAINTENANCE' && plan.outcome === 'NO_FILE';
      requireValue(
        !noFileOutcome || task.paths.length === 0,
        'PLAN_MISMATCH',
        'A NO_FILE maintenance plan cannot assign files to a task.',
      );
    }
    if (implementerRoles.has(task.role) && [...planDrivenKinds, 'BUGFIX'].includes(change.kind)) {
      let plannedRedDependencies = task.depends_on
        .map((id) => change.tasks[id])
        .filter((dependency) => testAuthorRoles.has(dependency.role));
      requireValue(
        plannedRedDependencies.length > 0,
        'TDD_REQUIRED',
        'An implementation task must depend on at least one designated test-author task.',
      );
      for (const dependency of plannedRedDependencies) {
        if (dependency.result?.verification_mode !== 'EXPECTED_RED') continue;
        if (
          change.pull_request?.number &&
          ['WAITING_REVIEW', 'CHANGES_REQUESTED'].includes(dependency.result.status)
        ) {
          try {
            await handlers['review.resolve'](
              { change_id: change.id, task_id: dependency.id },
              { ...context, projectRoot },
            );
          } catch (error) {
            if (!['REVIEW_REQUIRED', 'STALE_REVISION'].includes(error.code)) throw error;
          }
        }
        ({ state, profile } = await load(projectRoot));
        change = findChange(state, input.change_id);
      }
      plannedRedDependencies = task.depends_on
        .map((id) => change.tasks[id])
        .filter((dependency) => testAuthorRoles.has(dependency.role));
      const completedWithoutRed = plannedRedDependencies.some(
        (dependency) =>
          dependency.state === 'DONE' &&
          !(noFileOutcome
            ? hasReviewedGreenEvidence(change, dependency, state)
            : hasReviewedRedEvidence(change, dependency, state)),
      );
      requireValue(
        !completedWithoutRed,
        'TDD_REQUIRED',
        noFileOutcome
          ? 'A completed no-file test-author prerequisite must contain reviewed, current GREEN evidence.'
          : 'A completed test-author prerequisite must contain reviewed, evidence-backed behavioral RED.',
      );
      reviewedRedDependency = plannedRedDependencies.some((dependency) =>
        hasReviewedRedEvidence(change, dependency, state),
      );
      reviewedNoFileDependency = plannedRedDependencies.some((dependency) =>
        hasReviewedGreenEvidence(change, dependency, state),
      );
    }
    if (planDrivenKinds.has(change.kind) && change.stage === 'IMPLEMENTATION') {
      const { plan } = await acceptedFeaturePlan(projectRoot, change);
      const completed = new Set(change.completed_increment_ids ?? []);
      const currentIncrement = plan.increments.find((increment) => !completed.has(increment.id));
      requireValue(
        currentIncrement && task.increment_id === currentIncrement.id,
        'INCREMENT_BLOCKED',
        'Prepare tasks only for the next uncompleted increment in the accepted plan.',
      );
      const plannedTask = plan.tasks.find((entry) => entry.id === task.id);
      requireValue(
        plannedTask &&
          hash(plannedTask.paths ?? []) === hash(task.paths) &&
          canonicalRole(plannedTask.role) === canonicalRole(task.role) &&
          hash(plannedTask.depends_on) === hash(task.depends_on) &&
          hash(plannedTask.outputs) === hash(task.outputs) &&
          hash(plannedTask.verification_profiles) === hash(task.verification_profiles) &&
          hash(plannedTask.scenario_ids) === hash(task.scenario_ids) &&
          plannedTask.increment_id === task.increment_id,
        'PLAN_MISMATCH',
        'Planned feature/maintenance tasks must match the reviewed plan ID, role, file ownership, increment, scenarios, dependencies, outputs, and verification profiles.',
      );
    }
    requireValue(
      task.verification_profiles.every((name) => profile.commands[name]),
      'VALIDATION_FAILED',
      'Task profiles must be registered.',
    );
    const dependenciesReady = task.depends_on.every((id) => change.tasks[id].state === 'DONE');
    const ready =
      dependenciesReady &&
      (!implementerRoles.has(task.role) ||
        ![...planDrivenKinds, 'BUGFIX'].includes(change.kind) ||
        reviewedRedDependency ||
        (noFileOutcome && reviewedNoFileDependency));
    if (change.tasks[task.id]) {
      requireValue(
        hash(change.tasks[task.id].definition) === hash(task),
        'TASK_CONFLICT',
        'A task ID already refers to another envelope.',
      );
      if (change.tasks[task.id].state === 'WAITING_DEPENDENCY' && ready) {
        change.tasks[task.id].state = 'READY';
        await save(projectRoot, state, 'task.prepare.unblocked', {
          change_id: change.id,
          task_id: task.id,
        });
      } else if (
        change.tasks[task.id].state === 'READY' &&
        !ready &&
        !change.tasks[task.id].result
      ) {
        change.tasks[task.id].state = 'WAITING_DEPENDENCY';
        await save(projectRoot, state, 'task.prepare.reblocked', {
          change_id: change.id,
          task_id: task.id,
        });
      }
      return { task: change.tasks[task.id] };
    }
    const prepared = {
      ...task,
      definition: task,
      state: ready ? 'READY' : 'WAITING_DEPENDENCY',
      verification_status: 'LOCAL_RECORD_ONLY',
      review_budget: 3,
      review_attempts: 0,
    };
    change.tasks[task.id] = prepared;
    await save(projectRoot, state, 'task.prepare', { change_id: change.id, task_id: task.id });
    return { task: prepared };
  };

  handlers['increment.inspect'] = async (input, { projectRoot }) => {
    const { state } = await load(projectRoot);
    const change = findChange(state, input.change_id);
    requireValue(
      planDrivenKinds.has(change.kind) && change.stage === 'IMPLEMENTATION',
      'GATE_BLOCKED',
      'Increment operations are available only during feature or maintenance implementation.',
    );
    const { plan } = await acceptedFeaturePlan(projectRoot, change);
    const completed = new Set(change.completed_increment_ids ?? []);
    const increment = plan.increments.find((entry) => !completed.has(entry.id));
    if (!increment)
      return {
        change_id: change.id,
        complete: true,
        completed_increment_ids: [...completed],
        increment: null,
        ready: false,
        missing: [],
      };
    const plannedTasks = plan.tasks.filter((task) => task.increment_id === increment.id);
    const missing = missingIncrementTaskEvidence(
      change,
      state,
      plannedTasks,
      change.kind === 'MAINTENANCE' && plan.outcome === 'NO_FILE',
    );
    return {
      change_id: change.id,
      increment,
      ready: plannedTasks.length > 0 && missing.length === 0,
      missing,
      completed_increment_ids: [...completed],
      state_revision: state.revision,
    };
  };

  handlers['increment.advance'] = async (input, { projectRoot, ...context }) => {
    let { state } = await load(projectRoot);
    let change = findChange(state, input.change_id);
    requireValue(
      planDrivenKinds.has(change.kind) && change.stage === 'IMPLEMENTATION',
      'GATE_BLOCKED',
      'Increment advancement is available only during feature or maintenance implementation.',
    );
    requireValue(
      Number.isInteger(input.expected_revision) && input.expected_revision === state.revision,
      'STALE_REVISION',
      'Supply the inspected workflow revision; it must still match before advancing the increment.',
    );
    let { plan } = await acceptedFeaturePlan(projectRoot, change);
    let completed = new Set(change.completed_increment_ids ?? []);
    let current = plan.increments.find((increment) => !completed.has(increment.id));
    requireValue(
      current && input.increment_id === current.id,
      'STALE_INCREMENT',
      'Advance only the next uncompleted increment returned by increment.inspect.',
    );
    let plannedTasks = plan.tasks.filter((task) => task.increment_id === current.id);
    requireValue(plannedTasks.length > 0, 'GATE_BLOCKED', 'The increment has no planned tasks.');
    for (const plannedTask of plannedTasks) {
      if (change.tasks[plannedTask.id]?.state !== 'DONE') continue;
      await handlers['review.resolve'](
        { change_id: change.id, task_id: plannedTask.id },
        { ...context, projectRoot },
      );
      ({ state } = await load(projectRoot));
      change = findChange(state, input.change_id);
    }
    ({ plan } = await acceptedFeaturePlan(projectRoot, change));
    completed = new Set(change.completed_increment_ids ?? []);
    current = plan.increments.find((increment) => !completed.has(increment.id));
    plannedTasks = current ? plan.tasks.filter((task) => task.increment_id === current.id) : [];
    requireValue(
      current?.id === input.increment_id,
      'STALE_INCREMENT',
      'The current planned increment changed while task reviews were refreshed.',
    );
    const gate = await handlers['increment.inspect']({ change_id: change.id }, { projectRoot });
    requireValue(
      gate.ready,
      'GATE_BLOCKED',
      'Every task in the increment must have current accepted review and required RED/GREEN evidence.',
      { gate },
    );
    change.completed_increment_ids ??= [];
    change.completed_increment_ids.push(current.id);
    await save(projectRoot, state, 'increment.advance', {
      change_id: change.id,
      increment_id: current.id,
      task_ids: plannedTasks.map((task) => task.id),
    });
    return { change_id: change.id, increment_id: current.id, completed: true };
  };

  handlers['review.request'] = async (input, { projectRoot }) => {
    const { state } = await load(projectRoot);
    const change = findChange(state, input.change_id);
    const task = change.tasks[input.task_id];
    requireValue(
      task && typeof input.reviewer_role === 'string' && input.reviewer_role !== task.role,
      'VALIDATION_FAILED',
      'Review requires an existing task and a distinct reviewer role.',
    );
    const review = {
      id: randomUUID(),
      task_id: task.id,
      reviewer_role: input.reviewer_role,
      status: 'REQUESTED',
      accepted: false,
    };
    change.reviews.push(review);
    await save(projectRoot, state, 'review.request', {
      change_id: change.id,
      review_id: review.id,
    });
    return { review };
  };

  handlers['task.record_result'] = async (input, { projectRoot, ...context }) => {
    let { state, profile } = await load(projectRoot);
    let change = findChange(state, input.change_id);
    let task = change.tasks[input.task_id];
    requireValue(task, 'VALIDATION_FAILED', 'The task must exist.');
    const currentHead = git(projectRoot, ['rev-parse', 'HEAD']);
    let noFileOutcome = false;
    if (implementerRoles.has(task.role) && [...planDrivenKinds, 'BUGFIX'].includes(change.kind)) {
      requireValue(
        (planDrivenKinds.has(change.kind) && change.stage === 'IMPLEMENTATION') ||
          (change.kind === 'BUGFIX' && change.stage === 'IMPLEMENTATION'),
        'GATE_BLOCKED',
        'Implementation results require the reviewed feature/maintenance plan or accepted bugfix reproduction gate.',
      );
      const redDependencies = task.depends_on
        .map((id) => change.tasks[id])
        .filter((dependency) => testAuthorRoles.has(dependency.role));
      if (planDrivenKinds.has(change.kind)) {
        const { plan } = await acceptedFeaturePlan(projectRoot, change);
        requireValue(
          change.kind === 'MAINTENANCE' || plan.outcome !== 'NO_FILE',
          'GATE_BLOCKED',
          'Only a reviewed MAINTENANCE plan can declare a NO_FILE outcome.',
        );
        noFileOutcome = change.kind === 'MAINTENANCE' && plan.outcome === 'NO_FILE';
      }
      requireValue(
        redDependencies.length > 0 &&
          redDependencies.every((dependency) =>
            noFileOutcome
              ? hasReviewedGreenEvidence(change, dependency, state)
              : hasReviewedRedEvidence(change, dependency, state),
          ) &&
          (!noFileOutcome || task.paths.length === 0),
        'TDD_REQUIRED',
        noFileOutcome
          ? 'A no-file implementation result needs empty file ownership and an accepted test-author task with current GREEN evidence.'
          : 'Implementation completion requires an accepted, evidence-backed RED test-author dependency.',
      );
      for (const dependency of redDependencies) {
        await handlers['review.resolve'](
          { change_id: change.id, task_id: dependency.id },
          { ...context, projectRoot },
        );
        ({ state, profile } = await load(projectRoot));
        change = findChange(state, input.change_id);
        task = change.tasks[input.task_id];
        requireValue(
          noFileOutcome
            ? hasReviewedGreenEvidence(change, change.tasks[dependency.id], state)
            : hasReviewedRedEvidence(change, change.tasks[dependency.id], state),
          'TDD_REVIEW_REQUIRED',
          'A test-author prerequisite is no longer accepted; resolve its latest human review before completing implementation.',
        );
      }
    }
    task.review_budget ??= 3;
    task.review_attempts ??= task.result?.review_attempt ?? 0;
    if (
      task.state === 'DONE' &&
      task.result?.status === 'DONE' &&
      task.result.checkpoint_sha === currentHead &&
      hash(task.result.run_ids) === hash(input.run_ids)
    )
      return { task, accepted: true, already_recorded: true };
    requireValue(
      task.state === 'READY' ||
        task.state === 'WAITING_REVIEW' ||
        task.state === 'CHANGES_REQUESTED',
      'TASK_NOT_READY',
      'Only a ready task can submit a result for review.',
    );
    requireValue(
      Array.isArray(input.run_ids) &&
        input.run_ids.length > 0 &&
        new Set(input.run_ids).size === input.run_ids.length,
      'GATE_BLOCKED',
      'Provide unique recorded run IDs for the task verification profiles.',
    );
    const runs = input.run_ids.map((id) => state.runs[id]);
    requireValue(
      runs.every((run) => run && run.change_id === change.id),
      'INVALID_TASK_RESULT',
      'Every verification run must be recorded for this change.',
    );
    requireValue(
      runs.every((run) => task.verification_profiles.includes(run.profile)),
      'INVALID_TASK_RESULT',
      'A task result cannot include verification profiles outside its reviewed plan.',
    );
    const runProfiles = new Set(runs.map((run) => run.profile));
    requireValue(
      task.verification_profiles.every((name) => runProfiles.has(name)),
      'VERIFICATION_INCOMPLETE',
      'Every profile listed on the task must have a recorded run.',
    );
    const testAuthor = ['test_author', 'sdlc_test_author'].includes(task.role);
    const expectedRedRunIds = [];
    for (const run of runs) {
      const command = profile.commands[run.profile];
      requireValue(
        command &&
          run.source_fingerprint === run.current_fingerprint &&
          run.source_fingerprint === (await fingerprint(projectRoot, command)),
        'STALE_REVISION',
        `Verification profile ${run.profile} is stale for the current source and command configuration.`,
      );
      if (run.classification === 'PASS') continue;
      requireValue(
        testAuthor && run.classification === 'ASSERTION_FAILURE',
        'TESTS_NOT_PASSING',
        `Verification profile ${run.profile} did not pass. Only a test-author task with recorded behavioral RED evidence can submit a failing run for review.`,
      );
      const failures = run.failed_tests ?? [];
      const redEvidence = change.evidence.filter(
        (evidence) => evidence.phase === 'RED' && evidence.run_id === run.id,
      );
      const recordedFailures = new Set(
        redEvidence.map((evidence) => evidence.expected_failure?.test_id),
      );
      requireValue(
        failures.length > 0 &&
          redEvidence.length === failures.length &&
          recordedFailures.size === failures.length &&
          failures.every((failure) => recordedFailures.has(failure.name)),
        'INVALID_TDD_EVIDENCE',
        'A failing test-author run needs current TDD RED evidence for every failed assertion and no unrelated failure.',
      );
      expectedRedRunIds.push(run.id);
    }
    const taskCheckpoints = Object.values(state.receipts).filter(
      (receipt) =>
        receipt.change_id === change.id && receipt.task_id === task.id && receipt.commit_sha,
    );
    const checkpoint = taskCheckpoints.find((receipt) => receipt.commit_sha === currentHead);
    requireValue(
      checkpoint,
      'CHECKPOINT_REQUIRED',
      taskCheckpoints.length
        ? 'The task branch has moved beyond its latest recorded checkpoint; reconcile and checkpoint the current revision.'
        : 'Record a scoped task checkpoint before requesting completion review.',
    );
    requireValue(
      checkpoint.pushed && !checkpoint.pending_push,
      'PUSH_PENDING',
      'The task commit must be pushed before completion review.',
    );
    requireValue(
      checkpoint.paths.every((file) =>
        task.paths.some(
          (owned) =>
            posix(file) === posix(owned) ||
            posix(file).startsWith(`${posix(owned).replace(/\/$/, '')}/`),
        ),
      ),
      'CHECKPOINT_CONFLICT',
      'The checkpoint includes files outside the declared task ownership.',
    );
    requireValue(
      git(projectRoot, ['branch', '--show-current']) === change.branch &&
        currentHead === checkpoint.commit_sha,
      'CHECKPOINT_STALE',
      'The branch moved after this task checkpoint; review the current branch before recording the result.',
    );
    if (task.result?.status === 'WAITING_REVIEW') {
      requireValue(
        task.state === 'WAITING_REVIEW' &&
          task.result.checkpoint_sha === checkpoint.commit_sha &&
          hash(task.result.run_ids) === hash(input.run_ids),
        'TASK_RESULT_CONFLICT',
        'This task already has a different review result.',
      );
      return { task, accepted: false, already_recorded: true };
    }
    if (task.result?.status === 'CHANGES_REQUESTED') {
      requireValue(
        task.state === 'CHANGES_REQUESTED' && task.review_attempts < task.review_budget,
        'REVIEW_LIMIT_EXCEEDED',
        'The task exhausted its bounded review attempts and requires human escalation.',
      );
      task.review_history ??= [];
      task.review_history.push({ result: task.result, review: task.review });
      task.review = null;
    }
    task.review_attempts = (task.review_attempts ?? 0) + 1;
    requireValue(
      task.review_attempts <= task.review_budget,
      'REVIEW_LIMIT_EXCEEDED',
      'The task exhausted its bounded review attempts and requires human escalation.',
    );
    task.result = {
      status: 'DONE',
      verification_mode: expectedRedRunIds.length > 0 ? 'EXPECTED_RED' : 'GREEN',
      expected_red_run_ids: expectedRedRunIds,
      review_attempt: task.review_attempts,
      run_ids: input.run_ids,
      checkpoint_sha: checkpoint.commit_sha,
      at: new Date().toISOString(),
    };
    task.review = {
      status: 'ACCEPTED',
      provider: 'workflow_verification',
      reviewer: 'automated_checks',
      result_hash: hash(task.result),
      reviewed_at: task.result.at,
    };
    task.state = 'DONE';
    await save(projectRoot, state, 'task.record_result', {
      change_id: change.id,
      task_id: task.id,
      checkpoint_sha: checkpoint.commit_sha,
    });
    return {
      task,
      accepted: true,
      message: 'Recorded verification and checkpoint evidence complete the task.',
    };
  };

  handlers['stage.inspect'] = async (input, { projectRoot }) => {
    const { state } = await load(projectRoot);
    const change = findChange(state, input.change_id);
    if (change.kind === 'PROJECT_INIT')
      return {
        change_id: change.id,
        kind: change.kind,
        stage: change.stage,
        state_revision: state.revision,
        transition: await inspectInitializationTransition(projectRoot, change, state),
      };
    if (planDrivenKinds.has(change.kind))
      return {
        change_id: change.id,
        kind: change.kind,
        stage: change.stage,
        state_revision: state.revision,
        transition: await inspectFeatureTransition(projectRoot, change, state, (specification) =>
          handlers['spec.validate'](specification, { projectRoot }),
        ),
      };
    if (change.kind === 'BUGFIX')
      return {
        change_id: change.id,
        kind: change.kind,
        stage: change.stage,
        state_revision: state.revision,
        transition: await inspectBugfixTransition(projectRoot, change, state),
      };
    return {
      change_id: change.id,
      kind: change.kind,
      stage: change.stage,
      state_revision: state.revision,
      supported: false,
      reason: 'This change kind has no executable transition policy yet.',
    };
  };

  handlers['decision.accept'] = async (input, { projectRoot }) => {
    requireValue(
      input &&
        Object.keys(input).every((key) =>
          [
            'change_id',
            'artifact_id',
            'decision',
            'expected_revision',
            'expected_content_hash',
          ].includes(key),
        ) &&
        typeof input.change_id === 'string' &&
        typeof input.artifact_id === 'string' &&
        ['APPROVED', 'REJECTED'].includes(input.decision) &&
        Number.isInteger(input.expected_revision) &&
        typeof input.expected_content_hash === 'string',
      'VALIDATION_FAILED',
      'A chat decision requires the change, artifact, explicit decision, and inspected revision/content hash.',
    );
    const { state } = await load(projectRoot);
    requireValue(
      input.expected_revision === state.revision,
      'STALE_REVISION',
      'The workflow changed after this artifact was presented in chat. Re-present the current artifact before recording a decision.',
    );
    const change = findChange(state, input.change_id);
    const ref = change.artifacts.find((artifact) => artifact.id === input.artifact_id);
    requireValue(
      ref,
      'ARTIFACT_NOT_FOUND',
      'The decision subject is not registered to this change.',
    );
    const artifact = await readJson(
      await safePath(projectRoot, ref.path, {
        protectedAccess: ref.path.startsWith('.workflow-runtime/'),
      }),
    );
    const subjectHash = hash(artifact);
    requireValue(
      subjectHash === ref.content_hash && subjectHash === input.expected_content_hash,
      'STALE_ARTIFACT',
      'The artifact changed after it was presented in chat. Review and decide on the current content.',
    );
    const approval = {
      artifact_id: ref.id,
      status: input.decision,
      provider: 'codex_chat',
      reviewer: 'user',
      subject_hash: subjectHash,
      decided_at: new Date().toISOString(),
    };
    const existing = change.approvals.findIndex((entry) => entry.artifact_id === ref.id);
    if (existing >= 0) change.approvals[existing] = approval;
    else change.approvals.push(approval);
    await save(projectRoot, state, 'decision.accept', {
      change_id: change.id,
      artifact_id: ref.id,
      decision: input.decision,
      subject_hash: subjectHash,
      source: 'codex_chat',
    });
    return { change_id: change.id, artifact_id: ref.id, approval, state_revision: state.revision };
  };

  handlers['stage.advance'] = async (input, { projectRoot, ...context }) => {
    let { state } = await load(projectRoot);
    let change = findChange(state, input.change_id);
    requireValue(
      typeof input.to === 'string',
      'VALIDATION_FAILED',
      'Choose the next stage explicitly.',
    );
    const previousTransition = (change.stage_history ?? []).find(
      (entry) => entry.from === input.expected_stage && entry.to === input.to,
    );
    if (change.stage === input.to && previousTransition)
      return { change, already_advanced: true, transition: previousTransition };
    requireValue(
      ['PROJECT_INIT', ...planDrivenKinds, 'BUGFIX'].includes(change.kind),
      'GATE_BLOCKED',
      'Executable stage gates are not yet registered for this change kind.',
    );
    const inspectGate = () =>
      change.kind === 'PROJECT_INIT'
        ? inspectInitializationTransition(projectRoot, change, state)
        : planDrivenKinds.has(change.kind)
          ? inspectFeatureTransition(projectRoot, change, state, (specification) =>
              handlers['spec.validate'](specification, { projectRoot }),
            )
          : inspectBugfixTransition(projectRoot, change, state);
    let gate = await inspectGate();
    requireValue(
      gate.supported && gate.to === input.to,
      'GATE_BLOCKED',
      `No executable transition from ${change.stage} to ${input.to} is registered.`,
    );
    requireValue(
      input.expected_stage === change.stage,
      'STALE_STAGE',
      'Supply the inspected stage; it must still match the current change stage.',
    );
    requireValue(
      Number.isInteger(input.expected_revision) && input.expected_revision === state.revision,
      'STALE_REVISION',
      'Supply the inspected state revision; it must still match the current workflow state.',
    );
    if (change.kind === 'WORKFLOW_CHANGE' && change.stage === 'EVALUATION') {
      await handlers['pr.refresh']({ change_id: change.id }, { ...context, projectRoot });
      const refreshed = await load(projectRoot);
      state = refreshed.state;
      change = findChange(state, input.change_id);
      gate = await inspectGate();
    }
    if (
      input.to === 'COMPLETE' &&
      change.pull_request?.number &&
      gate.missing.length === 1 &&
      gate.missing[0] === 'manual_merge_confirmation'
    ) {
      await handlers['change.confirm_merge']({ change_id: change.id }, { ...context, projectRoot });
      const refreshed = await load(projectRoot);
      state = refreshed.state;
      change = findChange(state, input.change_id);
      gate = await inspectGate();
    }
    if (!gate.ready)
      throw new WorkflowError(
        'GATE_BLOCKED',
        'Stage prerequisites are not satisfied. Complete the listed artifacts and validation, record chat approvals, or wait for the user to merge the pull request.',
        { gate },
      );
    const transition = {
      from: change.stage,
      to: input.to,
      evidence: gate.evidence,
      advanced_at: new Date().toISOString(),
    };
    change.stage_history ??= [];
    change.stage_history.push(transition);
    change.stage = input.to;
    change.status = input.to === 'COMPLETE' ? 'PASSED' : 'READY';
    await save(projectRoot, state, 'stage.advance', {
      change_id: change.id,
      from: transition.from,
      to: transition.to,
      evidence: transition.evidence,
    });
    return { change, transition, already_advanced: false };
  };

  handlers['quality.check'] = async (input, context) =>
    handlers['tests.run']({ ...input, profile: input.profile ?? 'quality' }, context);

  // Registered fail-closed endpoints identify missing integrations without inventing success.
  for (const name of ['workflow.activate', 'workflow.migrate']) {
    handlers[name] = async () => {
      throw new WorkflowError(
        name === 'workflow.activate'
          ? 'ACTIVATION_GATES_UNAVAILABLE'
          : 'MIGRATION_GATES_UNAVAILABLE',
        name === 'workflow.activate'
          ? 'Activation requires an evaluation performed under the prior pinned bundle, authenticated human approval bound to the candidate identity, and a verified protected operation boundary. Merge or installation alone is not activation.'
          : 'Migration requires a reviewed plan, authenticated approval, tested reversible transformation, backup, and recovery evidence. Existing changes remain pinned; no state was changed.',
      );
    };
  }
  for (const name of ['release.publish']) {
    handlers[name] = async () => {
      throw new WorkflowError(
        'INTEGRATION_NOT_CONFIGURED',
        `${name} requires a separately configured and verified authority/integration adapter. No external effect was performed.`,
      );
    };
  }
  registerDeploymentOperations(handlers);
  registerGithubOperations(handlers);
  registerDeliveryGithubOperations(handlers);
}
