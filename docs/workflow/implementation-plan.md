# Workflow Implementation Plan

Status: implementation is progressing on `workflow/W-000-bootstrap`; multiple verified increments have been committed and pushed. The plan is not complete, the full eight-journey acceptance gate has not passed, and this candidate is not ready for activation or PR. The selected direction is recorded in [Codex integration architecture](codex-integration.md). All paths below concern the workflow itself; each target project's application layout remains a Stage 0 decision.

Policy update for bundle 0.1.30: business decisions are recorded from explicit chat responses, PRs are created ready for review, and users review/merge manually. The workflow only records merge completion after GitHub confirms it. Older implementation notes below describe earlier behavior unless updated explicitly.

### Current task-level implementation status

| Tasks | Local implementation status | Remaining acceptance or capability |
| --- | --- | --- |
| W-001–W-018 | Core contracts, schemas/templates, state/operations, local Git and GitHub adapters, native bundle assets, planning/test policy, CI/image templates, and Compose operations have deterministic checks. Multi-application plan validation requires each increment to declare known affected application IDs; feature task/increment test scope derives from the current reviewed increment, expands missing/unknown scope to all configured applications, and rejects conflicting caller scope. Scheduled execution blocks before running profiles when coverage is incomplete, and category cadence floors prevent slow test classes from being scheduled too early. W-016 includes an installed target-project Actions template with separate focused, fast, acceptance, and system matrices. Discovery rejects missing category coverage and the required aggregate rejects empty/skipped/failed matrices and non-current SHAs. W-017 now preflights the configured GHCR namespace using package metadata and blocks publication when a visible package is not private; live target-project event acceptance remains pending. A live Codex CLI test loads the entry skill, performs a read-only handoff to the installed specialist definition, and resumes that saved session from a fresh CLI process when explicitly bound for that run. | W-002/W-012 automatic discovery from a trusted project, client reload, full Git identity verification during resume under the selected host, and isolation proof; W-009 live GitHub PR/merge, W-016 live target-project Actions acceptance, and W-017 live Actions/GHCR acceptance (the workflow repository's own four-job Actions matrix passes); W-018 multi-application and target-project Docker acceptance. These tasks are not fully accepted by mock evidence alone. |
| W-019 | Initialization and defect gates plus advisory routes are implemented. Maintenance requires a reviewed impact map classifying every configured application; task scheduling derives scope from that accepted map and expands to all applications when any impact is unknown. A no-file plan may use GREEN test-author evidence and an empty-ownership implementation checkpoint. BUGFIX also requires authenticated approval of its unchanged defect report before implementation or no-file completion; a rejected intent remains blocked and returns the coordinator to feature specification guidance. For no-file fixes, the decision is bound to an open GitHub Issue carrying the exact change marker; only the latest exact-artifact decision comment from an allowlisted human counts, and stage advancement refreshes it. | Bare-remote/API fixtures cover initialization, defect-fix, and no-file maintenance journeys through current review, CI, squash merge, and completion gates. No-file BUGFIX fixture covers missing decision, changes requested, approval, later revocation, reapproval, completion, and no empty commit. The defect fixture covers rejected intent, specification route, and subsequent current approval. Live deployment verification remains pending. |
| W-020 | Bundle content hashes are immutable per version and pinned per project/change. `WORKFLOW_CHANGE` uses the standard specification, reviewed plan, increment, and task-review flow, then enters a separate EVALUATION gate. A manually dispatched evaluator from the integration branch checks an exact candidate SHA with read-only access and writes a canonical report. `evaluation.ingest` verifies the exact successful run, current evaluator commit, unique retained report artifact, report contents, current PR head, and candidate bundle version before persisting evidence; the gate revalidates the report hash and current head. | Evaluation import and progression to integration have deterministic API/archive coverage. Activation/migration still fail closed pending trusted activation authority, migration execution/rollback, and a protected operation boundary. Live evaluation acceptance remains pending. |
| W-021 | Operations and test profiles have bounded timeouts; resource locks fail closed; stale operation locks and recovery guards can be inspected and recovered by exact hash only when their owner PID is inactive; a durable reconciliation intent resumes interruption safely and blocks mutations until receipt; concurrent recovery retries transient Windows `EPERM` reads while retaining fail-closed behavior for persistent errors; test files run with a bounded concurrency of two to reduce process and filesystem contention; authenticated changes-requested review loops are recorded and capped at three. The opt-in Codex acceptance bounds `exec` and fresh-process `resume`, records best-effort usage when reported, and deletes a started test session even after a failed invocation. `workflow.resume` returns durable change state when sandbox Git access is denied, explicitly marks the repository unverified, and blocks the next mutation. | The Codex interactive session still has no connected cancellation/usage adapter. Live resume was tested under both `read-only` and `workspace-write` with `on-request`; on the current Windows host, nested Git inspection still returns `spawnSync git EPERM`, so successful identity restoration remains unverified. The test can require `verified:true` on a host that permits the nested read. No agent permission isolation is claimed. See the [Codex sandbox documentation](https://learn.chatgpt.com/docs/sandboxing). |
| W-022 | Setup doctor, acceptance-status report, and unrelated-project portability journey are delivered. The doctor probes the configured local Docker Engine and Compose v2 plugin with bounded calls and reports only sanitized versions/status. | Deterministic suite passes; live multi-image Docker Compose acceptance passes locally. The eight full end-to-end journeys and actual client/service acceptance remain pending as listed in [acceptance status](acceptance-status.md). |

W-003 pins ESLint through the lockfile and checks the workflow, script, and test JavaScript in CI. The flat configuration adds actionable diagnostics alongside syntax, bundle-integrity, and formatting checks; all run on the Ubuntu/Windows and Node 22/24 matrix.

## Current implementation boundary

The local runtime can initialize a repository profile, create a change branch, create and validate artifacts, validate plans, inspect and retrieve bounded repository context, discover test files, schedule registered checks by application and task/increment/merge/release cadence, execute the selected matrix sequentially with persisted per-profile results and fail-fast behavior, record supported Node test-runner TDD evidence, prepare task records, verify task results against fresh planned runs and pushed scoped checkpoints, place verified tasks in `WAITING_REVIEW`, and create scoped local Git commits with optional push. Designated test-author tasks can submit current, fully explained behavioral RED runs for independent review without certifying GREEN or task completion. FEATURE, MAINTENANCE, and WORKFLOW_CHANGE use requirements, planning, implementation-plan coverage, task ownership, and sequential increment gates; BUGFIX implementers require an approved unchanged defect report and evidence-backed RED dependencies. MAINTENANCE plans explicitly marked `NO_FILE` instead require reviewed GREEN test-author evidence and empty file ownership, while retaining task reviews and normal integration gates. WORKFLOW_CHANGE stays pinned to its starting bundle and requires a distinct EVALUATION stage before integration; trusted GitHub Actions evidence can now be verified and imported by the local gate, with live evaluator acceptance still pending. Maintenance selects test profiles by impact; unknown impact requires broader application and system checks. A bare-remote/API fixture completes two genuine feature RED/review/GREEN increments, blocks the second until the first is accepted, rejects a mismatched task definition, and proves that integration waits for both increments. Stale operation locks can be inspected and recovered against their exact content hash when their owner PID is inactive; recovery receipts are retained. Projects and changes pin a deterministic SHA-256 identity over the bundle version and installed source files; a version cannot be silently reused for different content. Project-initialization gates enforce artifact integrity, current authenticated decisions, expected revisions, and bootstrap squash-merge evidence. A bare-remote/API fixture completes the full two-increment feature journey through whole-change review, current CI, authenticated plan approval, PR readiness, squash merge, and the completion gate; live GitHub/native acceptance remains outstanding. No-file maintenance traverses current review, plan approval, CI, PR readiness, and squash merge without an empty commit. Initialization, defect, maintenance, and workflow-change routes are implemented; route guidance does not substitute for executable gates. Authenticated task-review adapters record accepted/changes-requested outcomes; readiness, stage advancement, increment advancement, and squash merge refresh accepted task reviews to invalidate late changes-requested outcomes, and the third unresolved attempt blocks the task for human escalation. Native reviewer authority and the protected W-006 capability boundary remain unverified. The distributable bundle includes nine skills, eleven native agent role definitions, and fifty-seven artifact formats.

These primitives do not yet form a fully gated autonomous SDLC. Draft PR creation/refresh, exact-head CI inspection and bounded polling, task review resolution, artifact-bound business decision ingestion, PR readiness, and expected-head squash merge have GitHub REST adapters covered by deterministic API doubles, but they have not passed live repository acceptance. In multi-application projects, plan validation requires every increment to declare known application IDs. Feature task/increment test scope is derived from the current reviewed plan increment; an absent or unknown application scope expands to all configured applications and caller attempts to narrow it are rejected. Scheduled test execution refuses partial application coverage before running commands, and category cadence floors prevent expensive test types from running on an earlier-than-planned cadence. Initial opt-in GitHub Actions templates now build configured image matrices and publish source/run-scoped GHCR candidates; deterministic tooling validates the project catalog and complete digest-bound candidate set. The candidate template runs the configured Compose acceptance service against exact published digests. Both Compose acceptance jobs use per-run project names, retain sanitized service status on failure, and clean only that project's resources. A separate protected-environment workflow can publish a GitHub Release manifest referring to the tested digests without rebuilding or retagging images. Local Compose deploy/verify/recover operations use exact-digest overrides, health checks, bounded waits, ordered digest-pinned migration services, declared compatibility/recovery guidance, durable status, and non-destructive recovery; deterministic command tests pass, as does an opt-in live web/API smoke deploying separate immutable public image digests, verifying service health, and exercising web-to-API HTTP traffic over the Compose network. Private GHCR and GitHub acceptance remain unverified, and the workflow does not automate database rollback. Release activation and bundle migration remain unavailable. Codex discovery, specialist handoff and isolation have not been verified on an installed target. Local JSON state is project data, not a security boundary. Continue to report those limits until their plan tasks are implemented and live acceptance checks pass.

## 1. Portability and configuration baseline

The workflow is a reusable system, not a description of the machine or repository on which this plan was prepared. Do not encode an absolute repository path, account, remote URL, baseline commit, installed version, or local diagnostic as a workflow assumption.

A validated project profile supplies:

- Repository root, repository identity, Git remote, base branch, and branch naming policy.
- GitHub repository/App references, permitted human decision sources, GHCR destinations, and credential references rather than secret values.
- Supported Codex client capabilities, bundle installation bindings, role/model settings, operation access, and tested permission/isolation settings.
- Application/contract catalog, operation bindings, test/build profiles, and target environment references, completed during project Stage 0 as appropriate.
- Runtime state/evidence locations, retention, supported host capabilities, and deployment locking scope.

Discover and validate actual capabilities through a setup operation before side effects. Preserve existing repository instructions and user work. A project profile configures the workflow; it does not permit overriding protected approval or privilege rules. Runtime diagnostics belong to the current run's evidence, not to the reusable plan.

References to `main` below mean the configured integration branch. Example branch names and workflow-owned paths are conventions rather than fixed project locations.

## 2. Implementation architecture decisions

Codex is the selected initial execution host. Reuse its main session, skills, and native custom subagents rather than building another agent runtime. W-001 specifies bundle contracts, selects the language/tooling for registered operations and gate validators, and justifies durable storage. No database is mandatory. These decisions are separate from each target application's Stage 0 architecture.

| Concern | Required responsibility and decision |
| --- | --- |
| Coordinator | The main Codex agent follows a dedicated entry skill and delegates to native specialist subagents. It reads durable state on start/resume. Do not build an independent scheduler or LLM loop. |
| Gate validation | A small deterministic layer checks legal transitions, current evidence, task dependencies, and human decisions before operations have effects. It is not a second agent runtime. |
| State | Durable state/events, operation receipts, schema migrations, atomic updates, crash recovery, and explicit locking. Evaluate a minimal file-backed implementation; adopt a database only if justified. Keep authoritative data outside untrusted agent-writable worktrees. |
| Contracts | Versioned JSON Schema for machine records; Markdown documents with structured metadata and explicit section contracts for human-readable artifacts. Generate both from one canonical artifact model. |
| Agent execution | Native Codex custom subagents and supported session controls. Define bounded task/result records and independent author/reviewer handoffs. No subprocess-based executor or SDK service is required for initial interactive operation. |
| Agent privilege boundary | Registered operations and configured external controls protect authoritative state, approvals, credentials, merge, publication, and activation. Native subagents inherit parent permissions; role text alone does not isolate them. W-002 must prove the actual boundary. |
| Operations | Schema-validated executable entry points, safe process arguments, declared effects, expected revisions, idempotency/reconciliation, and structured receipts. Select script/runtime bindings for supported hosts. |
| MCP integration | Use the same operations through an MCP facade when needed for controlled capabilities or plugin packaging. Choose this binding in W-001/W-002; do not duplicate operation logic or build a service solely to replace native delegation. |
| GitHub | An adapter with verified API/event behavior, configured destination, a GitHub App installation identity for automated repository/PR operations, and a separate verified human decision source. Use job-scoped `GITHUB_TOKEN` for authorized GHCR publishing. |
| Verification | Select and pin a test runner, formatter, linter, and applicable type/static checks for the chosen runtime. Test actual temporary repositories and the chosen persistence backend; separate deterministic doubles from live checks. |
| CI | GitHub Actions invokes the same registered checks used locally. Start deterministic CI in W-003 and extend it as integrations become available. Pin third-party actions to reviewed immutable commits. |
| Application support | A versioned application catalog declares dependencies, contracts, test profiles, build adapters, artifact types, readiness, and deployability. Do not hard-code web/backend/mobile paths or assume every app is a container. |
| Initial scope | A reusable Codex bundle for one repository with potentially multiple applications, serial branch mutations, private GHCR, Compose delivery, and a non-container adapter fixture. Production hosting, stores, multiple repositories, unattended scheduling, and a separate dashboard remain extensions. |

If W-002 cannot enforce a required protected capability on the selected Codex surface, keep that action blocked and identify the needed operation boundary, trusted decision source, or isolation configuration. Do not silently introduce another runtime or replace enforcement with instructions. Here, controller means the small operation/state layer; coordination remains in Codex.

## 3. Proposed workflow-owned layout

```text
docs/workflow/             Requirements, scenarios, plan, ADRs, operation reference
workflow/                 Bundle sources, schemas/templates, gate/state support, skill assets
tests/workflow/           Unit, integration, end-to-end, fixtures, evaluation cases
scripts/workflow/         Thin entry points where required
.github/workflows/        Deterministic CI and authorized artifact pipelines
```

Exact subdirectories are finalized in W-001. Do not create application directories until application Stage 0. W-011 packages the coordinator/specialist skills and native Codex agent definitions; W-012 installs their owned files into supported project locations, preserves existing configuration, and reports required reloads. Plugin packaging is optional; installation must not silently write global user configuration.

Runtime state stores, credentials, reports, temporary worktrees, and test environments are not source artifacts. Their locations, access rules, ignore rules, cleanup, backup, and evidence retention are explicit W-005/W-007 outputs.

## 4. Delivery rules for implementing the workflow

Each task below has a single implementation owner and independent test/review ownership. Before behavioral implementation, a test author selects the mapped acceptance scenarios and writes meaningful tests; a test reviewer verifies their quality and RED. Minimal runner/contracts may be bootstrapped without business behavior where necessary.

Use the current Codex session to coordinate bootstrap tasks; do not pretend the entry skill or state operations are already installed. Native delegation may be used as available, with explicit specialist ownership. Before claiming the bundle is operational, pass W-022. A human decision comes only from actual user input or a configured authenticated decision channel; tool-execution approval is not automatically business acceptance.

At implementation start, create `workflow/W-000-bootstrap` for the first bounded foundation increment and its draft PR. Subsequent independently reviewable increments use `workflow/W-<id>-<slug>`; small tasks within one increment share its branch. This is not one long-lived branch for all 22 tasks.

After a task satisfies its checks/review, commit its owned diff and push. A no-file task records its result without an empty commit. An intentional RED test checkpoint is allowed. Before PR creation, the completed increment must be green and reviewed as a whole. The user reviews and merges the ready PR manually; do not bypass branch protection.

Review artifacts and task completion are controller-verified records, not free-form claims. Initial bootstrap records are labelled host-coordinated and later imported with provenance rather than fabricated as engine-generated evidence.

## 5. State, version, and evidence decisions

- Separate change stage/status, task state, operation execution, review, approval, release state, and deployment state. A task can be DONE while its feature remains incomplete.
- Stage statuses: `READY`, `RUNNING`, `WAITING_REVIEW`, `WAITING_HUMAN`, `CHANGES_REQUESTED`, `BLOCKED`, `PASSED`, `CANCELLED`.
- Task lifecycle includes `CHECKPOINT_PENDING`; a successful commit followed by failed push is not DONE until reconciled. No-file tasks can complete from verified results.
- Operation identity includes change/task ID, operation/version, normalized inputs, and expected revisions. Record local and external effects so retries reconcile before repeating mutations.
- Business approval binds the normalized business artifact hash and its explicit version. Adding a task report must not invalidate unrelated business acceptance.
- Code acceptance binds the reviewed change revision and intended target/integration candidate. A target move requires revalidation; changed reviewed code requires appropriate renewed acceptance.
- Verification evidence identifies source tree/revision, test definitions, configuration/environment fingerprints, profile, command, raw outcome, classification, and timestamps. A nonzero exit is not automatically valid RED.
- Pre-commit evidence can bind a Git tree and relevant inputs; after checkpoint, record the commit containing that tree. Evidence generated by tests must not invalidate itself merely because an unrelated report file was added.
- Workflow bundles are immutable gate/state-support, role/skill, operation, schema, and template manifests with declared Codex capability compatibility. Pin resources per change and record actual host capabilities; merging a candidate does not activate it.
- Session history supports interaction but is not authoritative durable workflow state. Re-invocation in a new conversation resumes from verified records and actual effects. Closing the client does not imply background execution.
- Default serial execution. Read-only parallel analysis is possible; concurrent writers require isolated worktrees, disjoint ownership, explicit integration, and tested locks.

## 6. Task plan

Every task has the common delivery protocol in section 4. Dependency IDs refer to completed, verified tasks, not merely files existing on a branch.

### W-001 — Freeze executable contracts and workflow architecture

- Owner: architect; independent specification/plan reviewer.
- Depends on: none.
- Deliver: refine this baseline around the selected Codex architecture; define entry/specialist skill contracts, native agent handoffs, supported Codex surfaces, project-profile contract, canonical artifact inventory, protected state/approval boundaries, operation/MCP bindings, and English authoring rules. Select operation tooling and minimal durable storage through ADRs without prescribing a database or custom agent runtime. Define bundle-owned layout without defining product layout.
- Acceptance: no unresolved semantic conflict between requirements, state transitions, Git checkpoints, and human decisions; every standard artifact type has an assigned schema/template/generator approach.
- Verification: AC-001–AC-008, AC-014, AC-017, AC-020, AC-027, AC-030, AC-043, AC-047–AC-050 reviewed as contracts; structural examples are prepared for executable tests in W-004.

### W-002 — Prove native Codex delegation and operation boundaries

- Owner: integration implementer; independent security-relevant implementation reviewer.
- Depends on: W-001.
- Deliver: disposable capability spike for entry-skill discovery/invocation, native custom-agent handoff, independent author/reviewer executions, structured artifacts, cancellation, inherited permissions, script/MCP access, and protected authoritative state/actions on the selected Codex surface.
- Acceptance: required protected actions and human decisions cannot be forged through worker output or direct shell access; record actual supported controls and any required MCP boundary. Do not claim a reviewer has a separate read-only sandbox merely because its instructions say so. No second agent runtime is started.
- Verification: AC-017, AC-027, AC-028, AC-046, AC-048–AC-050; include incomplete results, cancellation, and unsupported-client behavior. Deterministic fixtures and live Codex capability evidence are separate layers.

### W-003 — Establish bundle tooling, test runner, and early CI

- Owner: tooling implementer; independent test reviewer.
- Depends on: W-001.
- Deliver: bundle source manifest, minimal operation/gate tooling in the selected language, pinned dependencies, test runner/formatter/linter/static checks, English coding/test standards, and deterministic CI for supported hosts without publishing credentials. Do not scaffold a custom agent application.
- Acceptance: fresh checkout installs and runs a real failing/passing contract example; formatting/type diagnostics are actionable; no implementation is smuggled into bootstrap tests.
- Verification: AC-001, AC-010, AC-011, AC-016, AC-032 using baseline smoke/contract checks.

### W-004 — Generate and validate versioned artifacts

- Owner: contract/template implementer; independent semantic reviewer.
- Depends on: W-001, W-003.
- Deliver: schemas, Markdown contracts, templates, generation and validation operations for the complete artifact inventory and project profile, shared ID/reference rules, and representative examples for all change types and unrelated target projects.
- Acceptance: typed inputs generate readable English artifacts; required unknowns are explicit; duplicate IDs, missing sections, invalid references, and forged machine evidence fail validation. Review/approval placeholders never count as real decisions.
- Verification: AC-001, AC-005, AC-007, AC-020, AC-045, AC-047.

### W-005 — Persist changes, tasks, events, and recovery receipts

- Owner: persistence implementer; independent implementation reviewer.
- Depends on: W-003, W-004.
- Deliver: minimal durable records using the selected storage implementation, schema versioning, atomic state/events, operation receipts, protected configurable paths, retention/export/backup rules, and interruption recovery primitives. A database is optional, not an acceptance prerequisite.
- Acceptance: restart preserves state and evidence; committed external effects are not blindly repeated; stale writes conflict; agents cannot edit authoritative records.
- Verification: AC-024, AC-028–AC-030, AC-044, AC-049 with actual durable storage and injected interruption points, including a fresh-conversation resume.

### W-006 — Enforce transitions, approvals, and evidence freshness

- Owner: gate-validation implementer; independent test and implementation reviewers.
- Depends on: W-004, W-005.
- Deliver: transition/gate validators used by operations, dependency readiness, trusted user/GitHub decision ingestion, content/revision binding, invalidation handling, and separate task/change/release records. Stage routing belongs to the coordinator skill; do not implement a second agent scheduler.
- Acceptance: neither an agent assertion nor stale evidence advances a gated stage; invalidation affects the relevant subject rather than all unrelated approvals; integration and deployment are different states.
- Verification: AC-002, AC-003, AC-006, AC-012, AC-017, AC-025, AC-030, AC-043, AC-046.

### W-007 — Execute registered operations with reconciliation

- Owner: operation-runtime implementer; independent implementation reviewer.
- Depends on: W-002, W-004–W-006.
- Deliver: operation registry and script interface, role capabilities, typed requests/results, safe arguments, timeouts/cancellation, expected revisions, scoped effects, reconciliation, and dry-run boundaries. Implement the MCP facade if selected by W-001/W-002; it delegates to the same operations and does not own a second workflow implementation.
- Acceptance: unknown/disallowed operations cannot execute; timeout cleanup is bounded; a dry run never produces a live success receipt; environment/command errors are not business failures.
- Verification: AC-011, AC-024, AC-027–AC-031, AC-046.

### W-008 — Automate scoped Git branches and task checkpoints

- Owner: Git integration implementer; independent reviewer.
- Depends on: W-005–W-007.
- Deliver: repository inspection, change branch creation, task-scoped diff selection, commit/push receipts, expected tree/SHA checks, no-op handling, dirty-worktree protection, and reconciliation.
- Acceptance: repeated start/checkpoint does not duplicate work; unrelated edits are preserved; failed push resumes the existing commit; task state reaches DONE only after its required checkpoint completes.
- Verification: AC-021–AC-024, AC-029, AC-030 with real temporary repositories and local bare remotes, including spaces in paths.

### W-009 — Automate PR creation and verify user merge

- Owner: GitHub integration implementer; independent reviewer.
- Depends on: W-006–W-008.
- Deliver: configured GitHub adapter, GitHub App token provisioning interface, ready PR ensure/refresh, explicit chat-decision recording, current check inspection, manual merge confirmation, and safe cleanup. The user performs PR review and merge; workflow code does not merge.
- Acceptance: exactly one ready PR; business decisions bind to current artifact content; protected main is not bypassed; required PR/main workflows actually trigger under the chosen identity. Treat changed integration targets as revalidation, not permission to merge stale results.
- Verification: AC-006, AC-017, AC-021, AC-025, AC-026, AC-034. Deterministic API tests first; live checks require an authorized test repository and App installation.

### W-010 — Retrieve bounded repository context on demand

- Owner: context implementer; independent reviewer.
- Depends on: W-004, W-007.
- Deliver: context prepare/refresh, bounded search/read, test discovery, source/revision records, capability index loading, and conflicting-source diagnostics against the configured repository/application layout. Use `rg` where available with a documented fallback.
- Acceptance: description-only intake is sufficient; no complete repository dump; source content remains data rather than new controller instructions; stale context is detected and relevant gaps are exposed.
- Verification: AC-004, AC-018, AC-019, AC-047 against small, large, and unrelated fixture repositories.

### W-011 — Author coordinator and specialist skills with native agent definitions

- Owner: role/skill author; independent specification reviewer.
- Depends on: W-004, W-007, W-010.
- Deliver: English entry/coordinator skill, specialist skills, native Codex custom-agent definitions, bounded task/result contracts, operation references, escalation rules, reviewer checklists, and bundle resources. Verify supported project conventions without embedding account or application paths.
- Acceptance: the entry skill routes start/inspect/resume intents; every agreed specialist has bounded responsibilities; skills use canonical operations; reviewers retrieve sources independently; models remain profile configuration and roles do not invent permission isolation.
- Verification: AC-009, AC-013, AC-017, AC-018, AC-027, AC-048, AC-050 using role/skill contract checks and evaluation cases.

### W-012 — Install and invoke the Codex workflow bundle

- Owner: Codex bundle-integration implementer; independent implementation reviewer.
- Depends on: W-002, W-007, W-010, W-011.
- Deliver: a repeatable `workflow.setup` operation invoked from the cloned workflow repository with a user-selected target folder; conflict-safe installation of bundle-owned assets; local Git initialization and one baseline commit for an empty target without remote creation; a workflow-only setup commit on the checked-out base branch for a clean existing repository; preservation of existing repository history; native agent/skill registration, script/MCP binding setup, capability preflight, declared reload instructions, and a verified entry-skill-to-native-specialist handoff. Optional plugin packaging wraps these assets without replacing Codex execution.
- Acceptance: both empty and existing clean Git targets are supported; setup refuses a dirty or conflicting target without overwriting project files; retries are idempotent; setup creates no remote; Stage 0 cannot start against the workflow source checkout by default and begins only after the installed target is opened in Codex; malformed specialist artifacts cannot complete tasks; author/reviewer executions are distinct; absent capabilities/authentication are explicit. Only actual post-reload invocation can certify availability.
- Verification: AC-017, AC-018, AC-027, AC-028, AC-031, AC-046, AC-048–AC-051. Deterministic installation fixtures first; live client installation/invocation is required for operational acceptance.

### W-013 — Validate vertical plans and select test profiles

- Owner: planning/test-policy implementer; independent plan reviewer.
- Depends on: W-004, W-006, W-010.
- Deliver: application/contract catalog, plan validation, DAG and ownership checks, requirement/scenario/task/test traceability, impact selection, and focused/fast/integration/acceptance/artifact/release profile contracts.
- Acceptance: increments deliver observable behavior; technical subtasks support them; required applications and contract consumers are covered; unknown impact expands testing; no universal all-tests-after-every-edit rule.
- Verification: AC-007, AC-008, AC-014, AC-015, AC-039.

### W-014 — Implement coordinator skills for discovery, scenarios, planning, and review

- Owner: orchestration implementer; independent reviewer.
- Depends on: W-006, W-009–W-013.
- Deliver: entry/coordinator skill routing for description-only intake, source retrieval, targeted clarification, stable requirement/scenario IDs, native specialist handoffs, independent review loops, human acceptance, and reviewed plan handoff using registered state/gate operations.
- Acceptance: stages 1–3 run through registered operations; only unresolved business decisions reach the user; no implementation starts before valid inputs and gates; checkpoint and draft PR rules apply throughout.
- Verification: AC-004–AC-008, AC-017–AC-021, AC-031, AC-045, AC-048, AC-049 with a deterministic discovery-to-plan journey and separate live native-delegation evidence.

### W-015 — Implement skill-driven TDD and whole-feature review

- Owner: TDD orchestration implementer; independent test and implementation reviewers.
- Depends on: W-008, W-009, W-012–W-014.
- Deliver: coordinator/specialist skill procedures and operation support for per-increment test author/reviewer handoffs, RED classification, native implementer delegation, GREEN/refactor verification, test-change requests, per-task checkpoints, increment review, documentation, and final feature review/merge handoff.
- Acceptance: stages 4–5 alternate for small increments; task DONE does not complete the feature; all required current checks and human acceptance precede squash merge; readability/standards are explicit review criteria.
- Verification: AC-009–AC-017, AC-022–AC-026, AC-045 using at least two increments and an interrupted checkpoint.

### W-016 — Extend GitHub Actions with application and system test matrices

- Owner: CI implementer; independent reviewer.
- Depends on: W-009, W-013, W-015.
- Deliver: draft/ready/main event policy, application impact matrix, focused/fast/acceptance/system jobs, current-revision status aggregation, retained diagnostics, and cancellation of superseded PR runs.
- Acceptance: PR jobs do not publish; known workflow/contract changes trigger broader regression; final acceptance cannot be bypassed by an empty matrix or skipped required check; old runs cannot certify a new revision.
- Verification: AC-014, AC-015, AC-025, AC-032, AC-034, AC-045, AC-046. Include live observation of automated PR and merge events.

### W-017 — Build private GHCR candidates and promote verified releases

- Owner: release implementer; independent reviewer.
- Depends on: W-007, W-009, W-013, W-016.
- Deliver: build adapters, pre-publication GHCR visibility checks, main-only publication, source/SHA metadata, candidate manifests, immutable artifact identity, release promotion, version conflict checks, and GitHub Release output.
- Acceptance: publication is a candidate state; verification is a separate gate; retries do not overwrite version identities; promotion reuses tested digests; release metadata does not create a self-triggering source commit loop.
- Verification: AC-033, AC-036, AC-039, AC-046 with registry doubles followed by a private live package. Artifact verification receipts come from W-018.

### W-018 — Verify Compose sets and deploy locally with data-aware recovery

- Owner: deployment implementer; independent reviewer.
- Depends on: W-007, W-013, W-017.
- Deliver: exact-digest Compose environment creation, readiness/migration sequencing, system tests, diagnostics and CI cleanup, local deployment locking, state recording, manifest selection, and compatibility-aware recovery.
- Acceptance: CI cleanup works after failure; local persistent data is not deleted; deployment reports actual readiness/behavior; incompatible database rollback requires the declared recovery path; successful verification enables W-017 promotion.
- Verification: AC-030, AC-035–AC-039 using Docker integration fixtures, then GHCR round-trip and a local deployment with disposable data.

### W-019 — Complete initialization, defect, and maintenance playbooks

- Owner: workflow-route implementer; independent specification and code reviewers.
- Depends on: W-014, W-015, W-018.
- Deliver: entry/specialist skill routes and operation support for Stage 0 product/architecture gates and bootstrap; defect reproduction/intent triage/regression; maintenance impact-based stage selection and no-file tasks.
- Acceptance: Stage 0 elicits rather than assumes product scope; a valid bug uses approved intent; ambiguous behavior returns to specification; an already-fixed deployment is identified; omitted maintenance steps require an explicit policy reason.
- Verification: AC-002, AC-003, AC-023, AC-040, AC-041 plus full initialization/bug-fix journeys.

### W-020 — Version, evaluate, activate, and migrate the workflow

- Owner: workflow-lifecycle implementer; independent reviewer.
- Depends on: W-005–W-007, W-012, W-019.
- Deliver: immutable skill/agent/operation/schema/template/gate bundle manifests, declared Codex capability compatibility, per-change pinning, workflow-change skill route, evaluations, activation gates, migrations, rollback checks, and required reload detection.
- Acceptance: a candidate cannot govern its own acceptance; merge is not activation; existing runs retain their bundle; critical changes need a real human decision; failed migration preserves recoverable state.
- Verification: AC-028, AC-042–AC-044, AC-046 and a complete isolated workflow-upgrade journey.

### W-021 — Enforce budgets, isolation, and operational recovery

- Owner: reliability implementer; independent reviewer.
- Depends on: W-005–W-007, W-012, W-015, W-018, W-020.
- Deliver: bounded operation time/retry limits, recorded review-loop attempts, native session usage/cancellation integration where supported, locks, fresh-conversation recovery, isolated parallel handoff rules, and diagnostics. Do not create an unattended scheduler to implement these controls.
- Acceptance: loops stop at verified operation/task boundaries; unavailable host token/cost/cancellation controls are reported honestly rather than fabricated; writers do not race; parallel outputs are ownership-checked. Default remains serial and client closure does not imply continued execution.
- Verification: AC-024, AC-028–AC-031, AC-037, AC-044, AC-046, AC-049, AC-050 using fault injection, client interruption, and operation process interruption on supported platforms.

### W-022 — Run acceptance journeys and publish the operator guide

- Owner: acceptance/test author and documentation author; independent final code reviewer.
- Depends on: W-016–W-021.
- Deliver: executable full journeys, bundle installation/invocation/resume guide, operation reference, setup doctor, live-integration checklist, accurate capability index, and workflow version 1 readiness report.
- Acceptance: invoke the bundle from Codex, initialize a fixture project, deliver a cross-application feature, fix a defect, and upgrade the workflow. Resume in a new conversation and run against unrelated projects without source edits. Distinguish deterministic tests, native client checks, external integrations, and pending prerequisites.
- Verification: AC-001–AC-050 with explicit per-layer evidence; all eight required end-to-end journeys; actual Codex entry-skill/native-specialist invocation, private GHCR round-trip, authorized GitHub PR/squash lifecycle, and human activation of the initial usable bundle.

## 7. Milestones and reviewable increments

| Milestone | Tasks | Demonstrable outcome |
| --- | --- | --- |
| M1: native capability and operation foundation | W-001–W-007 | Codex capability proof, validated artifacts, minimal durable state, trustworthy gate checks, and registered operations with early CI |
| M2: invocable Codex workflow | W-008–W-014 | Installed entry skill delegates to specialists; a description becomes an accepted specification and reviewed plan on one branch/draft PR |
| M3: integrated functional increment | W-015–W-016 | Two small increments complete through TDD, scoped task commits, reviews, real CI, and approved squash integration |
| M4: delivered compatible system | W-017–W-019 | Verified private images/non-container fixture package, manifest promotion, local Compose deployment, initialization and defect routes |
| M5: maintainable workflow | W-020–W-022 | Controlled workflow upgrades, recovery/limits, complete acceptance journeys, live evidence, and operator documentation |

Milestones are not automatic branch boundaries. Split them into independently useful, green, reviewed increments; never merge deliberately broken unfinished behavior solely to meet a milestone date.

## 8. Verification schedule for workflow development

| Trigger | Required verification |
| --- | --- |
| TDD edit | Relevant focused tests; include fast integrations when they are the subject of the task |
| Task checkpoint | Format/lint/type checks and relevant regression; an explicit reviewed RED task records expected failure separately |
| Completed increment | Relevant integration/contract tests and independent increment review |
| PR ready / merge | Full workflow unit and integration suites, required system journeys, whole-change review, current integration candidate, and human acceptance |
| Main candidate | Verify merged source and artifact packaging; where images are produced, pull exact published digests for Compose/system verification |
| Release | Confirm the selected candidate's complete evidence; do not duplicate unchanged checks or rebuild artifacts merely to attach a version |
| Scheduled evaluation | Expanded fault/platform/agent evaluations; required feature verification never waits until the schedule |

Initial workflow E2E journeys should be small enough to run before merge. Expand slower cross-platform/live matrices according to measured cost and risk, without moving critical regression exclusively after merge. If impact cannot be bounded, run a conservative broader suite. Time budgets are planning signals, not permission to skip required checks.

## 9. Registered operation surface

The following names are registered by the current local CLI. They use structured JSON requests and results and English operation help; the Codex coordinator skill is the user-facing entry point. This inventory includes supporting operations added as the implementation matured.

- Workflow and bundle: `workflow.setup`, `workflow.init`, `workflow.inspect`, `workflow.resume`, `workflow.doctor`, `workflow.lock.inspect`, `workflow.lock.recover`, `bundle.inspect`, `bundle.install`, `bundle.preflight`.
- Artifact and context: `artifact.create`, `artifact.validate`, `spec.validate`, `plan.validate`, `context.prepare`, `context.refresh`, `repo.search`, `repo.read`, `tests.find`.
- Verification and TDD: `test.schedule`, `tests.run_scheduled`, `tests.run`, `tdd.record`, `quality.check`.
- Tasks and gates: `task.prepare`, `task.record_result`, `review.request`, `review.resolve`, `decision.accept`, `increment.inspect`, `increment.advance`, `stage.inspect`, `stage.advance`.
- Changes and GitHub: `change.start`, `change.route`, `change.checkpoint`, `change.cleanup`, `pr.ensure`, `pr.refresh`, `change.confirm_merge`, `ci.inspect`, `ci.await`, `evaluation.ingest`.
- Delivery: `images.publish`, `images.verify`, `release.publish`, `deploy.local`, `deploy.verify`, `deploy.recover`.
- Lifecycle placeholders: `workflow.activate` and `workflow.migrate` are registered fail-closed endpoints; they do not activate a bundle or mutate pinned state until trusted authority and protected execution boundaries are implemented.

Operation schemas, permissions, preconditions, side effects, reconciliation, timeouts, evidence, and examples remain the contract for each command. Native Codex delegation and cancellation are host capabilities, not emulated operations. Agent-facing operation access must never expose human activation or approval authority.

## 10. External setup and activation checklist

Plan and deterministic implementation can proceed without live credentials. Complete these prerequisites before their respective live acceptance tasks:

1. Validate the target profile and selected Codex client's skills/custom-agent support, authentication, native delegation, operation access, required reloads, trusted decision channel, and permission/isolation boundaries. Record diagnostics without making them universal project assumptions.
2. Provision a narrowly scoped GitHub App for the intended repository and verify push/PR/merge workflow events. Do not grant branch-protection bypass. Set the Actions repository variable `WORKFLOW_BASE_BRANCH` when the configured protected integration branch differs from the repository default branch.
3. Configure allowed human reviewers/decision sources and protect main with required checks/reviews under the actual account capabilities.
4. Verify private GHCR package creation/linking/access, job-scoped publishing permissions, and local read authentication without recording credentials in source or logs.
5. Verify Docker daemon operation, required resources/platforms, and disposable local data paths.
6. Define artifact retention and ensure release manifests remain resolvable after short-lived CI logs expire.
7. Configure app-specific native tooling/signing only if the project architecture selects native applications. A fixture adapter demonstrates extensibility, not a working production mobile release.
8. Review the initial workflow bundle and explicitly activate it only after acceptance evidence is available.

Where account features or credentials are unavailable, record the precise pending prerequisite. Do not report mock success as live completion or weaken gates to proceed.

## 11. Integration references and selection rules

- [Codex integration architecture](codex-integration.md) records the selected native orchestration direction and official skill/subagent/MCP references. Operation tooling, minimal storage, client compatibility, and installation bindings are finalized in W-001 and verified in W-002. No planning-machine language, database, account, or path is a project requirement.
- [GitHub Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) and [package access](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility): publishing, private access, source association, and digest identity.
- [GitHub workflow trigger behavior](https://docs.github.com/en/actions/concepts/security/github_token): choose automation identity and verify actual event behavior rather than assume a token-triggered push starts every downstream job.
- [Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/): dependency readiness and successful migration sequencing.

The implementation must re-check platform documentation and pin dependencies/actions when creating executable integrations; this plan does not lock today's remote behavior indefinitely.
