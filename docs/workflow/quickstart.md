# Codex SDLC workflow quickstart

This package is reusable across projects. Product goals, MVP scope, application inventory, technologies, layout and delivery bindings are discovered during Stage 0, not embedded in this bundle.

## Prerequisites

- Node.js 22 or later and Git for the operation scripts.
- A Codex client whose actual project skill and native custom-agent discovery are verified.
- A target Git repository and a reviewed project profile.
- GitHub/GHCR credentials and Docker only when enabling their corresponding integrations.

For workflow repository development, install the locked tools with `npm ci`, then run `npm run format:check`, `npm run lint`, `npm run check`, and `npm test`. GitHub Actions runs these checks on Ubuntu and Windows with Node.js 22 and 24.

Native subagents inherit session permissions. Reviewer role instructions are behavioral boundaries, not separate read-only sandboxes.

## What is usable in the first increment

Local profile/state, branch creation, artifact/plan validation, bounded retrieval, application-aware test scheduling and execution, TDD evidence, and commit/push checkpoint primitives can be exercised against an isolated target repository. The scheduler executes profiles in order and stops after the first failure. The bundle also supplies skills, native role definitions and artifact formats. This increment does not claim an end-to-end autonomous feature delivery or live external integration.

Business acceptance happens in chat. Present the exact artifact and wait for the user's explicit response; then use `decision.accept` to record `APPROVED` or `REJECTED` against the inspected artifact hash and workflow revision. PR review and merge happen manually in GitHub. The workflow does not ask for a second PR approval or merge the PR; it only confirms the completed merge before advancing the change. PR creation/refresh, CI inspection, task review resolution, and merge confirmation use GitHub REST adapters; configure the target and verify live before enabling those effects. Container publication now queries visible GHCR package metadata before building and blocks any existing non-private package; live GitHub Actions/GHCR acceptance is still required to verify the configured token can read package metadata and publish/pull private digests. Local Compose deploy/verify/recover operations pass deterministic tests and an opt-in two-service Docker smoke; run `WORKFLOW_LIVE_DOCKER=1 npm run test:docker-live` (PowerShell: `$env:WORKFLOW_LIVE_DOCKER='1'; npm run test:docker-live`). This smoke does not verify private GHCR, GitHub Actions publication, cross-application behavior, or deployment to a target project. The optional Codex CLI test runs `WORKFLOW_LIVE_CODEX=1 npm run test:codex-live` (PowerShell: `$env:WORKFLOW_LIVE_CODEX='1'; npm run test:codex-live`) in a disposable project and removes its session afterward. Its default read-only mode verifies fail-closed resume and native specialist handoff. To require successful Git identity restoration on a host that permits nested Git processes, set `WORKFLOW_CODEX_SANDBOX=workspace-write` and `WORKFLOW_CODEX_EXPECT_VERIFIED=1`; this uses `on-request` approvals and still confines writes to the disposable project. Neither mode proves per-agent permission isolation. Declaring a capability in a profile does not make it available.

## Install into a selected project

From the cloned workflow repository, select an existing empty target folder or a clean Git repository root. Inspect the candidate bundle and target readiness, then run the single setup operation:

```text
node scripts/workflow/run.mjs bundle.inspect --project TARGET_PROJECT_ROOT
node scripts/workflow/run.mjs bundle.preflight --project TARGET_PROJECT_ROOT
node scripts/workflow/run.mjs workflow.setup --project TARGET_PROJECT_ROOT
```

Send `{}` on stdin, or pass `{ "base_branch": "develop" }` when the existing repository has `develop` checked out. New folders use `main` by default. Setup requires Git identity, commits only installed workflow-owned files, creates no remote, and does not initialize product-specific workflow state. Open the target folder in Codex, reload if needed, verify the entry skill and specialist handoff, then begin Stage 0 there.

## Inspect before installation

From the source checkout, invoke the runner with the target project explicitly:

