# Change routes

`change.route` returns the fixed playbook for a persisted change kind. It is a read-only navigation aid, not a gate validator. Route output and agent messages do not record business acceptance. Present the current artifact in chat, wait for the user's explicit response, and call `decision.accept` immediately with the inspected content hash and state revision.

## Project initialization

1. Discover the product purpose, users, measurable outcomes, MVP boundary, assumptions, constraints, and open questions. Create and review the product charter, MVP map, and constraints.
2. Obtain explicit product acceptance before finalizing architecture.
3. Define system boundaries, collaborating applications, their layout, contracts, dependencies, data ownership, ADRs, implementation and test standards, and delivery strategy. Review the complete foundation set.
4. Obtain explicit architecture acceptance before creating the application/repository bootstrap.
5. Bootstrap the accepted layout, workflow operations, CI, test tooling, and artifact conventions. Verify a fresh checkout and recovery from an interrupted operation. Create a ready PR for the user to review and merge manually.

Do not infer product scope, technology choices, or application paths from the workflow bundle. Those are outputs of this route and require the corresponding review and human acceptance.

## Defects

1. Compare the report with the accepted requirements and decisions, implemented behavior, known fixes, and planned changes. Keep these sources distinct.
2. If expected behavior is ambiguous, contradicts an accepted requirement, or requests changed behavior, return to feature specification. Do not create a bugfix branch as a shortcut around business clarification.
3. Record expected and observed behavior, affected version, environment, impact, and concrete reproduction steps. Identify the source revision under test.
4. Reproduce the failure before implementation. If it cannot be reproduced, report the missing condition or evidence and pause implementation. Do not treat setup failures as behavioral RED.
5. If the exact target deployment already contains the fix, verify that deployment and relevant behavior. Close with evidence as a no-file outcome; do not create an empty commit. A source checkout alone cannot establish deployed status.
6. Otherwise author a readable regression test against approved expected behavior. Independently review the test and verify genuine assertion RED before implementing. Continue with normal task checkpoints, test cadence, task review, and current checks. Present any business decision in chat; the user reviews and merges the resulting PR manually, then the workflow confirms that merge before completion.

## Maintenance

1. Classify the request (for example documentation, dependency update, refactor, security, or build/release maintenance) and check it against accepted product and architecture decisions.
2. Create a reviewed impact map with exactly one `{ "application_id", "impact", "rationale" }` entry for every configured application. Use `AFFECTED`, `UNAFFECTED`, or `UNKNOWN`; cite why an application or check is omitted in the rationale. Also map shared contracts, data, security, compatibility, and delivery. Unknown impact requires broader application and system verification, and task test scope is derived from this accepted map.
3. Choose only the workflow stages and test profiles justified by the evidence and impact. For every omitted stage or check, record why it cannot affect the change and cite the applicable constraint or source.
4. Plan small tasks with verifiable outputs. A no-file task is valid only when inspection or execution proves the requested condition is already satisfied or no change is needed. Retain the evidence and independent review result.
5. For file-changing plans, author and independently review behavioral RED before implementation, then run selected checks against current source. For an explicit `NO_FILE` plan, every task must have empty file ownership, both test-author and implementer tasks need current GREEN evidence and independent review, and the rationale must explain why no change is needed. Do not create an empty commit for a verified no-op. The user reviews and merges the resulting PR manually; the workflow confirms the merge before completion.

## Features and workflow changes

Features follow context retrieval, reviewed requirements and scenarios, exact-content business acceptance, and reviewed vertical planning before implementation. Workflow changes remain pinned to the active bundle while they are implemented and evaluated. Merge does not activate a candidate; activation and any migration require their own verified gates.
