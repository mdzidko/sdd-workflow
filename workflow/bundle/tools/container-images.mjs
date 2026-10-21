import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPOSITORY = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const GITHUB_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const SHA = /^[a-f0-9]{40,64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateCatalog(catalog) {
  ensure(catalog && typeof catalog === 'object' && !Array.isArray(catalog), 'Catalog must be an object.');
  ensure(catalog.schema_version === '1', 'schema_version must be "1".');
  ensure(ID.test(catalog.acceptance_service ?? ''), 'acceptance_service must be a lowercase Compose service ID.');
  ensure(Array.isArray(catalog.images) && catalog.images.length > 0, 'images must contain at least one image.');
  const ids = new Set();
  const services = new Set();
  for (const image of catalog.images) {
    ensure(image && typeof image === 'object', 'Each image entry must be an object.');
    ensure(ID.test(image.id ?? '') && !ids.has(image.id), `Invalid or duplicate image ID: ${image.id}`);
    ensure(ID.test(image.service ?? '') && !services.has(image.service), `Invalid or duplicate Compose service: ${image.service}`);
    ensure(typeof image.context === 'string' && isSafeProjectPath(image.context), `Image ${image.id} has an unsafe build context.`);
    ensure(typeof image.dockerfile === 'string' && isSafeProjectPath(image.dockerfile), `Image ${image.id} has an unsafe Dockerfile path.`);
    ensure(image.target === undefined || (typeof image.target === 'string' && ID.test(image.target)), `Image ${image.id} has an invalid target.`);
    ids.add(image.id);
    services.add(image.service);
  }
  ensure(!services.has(catalog.acceptance_service), 'acceptance_service must not collide with an image service.');
  ensure(catalog.migrations === undefined || Array.isArray(catalog.migrations), 'migrations must be an ordered array.');
  const migrationIds = new Set();
  const migrationServices = new Set();
  for (const migration of catalog.migrations ?? []) {
    ensure(
      migration &&
        ID.test(migration.id ?? '') &&
        !migrationIds.has(migration.id) &&
        ID.test(migration.service ?? '') &&
        services.has(migration.service) &&
        !migrationServices.has(migration.service) &&
        ['backward-compatible', 'forward-only'].includes(migration.compatibility) &&
        ['roll-forward', 'restore-backup', 'manual'].includes(migration.recovery_strategy) &&
        typeof migration.recovery_instructions === 'string' &&
        migration.recovery_instructions.trim().length > 0,
      `Migration ${migration?.id ?? '(unknown)'} must map to a unique configured service and declare compatibility and recovery instructions.`,
    );
    migrationIds.add(migration.id);
    migrationServices.add(migration.service);
  }
  return catalog;
}

function isSafeProjectPath(value) {
  if (!value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  // eslint-disable-next-line no-control-regex -- Control characters are forbidden in untrusted paths.
  return !/[\u0000-\u001f\u007f]/.test(value) && parts.every((part) => part && part !== '.' && part !== '..');
}

export function imageMatrix(catalog) {
  validateCatalog(catalog);
  return { include: catalog.images.map(({ id, context, dockerfile, target, service }) => ({ id, context, dockerfile, target: target ?? '', service })) };
}

export function validateCandidateSet(catalog, manifests, { sourceSha, owner, repository }) {
  validateCatalog(catalog);
  ensure(SHA.test(sourceSha ?? ''), 'sourceSha must be a full Git commit SHA.');
  ensure(GITHUB_NAME.test(owner ?? '') && GITHUB_NAME.test(repository ?? ''), 'owner and repository must be GitHub identifiers.');
  ensure(Array.isArray(manifests), 'Candidate manifests must be an array.');
  const namespace = `ghcr.io/${owner.toLowerCase()}/${repository.toLowerCase()}`;
  const expected = new Map(catalog.images.map((image) => [image.id, `${namespace}/${image.id}`]));
  const accepted = new Map();
  for (const manifest of manifests) {
    ensure(manifest && manifest.schema_version === '1', 'Candidate manifest schema_version must be "1".');
    ensure(expected.has(manifest.image_id), `Candidate contains unknown image ID: ${manifest.image_id}`);
    ensure(!accepted.has(manifest.image_id), `Duplicate candidate manifest: ${manifest.image_id}`);
    ensure(manifest.source_sha === sourceSha, `Candidate ${manifest.image_id} was built from a different source SHA.`);
    ensure(manifest.image === expected.get(manifest.image_id), `Candidate ${manifest.image_id} has an unexpected registry image.`);
    ensure(DIGEST.test(manifest.digest ?? ''), `Candidate ${manifest.image_id} has an invalid immutable digest.`);
    accepted.set(manifest.image_id, manifest);
  }
  ensure(accepted.size === expected.size, 'Candidate set must contain exactly one manifest for every configured image.');
  return catalog.images.map((image) => ({
    image_id: image.id,
    image: expected.get(image.id),
    digest: accepted.get(image.id).digest,
    source_sha: sourceSha,
    service: image.service,
  }));
}

export function composeDigestOverride(candidates) {
  const services = Object.fromEntries(candidates.map((item) => [item.service, { image: `${item.image}@${item.digest}` }]));
  return `${JSON.stringify({ services }, null, 2)}\n`;
}

export async function assertPrivatePackageVisibility(catalog, {
  owner,
  ownerType,
  repository,
  apiBaseUrl,
  token,
  fetchImpl = fetch,
}) {
  validateCatalog(catalog);
  ensure(GITHUB_NAME.test(owner ?? '') && GITHUB_NAME.test(repository ?? ''), 'owner and repository must be GitHub identifiers.');
  ensure(['Organization', 'User'].includes(ownerType), 'ownerType must be Organization or User.');
  ensure(typeof token === 'string' && token.length > 0, 'A GitHub API token is required for package visibility checks.');
  const base = new URL(apiBaseUrl);
  ensure(base.protocol === 'https:', 'GitHub API URL must use HTTPS.');
  const endpoint = ownerType === 'Organization' ? 'orgs' : 'users';
  let nextUrl = new URL(`${endpoint}/${encodeURIComponent(owner)}/packages?package_type=container&per_page=100`, `${base.href.replace(/\/$/, '')}/`);
  const expectedNames = new Set(catalog.images.map((image) => `${repository}/${image.id}`.toLowerCase()));
  const seen = new Map();
  const visited = new Set();
  let pageCount = 0;

  while (nextUrl) {
    pageCount += 1;
    ensure(pageCount <= 100, 'GitHub package visibility pagination exceeded the documented 10,000-record limit.');
    ensure(nextUrl.origin === base.origin && !visited.has(nextUrl.href), 'GitHub package pagination returned an unsafe or repeated URL.');
    visited.add(nextUrl.href);
    const response = await fetchImpl(nextUrl, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    });
    ensure(response.ok, `GitHub package visibility check failed with HTTP ${response.status}.`);
    const packages = await response.json();
    ensure(Array.isArray(packages), 'GitHub package visibility response must be an array.');
    for (const item of packages) {
      ensure(item && typeof item.name === 'string' && typeof item.visibility === 'string', 'GitHub package visibility response contains an invalid package record.');
      const name = item.name.toLowerCase();
      if (expectedNames.has(name)) seen.set(name, item.visibility);
    }
    const link = response.headers.get('link') ?? '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = next ? new URL(next[1]) : null;
  }

  for (const name of expectedNames) {
    const visibility = seen.get(name);
    ensure(visibility === undefined || visibility === 'private', `GHCR package ${name} is ${visibility}; only private packages are allowed.`);
  }
  return { checkedExistingCount: seen.size, imageCount: expectedNames.size };
}

async function main(args) {
  const [command, ...options] = args;
  const values = new Map();
  for (let index = 0; index < options.length; index += 2) {
    ensure(options[index]?.startsWith('--') && options[index + 1], `Invalid argument near ${options[index] ?? 'end of arguments'}.`);
    values.set(options[index].slice(2), options[index + 1]);
  }
  const required = (key) => {
    const value = values.get(key);
    ensure(value, `Missing --${key}.`);
    return value;
  };
  const catalogPath = path.resolve(required('catalog'));
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  if (command === 'validate') {
    validateCatalog(catalog);
    process.stdout.write(`${JSON.stringify({ ok: true, image_count: catalog.images.length })}\n`);
    return;
  }
  if (command === 'matrix') {
    process.stdout.write(`${JSON.stringify(imageMatrix(catalog))}\n`);
    return;
  }
  if (command === 'registry-prefix') {
    const repository = (process.env.GITHUB_REPOSITORY ?? '').toLowerCase();
    const [owner, name, ...rest] = repository.split('/');
    ensure(!rest.length && REPOSITORY.test(owner ?? '') && REPOSITORY.test(name ?? ''), 'GITHUB_REPOSITORY must be owner/repository.');
    process.stdout.write(`image=ghcr.io/${owner}/${name}\n`);
    return;
  }
  if (command === 'registry-private-check') {
    const result = await assertPrivatePackageVisibility(catalog, {
      owner: required('owner'),
      ownerType: required('owner-type'),
      repository: required('repository'),
      apiBaseUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
      token: process.env.GITHUB_TOKEN,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  if (command === 'candidate-write') {
    const imageId = required('image-id');
    const configured = catalog.images.find((image) => image.id === imageId);
    ensure(configured, `Unknown image ID: ${imageId}`);
    const sourceSha = required('source-sha');
    ensure(SHA.test(sourceSha), 'source-sha must be a full Git commit SHA.');
    const owner = required('owner').toLowerCase();
    const repository = required('repository').toLowerCase();
    ensure(REPOSITORY.test(owner) && REPOSITORY.test(repository), 'owner and repository must be valid GitHub identifiers.');
    const digest = required('digest');
    ensure(DIGEST.test(digest), 'digest must be an immutable sha256 digest.');
    const candidateTag = required('candidate-tag');
    ensure(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(candidateTag), 'candidate-tag contains unsupported characters.');
    const manifest = {
      schema_version: '1',
      image_id: imageId,
      image: `ghcr.io/${owner}/${repository}/${imageId}`,
      digest,
      source_sha: sourceSha,
      candidate_tag: candidateTag,
      created_at: new Date().toISOString(),
    };
    const output = path.resolve(required('output'));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ ok: true, output })}\n`);
    return;
  }
  if (command === 'candidate-compose') {
    const directory = path.resolve(required('manifests'));
    const filenames = await fs.readdir(directory);
    const manifests = [];
    for (const filename of filenames.filter((name) => name.endsWith('.json')).sort()) {
      manifests.push(JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8')));
    }
    const candidates = validateCandidateSet(catalog, manifests, {
      sourceSha: required('source-sha'),
      owner: required('owner'),
      repository: required('repository'),
    });
    const output = path.resolve(required('output'));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, composeDigestOverride(candidates), { flag: 'w' });
    if (values.has('manifest-output')) {
      const manifestOutput = path.resolve(required('manifest-output'));
      await fs.mkdir(path.dirname(manifestOutput), { recursive: true });
      await fs.writeFile(
        manifestOutput,
        `${JSON.stringify({
          schema_version: '1',
          source_sha: required('source-sha'),
          candidates: candidates.map((candidate) => ({ schema_version: '1', ...candidate })),
        }, null, 2)}\n`,
        { flag: 'w' },
      );
    }
    process.stdout.write(`${JSON.stringify({ ok: true, image_count: candidates.length, output })}\n`);
    return;
  }
  if (command === 'release-prepare') {
    const integrationBranch = required('integration-branch');
    const sourceSha = required('source-sha');
    const owner = required('owner');
    const repository = required('repository');
    const version = required('version');
    const sourceRunId = required('source-run-id');
    ensure(VERSION.test(version), 'version must be a semantic version without a leading v.');
    ensure(/^\d{1,20}$/.test(sourceRunId), 'source-run-id must be a numeric GitHub Actions run ID.');
    const sourceRun = JSON.parse(await fs.readFile(path.resolve(required('source-run')), 'utf8'));
    ensure(String(sourceRun.databaseId) === sourceRunId, 'Source workflow run ID does not match source-run-id.');
    ensure(sourceRun.conclusion === 'success', 'Source candidate workflow did not complete successfully.');
    ensure(sourceRun.headSha === sourceSha && SHA.test(sourceSha), 'Source run commit does not match source-sha.');
    ensure(sourceRun.headBranch === integrationBranch, 'Source candidate was not built from the configured integration branch.');
    ensure(sourceRun.workflowName === 'Publish and verify image candidates', 'Source run is not the candidate build and verification workflow.');
    ensure(['push', 'workflow_dispatch'].includes(sourceRun.event), 'Source candidate workflow event is not allowed.');
    const candidateSet = JSON.parse(await fs.readFile(path.resolve(required('candidate-set')), 'utf8'));
    ensure(candidateSet && candidateSet.schema_version === '1' && candidateSet.source_sha === sourceSha, 'Candidate set does not match source-sha.');
    const candidates = validateCandidateSet(catalog, candidateSet.candidates, { sourceSha, owner, repository });
    const manifest = {
      schema_version: '1',
      version,
      tag: `v${version}`,
      prerelease: version.includes('-'),
      source_sha: sourceSha,
      source_run_id: sourceRunId,
      migrations: catalog.migrations ?? [],
      images: candidates.map(({ image_id, image, digest, service }) => ({
        image_id,
        image,
        digest,
        reference: `${image}@${digest}`,
        service,
      })),
    };
    const output = path.resolve(required('output'));
    const notesOutput = path.resolve(required('notes-output'));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.mkdir(path.dirname(notesOutput), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w' });
    const notes = [
      `Release ${manifest.tag}`,
      '',
      `Source commit: ${sourceSha}`,
      `Verified candidate workflow run: ${sourceRunId}`,
      '',
      'Container images (immutable digests):',
      ...manifest.images.map((image) => `- ${image.image_id}: ${image.reference}`),
      '',
      'Database migrations:',
      ...(manifest.migrations.length
        ? manifest.migrations.map(
            (migration) =>
              `- ${migration.id} (${migration.compatibility}; ${migration.recovery_strategy}): ${migration.recovery_instructions}`,
          )
        : ['- None']),
      '',
      'Images are referenced by the exact digests tested by the candidate workflow. This release does not rebuild or retag them.',
    ].join('\n');
    await fs.writeFile(notesOutput, `${notes}\n`, { flag: 'w' });
    process.stdout.write(`${JSON.stringify({ ok: true, version, tag: manifest.tag, image_count: candidates.length })}\n`);
    return;
  }
  throw new Error('Command must be validate, matrix, registry-prefix, registry-private-check, candidate-write, candidate-compose, or release-prepare.');
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
