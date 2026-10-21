# Native delegation contract

Use installed native roles: sdlc_architect, sdlc_spec_author, sdlc_spec_reviewer, sdlc_planner, sdlc_plan_reviewer, sdlc_test_author, sdlc_test_reviewer, sdlc_implementer, sdlc_implementation_reviewer, sdlc_documentation_author and sdlc_release_agent. The main session is the coordinator; do not spawn a replacement custom runtime.

Call task.prepare for a bounded envelope containing pinned inputs, ownership, allowed operations, expected outputs, completion criteria, evidence, limits and escalation conditions. Pass the envelope and references, not the whole repository. Tell specialists they share the workspace and must preserve others' edits. Default to serial mutation. Parallel work requires proven isolation/locking, stable contracts and disjoint ownership.

Authors and reviewers use separate execution identities for the same deliverable. Reviewers inspect original sources independently and return findings without editing author work. All roles inherit actual session permissions; instructions are not independent filesystem or credential isolation.

A specialist's result is a proposal. task.record_result and stage.advance independently validate prerequisites. Never claim native roles are installed/loaded until the selected client has actually discovered them and a real handoff is observed. If a capability is absent, report its limitation and pause dependent execution.
