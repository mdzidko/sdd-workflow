# Codex SDLC Workflow

This repository contains a reusable, human-governed software delivery workflow for Codex: coordinator and specialist skills, artifact contracts and templates, deterministic Node.js operations, local workflow records, and automated tests. The repository is the workflow product and its installer source; it is separate from each project that uses the workflow.

## Installation

Clone this repository, choose a separate target folder, and run setup from the repository root. The target must be an existing empty folder or the root of a clean Git repository. Setup checks for file conflicts and stops without overwriting project files.

```powershell
'{}' | node scripts/workflow/run.mjs bundle.inspect --project TARGET_PROJECT_ROOT
'{}' | node scripts/workflow/run.mjs bundle.preflight --project TARGET_PROJECT_ROOT
'{}' | node scripts/workflow/run.mjs workflow.setup --project TARGET_PROJECT_ROOT
```

For a new project, setup initializes local Git on `main` and commits the installed workflow. For an existing repository, it commits only workflow-owned files on the checked-out base branch. It does not create a remote repository or publish anything. Setup requires Git author and committer identity.

Open the target folder in Codex, reload if needed, then verify that Codex discovers `$sdlc-workflow` and can hand off to a native specialist. Setup installs workflow tools; it does not define the target product or initialize its workflow state. See [installation details](docs/workflow/installation.md) and the [quickstart](docs/workflow/quickstart.md).

## Using the workflow

In the target project, invoke `$sdlc-workflow` in Codex and describe the feature, defect, or maintenance need in plain language. The coordinator reads the installed project profile and workflow state, gathers bounded repository context, and routes work to specialist agents. Human approval is required at business and other protected decision gates.

For a new product, begin with Stage 0 to define and approve its purpose, MVP, architecture, applications, engineering standards, and delivery constraints. For a feature, the workflow turns the request into reviewed requirements and scenarios, plans small vertical increments, has tests written and reviewed before implementation, and uses task-by-task TDD, commits, pull-request review, CI, and squash merge. A defect follows a reproduction and regression-test path before its fix. Image publication, release, and deployment are separate steps after merge.

The workflow creates change branches from the configured integration branch, records completed task checkpoints, and opens or updates a draft PR when the GitHub integration is configured. It cannot treat an agent claim or a JSON field as human approval. Configure the project profile and credentials only for integrations the project will use; see the [operation reference](docs/workflow/operations.md).

## Developing this workflow repository

Use a clean clone of this repository as your development checkout. Create changes from `master` (or the repository's configured integration branch). Use `WORKFLOW_CHANGE` for workflow improvements and `BUGFIX` for defects. When this checkout has an initialized workflow profile and the entry skill is installed, invoke `$sdlc-workflow` with the change description; it creates `workflow/<ID>-<slug>` or `fix/<ID>-<slug>` branches and routes work through reviewed planning and test-first implementation. A raw source checkout is the installer, not a setup target. To use Codex to modify the workflow itself, run setup from a separate installer clone into a clean development clone, then open that target clone in Codex. Workflow changes use the currently pinned workflow version for their own evaluation; merging a change does not activate a new workflow version. Activation requires its separate human-controlled gate.

Keep tasks small and reviewable. Add or update readable tests before implementation for behavior changes. The test author and implementation changes are reviewed independently; checkpoint commits are made per completed task. Run the repository checks before opening or updating the PR:

```sh
npm ci
npm run format:check
npm run lint
npm run check
npm test
```

The GitHub Actions workflow repeats format, lint, integrity, and test checks on Ubuntu and Windows with Node.js 22 and 24. Complete task-level reviews, obtain required human decisions, wait for current CI, then squash merge the PR. See [workflow requirements](docs/workflow/requirements.md), the [implementation plan](docs/workflow/implementation-plan.md), and the [acceptance status](docs/workflow/acceptance-status.md) for scope and current verification limits.

Requirements for repository development: Node.js 22 or later and Git. See [Codex integration architecture](docs/workflow/codex-integration.md) for host capabilities and limitations.
