---
name: sdlc-testing
description: Author and verify readable unit, integration, contract, or E2E tests for the next small increment.
---

# Sdlc Testing

Retrieve only relevant contracts, tests, fixtures and standards through bounded `repo.search` and `repo.read` calls. Search the expected public contract and existing examples before assuming an API exists. If the contract or test prerequisite is missing, return a structured missing-prerequisite report to the coordinator: inspected paths/revision, expected interface, observed gap, blocked test scope, and a proposed bounded bootstrap/contract task. Do not implement the missing API or business behavior yourself. A collection/import failure is never behavioral RED. Resume the blocked test only after the prerequisite is separately supplied through the workflow. Prepare tests with behavior-based names, clear arrange/act/assert, explicit isolated data, useful assertions and transparent helpers. Use the plan's appropriate level; system tests verify collaboration across required applications. Run tests.run on the assigned profile and capture actual evidence with tdd.record. Classify behavioral RED separately from setup, collection, dependency and infrastructure failures. Workflow verification records task completion from current evidence and its pushed scoped checkpoint; do not wait for a separate task review. No business implementation, weakened assertions, fabricated failures or agent-issued completion.

Invoke operations with `node scripts/workflow/run.mjs OPERATION --project PROJECT_ROOT`, passing JSON on stdin. Read the operation registry before assuming availability.
