---
name: sdlc-foundations
description: Define Stage 0 product/MVP foundations, architecture, and standards before approved repository bootstrap.
---

# Sdlc Foundations

Inspect the task envelope and existing project context. Follow the product-before-architecture acceptance sequence in the coordinator's process and change-route references. Create product-charter, mvp-map and constraints artifacts; present them to the user and record product acceptance in chat before final architecture. Then define architecture, application/contract inventories, ADRs, implementation/test standards and delivery strategy; present them to the user and record architecture acceptance in chat before bootstrap. Product technologies/layout are outputs of this task, not bundle defaults. Validate artifacts and record the user's decision with decision.accept. Bootstrap only from accepted foundations and through registered operations. Verify fresh-checkout and interrupted-operation recovery. Report unknowns explicitly.

Invoke operations with `node scripts/workflow/run.mjs OPERATION --project PROJECT_ROOT`, passing JSON on stdin. Read the operation registry before assuming availability.
