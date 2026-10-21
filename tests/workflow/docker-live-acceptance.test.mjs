import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { initialize, repository, succeeds } from './helpers.mjs';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 600_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function imageReference(tag) {
  const repositoryDigest = docker([
    'image',
    'inspect',
    tag,
    '--format',
    '{{index .RepoDigests 0}}',
  ]);
  const separator = repositoryDigest.lastIndexOf('@');
  assert.ok(separator > 0, `Image ${tag} must expose an immutable repository digest.`);
  return {
    image: repositoryDigest.slice(0, separator),
    digest: repositoryDigest.slice(separator + 1),
  };
}

test(
  'the real Docker engine deploys and verifies a multi-image digest-pinned Compose release',
  { skip: process.env.WORKFLOW_LIVE_DOCKER !== '1' },
  async (t) => {
    docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 });
    docker(['pull', 'nginx:alpine']);
    docker(['pull', 'busybox:stable']);
    const web = imageReference('nginx:alpine');
    const api = imageReference('busybox:stable');
    const port = await availablePort();
    const projectName = `wf-live-${randomBytes(6).toString('hex')}`;
    let repo;
    let composeAvailable = false;
    t.after(() => {
      if (!composeAvailable) return;
      docker(
        [
          'compose',
          '--project-name',
          projectName,
          '--file',
          'compose.yaml',
          'down',
          '--timeout',
          '10',
        ],
        { cwd: repo.projectRoot },
      );
    });
    repo = await repository(t);
    const compose = [
      'services:',
      '  web:',
      '    image: nginx:alpine',
      '    volumes:',
      '      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro',
      '    depends_on:',
      '      api:',
      '        condition: service_healthy',
      '    ports:',
      `      - "127.0.0.1:${port}:80"`,
      '    healthcheck:',
      '      test: ["CMD-SHELL", "wget -q -O - http://127.0.0.1/ | grep -q api-ready"]',
      '      interval: 1s',
      '      timeout: 2s',
      '      retries: 30',
      '      start_period: 2s',
      '  api:',
      '    image: busybox:stable',
      '    command: ["sh", "-c", "mkdir -p /www && printf api-ready > /www/index.html && httpd -f -p 8080 -h /www"]',
      '    healthcheck:',
      '      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1"]',
      '      interval: 1s',
      '      timeout: 2s',
      '      retries: 30',
      '',
    ].join('\n');
    const nginxConfig = [
      'server {',
      '  listen 80;',
      '  location / {',
      '    proxy_pass http://api:8080;',
      '  }',
      '}',
      '',
    ].join('\n');
    const manifest = {
      schema_version: '1',
      version: '1.0.0',
      tag: 'v1.0.0',
      prerelease: false,
      source_sha: 'a'.repeat(40),
      images: [
        { image_id: 'web', ...web, reference: `${web.image}@${web.digest}`, service: 'web' },
        {
          image_id: 'api',
          ...api,
          reference: `${api.image}@${api.digest}`,
          service: 'api',
        },
      ],
    };
    await repo.write('compose.yaml', compose);
    await repo.write('nginx.conf', nginxConfig);
    composeAvailable = true;
    await repo.write('release-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    await repo.write(
      'checks/system.test.mjs',
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        '',
        "test('the deployed web application reaches its API over the Compose network', async () => {",
        `  const response = await fetch('http://127.0.0.1:${port}/');`,
        '  assert.equal(response.status, 200);',
        "  assert.equal(await response.text(), 'api-ready');",
        '});',
        '',
      ].join('\n'),
    );
    await initialize(repo, {
      commands: {
        system: {
          command: process.execPath,
          args: ['--test', 'checks/system.test.mjs'],
          timeout_ms: 30_000,
        },
      },
      delivery: {
        compose: {
          file: 'compose.yaml',
          project_name: projectName,
          readiness_timeout_ms: 90_000,
          verification_profiles: ['system'],
        },
      },
    });

    const deployment = succeeds(
      await repo.run('deploy.local', {
        deployment_id: 'D-DOCKER-LIVE',
        manifest_path: 'release-manifest.json',
      }),
      'deploy.local',
    );
    assert.equal(deployment.deployment.status, 'READY');
    assert.deepEqual(deployment.deployment.image_references, [
      `${web.image}@${web.digest}`,
      `${api.image}@${api.digest}`,
    ]);

    const verification = succeeds(
      await repo.run('deploy.verify', { deployment_id: 'D-DOCKER-LIVE' }),
      'deploy.verify',
    );
    assert.equal(verification.passed, true);
    assert.equal(verification.deployment.status, 'VERIFIED');
    assert.equal(verification.deployment.verification_runs[0].classification, 'PASS');
  },
);
