# Workflow Requirements

Status: implementation-planning baseline. The user selected the Codex-based bundle direction. Detailed implementation contracts remain subject to review; this document does not claim that the workflow exists or fabricate operational approvals.

## Purpose and boundary

Build a reusable workflow invoked from Codex. The main Codex agent coordinates bounded work through skills and native specialist subagents. A small deterministic operation/state layer verifies evidence, enforces transitions, and protects explicit human decisions. Support project initialization, MVP development, subsequent features, bug fixes, maintenance, and changes to the workflow itself. Do not reimplement the Codex agent loop or require a separate scheduler/service for the initial version.

For each target project, the product goal, MVP scope, application technologies, application layout, and actual application inventory remain Stage 0 outputs. Multi-application fixtures used to verify the workflow are disposable examples, not a prescribed product architecture. The workflow's own runtime and storage implementation are separate architectural decisions; they must not be inferred from the planning workstation.

Throughout these documents, `main` is shorthand for the configured integration branch, not a required literal branch name. Branch names and directory examples illustrate conventions; target paths, repository identities, and application layouts come from configuration and approved project architecture.

## Requirements

| ID | Requirement |
| --- | --- |
| WF-001 | Implement all workflow-owned code, documents, schemas, templates, prompts, skills, names, messages, and test descriptions in English. Preserve externally supplied content when translating it would lose evidence or meaning. |
| WF-002 | Stage 0 discovers and approves the product goal and MVP boundary, then proposes and approves architecture and standards, then bootstraps and verifies the repository. Do not require these decisions before Stage 0 starts. |
| WF-003 | Accept a user's feature description as sufficient intake. Retrieve existing product, architecture, requirements, capabilities, code, tests, constraints, and dependencies automatically. Ask only for unresolved decisions. |
| WF-004 | Stage 1 records requirements with stable IDs, scope, exclusions, examples, decisions, and explicit unknowns. Stage 2 adds observable scenarios, requirement coverage, independent review, and human acceptance. |
| WF-005 | Stage 3 produces small vertical increments, bounded tasks, ownership, dependencies, scenario coverage, verification triggers, environments, and expected test costs. Do not silently change approved behavior. |
| WF-006 | Model multiple collaborating applications, service contracts, dependency impact, per-application checks, system checks, and supported version combinations. Change only applications required by the feature. |
| WF-007 | Stage 4 prepares and independently reviews readable tests and realistic isolated data for the next increment. Stage 5 implements task by task using repeated RED/GREEN/refactor cycles. |
| WF-008 | Distinguish an expected behavioral failure from test collection errors, missing dependencies, unavailable infrastructure, and other execution errors. A test author's claim alone cannot certify RED or GREEN. |
| WF-009 | Run focused checks during TDD, fast checks at checkpoints, relevant integration checks when boundaries change, acceptance checks before merge, and artifact/system checks after merge. Fast integration tests may belong in the inner loop. |
| WF-010 | Keep test names meaningful, arrange/act/assert understandable, fixtures explicit, assertions useful, and helpers transparent. Automate formatting and linting; review semantic readability. |
| WF-011 | Define implementation standards in Stage 0: architecture boundaries, naming, formatting, contracts, validation, errors, data changes, security, observability, configuration, dependencies, and testability. Enforce applicable rules in each task. |
| WF-012 | Use role-specific authors and independent reviewers with bounded task envelopes, immutable inputs, permitted operations, outputs, limits, and escalation conditions. Agents cannot certify their own completion or human approval. |
| WF-013 | Keep initial agent context small. Provide bounded repository search and selective reads with paths, source revisions, and provenance; distinguish approved intent, implemented behavior, and future plans. |
| WF-014 | Provide versioned templates and machine-readable contracts for every standard artifact type. Generate execution evidence from operations. Validate structure and traceability separately from semantic review. |
| WF-015 | Create a change branch automatically from a verified main revision. After the first substantive commit and push, ensure exactly one draft PR. Keep feature changes across applications together when they share this repository. |
| WF-016 | After each completed task with repository changes, create a scoped incremental commit and push. Do not include unrelated work or create empty commits. Recover partial success before marking the task DONE. An approved test task may checkpoint RED. |
| WF-017 | Before integration, run the planned checks and task reviews. The user reviews and merges the ready PR manually; the workflow waits for GitHub to confirm the merge before continuing. Delete a branch only after confirming merge and absence of unsaved work. |
| WF-018 | Bind human decisions to their actual authenticated source and relevant content/revision. Invalidate approvals and test evidence when their subject changes. Do not treat agent output, timeout, or a typed actor field as human approval. |
| WF-019 | Use registered, versioned operations with input/output schemas, preconditions, scope, timeout, reconciliation, errors, and evidence. Prevent shell improvisation from bypassing controller-owned gates or privileged actions. |
| WF-020 | Persist process state and an append-only operation/event history. Support restart, interrupted external effects, optimistic revision checks, operation deduplication, resource locks, bounded retries, and explicit blocked/waiting states. |
| WF-021 | Use GitHub Actions for PR checks and merged-source artifact pipelines. Publish container images only from authorized main candidates into private GHCR packages. Explicitly verify package access and publication eligibility. |
| WF-022 | Verify published images by digest in a disposable Compose environment. Test application collaboration and critical user journeys, collect diagnostics, and clean test resources even on failure. A published image is not automatically a verified release. |
| WF-023 | Release a compatible artifact set with a manifest, source revisions, image digests or package checksums, configuration revision, migrations, verification evidence, and recovery instructions. Promote verified artifacts without rebuilding. |
| WF-024 | Deploy locally through registered operations using the selected manifest. Check readiness and behavior, serialize deployments, protect persistent data, and record the actual deployed version. Do not assume image rollback reverses database migrations. |
| WF-025 | Support non-container applications through artifact and test adapters. Native mobile packages are not Docker images; test and compatibility requirements must be explicit. Store publication is outside the initial local-delivery scope. |
| WF-026 | Bug fixes establish expected behavior, reproduce the defect, add a reviewed regression test, implement the fix, and follow normal integration/release controls. Ambiguous intent returns to specification; behavior changes follow feature/change approval. |
| WF-027 | Workflow changes run under the previously pinned workflow version, on a dedicated branch, with independent review and regression/evaluation scenarios. Candidate changes do not activate by being merged. |
| WF-028 | Pin the bundle's gate/state support, skills, roles, operations, schemas, and templates per change; declare Codex capability compatibility and record the actual host. Activate verified versions explicitly; preserve in-flight versions unless an explicit, verified state migration is approved. Critical gate/permission changes require human activation approval. |
| WF-029 | Maintain an accurate short index of delivered capabilities and current architecture references. Review documentation with code; preserve evidence and release artifacts outside normal source history with an explicit retention policy. |
| WF-030 | Report integrated, built, artifact-verified, released, deployed, and deployment-verified states separately. Never label simulated external success as live acceptance or task completion as complete feature delivery. |
| WF-031 | Keep the workflow reusable through a validated project profile. Configure repository location/identity, Git remote and base branch, GitHub/GHCR destinations, applications, operation bindings, agent execution, supported hosts, and environment references. Do not hard-code planning-workstation details or product assumptions. Select workflow runtime/storage in explicit architecture decisions rather than treating them as requirements. |
| WF-032 | Package the workflow for invocation from a supported Codex client using a coordinator skill, native custom subagents, specialist skills, templates, and registered script/tool operations. Reuse native delegation and conversation interaction; keep authoritative state and gate validation in a minimal deterministic layer. Expose an MCP operation facade when required for controlled access or packaging. Do not require a custom agent runtime, mandatory database, web dashboard, or unattended service. |
| WF-033 | Keep the workflow repository separate from each target project. From a cloned workflow repository, let the user choose a target folder and install only bundle-owned runtime assets there, preserving unrelated files and stopping on conflicts. Support both a new empty target and an existing Git project; initialize local Git for an empty target without creating a remote. Run Codex discovery checks and project-specific Stage 0 in the selected target only after installation. |

