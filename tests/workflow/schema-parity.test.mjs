import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fails, initialize, repository, succeeds } from './helpers.mjs';

const contractsRoot = fileURLToPath(new URL('../../workflow/bundle/contracts/', import.meta.url));
const examplesRoot = path.join(contractsRoot, 'examples');
const schema = JSON.parse(await readFile(path.join(contractsRoot, 'artifact.schema.json'), 'utf8'));

function minimalRequirements() {
  return {
    schema_version: '1',
    type: 'requirements',
    id: 'F-001-REQUIREMENTS',
    change_id: 'F-001',
    title: 'Adding a person',
    status: 'draft',
    data: { requirements: [{ id: 'REQ-001', description: 'A valid person can be saved.' }] },
  };
}

async function validateWrittenArtifact(repo, artifact, name = 'artifact') {
  const relative = `docs/schema-parity/${name}.json`;
  await repo.write(relative, JSON.stringify(artifact));
  return repo.run('artifact.validate', { path: relative });
}

test('public structural validation accepts every independently verified valid contract example', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const files = (await readdir(examplesRoot)).filter((name) => name.endsWith('.valid.json')).sort();
  const coveredTypes = new Set();
  assert.equal(
    files.length,
    schema.properties.type.enum.length,
    'Every canonical artifact type needs a positive example.',
  );
  for (const filename of files) {
    await t.test(filename.replace('.valid.json', ''), async () => {
      const example = JSON.parse(await readFile(path.join(examplesRoot, filename), 'utf8'));
      coveredTypes.add(example.type);
      const result = await validateWrittenArtifact(repo, example, filename.replace('.json', ''));
      assert.equal(succeeds(result, 'artifact.validate').valid, true);
    });
  }
  assert.deepEqual([...coveredTypes].sort(), [...schema.properties.type.enum].sort());
});

test('public structural validation rejects every independently verified invalid contract example', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const files = (await readdir(examplesRoot))
    .filter((name) => name.endsWith('.invalid.json'))
    .sort();
  assert.equal(
    files.length,
    schema.properties.type.enum.length,
    'Every canonical artifact type needs a negative example.',
  );
  for (const filename of files) {
    await t.test(filename.replace('.invalid.json', ''), async () => {
      const example = JSON.parse(await readFile(path.join(examplesRoot, filename), 'utf8'));
      fails(
        await validateWrittenArtifact(repo, example, filename.replace('.json', '')),
        'artifact.validate',
        'VALIDATION_FAILED',
      );
    });
  }
});

test('every canonical artifact status remains structurally valid without granting workflow authority', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  for (const status of schema.properties.status.enum) {
    await t.test(status, async () => {
      const artifact = { ...minimalRequirements(), status };
      assert.equal(
        succeeds(
          await validateWrittenArtifact(repo, artifact, `status-${status}`),
          'artifact.validate',
        ).valid,
        true,
      );
    });
  }
  const inspected = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  assert.deepEqual(
    inspected.changes,
    [],
    'Validating approved-looking content does not create an authoritative change or approval.',
  );
});

test('artifact envelopes reject unsupported fields rather than silently accepting authority claims', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  fails(
    await validateWrittenArtifact(repo, {
      ...minimalRequirements(),
      approved_by: 'human',
    }),
    'artifact.validate',
    'VALIDATION_FAILED',
  );
});

test('every required envelope field must be present', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  for (const field of schema.required) {
    await t.test(`missing ${field}`, async () => {
      const artifact = minimalRequirements();
      delete artifact[field];
      fails(await validateWrittenArtifact(repo, artifact, `missing-${field}`), 'artifact.validate');
    });
  }
});

test('requirements reject missing core fields, whitespace descriptions and duplicate stable IDs', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const cases = [
    { name: 'missing requirement ID', requirements: [{ description: 'Save a valid person.' }] },
    { name: 'missing description', requirements: [{ id: 'REQ-001' }] },
    { name: 'whitespace description', requirements: [{ id: 'REQ-001', description: ' \t\n ' }] },
    {
      name: 'duplicate IDs',
      requirements: [
        { id: 'REQ-001', description: 'Save a valid person.' },
        { id: 'REQ-001', description: 'Read the saved person.' },
      ],
    },
  ];
  for (const [index, example] of cases.entries()) {
    await t.test(example.name, async () => {
      const artifact = minimalRequirements();
      artifact.data.requirements = example.requirements;
      fails(
        await validateWrittenArtifact(repo, artifact, `requirement-boundary-${index}`),
        'artifact.validate',
        'VALIDATION_FAILED',
      );
    });
  }
});
