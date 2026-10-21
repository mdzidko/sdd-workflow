---
name: sdlc-planning
description: Plan accepted scenarios as small cross-application increments with task ownership and a trigger-based test schedule.
---

# Sdlc Planning

Check the accepted specification revision first. Read architecture and use selective source retrieval. Create impact-map and plan artifacts: increments deliver demonstrable behavior; each increment contains a test-author task and an implementer task, and each implementer directly depends on a test-author task in that same increment. On multi-application projects, declare every affected `application_id` on each increment and include cross-application contracts in the task ownership and verification plan. Every task has role, ownership, dependencies, allowed operations, outputs, completion criteria, evidence and limits. Map requirements/scenarios to tasks and tests, including shared contracts and whole-system checks. For a MAINTENANCE request that needs no implementation, use `outcome: NO_FILE` with an evidence-based rationale; every task must own an empty path list, the reviewed test-author task must pass current checks, and the implementer task must independently verify the no-op and pass its checks. The ordinary PR review and merge gates still apply, and no empty commit is created. Define named test command profiles with category, cadence, and application_ids. Call test.schedule for each task, vertical increment, merge candidate, and release; implementation task and increment scope is derived from the current reviewed increment, a missing declared scope expands to all registered apps, and maintenance scope comes from its accepted impact map. Mismatched caller scope is rejected. Keep focused/unit/contract tests frequent, integration checks at increment boundaries, slow E2E at merge, and image/release checks at their own gates. Validate with plan.validate; request plan review. Return missing product/architecture decisions rather than expanding scope.

For maintenance, justify stage selection from the impact map and accepted standards. A verified no-op may complete without a file change or empty commit; retain the inspection and verification evidence and state why each omitted stage/check is unnecessary.

Invoke operations with `node scripts/workflow/run.mjs OPERATION --project PROJECT_ROOT`, passing JSON on stdin. Read the operation registry before assuming availability.
