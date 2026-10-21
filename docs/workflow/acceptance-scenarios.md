# Workflow Acceptance Scenarios

Status: planned acceptance behavior, not test execution evidence. Scenario IDs remain stable. Concrete test names must describe behavior in English; IDs belong in metadata or traceability records.

Each implementation task selects these scenarios, adds meaningful boundary cases, and follows test-author review before behavioral implementation. Use real temporary Git repositories, filesystem state, and the selected persistence backend for local integration tests. Use deterministic external-service doubles for repeatable tests and separately labelled live checks for GitHub, the configured agent executor, Docker, and GHCR.

| ID | Requirements | Given / When / Then |
| --- | --- | --- |
| AC-001 | WF-001 | Given a non-English intake, when workflow-owned artifacts are generated, then their structure, identifiers, instructions, and generated prose are English while original evidence and meaning remain available. |
| AC-002 | WF-002 | Given only a project idea, when Stage 0 starts, then the author elicits the product goal and MVP; architecture finalization waits for their human acceptance. |
| AC-003 | WF-002, WF-011 | Given accepted product boundaries, when architecture is reviewed and accepted, then application structure and enforceable implementation/test standards are recorded before dependent bootstrap. |
| AC-004 | WF-003, WF-013 | Given a feature description and existing repository documents, when intake runs, then context is retrieved without asking the user to paste known project material. |
| AC-005 | WF-004, WF-014 | Given a revised specification, when it is validated, then IDs remain stable, references resolve, coverage is checked, and unresolved blocking decisions prevent acceptance. |
| AC-006 | WF-004, WF-018 | Given reviewed scenarios, when an authorized human accepts their content hash, then planning is permitted; changing business meaning invalidates that acceptance. |
| AC-007 | WF-005 | Given accepted scenarios, when a plan is reviewed, then every scenario has bounded implementing/verifying tasks with acyclic dependencies, ownership, and observable completion criteria. |
| AC-008 | WF-006 | Given a feature affecting two clients and a service, when planning runs, then the impact map includes required changes, contracts, application checks, and system checks; an unaffected application is not modified. |
| AC-009 | WF-007, WF-010 | Given the next increment, when a test author submits tests, then an independent reviewer assesses behavior, naming, setup readability, assertions, fixtures, isolation, and duplication before acceptance. |
| AC-010 | WF-008 | Given a runnable test that fails on the specified missing behavior, when RED is recorded, then evidence includes the source tree, test identity, command/profile, and observed failure. |
| AC-011 | WF-008 | Given an import error, missing dependency, or unavailable database, when test execution fails, then it is an execution/environment problem and not certified RED. |
| AC-012 | WF-007, WF-009 | Given an accepted RED task, when implementation proceeds, then focused checks run during TDD, applicable regression runs after refactoring, and task completion requires current GREEN evidence. |
| AC-013 | WF-007, WF-018 | Given an implementer discovers a questionable assertion, when a change is requested, then test-author/reviewer handling is required; weakening it directly cannot pass task validation. |
| AC-014 | WF-009 | Given a small internal change, when an inner-loop check runs, then only its registered focused/fast profiles run; before merge the complete required acceptance profile remains mandatory. |
| AC-015 | WF-006, WF-009 | Given a shared contract change or incomplete impact information, when test selection runs, then dependent applications or a conservative broader suite are included. |
| AC-016 | WF-011 | Given a forbidden dependency or formatting violation, when task checks run, then completion is rejected with an actionable diagnostic. |
| AC-017 | WF-012, WF-018 | Given an agent result claiming reviewer or human approval, when gate validation evaluates it, then the claim does not satisfy independently sourced review/approval requirements. |
| AC-018 | WF-013 | Given a large repository, when an agent searches and reads code, then results are bounded, revision-labelled, and source-linked; unrelated complete source trees are not injected. |
| AC-019 | WF-013, WF-029 | Given conflicting implemented, approved, and planned descriptions, when context is prepared, then the conflict is exposed and those categories are not merged into a false capability claim. |
| AC-020 | WF-014 | Given malformed artifacts, duplicate IDs, or missing references, when validation runs, then it fails deterministically; a structurally valid artifact still requires semantic review. |
| AC-021 | WF-015 | Given an accepted intake and a verified main SHA, when change start and first checkpoint are retried, then exactly one branch and one draft PR exist. |
| AC-022 | WF-016 | Given a completed task and unrelated local edits, when checkpoint runs, then only owned approved changes are committed and pushed; uncertain ownership blocks the operation. |
| AC-023 | WF-016 | Given a task with no repository diff, when checkpoint runs, then no empty commit is created and the non-file result remains recorded. |
| AC-024 | WF-016, WF-020 | Given a successful local commit and failed push, when execution resumes, then the existing commit is reconciled and pushed once before task DONE is recorded. |
| AC-025 | WF-017, WF-018 | Given all tasks complete, when the user manually reviews and merges the ready PR, then stage advancement confirms the merged PR through GitHub and continues without a workflow-side PR approval or merge action. |
| AC-026 | WF-017 | Given an approved verified feature, when merge completes, then main receives one squash commit; cleanup confirms remote merge and preserves unsaved local work. |
| AC-027 | WF-019 | Given an unknown operation or disallowed parameters, when an agent requests execution, then it is rejected without arbitrary shell fallback or privileged side effects. |
| AC-028 | WF-019, WF-020 | Given an agent attempts to alter controller state, invoke human approval, use publishing credentials, or merge directly, when the adapter capability boundary is tested, then access is prevented and the attempt is recorded. Prompt-only restrictions do not satisfy this scenario. |
| AC-029 | WF-020 | Given a crash around a state write or external side effect, when the controller restarts, then it reconciles actual effects, preserves its event history, and avoids duplicate actions. |
| AC-030 | WF-020 | Given competing branch/deployment mutations or stale expected revisions, when operations execute, then one valid writer proceeds and the other receives a recoverable conflict. |
| AC-031 | WF-020 | Given repeated unresolved review findings or an exceeded execution limit, when another attempt is requested, then the dependent loop stops with evidence and a precise escalation. |
| AC-032 | WF-021 | Given a draft/ready PR, when CI runs, then required checks match its phase and an untrusted PR job cannot publish images or access release credentials. |
| AC-033 | WF-021 | Given an authorized merged candidate, when publishing runs, then images are private, repository access is verified, and source/digest records are captured; a public or inaccessible existing destination blocks publication. |
| AC-034 | WF-021 | Given the automation identity creates/updates a PR or merges it, when GitHub events are observed, then the expected PR/main checks actually start and are associated with the correct revision. |
| AC-035 | WF-022, WF-030 | Given published candidate images, when Compose verification runs, then exact digests are started, readiness and system checks execute, diagnostics are retained, and test resources are cleaned on success or failure. Failure never makes the candidate release-eligible. |
| AC-036 | WF-023 | Given a verified candidate, when a release is created or retried, then version tags reference the existing artifacts, the manifest is complete, and no rebuild or version overwrite occurs. |
| AC-037 | WF-024 | Given a release manifest, when local deployment runs, then exact artifacts are used, data is preserved, verification records the running release, and conflicting deployment attempts are serialized. |
| AC-038 | WF-024 | Given a database-incompatible previous image version, when recovery is requested, then a blind image rollback is rejected and the declared data recovery procedure is required. |
| AC-039 | WF-006, WF-025 | Given a non-container client, when a release set is verified, then its adapter supplies package identity, checksum, tests, and supported backend versions; it is not treated as a Docker image. |
| AC-040 | WF-026 | Given a reproducible defect against approved intent, when bug-fix routing runs, then it produces regression RED, a scoped fix, review, and normal integration/delivery evidence. |
| AC-041 | WF-026 | Given unclear intent or an older deployed version, when defect triage runs, then it requests only missing decisions or identifies an existing corrected release instead of inventing behavior or duplicate work. |
| AC-042 | WF-027, WF-028 | Given a workflow change, when the candidate changes its own gate definitions, then its execution remains governed by the old pinned bundle and the candidate is tested only in isolation. |
| AC-043 | WF-028 | Given a verified new workflow bundle, when activation is requested, then critical changes need authenticated human activation approval; existing changes retain their old bundle unless explicitly migrated. |
| AC-044 | WF-028 | Given incompatible state schemas, when migration or rollback is requested, then unsupported transitions are rejected without losing state and a verified migration path is required. |
| AC-045 | WF-029 | Given a completed feature, when whole-change review runs, then the capability index describes actual delivered behavior and reports link to retained evidence rather than invented results. |
| AC-046 | WF-030 | Given successful fixture-based acceptance and unavailable live credentials, when status is reported, then simulated checks pass only their own layer and live GitHub/GHCR/agent-executor acceptance remains explicitly pending. |
| AC-047 | WF-031 | Given two unrelated target repositories at different paths with different base branches, account destinations, and application layouts, when the same workflow bundle runs with their respective project profiles, then each uses only its configured resources without source edits or leaked project assumptions; invalid or missing configuration fails before side effects. |
| AC-048 | WF-032 | Given the bundle is installed in a supported Codex client, when the user invokes its entry skill with a feature description, then the main agent retrieves durable state/context and delegates a bounded task to a configured native specialist without starting a second agent runtime. |
| AC-049 | WF-012, WF-020, WF-032 | Given a paused Codex-driven change, when a new conversation invokes resume with its ID, then verified state and actual external effects restore the next allowed action without replaying completed operations or depending on the old conversation transcript. |
| AC-050 | WF-019, WF-031, WF-032 | Given a client lacks required custom-agent, operation-access, trusted-decision, or isolation capabilities, when installation/preflight or a protected action runs, then it reports the precise unsupported capability, preserves existing configuration, and does not claim installation success, weaken gates, or silently introduce another runtime. |
| AC-051 | WF-031, WF-032, WF-033 | Given the workflow repository is cloned and the user selects an empty folder or an existing Git project, when workflow installation runs, then only bundle-owned runtime assets are installed, conflicts stop without overwriting, an empty target receives a local Git repository but no remote, and project-specific Stage 0 starts only after Codex is opened in the target and its skill/agent discovery is verified. |

