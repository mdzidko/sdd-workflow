# Codex Integration Architecture

Status: selected architectural direction, based on the user's decision to build the workflow around Codex capabilities. This is a design record, not an implementation or live-verification report.

## Decision

Provide a reusable Codex workflow bundle. The main Codex agent coordinates work using a dedicated entry skill and native specialist subagents. Registered operations implement repeatable actions, while a small deterministic layer stores durable records and validates transitions.

Do not build a second agent runtime, custom LLM loop, independent scheduler, or web application in the initial version. A database is not mandatory. Select the language for operation scripts and the durable storage implementation during W-001, based on actual guarantees and supported hosts rather than the planning environment.

## Responsibility split

| Layer | Responsibility |
| --- | --- |
| Codex client/session | User interaction, native agent execution, delegation lifecycle, and available session permission controls |
| Coordinator skill | Route initialization/features/defects/workflow changes; inspect state; delegate bounded work; request human decisions; invoke registered operations |
| Custom specialist subagents | Architecture, requirements/scenarios, planning, tests, implementation, reviews, documentation, and release investigation |
| Specialist skills | Narrow procedures, role boundaries, source retrieval guidance, operation references, and escalation rules |
| Templates and schemas | Readable artifacts, stable IDs, structured inputs/results, and traceability |
| Operation/state layer | Validate requests and transitions; preserve receipts; reconcile interruptions; execute scoped Git, validation, test, release, and deployment actions |
| GitHub | Protected integration, authenticated review evidence, CI, package publication, and release records |
| Project profile | Bind one generic workflow bundle to repository identity, applications, operation bindings, and environments |

The coordinator decides what to propose next. An operation independently decides whether its requested action is legal. Agent output alone cannot mark a task complete, mint human acceptance, or make a release eligible.

## Invocation and continuation

The entry skill will support the following intents, with exact invocation syntax verified during installation:

- Start project initialization from an idea.
- Start a feature from a description.
- Report and investigate a defect.
- Inspect or resume a change by its stable ID.
- Propose an improvement to the workflow.

An example request after installation is: `Use the SDLC workflow to implement: <feature description>.` This is an intended interaction, not a currently installed command.

On every start/resume, the coordinator calls state/context operations before delegating. The conversation is not the authoritative workflow database. Recover task/checkpoint status from durable records and actual repository/external effects, then recreate the minimum context needed by specialists.

Closing the client does not imply unattended execution. The initial implementation resumes when invoked again. A future background runner is a separate extension with explicit scheduling, credentials, lifecycle, and cost decisions.

## Bundle and installation

The distributable bundle contains the coordinator skill, specialist definitions/skills, schemas/templates, operation scripts or tool bindings, gate rules, and a version manifest. Role model selections are configuration; do not embed a mandatory model in generic role instructions.

Where the selected local Codex client supports them, project custom agents use its documented `.codex/agents/` convention. Skill installation uses that client's supported project skill location, verified against its version. These are host integration conventions, not product application layout decisions.

Installation must:

1. Inspect client capabilities, existing project instructions, and destination conflicts.
2. Validate the project profile and credential references without exposing secret values.
3. Install only explicitly owned bundle files; preserve existing agents, skills, and configuration.
4. Expose the entry skill and operation interface; connect MCP if the selected integration requires it.
5. Report any required client reload/restart rather than claiming new capabilities are already loaded.
6. Verify an actual invocation and specialist handoff on the selected surface.

A plugin is an optional distribution wrapper for the skills and MCP integration. It is not a new runtime. Do not publish to a marketplace, alter global user configuration, or register external integrations merely to create the local bundle.

## Registered operations and MCP

Every operation has the same schema, preconditions, effects, result, and evidence whether invoked through a script or MCP. MCP is a facade, not an alternate implementation of business rules.

W-001/W-002 select direct script access, an MCP facade, or a combination based on enforceable capability boundaries. Use an MCP boundary if protected state or privileged operations cannot safely be exposed through the current session's direct script access. The access-control proof is required before enabling those effects.

Do not use lifecycle hooks as the sole record of a completed stage or the sole enforcement point. Hooks may be supplementary only where the selected client supports them and failure behavior is tested. Explicit operations remain callable and verifiable.

## State and approvals

The state layer needs atomic updates, event/receipt history, locks, safe retries, and versioned migration. A file-backed implementation is a candidate, provided crash/recovery tests demonstrate those properties. Introduce a database only through a justified decision; conversation history is not a replacement for durable workflow state.

Protect active gate definitions, state, credentials, and approval capabilities from agent-authored candidate code. A writable JSON file inside a worker's worktree does not establish that boundary.

Human acceptance must originate from a trusted client input/decision channel or authenticated GitHub decision. Its evidence binds the actual user decision to the appropriate content/revision. If a client cannot export a trustworthy machine-verifiable decision, use another configured human decision channel. Never invent a signature or provenance field from agent prose.

## Native permission limitations

Custom subagents inherit the parent session's sandbox/approval settings; a role description does not create a separate read-only sandbox. Configure supported capability restrictions explicitly and test them. Native session approval authorizes tool execution; it does not automatically accept business requirements or a final feature.

The capability spike must prove which parts can safely execute within the selected Codex surface. If a protected action cannot be enforced, report that precise missing capability and keep the action blocked. Do not silently switch to a custom runtime or weaken workflow gates.

## Reuse and versioning

Reuse the bundle across unrelated projects through their profiles. Product goals, application directories, deployment inventories, and test bindings remain project-specific. Keep role instructions and stage rules free from account names, absolute project paths, and assumed application frameworks.

Pin bundle resources for each change and record compatible/actual Codex capabilities. Resume must detect incompatible host or bundle changes. A new candidate bundle cannot govern its own acceptance or replace the active version merely by being merged.

## Extension triggers

Consider Codex SDK, app-server, or a separate runner only when a concrete requirement demands unattended scheduling, external event processing, an independent queue, or a separate user interface. Such an extension must preserve current operation contracts and acceptance gates and follow the workflow-change process.

The OpenAI Agents API documents managed Codex sessions with explicit turn cancellation and best-effort usage reporting. Those controls apply to API-managed sessions; this workflow currently uses the interactive Codex session and native subagents. Moving orchestration to the Agents API would be an architecture change with separate credentials, session ownership, and runtime acceptance, not a setting that can control the existing interactive session.

## Official references

- [Subagents](https://developers.openai.com/codex/subagents/): native delegation, custom agent definitions, inherited permissions, and supported capability controls.
- [Skills](https://developers.openai.com/codex/skills/): reusable instructions and supporting resources.
- [Model Context Protocol](https://developers.openai.com/codex/mcp/): configured local/remote operation interfaces and client-specific availability.
- [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins): packaging skills, MCP, and optional lifecycle hooks.
- [Codex integration choices](https://developers.openai.com/blog/codex-as-a-platform): distinct uses for non-interactive execution, SDK, and app-server.
- [Agents API sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions) and [observability and usage](https://developers.openai.com/api/docs/guides/agents-api/observability): managed-session cancellation and best-effort usage reporting.

Verify documentation and the selected installed client's behavior during implementation. A documented capability on one surface is not proof of availability on every Codex/ChatGPT surface.
