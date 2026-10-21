---
name: sdlc-implementation
description: Implement a bounded task against reviewed tests and approved architecture using short TDD cycles.
---

# Sdlc Implementation

Inspect the task envelope, standards, test review and RED evidence. Search/read relevant code as needed. Implement minimal behavior; run the assigned focused profile until genuine GREEN, refactor, then ask the coordinator to execute the registered `tests.run_scheduled` matrix at task/increment gates. Stop and return the actual failure classification if a profile fails; do not claim later profiles ran. Test changes return to author/reviewer; approved behavior changes return to specification. Preserve unrelated edits and app compatibility. The coordinator invokes checkpoint after gates pass; do not invent Git commands or mark yourself complete.

Invoke operations with `node scripts/workflow/run.mjs OPERATION --project PROJECT_ROOT`, passing JSON on stdin. Read the operation registry before assuming availability.