```text
node scripts/workflow/run.mjs bundle.inspect --project PROJECT_ROOT
node scripts/workflow/run.mjs bundle.preflight --project PROJECT_ROOT
node scripts/workflow/run.mjs workflow.doctor --project PROJECT_ROOT
```

Pass the JSON object required by the operation through stdin. Inspect unsupported or blocked results; do not continue by inventing approval fields. If bundle inspection/preflight are not registered in the selected installed version, stop that integration path and report the unsupported operation. The operation interface and availability caveats are documented in [operations.md](operations.md).

`workflow.doctor` reports project setup, bundle identity, configured GitHub credentials, and capabilities still requiring live verification. For projects with a Compose target, it makes bounded local probes of the Docker Engine and Compose v2 plugin. A `READY` Docker result confirms only that both respond on this machine; target access and disposable-data policy still need acceptance. A `CONFIGURED` GitHub result only means settings and a credential reference are present; it does not authenticate the token or verify branch protection. Codex discovery, protected authority boundaries, GHCR, and GitHub live behavior must be verified on their actual target surfaces.

If an interrupted process leaves `.workflow/operation.lock`, call `workflow.lock.inspect`. Recover only a `STALE` owner record using its returned `lock_id` as `expected_lock_id` with `workflow.lock.recover`. Active, unknown, malformed, or changed locks are not removed. If the recovery process itself stops, resume it with the recovery guard's `lock_id`, or the pending intent's `reconciliation_lock_id`, as `expected_recovery_lock_id`; the durable reconciliation intent keeps ordinary mutations blocked until a receipt is written. Never delete operation, recovery, or reconciliation files by age alone.

The distributable source is `workflow/bundle/manifest.json`. It maps skills to `.agents/skills/`, native role files to `.codex/agents/`, and contracts/templates/references to `.workflow/` in the target. The installer also copies the workflow runtime to its documented target paths. It must refuse conflicting files and preserve existing project configuration. Do not install over a restricted directory or alter global user configuration as a workaround.

## Configure and initialize

Start with `workflow/bundle/profile.example.json`:

```json
{
  "schema_version": "1",
  "bundle_version": "0.1.28",
  "repository": { "remote": "origin", "base_branch": "main" },
  "applications": [],
  "commands": {}
}
```

An empty application inventory is intentional before Stage 0. Add application paths, contracts, test/quality commands, environments and delivery adapters after architecture acceptance. Commands use an executable, argument array and timeout, not free-form shell text. Store credential references, never secret values, in versioned configuration.

For local Compose delivery, configure the accepted project profile with a `delivery.compose` binding, for example:

```json
{
  "file": "compose.yaml",
  "project_name": "product",
  "readiness_timeout_ms": 120000,
  "verification_profiles": ["system-e2e"]
}
```

The named verification profile must also exist under `commands`. All image-bearing Compose services must be listed in the release manifest and define Docker health checks. The local Docker CLI must already be authenticated to pull private images.

Test profiles also declare `category`, `cadence` and `application_ids`: focused unit/contract checks run at task cadence, component integration at increment cadence, slower system/E2E checks at merge cadence, and image/release checks at release cadence. The scheduler enforces minimum cadence by category: unit/contract no earlier than task, integration no earlier than increment, E2E no earlier than merge, and image/release no earlier than release. Profiles may run at later gates. Use `application_ids: ["*"]` for a whole-system profile. In projects with multiple configured applications, every implementation-plan increment must declare a non-empty, unique set of known `application_ids`; `plan.validate` and the planning stage gate reject missing or invalid scopes. During feature implementation, `test.schedule` derives task/increment scope from the current reviewed increment and rejects conflicting caller scope. A missing or unknown increment scope expands to all configured applications and marks full coverage required. Maintenance derives scope from its accepted impact map. `test.schedule` reports the applicable profile matrix and any uncovered applications. `tests.run_scheduled` refuses to start if any affected application has no selected profile, so partial results cannot be recorded as a completed schedule.

