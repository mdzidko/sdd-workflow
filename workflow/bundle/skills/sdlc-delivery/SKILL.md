---
name: sdlc-delivery
description: Prepare verified artifact sets, private GHCR publication, versioned release, and local deployment through registered operations.
---

# Sdlc Delivery

Inspect pinned source and actual CI before invoking delivery operations. After the integration-branch candidate workflow finishes, call images.publish with its run ID to bind publication to the exact merged change, then images.verify to record successful image-matrix and exact-digest Compose checks. Publication alone does not authorize release. release.publish verifies that the workflow-release environment has a required reviewer and prevents self-review, then dispatches the release workflow for the verified candidate. An authorized human must approve that environment before GitHub creates the tag and release. Call it again with the resulting release run ID to verify the manifest asset and record a receipt. Verify exact digests in disposable system environments, collecting diagnostics and cleaning test resources on failure. deploy.local uses the manifest and serializes environment changes; deploy.verify confirms readiness and behavior. Preserve data; verify migration compatibility before recovery. Missing credentials, proof or adapter means blocked, not simulated success. Native mobile artifacts require appropriate adapters, not Docker images.

Invoke operations with `node scripts/workflow/run.mjs OPERATION --project PROJECT_ROOT`, passing JSON on stdin. Read the operation registry before assuming availability.
