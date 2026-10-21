---
name: sdlc-workflow
description: Coordinate the reusable Codex SDLC workflow for project initialization, features, defects, maintenance, or workflow improvements. Use native specialist delegation and registered operations to manage stage gates and resume work.
---

# Sdlc Workflow

Use the main Codex session as coordinator. Inspect the installed bundle/profile with `bundle.inspect` and `workflow.inspect`; resume through `workflow.resume`. If the selected surface cannot load roles or delegate, report the precise missing capability instead of claiming execution.

Read [process](references/process.md) for stage order and [operation access](references/operations.md) before calling the controller. Read [delegation](references/delegation.md) before the first specialist handoff.

Resolve the applicable initialization, feature, defect, maintenance, or workflow-change playbook with `change.route`. Treat its result as advisory routing only; it never accepts requirements, records reproduction, grants approval, or advances a gate. Follow [change routes](references/routes.md) and preserve unresolved decisions for the appropriate human gate.

For initialization, discover and obtain acceptance of product/MVP, then architecture and standards, then bootstrap. For features, retrieve context from a user description, author/review requirements and scenarios, obtain business acceptance, then plan/review. Execute small vertical increments with reviewed tests and genuine RED/GREEN/refactor cycles. Defects require reproduction and a reviewed regression test. Workflow changes run under the previously pinned version, require independent evaluation and explicit human activation, and never migrate in-flight changes implicitly.

Delegate bounded tasks to the matching installed role. Use task.prepare and task.record_result; agent statements do not certify completion. Commit and push each completed changed task through change.checkpoint, then ensure an early draft PR. A human reviewer copies the returned task.result.review_marker into their GitHub review; call review.resolve to verify that review before treating the task as DONE. Address `CHANGES_REQUESTED` in a new task checkpoint and review cycle. Stop and escalate when the third attempt remains unresolved. No empty or unrelated commits. After all tasks are reviewed, use ci.await for required current-head checks, then pr.mark_ready. Obtain business acceptance with decision.ingest against the reviewed artifact before any merge. Publish, verify, release and deploy as distinct stages.

When a gate fails, preserve the reason and follow the allowed correction path. Never manufacture decision provenance, substitute prose for operation evidence, or modify active gates to pass your own work.

Invoke operations with `node scripts/workflow/run.mjs OPERATION --project PROJECT_ROOT`, passing JSON on stdin. Read the operation registry before assuming availability.