## Human decisions

- Product goal and MVP boundary before architecture is finalized.
- Architecture, implementation/test standards, and autonomy boundaries before dependent bootstrap.
- Business specification after requirements and scenarios are reviewed.
- Business artifact acceptance in chat before dependent planning or implementation.
- Manual PR review and merge by the user; the workflow only verifies the merged status before continuing.
- Material changes to previously approved behavior or architecture.
- Workflow activation that changes human gates, privileges, completion rules, or state migration.
- Destructive or out-of-policy deployment/data actions.

Routine planning, test review, task checkpoints, and disposable environment deployment do not introduce extra human gates. Unknown decisions pause only dependent work; unrelated ready work may continue.

## Artifact contract inventory

Every type below needs a versioned schema or document contract, a generator/template where appropriate, positive/negative examples, and validation rules. Names here are logical types, not an application directory layout.

| Group | Types |
| --- | --- |
| Project binding | Validated project profile, capability/preflight report, credential references without secret values |
| Project foundations | Product charter, MVP map, constraints, architecture, implementation/test standards, ADR, application/contract inventory, delivery strategy |
| Change definition | Intake, requirements, scenarios, business decisions, defect report, reproduction evidence |
| Planning | Impact map, vertical increment, task envelope, dependency graph, scenario/test map, verification schedule, risk record |
| Execution | Agent result, operation request/result, task checkpoint, RED/GREEN evidence, environment descriptor |
| Review and decisions | Review finding, response/resolution, review report, human approval/rejection, escalation |
| Git and GitHub | Branch identity, commit metadata, draft/ready PR content, merge receipt, cleanup receipt |
| Delivery | Build record, candidate manifest, verification report, release manifest, release notes, deployment/recovery report |
| Workflow lifecycle | Workflow bundle manifest, activation record, state migration plan/result, evaluation report |

