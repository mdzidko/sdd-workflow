# Registered operation interface

The reusable bundle uses one command interface:

```text
node scripts/workflow/run.mjs OPERATION --project PROJECT_ROOT
```

Pass exactly one JSON object through standard input. The runner returns a JSON response and an exit status. `ok: false` is a failed operation; do not reinterpret it as completion. Use the implementation registry and returned error codes as the authoritative availability report. The following inventory defines the intended surface, not proof that a selected host is configured for every effect.

## First-increment availability

The local bootstrap implements profile/state initialization and inspection/resume, branch creation, canonical artifact creation/validation, plan validation, bounded source reads/search, profile-bound test execution, TDD evidence recording, a cadence-aware cross-application test scheduler, and scoped commit/push checkpoint primitives. In projects with multiple configured applications, plan validation requires each implementation increment to declare a non-empty set of known application IDs. During FEATURE and WORKFLOW_CHANGE implementation, task/increment test scope comes from the current accepted plan increment; conflicting caller scope is rejected, while missing/unknown scope selects all configured applications. MAINTENANCE derives scope from its accepted impact map. Category cadence floors prevent E2E and image/release profiles from running too early. `tests.run_scheduled` fails before executing any profile if an affected application is uncovered; it does not persist partial results as a successful schedule. `decision.ingest` deliberately rejects caller-supplied approvals.

These are local execution and evidence primitives. They do not establish an authorization boundary against a process that can rewrite controller code/state, and a checkpoint receipt does not certify that all business/task gates passed. The profile may bind a command, but a caller-provided capability field does not prove a host feature or grant authority.

Bundle installation/preflight and task orchestration are additional local operations only when reported by the installed registry. Draft PR creation/refresh, exact-head CI inspection and bounded polling, task review resolution, artifact-bound business decisions, readiness transition, and expected-head squash merge use GitHub REST adapters exercised with API doubles; they still require live repository verification. The opt-in Docker live test deploys a digest-pinned web/API pair locally and verifies web-to-API traffic through Compose. Private GHCR, target-project deployment, and live GitHub lifecycle acceptance remain pending. No complete feature-to-deployment run is claimed by this increment.

## Operation groups

| Group | Operations | Important boundary |
| --- | --- | --- |
| Bundle and setup | `bundle.inspect`, `bundle.install`, `bundle.preflight`, `workflow.setup`, `workflow.init`, `workflow.doctor` | `workflow.setup` installs into an empty target or clean repository and records one local bootstrap commit without creating a remote; Stage 0 profile initialization remains separate. Installation preserves unrelated files and does not prove client discovery or activate privileged capabilities. The doctor reports configured versus live-verified capabilities without returning secret values. |
| State and continuation | `workflow.inspect`, `workflow.resume`, `workflow.lock.inspect`, `workflow.lock.recover`, `stage.inspect`, `stage.advance`, `workflow.activate`, `workflow.migrate` | Stage inspection is read-only. Initialization gates require schema-valid, unchanged artifacts and authenticated human decisions refreshed against the current GitHub PR head; bootstrap completion requires a squash-merge receipt. Feature, maintenance, and workflow-change work require accepted requirements/scenarios and a reviewed plan before implementation; maintenance and workflow changes use the task-bound TDD and sequential increment gates. Workflow changes remain pinned to their starting bundle and stop at EVALUATION until trusted GitHub Actions evidence can be verified. Bugfix implementation requires an unchanged defect report with expected/observed behavior and reproduction steps, authenticated intent approval, and a test-author task with recorded assertion-failure RED evidence and a current accepted human review. Completion requires a verified squash-merge receipt. Lock recovery uses the exact inspected lock hash and a provably inactive owner PID. A durable reconciliation intent can resume a stale recovery guard; ordinary mutations stay blocked until its receipt is written. Activation and migration fail closed until prior-version evaluation, trusted approval, and a protected operation boundary are configured. |
| Change routing | `change.route` | Read-only playbook selection by persisted change kind; advisory guidance cannot accept a gate or authenticate evidence. |
| Intake and Git | `change.start`, `change.checkpoint` | Verified base, clean/scoped ownership, commits after changed completed tasks, no empty commits or unrelated additions. |
| Artifacts | `artifact.create`, `artifact.validate`, `spec.validate`, `plan.validate` | Templates and schema validation do not replace semantic review or human acceptance. |
| Context | `repo.search`, `repo.read`, `context.prepare`, `tests.find` | Bounded results include source location and revision; approved intent differs from implemented behavior. |
| Test and quality | `tests.find`, `test.schedule`, `tests.run`, `tests.run_scheduled`, `tdd.record`, `quality.check` | Profile-bound commands, sequential phase matrix with persisted per-profile results and fail-fast behavior, explicit behavioral RED versus infrastructure failures. |
| Delegation and review | `task.prepare`, `task.record_result`, `review.request`, `review.resolve` | Task results require current planned verification and the current pushed scoped checkpoint. Task review is bound to its result marker and checkpoint; an accepted review remains valid across later descendant task commits on the same PR branch, while later decisions carrying that task marker can revoke it. A designated test-author task can submit an assertion-failure run only when current TDD RED evidence covers every failure; it enters independent review without becoming `DONE` or certifying GREEN. Authenticated `CHANGES_REQUESTED` reviews start a new recorded attempt; after three unresolved attempts the task is `BLOCKED` for human escalation. |
| Human decisions | `decision.ingest` | Accepts only an authenticated, allowlisted GitHub review with the exact registered artifact hash and current PR head. It returns a marker for the human when approval is still pending; caller actor/decision fields are rejected. |
| GitHub integration | `pr.ensure`, `pr.refresh`, `pr.mark_ready`, `ci.inspect`, `ci.await`, `change.squash_merge`, `change.cleanup` | PR ensure/refresh/readiness, CI inspection/polling, task review resolution, artifact decision ingestion, expected-head squash merge and guarded local branch cleanup have deterministic API/Git tests. Cleanup requires confirmed merge, GitHub automatic branch deletion, an unchanged local PR-head ref, an updated integration branch and no linked worktree. Live use requires a protected token, trusted API host, branch-protection verification and authorized test repository. |
| Delivery | `images.publish`, `images.verify`, `release.publish`, `deploy.local`, `deploy.verify`, `deploy.recover` | `images.publish` records only a successful candidate Actions run tied to the exact squash-merge SHA and retained digest-set artifact; `images.verify` requires successful discovery, matrix publication, and exact-digest Compose acceptance jobs. `release.publish` verifies the live `workflow-release` environment has a required reviewer and prevents self-review, dispatches the configured workflow, and records success only after the exact release, manifest asset, notes, and source tag are confirmed. CI Compose projects are isolated per run; failures retain sanitized health/exit status and cleanup is scoped to that project. The manifest can declare ordered Compose migration services with compatibility and recovery instructions. Local deployment runs those services before application services and blocks startup after a migration failure. Delivery adapters have deterministic tests, not private-GHCR or release-environment live acceptance. Published, verified, released and deployed are separate. |

