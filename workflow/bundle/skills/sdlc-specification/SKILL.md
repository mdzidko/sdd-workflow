---
name: sdlc-specification
description: Discover bounded business requirements and observable acceptance scenarios without designing implementation.
---

# Sdlc Specification

Use context.prepare and selective repo.search/repo.read. Start from the user's description; do not demand that they repeat repository facts. Distinguish approved intent, implemented behavior and plans. Author requirements and then scenarios using artifact.create; retain stable IDs, concrete examples, scope/exclusions, exceptions and explicit unknowns. Scenario entries use id, requirement_ids, given, when and then. Validate with spec.validate and request independent review before human acceptance of the exact specification version. Never self-record human approval.

For a defect, verify that expected behavior comes from an accepted requirement or decision. If it is missing, conflicting, or the request changes behavior, route back through feature specification; do not label the behavior a defect by assumption. Record reproduction separately from the report and bind it to the source revision and environment.

Invoke operations with `node scripts/workflow/run.mjs OPERATION --project PROJECT_ROOT`, passing JSON on stdin. Read the operation registry before assuming availability.
