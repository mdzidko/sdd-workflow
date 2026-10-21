import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fails, initialize, repository, stateBytes, succeeds } from './helpers.mjs';

const sourceSha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const manifest = {
  schema_version: '1',
  version: '1.2.3',
  tag: 'v1.2.3',
  prerelease: false,
  source_sha: sourceSha,
  images: [
    {
      image_id: 'api',
      image: 'ghcr.io/example/product/api',
      digest,
      reference: `ghcr.io/example/product/api@${digest}`,
      service: 'api',
    },
  ],
};
const github = {
  owner: 'example-org',
  name: 'project-x',
  api_url: 'https://api.example.test',
  required_reviewers: ['human-reviewer'],
  automation_logins: ['workflow-bot[bot]'],
  required_checks: ['workflow-ci / verify'],
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const migration = {
  id: 'schema-v2',
  service: 'migrate',
  compatibility: 'forward-only',
  recovery_strategy: 'restore-backup',
  recovery_instructions:
    'Restore the pre-deployment database backup before deploying the prior release.',
};

function composeRunner(options = {}) {
  const { ready = true, pinned = true, migrationFails = false, release = manifest } = options;
  const calls = [];
  const runner = (_executable, args) => {
    calls.push(args);
    if (args.includes('config')) {
      const services = Object.fromEntries(
        release.images.map((item) => [
          item.service,
          { image: pinned ? item.reference : `${item.image}:latest` },
        ]),
      );
      return {
        status: 0,
        stdout: JSON.stringify({ services }),
        stderr: '',
      };
    }
    if (args.includes('run') && migrationFails)
      return { status: 1, stdout: '', stderr: 'migration failed' };
    if (args.includes('up') && options.applicationFails)
      return { status: 1, stdout: '', stderr: 'application failed to start' };
    if (args.includes('ps')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          Service: 'api',
          State: ready ? 'running' : 'exited',
          Health: ready ? 'healthy' : 'unhealthy',
        }),
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, runner };
}

async function configuredRepository(t, docker, extra = {}) {
  const { context: contextOverrides = {}, ...profileOverrides } = extra;
  let time = 0;
  const repo = await repository(t, {
    context: {
      dockerRunner: docker.runner,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      ...contextOverrides,
    },
  });
  await repo.write('compose.yaml', 'services:\n  api:\n    image: example\n');
  await repo.write('release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  await repo.write(
    'checks/system.test.mjs',
    "import test from 'node:test'; import assert from 'node:assert/strict'; test('system acceptance passes', () => assert.equal(1, 1));\n",
  );
  await initialize(repo, {
    commands: {
      system: {
        command: process.execPath,
        args: ['--test', 'checks/system.test.mjs'],
        timeout_ms: 10_000,
      },
    },
    delivery: {
      compose: {
        file: 'compose.yaml',
        project_name: 'test-product',
        readiness_timeout_ms: 1_000,
        verification_profiles: ['system'],
      },
    },
    ...profileOverrides,
  });
  return repo;
}