## Local operation input examples

Inputs below describe the first-increment primitives. These are API examples, not workflow approval or execution evidence.

| Operation | Input |
| --- | --- |
| `workflow.init` | `{ "profile": { "repository": { "remote": "origin", "base_branch": "main" }, "applications": [], "commands": {} } }` |
| `bundle.inspect` | `{}` (returns the candidate content hash and any installed identity) |
| `workflow.setup` | `{}` (or `{ "base_branch": "develop" }` for a clean repository with `develop` checked out) |
| `workflow.doctor` | `{}` (read-only capability and setup report; external/native checks remain explicitly unverified) |
| `workflow.lock.inspect` | `{}` (returns operation/recovery lock states, content IDs, and the `reconciliation_lock_id` when a durable recovery reconciliation is pending) |
| `workflow.lock.recover` | `{ "expected_lock_id": "SHA256_FROM_LOCK_INSPECTION" }` recovers a stale operation lock; `{ "expected_recovery_lock_id": "SHA256_FROM_LOCK_INSPECTION" }` resumes a stale recovery guard or its exact pending reconciliation intent |
| `workflow.inspect` | `{}` |
| `workflow.resume` | `{ "change_id": "F-001" }` |
| `stage.inspect` | `{ "change_id": "INIT-001" }` (read-only gate evidence for the current transition) |
| `stage.advance` | `{ "change_id": "INIT-001", "expected_stage": "FOUNDATIONS", "expected_revision": 12, "to": "ARCHITECTURE" }` |
| `change.route` | `{ "change_id": "F-001" }` |
| `change.start` | `{ "id": "F-001", "kind": "FEATURE", "description": "Describe a behavior" }` |
| `artifact.create` | `{ "id": "REQS-001", "change_id": "F-001", "type": "requirements", "title": "Requested behavior", "data": { "requirements": [{ "id": "REQ-001", "description": "Describe the required behavior." }] } }` |
| `artifact.validate` | `{ "path": "docs/changes/F-001/REQS-001.json" }` |
| `plan.validate` | See the minimal structural example below. |
| `repo.search` | `{ "query": "publicContract", "limit": 20 }` |
| `repo.read` | `{ "path": "relative/source-file", "start_line": 1, "end_line": 100, "max_chars": 12000 }` |
| `tests.run` | `{ "profile": "focused", "change_id": "F-001" }` |
| `test.schedule` | `{ "phase": "increment", "affected_application_ids": ["api"], "impact_unknown": false }` |
| `tests.run_scheduled` | `{ "phase": "merge", "affected_application_ids": ["api"], "impact_unknown": false, "change_id": "F-001" }` |
| `task.record_result` | `{ "change_id": "F-001", "task_id": "T-001", "run_ids": ["RECORDED_RUN_ID"] }` |
| `tdd.record` | `{ "change_id": "F-001", "run_id": "RECORDED_RUN_ID", "phase": "RED", "expected_failure": { "test_id": "observed test name", "message": "observed assertion message" } }` |
| `change.checkpoint` | `{ "change_id": "F-001", "task_id": "T-001", "paths": ["relative/owned-file"], "message": "test(F-001): cover required behavior", "push": true }` |
| `pr.ensure` | `{ "change_id": "F-001" }` |
| `pr.refresh` | `{ "change_id": "F-001" }` |
| `ci.inspect` | `{ "change_id": "F-001" }` |
| `ci.await` | `{ "change_id": "F-001", "timeout_ms": 600000, "poll_interval_ms": 5000 }` |
| `pr.mark_ready` | `{ "change_id": "F-001" }` |

