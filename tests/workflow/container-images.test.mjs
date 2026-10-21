import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeDigestOverride,
  assertPrivatePackageVisibility,
  imageMatrix,
  validateCandidateSet,
  validateCatalog,
} from '../../workflow/bundle/tools/container-images.mjs';
import { ensureGitTag, publishRelease } from '../../workflow/bundle/tools/release-publisher.mjs';
import { sanitizeComposeStatus } from '../../workflow/bundle/tools/compose-status.mjs';

const bundle = fileURLToPath(new URL('../../workflow/bundle/', import.meta.url));
const sourceSha = 'a'.repeat(40);
const catalog = {
  schema_version: '1',
  acceptance_service: 'acceptance-tests',
  images: [
    {
      id: 'web',
      service: 'web',
      context: 'apps/web',
      dockerfile: 'apps/web/Dockerfile',
      target: 'runtime',
    },
    { id: 'api', service: 'api', context: 'services/api', dockerfile: 'services/api/Dockerfile' },
  ],
};
const digest = `sha256:${'b'.repeat(64)}`;
const migration = {
  id: 'schema-v2',
  service: 'api',
  compatibility: 'forward-only',
  recovery_strategy: 'restore-backup',
  recovery_instructions:
    'Restore the pre-deployment database backup before deploying the prior release.',
};

test('image catalog creates a stable build matrix without interpreting project paths as commands', () => {
  assert.deepEqual(imageMatrix(catalog), {
    include: [
      {
        id: 'web',
        context: 'apps/web',
        dockerfile: 'apps/web/Dockerfile',
        target: 'runtime',
        service: 'web',
      },
      {
        id: 'api',
        context: 'services/api',
        dockerfile: 'services/api/Dockerfile',
        target: '',
        service: 'api',
      },
    ],
  });
});

test('image catalog rejects traversal, absolute paths, duplicate IDs, and unsafe Compose names', () => {
  for (const context of ['../outside', '/absolute/path', 'C:/outside', 'apps/../secret']) {
    assert.throws(() =>
      validateCatalog({ ...catalog, images: [{ ...catalog.images[0], context }] }),
    );
  }
  assert.throws(() =>
    validateCatalog({ ...catalog, images: [catalog.images[0], catalog.images[0]] }),
  );
  assert.throws(() => validateCatalog({ ...catalog, acceptance_service: 'acceptance-tests; rm' }));
  assert.throws(() =>
    validateCatalog({ ...catalog, images: [{ ...catalog.images[0], context: 'apps/\nname' }] }),
  );
});

test('image catalog validates ordered migration metadata against configured digest-built services', () => {
  validateCatalog({ ...catalog, migrations: [migration] });
  assert.throws(
    () => validateCatalog({ ...catalog, migrations: [{ ...migration, service: 'missing' }] }),
    /configured service/,
  );
  assert.throws(
    () =>
      validateCatalog({ ...catalog, migrations: [{ ...migration, recovery_instructions: ' ' }] }),
    /recovery instructions/,
  );
});

test('GHCR preflight allows absent and private packages but blocks public or unverifiable destinations', async () => {
  const options = {
    owner: 'example',
    ownerType: 'Organization',
    repository: 'product',
    apiBaseUrl: 'https://api.github.test',
    token: 'fixture-token',
  };
  const response = (packages, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => packages,
  });
  const fetchFor = (result) => async (_url, request) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    return result;
  };

  const absent = await assertPrivatePackageVisibility(catalog, {
    ...options,
    fetchImpl: fetchFor(response([])),
  });
  assert.deepEqual(absent, { checkedExistingCount: 0, imageCount: 2 });

  const privatePackages = await assertPrivatePackageVisibility(catalog, {
    ...options,
    fetchImpl: fetchFor(
      response([
        { name: 'product/web', visibility: 'private' },
        { name: 'product/api', visibility: 'private' },
      ]),
    ),
  });
  assert.deepEqual(privatePackages, { checkedExistingCount: 2, imageCount: 2 });

  await assert.rejects(
    assertPrivatePackageVisibility(catalog, {
      ...options,
      fetchImpl: fetchFor(response([{ name: 'product/web', visibility: 'public' }])),
    }),
    /only private packages are allowed/,
  );
  await assert.rejects(
    assertPrivatePackageVisibility(catalog, {
      ...options,
      fetchImpl: fetchFor(response([], 403)),
    }),
    /HTTP 403/,
  );
  await assert.rejects(
    assertPrivatePackageVisibility(catalog, {
      ...options,
      fetchImpl: fetchFor(response([{ name: 'product/web', visibility: 'unknown' }])),
    }),
    /only private packages are allowed/,
  );
});

