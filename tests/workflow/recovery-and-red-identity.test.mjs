import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fails, initialize, repository, startFeature, stateBytes, succeeds } from './helpers.mjs';

test('RED must bind the failing assertion to its actual failing test rather than another passing test', async (t) => {
  const repo = await repository(t);
  const fixture = fileURLToPath(new URL('./fixtures/mixed-results-test.mjs', import.meta.url));
  await initialize(repo, {
    commands: {
      focused: { command: process.execPath, args: ['--test', fixture], timeout_ms: 2_000 },
    },
  });
  await startFeature(repo);
  const tested = succeeds(
    await repo.run('tests.run', { change_id: 'F-001', profile: 'focused' }),
    'tests.run',
  );
  assert.equal(tested.run.classification, 'ASSERTION_FAILURE');
  fails(
    await repo.run('tdd.record', {
      change_id: 'F-001',
      run_id: tested.run.id,
      phase: 'RED',
      expected_failure: {
        test_id: 'accepts a valid person',
        message: 'A cyclic parent relationship must be rejected.',
      },
    }),
    'tdd.record',
    'INVALID_TDD_EVIDENCE',
  );
});

test('initialization refuses to replace prior change history when its profile is missing', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await startFeature(repo);
  const before = await stateBytes(repo);
  await rm(path.join(repo.projectRoot, '.workflow/project.json'));

  fails(await repo.run('workflow.init'), 'workflow.init', 'INITIALIZATION_INCOMPLETE');
  assert.equal(
    await stateBytes(repo),
    before,
    'Existing changes and receipts must remain byte-for-byte intact.',
  );
  await assert.rejects(access(path.join(repo.projectRoot, '.workflow/project.json')), {
    code: 'ENOENT',
  });
});

test('retrying artifact creation reconciles missing projections without duplicating the canonical artifact', async (t) => {
  for (const missing of ['markdown', 'state registration', 'both']) {
    await t.test(`missing ${missing}`, async (caseContext) => {
      const repo = await repository(caseContext);
      await initialize(repo);
      await startFeature(repo);
      const input = {
        change_id: 'F-001',
        type: 'requirements',
        id: 'F-001-REQUIREMENTS',
        title: 'Adding a person',
        data: { requirements: [{ id: 'REQ-001', description: 'A valid person can be saved.' }] },
      };
      const created = succeeds(await repo.run('artifact.create', input), 'artifact.create');
      const canonicalPath = path.join(repo.projectRoot, created.path);
      const originalBytes = await readFile(canonicalPath);
      const markdownPath = created.markdown_path ?? created.path.replace(/\.json$/, '.md');

      if (missing === 'markdown' || missing === 'both')
        await rm(path.join(repo.projectRoot, markdownPath));
      if (missing === 'state registration' || missing === 'both') {
        const state = JSON.parse(await stateBytes(repo));
        state.changes['F-001'].artifacts = [];
        await repo.write('.workflow/state.json', JSON.stringify(state));
      }

      const recovered = succeeds(await repo.run('artifact.create', input), 'artifact.create');
      assert.equal(recovered.path, created.path);
      assert.deepEqual(await readFile(canonicalPath), originalBytes);
      assert.match(
        await readFile(path.join(repo.projectRoot, markdownPath), 'utf8'),
        /Adding a person/,
      );
      const resumed = succeeds(
        await repo.run('workflow.resume', { change_id: 'F-001' }),
        'workflow.resume',
      );
      const registrations = resumed.change.artifacts.filter((artifact) => artifact.id === input.id);
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0].path, created.path);
    });
  }
});
