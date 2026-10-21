import { findChange, load, save } from './state.mjs';
import { hash, requireValue } from './support.mjs';
import {
  githubConfiguration,
  githubDownload,
  githubRequest,
  repositoryEndpoint,
} from './github-api.mjs';

const CANDIDATE_WORKFLOW = '.github/workflows/publish-candidates.yml';
const CANDIDATE_WORKFLOW_NAME = 'Publish and verify image candidates';
const CANDIDATE_ARTIFACT = 'verified-candidate-set';
const RELEASE_WORKFLOW = '.github/workflows/publish-release.yml';
const RELEASE_WORKFLOW_ID = 'publish-release.yml';
const RELEASE_WORKFLOW_NAME = 'Publish release from verified image candidate';
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/i;

async function releaseEnvironmentPolicy(context, configuration) {
  let environment;
  try {
    ({ data: environment } = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, '/environments/workflow-release'),
    ));
  } catch (error) {
    if (error.code !== 'GITHUB_NOT_FOUND') throw error;
    requireValue(
      false,
      'RELEASE_ENVIRONMENT_REQUIRED',
      'Configure a protected workflow-release environment with required human reviewers before publishing releases.',
    );
  }
  const rule = environment?.protection_rules?.find((item) => item.type === 'required_reviewers');
  const reviewers = rule?.reviewers
    ?.map((item) => ({ type: item.type, id: item.reviewer?.id }))
    .filter((item) => ['User', 'Team'].includes(item.type) && Number.isInteger(item.id))
    .sort((left, right) => left.type.localeCompare(right.type) || left.id - right.id);
  requireValue(
    rule?.prevent_self_review === true && reviewers?.length > 0,
    'RELEASE_ENVIRONMENT_REQUIRED',
    'The workflow-release environment must require at least one human reviewer and prevent self-review.',
  );
  const policy = { environment: 'workflow-release', prevent_self_review: true, reviewers };
  return { policy, policy_hash: hash(policy) };
}

function validateRun(run, change, profile, runId) {
  requireValue(
    run?.id === runId &&
      run.workflow_id > 0 &&
      run.head_branch === profile.repository.base_branch &&
      run.head_sha === change.merge_receipt.merge_commit_sha &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      String(run.path ?? '').split('@')[0] === CANDIDATE_WORKFLOW &&
      run.name === CANDIDATE_WORKFLOW_NAME &&
      Number.isInteger(run.run_attempt) &&
      run.run_attempt > 0,
    'IMAGE_RUN_UNTRUSTED',
    'The selected Actions run must use the trusted candidate workflow on the configured integration branch and exact merge commit.',
  );
}

async function candidateRun(context, configuration, change, profile, runId) {
  const { data: run } = await githubRequest(
    context,
    configuration,
    repositoryEndpoint(configuration, `/actions/runs/${runId}`),
  );
  validateRun(run, change, profile, runId);
  if (run.status !== 'completed') return { run, pending: true };
  requireValue(
    run.conclusion === 'success',
    'IMAGE_BUILD_FAILED',
    'The candidate build or exact-digest Compose verification did not complete successfully.',
  );
  const { data: artifactList, headers } = await githubRequest(
    context,
    configuration,
    repositoryEndpoint(configuration, `/actions/runs/${runId}/artifacts?per_page=100`),
  );
  requireValue(
    Array.isArray(artifactList?.artifacts) &&
      !headers.get('link')?.includes('rel="next"') &&
      artifactList.total_count === artifactList.artifacts.length,
    'GITHUB_LIST_INCOMPLETE',
    'GitHub did not return the complete candidate artifact list.',
  );
  const matching = artifactList.artifacts.filter(
    (artifact) => artifact.name === CANDIDATE_ARTIFACT,
  );
  requireValue(
    matching.length === 1 &&
      Number.isInteger(matching[0].id) &&
      matching[0].expired === false &&
      Number.isInteger(matching[0].size_in_bytes) &&
      matching[0].size_in_bytes > 0,
    'IMAGE_CANDIDATE_ARTIFACT_MISSING',
    'The successful candidate run must retain one unexpired digest-bound candidate set.',
  );
  return { run, artifact: matching[0], pending: false };
}