test('GHCR preflight follows only same-origin pagination links', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url).href);
    if (requests.length === 1) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          link: '<https://api.github.test/orgs/example/packages?package_type=container&per_page=100&page=2>; rel="next"',
        }),
        json: async () => [],
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [{ name: 'product/web', visibility: 'private' }],
    };
  };
  await assertPrivatePackageVisibility(catalog, {
    owner: 'example',
    ownerType: 'Organization',
    repository: 'product',
    apiBaseUrl: 'https://api.github.test',
    token: 'fixture-token',
    fetchImpl,
  });
  assert.equal(requests.length, 2);
  await assert.rejects(
    assertPrivatePackageVisibility(catalog, {
      owner: 'example',
      ownerType: 'Organization',
      repository: 'product',
      apiBaseUrl: 'https://api.github.test',
      token: 'fixture-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ link: '<https://attacker.test/steal-token>; rel="next"' }),
        json: async () => [],
      }),
    }),
    /unsafe or repeated URL/,
  );
});

test('Compose diagnostics retain only service health fields and discard command or label data', () => {
  const result = sanitizeComposeStatus(
    JSON.stringify({
      Service: 'api',
      State: 'running',
      Health: 'healthy',
      ExitCode: 0,
      Command: 'start --password hidden-secret',
      Labels: { token: 'hidden-secret' },
    }),
  );
  assert.deepEqual(result, {
    available: true,
    services: [{ service: 'api', state: 'running', health: 'healthy', exit_code: 0 }],
  });
  assert.doesNotMatch(JSON.stringify(result), /hidden-secret|Command|Labels/);
  assert.deepEqual(sanitizeComposeStatus('not-json'), { available: false, services: [] });
});

test('candidate set requires exact configured image coverage from the requested source and immutable digests', () => {
  const manifests = catalog.images.map((image) => ({
    schema_version: '1',
    image_id: image.id,
    image: `ghcr.io/example/product/${image.id}`,
    digest,
    source_sha: sourceSha,
  }));
  assert.equal(
    validateCandidateSet(catalog, manifests, { sourceSha, owner: 'example', repository: 'product' })
      .length,
    2,
  );
  assert.equal(
    validateCandidateSet(catalog, manifests, { sourceSha, owner: 'Example', repository: 'Product' })
      .length,
    2,
  );
  assert.throws(
    () =>
      validateCandidateSet(catalog, manifests.slice(0, 1), {
        sourceSha,
        owner: 'example',
        repository: 'product',
      }),
    /exactly one/,
  );
  assert.throws(
    () =>
      validateCandidateSet(
        catalog,
        [manifests[0], { ...manifests[1], source_sha: 'c'.repeat(40) }],
        { sourceSha, owner: 'example', repository: 'product' },
      ),
    /different source SHA/,
  );
  assert.throws(
    () =>
      validateCandidateSet(catalog, [manifests[0], { ...manifests[1], digest: 'latest' }], {
        sourceSha,
        owner: 'example',
        repository: 'product',
      }),
    /immutable digest/,
  );
  assert.throws(
    () =>
      validateCandidateSet(catalog, [manifests[0], manifests[0]], {
        sourceSha,
        owner: 'example',
        repository: 'product',
      }),
    /Duplicate candidate/,
  );
});

test('Compose override is valid JSON and pins each configured service to the exact registry digest', () => {
  const candidates = validateCandidateSet(
    catalog,
    catalog.images.map((image) => ({
      schema_version: '1',
      image_id: image.id,
      image: `ghcr.io/example/product/${image.id}`,
      digest,
      source_sha: sourceSha,
    })),
    { sourceSha, owner: 'example', repository: 'product' },
  );
  const override = JSON.parse(composeDigestOverride(candidates));
  assert.equal(override.services.web.image, `ghcr.io/example/product/web@${digest}`);
  assert.equal(override.services.api.image, `ghcr.io/example/product/api@${digest}`);
});

