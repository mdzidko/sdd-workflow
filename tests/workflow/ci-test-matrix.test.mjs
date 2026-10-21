import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCiMatrix } from '../../workflow/bundle/tools/ci-test-matrix.mjs';

const profile = {
  applications: [
    { id: 'api', path: 'services/api' },
    { id: 'web', path: 'apps/web' },
  ],
  commands: {
    api_unit: {
      command: 'npm',
      args: ['test', '--', '--runInBand'],
      category: 'unit',
      cadence: 'task',
      application_ids: ['api'],
    },
    web_unit: {
      command: 'npm',
      args: ['test', '--', '--runInBand'],
      category: 'unit',
      cadence: 'task',
      application_ids: ['web'],
    },
    api_integration: {
      command: 'npm',
      args: ['run', 'test:integration'],
      category: 'integration',
      cadence: 'increment',
      application_ids: ['api'],
    },
    web_integration: {
      command: 'npm',
      args: ['run', 'test:integration'],
      category: 'integration',
      cadence: 'increment',
      application_ids: ['web'],
    },
    api_acceptance: {
      command: 'npm',
      args: ['run', 'test:e2e'],
      category: 'e2e',
      cadence: 'merge',
      application_ids: ['api'],
    },
    web_acceptance: {
      command: 'npm',
      args: ['run', 'test:e2e'],
      category: 'e2e',
      cadence: 'merge',
      application_ids: ['web'],
    },
    whole_system: {
      command: 'npm',
      args: ['run', 'test:e2e'],
      category: 'e2e',
      cadence: 'merge',
      application_ids: ['*'],
    },
    release_only: {
      command: 'npm',
      args: ['run', 'release:check'],
      category: 'release',
      cadence: 'release',
      application_ids: ['*'],
    },
  },
};

test('CI matrix scopes changed applications and includes system profiles at merge cadence', () => {
  const matrix = buildCiMatrix(profile, ['apps/web/src/page.tsx']);
  assert.deepEqual(
    matrix.include.map(({ profile: name, application_id }) => [name, application_id]),
    [
      ['web_unit', 'web'],
      ['web_integration', 'web'],
      ['web_acceptance', 'web'],
      ['whole_system', '*'],
    ],
  );
  assert.equal(
    matrix.include.find((entry) => entry.profile === 'web_integration').working_directory,
    'apps/web',
  );
  assert.deepEqual(matrix.matrices, {
    focused: matrix.include.filter((entry) => entry.category === 'unit'),
    fast: matrix.include.filter((entry) => entry.category === 'integration'),
    acceptance: matrix.include.filter(
      (entry) => entry.category === 'e2e' && entry.application_id !== '*',
    ),
    system: matrix.include.filter((entry) => entry.application_id === '*'),
  });
});

test('unknown or shared-file impact expands application coverage and never produces an empty required matrix', () => {
  const matrix = buildCiMatrix(profile, ['docs/architecture.md']);
  assert.deepEqual(
    matrix.include.map(({ profile: name, application_id }) => [name, application_id]),
    [
      ['api_unit', 'api'],
      ['web_unit', 'web'],
      ['api_integration', 'api'],
      ['web_integration', 'web'],
      ['api_acceptance', 'api'],
      ['web_acceptance', 'web'],
      ['whole_system', '*'],
    ],
  );
  assert.deepEqual(
    matrix.matrices.focused.map((entry) => entry.profile),
    ['api_unit', 'web_unit'],
  );
  assert.deepEqual(
    matrix.matrices.fast.map((entry) => entry.profile),
    ['api_integration', 'web_integration'],
  );
  assert.deepEqual(
    matrix.matrices.acceptance.map((entry) => entry.profile),
    ['api_acceptance', 'web_acceptance'],
  );
  assert.deepEqual(
    matrix.matrices.system.map((entry) => entry.profile),
    ['whole_system'],
  );
  assert.throws(
    () => buildCiMatrix({ applications: [], commands: {} }, []),
    /No eligible CI test profiles/,
  );
  assert.throws(
    () =>
      buildCiMatrix(
        {
          applications: [{ id: 'api', path: 'services/api' }],
          commands: { api_unit: profile.commands.api_unit },
        },
        ['services/api/index.js'],
      ),
    /focused, fast, acceptance, and system/,
  );
});

test('matrix rejects unsafe paths, malformed commands, and invalid app references', () => {
  assert.throws(
    () =>
      buildCiMatrix({ ...profile, applications: [{ id: 'api', path: '../api' }] }, [
        'services/api/a.js',
      ]),
    /project-relative application path/,
  );
  assert.throws(
    () =>
      buildCiMatrix(
        {
          ...profile,
          commands: {
            ...profile.commands,
            bad: { ...profile.commands.api_unit, command: 'npm && echo bad' },
          },
        },
        [],
      ),
    /executable/,
  );
  assert.throws(
    () =>
      buildCiMatrix(
        {
          ...profile,
          commands: {
            ...profile.commands,
            bad: { ...profile.commands.api_unit, application_ids: ['missing'] },
          },
        },
        [],
      ),
    /unknown application/,
  );
});