For target-project GitHub Actions, copy `.workflow/templates/ci-profile.example.json` to the tracked `.workflow/ci-profile.json`, replace it with the reviewed application paths and test command profiles, and keep it synchronized with the accepted local project profile. Each impacted application needs focused unit/contract, fast integration, and application acceptance profiles, plus at least one system-wide profile. Install `.workflow/templates/github-actions/application-tests.yml` under `.github/workflows/` and configure `Required application verification` as a required branch-protection check. The template runs four separate matrices without a shell, scopes checks to changed applications when all changed files map cleanly, expands to every application when impact is uncertain, retains sanitized per-profile results, cancels superseded pull-request runs, and fails closed if any required matrix is empty, skipped, unsuccessful, or bound to a different source SHA. It does not publish images. The project remains responsible for installing each application's test prerequisites in its command wrapper.

Use `tests.run_scheduled` to execute that matrix. For MAINTENANCE changes, `test.schedule` requires the current human-approved impact map, classifies every configured application as `AFFECTED`, `UNAFFECTED`, or `UNKNOWN`, and derives the test scope from it; any unknown application or an all-unaffected map expands checks to every application. It records each actual profile run and stops after the first non-passing result. To put a task into `WAITING_REVIEW`, submit its recorded run IDs to `task.record_result` after its scoped checkpoint has been pushed. A designated test-author task may submit an assertion-failure run only after `tdd.record` binds every observed failing assertion to current behavioral RED evidence; the result is explicitly marked `EXPECTED_RED` and does not certify GREEN or implementation-task completion. Independent review acceptance and `DONE` require a trusted reviewer integration.

Use `workflow.setup` from the cloned workflow source for the first installation. `bundle.install` remains a lower-level copy operation and does not initialize Git or record the setup commit. After opening the target in Codex and reviewing the Stage 0 profile inputs, initialize local state with `workflow.init`; for example, pass this JSON through stdin:

```json
{
  "profile": {
    "repository": { "remote": "origin", "base_branch": "main" },
    "applications": [],
    "commands": {}
  }
}
```

For GitHub-backed operations, add `github.owner`, `github.name`, `github.automation_logins` and `github.required_checks` to the reviewed profile. No formatted GitHub review or task marker is required to complete a task; recorded verification evidence and a pushed checkpoint do that. Supply a short-lived GitHub App installation token as `GH_TOKEN` or `GITHUB_TOKEN` in the protected process environment; never place the token in the profile. Public GitHub defaults to `https://api.github.com`. For GitHub Enterprise, set `GITHUB_API_URL` in the protected environment and set the profile `github.api_url` to the same HTTPS URL. The adapter refuses a profile URL that differs from the protected host setting.

`task.record_result` marks a task complete after its planned checks and pushed checkpoint are verified. Business decisions still require the user's explicit acceptance in chat. The user reviews and merges the PR manually; the workflow waits for GitHub to confirm that merge.

For FEATURE and BUGFIX implementation tasks, include the test-author task in `depends_on`. It must have actual assertion-failure RED evidence and a current accepted human review. The implementer stays in `WAITING_DEPENDENCY` until review resolves; the checkpoint and result operations refresh that review again before implementation progress is recorded. A later `CHANGES_REQUESTED` decision for the test task blocks the dependent implementation.

`plan.validate` requires the accepted scenario IDs, non-empty increment/task coverage, a test-author task and an implementer in every increment, and a direct same-increment test dependency for each implementer. A MAINTENANCE plan may explicitly use `outcome: NO_FILE` only with a rationale and empty file ownership for every task. Its test-author task must provide current GREEN evidence; the implementer task must verify the no-op and pass current checks. Ordinary plans require evidence of behavioral RED before implementation. Follow only the next increment reported by `increment.inspect`. Prepare tasks from the accepted implementation plan, complete each planned task, then call `increment.advance` with its increment ID and inspected state revision. Advancement rechecks verification evidence; later increments remain blocked until then. `stage.advance` permits integration only after all planned increments are complete.