function validateInput(input, { requireRun = true } = {}) {
  const allowed = requireRun
    ? ['change_id', 'run_id', 'expected_revision']
    : ['change_id', 'run_id', 'expected_revision'];
  requireValue(
    input &&
      Object.keys(input).every((key) => allowed.includes(key)) &&
      typeof input.change_id === 'string' &&
      Number.isInteger(input.expected_revision) &&
      (!requireRun || (Number.isInteger(input.run_id) && input.run_id > 0)),
    'VALIDATION_FAILED',
    'Image delivery requires a change ID, Actions run ID, and inspected workflow revision.',
  );
}

export function registerDeliveryGithubOperations(handlers) {
  handlers['images.publish'] = async (input, context) => {
    validateInput(input);
    const { profile, state } = await load(context.projectRoot);
    requireValue(
      input.expected_revision === state.revision,
      'STALE_REVISION',
      'Inspect workflow state again before recording a candidate image run.',
    );
    const change = findChange(state, input.change_id);
    requireValue(
      change.merge_receipt?.pull_request_number === change.pull_request?.number &&
        /^[a-f0-9]{40,64}$/i.test(change.merge_receipt?.merge_commit_sha ?? ''),
      'MERGE_REQUIRED',
      'Candidate images can be published only from a change with a confirmed user-merge receipt.',
    );
    const configuration = githubConfiguration(profile.github, context.env);
    const result = await candidateRun(context, configuration, change, profile, input.run_id);
    if (result.pending)
      return { status: 'PENDING', run_id: input.run_id, run_status: result.run.status };
    const candidate = {
      run_id: result.run.id,
      run_attempt: result.run.run_attempt,
      artifact_id: result.artifact.id,
      source_sha: result.run.head_sha,
      workflow_path: CANDIDATE_WORKFLOW,
      workflow_id: result.run.workflow_id,
      published_at: new Date().toISOString(),
    };
    if (
      change.image_candidate?.run_id === candidate.run_id &&
      change.image_candidate?.run_attempt === candidate.run_attempt &&
      change.image_candidate?.artifact_id === candidate.artifact_id
    )
      return { status: 'PUBLISHED', candidate: change.image_candidate, already_recorded: true };
    change.image_candidate = candidate;
    delete change.image_verification;
    await save(context.projectRoot, state, 'images.publish', {
      change_id: change.id,
      run_id: candidate.run_id,
      run_attempt: candidate.run_attempt,
      artifact_id: candidate.artifact_id,
      source_sha: candidate.source_sha,
    });
    return { status: 'PUBLISHED', candidate, already_recorded: false };
  };

  handlers['images.verify'] = async (input, context) => {
    validateInput(input);
    const { profile, state } = await load(context.projectRoot);
    requireValue(
      input.expected_revision === state.revision,
      'STALE_REVISION',
      'Inspect workflow state again before recording candidate verification.',
    );
    const change = findChange(state, input.change_id);
    requireValue(
      change.image_candidate?.run_id === input.run_id &&
        change.image_candidate.source_sha === change.merge_receipt?.merge_commit_sha,
      'IMAGE_PUBLICATION_REQUIRED',
      'Record the trusted candidate publication with images.publish before verifying it.',
    );
    const configuration = githubConfiguration(profile.github, context.env);
    const result = await candidateRun(context, configuration, change, profile, input.run_id);
    if (result.pending)
      return { status: 'PENDING', run_id: input.run_id, run_status: result.run.status };
    requireValue(
      result.artifact.id === change.image_candidate.artifact_id &&
        result.run.run_attempt === change.image_candidate.run_attempt,
      'IMAGE_CANDIDATE_CHANGED',
      'The candidate artifact or run attempt differs from the recorded publication.',
    );
    const { data: jobList, headers } = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, `/actions/runs/${input.run_id}/jobs?per_page=100`),
    );
    const jobs = jobList?.jobs;
    requireValue(
      Array.isArray(jobs) && !headers.get('link')?.includes('rel="next"') && jobs.length > 0,
      'GITHUB_LIST_INCOMPLETE',
      'GitHub did not return the complete candidate verification job list.',
    );
    requireValue(
      jobs.every((job) => job.status === 'completed' && job.conclusion === 'success') &&
        jobs.some((job) => job.name === 'discover') &&
        jobs.some((job) => job.name.startsWith('publish')) &&
        jobs.some((job) => job.name === 'verify-candidate-set'),
      'IMAGE_VERIFICATION_FAILED',
      'The candidate run must contain successful discovery, image publication, and exact-digest Compose verification jobs.',
    );
    const verification = {
      run_id: result.run.id,
      run_attempt: result.run.run_attempt,
      artifact_id: result.artifact.id,
      source_sha: result.run.head_sha,
      verified_at: new Date().toISOString(),
      evidence: ['complete_image_matrix', 'exact_digest_pull', 'compose_system_acceptance'],
    };
    if (
      change.image_verification?.run_id === verification.run_id &&
      change.image_verification?.run_attempt === verification.run_attempt &&
      change.image_verification?.artifact_id === verification.artifact_id
    )
      return {
        status: 'VERIFIED',
        verification: change.image_verification,
        already_recorded: true,
      };
    change.image_verification = verification;
    await save(context.projectRoot, state, 'images.verify', {
      change_id: change.id,
      run_id: verification.run_id,
      run_attempt: verification.run_attempt,
      artifact_id: verification.artifact_id,
      source_sha: verification.source_sha,
    });
    return { status: 'VERIFIED', verification, already_recorded: false };
  };

  handlers['release.publish'] = async (input, context) => {
    requireValue(
      input &&
        Object.keys(input).every((key) =>
          ['change_id', 'source_run_id', 'version', 'release_run_id', 'expected_revision'].includes(
            key,
          ),
        ) &&
        typeof input.change_id === 'string' &&
        Number.isInteger(input.source_run_id) &&
        input.source_run_id > 0 &&
        typeof input.version === 'string' &&
        VERSION.test(input.version) &&
        (input.release_run_id === undefined ||
          (Number.isInteger(input.release_run_id) && input.release_run_id > 0)) &&
        Number.isInteger(input.expected_revision),
      'VALIDATION_FAILED',
      'Release publication requires a verified candidate run, semantic version, inspected revision, and optionally the dispatched release run ID.',
    );
    const { profile, state } = await load(context.projectRoot);
    requireValue(
      input.expected_revision === state.revision,
      'STALE_REVISION',
      'Inspect workflow state again before dispatching or recording a release.',
    );
    const change = findChange(state, input.change_id);
    requireValue(
      change.image_verification?.run_id === input.source_run_id &&
        change.image_verification.source_sha === change.merge_receipt?.merge_commit_sha,
      'IMAGE_VERIFICATION_REQUIRED',
      'A verified candidate set for the exact merged source is required before release publication.',
    );
    requireValue(
      change.image_candidate?.run_id === input.source_run_id &&
        change.image_candidate.run_attempt === change.image_verification.run_attempt &&
        change.image_candidate.artifact_id === change.image_verification.artifact_id,
      'IMAGE_VERIFICATION_REQUIRED',
      'The verified candidate must match the recorded candidate publication and artifact.',
    );
    const configuration = githubConfiguration(profile.github, context.env);
    const tag = `v${input.version}`;
    const dispatchTitle = `Publish release ${tag} from candidate run ${input.source_run_id}`;
    if (input.release_run_id === undefined) {
      if (change.release_receipt?.tag === tag) {
        requireValue(
          change.release_receipt.source_sha === change.image_verification.source_sha &&
            change.release_receipt.source_run_id === input.source_run_id,
          'RELEASE_VERSION_CONFLICT',
          'This release version is already bound to another source or candidate run.',
        );
        return { status: 'PUBLISHED', release: change.release_receipt, already_published: true };
      }
      if (change.release_dispatch) {
        requireValue(
          change.release_dispatch.tag === tag &&
            change.release_dispatch.source_sha === change.image_verification.source_sha &&
            change.release_dispatch.source_run_id === input.source_run_id,
          'RELEASE_VERSION_CONFLICT',
          'A different release dispatch is already pending for this change.',
        );
        return {
          status: 'AWAITING_HUMAN',
          dispatch: change.release_dispatch,
          already_dispatched: true,
        };
      }
      const { data: base } = await githubRequest(
        context,
        configuration,
        repositoryEndpoint(
          configuration,
          `/branches/${encodeURIComponent(profile.repository.base_branch)}`,
        ),
      );
      requireValue(
        /^[a-f0-9]{40,64}$/i.test(base?.commit?.sha ?? ''),
        'GITHUB_RESPONSE_INVALID',
        'GitHub did not return a valid integration branch commit for release dispatch.',
      );
      const releasePolicy = await releaseEnvironmentPolicy(context, configuration);
      const { data: workflowRuns, headers: workflowRunHeaders } = await githubRequest(
        context,
        configuration,
        repositoryEndpoint(
          configuration,
          `/actions/workflows/${RELEASE_WORKFLOW_ID}/runs?event=workflow_dispatch&branch=${encodeURIComponent(profile.repository.base_branch)}&per_page=100`,
        ),
      );
      requireValue(
        Array.isArray(workflowRuns?.workflow_runs) &&
          workflowRuns.total_count === workflowRuns.workflow_runs.length &&
          !workflowRunHeaders.get('link')?.includes('rel="next"'),
        'GITHUB_LIST_INCOMPLETE',
        'GitHub did not return a complete release workflow run list for dispatch reconciliation.',
      );
      const matchingRuns = workflowRuns.workflow_runs.filter(
        (run) =>
          run.display_title === dispatchTitle &&
          run.event === 'workflow_dispatch' &&
          run.head_branch === profile.repository.base_branch &&
          run.head_sha === base.commit.sha &&
          String(run.path ?? '').split('@')[0] === RELEASE_WORKFLOW &&
          run.name === RELEASE_WORKFLOW_NAME &&
          run.status !== 'completed',
      );
      requireValue(
        matchingRuns.length <= 1,
        'RELEASE_DISPATCH_AMBIGUOUS',
        'More than one release workflow run matches this version and candidate. Resolve duplicate runs manually.',
      );
      if (matchingRuns.length === 1) {
        const existing = matchingRuns[0];
        requireValue(
          Number.isInteger(existing.id) && existing.id > 0,
          'GITHUB_RESPONSE_INVALID',
          'GitHub returned an invalid matching release workflow run ID.',
        );
        const dispatch = {
          tag,
          version: input.version,
          source_sha: change.image_verification.source_sha,
          source_run_id: input.source_run_id,
          workflow_path: RELEASE_WORKFLOW,
          workflow_name: RELEASE_WORKFLOW_NAME,
          dispatch_head_sha: base.commit.sha,
          release_run_id: existing.id,
          run_status: existing.status,
          environment_policy_hash: releasePolicy.policy_hash,
          requested_at: existing.created_at ?? new Date().toISOString(),
          reconciled: true,
        };
        change.release_dispatch = dispatch;
        await save(context.projectRoot, state, 'release.publish.reconcile', {
          change_id: change.id,
          tag,
          source_sha: dispatch.source_sha,
          source_run_id: input.source_run_id,
          release_run_id: existing.id,
          environment_policy_hash: releasePolicy.policy_hash,
        });
        return { status: 'AWAITING_HUMAN', dispatch, already_dispatched: true };
      }
      await githubRequest(
        context,
        configuration,
        repositoryEndpoint(configuration, `/actions/workflows/${RELEASE_WORKFLOW_ID}/dispatches`),
        {
          method: 'POST',
          body: {
            ref: profile.repository.base_branch,
            inputs: {
              source_run_id: String(input.source_run_id),
              source_sha: change.image_verification.source_sha,
              version: input.version,
            },
          },
        },
      );
      const dispatch = {
        tag,
        version: input.version,
        source_sha: change.image_verification.source_sha,
        source_run_id: input.source_run_id,
        workflow_path: RELEASE_WORKFLOW,
        workflow_name: RELEASE_WORKFLOW_NAME,
        dispatch_head_sha: base.commit.sha,
        environment_policy_hash: releasePolicy.policy_hash,
        requested_at: new Date().toISOString(),
      };
      change.release_dispatch = dispatch;
      await save(context.projectRoot, state, 'release.publish.dispatch', {
        change_id: change.id,
        tag,
        source_sha: dispatch.source_sha,
        source_run_id: input.source_run_id,
        dispatch_head_sha: dispatch.dispatch_head_sha,
      });
      return {
        status: 'AWAITING_HUMAN',
        dispatch,
        message:
          'The protected release workflow was dispatched. A required reviewer must approve the workflow-release environment before publication can complete.',
      };
    }

    const dispatch = change.release_dispatch;
    requireValue(
      dispatch?.tag === tag &&
        dispatch.source_run_id === input.source_run_id &&
        dispatch.source_sha === change.image_verification.source_sha,
      'RELEASE_DISPATCH_REQUIRED',
      'Dispatch this exact verified candidate and version before recording a published release.',
    );
    const currentReleasePolicy = await releaseEnvironmentPolicy(context, configuration);
    requireValue(
      currentReleasePolicy.policy_hash === dispatch.environment_policy_hash,
      'RELEASE_ENVIRONMENT_CHANGED',
      'The protected human-review policy changed while the release was running; inspect and reconcile it before recording success.',
    );
    const { data: run } = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, `/actions/runs/${input.release_run_id}`),
    );
    requireValue(
      run?.id === input.release_run_id &&
        run.workflow_id > 0 &&
        String(run.path ?? '').split('@')[0] === RELEASE_WORKFLOW &&
        run.name === RELEASE_WORKFLOW_NAME &&
        run.display_title === dispatchTitle &&
        run.event === 'workflow_dispatch' &&
        run.head_branch === profile.repository.base_branch &&
        run.head_sha === dispatch.dispatch_head_sha &&
        Number.isInteger(run.run_attempt) &&
        run.run_attempt > 0,
      'RELEASE_RUN_UNTRUSTED',
      'The selected release run must match the dispatched workflow, version, candidate run, and integration revision.',
    );
    if (run.status !== 'completed')
      return {
        status: 'AWAITING_HUMAN',
        release_run_id: run.id,
        run_status: run.status,
        message:
          'The release workflow is pending or running, including its protected environment approval.',
      };
    requireValue(
      run.conclusion === 'success',
      'RELEASE_PUBLICATION_FAILED',
      'The protected release workflow did not complete successfully.',
    );
    const { data: release } = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, `/releases/tags/${encodeURIComponent(tag)}`),
    );
    requireValue(
      release?.tag_name === tag &&
        release.draft === false &&
        release.prerelease === input.version.includes('-') &&
        typeof release.html_url === 'string' &&
        release.body?.includes(`Source commit: ${dispatch.source_sha}`) &&
        release.body.includes(`Verified candidate workflow run: ${input.source_run_id}`),
      'RELEASE_MISMATCH',
      'The published GitHub Release does not match the approved candidate source and version.',
    );
    const manifestAssets = (release.assets ?? []).filter(
      (asset) =>
        asset.name === 'release-manifest.json' &&
        asset.state === 'uploaded' &&
        Number.isInteger(asset.id) &&
        asset.size > 0 &&
        asset.size <= 1024 * 1024,
    );
    requireValue(
      manifestAssets.length === 1,
      'RELEASE_MANIFEST_MISSING',
      'The published release must contain exactly one digest-bound release manifest.',
    );
    const manifestArchive = await githubDownload(
      context,
      configuration,
      repositoryEndpoint(configuration, `/releases/assets/${manifestAssets[0].id}`),
      1024 * 1024,
      'application/octet-stream',
    );
    let releaseManifest;
    try {
      releaseManifest = JSON.parse(manifestArchive.toString('utf8'));
    } catch {
      requireValue(
        false,
        'RELEASE_MANIFEST_INVALID',
        'The published release manifest is not valid JSON.',
      );
    }
    const imageIds = new Set();
    const imageServices = new Set();
    const namespace = `ghcr.io/${configuration.owner.toLowerCase()}/${configuration.name.toLowerCase()}/`;
    requireValue(
      releaseManifest?.schema_version === '1' &&
        releaseManifest.version === input.version &&
        releaseManifest.tag === tag &&
        releaseManifest.prerelease === input.version.includes('-') &&
        releaseManifest.source_sha === dispatch.source_sha &&
        String(releaseManifest.source_run_id) === String(input.source_run_id) &&
        Array.isArray(releaseManifest.images) &&
        releaseManifest.images.length > 0 &&
        releaseManifest.images.every((image) => {
          const valid =
            image &&
            typeof image.image_id === 'string' &&
            /^[a-z0-9][a-z0-9-]{0,62}$/.test(image.image_id) &&
            !imageIds.has(image.image_id) &&
            typeof image.service === 'string' &&
            /^[a-z0-9][a-z0-9_-]{0,62}$/.test(image.service) &&
            !imageServices.has(image.service) &&
            image.image === `${namespace}${image.image_id}` &&
            DIGEST.test(image.digest ?? '') &&
            image.reference === `${image.image}@${image.digest}`;
          if (valid) {
            imageIds.add(image.image_id);
            imageServices.add(image.service);
          }
          return valid;
        }) &&
        Array.isArray(releaseManifest.migrations ?? []),
      'RELEASE_MANIFEST_MISMATCH',
      'The published digest manifest must match the verified candidate run, exact release version, repository image namespace, and unique immutable image references.',
    );
    const { data: tagRef } = await githubRequest(
      context,
      configuration,
      repositoryEndpoint(configuration, `/git/ref/tags/${encodeURIComponent(tag)}`),
    );
    requireValue(
      tagRef?.ref === `refs/tags/${tag}` &&
        tagRef.object?.type === 'commit' &&
        tagRef.object.sha === dispatch.source_sha,
      'RELEASE_TAG_MISMATCH',
      'The release tag must point to the exact verified candidate source commit.',
    );
    const receipt = {
      tag,
      version: input.version,
      source_sha: dispatch.source_sha,
      source_run_id: input.source_run_id,
      release_run_id: input.release_run_id,
      release_url: release.html_url,
      manifest_asset_id: manifestAssets[0].id,
      image_references: releaseManifest.images.map((image) => image.reference),
      tag_sha: tagRef.object.sha,
      published_at: release.published_at,
      verified_at: new Date().toISOString(),
    };
    change.release_receipt = receipt;
    await save(context.projectRoot, state, 'release.publish', {
      change_id: change.id,
      tag,
      source_sha: receipt.source_sha,
      source_run_id: input.source_run_id,
      release_run_id: input.release_run_id,
      manifest_asset_id: receipt.manifest_asset_id,
    });
    return { status: 'PUBLISHED', release: receipt, already_published: false };
  };
}
