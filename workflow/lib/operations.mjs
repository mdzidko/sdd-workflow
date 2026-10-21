import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  atomicWrite,
  fingerprint,
  git,
  hash,
  identifier,
  posix,
  redact,
  requireValue,
  revision,
  safePath,
  sourceFiles,
  WorkflowError,
} from './support.mjs';
import { findChange, load, readJson, save, stateFile, withLock } from './state.mjs';
import { validateArtifact, validatePlan, validateProfile } from './contracts.mjs';
import { acceptedFeaturePlan, registerBundleOperations } from './bundle-operations.mjs';

export const handlers = {};
const planDrivenKinds = new Set(['FEATURE', 'MAINTENANCE', 'WORKFLOW_CHANGE']);

function hasReviewedGreenTestAuthor(change, task, state) {
  return (
    ['test_author', 'sdlc_test_author'].includes(task?.role) &&
    task.state === 'DONE' &&
    task.review?.status === 'ACCEPTED' &&
    task.result?.verification_mode === 'GREEN' &&
    Array.isArray(task.result.run_ids) &&
    task.result.run_ids.length > 0 &&
    task.result.run_ids.every(
      (runId) =>
        state.runs[runId]?.change_id === change.id && state.runs[runId]?.classification === 'PASS',
    )
  );
}

function initializationGit(root, args) {
  try {
    return git(root, args);
  } catch (error) {
    if (error.code !== 'GIT_FAILED' || !/\b(?:EPERM|EACCES|ENOENT)\b/i.test(error.message))
      throw error;
    throw new WorkflowError(
      'GIT_ACCESS_UNAVAILABLE',
      'Project initialization needs read-only Git access to verify the repository and locate its local exclude file. Allow the Node workflow process to run Git (or install Git), then retry. No project profile or workflow state was written.',
    );
  }
}

