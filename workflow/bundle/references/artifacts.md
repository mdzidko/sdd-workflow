# Artifact authoring contract

Canonical artifacts are JSON envelopes: `schema_version`, `type`, `id`, `change_id`, `title`, `status`, and `data`. Draft validation uses `core_required`; `stage_required` lists the full information expected before semantic stage acceptance. Empty optional sections may remain during drafting, but not substitute for missing business decisions. The data contract is selected by type in `contracts/artifact-types.json`; the full interchange schema is `contracts/artifact.schema.json`.

Use `artifact.create` to instantiate the selected template. Fill substantive data from sources, retaining stable IDs and explicit unknowns. Empty template fields are scaffolding, not accepted content. Validate through `artifact.validate`, then request the appropriate independent semantic review. Render human Markdown from the same canonical data, preserving IDs, decisions, unknowns, and traceability. Markdown must not introduce a different approved specification.

Types marked `generated` describe operation-produced evidence. Their templates describe the exchange shape; an agent-filled instance is never authenticated evidence. Creating a human-decision template cannot grant approval. Approval status fields are descriptive until the controller verifies the authoritative source and content revision.

Standard types and their required data are enumerated in the catalog. Each type has a matching template. Do not silently repurpose existing IDs or overwrite historical evidence when updating an artifact.

The `contracts/examples/` pairs are synthetic schema fixtures. Positive examples demonstrate shape, not semantic completeness or trusted evidence. Negative examples omit one type-specific mandatory field. Never import these examples into active workflow history.

Generated evidence templates cannot be instantiated as trusted receipts. Their examples only exercise the schema; authenticated evidence is created and verified by the relevant operation.