For a business decision, present the registered artifact in chat and wait for the user's explicit approval or rejection. Call `decision.accept` with `change_id`, `artifact_id`, the user's `APPROVED` or `REJECTED` decision, and the `expected_revision` and `expected_content_hash` returned by inspection. The operation records the decision status immediately and refuses stale artifact content or workflow revisions.

After task work and checks are complete, the user reviews and merges the PR manually in GitHub. `change.confirm_merge` only refreshes GitHub and records a receipt when the PR is actually merged; it never sends a merge request. Advancing the change to `COMPLETE` performs the same confirmation and reports `MERGE_PENDING` until the user has merged it. GitHub repository permissions and branch protection remain in force.

After merge, use `change.cleanup` with the current inspected workflow revision. It verifies the PR against the stored merge receipt, requires repository auto-delete for merged branches, and waits for GitHub to remove the remote branch. It deletes the local branch only if its head is unchanged, the configured integration branch contains the merge commit, and the branch is not checked out in any worktree. A changed or in-use branch is preserved.

```text
node scripts/workflow/run.mjs workflow.init --project PROJECT_ROOT
```

The initialized repository must already have a Git history and the configured base branch. Inspect it through `workflow.inspect` using `{}` on stdin. Start a bounded local change through `change.start` with an input such as:

```json
{
  "id": "F-001",
  "kind": "FEATURE",
  "description": "Describe the requested user behavior"
}
```

`change.start` requires a clean worktree and records the base revision. It creates a local branch; it does not create a GitHub PR or grant business acceptance. Installation must validate target ownership/conflicts and report whether the client requires reload. Confirm the entry skill is discovered and that a real specialist handoff succeeds on the selected client. File installation alone does not prove runtime capability.

## Invoke and resume from Codex

After verified installation, an example request is:

```text
Use $sdlc-workflow to initialize this project from my idea.
```

Stage 0 discovers product purpose and MVP, obtains human acceptance, then defines architecture/standards, obtains acceptance, and prepares the environment. Later requests can start a feature, report a defect, inspect/resume a change, or propose a workflow improvement.

Workflow changes start on a branch pinned to the currently installed bundle and use the same requirements, planning, increment, TDD, and review gates as feature work. Their final implementation transition enters a separate EVALUATION stage. Dispatch `.github/workflows/workflow-evaluate.yml` from the configured integration branch (the repository default unless `WORKFLOW_BASE_BRANCH` is set) with the change ID and exact candidate commit SHA. The pinned evaluator checks formatting, bundle integrity, and tests with read-only repository access, then retains a run-attempt-specific report. Import it with `evaluation.ingest` using the Actions run ID; the operation verifies the current evaluator branch, successful run, artifact, candidate PR head, and bundle version before `stage.advance` can proceed. Evaluation never activates a bundle or migrates in-flight changes. Activation and migration remain unavailable until their protected approval and recovery paths are implemented and accepted.

The coordinator inspects durable state, retrieves a small context package and delegates bounded tasks. Specialists search and read relevant code on demand. The controller checks operation prerequisites; agent output does not create human acceptance.

After accepted specification and plan artifacts are committed, call `pr.ensure` to create a ready PR before the first task review that needs GitHub. Later task checkpoints push to the same PR. The user performs final PR review and merge manually; the workflow confirms the merge before completion.

Closing the client does not imply background execution. Invoke the skill again to resume from reconciled records.

## Delivery integration contract and current limits

### Optional container workflow templates

