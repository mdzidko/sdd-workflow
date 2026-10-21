import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function apiEndpoint(apiUrl, pathname) {
  const base = new URL(apiUrl);
  ensure(
    base.protocol === 'https:' && !base.username && !base.password && !base.search && !base.hash,
    'GitHub API URL must be HTTPS and must not include credentials, a query, or a fragment.',
  );
  base.pathname = `${base.pathname.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`;
  return base;
}

async function requestJson(fetchImpl, apiUrl, token, pathname, options = {}) {
  const response = await fetchImpl(apiEndpoint(apiUrl, pathname), {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(30_000),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(options.headers ?? {}),
    },
  });
  let data = null;
  try {
    data = await response.json();
  } catch {}
  return { status: response.status, data };
}

export async function ensureGitTag({ apiUrl, token, repository, tag, sourceSha, fetchImpl = fetch }) {
  ensure(typeof token === 'string' && token.length > 0, 'A GitHub token is required.');
  ensure(/^[A-Za-z0-9_.-]{1,100}$/.test(tag), 'Tag contains unsupported characters.');
  ensure(/^[a-f0-9]{40,64}$/.test(sourceSha), 'sourceSha must be a full Git commit SHA.');
  const [owner, name, ...extra] = repository.split('/');
  ensure(!extra.length && owner && name, 'repository must have the form owner/name.');
  const base = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const refPath = `${base}/git/ref/tags/${encodeURIComponent(tag)}`;
  const readRef = async () => requestJson(fetchImpl, apiUrl, token, refPath);
  const verify = (ref) => {
    ensure(
      ref?.object?.type === 'commit' && ref.object.sha === sourceSha,
      `Tag ${tag} already exists at a different commit or is not a lightweight commit tag.`,
    );
  };
  const existing = await readRef();
  if (existing.status === 200) {
    verify(existing.data);
    return { created: false, tag, source_sha: sourceSha };
  }
  ensure(existing.status === 404, `Could not inspect tag ${tag}: GitHub API returned ${existing.status}.`);
  const created = await requestJson(fetchImpl, apiUrl, token, `${base}/git/refs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: sourceSha }),
  });
  if (created.status === 201) {
    verify(created.data);
    return { created: true, tag, source_sha: sourceSha };
  }
  if (created.status === 422) {
    const raced = await readRef();
    ensure(raced.status === 200, `Tag creation conflicted and the existing ref could not be read (${raced.status}).`);
    verify(raced.data);
    return { created: false, tag, source_sha: sourceSha };
  }
  throw new Error(`Could not create tag ${tag}: GitHub API returned ${created.status}.`);
}

function runGh(args, env) {
  const result = spawnSync('gh', args, { encoding: 'utf8', env, windowsHide: true });
  ensure(result.status === 0, `GitHub CLI failed: ${(result.stderr || result.error?.message || 'unknown error').trim()}`);
}

export async function publishRelease({
  apiUrl,
  token,
  repository,
  tag,
  sourceSha,
  manifestPath,
  notesPath,
  fetchImpl = fetch,
  command = runGh,
}) {
  const base = `repos/${repository.split('/').map(encodeURIComponent).join('/')}`;
  const releaseManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  ensure(
    releaseManifest.tag === tag &&
      releaseManifest.source_sha === sourceSha &&
      releaseManifest.prerelease === releaseManifest.version.includes('-'),
    'Release manifest tag, source commit, or prerelease status does not match the request.',
  );
  await ensureGitTag({ apiUrl, token, repository, tag, sourceSha, fetchImpl });
  const releasePath = `${base}/releases/tags/${encodeURIComponent(tag)}`;
  const existing = await requestJson(fetchImpl, apiUrl, token, releasePath);
  if (existing.status === 404) {
    const createArgs = [
        'release',
        'create',
        tag,
        '--repo',
        repository,
        '--verify-tag',
        '--title',
        tag,
        '--notes-file',
        notesPath,
        manifestPath,
      ];
    if (releaseManifest.prerelease) createArgs.splice(10, 0, '--prerelease');
    await command(createArgs, { ...process.env, GH_TOKEN: token });
  } else {
    ensure(existing.status === 200, `Could not inspect release ${tag}: GitHub API returned ${existing.status}.`);
  }

  const release = existing.status === 200 ? existing.data : (await requestJson(fetchImpl, apiUrl, token, releasePath)).data;
  ensure(release && release.tag_name === tag, `GitHub did not return the expected release ${tag}.`);
  ensure(release.draft === false, `Release ${tag} exists but is still a draft.`);
  ensure(release.prerelease === releaseManifest.prerelease, `Release ${tag} has a different prerelease status.`);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'workflow-release-'));
  try {
    await command(
      ['release', 'download', tag, '--repo', repository, '--pattern', path.basename(manifestPath), '--dir', temporary],
      { ...process.env, GH_TOKEN: token },
    );
    const [expected, actual] = await Promise.all([
      readFile(manifestPath),
      readFile(path.join(temporary, path.basename(manifestPath))),
    ]);
    ensure(expected.equals(actual), `Existing release ${tag} has a different digest manifest.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { published: true, tag, source_sha: sourceSha, reconciled: existing.status === 200 };
}

async function main(args) {
  const [operation, ...options] = args;
  ensure(operation === 'publish', 'Operation must be publish.');
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
  const token = process.env.GH_TOKEN;
  ensure(token, 'GH_TOKEN must be present in the protected environment.');
  const result = await publishRelease({
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    token,
    repository: required('repository'),
    tag: required('tag'),
    sourceSha: required('source-sha'),
    manifestPath: path.resolve(required('manifest')),
    notesPath: path.resolve(required('notes')),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