A minimal structural `plan.validate` input is:

```json
{
  "scenario_ids": ["SC-001"],
  "plan": {
    "increments": [
      { "id": "I-001", "goal": "The user can retain a valid request", "scenario_ids": ["SC-001"] }
    ],
    "tasks": [
      {
        "id": "T-001",
        "increment_id": "I-001",
        "role": "sdlc_test_author",
        "depends_on": [],
        "scenario_ids": ["SC-001"],
        "outputs": ["Reviewed tests for request retention"],
        "verification_profiles": ["focused"]
      }
    ]
  }
}
```

Structural validity does not imply that this one-task example is a complete implementation plan. Independent review must assess implementation, integration and delivery coverage.

`artifact.create` generates JSON and a Markdown representation from the same data. Draft core fields may be sufficient for creation; full stage fields and semantic review are required before acceptance. Run IDs and revisions must come from actual operation results. The test classifier currently recognizes supported Node assertion output; arbitrary test-runner output is not automatically recognized as behavioral RED.

## Request and result discipline

Use the concrete operation's input fields rather than adding unrecognized flags that pretend to bypass a gate. Supply expected revision and request identity where supported. A retry must reconcile prior effects before creating another branch, commit, PR, release or deployment.

Command profiles are configuration entries under `commands`, each with `command`, an argument array, and `timeout_ms`. To participate in `test.schedule`, a profile also declares a category (`unit`, `contract`, `integration`, `e2e`, `image`, or `release`), cadence (`task`, `increment`, `merge`, or `release`), and application IDs; use `*` alone for a system-wide profile. The project application catalog declares stable IDs and project-relative paths. Unknown impact selects all current-phase profiles across the catalog. Profiles are selected by name; never interpolate a user description into shell source. Profile configuration is trusted executable configuration and must be reviewed accordingly.

GitHub-backed operations require `profile.github.owner` and `profile.github.name`. CI inspection also requires a non-empty `required_checks` list. Set a short-lived `GH_TOKEN` or `GITHUB_TOKEN` in the protected process environment. Public GitHub uses `https://api.github.com`; GitHub Enterprise requires a matching trusted `GITHUB_API_URL` environment value and profile `api_url`. The token is never written to profile/state or returned in operation results.

`tests.run_scheduled` executes the selected matrix sequentially through the registered command runner, stores one evidence record per executed profile, and stops after the first non-passing classification. It reports later profiles as not run; a partial run never becomes a passing gate.

Expected RED may be committed to a draft branch and submitted for independent review by a designated test-author task when every observed assertion failure has matching current TDD evidence. It remains a failing test; it is not a green CI result or task completion for implementation work. Before merge, the final integration candidate must satisfy all required controls and actual human review.

## Availability and security limits

A registered name is not evidence of a completed external integration. Missing credentials, adapters, host discovery, authenticated decisions or enforceable privilege boundaries must produce an explicit blocked/unsupported result. Test fixtures may prove adapter behavior but do not establish live GitHub, GHCR or Docker success. The release template requires a configured protected `workflow-release` environment with required human reviewers.

Direct filesystem-based controller records cannot withstand an unrestricted process that can rewrite both records and controller code. Native specialist instructions do not establish permission isolation. Keep protected operations disabled until the selected deployment provides a verified authority boundary. Use GitHub protected branches and authenticated reviews as external merge enforcement rather than an editable JSON approval field.

## Artifacts and versioning

`workflow/bundle/contracts/artifact-types.json` lists canonical types and their core/stage fields. Matching JSON templates are under `workflow/bundle/templates/`; schemas and synthetic positive/negative examples are under `workflow/bundle/contracts/`. Generated evidence templates cannot be instantiated as trusted receipts. A hand-filled receipt cannot certify that an operation occurred.

Changes pin a bundle version. Candidate workflow changes execute under the prior active version. Merge does not activate a new workflow or migrate in-flight records.