test('local deployment uses exact digests, waits for healthy services, verifies behavior, and preserves volumes', async (t) => {
  const docker = composeRunner();
  const repo = await configuredRepository(t, docker);
  const deployed = succeeds(
    await repo.run('deploy.local', {
      deployment_id: 'D-001',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
  );
  assert.equal(deployed.deployment.status, 'READY');
  const up = docker.calls.find((args) => args.includes('up'));
  assert.deepEqual(up.slice(-6), ['up', '--detach', '--pull', 'always', '--no-build', 'api']);
  assert.equal(
    docker.calls.some((args) => args.includes('down')),
    false,
  );
  const override = JSON.parse(
    await readFile(
      path.join(repo.projectRoot, '.workflow-runtime/deployments/D-001.compose.json'),
      'utf8',
    ),
  );
  assert.equal(override.services.api.image, manifest.images[0].reference);

  const verified = succeeds(
    await repo.run('deploy.verify', { deployment_id: 'D-001' }),
    'deploy.verify',
  );
  assert.equal(verified.passed, true);
  assert.equal(verified.deployment.status, 'VERIFIED');
  const recovery = succeeds(
    await repo.run('deploy.recover', { deployment_id: 'D-001' }),
    'deploy.recover',
  );
  assert.match(recovery.recovery_action, /No recovery action/);

  const repeated = succeeds(
    await repo.run('deploy.local', {
      deployment_id: 'D-001',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
  );
  assert.equal(repeated.already_ready, true);
});

test('a bug report with no-file evidence still requires authenticated intent approval', async (t) => {
  const docker = composeRunner();
  const comments = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith('/issues/314'))
      return response({
        number: 314,
        state: 'open',
        body: '<!-- codex-sdlc-change: B-FIXED -->',
        user: { login: 'reporter', type: 'User' },
      });
    if (parsed.pathname.endsWith('/issues/314/comments')) return response(comments);
    throw new Error(`Unexpected GitHub API request: ${url}`);
  };
  const repo = await configuredRepository(t, docker, {
    github,
    context: {
      env: { GH_TOKEN: 'fixture-token', GITHUB_API_URL: github.api_url },
      fetchImpl,
    },
  });
  succeeds(
    await repo.run('deploy.local', {
      deployment_id: 'D-FIXED',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
  );
  succeeds(await repo.run('deploy.verify', { deployment_id: 'D-FIXED' }), 'deploy.verify');
  repo.git('add', 'compose.yaml', 'release-manifest.json', 'checks/system.test.mjs');
  repo.git('commit', '-m', 'test: add verified deployment fixture');
  await appendFile(path.join(repo.projectRoot, '.git/info/exclude'), '\n.workflow-runtime/\n');
  assert.equal(repo.git('status', '--porcelain'), '', repo.git('status', '--porcelain'));
  const started = succeeds(
    await repo.run('change.start', {
      id: 'B-FIXED',
      kind: 'BUGFIX',
      description: 'Verify the person name regression is already fixed.',
    }),
    'change.start',
  );
  const originalHead = repo.git('rev-parse', 'HEAD');
  succeeds(
    await repo.run('artifact.create', {
      change_id: 'B-FIXED',
      id: 'DEFECT-WRONG-EVIDENCE',
      type: 'defect-report',
      title: 'Unverified release and test references cannot close the defect',
      data: {
        description: 'The report concerns a known name normalization issue.',
        expected: 'Names are normalized consistently.',
        observed: 'The reporter observed inconsistent normalization.',
        affected_versions: ['9.9.9'],
        reproduction_steps: ['Open the affected person record.'],
        impact: 'Users may see inconsistent names.',
        source: 'Production deployment feedback.',
        already_fixed_deployment_id: 'D-FIXED',
        already_fixed_test_id: 'test that does not exist',
      },
    }),
    'artifact.create',
  );
  const rejectedGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'B-FIXED' }),
    'stage.inspect',
  );
  assert.equal(rejectedGate.transition.to, 'COMPLETE');
  assert.equal(rejectedGate.transition.ready, false);
  assert.ok(
    rejectedGate.transition.missing.some((item) => item.reason === 'deployment_version_mismatch'),
  );
  assert.ok(
    rejectedGate.transition.missing.some(
      (item) => item.reason === 'named_system_test_not_verified',
    ),
  );

  succeeds(
    await repo.run('artifact.create', {
      change_id: 'B-FIXED',
      id: 'DEFECT-FIXED',
      type: 'defect-report',
      title: 'The target deployment already contains the correction',
      data: {
        description: 'The report concerns a known name normalization issue.',
        expected: 'Names are normalized consistently.',
        observed: 'The reporter observed inconsistent normalization.',
        affected_versions: ['1.2.3'],
        reproduction_steps: ['Open the affected person record.'],
        impact: 'Users may see inconsistent names.',
        source: 'Production deployment feedback.',
        already_fixed_deployment_id: 'D-FIXED',
        already_fixed_test_id: 'system acceptance passes',
      },
    }),
    'artifact.create',
  );

  const gate = succeeds(await repo.run('stage.inspect', { change_id: 'B-FIXED' }), 'stage.inspect');
  assert.equal(gate.transition.to, 'COMPLETE');
  assert.equal(gate.transition.ready, false);
  assert.ok(
    gate.transition.missing.some((item) => item.reason === 'authenticated_approval_missing'),
  );
  assert.ok(
    gate.transition.evidence.some(
      (item) => item.type === 'verified_no_file_deployment' && item.deployment_id === 'D-FIXED',
    ),
  );
  const pendingDecision = succeeds(
    await repo.run('decision.ingest', {
      change_id: 'B-FIXED',
      artifact_id: 'DEFECT-FIXED',
      issue_number: 314,
    }),
    'decision.ingest',
  );
  assert.equal(pendingDecision.status, 'AWAITING_HUMAN');
  assert.equal(pendingDecision.issue_number, 314);
  comments.push({
    id: 1,
    user: { login: 'human-reviewer', type: 'User' },
    created_at: '2026-10-20T10:00:00.000Z',
    body: `CHANGES_REQUESTED ${pendingDecision.required_marker}`,
  });
  const rejected = succeeds(
    await repo.run('decision.ingest', {
      change_id: 'B-FIXED',
      artifact_id: 'DEFECT-FIXED',
      issue_number: 314,
    }),
    'decision.ingest',
  );
  assert.equal(rejected.status, 'REJECTED');
  const inspected = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  fails(
    await repo.run('stage.advance', {
      change_id: 'B-FIXED',
      expected_stage: 'REPRODUCTION',
      expected_revision: inspected.revision,
      to: 'COMPLETE',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
  comments.push({
    id: 2,
    user: { login: 'human-reviewer', type: 'User' },
    created_at: '2026-10-20T10:01:00.000Z',
    body: `APPROVED ${pendingDecision.required_marker}`,
  });
  const approved = succeeds(
    await repo.run('decision.ingest', {
      change_id: 'B-FIXED',
      artifact_id: 'DEFECT-FIXED',
      issue_number: 314,
    }),
    'decision.ingest',
  );
  assert.equal(approved.status, 'APPROVED');
  comments.push({
    id: 3,
    user: { login: 'human-reviewer', type: 'User' },
    created_at: '2026-10-20T10:02:00.000Z',
    body: `CHANGES_REQUESTED ${pendingDecision.required_marker}`,
  });
  const finalGate = succeeds(
    await repo.run('stage.inspect', { change_id: 'B-FIXED' }),
    'stage.inspect',
  );
  assert.equal(finalGate.transition.ready, true);
  const finalState = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  fails(
    await repo.run('stage.advance', {
      change_id: 'B-FIXED',
      expected_stage: 'REPRODUCTION',
      expected_revision: finalState.revision,
      to: 'COMPLETE',
    }),
    'stage.advance',
    'GATE_BLOCKED',
  );
  comments.push({
    id: 4,
    user: { login: 'human-reviewer', type: 'User' },
    created_at: '2026-10-20T10:03:00.000Z',
    body: `APPROVED ${pendingDecision.required_marker}`,
  });
  const reapproved = succeeds(
    await repo.run('decision.ingest', {
      change_id: 'B-FIXED',
      artifact_id: 'DEFECT-FIXED',
      issue_number: 314,
    }),
    'decision.ingest',
  );
  assert.equal(reapproved.status, 'APPROVED');
  const approvedState = succeeds(await repo.run('workflow.inspect'), 'workflow.inspect');
  const completed = succeeds(
    await repo.run('stage.advance', {
      change_id: 'B-FIXED',
      expected_stage: 'REPRODUCTION',
      expected_revision: approvedState.revision,
      to: 'COMPLETE',
    }),
    'stage.advance',
  );
  assert.equal(completed.change.stage, 'COMPLETE');
  assert.equal(completed.change.status, 'PASSED');
  assert.equal(repo.git('rev-parse', 'HEAD'), originalHead);
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(started.change.stage, 'REPRODUCTION');
});

test('deployment rejects mutable or unlisted Compose images before starting containers', async (t) => {
  const docker = composeRunner({ pinned: false });
  const repo = await configuredRepository(t, docker);
  fails(
    await repo.run('deploy.local', {
      deployment_id: 'D-002',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
    'COMPOSE_IMAGE_UNPINNED',
  );
  assert.equal(
    docker.calls.some((args) => args.includes('up')),
    false,
  );
  const recovered = succeeds(
    await repo.run('deploy.recover', { deployment_id: 'D-002' }),
    'deploy.recover',
  );
  assert.equal(recovered.deployment.status, 'FAILED');
});

test('deployment does not claim readiness when a Compose service is unhealthy', async (t) => {
  const docker = composeRunner({ ready: false });
  const repo = await configuredRepository(t, docker);
  fails(
    await repo.run('deploy.local', {
      deployment_id: 'D-003',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
    'DEPLOYMENT_NOT_READY',
  );
  const recovered = succeeds(
    await repo.run('deploy.recover', { deployment_id: 'D-003' }),
    'deploy.recover',
  );
  assert.equal(recovered.deployment.status, 'FAILED');
  assert.equal(
    docker.calls.some((args) => args.includes('down')),
    false,
  );
});

test('verification rejects a release manifest changed after deployment', async (t) => {
  const docker = composeRunner();
  const repo = await configuredRepository(t, docker);
  succeeds(
    await repo.run('deploy.local', {
      deployment_id: 'D-004',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
  );
  await repo.write('release-manifest.json', JSON.stringify({ ...manifest, version: '9.9.9' }));
  fails(
    await repo.run('deploy.verify', { deployment_id: 'D-004' }),
    'deploy.verify',
    'DEPLOYMENT_STALE',
  );
  assert.equal(docker.calls.filter((args) => args.includes('ps')).length, 1);
});

test('verification cannot treat an arbitrary successful command as executed system tests', async (t) => {
  const docker = composeRunner();
  const repo = await configuredRepository(t, docker, {
    commands: {
      system: { command: process.execPath, args: ['-e', 'process.exit(0)'], timeout_ms: 10_000 },
    },
  });
  succeeds(
    await repo.run('deploy.local', {
      deployment_id: 'D-005',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
  );
  const verified = succeeds(
    await repo.run('deploy.verify', { deployment_id: 'D-005' }),
    'deploy.verify',
  );
  assert.equal(verified.passed, false);
  assert.equal(verified.deployment.status, 'VERIFY_FAILED');
  assert.equal(verified.deployment.verification_runs[0].classification, 'UNVERIFIED_TEST_RUN');
});

test('deployment runs manifest migration services before starting application services', async (t) => {
  const withMigrations = {
    ...manifest,
    images: [
      ...manifest.images,
      {
        image_id: 'migrate',
        image: 'ghcr.io/example/product/migrate',
        digest,
        reference: `ghcr.io/example/product/migrate@${digest}`,
        service: 'migrate',
      },
    ],
    migrations: [migration],
  };
  const docker = composeRunner({ release: withMigrations });
  const repo = await configuredRepository(t, docker);
  await repo.write('release-manifest.json', `${JSON.stringify(withMigrations, null, 2)}\n`);
  const deployed = succeeds(
    await repo.run('deploy.local', {
      deployment_id: 'D-006',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
  );

  const migrateIndex = docker.calls.findIndex((args) => args.includes('run'));
  const appUpIndex = docker.calls.findIndex((args) => args.includes('up'));
  assert.ok(migrateIndex >= 0);
  assert.ok(migrateIndex < appUpIndex);
  assert.ok(docker.calls[migrateIndex].includes('migrate'));
  assert.equal(deployed.deployment.status, 'READY');
  assert.deepEqual(
    deployed.deployment.migrations.map((item) => item.id),
    ['schema-v2'],
  );
});

test('failed forward-only migration blocks application startup and reports its declared recovery', async (t) => {
  const withMigrations = {
    ...manifest,
    images: [
      ...manifest.images,
      {
        image_id: 'migrate',
        image: 'ghcr.io/example/product/migrate',
        digest,
        reference: `ghcr.io/example/product/migrate@${digest}`,
        service: 'migrate',
      },
    ],
    migrations: [migration],
  };
  const docker = composeRunner({ migrationFails: true, release: withMigrations });
  const repo = await configuredRepository(t, docker);
  await repo.write('release-manifest.json', `${JSON.stringify(withMigrations, null, 2)}\n`);
  fails(
    await repo.run('deploy.local', {
      deployment_id: 'D-007',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
    'MIGRATION_FAILED',
  );
  assert.equal(
    docker.calls.some((args) => args.includes('up')),
    false,
  );
  const recovered = succeeds(
    await repo.run('deploy.recover', { deployment_id: 'D-007' }),
    'deploy.recover',
  );
  assert.equal(recovered.deployment.status, 'MIGRATION_FAILED');
  assert.equal(recovered.deployment.migrations[0].status, 'FAILED');
  assert.match(recovered.recovery_action, /Restore the pre-deployment database backup/);
  fails(
    await repo.run('deploy.local', {
      deployment_id: 'D-007',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
    'RECOVERY_REQUIRED',
  );
  assert.equal(
    docker.calls.some((args) => args.includes('down')),
    false,
  );
});

test('deployment rejects migration metadata that disagrees with immutable image references', async (t) => {
  const withMigrations = { ...manifest, migrations: [migration] };
  const docker = composeRunner();
  const repo = await configuredRepository(t, docker);
  await repo.write('release-manifest.json', `${JSON.stringify(withMigrations, null, 2)}\n`);
  fails(
    await repo.run('deploy.local', {
      deployment_id: 'D-008',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
    'INVALID_RELEASE_MANIFEST',
  );
  assert.equal(
    docker.calls.some((args) => args.includes('up') || args.includes('run')),
    false,
  );
});

test('retry after application startup failure does not rerun a completed migration', async (t) => {
  const withMigrations = {
    ...manifest,
    images: [
      ...manifest.images,
      {
        image_id: 'migrate',
        image: 'ghcr.io/example/product/migrate',
        digest,
        reference: `ghcr.io/example/product/migrate@${digest}`,
        service: 'migrate',
      },
    ],
    migrations: [migration],
  };
  const dockerOptions = { release: withMigrations, applicationFails: true };
  const docker = composeRunner(dockerOptions);
  const repo = await configuredRepository(t, docker);
  await repo.write('release-manifest.json', `${JSON.stringify(withMigrations, null, 2)}\n`);
  fails(
    await repo.run('deploy.local', {
      deployment_id: 'D-009',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
    'DOCKER_FAILED',
  );
  dockerOptions.applicationFails = false;
  succeeds(
    await repo.run('deploy.local', {
      deployment_id: 'D-009',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
  );
  assert.equal(docker.calls.filter((args) => args.includes('run')).length, 1);
});

test('an interrupted migration with an unknown outcome requires recovery before retry', async (t) => {
  const withMigrations = {
    ...manifest,
    images: [
      ...manifest.images,
      {
        image_id: 'migrate',
        image: 'ghcr.io/example/product/migrate',
        digest,
        reference: `ghcr.io/example/product/migrate@${digest}`,
        service: 'migrate',
      },
    ],
    migrations: [migration],
  };
  const docker = composeRunner({ release: withMigrations });
  const repo = await configuredRepository(t, docker);
  await repo.write('release-manifest.json', `${JSON.stringify(withMigrations, null, 2)}\n`);
  succeeds(
    await repo.run('deploy.local', {
      deployment_id: 'D-010',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
  );
  const state = JSON.parse(await stateBytes(repo));
  state.receipts.deployments['D-010'].status = 'MIGRATING';
  state.receipts.deployments['D-010'].migrations[0].status = 'RUNNING';
  await repo.write('.workflow/state.json', `${JSON.stringify(state, null, 2)}\n`);

  const recovery = succeeds(
    await repo.run('deploy.recover', { deployment_id: 'D-010' }),
    'deploy.recover',
  );
  assert.match(recovery.recovery_action, /outcome is unknown/);
  fails(
    await repo.run('deploy.local', {
      deployment_id: 'D-010',
      manifest_path: 'release-manifest.json',
    }),
    'deploy.local',
    'RECOVERY_REQUIRED',
  );
  assert.equal(docker.calls.filter((args) => args.includes('run')).length, 1);
});
