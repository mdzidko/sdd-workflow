# Install the workflow into a project

The workflow repository is the workflow product and installer source. It is not the default project where the workflow will deliver application features. Clone this repository, select a separate target folder, install the workflow into that folder, then open the target in Codex to begin its project initialization.

## First-run flow

1. Clone this workflow repository and run the setup operation from its root.
2. Select an empty folder for a new project or an existing Git repository as the target.
3. The setup operation inspects the destination, checks for conflicting files, and copies only workflow-owned resources. It preserves existing files and stops without overwriting on conflicts.
4. For a new empty folder, setup initializes a local Git repository on `main` (or the supplied `base_branch`) and commits the installed workflow assets. In an existing clean Git repository, it commits only workflow-owned paths on the checked-out base branch. It does not create a remote GitHub repository or publish files.
5. Open the target folder in Codex. Reload if required, then verify that Codex discovers the entry skill and can hand work to a native specialist.
6. Start Stage 0 in the target project. Define and accept its purpose, MVP, architecture, application structure, engineering standards, and delivery constraints before feature work.

Installation and Stage 0 are separate. Installation prepares the workflow tools; Stage 0 defines the product that will use them. The workflow does not infer or accept product decisions during installation.

## What gets installed

The installer copies the skills under `.agents/skills/`, specialist definitions under `.codex/agents/`, and workflow contracts, templates, references, tools, and example profile under `.workflow/`. It also copies the required operation runtime from `workflow/lib/`, `workflow/bundle/`, and `scripts/workflow/run.mjs`.

Repository development files such as tests, CI configuration, lint/format tooling, `package.json`, and development documentation are not copied to the target project. Each target gets its own workflow profile and local state.

## Run the installer

From the root of the cloned workflow repository, pass the selected target folder to the runner:

```powershell
'{}' | node scripts/workflow/run.mjs bundle.inspect --project TARGET_PROJECT_ROOT
'{}' | node scripts/workflow/run.mjs bundle.preflight --project TARGET_PROJECT_ROOT
'{}' | node scripts/workflow/run.mjs workflow.setup --project TARGET_PROJECT_ROOT
```

Review all inspection and preflight results. Setup must stop if destinations conflict, the target repository is dirty, or the installed bundle identity differs; do not resolve conflicts by overwriting target files. Setup creates one local bootstrap commit and records a receipt. It does not create project workflow state or accept Stage 0 decisions. File installation alone does not prove native invocation works.

After opening the target project in Codex and verifying the installed entry skill and specialist handoff, initialize that project's workflow profile and durable state. Consult the [quickstart](quickstart.md) and [operation reference](operations.md) for profile fields, supported operations, and prerequisites.

## Current readiness

`workflow.setup` implements first-run installation for an empty target folder or a clean existing Git repository. The target must be the repository root when Git is already initialized. Setup requires a configured Git author and committer identity, creates no remote, and leaves product-specific `workflow.init` for Stage 0 after the target is opened and the native Codex handoff is checked.

Codex has not yet been verified to discover and execute the installed skills and agents on every supported surface. GitHub PR/review/CI operations, private GHCR publication, GitHub Release publication, and target-project Docker deployment still require live acceptance.

The bundle includes opt-in GitHub Actions templates for container verification and candidate/release publication, plus local Compose deployment and recovery operations. These paths have deterministic tests but do not prove that a target's credentials, branch protections, registry access, or deployments are configured correctly. Database rollback is never automated.

The workflow uses Node.js 22 or later and Git. The source repository can be validated with:

```sh
npm ci
npm run format:check
npm run check
npm test
```