test('release preparation accepts only a successful verified candidate run and writes digest-only release assets', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'container-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalogPath = path.join(directory, 'container-images.json');
  await writeFile(
    catalogPath,
    `${JSON.stringify({ ...catalog, migrations: [migration] }, null, 2)}\n`,
  );
  const manifestsDirectory = path.join(directory, 'candidate-manifests');
  await mkdir(manifestsDirectory);
  for (const image of catalog.images) {
    await writeFile(
      path.join(manifestsDirectory, `${image.id}.json`),
      JSON.stringify({
        schema_version: '1',
        image_id: image.id,
        image: `ghcr.io/example/product/${image.id}`,
        digest,
        source_sha: sourceSha,
      }),
    );
  }
  const candidateSetPath = path.join(directory, 'candidate-set.json');
  const toolPath = path.join(bundle, 'tools/container-images.mjs');
  execFileSync(
    process.execPath,
    [
      toolPath,
      'candidate-compose',
      '--catalog',
      catalogPath,
      '--manifests',
      manifestsDirectory,
      '--source-sha',
      sourceSha,
      '--owner',
      'example',
      '--repository',
      'product',
      '--output',
      path.join(directory, 'compose.digest.json'),
      '--manifest-output',
      candidateSetPath,
    ],
    { encoding: 'utf8' },
  );
  const sourceRunPath = path.join(directory, 'source-run.json');
  const sourceRun = {
    databaseId: 12345,
    conclusion: 'success',
    headSha: sourceSha,
    headBranch: 'main',
    event: 'push',
    workflowName: 'Publish and verify image candidates',
  };
  await writeFile(sourceRunPath, JSON.stringify(sourceRun));
  const manifestPath = path.join(directory, 'release-manifest.json');
  const notesPath = path.join(directory, 'release-notes.md');
  const args = [
    toolPath,
    'release-prepare',
    '--catalog',
    catalogPath,
    '--candidate-set',
    candidateSetPath,
    '--source-run',
    sourceRunPath,
    '--source-run-id',
    '12345',
    '--source-sha',
    sourceSha,
    '--integration-branch',
    'main',
    '--version',
    '1.2.3',
    '--owner',
    'example',
    '--repository',
    'product',
    '--output',
    manifestPath,
    '--notes-output',
    notesPath,
  ];
  execFileSync(process.execPath, args, { encoding: 'utf8' });
  const release = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(release.tag, 'v1.2.3');
  assert.equal(release.prerelease, false);
  assert.equal(release.source_sha, sourceSha);
  assert.equal(release.images[0].reference, `ghcr.io/example/product/web@${digest}`);
  assert.deepEqual(release.migrations, [migration]);
  assert.match(await readFile(notesPath, 'utf8'), /schema-v2 \(forward-only; restore-backup\)/);
  assert.match(await readFile(notesPath, 'utf8'), /does not rebuild or retag/);

  execFileSync(
    process.execPath,
    args.map((value) => (value === '1.2.3' ? '1.2.3-rc.1' : value)),
    { encoding: 'utf8' },
  );
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).prerelease, true);

  await writeFile(sourceRunPath, JSON.stringify({ ...sourceRun, conclusion: 'failure' }));
  assert.throws(() => execFileSync(process.execPath, args, { encoding: 'utf8' }));
  await writeFile(sourceRunPath, JSON.stringify(sourceRun));
  assert.throws(() =>
    execFileSync(
      process.execPath,
      args.map((value) => (value === '1.2.3' ? 'latest' : value)),
      { encoding: 'utf8' },
    ),
  );
});

test('release tag creation is idempotent for the same source and refuses an existing tag at another commit', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (options.method === 'POST') {
      return {
        status: 201,
        json: async () => ({ object: { type: 'commit', sha: sourceSha } }),
      };
    }
    return { status: 404, json: async () => ({}) };
  };
  const created = await ensureGitTag({
    apiUrl: 'https://api.github.com',
    token: 'test-token',
    repository: 'example/product',
    tag: 'v1.2.3',
    sourceSha,
    fetchImpl,
  });
  assert.equal(created.created, true);
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(JSON.parse(requests[1].options.body).sha, sourceSha);
  await assert.rejects(
    ensureGitTag({
      apiUrl: 'https://api.github.com',
      token: 'test-token',
      repository: 'example/product',
      tag: 'v1.2.3',
      sourceSha,
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({ object: { type: 'commit', sha: 'c'.repeat(40) } }),
      }),
    }),
    /different commit/,
  );
});