## Role inventory

Coordinator, architect, requirements/scenario author, specification reviewer, planner, plan reviewer, test author, test reviewer, implementer, implementation reviewer, documentation author, and release agent. Workflow-specific work reuses relevant specialist roles with a separate change scope. Authors and reviewers must not share an execution identity for the same artifact.

The main Codex agent is the coordinator. Native specialist subagents author and review bounded outputs. The small deterministic operation/state layer owns authoritative transitions and privileged operation preconditions; a coordinator cannot override a failed gate. The term controller elsewhere refers to this layer, not a second agent runtime.

Native subagents inherit session permissions. Role instructions are not permission isolation. Verify actual supported capability controls and keep protected state/credentials inaccessible to untrusted editing sessions. Distinguish a Codex tool-execution approval from business acceptance of a versioned specification.

## Scope of the first implementation

- Operation on explicitly supported host platforms and CI runners, with capabilities verified for each configured environment.
- Invocation and continuation from Codex through an installed bundle. Installation verifies the selected client's actual support for custom agents, skills, and operation access; unsupported surfaces receive an actionable failure rather than a false installation success.
- One Git repository containing potentially multiple applications; one branch/PR per change.
- Serial mutation of a change branch; isolated parallel work only after ownership/locking tests pass.
- GitHub Actions and private GHCR for containers; a documented non-container adapter contract and executable fixture adapter.
- No production hosting, app-store submission, multi-repository atomic release, visual workflow editor, or predetermined product features.

## Traceability

Acceptance examples are in [acceptance-scenarios.md](acceptance-scenarios.md). The selected integration is described in [codex-integration.md](codex-integration.md). Implementation ownership, dependencies, and verification are in [implementation-plan.md](implementation-plan.md).