The bundle installs `.workflow/templates/container-images.example.json`, `.workflow/templates/github-actions/container-tests.yml`, `.workflow/templates/github-actions/publish-candidates.yml`, `.workflow/templates/github-actions/publish-release.yml`, `.workflow/tools/container-images.mjs`, and `.workflow/tools/compose-status.mjs`. Copy and configure the example catalog as `.github/container-images.json`, then copy the desired Action templates to `.github/workflows/`. The catalog is project-specific: each image needs a stable lowercase ID, Compose service, relative build context, Dockerfile path, and optional target. Ordered database migrations can be declared in `migrations`; each references a digest-built service and includes a stable ID, compatibility (`backward-compatible` or `forward-only`), recovery strategy (`roll-forward`, `restore-backup`, or `manual`), and operator instructions. The release manifest carries those declarations unchanged. The project also supplies `compose.ci.yaml` with the configured `acceptance_service` and CI-safe disposable data.

Both Compose acceptance jobs set a unique project name from the workflow run and attempt. On failure, they retain a seven-day artifact containing only service name, state, health, and exit code; application logs and container command details are excluded. Cleanup removes volumes only for that run's Compose project, including after test failure.

The container verification template builds each catalog entry without publishing from PRs, then runs the configured Compose acceptance service. The publication template runs only when the configured repository variable `WORKFLOW_INTEGRATION_BRANCH` matches the pushed branch. It publishes unique source/run candidate tags to GHCR, records each returned immutable digest, rejects missing/duplicate/stale manifests, verifies that every digest can be pulled, and runs the Compose acceptance service with an override that pins every image to its exact digest. After that system test passes, it retains the candidate set as a workflow artifact.

The release template is manually dispatched from the integration branch with the successful candidate run ID, source SHA, and semantic version. It verifies the source run and complete candidate set, then waits at the protected GitHub environment `workflow-release`. Configure required human reviewers and prevent self-review on that environment. `release.publish` verifies this live policy before dispatch and again before recording success. After approval, the workflow creates a Git tag and GitHub Release with a manifest and notes referencing the tested image digests. It does not rebuild or retag images; deployments should use the release manifest's `image@sha256:...` references. An existing tag is accepted only when it already points to the requested source commit; an existing release is accepted only when its published digest manifest matches exactly, which makes retries recoverable. Configure package access and verify package visibility and repository association before relying on private registry behavior. These templates have not passed live Docker/GHCR/GitHub Release acceptance. Keep them disabled until project layout, CI-safe data, protected environment, and package access are configured.

After downloading the manifest asset from a verified GitHub Release and logging in to the private registry, deploy locally with `deploy.local` using a stable deployment ID and project-relative manifest path. It validates the Compose model, pins every configured service to the release digest, runs declared migration services in manifest order, then starts non-migration services and waits for healthy status. A failed migration blocks application startup and records its declared recovery instructions; the operation never rolls back images or deletes persistent data. After recovery, use a new deployment ID. Then call `deploy.verify` to run the configured verification profiles. This initial adapter accepts only successful Node test-runner reports with at least one executed test as verification evidence. `deploy.recover` reports the recorded status and next action. These local operations have deterministic Docker command fixtures only; they have not run against a live Docker daemon.

The release workflow and local deployment operations have deterministic adapter tests only; neither has passed live acceptance.

Native mobile outputs require appropriate non-container adapters. Local deployment operations still require live Docker/GHCR acceptance, and each project must verify its migration services and recovery instructions against disposable data before routine use.

Operations with missing adapters, credentials, authoritative approval or protected execution capabilities remain blocked. This quickstart describes the supported interface and required setup; it is not a claim that a live target, registry or deployment has been configured.

After the candidate Actions run succeeds, call `images.publish` and `images.verify` with its run ID, the merged `change_id`, and the current `expected_revision`. `release.publish` first dispatches the protected release workflow with `{ "change_id": "F-001", "source_run_id": 123456, "version": "1.2.3", "expected_revision": 14 }` and returns `AWAITING_HUMAN`. Configure required reviewers on the GitHub environment `workflow-release`; after approval, call `release.publish` again with the returned `release_run_id` and a newly inspected revision. It records success only when the workflow run, published release, manifest asset, release notes, and tag all match the verified candidate.
