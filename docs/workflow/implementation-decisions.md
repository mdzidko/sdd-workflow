# Initial Implementation Decisions

## Operation runtime

Use Node.js 22 or later for small executable operations and its built-in test runner. The operation interface consumes JSON and produces JSON. No external runtime dependency, database, custom model loop, background scheduler, or product framework is introduced. This choice concerns workflow tools only and does not constrain any target application.

## Durable records

Use versioned JSON snapshots with an embedded event/receipt history, exclusive filesystem locks, atomic replacement, revision checks, and interruption recovery. A JSONL event export is diagnostic rather than a second source of truth. Do not call a local writable state file an authorization boundary. Human decisions for protected actions must be independently verified, and unsupported local isolation must remain explicitly unverified.

## Native integration

Bundle native specialist definitions and operation-backed skills. An installer copies only bundle-owned files into a target project, preserves existing configuration, and reports required client reload. Installation is separate from actual native invocation verification.

## Repository and target-project boundary

This repository contains and versions the workflow product only: its source, distributable bundle, tests, and development documentation. A user clones this repository to obtain the installer, selects a separate target folder, and installs the workflow there before starting product work. The workflow repository is not the default target project.

The first-run flow has two distinct gates. Installation copies only the distributable workflow subset into the selected target and verifies file conflicts without overwriting project-owned files. The user then opens that target in Codex and verifies entry-skill and specialist discovery. Project initialization (Stage 0) starts only in the target project and defines its goal, MVP, architecture, application structure, engineering standards, and delivery constraints. Workflow installation does not invent or accept those product decisions.

The installer should support an empty target folder and an existing Git repository. For an empty folder it initializes a local Git repository on the configured default branch, but does not create a remote repository or publish files. Existing repository history, branch configuration, and unrelated files are preserved. Remote hosting and credentials are configured separately.

## External effects

Git operations use argument arrays. GitHub operations use authenticated API requests and independently verified human review/check evidence. Credentials are references from the executing environment, never artifact content. CI publication is performed by GitHub Actions. No self-declared agent approval can authorize business acceptance, merge, workflow activation, or destructive deployment.

## Bootstrap provenance

Initial work is coordinated by the current host session, not by the unfinished workflow. Automated test results, review results, remote publication, native client invocation, and deployment evidence are recorded separately. A successful local test never proves a live external integration.