test('release publication reconciles an existing matching manifest without rebuilding or overwriting it', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'release-publisher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'release-manifest.json');
  const notesPath = path.join(directory, 'release-notes.md');
  const manifest =
    '{"tag":"v1.2.3","version":"1.2.3","prerelease":false,"source_sha":"' + sourceSha + '"}\n';
  await writeFile(manifestPath, manifest);
  await writeFile(notesPath, 'Verified release notes\n');
  const calls = [];
  const ghCalls = [];
  let releaseExists = true;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/git/ref/tags/v1.2.3')) {
      return { status: 200, json: async () => ({ object: { type: 'commit', sha: sourceSha } }) };
    }
    return releaseExists
      ? {
          status: 200,
          json: async () => ({ tag_name: 'v1.2.3', draft: false, prerelease: false }),
        }
      : { status: 404, json: async () => ({}) };
  };
  const command = async (args) => {
    ghCalls.push(args);
    if (args[1] === 'create') releaseExists = true;
    if (args[1] === 'download') {
      const outputDirectory = args[args.indexOf('--dir') + 1];
      await writeFile(path.join(outputDirectory, 'release-manifest.json'), manifest);
    }
  };
  const result = await publishRelease({
    apiUrl: 'https://api.github.com',
    token: 'test-token',
    repository: 'example/product',
    tag: 'v1.2.3',
    sourceSha,
    manifestPath,
    notesPath,
    fetchImpl,
    command,
  });
  assert.equal(result.reconciled, true);
  assert.equal(calls.length, 2);
  releaseExists = false;
  const firstPublication = await publishRelease({
    apiUrl: 'https://api.github.com',
    token: 'test-token',
    repository: 'example/product',
    tag: 'v1.2.3',
    sourceSha,
    manifestPath,
    notesPath,
    fetchImpl,
    command,
  });
  assert.equal(firstPublication.reconciled, false);
  assert.ok(ghCalls.some((args) => args[1] === 'create'));
  await assert.rejects(
    publishRelease({
      apiUrl: 'http://api.github.com',
      token: 'test-token',
      repository: 'example/product',
      tag: 'v1.2.3',
      sourceSha,
      manifestPath,
      notesPath,
      fetchImpl,
      command,
    }),
    /must be HTTPS/,
  );
});