## Required end-to-end journeys

1. From a workflow checkout, install into a disposable empty target, verify Codex skill/agent discovery there, initialize a project from an idea, exercise both foundation approvals, and deliver verified bootstrap. Repeat installation into an existing repository and verify preservation of its existing files and Git history.
2. Submit a description, retrieve context, clarify a business decision, approve scenarios, plan two small increments, and alternate test author/reviewer and implementer roles.
3. Commit and push after task checkpoints, recover an interrupted push, let the user review and merge the PR manually, then confirm the merged status and continue.
4. Build a multi-application artifact set from merged source, publish privately, test exact images, promote without rebuilding, and verify local deployment.
5. Reproduce and fix a defect with a regression test; separately exercise ambiguous intent and an already-fixed deployed version.
6. Change a workflow rule under the old bundle, reject self-activation, evaluate the candidate, activate with the required decision, and preserve an existing run on its original version.
7. Run the same bundle against two unrelated fixture projects using separate profiles, paths, base branches, destinations, and application layouts; verify that behavior changes through configuration rather than workflow source edits.
8. Install the bundle into a supported Codex client, invoke the entry skill, delegate to native specialists, pause, and resume in a new conversation; separately verify conflict preservation and actionable failure on an unsupported client surface.

These journeys must exercise actual controller transitions and operations. Fixture agents may provide deterministic authored content, but must not replace the controller, Git operations, or evidence checks being tested.