handlers['workflow.init'] = async (input, { projectRoot: root }) => {
  const profile = validateProfile(input.profile ?? {});
  const bundle = await handlers['bundle.inspect']({}, { projectRoot: root });
  requireValue(
    bundle.candidate_matches_installed,
    'BUNDLE_VERSION_CONFLICT',
    'The installed bundle identity differs from the operation sources. Resolve the pinned migration before initialization.',
  );
  profile.bundle_version = bundle.manifest.bundle_version;
  profile.bundle_hash = bundle.manifest_hash;
  initializationGit(root, ['rev-parse', '--show-toplevel']);
  const profilePath = await stateFile(root, 'project.json');
  const pendingPath = await stateFile(root, 'initialization.pending.json');
  try {
    await fs.access(profilePath);
    let current;
    try {
      current = await load(root);
    } catch (error) {
      if (error.code !== 'NOT_INITIALIZED') throw error;
      let pending;
      try {
        pending = await readJson(pendingPath);
      } catch {
        /* No trusted initialization receipt exists. */
      }
      requireValue(
        pending?.profile_hash === hash(profile),
        'INITIALIZATION_INCOMPLETE',
        'A profile exists without durable state or a matching initialization receipt. No state has been invented.',
      );
      const recovered = {
        schema_version: '1',
        revision: 0,
        changes: {},
        runs: {},
        receipts: {},
        events: [],
      };
      await save(root, recovered, 'workflow.init.recover');
      current = { profile: await readJson(profilePath), state: recovered };
    }
    requireValue(
      hash(current.profile) === hash(profile),
      'PROFILE_CONFLICT',
      'This project is already initialized with another profile.',
    );
    await fs.rm(pendingPath, { force: true });
    return { profile: current.profile, already_initialized: true };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.access(await stateFile(root, 'state.json'));
    throw new WorkflowError(
      'INITIALIZATION_INCOMPLETE',
      'Durable state exists without its project profile. Existing history has been preserved.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const state = {
    schema_version: '1',
    revision: 0,
    changes: {},
    runs: {},
    receipts: {},
    events: [],
  };
  const excludePath = path.resolve(
    root,
    initializationGit(root, ['rev-parse', '--git-path', 'info/exclude']),
  );
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  let exclusions = '';
  try {
    exclusions = await fs.readFile(excludePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!exclusions.split(/\r?\n/).includes('.workflow/'))
    await fs.appendFile(excludePath, '\n.workflow/\n');
  await atomicWrite(pendingPath, JSON.stringify({ profile_hash: hash(profile) }));
  await atomicWrite(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  await save(root, state, 'workflow.init');
  await fs.rm(pendingPath, { force: true });
  return {
    profile,
    state_path: '.workflow/state.json',
    authorization_boundary: 'UNVERIFIED_LOCAL_STATE',
  };
};

handlers['workflow.inspect'] = async (_input, { projectRoot }) => {
  const { profile, state } = await load(projectRoot);
  return {
    profile,
    changes: Object.values(state.changes),
    revision: state.revision,
    active_bundle: { version: profile.bundle_version, hash: profile.bundle_hash ?? null },
    authorization_boundary: 'UNVERIFIED_LOCAL_STATE',
    operation_names: Object.keys(handlers),
  };
};

handlers['workflow.resume'] = async (input, { projectRoot }) => {
  const { state } = await load(projectRoot);
  const change = findChange(state, input.change_id);
  let repositoryStatus;
  try {
    repositoryStatus = {
      verified: true,
      current_branch: git(projectRoot, ['branch', '--show-current']),
      current_sha: git(projectRoot, ['rev-parse', 'HEAD']),
    };
  } catch (error) {
    if (error.code !== 'GIT_FAILED' || !/\b(?:EPERM|EACCES|ENOENT)\b/i.test(error.message))
      throw error;
    repositoryStatus = {
      verified: false,
      current_branch: null,
      current_sha: null,
      reason: 'GIT_ACCESS_UNAVAILABLE',
    };
  }
  return {
    change,
    ...repositoryStatus,
    pending_checkpoints: Object.values(state.receipts).filter(
      (receipt) => receipt.change_id === change.id && receipt.pending_push,
    ),
    next_action: repositoryStatus.verified
      ? (change.next_action ?? 'Review the saved stage and current repository before delegating.')
      : 'Saved workflow state was loaded, but Git could not verify the current branch and revision. Restore Git access and resume again before any mutation.',
  };
};

handlers['change.start'] = async (input, { projectRoot }) => {
  identifier(input.id);
  requireValue(
    ['PROJECT_INIT', 'FEATURE', 'BUGFIX', 'MAINTENANCE', 'WORKFLOW_CHANGE'].includes(input.kind) &&
      typeof input.description === 'string' &&
      input.description.trim(),
    'VALIDATION_FAILED',
    'A change needs a registered kind and description.',
  );
  const { state, profile } = await load(projectRoot);
  if (state.changes[input.id]) {
    const change = state.changes[input.id];
    requireValue(
      change.kind === input.kind && change.description === input.description,
      'CHANGE_CONFLICT',
      'This change ID already describes different work.',
    );
    return { change, already_exists: true };
  }
  const base = git(projectRoot, ['rev-parse', profile.repository.base_branch]);
  requireValue(
    !input.expected_sha || input.expected_sha === base,
    'STALE_REVISION',
    'The integration branch changed since it was inspected.',
  );
  requireValue(
    git(projectRoot, ['status', '--porcelain']) === '',
    'DIRTY_WORKTREE',
    'Commit or isolate unrelated work before creating a change branch.',
  );
  const prefix = {
    PROJECT_INIT: 'chore',
    FEATURE: 'feature',
    BUGFIX: 'fix',
    MAINTENANCE: 'chore',
    WORKFLOW_CHANGE: 'workflow',
  }[input.kind];
  const slug =
    input.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 45) || 'change';
  const branch = `${prefix}/${input.id}-${slug}`;
  const exists = git(projectRoot, ['show-ref', '--verify', `refs/heads/${branch}`], {
    allowFailure: true,
  });
  if (exists.status === 0)
    requireValue(
      git(projectRoot, ['rev-parse', branch]) === base,
      'CHANGE_CONFLICT',
      'An unrecorded branch with this name already contains other work.',
    );
  if (exists.status !== 0) git(projectRoot, ['branch', branch, base]);
  git(projectRoot, ['switch', branch]);
  const change = {
    id: input.id,
    kind: input.kind,
    description: input.description,
    branch,
    base_sha: base,
    bundle_version: profile.bundle_version,
    bundle_hash: profile.bundle_hash ?? null,
    stage:
      input.kind === 'PROJECT_INIT'
        ? 'FOUNDATIONS'
        : input.kind === 'BUGFIX'
          ? 'REPRODUCTION'
          : 'REQUIREMENTS',
    status: 'READY',
    tasks: {},
    reviews: [],
    approvals: [],
    evidence: [],
    artifacts: [],
  };
  state.changes[input.id] = change;
  await save(projectRoot, state, 'change.start', { change_id: input.id, branch });
  return { change };
};

handlers['artifact.create'] = async (input, { projectRoot }) => {
  identifier(input.id);
  identifier(input.change_id);
  const { state, profile } = await load(projectRoot);
  const change = findChange(state, input.change_id);
  const artifact = {
    schema_version: '1',
    type: input.type,
    id: input.id,
    change_id: input.change_id,
    title: input.title,
    status: 'draft',
    data: input.data ?? {},
  };
  await validateArtifact(artifact);
  const localNoFileEvidence =
    artifact.type === 'defect-report' && artifact.data.already_fixed_deployment_id !== undefined;
  const relative = posix(
    localNoFileEvidence
      ? `.workflow-runtime/no-file-evidence/${input.change_id}/${input.id}.json`
      : `${profile.artifact_directory ?? 'docs/changes'}/${input.change_id}/${input.id}.json`,
  );
  const file = await safePath(projectRoot, relative, { protectedAccess: localNoFileEvidence });
  const canonical = `${JSON.stringify(artifact, null, 2)}\n`;
  let created = false;
  try {
    const existing = await fs.readFile(file, 'utf8');
    requireValue(
      existing === canonical,
      'ARTIFACT_EXISTS',
      'An artifact already uses this ID with different content; update it explicitly rather than overwriting it.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await atomicWrite(file, canonical);
    created = true;
  }
  const markdown = `# ${artifact.title}\n\nType: ${artifact.type} | ID: ${artifact.id} | Status: draft\n\n\`\`\`json\n${JSON.stringify(artifact.data, null, 2)}\n\`\`\`\n`;
  const markdownFile = file.replace(/\.json$/, '.md');
  let writeMarkdown;
  try {
    writeMarkdown = (await fs.readFile(markdownFile, 'utf8')) !== markdown;
  } catch (error) {
    if (error.code === 'ENOENT') writeMarkdown = true;
    else throw error;
  }
  if (writeMarkdown) await atomicWrite(markdownFile, markdown);
  const registered = change.artifacts.some((entry) => entry.id === artifact.id);
  if (!registered)
    change.artifacts.push({
      id: artifact.id,
      type: artifact.type,
      path: relative,
      content_hash: hash(artifact),
    });
  if (created || writeMarkdown || !registered)
    await save(projectRoot, state, 'artifact.create', {
      change_id: change.id,
      artifact_id: artifact.id,
      recovered: !created,
    });
  return {
    path: relative,
    markdown_path: relative.replace(/\.json$/, '.md'),
    artifact,
    recovered: !created,
  };
};

handlers['artifact.validate'] = async (input, { projectRoot }) => {
  const artifact = await readJson(await safePath(projectRoot, input.path), 'VALIDATION_FAILED');
  return { ...(await validateArtifact(artifact)), content_hash: hash(artifact) };
};

handlers['plan.validate'] = async (input, { projectRoot }) => {
  const { profile } = await load(projectRoot);
  return validatePlan(
    input.plan,
    input.scenario_ids ?? [],
    (profile.applications ?? []).map((application) => application.id),
  );
};

handlers['repo.read'] = async (input, { projectRoot }) => {
  const file = await safePath(projectRoot, input.path);
  const stat = await fs.stat(file);
  requireValue(
    stat.isFile() && stat.size <= 2 * 1024 * 1024,
    'INVALID_PATH',
    'Read a bounded text file.',
  );
  const body = await fs.readFile(file, 'utf8');
  requireValue(!body.includes('\0'), 'INVALID_PATH', 'Binary files cannot be read as source text.');
  const lines = body.split(/\r?\n/);
  const start = input.start_line ?? 1;
  const end = input.end_line ?? Math.min(lines.length, start + 199);
  const maxChars = input.max_chars ?? 12_000;
  requireValue(
    Number.isInteger(start) &&
      start > 0 &&
      Number.isInteger(end) &&
      end >= start &&
      end - start < 2000 &&
      Number.isInteger(maxChars) &&
      maxChars > 0 &&
      maxChars <= 50_000,
    'VALIDATION_FAILED',
    'Read limits must be positive and bounded.',
  );
  const selected = lines.slice(start - 1, end).join('\n');
  return {
    path: posix(input.path),
    revision: await revision(projectRoot),
    start_line: start,
    end_line: Math.min(end, lines.length),
    content: selected.slice(0, maxChars),
    truncated: selected.length > maxChars,
  };
};

handlers['repo.search'] = async (input, { projectRoot }) => {
  requireValue(
    typeof input.query === 'string' && input.query.length > 0 && input.query.length <= 1000,
    'VALIDATION_FAILED',
    'A bounded literal query is required.',
  );
  const limit = input.limit ?? 30;
  requireValue(
    Number.isInteger(limit) && limit > 0 && limit <= 200,
    'VALIDATION_FAILED',
    'Search limit must be between 1 and 200.',
  );
  const matches = [];
  let truncated = false;
  for (const relative of await sourceFiles(projectRoot)) {
    const body = await fs.readFile(await safePath(projectRoot, relative), 'utf8');
    if (body.includes('\0')) continue;
    const lines = body.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(input.query)) continue;
      if (matches.length === limit) {
        truncated = true;
        break;
      }
      matches.push({ path: posix(relative), line: index + 1, text: lines[index].slice(0, 500) });
    }
    if (truncated) break;
  }
  return { matches, truncated, revision: await revision(projectRoot) };
};

handlers['tests.run'] = async (input, context) => {
  const { projectRoot } = context;
  const { profile, state } = await load(projectRoot);
  const command = profile.commands[input.profile];
  requireValue(command, 'TEST_PROFILE_NOT_FOUND', 'The test profile is not registered.');
  if (input.change_id) findChange(state, input.change_id);
  const before = await fingerprint(projectRoot, command);
  const args = command.args.includes('--test')
    ? ['--test-reporter=tap', ...command.args.filter((arg) => !arg.startsWith('--test-reporter'))]
    : command.args;
  const executed = spawnSync(command.command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: command.timeout_ms ?? 60_000,
    maxBuffer: 1024 * 1024,
    env: Object.fromEntries(
      Object.entries(context.env ?? process.env).filter(
        ([key]) =>
          !/(TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key) &&
          !/^NODE_TEST/.test(key) &&
          key !== 'NODE_OPTIONS',
      ),
    ),
  });
  const output = `${executed.stdout ?? ''}\n${executed.stderr ?? ''}`;
  const infrastructure =
    executed.error ||
    /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|SyntaxError|ENOENT|ECONNREFUSED|EPERM/.test(
      output,
    );
  const assertion =
    !infrastructure &&
    /ERR_ASSERTION|AssertionError/.test(output) &&
    /not ok|testCodeFailure/.test(output);
  const classification =
    executed.status === 0 && !executed.error
      ? 'PASS'
      : assertion
        ? 'ASSERTION_FAILURE'
        : 'INFRASTRUCTURE_FAILURE';
  const nodeAdapter =
    path.resolve(command.command) === process.execPath && command.args.includes('--test');
  const testCount = nodeAdapter ? Number(output.match(/^# tests (\d+)\s*$/m)?.[1] ?? 0) : 0;
  const skipped = Number(output.match(/^# skipped (\d+)\s*$/m)?.[1] ?? 0);
  const todo = Number(output.match(/^# todo (\d+)\s*$/m)?.[1] ?? 0);
  const identities = [...output.matchAll(/^# Subtest: (.+)$/gm)]
    .map((match) => match[1])
    .filter(
      (name) =>
        !path.isAbsolute(name) && !/\.(?:mjs|cjs|js)$/.test(name) && !name.startsWith('file://'),
    );
  const failedTests = [
    ...output.matchAll(/^not ok \d+ - (.+)\r?\n([\s\S]*?)(?=^(?:not ok|ok) \d+ - |^1\.\.)/gm),
  ]
    .map((match) => ({ name: match[1].trim(), diagnostic: match[2].slice(0, 20_000) }))
    .filter((item) => item.diagnostic.length > 0);
  const run = redact(
    {
      id: randomUUID(),
      change_id: input.change_id ?? null,
      profile: input.profile,
      classification,
      test_adapter: nodeAdapter ? 'node-test-tap' : 'unverified-command',
      test_count: testCount,
      executed_test_count: testCount - skipped - todo,
      test_identities: identities,
      failed_tests: failedTests,
      exit_code: executed.status,
      signal: executed.signal,
      timed_out: executed.error?.code === 'ETIMEDOUT',
      source_fingerprint: before,
      current_fingerprint: await fingerprint(projectRoot, command),
      command_fingerprint: hash(command),
      revision: await revision(projectRoot),
      output: output.slice(0, 100_000),
      at: new Date().toISOString(),
    },
    context.env ?? process.env,
  );
  state.runs[run.id] = run;
  await save(projectRoot, state, 'tests.run', { run_id: run.id, classification });
  return { run };
};

handlers['tdd.record'] = async (input, { projectRoot }) => {
  const { profile, state } = await load(projectRoot);
  const change = findChange(state, input.change_id);
  const run = state.runs[input.run_id];
  requireValue(
    run && run.change_id === change.id && ['RED', 'GREEN'].includes(input.phase),
    'INVALID_TDD_EVIDENCE',
    'Select a recorded test run for this change and a valid phase.',
  );
  requireValue(
    run.source_fingerprint === run.current_fingerprint &&
      run.source_fingerprint === (await fingerprint(projectRoot, profile.commands[run.profile])),
    'STALE_REVISION',
    'Source, test definitions, or profile changed after this run.',
  );
  requireValue(
    run.test_adapter === 'node-test-tap' &&
      run.executed_test_count > 0 &&
      run.test_identities.length > 0,
    'INVALID_TDD_EVIDENCE',
    'TDD certification requires a supported report with actual executed tests. A command exit code alone is insufficient.',
  );
  if (input.phase === 'RED') {
    const failure = run.failed_tests?.find((item) => item.name === input.expected_failure?.test_id);
    requireValue(
      run.classification === 'ASSERTION_FAILURE' &&
        failure &&
        typeof input.expected_failure.message === 'string' &&
        input.expected_failure.message.trim() &&
        failure.diagnostic.includes(input.expected_failure.message),
      'INVALID_TDD_EVIDENCE',
      'RED requires an observed behavioral assertion and expected failure explanation from the same failed test.',
    );
  } else
    requireValue(
      run.classification === 'PASS',
      'INVALID_TDD_EVIDENCE',
      'GREEN requires a successful current test run.',
    );
  const evidence = {
    phase: input.phase,
    run_id: run.id,
    source_fingerprint: run.source_fingerprint,
    expected_failure: input.expected_failure ?? null,
  };
  change.evidence.push(evidence);
  await save(projectRoot, state, 'tdd.record', {
    change_id: change.id,
    run_id: run.id,
    phase: input.phase,
  });
  return { evidence };
};

handlers['change.checkpoint'] = async (input, { projectRoot, ...context }) => {
  identifier(input.task_id);
  let { state, profile } = await load(projectRoot);
  let change = findChange(state, input.change_id);
  requireValue(
    git(projectRoot, ['branch', '--show-current']) === change.branch,
    'WRONG_BRANCH',
    'Switch to the change branch before checkpointing.',
  );
  requireValue(
    Array.isArray(input.paths) &&
      input.paths.every((item) => typeof item === 'string') &&
      typeof input.message === 'string' &&
      input.message.trim() &&
      !input.message.includes('\n'),
    'VALIDATION_FAILED',
    'A checkpoint needs explicit paths and a single-line commit message.',
  );
  for (const relative of input.paths) await safePath(projectRoot, relative);
  const key = hash({
    change_id: change.id,
    task_id: input.task_id,
    paths: input.paths,
    message: input.message,
  });
  const checkpointTask = change.tasks[input.task_id];
  if (
    !state.receipts[key] &&
    ['implementer', 'sdlc_implementer'].includes(checkpointTask?.role) &&
    [...planDrivenKinds, 'BUGFIX'].includes(change.kind)
  ) {
    requireValue(
      (planDrivenKinds.has(change.kind) && change.stage === 'IMPLEMENTATION') ||
        (change.kind === 'BUGFIX' && change.stage === 'IMPLEMENTATION'),
      'GATE_BLOCKED',
      'Implementation checkpoints require the reviewed feature/maintenance plan or accepted bugfix reproduction gate.',
    );
    let noFileOutcome = false;
    if (planDrivenKinds.has(change.kind)) {
      const { plan } = await acceptedFeaturePlan(projectRoot, change);
      noFileOutcome = change.kind === 'MAINTENANCE' && plan.outcome === 'NO_FILE';
      requireValue(
        change.kind === 'MAINTENANCE' || plan.outcome !== 'NO_FILE',
        'GATE_BLOCKED',
        'Only a reviewed MAINTENANCE plan can declare a NO_FILE outcome.',
      );
    }
    const redDependencies = checkpointTask.depends_on
      .map((id) => change.tasks[id])
      .filter((dependency) => ['test_author', 'sdlc_test_author'].includes(dependency.role));
    if (noFileOutcome) {
      requireValue(
        checkpointTask.paths.length === 0 &&
          input.paths.length === 0 &&
          redDependencies.length > 0 &&
          redDependencies.every((dependency) =>
            hasReviewedGreenTestAuthor(change, dependency, state),
          ),
        'TDD_REQUIRED',
        'A NO_FILE maintenance checkpoint needs empty file ownership and an accepted test-author task with current GREEN evidence.',
      );
    } else {
      requireValue(
        redDependencies.length > 0 &&
          redDependencies.every(
            (dependency) =>
              dependency.result?.verification_mode === 'EXPECTED_RED' &&
              dependency.state === 'DONE' &&
              dependency.review?.status === 'ACCEPTED' &&
              dependency.result.expected_red_run_ids?.length > 0 &&
              dependency.result.expected_red_run_ids.every(
                (runId) =>
                  dependency.result.run_ids.includes(runId) &&
                  state.runs[runId]?.change_id === change.id &&
                  state.runs[runId]?.classification === 'ASSERTION_FAILURE' &&
                  change.evidence.some((item) => item.phase === 'RED' && item.run_id === runId),
              ),
          ),
        'TDD_REQUIRED',
        'Implementation checkpoints require an accepted test-author task with actual behavioral RED evidence.',
      );
      for (const dependency of redDependencies) {
        await handlers['review.resolve'](
          { change_id: change.id, task_id: dependency.id },
          { ...context, projectRoot },
        );
      }
    }
    const refreshed = await load(projectRoot);
    state = refreshed.state;
    change = findChange(state, input.change_id);
    const currentChange = change;
    const currentTask = currentChange.tasks[input.task_id];
    requireValue(
      currentTask.state === 'READY' &&
        redDependencies.every((dependency) =>
          noFileOutcome
            ? hasReviewedGreenTestAuthor(currentChange, currentChange.tasks[dependency.id], state)
            : currentChange.tasks[dependency.id]?.state === 'DONE' &&
              currentChange.tasks[dependency.id]?.review?.status === 'ACCEPTED',
        ),
      'TDD_REVIEW_REQUIRED',
      'The reviewed test-author prerequisite changed before implementation checkpoint; return to test review first.',
    );
  }
  let receipt = state.receipts[key];
  let head = git(projectRoot, ['rev-parse', 'HEAD']);
  if (!receipt) {
    requireValue(
      !input.expected_sha || input.expected_sha === head,
      'STALE_REVISION',
      'The branch changed since checkpoint preparation.',
    );
    requireValue(
      git(projectRoot, ['diff', '--cached', '--name-only']) === '',
      'STAGED_CHANGES_CONFLICT',
      'Preserve or commit the existing index before a workflow checkpoint.',
    );
    if (input.paths.length > 0) git(projectRoot, ['add', '--', ...input.paths]);
    const diff = git(projectRoot, ['diff', '--cached', '--name-only']);
    const stagedPaths = diff.split(/\r?\n/).filter(Boolean);
    requireValue(
      stagedPaths.every((file) =>
        input.paths.some(
          (owned) =>
            posix(file) === posix(owned) ||
            posix(file).startsWith(`${posix(owned).replace(/\/$/, '')}/`),
        ),
      ),
      'CHECKPOINT_CONFLICT',
      'The staged diff exceeds the declared ownership.',
    );
    receipt = {
      change_id: change.id,
      task_id: input.task_id,
      before_sha: head,
      no_changes: !diff,
      pending_push: Boolean(diff) && input.push !== false,
      pushed: !diff,
      prepared: true,
      paths: input.paths,
      expected_tree: git(projectRoot, ['write-tree']),
    };
    state.receipts[key] = receipt;
    await save(projectRoot, state, 'checkpoint.prepare', {
      change_id: change.id,
      task_id: input.task_id,
    });
    if (diff) git(projectRoot, ['commit', '-m', input.message]);
    receipt.commit_sha = git(projectRoot, ['rev-parse', 'HEAD']);
    receipt.prepared = false;
    await save(projectRoot, state, 'checkpoint.commit', {
      change_id: change.id,
      task_id: input.task_id,
      commit_sha: receipt.commit_sha,
    });
  } else if (receipt.prepared) {
    if (head !== receipt.before_sha) {
      requireValue(
        git(projectRoot, ['log', '-1', '--format=%s']) === input.message &&
          git(projectRoot, ['rev-parse', 'HEAD^']) === receipt.before_sha &&
          git(projectRoot, ['rev-parse', 'HEAD^{tree}']) === receipt.expected_tree,
        'CHECKPOINT_CONFLICT',
        'The interrupted checkpoint cannot be reconciled safely.',
      );
      receipt.commit_sha = head;
      receipt.prepared = false;
    } else {
      requireValue(
        git(projectRoot, ['write-tree']) === receipt.expected_tree,
        'CHECKPOINT_CONFLICT',
        'The current index differs from the prepared owned tree.',
      );
      git(projectRoot, ['commit', '-m', input.message]);
      receipt.commit_sha = git(projectRoot, ['rev-parse', 'HEAD']);
      receipt.prepared = false;
    }
    await save(projectRoot, state, 'checkpoint.reconcile', { change_id: change.id });
  }
  requireValue(
    receipt.commit_sha === git(projectRoot, ['rev-parse', 'HEAD']),
    'STALE_REVISION',
    'The branch moved after this checkpoint; reconcile before retrying.',
  );
  const ownedChanges = input.paths.length
    ? git(projectRoot, ['status', '--porcelain', '--', ...input.paths])
    : '';
  requireValue(
    !ownedChanges,
    'CHECKPOINT_CONFLICT',
    'Owned files changed after this checkpoint. Prepare a new task revision instead of reusing the completed checkpoint.',
  );
  if (input.push !== false && !receipt.pushed) {
    const pushed = git(projectRoot, ['push', '-u', profile.repository.remote, change.branch], {
      allowFailure: true,
    });
    if (pushed.status !== 0)
      throw new WorkflowError(
        'PUSH_FAILED',
        'The local checkpoint is saved; remote push failed. Retry this exact checkpoint after correcting remote access.',
      );
    receipt.pending_push = false;
    receipt.pushed = true;
    await save(projectRoot, state, 'checkpoint.push', {
      change_id: change.id,
      commit_sha: receipt.commit_sha,
    });
  }
  return { ...receipt, authorization_scope: 'local_checkpoint_primitive' };
};

registerBundleOperations(handlers);

export async function execute(request, context = {}) {
  const operation = request?.operation;
  const environment = context.env ?? process.env;
  try {
    requireValue(
      typeof operation === 'string' && Object.hasOwn(handlers, operation),
      'UNKNOWN_OPERATION',
      'The operation is not registered.',
    );
    requireValue(
      request.input === undefined ||
        (request.input && typeof request.input === 'object' && !Array.isArray(request.input)),
      'VALIDATION_FAILED',
      'Operation input must be an object.',
    );
    const projectRoot = await fs.realpath(context.projectRoot ?? process.cwd());
    const invoke = () => handlers[operation](request.input ?? {}, { ...context, projectRoot });
    const readonly = [
      'workflow.inspect',
      'workflow.resume',
      'workflow.lock.inspect',
      'stage.inspect',
      'change.route',
      'repo.read',
      'repo.search',
      'artifact.validate',
      'spec.validate',
      'plan.validate',
      'bundle.inspect',
      'bundle.preflight',
      'workflow.doctor',
      'context.prepare',
      'context.refresh',
      'tests.find',
      'test.schedule',
    ].includes(operation);
    const data =
      readonly || operation === 'workflow.lock.recover'
        ? await invoke()
        : await withLock(projectRoot, invoke);
    return redact({ ok: true, operation, data }, environment);
  } catch (error) {
    return redact(
      {
        ok: false,
        operation,
        error: {
          code: error.code ?? 'OPERATION_FAILED',
          message: error.message || 'Operation failed.',
          ...(error.details ? { details: error.details } : {}),
        },
      },
      environment,
    );
  }
}
