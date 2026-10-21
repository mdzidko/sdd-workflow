import fs from 'node:fs/promises';
import { atomicWrite, git, hash, requireValue, safePath, WorkflowError } from './support.mjs';
import { validateArtifact } from './contracts.mjs';
import { findChange, load, readJson, save } from './state.mjs';
import {
  githubDownload,
  githubConfiguration,
  githubRequest,
  repositoryEndpoint,
  summarizePullRequest,
} from './github-api.mjs';
import { readEvaluationReportArchive } from './evaluation-artifact.mjs';

const testAuthorRoles = new Set(['test_author', 'sdlc_test_author']);
const implementerRoles = new Set(['implementer', 'sdlc_implementer']);

function hasReviewedRedEvidence(change, task, state) {
  const runIds = task?.result?.expected_red_run_ids;
  return (
    testAuthorRoles.has(task?.role) &&
    task.state === 'DONE' &&
    task.review?.status === 'ACCEPTED' &&
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

function unblockCompletedDependents(change, state) {
  const unblocked = [];
  for (const candidate of Object.values(change.tasks)) {
    if (candidate.state !== 'WAITING_DEPENDENCY') continue;
    const dependencies = candidate.depends_on.map((id) => change.tasks[id]);
    if (!dependencies.every((dependency) => dependency?.state === 'DONE')) continue;
    if (
      implementerRoles.has(candidate.role) &&
      ['FEATURE', 'BUGFIX'].includes(change.kind) &&
      !dependencies.some((dependency) => hasReviewedRedEvidence(change, dependency, state))
    )
      continue;
    candidate.state = 'READY';
    unblocked.push(candidate.id);
  }
  return unblocked;
}

function reblockUnstartedDependents(change, dependencyId) {
  const blocked = [];
  for (const candidate of Object.values(change.tasks)) {
    if (
      candidate.state === 'READY' &&
      !candidate.result &&
      candidate.depends_on.includes(dependencyId)
    ) {
      candidate.state = 'WAITING_DEPENDENCY';
      blocked.push(candidate.id);
    }
  }
  return blocked;
}

function validatePullRequest(pullRequest, change, baseBranch, configuration) {
  let trustedHtmlUrl = false;
  try {
    trustedHtmlUrl = new URL(pullRequest?.html_url).protocol === 'https:';
  } catch {
    // A malformed URL is rejected by the identity check below.
  }
  const valid =
    pullRequest &&
    Number.isInteger(pullRequest.number) &&
    pullRequest.number > 0 &&
    trustedHtmlUrl &&
    pullRequest.head?.ref === change.branch &&
    typeof pullRequest.head?.sha === 'string' &&
    /^[a-f0-9]{40,64}$/i.test(pullRequest.head.sha) &&
    pullRequest.head?.repo?.full_name === `${configuration.owner}/${configuration.name}` &&
    pullRequest.base?.ref === baseBranch &&
    pullRequest.base?.repo?.full_name === `${configuration.owner}/${configuration.name}` &&
    typeof pullRequest.user?.login === 'string' &&
    ['open', 'closed'].includes(pullRequest.state);
  if (!valid)
    throw new WorkflowError(
      'PR_IDENTITY_MISMATCH',
      'The GitHub pull request does not match the registered change branch and integration branch.',
      {
        expected_branch: change.branch,
        expected_base: baseBranch,
        actual_branch: pullRequest?.head?.ref,
        actual_base: pullRequest?.base?.ref,
      },
    );
  return summarizePullRequest(pullRequest);
}

function requirePublishedDecisionSubject(projectRoot, headSha, artifactRef, subjectHash) {
  const committed = git(projectRoot, ['show', `${headSha}:${artifactRef.path}`], {
    allowFailure: true,
  });
  requireValue(
    committed.status === 0,
    'DECISION_SUBJECT_NOT_PUBLISHED',
    'The approved artifact must be present in the current pull request head before human review.',
  );
  let parsed;
  try {
    parsed = JSON.parse(committed.stdout);
  } catch {
    throw new WorkflowError(
      'DECISION_SUBJECT_NOT_PUBLISHED',
      'The artifact at the current pull request head is not valid JSON.',
    );
  }
  requireValue(
    hash(parsed) === subjectHash,
    'DECISION_SUBJECT_NOT_PUBLISHED',
    'The artifact in the pull request differs from the content submitted for human approval.',
  );
}

async function listMatchingPullRequests(context, configuration, change, baseBranch) {
  const head = encodeURIComponent(`${configuration.owner}:${change.branch}`);
  const base = encodeURIComponent(baseBranch);
  const { data, headers } = await githubRequest(
    context,
    configuration,
    repositoryEndpoint(configuration, `/pulls?state=all&head=${head}&base=${base}&per_page=100`),
  );
  requireValue(
    Array.isArray(data),
    'GITHUB_RESPONSE_INVALID',
    'GitHub returned an invalid pull request list.',
  );
  requireValue(
    !headers.get('link')?.includes('rel="next"'),
    'GITHUB_LIST_INCOMPLETE',
    'The matching pull request list is paginated; refusing to create or adopt from an incomplete result.',
  );
  return data.filter((item) => item.head?.ref === change.branch && item.base?.ref === baseBranch);
}

export function registerGithubOperations(handlers) {
  handlers['pr.ensure'] = async (input, context) => {
    const { projectRoot } = context;
    const { profile, state } = await load(projectRoot);
    const configuration = githubConfiguration(profile.github, context.env);
    const change = findChange(state, input.change_id);
    requireValue(
      git(projectRoot, ['branch', '--show-current']) === change.branch,
      'WRONG_BRANCH',
      'Switch to the registered change branch before ensuring its pull request.',
    );
    requireValue(
      git(projectRoot, ['status', '--porcelain']) === '',
      'DIRTY_WORKTREE',
      'Commit or isolate uncommitted work before creating or updating a pull request.',
    );
    const headSha = git(projectRoot, ['rev-parse', 'HEAD']);
    requireValue(
      git(projectRoot, ['rev-parse', profile.repository.base_branch]) === change.base_sha,
      'STALE_REVISION',
      'The integration branch moved after change start; update the change and revalidate it before opening a pull request.',
    );
    const remoteRefs = git(
      projectRoot,
      [
        'ls-remote',
        '--heads',
        profile.repository.remote,
        `refs/heads/${change.branch}`,
        `refs/heads/${profile.repository.base_branch}`,
      ],
      { allowFailure: true },
    );
    requireValue(
      remoteRefs.status === 0,
      'REMOTE_UNAVAILABLE',
      'Cannot verify the pushed branch and integration base at the configured Git remote.',
    );
    const refs = new Map(
      remoteRefs.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split(/\s+/);
          return [ref, sha];
        }),
    );
    requireValue(
      refs.get(`refs/heads/${profile.repository.base_branch}`) === change.base_sha,
      'STALE_REVISION',
      'The remote integration branch moved after change start; update the change and revalidate it before opening a pull request.',
    );
    requireValue(
      Object.values(state.receipts).some(
        (receipt) =>
          receipt.change_id === change.id &&
          receipt.pushed &&
          !receipt.pending_push &&
          receipt.commit_sha === headSha,
      ),
      'CHECKPOINT_REQUIRED',
      'Push a completed task checkpoint on the current branch before ensuring a draft pull request.',
    );
    requireValue(
      refs.get(`refs/heads/${change.branch}`) === headSha,
      'PUSH_PENDING',
      'The current change branch head is not present on the configured Git remote.',
    );
    const matches = await listMatchingPullRequests(
      context,
      configuration,
      change,
      profile.repository.base_branch,
    );
    requireValue(
      matches.length <= 1,
      'PR_AMBIGUOUS',
      'More than one pull request matches this change branch. Resolve duplicates manually.',
    );
    if (matches.length === 1 && matches[0].state !== 'open')
      throw new WorkflowError(
        'PR_CLOSED',
        'A pull request for this change branch is already closed; it will not be recreated automatically.',
      );
    if (change.pull_request) {
      requireValue(
        !matches.length || matches[0].number === change.pull_request.number,
        'PR_CONFLICT',
        'A different open pull request now targets this change branch.',
      );
      const refreshed = await handlers['pr.refresh']({ change_id: change.id }, context);
      requireValue(
        refreshed.pull_request.state === 'open',
        'PR_CLOSED',
        'The registered pull request is closed; it will not be recreated automatically.',
      );
      requireValue(
        refreshed.pull_request.head_sha === headSha,
        'STALE_REVISION',
        'The registered pull request head differs from the current local change checkpoint.',
      );
      return { ...refreshed, created: false };
    }
    let pullRequest;
    let created = false;
    if (matches.length === 1) {
      pullRequest = matches[0];
    } else {
      const title = `[${change.id}] ${change.description}`.slice(0, 250);
      const body = [
        `## Change ${change.id}`,
        '',
        change.description,
        '',
        '<!-- codex-sdlc-workflow:change-id=' + change.id + ' -->',
      ].join('\n');
      const result = await githubRequest(
        context,
        configuration,
        repositoryEndpoint(configuration, '/pulls'),
        {
          method: 'POST',
          body: {
            title,
            head: change.branch,
            base: profile.repository.base_branch,
            body,
            draft: true,
          },
        },
      );
      pullRequest = result.data;
      created = true;
    }
    const summary = validatePullRequest(
      pullRequest,
      change,
      profile.repository.base_branch,
      configuration,
    );
    requireValue(
      summary.state === 'open',
      'PR_CLOSED',
      'Only an open pull request can be registered.',
    );
    requireValue(
      summary.head_sha === headSha,
      'STALE_REVISION',
      'The pull request head does not match the current pushed change checkpoint.',
    );
    if (created)
      requireValue(
        summary.draft,
        'PR_NOT_DRAFT',
        'A newly created pull request must be in draft state.',
      );
    change.pull_request = summary;
    await save(projectRoot, state, 'pr.ensure', {
      change_id: change.id,
      pull_request_number: summary.number,
      head_sha: summary.head_sha,
    });
    return { pull_request: summary, created };
  };

  handlers['pr.refresh'] = async (input, { projectRoot, ...context }) => {
    const { profile, state } = await load(projectRoot);
    const configuration = githubConfiguration(profile.github, context.env);
    const change = findChange(state, input.change_id);
    requireValue(
      change.pull_request?.number,
      'PR_NOT_FOUND',
      'Ensure or record a pull request before refreshing it.',
    );
    const { data } = await githubRequest(
      { ...context, projectRoot },
      configuration,
      repositoryEndpoint(configuration, `/pulls/${change.pull_request.number}`),
    );
    const summary = validatePullRequest(
      data,
      change,
      profile.repository.base_branch,
      configuration,
    );
    change.pull_request = summary;
    await save(projectRoot, state, 'pr.refresh', {
      change_id: change.id,
      pull_request_number: summary.number,
      head_sha: summary.head_sha,
      state: summary.state,
    });
    return { pull_request: summary };
  };

  handlers['ci.inspect'] = async (input, context) => {
    const { projectRoot } = context;
    const refreshed = await handlers['pr.refresh'](input, context);
    const { profile, state } = await load(projectRoot);
    const configuration = githubConfiguration(profile.github, context.env);
    const change = findChange(state, input.change_id);
    const headSha = refreshed.pull_request.head_sha;
    const required = profile.github.required_checks;
    requireValue(
      Array.isArray(required) &&
        required.length > 0 &&
        new Set(required).size === required.length &&
        required.every((name) => typeof name === 'string' && name.trim()),
      'GITHUB_CONFIG_INVALID',
      'Configure unique required_checks names before using CI as merge evidence.',
    );
    const checksResult = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, `/commits/${headSha}/check-runs?per_page=100`),
    );
    const statusResult = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, `/commits/${headSha}/status`),
    );
    requireValue(
      !checksResult.headers.get('link')?.includes('rel="next"') &&
        !statusResult.headers.get('link')?.includes('rel="next"'),
      'GITHUB_LIST_INCOMPLETE',
      'GitHub returned paginated check results; merge verification requires a complete result set.',
    );
    requireValue(
      Number.isInteger(checksResult.data?.total_count) &&
        checksResult.data.total_count === checksResult.data.check_runs?.length,
      'GITHUB_LIST_INCOMPLETE',
      'GitHub did not return every check run for the pull request head.',
    );
    requireValue(
      Array.isArray(checksResult.data?.check_runs) &&
        Array.isArray(statusResult.data?.statuses) &&
        statusResult.data.sha === headSha,
      'GITHUB_RESPONSE_INVALID',
      'GitHub returned malformed or mismatched check results.',
    );
    const checkRecords = [];
    for (const name of required) {
      const runs = checksResult.data.check_runs.filter((entry) => entry.name === name);
      const statuses = statusResult.data.statuses.filter((entry) => entry.context === name);
      if (runs.some((entry) => entry.head_sha !== headSha))
        throw new WorkflowError(
          'STALE_REVISION',
          `Required check ${name} belongs to another source revision.`,
        );
      const evidence = [
        ...runs.map((entry) => `check_run:${entry.id}`),
        ...statuses.map((entry) => `status:${entry.id ?? entry.context}`),
      ];
      const states = [
        ...runs.map((entry) => (entry.status === 'completed' ? entry.conclusion : entry.status)),
        ...statuses.map((entry) => entry.state),
      ];
      const result =
        states.length === 0
          ? 'MISSING'
          : states.some((value) =>
                ['failure', 'error', 'cancelled', 'timed_out', 'action_required'].includes(value),
              )
            ? 'FAILURE'
            : states.every((value) => value === 'success')
              ? 'SUCCESS'
              : states.some((value) =>
                    ['queued', 'in_progress', 'pending', 'requested', 'waiting'].includes(value),
                  )
                ? 'PENDING'
                : 'UNKNOWN';
      checkRecords.push({ name, state: result, evidence });
    }
    const inspection = {
      head_sha: headSha,
      checks: checkRecords,
      all_passed:
        checkRecords.length === required.length &&
        checkRecords.every((item) => item.state === 'SUCCESS'),
      inspected_at: new Date().toISOString(),
    };
    change.ci_checks = inspection;
    await save(projectRoot, state, 'ci.inspect', {
      change_id: change.id,
      head_sha: headSha,
      all_passed: inspection.all_passed,
    });
    return inspection;
  };

  handlers['evaluation.ingest'] = async (input, context) => {
    requireValue(
      input &&
        Object.keys(input).every((key) => ['change_id', 'run_id'].includes(key)) &&
        typeof input.change_id === 'string' &&
        Number.isInteger(input.run_id) &&
        input.run_id > 0,
      'VALIDATION_FAILED',
      'Evaluation import requires a workflow change ID and numeric GitHub Actions run ID.',
    );
    const { projectRoot } = context;
    const { profile, state: initialState } = await load(projectRoot);
    let state = initialState;
    const configuration = githubConfiguration(profile.github, context.env);
    let change = findChange(state, input.change_id);
    requireValue(
      change.kind === 'WORKFLOW_CHANGE' && change.stage === 'EVALUATION',
      'GATE_BLOCKED',
      'Evaluation reports can only be imported for a workflow change at its EVALUATION stage.',
    );
    const { pull_request: pull } = await handlers['pr.refresh']({ change_id: change.id }, context);
    state = (await load(projectRoot)).state;
    change = findChange(state, input.change_id);
    change.pull_request = pull;
    requireValue(
      pull.state === 'open' && /^[a-f0-9]{40}$/.test(pull.head_sha ?? ''),
      'PR_CLOSED',
      'A current open pull request is required to identify the exact workflow candidate.',
    );
    const { data: run } = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, `/actions/runs/${input.run_id}`),
    );
    const workflowPath = String(run?.path ?? '').split('@')[0];
    requireValue(
      run?.id === input.run_id &&
        run.event === 'workflow_dispatch' &&
        run.status === 'completed' &&
        run.conclusion === 'success' &&
        run.head_branch === profile.repository.base_branch &&
        workflowPath === '.github/workflows/workflow-evaluate.yml' &&
        Number.isInteger(run.run_attempt) &&
        /^[a-f0-9]{40}$/.test(run.head_sha ?? ''),
      'EVALUATION_RUN_UNTRUSTED',
      'The selected run is not a successful manual evaluation from the configured integration branch.',
    );
    const { data: base } = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(
        configuration,
        `/branches/${encodeURIComponent(profile.repository.base_branch)}`,
      ),
    );
    requireValue(
      base?.commit?.sha === run.head_sha,
      'EVALUATION_RUN_STALE',
      'The evaluator run predates the current integration branch policy; rerun it from the latest integration branch.',
    );
    const artifactName = `workflow-evaluation-${input.run_id}-${run.run_attempt}`;
    const { data: artifacts, headers } = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, `/actions/runs/${input.run_id}/artifacts?per_page=100`),
    );
    requireValue(
      Array.isArray(artifacts?.artifacts) &&
        !headers.get('link')?.includes('rel="next"') &&
        artifacts.total_count === artifacts.artifacts.length,
      'GITHUB_LIST_INCOMPLETE',
      'GitHub did not return the complete evaluation artifact list.',
    );
    const matching = artifacts.artifacts.filter((artifact) => artifact.name === artifactName);
    requireValue(
      matching.length === 1 &&
        Number.isInteger(matching[0].id) &&
        !matching[0].expired &&
        matching[0].size_in_bytes > 0 &&
        matching[0].size_in_bytes <= 2 * 1024 * 1024,
      'EVALUATION_ARTIFACT_MISSING',
      'The selected run must retain exactly one small, unexpired report artifact for this run attempt.',
    );
    const archive = await githubDownload(
      context,
      configuration,
      repositoryEndpoint(configuration, `/actions/artifacts/${matching[0].id}/zip`),
      2 * 1024 * 1024,
    );
    const report = readEvaluationReportArchive(archive);
    const candidateManifestText = git(
      projectRoot,
      ['show', `${pull.head_sha}:workflow/bundle/manifest.json`],
      { allowFailure: true },
    );
    requireValue(
      candidateManifestText.status === 0 && !candidateManifestText.error,
      'EVALUATION_CANDIDATE_INVALID',
      'The current pull request does not contain a readable workflow bundle manifest.',
    );
    let candidateVersion;
    try {
      candidateVersion = JSON.parse(candidateManifestText.stdout).bundle_version;
    } catch {
      throw new WorkflowError(
        'EVALUATION_CANDIDATE_INVALID',
        'The current pull request bundle manifest is invalid.',
      );
    }
    const reportValidation = await validateArtifact(report);
    requireValue(
      reportValidation.valid &&
        report.id === `EVAL-${input.run_id}-${run.run_attempt}` &&
        report.change_id === change.id &&
        report.status === 'recorded' &&
        report.data?.baseline_version === 'pinned-workflow-evaluator' &&
        report.data?.candidate_version === candidateVersion &&
        report.data?.correctness?.checks_result === 'success' &&
        report.data?.interventions?.evaluator_sha === run.head_sha &&
        report.data?.interventions?.evaluator_run_attempt === run.run_attempt &&
        report.data?.interventions?.candidate_sha === pull.head_sha &&
        Array.isArray(report.data?.limitations) &&
        report.data.limitations.some((item) =>
          /does not authorize activation or migration/i.test(item),
        ),
      'EVALUATION_REPORT_MISMATCH',
      'The trusted report does not match the current change, candidate SHA, evaluator SHA, run attempt, or successful checks.',
    );
    const relative = `.workflow-runtime/evaluations/${change.id}/${report.id}.json`;
    const reportPath = await safePath(projectRoot, relative, { protectedAccess: true });
    const canonical = `${JSON.stringify(report, null, 2)}\n`;
    try {
      const existing = await fs.readFile(reportPath, 'utf8');
      requireValue(
        existing === canonical,
        'EVALUATION_REPORT_CONFLICT',
        'The same evaluator run attempt already produced different report content.',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicWrite(reportPath, canonical);
    }
    const evidence = {
      run_id: input.run_id,
      run_attempt: run.run_attempt,
      artifact_id: matching[0].id,
      report_id: report.id,
      report_path: relative,
      report_hash: hash(report),
      evaluator_sha: run.head_sha,
      candidate_sha: pull.head_sha,
      candidate_version: candidateVersion,
      recorded_at: new Date().toISOString(),
    };
    if (
      change.evaluation &&
      change.evaluation.run_id === evidence.run_id &&
      change.evaluation.run_attempt === evidence.run_attempt &&
      change.evaluation.report_hash === evidence.report_hash
    )
      return { evaluation: change.evaluation, already_ingested: true };
    change.evaluation = evidence;
    await save(projectRoot, state, 'evaluation.ingest', {
      change_id: change.id,
      run_id: input.run_id,
      run_attempt: run.run_attempt,
      candidate_sha: pull.head_sha,
      report_hash: evidence.report_hash,
    });
    return { evaluation: evidence, already_ingested: false };
  };

  handlers['decision.ingest'] = async (input, { projectRoot, ...context }) => {
    if (
      input &&
      ['actor', 'approved', 'decision', 'kind', 'source', 'status'].some((key) =>
        Object.hasOwn(input, key),
      )
    )
      throw new WorkflowError(
        'UNTRUSTED_DECISION',
        'Caller-supplied actor, source, or decision claims are not human evidence.',
      );
    requireValue(
      input &&
        Object.keys(input).every((key) =>
          ['change_id', 'artifact_id', 'issue_number'].includes(key),
        ) &&
        typeof input.change_id === 'string' &&
        typeof input.artifact_id === 'string' &&
        (input.issue_number === undefined ||
          (Number.isInteger(input.issue_number) && input.issue_number > 0)),
      'VALIDATION_FAILED',
      'A decision can only be ingested by change, registered artifact ID, and an optional GitHub Issue number for no-file bugfix evidence; caller-supplied actor or decision claims are not accepted.',
    );
    const { profile, state } = await load(projectRoot);
    const configuration = githubConfiguration(profile.github, context.env);
    const change = findChange(state, input.change_id);
    const artifactRef = change.artifacts.find((entry) => entry.id === input.artifact_id);
    requireValue(
      artifactRef,
      'ARTIFACT_NOT_FOUND',
      'The decision subject is not registered to this change.',
    );
    const artifact = await readJson(
      await safePath(projectRoot, artifactRef.path, {
        protectedAccess: artifactRef.path.startsWith('.workflow-runtime/'),
      }),
    );
    const subjectHash = hash(artifact);
    requireValue(
      subjectHash === artifactRef.content_hash,
      'STALE_ARTIFACT',
      'The decision subject changed after registration; refresh and review its current content.',
    );
    const automationLogins = profile.github.automation_logins ?? [];
    requireValue(
      Array.isArray(automationLogins) &&
        automationLogins.every(
          (login) => typeof login === 'string' && /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/.test(login),
        ),
      'GITHUB_CONFIG_INVALID',
      'automation_logins must be a list of GitHub logins.',
    );
    const marker = `<!-- codex-sdlc-decision: change=${change.id} artifact=${artifactRef.id} content=${subjectHash} -->`;
    if (input.issue_number !== undefined) {
      requireValue(
        change.kind === 'BUGFIX' &&
          artifact.type === 'defect-report' &&
          artifact.data.already_fixed_deployment_id !== undefined &&
          artifactRef.path.startsWith('.workflow-runtime/no-file-evidence/'),
        'DECISION_SOURCE_INVALID',
        'GitHub Issue decisions are reserved for protected no-file BUGFIX evidence already present in a verified deployment.',
      );
      requireValue(
        change.intent_issue_number === undefined ||
          change.intent_issue_number === input.issue_number,
        'DECISION_SOURCE_CONFLICT',
        'This no-file defect report is already bound to another GitHub Issue.',
      );
      const issuePath = repositoryEndpoint(configuration, `/issues/${input.issue_number}`);
      const { data: issue } = await githubRequest(
        { ...context, projectRoot },
        configuration,
        issuePath,
      );
      requireValue(
        issue?.number === input.issue_number &&
          issue.state === 'open' &&
          !issue.pull_request &&
          typeof issue.body === 'string' &&
          issue.body.includes(`<!-- codex-sdlc-change: ${change.id} -->`),
        'DECISION_SOURCE_INVALID',
        'Use an open GitHub Issue linked to this change with the exact change marker in its body.',
      );
      if (change.intent_issue_number === undefined) {
        change.intent_issue_number = input.issue_number;
        await save(projectRoot, state, 'decision.issue.bind', {
          change_id: change.id,
          artifact_id: artifactRef.id,
          issue_number: input.issue_number,
          subject_hash: subjectHash,
        });
      }
      const { data: comments, headers } = await githubRequest(
        { ...context, projectRoot },
        configuration,
        repositoryEndpoint(configuration, `/issues/${input.issue_number}/comments?per_page=100`),
      );
      requireValue(
        Array.isArray(comments) && !headers.get('link')?.includes('rel="next"'),
        'GITHUB_LIST_INCOMPLETE',
        'GitHub did not return the complete Issue comment history; refusing to infer a business decision.',
      );
      const permitted = new Set(reviewers.map((login) => login.toLowerCase()));
      const automation = new Set(automationLogins.map((login) => login.toLowerCase()));
      const latestByReviewer = new Map();
      for (const comment of comments) {
        const login = comment.user?.login;
        const created = Date.parse(comment.created_at);
        const body = comment.body;
        if (
          typeof login !== 'string' ||
          !Number.isFinite(created) ||
          !Number.isInteger(comment.id) ||
          typeof body !== 'string' ||
          !body.includes(marker)
        )
          continue;
        const decision = body.trimStart().startsWith('APPROVED ')
          ? 'APPROVED'
          : body.trimStart().startsWith('CHANGES_REQUESTED ')
            ? 'CHANGES_REQUESTED'
            : null;
        if (!decision) continue;
        const key = login.toLowerCase();
        const existing = latestByReviewer.get(key);
        if (
          !existing ||
          created > existing.created ||
          (created === existing.created && comment.id > existing.comment.id)
        )
          latestByReviewer.set(key, { comment, created, decision });
      }
      const latestDecision = [...latestByReviewer.entries()]
        .filter(
          ([login, item]) =>
            permitted.has(login) &&
            login !== issue.user?.login?.toLowerCase() &&
            !automation.has(login) &&
            item.comment.user?.type === 'User',
        )
        .sort(
          (left, right) =>
            right[1].created - left[1].created || right[1].comment.id - left[1].comment.id,
        )[0];
      if (!latestDecision) {
        const previous = change.approvals?.find(
          (entry) => entry.artifact_id === artifactRef.id && entry.provider === 'github_issue',
        );
        if (previous && previous.status !== 'SUPERSEDED') {
          change.approvals = change.approvals.map((entry) =>
            entry.artifact_id === artifactRef.id
              ? { ...entry, status: 'SUPERSEDED', superseded_at: new Date().toISOString() }
              : entry,
          );
          await save(projectRoot, state, 'decision.issue.supersede', {
            change_id: change.id,
            artifact_id: artifactRef.id,
            issue_number: input.issue_number,
            subject_hash: subjectHash,
          });
        }
        return {
          status: 'AWAITING_HUMAN',
          artifact_id: artifactRef.id,
          subject_hash: subjectHash,
          issue_number: input.issue_number,
          issue_url: issue.html_url,
          required_marker: marker,
          required_comments: {
            approve: `APPROVED ${marker}`,
            request_changes: `CHANGES_REQUESTED ${marker}`,
          },
          message:
            'An authenticated human must comment on the linked Issue with one of the exact decision prefixes and this marker. This path is only for no-file BUGFIX evidence.',
        };
      }
      const [login, { comment, decision: action }] = latestDecision;
      const status = action === 'APPROVED' ? 'APPROVED' : 'REJECTED';
      const decision = {
        id: `D-${artifactRef.id}`,
        artifact_id: artifactRef.id,
        subject_hash: subjectHash,
        status,
        provider: 'github_issue',
        issue_number: input.issue_number,
        issue_comment_id: comment.id,
        reviewer: login,
        decided_at: comment.created_at,
        marker,
      };
      const previous = change.approvals?.find(
        (existing) =>
          existing.artifact_id === artifactRef.id && existing.provider === 'github_issue',
      );
      if (
        previous &&
        previous.status === decision.status &&
        previous.subject_hash === decision.subject_hash &&
        previous.issue_number === decision.issue_number &&
        previous.issue_comment_id === decision.issue_comment_id
      )
        return { status, decision: previous, already_ingested: true };
      change.approvals = (change.approvals ?? []).filter(
        (existing) => existing.artifact_id !== artifactRef.id,
      );
      change.approvals.push(decision);
      await save(projectRoot, state, 'decision.ingest.issue', {
        change_id: change.id,
        artifact_id: artifactRef.id,
        decision: status,
        reviewer: login,
        issue_number: input.issue_number,
        issue_comment_id: comment.id,
        subject_hash: subjectHash,
      });
      return { status, decision };
    }
    const { pull_request: pull } = await handlers['pr.refresh'](
      { change_id: change.id },
      { ...context, projectRoot },
    );
    requireValue(
      pull.state === 'open',
      'PR_CLOSED',
      'A business decision requires an open pull request with a current reviewable head.',
    );
    requirePublishedDecisionSubject(projectRoot, pull.head_sha, artifactRef, subjectHash);
    const { data, headers } = await githubRequest(
      { ...context, projectRoot },
      configuration,
      repositoryEndpoint(configuration, `/pulls/${pull.number}/reviews?per_page=100`),
    );
    requireValue(
      Array.isArray(data) && !headers.get('link')?.includes('rel="next"'),
      'GITHUB_LIST_INCOMPLETE',
      'GitHub did not return the complete review history; refusing to infer a business decision.',
    );
    const automation = new Set(automationLogins.map((login) => login.toLowerCase()));
    const latestByReviewer = new Map();
    for (const review of data) {
      const login = review.user?.login;
      const submitted = Date.parse(review.submitted_at);
      if (typeof login !== 'string' || !Number.isFinite(submitted) || !Number.isInteger(review.id))
        continue;
      const key = login.toLowerCase();
      const existing = latestByReviewer.get(key);
      if (
        !existing ||
        submitted > existing.submitted ||
        (submitted === existing.submitted && review.id > existing.review.id)
      )
        latestByReviewer.set(key, { review, submitted });
    }
    const latestDecision = [...latestByReviewer.entries()]
      .filter(([login, item]) => {
        const review = item.review;
        return (
          !automation.has(login) &&
          review.user?.type === 'User' &&
          review.commit_id === pull.head_sha &&
          typeof review.body === 'string' &&
          review.body.includes(marker) &&
          ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state)
        );
      })
      .sort(
        (left, right) =>
          right[1].submitted - left[1].submitted || right[1].review.id - left[1].review.id,
      )[0];
    if (!latestDecision) {
      let previousDecisionInvalidated = false;
      const previous = change.approvals?.find((entry) => entry.artifact_id === artifactRef.id);
      if (previous && previous.status !== 'SUPERSEDED') {
        change.approvals = change.approvals.map((entry) =>
          entry.artifact_id === artifactRef.id
            ? {
                ...entry,
                status: 'SUPERSEDED',
                superseded_at: new Date().toISOString(),
                superseded_head_sha: pull.head_sha,
              }
            : entry,
        );
        await save(projectRoot, state, 'decision.supersede', {
          change_id: change.id,
          artifact_id: artifactRef.id,
          subject_hash: subjectHash,
          head_sha: pull.head_sha,
        });
        previousDecisionInvalidated = true;
      }
      return {
        status: 'AWAITING_HUMAN',
        artifact_id: artifactRef.id,
        subject_hash: subjectHash,
        head_sha: pull.head_sha,
        pull_request_url: pull.url,
        required_marker: marker,
        message:
          'An authenticated human must submit a GitHub pull request review containing this exact marker. Approve accepts the artifact; request changes rejects it.',
        previous_decision_invalidated: previousDecisionInvalidated,
      };
    }
    const [login, { review }] = latestDecision;
    const status = review.state === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    const decision = {
      id: `D-${artifactRef.id}`,
      artifact_id: artifactRef.id,
      subject_hash: subjectHash,
      status,
      provider: 'github',
      pull_request_number: pull.number,
      head_sha: pull.head_sha,
      reviewer: login,
      review_id: review.id,
      decided_at: review.submitted_at,
      marker,
    };
    const previous = change.approvals?.find((existing) => existing.artifact_id === artifactRef.id);
    if (
      previous &&
      previous.status === decision.status &&
      previous.subject_hash === decision.subject_hash &&
      previous.head_sha === decision.head_sha &&
      previous.review_id === decision.review_id
    )
      return { status, decision: previous, already_ingested: true };
    change.approvals = (change.approvals ?? []).filter(
      (existing) => existing.artifact_id !== artifactRef.id,
    );
    change.approvals.push(decision);
    await save(projectRoot, state, 'decision.ingest', {
      change_id: change.id,
      artifact_id: artifactRef.id,
      decision: status,
      reviewer: login,
      review_id: review.id,
      head_sha: pull.head_sha,
      subject_hash: subjectHash,
    });
    return { status, decision };
  };

  handlers['ci.await'] = async (input, context) => {
    const timeoutMs = input.timeout_ms ?? 600_000;
    const pollIntervalMs = input.poll_interval_ms ?? 5_000;
    requireValue(
      Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900_000,
      'VALIDATION_FAILED',
      'CI timeout_ms must be between 1 and 900000 milliseconds.',
    );
    requireValue(
      Number.isInteger(pollIntervalMs) && pollIntervalMs > 0 && pollIntervalMs <= 30_000,
      'VALIDATION_FAILED',
      'CI poll_interval_ms must be between 1 and 30000 milliseconds.',
    );
    const started = performance.now();
    let attempts = 0;
    while (true) {
      attempts += 1;
      const inspection = await handlers['ci.inspect'](input, context);
      if (inspection.all_passed)
        return {
          state: 'SUCCESS',
          attempts,
          head_sha: inspection.head_sha,
          inspection,
        };
      const failedChecks = inspection.checks.filter((check) => check.state === 'FAILURE');
      if (failedChecks.length)
        throw new WorkflowError('CI_FAILED', 'A required pull request check failed.', {
          attempts,
          head_sha: inspection.head_sha,
          failed_checks: failedChecks,
        });
      const remaining = timeoutMs - (performance.now() - started);
      if (remaining <= 0)
        throw new WorkflowError(
          'CI_TIMEOUT',
          'Required pull request checks did not pass before the timeout.',
          {
            attempts,
            head_sha: inspection.head_sha,
            checks: inspection.checks,
          },
        );
      const sleep =
        context.sleepImpl ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  };

  handlers['pr.mark_ready'] = async (input, { projectRoot, ...context }) => {
    const { profile } = await load(projectRoot);
    let { state } = await load(projectRoot);
    let change = findChange(state, input.change_id);
    const tasks = Object.values(change.tasks);
    requireValue(
      tasks.length > 0 &&
        tasks.every((task) => task.state === 'DONE' && task.review?.status === 'ACCEPTED'),
      'TASKS_INCOMPLETE',
      'Every planned task must be complete with an accepted human review before marking the pull request ready.',
    );
    for (const task of tasks) {
      const review = await handlers['review.resolve'](
        { change_id: change.id, task_id: task.id },
        { ...context, projectRoot },
      );
      requireValue(
        review.task.state === 'DONE' && review.review.status === 'ACCEPTED',
        'REVIEW_REQUIRED',
        'A task review changed; resolve the latest human decision before marking the pull request ready.',
      );
    }
    ({ state } = await load(projectRoot));
    change = findChange(state, input.change_id);
    const refreshed = await handlers['pr.refresh'](
      { change_id: change.id },
      { ...context, projectRoot },
    );
    requireValue(
      refreshed.pull_request.state === 'open',
      'PR_CLOSED',
      'Only an open pull request can become ready for review.',
    );
    const ci = await handlers['ci.inspect']({ change_id: change.id }, { ...context, projectRoot });
    requireValue(
      ci.all_passed,
      'CI_NOT_PASSING',
      'Every required check must pass on the current pull request head before it can become ready.',
    );
    ({ state } = await load(projectRoot));
    change = findChange(state, input.change_id);
    let summary = change.pull_request;
    requireValue(
      summary?.head_sha === ci.head_sha,
      'STALE_REVISION',
      'The pull request changed while required checks were being inspected.',
    );
    let alreadyReady = !summary.draft;
    if (!alreadyReady) {
      const { data } = await githubRequest(
        { ...context, projectRoot },
        githubConfiguration(profile.github, context.env),
        repositoryEndpoint(
          githubConfiguration(profile.github, context.env),
          `/pulls/${summary.number}/ready_for_review`,
        ),
        { method: 'POST', body: {} },
      );
      summary = validatePullRequest(
        data,
        change,
        profile.repository.base_branch,
        githubConfiguration(profile.github, context.env),
      );
      requireValue(
        summary.state === 'open' && !summary.draft && summary.head_sha === ci.head_sha,
        'STALE_REVISION',
        'The pull request changed while it was being marked ready; refresh and revalidate it.',
      );
      change.pull_request = summary;
      await save(projectRoot, state, 'pr.mark_ready', {
        change_id: change.id,
        pull_request_number: summary.number,
        head_sha: summary.head_sha,
      });
    }
    return { pull_request: summary, head_sha: ci.head_sha, ci, already_ready: alreadyReady };
  };

  handlers['review.resolve'] = async (input, { projectRoot, ...context }) => {
    let { profile, state } = await load(projectRoot);
    const configuration = githubConfiguration(profile.github, context.env);
    let change = findChange(state, input.change_id);
    let task = change.tasks[input.task_id];
    if (task) {
      task.review_budget ??= 3;
      task.review_attempts ??= task.result?.review_attempt ?? 1;
    }
    requireValue(
      task && ['WAITING_REVIEW', 'CHANGES_REQUESTED'].includes(task.result?.status),
      'TASK_NOT_READY',
      'A task with recorded verification and checkpoint evidence is required for review resolution.',
    );
    requireValue(
      (['WAITING_REVIEW', 'CHANGES_REQUESTED'].includes(task.state) ||
        (task.state === 'DONE' && task.review?.status === 'ACCEPTED')) &&
        typeof task.result.review_marker === 'string',
      'TASK_NOT_READY',
      'The task is not awaiting review or has no bound review marker.',
    );
    const automationLogins = profile.github.automation_logins ?? [];
    requireValue(
      Array.isArray(automationLogins) &&
        automationLogins.every(
          (login) => typeof login === 'string' && /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/.test(login),
        ),
      'GITHUB_CONFIG_INVALID',
      'automation_logins must be a list of GitHub logins.',
    );
    const refreshed = await handlers['pr.refresh'](
      { change_id: change.id },
      { ...context, projectRoot },
    );
    const pull = refreshed.pull_request;
    const branchHead = git(projectRoot, ['rev-parse', `refs/heads/${change.branch}`], {
      allowFailure: true,
    });
    requireValue(
      pull.state === 'open' &&
        branchHead.status === 0 &&
        branchHead.stdout.trim() === pull.head_sha &&
        git(
          projectRoot,
          ['merge-base', '--is-ancestor', task.result.checkpoint_sha, pull.head_sha],
          { allowFailure: true },
        ).status === 0,
      'STALE_REVISION',
      'The task checkpoint must remain in the current open pull request branch before its review can be resolved.',
    );
    ({ state } = await load(projectRoot));
    change = findChange(state, input.change_id);
    task = change.tasks[input.task_id];
    requireValue(
      task && ['WAITING_REVIEW', 'CHANGES_REQUESTED'].includes(task.result?.status),
      'TASK_NOT_READY',
      'The task review state changed while refreshing the pull request.',
    );
    const { data, headers } = await githubRequest(
      { ...context, projectRoot },
      configuration,
      repositoryEndpoint(configuration, `/pulls/${pull.number}/reviews?per_page=100`),
    );
    requireValue(
      Array.isArray(data) && !headers.get('link')?.includes('rel="next"'),
      'GITHUB_LIST_INCOMPLETE',
      'GitHub did not return the complete review history; refusing to infer human approval.',
    );
    const automation = new Set(automationLogins.map((login) => login.toLowerCase()));
    const latestByReviewer = new Map();
    for (const review of data) {
      if (
        !/^[a-f0-9]{40,64}$/i.test(review.commit_id ?? '') ||
        typeof review.body !== 'string' ||
        !review.body.includes(task.result.review_marker) ||
        git(
          projectRoot,
          ['merge-base', '--is-ancestor', task.result.checkpoint_sha, review.commit_id],
          { allowFailure: true },
        ).status !== 0 ||
        git(projectRoot, ['merge-base', '--is-ancestor', review.commit_id, pull.head_sha], {
          allowFailure: true,
        }).status !== 0
      )
        continue;
      const login = review.user?.login;
      const submitted = Date.parse(review.submitted_at);
      if (typeof login !== 'string' || !Number.isFinite(submitted) || !Number.isInteger(review.id))
        continue;
      const key = login.toLowerCase();
      const existing = latestByReviewer.get(key);
      if (
        !existing ||
        submitted > existing.submitted ||
        (submitted === existing.submitted && review.id > existing.review.id)
      )
        latestByReviewer.set(key, { review, submitted });
    }
    const submittedAfterResult = Date.parse(task.result.at);
    const currentDecisions = [...latestByReviewer.entries()].filter(([login, item]) => {
      const review = item.review;
      return (
        !automation.has(login) &&
        review.user?.type === 'User' &&
        ['APPROVED', 'CHANGES_REQUESTED'].includes(review.state) &&
        item.submitted >= submittedAfterResult &&
        typeof review.body === 'string' &&
        review.body.includes(task.result.review_marker)
      );
    });
    currentDecisions.sort(
      (left, right) =>
        right[1].submitted - left[1].submitted || right[1].review.id - left[1].review.id,
    );
    const decision = currentDecisions[0];
    if (!decision) {
      if (task.state === 'DONE' && task.review?.status === 'ACCEPTED') {
        const invalidated = {
          ...task.review,
          status: 'SUPERSEDED',
          accepted: false,
          superseded_at: new Date().toISOString(),
          superseded_head_sha: pull.head_sha,
        };
        task.review = invalidated;
        task.state = 'WAITING_REVIEW';
        const blockedTaskIds = reblockUnstartedDependents(change, task.id);
        change.reviews.push({
          task_id: task.id,
          reviewer_role: 'github-human-reviewer',
          status: 'SUPERSEDED',
          accepted: false,
          ...invalidated,
        });
        await save(projectRoot, state, 'review.invalidate', {
          change_id: change.id,
          task_id: task.id,
          previous_review_id: invalidated.review_id,
          head_sha: pull.head_sha,
          blocked_task_ids: blockedTaskIds,
        });
      }
      throw new WorkflowError(
        'REVIEW_REQUIRED',
        'No current decision from an authenticated human is bound to this exact task result and pull request head.',
      );
    }
    const [login, { review }] = decision;
    if (
      task.review?.review_id === review.id &&
      task.review.result_marker === task.result.review_marker
    )
      return { task, review: task.review, already_recorded: true };
    if (review.state === 'CHANGES_REQUESTED') {
      const attempt = task.result.review_attempt ?? task.review_attempts;
      const exhausted = attempt >= task.review_budget;
      task.review = {
        status: 'CHANGES_REQUESTED',
        provider: 'github',
        pull_request_number: pull.number,
        head_sha: pull.head_sha,
        reviewer: login,
        review_id: review.id,
        reviewed_at: review.submitted_at,
        result_marker: task.result.review_marker,
      };
      task.result.status = exhausted ? 'BLOCKED' : 'CHANGES_REQUESTED';
      task.state = exhausted ? 'BLOCKED' : 'CHANGES_REQUESTED';
      const blockedTaskIds = reblockUnstartedDependents(change, task.id);
      change.reviews.push({
        task_id: task.id,
        reviewer_role: 'github-human-reviewer',
        status: task.result.status,
        accepted: false,
        ...task.review,
      });
      await save(projectRoot, state, 'review.resolve', {
        change_id: change.id,
        task_id: task.id,
        reviewer: login,
        review_id: review.id,
        head_sha: pull.head_sha,
        attempt,
        exhausted,
        blocked_task_ids: blockedTaskIds,
      });
      return {
        task,
        review: task.review,
        accepted: false,
        exhausted,
        blocked_task_ids: blockedTaskIds,
        next_action: exhausted
          ? 'Stop automated review attempts and escalate the unresolved findings to the human coordinator.'
          : 'Address the review findings, rerun the reviewed checks, checkpoint the revision, and submit a new bounded review attempt.',
      };
    }
    task.review = {
      status: 'ACCEPTED',
      provider: 'github',
      pull_request_number: pull.number,
      head_sha: pull.head_sha,
      reviewer: login,
      review_id: review.id,
      reviewed_at: review.submitted_at,
      result_marker: task.result.review_marker,
    };
    task.state = 'DONE';
    const unblockedTaskIds = unblockCompletedDependents(change, state);
    change.reviews.push({
      task_id: task.id,
      reviewer_role: 'github-human-reviewer',
      status: 'ACCEPTED',
      accepted: true,
      ...task.review,
    });
    await save(projectRoot, state, 'review.resolve', {
      change_id: change.id,
      task_id: task.id,
      reviewer: login,
      review_id: review.id,
      head_sha: pull.head_sha,
      unblocked_task_ids: unblockedTaskIds,
    });
    return {
      task,
      review: task.review,
      unblocked_task_ids: unblockedTaskIds,
      already_accepted: false,
    };
  };

  handlers['change.squash_merge'] = async (input, { projectRoot, ...context }) => {
    let profile;
    let { state } = await load(projectRoot);
    let change = findChange(state, input.change_id);
    if (change.merge_receipt)
      return { ...change.merge_receipt, merged: true, already_merged: true };
    const tasks = Object.values(change.tasks);
    requireValue(
      tasks.length > 0 &&
        tasks.every((task) => task.state === 'DONE' && task.review?.status === 'ACCEPTED'),
      'TASKS_INCOMPLETE',
      'Every planned task must have an accepted human review before merge.',
    );
    for (const task of tasks) {
      const review = await handlers['review.resolve'](
        { change_id: change.id, task_id: task.id },
        { ...context, projectRoot },
      );
      requireValue(
        review.task.state === 'DONE' && review.review.status === 'ACCEPTED',
        'REVIEW_REQUIRED',
        'A task review changed; resolve the latest human decision before merging.',
      );
    }
    ({ state } = await load(projectRoot));
    change = findChange(state, input.change_id);
    requireValue(
      Object.values(change.tasks).every(
        (task) => task.state === 'DONE' && task.review?.status === 'ACCEPTED',
      ),
      'TASKS_INCOMPLETE',
      'Every planned task must remain complete with an accepted review before merge.',
    );
    let { pull_request: pull } = await handlers['pr.refresh'](
      { change_id: change.id },
      { ...context, projectRoot },
    );
    ({ profile, state } = await load(projectRoot));
    change = findChange(state, input.change_id);
    const approvedDecisions = (change.approvals ?? []).filter(
      (entry) => entry.status === 'APPROVED',
    );
    const approval = approvedDecisions.find((entry) => entry.head_sha === pull.head_sha);
    requireValue(
      approval,
      approvedDecisions.length > 0 ? 'DECISION_STALE' : 'DECISION_REQUIRED',
      'A current authenticated business approval is required on the pull request head before merge.',
    );
    const artifactRef = change.artifacts.find((entry) => entry.id === approval.artifact_id);
    requireValue(
      artifactRef,
      'DECISION_STALE',
      'The approved decision subject is no longer registered.',
    );
    const artifact = await readJson(await safePath(projectRoot, artifactRef.path));
    requireValue(
      hash(artifact) === approval.subject_hash &&
        artifactRef.content_hash === approval.subject_hash,
      'DECISION_STALE',
      'The approved business artifact changed after acceptance; obtain a current human decision.',
    );
    requirePublishedDecisionSubject(
      projectRoot,
      approval.head_sha,
      artifactRef,
      approval.subject_hash,
    );
    requireValue(
      change.ci_checks?.all_passed === true && change.ci_checks.head_sha === approval.head_sha,
      'CI_NOT_PASSING',
      'Current passing CI evidence is required for the approved pull request head.',
    );
    requireValue(
      pull.head_sha === approval.head_sha,
      'DECISION_STALE',
      'The business approval does not target the current pull request head.',
    );
    if (pull.state === 'closed' && pull.merged && pull.merge_commit_sha) {
      const receipt = {
        pull_request_number: pull.number,
        head_sha: pull.head_sha,
        merge_commit_sha: pull.merge_commit_sha,
        merge_method: 'unknown',
        merge_method_verified: false,
        merged_at: new Date().toISOString(),
        recovered: true,
      };
      ({ state } = await load(projectRoot));
      change = findChange(state, input.change_id);
      change.merge_receipt = receipt;
      await save(projectRoot, state, 'change.squash_merge.recover', {
        change_id: change.id,
        pull_request_number: pull.number,
        head_sha: pull.head_sha,
        merge_commit_sha: pull.merge_commit_sha,
      });
      return { ...receipt, merged: true, already_merged: false };
    }
    requireValue(
      pull.state === 'open' && !pull.draft,
      'PR_NOT_READY',
      'Only a ready, open pull request can be squash merged.',
    );
    const ci = await handlers['ci.inspect']({ change_id: change.id }, { ...context, projectRoot });
    requireValue(
      ci.all_passed && ci.head_sha === approval.head_sha,
      'CI_NOT_PASSING',
      'Every required check must pass on the exact approved pull request head before merge.',
    );
    const configuration = githubConfiguration(profile.github, context.env);
    const merge = await githubRequest(
      { ...context, projectRoot },
      configuration,
      repositoryEndpoint(configuration, `/pulls/${pull.number}/merge`),
      {
        method: 'PUT',
        body: { merge_method: 'squash', sha: approval.head_sha },
      },
    );
    requireValue(
      merge.data?.merged === true &&
        typeof merge.data.sha === 'string' &&
        /^[a-f0-9]{40,64}$/i.test(merge.data.sha),
      'MERGE_NOT_CONFIRMED',
      'GitHub did not confirm a squash merge; no merge receipt was recorded.',
    );
    const refreshed = await handlers['pr.refresh'](
      { change_id: change.id },
      { ...context, projectRoot },
    );
    pull = refreshed.pull_request;
    requireValue(
      pull.state === 'closed' &&
        pull.merged &&
        pull.head_sha === approval.head_sha &&
        pull.merge_commit_sha === merge.data.sha,
      'MERGE_NOT_CONFIRMED',
      'The pull request state does not confirm the expected squash merge.',
    );
    ({ state } = await load(projectRoot));
    change = findChange(state, input.change_id);
    const receipt = {
      pull_request_number: pull.number,
      head_sha: approval.head_sha,
      merge_commit_sha: merge.data.sha,
      merge_method: 'squash',
      merged_at: new Date().toISOString(),
      recovered: false,
    };
    change.merge_receipt = receipt;
    await save(projectRoot, state, 'change.squash_merge', {
      change_id: change.id,
      pull_request_number: pull.number,
      head_sha: approval.head_sha,
      merge_commit_sha: merge.data.sha,
    });
    return { ...receipt, merged: true, already_merged: false };
  };

  handlers['change.cleanup'] = async (input, context) => {
    requireValue(
      input &&
        Object.keys(input).every((key) => ['change_id', 'expected_revision'].includes(key)) &&
        typeof input.change_id === 'string' &&
        Number.isInteger(input.expected_revision),
      'VALIDATION_FAILED',
      'Cleanup requires a change ID and the inspected workflow revision.',
    );
    const { projectRoot } = context;
    let profile;
    let { state } = await load(projectRoot);
    requireValue(
      input.expected_revision === state.revision,
      'STALE_REVISION',
      'Supply the current inspected workflow revision before cleaning a merged branch.',
    );
    let change = findChange(state, input.change_id);
    requireValue(
      change.pull_request?.number &&
        change.merge_receipt?.pull_request_number === change.pull_request.number &&
        /^[a-f0-9]{40,64}$/i.test(change.merge_receipt?.head_sha ?? '') &&
        /^[a-f0-9]{40,64}$/i.test(change.merge_receipt?.merge_commit_sha ?? ''),
      'MERGE_REQUIRED',
      'Only a change with a confirmed merge receipt can be cleaned up.',
    );
    const refreshed = await handlers['pr.refresh']({ change_id: change.id }, context);
    ({ profile, state } = await load(projectRoot));
    change = findChange(state, input.change_id);
    const pull = refreshed.pull_request;
    requireValue(
      pull.state === 'closed' &&
        pull.merged &&
        pull.head_sha === change.merge_receipt.head_sha &&
        pull.merge_commit_sha === change.merge_receipt.merge_commit_sha,
      'MERGE_RECEIPT_STALE',
      'GitHub must confirm that the registered pull request and recorded merge receipt still match.',
    );
    const configuration = githubConfiguration(profile.github, context.env);
    const { data: repository } = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, ''),
    );
    requireValue(
      repository?.delete_branch_on_merge === true,
      'CLEANUP_POLICY_REQUIRED',
      'Enable GitHub automatic deletion of merged branches before local cleanup; manual remote deletion is not race-safe.',
    );
    let remoteBranchAbsent = false;
    try {
      const { data: remoteRef } = await githubRequest(
        context,
        configuration,
        repositoryEndpoint(configuration, `/git/ref/heads/${encodeURIComponent(change.branch)}`),
      );
      requireValue(
        remoteRef?.ref === `refs/heads/${change.branch}` &&
          /^[a-f0-9]{40,64}$/i.test(remoteRef.object?.sha ?? ''),
        'GITHUB_RESPONSE_INVALID',
        'GitHub returned an invalid registered branch reference.',
      );
    } catch (error) {
      if (error.code !== 'GITHUB_NOT_FOUND') throw error;
      remoteBranchAbsent = true;
    }
    requireValue(
      remoteBranchAbsent,
      'CLEANUP_PENDING',
      'GitHub has not completed automatic deletion of the merged branch yet; no local branch was removed.',
    );
    const currentBranch = git(projectRoot, ['branch', '--show-current']);
    requireValue(
      currentBranch !== change.branch,
      'CLEANUP_WRONG_BRANCH',
      'Switch to another branch before removing the registered local change branch.',
    );
    const localRef = git(
      projectRoot,
      ['for-each-ref', '--format=%(objectname)', `refs/heads/${change.branch}`],
      { allowFailure: true },
    );
    requireValue(
      localRef.status === 0,
      'GIT_FAILED',
      'Git could not inspect the registered local change branch.',
    );
    let localBranchDeleted = false;
    if (localRef.stdout.trim()) {
      requireValue(
        localRef.stdout.trim() === change.merge_receipt.head_sha,
        'LOCAL_BRANCH_CHANGED',
        'The local change branch moved after its merged checkpoint; preserving it for manual review.',
      );
      const base = git(
        projectRoot,
        ['rev-parse', '--verify', `refs/heads/${profile.repository.base_branch}`],
        { allowFailure: true },
      );
      requireValue(
        base.status === 0 &&
          git(
            projectRoot,
            [
              'merge-base',
              '--is-ancestor',
              change.merge_receipt.merge_commit_sha,
              profile.repository.base_branch,
            ],
            { allowFailure: true },
          ).status === 0,
        'BASE_BRANCH_NOT_UPDATED',
        'Update the local integration branch to include the confirmed merge before cleanup.',
      );
      const worktrees = git(projectRoot, ['worktree', 'list', '--porcelain']);
      requireValue(
        !worktrees.split(/\r?\n/).some((line) => line === `branch refs/heads/${change.branch}`),
        'BRANCH_IN_USE',
        'The local change branch is checked out in another worktree and was preserved.',
      );
      const beforeDelete = git(
        projectRoot,
        ['for-each-ref', '--format=%(objectname)', `refs/heads/${change.branch}`],
        { allowFailure: true },
      );
      requireValue(
        beforeDelete.status === 0 && beforeDelete.stdout.trim() === change.merge_receipt.head_sha,
        'LOCAL_BRANCH_CHANGED',
        'The local change branch moved during cleanup; preserving it for manual review.',
      );
      git(projectRoot, [
        'update-ref',
        '-d',
        `refs/heads/${change.branch}`,
        change.merge_receipt.head_sha,
      ]);
      localBranchDeleted = true;
    }
    if (
      change.cleanup_receipt &&
      !localBranchDeleted &&
      change.cleanup_receipt.merge_commit_sha === change.merge_receipt.merge_commit_sha
    )
      return { cleanup: change.cleanup_receipt, already_cleaned: true };
    const receipt = {
      pull_request_number: pull.number,
      head_sha: pull.head_sha,
      merge_commit_sha: pull.merge_commit_sha,
      remote_branch_status: 'AUTO_DELETED_AFTER_MERGE',
      local_branch_deleted: localBranchDeleted,
      cleaned_at: new Date().toISOString(),
    };
    change.cleanup_receipt = receipt;
    await save(projectRoot, state, 'change.cleanup', {
      change_id: change.id,
      pull_request_number: pull.number,
      head_sha: pull.head_sha,
      merge_commit_sha: pull.merge_commit_sha,
      local_branch_deleted: localBranchDeleted,
    });
    return { cleanup: receipt, already_cleaned: false };
  };
}