test('bundle includes the project image catalog template and opt-in Actions templates with no publishing on PR', async () => {
  const sample = JSON.parse(
    await readFile(path.join(bundle, 'templates/container-images.example.json'), 'utf8'),
  );
  validateCatalog(sample);
  const verify = await readFile(
    path.join(bundle, 'templates/github-actions/container-tests.yml'),
    'utf8',
  );
  const publish = await readFile(
    path.join(bundle, 'templates/github-actions/publish-candidates.yml'),
    'utf8',
  );
  const release = await readFile(
    path.join(bundle, 'templates/github-actions/publish-release.yml'),
    'utf8',
  );
  assert.match(verify, /pull_request:/);
  assert.match(verify, /push: false/);
  assert.doesNotMatch(verify, /packages:\s*write/);
  assert.match(publish, /vars\.WORKFLOW_INTEGRATION_BRANCH/);
  assert.match(publish, /packages:\s*write/);
  assert.match(publish, /packages:\s*read/);
  assert.match(publish, /registry-private-check/);
  assert.ok(
    publish.indexOf('Block publication to an existing public GHCR package') <
      publish.indexOf('Build and publish unique source candidate'),
  );
  assert.match(publish, /SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(publish, /candidate-write/);
  assert.match(publish, /candidate-compose/);
  assert.ok(
    publish.lastIndexOf('Confirm all published packages remain private') >
      publish.indexOf('Build and publish unique source candidate'),
  );
  assert.ok(
    publish.lastIndexOf('Confirm all published packages remain private') <
      publish.indexOf('Verify every exact published digest can be pulled'),
  );
  assert.match(publish, /compose\.ci\.yaml/);
  assert.match(publish, /--pull always --no-build/);
  assert.match(
    verify,
    /COMPOSE_PROJECT_NAME: ci-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(
    verify,
    /compose --project-name "\$COMPOSE_PROJECT_NAME" -f compose\.ci\.yaml down --volumes --remove-orphans/,
  );
  assert.match(
    publish,
    /COMPOSE_PROJECT_NAME: ci-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(
    publish,
    /compose --project-name "\$COMPOSE_PROJECT_NAME" -f compose\.ci\.yaml down --volumes --remove-orphans/,
  );
  assert.doesNotMatch(`${verify}\n${publish}`, /docker system prune|docker volume prune/);
  for (const template of [verify, publish]) {
    const capture = template.indexOf('Capture sanitized Compose status');
    const upload = template.indexOf('Retain sanitized Compose status on failure');
    const cleanup = template.indexOf('Stop containers and remove disposable CI volumes');
    assert.ok(capture >= 0 && capture < upload && upload < cleanup);
    assert.match(template, /compose-status\.mjs/);
    assert.match(
      template,
      /name: compose-status-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
    );
    assert.doesNotMatch(template, /compose .* logs|docker inspect/);
  }
  assert.match(publish, /name: verified-candidate-set/);
  assert.match(release, /environment: workflow-release/);
  assert.match(
    release,
    /run-name: Publish release v\$\{\{ inputs\.version \}\} from candidate run \$\{\{ inputs\.source_run_id \}\}/,
  );
  assert.match(release, /release-publisher\.mjs publish/);
  assert.doesNotMatch(release, /docker\/build-push-action/);
  for (const template of [verify, publish]) {
    assert.match(template, /docker\/build-push-action@[a-f0-9]{40}/);
    assert.match(template, /docker\/setup-buildx-action@[a-f0-9]{40}/);
  }
});

test('application Actions template runs an impact matrix and rejects empty or stale required checks', async () => {
  const template = await readFile(
    path.join(bundle, 'templates/github-actions/application-tests.yml'),
    'utf8',
  );
  assert.match(
    template,
    /pull_request:\s+types: \[opened, reopened, synchronize, ready_for_review\]/,
  );
  assert.match(template, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(template, /ci-test-matrix\.mjs matrix --profile \.workflow\/ci-profile\.json/);
  assert.match(template, /outputs\.matrices\)\.focused/);
  assert.match(template, /outputs\.matrices\)\.fast/);
  assert.match(template, /outputs\.matrices\)\.acceptance/);
  assert.match(template, /outputs\.matrices\)\.system/);
  assert.match(template, /node \.workflow\/tools\/ci-test-matrix\.mjs run/);
  assert.doesNotMatch(template, /run: node .*\$\{\{ matrix\./);
  assert.match(template, /name: Required application verification/);
  for (const category of ['focused', 'fast', 'acceptance', 'system']) {
    assert.match(template, new RegExp(`^  ${category}:$`, 'm'));
    assert.match(template, new RegExp(`outputs\\.${category}_count != '0'`));
  }
  assert.match(template, /test "\$DISCOVERED_COUNT" -gt 0/);
  assert.match(template, /test "\$DISCOVERED_SHA" = "\$EXPECTED_SHA"/);
  assert.match(template, /test "\$category_count" -gt 0/);
  assert.match(
    template,
    /focused-test-\$\{\{ matrix\.profile \}\}-\$\{\{ matrix\.application_key \}\}/,
  );
  assert.doesNotMatch(template, /packages:\s*write|docker\/build-push-action/);
  const example = JSON.parse(
    await readFile(path.join(bundle, 'templates/ci-profile.example.json'), 'utf8'),
  );
  assert.equal(example.applications.length, 2);
  assert.equal(example.commands['system-e2e'].application_ids[0], '*');
});

test('bundle installation recursively includes the image tooling and opt-in workflow templates', async (t) => {
  const { repository, succeeds } = await import('./helpers.mjs');
  const repo = await repository(t);
  succeeds(await repo.run('bundle.install'), 'bundle.install');
  for (const relative of [
    '.workflow/tools/container-images.mjs',
    '.workflow/tools/release-publisher.mjs',
    '.workflow/tools/compose-status.mjs',
    '.workflow/tools/ci-test-matrix.mjs',
    '.workflow/templates/container-images.example.json',
    '.workflow/templates/ci-profile.example.json',
    '.workflow/templates/github-actions/container-tests.yml',
    '.workflow/templates/github-actions/application-tests.yml',
    '.workflow/templates/github-actions/publish-candidates.yml',
    '.workflow/templates/github-actions/publish-release.yml',
  ]) {
    const installed = await readFile(path.join(repo.projectRoot, relative));
    const source = await readFile(path.join(bundle, relative.replace('.workflow/', '')));
    assert.deepEqual(installed, source);
  }
});
