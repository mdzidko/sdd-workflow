import test from 'node:test';
import assert from 'node:assert/strict';
import { initialize, repository, succeeds } from './helpers.mjs';

test('setup doctor reports precise blockers and never returns the configured token', async (t) => {
  const token = 'fixture-token-that-must-not-be-returned';
  const repo = await repository(t, { context: { env: { GH_TOKEN: token } } });
  const github = {
    owner: 'example-org',
    name: 'project-x',
    required_reviewers: ['human-reviewer'],
    required_checks: ['workflow-ci / verify'],
  };

  const beforeInitialization = succeeds(await repo.run('workflow.doctor'), 'workflow.doctor');
  assert.equal(beforeInitialization.ready, false);
  assert.equal(
    beforeInitialization.checks.find((check) => check.id === 'project_profile').status,
    'NOT_CONFIGURED',
  );

  await initialize(repo, { github });
  const report = succeeds(await repo.run('workflow.doctor'), 'workflow.doctor');
  assert.equal(report.ready, false);
  assert.equal(report.secret_values_returned, false);
  assert.equal(report.checks.find((check) => check.id === 'project_profile').status, 'READY');
  assert.equal(report.checks.find((check) => check.id === 'operation_locks').status, 'READY');
  assert.equal(
    report.checks.find((check) => check.id === 'github_configuration').status,
    'CONFIGURED',
  );
  assert.equal(report.checks.find((check) => check.id === 'codex_discovery').status, 'UNVERIFIED');
  assert.equal(
    report.checks.find((check) => check.id === 'permission_boundary').status,
    'UNVERIFIED',
  );
  assert.equal(
    report.checks.find((check) => check.id === 'live_integrations').status,
    'UNVERIFIED',
  );
  assert.equal(JSON.stringify(report).includes(token), false);
});

test('setup doctor verifies the configured Docker Engine and Compose locally', async (t) => {
  const commands = [];
  const repo = await repository(t, {
    context: {
      dockerRunner: (command, args) => {
        commands.push([command, args]);
        return {
          status: 0,
          stdout: args[0] === 'info' ? '29.8.2\n' : 'v5.5.1\n',
          stderr: '',
        };
      },
    },
  });
  await initialize(repo, { delivery: { compose: { file: 'compose.yaml' } } });

  const report = succeeds(await repo.run('workflow.doctor'), 'workflow.doctor');
  const docker = report.checks.find((check) => check.id === 'docker_delivery');
  assert.equal(docker.status, 'READY');
  assert.match(docker.message, /Docker Engine 29\.8\.2 and Docker Compose 5\.5\.1/);
  assert.deepEqual(commands, [
    ['docker', ['info', '--format', '{{.ServerVersion}}']],
    ['docker', ['compose', 'version', '--short']],
  ]);
});

test('setup doctor reports Docker probe failure without exposing command output', async (t) => {
  const repo = await repository(t, {
    context: {
      dockerRunner: () => ({ status: 1, stdout: '', stderr: 'private-daemon-detail' }),
    },
  });
  await initialize(repo, { delivery: { compose: { file: 'compose.yaml' } } });

  const report = succeeds(await repo.run('workflow.doctor'), 'workflow.doctor');
  const docker = report.checks.find((check) => check.id === 'docker_delivery');
  assert.equal(docker.status, 'BLOCKED');
  assert.match(docker.message, /Docker Engine and Docker Compose v2 plugin/);
  assert.equal(JSON.stringify(docker).includes('private-daemon-detail'), false);
});
