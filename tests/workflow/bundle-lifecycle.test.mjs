import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fails, initialize, repository, startFeature, stateBytes, succeeds } from './helpers.mjs';

test('bundle inspection and project changes bind to one immutable content identity', async (t) => {
  const repo = await repository(t);
  const candidate = succeeds(await repo.run('bundle.inspect'), 'bundle.inspect');
  assert.match(candidate.manifest_hash, /^[a-f0-9]{64}$/);
  assert.ok(candidate.file_count > 0);
  assert.equal(candidate.candidate_matches_installed, true);

  const initialized = await initialize(repo);
  assert.equal(initialized.profile.bundle_version, candidate.manifest.bundle_version);
  assert.equal(initialized.profile.bundle_hash, candidate.manifest_hash);

  const change = (await startFeature(repo)).change;
  assert.equal(change.bundle_version, candidate.manifest.bundle_version);
  assert.equal(change.bundle_hash, candidate.manifest_hash);
  const installed = succeeds(await repo.run('bundle.install'), 'bundle.install');
  assert.equal(installed.manifest_hash, candidate.manifest_hash);
});

test('installation refuses to reuse a version with another content identity before writing files', async (t) => {
  const repo = await repository(t);
  const first = succeeds(await repo.run('bundle.install'), 'bundle.install');
  const installedPath = path.join(repo.projectRoot, '.workflow/installed-bundle.json');
  const changedRecord = { ...first, manifest_hash: '0'.repeat(64) };
  await repo.write('.workflow/installed-bundle.json', `${JSON.stringify(changedRecord)}\n`);
  const skillPath = path.join(repo.projectRoot, '.agents/skills/sdlc-workflow/SKILL.md');
  const installedSkill = await readFile(skillPath);

  fails(await repo.run('bundle.install'), 'bundle.install', 'BUNDLE_VERSION_CONFLICT');
  assert.deepEqual(await readFile(skillPath), installedSkill);
  assert.deepEqual(
    JSON.parse(await readFile(installedPath, 'utf8')),
    changedRecord,
    'The failed install must preserve the prior installed identity record.',
  );
});

test('workflow changes use the pinned bundle and enter the same gated specification flow', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const candidate = succeeds(await repo.run('bundle.inspect'), 'bundle.inspect');
  const started = succeeds(
    await repo.run('change.start', {
      id: 'W-001',
      kind: 'WORKFLOW_CHANGE',
      description: 'Add workflow candidate evaluation gate',
    }),
    'change.start',
  );

  assert.equal(started.change.bundle_version, candidate.manifest.bundle_version);
  assert.equal(started.change.bundle_hash, candidate.manifest_hash);
  const inspected = succeeds(
    await repo.run('stage.inspect', { change_id: 'W-001' }),
    'stage.inspect',
  );
  assert.ok(inspected.transition, 'Workflow changes need executable transition gates.');
  assert.equal(inspected.transition.supported, true);
  assert.equal(inspected.transition.from, 'REQUIREMENTS');
  assert.equal(inspected.transition.to, 'PLANNING');
  assert.equal(inspected.transition.ready, false);
  assert.ok(inspected.transition.missing.some((item) => item.reason === 'artifact_missing'));
  fails(
    await repo.run('stage.advance', {
      change_id: 'W-001',
      expected_stage: 'REQUIREMENTS',
      expected_revision: inspected.transition.state_revision,
      to: 'IMPLEMENTATION',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );

  const workflow = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  assert.equal(workflow.active_bundle.version, started.change.bundle_version);
  assert.equal(workflow.active_bundle.hash, started.change.bundle_hash);
});

test('workflow activation and migration fail closed without changing pinned changes', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const { change } = await startFeature(repo);
  const before = await stateBytes(repo);

  fails(
    await repo.run('workflow.activate', {
      candidate_version: '0.2.0',
      approved: true,
      approval_ref: 'agent-claimed-approval',
    }),
    'workflow.activate',
    'ACTIVATION_GATES_UNAVAILABLE',
  );
  fails(
    await repo.run('workflow.migrate', { source_version: '0.1.0', target_version: '0.2.0' }),
    'workflow.migrate',
    'MIGRATION_GATES_UNAVAILABLE',
  );

  assert.equal(await stateBytes(repo), before);
  const resumed = succeeds(
    await repo.run('workflow.resume', { change_id: change.id }),
    'workflow.resume',
  );
  assert.equal(resumed.change.bundle_version, change.bundle_version);
  assert.equal(resumed.change.bundle_hash, change.bundle_hash);
});
