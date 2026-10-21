import { requireValue, WorkflowError } from './support.mjs';

const API_VERSION = '2022-11-28';

export function githubConfiguration(value, environment = {}) {
  const trustedApiUrl = environment.GITHUB_API_URL ?? 'https://api.github.com';
  requireValue(
    value &&
      typeof value.owner === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.owner) &&
      value.owner !== '.' &&
      value.owner !== '..' &&
      typeof value.name === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.name) &&
      value.name !== '.' &&
      value.name !== '..',
    'GITHUB_CONFIG_INVALID',
    'Configure the GitHub repository owner and name in the project profile.',
  );
  let apiUrl;
  try {
    apiUrl = new URL(trustedApiUrl);
  } catch {
    throw new WorkflowError('GITHUB_CONFIG_INVALID', 'The GitHub API URL is invalid.');
  }
  requireValue(
    apiUrl.protocol === 'https:' &&
      !apiUrl.username &&
      !apiUrl.password &&
      !apiUrl.search &&
      !apiUrl.hash,
    'GITHUB_CONFIG_INVALID',
    'The GitHub API URL must use HTTPS and cannot embed credentials, a query, or a fragment.',
  );
  let configuredApiUrl;
  if (value.api_url !== undefined) {
    try {
      configuredApiUrl = new URL(value.api_url).href.replace(/\/+$/, '');
    } catch {
      throw new WorkflowError('GITHUB_CONFIG_INVALID', 'The configured GitHub API URL is invalid.');
    }
  }
  requireValue(
    configuredApiUrl === undefined || configuredApiUrl === apiUrl.href.replace(/\/+$/, ''),
    'GITHUB_CONFIG_INVALID',
    'A project profile cannot change the trusted GitHub API host. Configure GITHUB_API_URL in the protected environment for GitHub Enterprise.',
  );
  return {
    owner: value.owner,
    name: value.name,
    apiUrl: apiUrl.href.replace(/\/+$/, ''),
  };
}

export async function githubRequest(
  context,
  configuration,
  endpoint,
  { method = 'GET', body } = {},
) {
  const token = context.env?.GH_TOKEN ?? context.env?.GITHUB_TOKEN;
  requireValue(
    typeof token === 'string' && token.length > 0,
    'GITHUB_NOT_CONFIGURED',
    'Set GH_TOKEN or GITHUB_TOKEN in the protected execution environment; credentials are never stored in the project profile.',
  );
  const fetchImpl = context.fetchImpl ?? globalThis.fetch;
  requireValue(
    typeof fetchImpl === 'function',
    'GITHUB_NOT_CONFIGURED',
    'A fetch implementation is unavailable.',
  );
  let response;
  try {
    response = await fetchImpl(`${configuration.apiUrl}${endpoint}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new WorkflowError(
      error.name === 'TimeoutError' ? 'GITHUB_TIMEOUT' : 'GITHUB_UNAVAILABLE',
      'The configured GitHub API could not be reached. No response was trusted.',
    );
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new WorkflowError('GITHUB_RESPONSE_INVALID', 'GitHub returned a non-JSON response.');
    }
  }
  if (!response.ok)
    throw new WorkflowError(
      response.status === 404 ? 'GITHUB_NOT_FOUND' : 'GITHUB_API_ERROR',
      `GitHub API request failed with HTTP ${response.status}.`,
      { status: response.status },
    );
  return { data, headers: response.headers };
}

export async function githubDownload(
  context,
  configuration,
  endpoint,
  maximumBytes,
  accept = 'application/vnd.github+json',
) {
  const token = context.env?.GH_TOKEN ?? context.env?.GITHUB_TOKEN;
  requireValue(
    typeof token === 'string' && token.length > 0,
    'GITHUB_NOT_CONFIGURED',
    'Set GH_TOKEN or GITHUB_TOKEN in the protected execution environment; credentials are never stored in the project profile.',
  );
  const fetchImpl = context.fetchImpl ?? globalThis.fetch;
  const headers = {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
  };
  let response;
  try {
    response = await fetchImpl(`${configuration.apiUrl}${endpoint}`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new WorkflowError(
      error.name === 'TimeoutError' ? 'GITHUB_TIMEOUT' : 'GITHUB_UNAVAILABLE',
      'The configured GitHub artifact endpoint could not be reached. No response was trusted.',
    );
  }
  requireValue(
    [302, 303].includes(response.status),
    'GITHUB_API_ERROR',
    'GitHub did not return the expected artifact download redirect.',
  );
  let downloadUrl;
  try {
    downloadUrl = new URL(response.headers.get('location'));
  } catch {
    throw new WorkflowError(
      'GITHUB_RESPONSE_INVALID',
      'GitHub returned an invalid artifact redirect.',
    );
  }
  requireValue(
    downloadUrl.protocol === 'https:' && !downloadUrl.username && !downloadUrl.password,
    'GITHUB_RESPONSE_INVALID',
    'The artifact redirect must use HTTPS and cannot include embedded credentials.',
  );
  try {
    response = await fetchImpl(downloadUrl, {
      headers: { Accept: 'application/zip' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new WorkflowError(
      error.name === 'TimeoutError' ? 'GITHUB_TIMEOUT' : 'GITHUB_UNAVAILABLE',
      'The GitHub artifact archive could not be downloaded.',
    );
  }
  requireValue(response.ok, 'GITHUB_API_ERROR', 'The GitHub artifact archive download failed.');
  const contentLength = response.headers.get('content-length');
  requireValue(
    contentLength === null ||
      (/^\d+$/.test(contentLength) && Number(contentLength) <= maximumBytes),
    'GITHUB_RESPONSE_INVALID',
    'The GitHub artifact archive exceeds the allowed download size.',
  );
  requireValue(
    typeof response.body?.getReader === 'function',
    'GITHUB_RESPONSE_INVALID',
    'The artifact archive response cannot be read as a bounded stream.',
  );
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new WorkflowError(
          'GITHUB_RESPONSE_INVALID',
          'The GitHub artifact archive exceeds the allowed download size.',
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  requireValue(
    bytes.length > 0 && bytes.length <= maximumBytes,
    'GITHUB_RESPONSE_INVALID',
    'The GitHub artifact archive is empty or exceeds the allowed size.',
  );
  return bytes;
}

export function repositoryEndpoint(configuration, suffix) {
  return `/repos/${encodeURIComponent(configuration.owner)}/${encodeURIComponent(configuration.name)}${suffix}`;
}

export function summarizePullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    state: pullRequest.state,
    draft: Boolean(pullRequest.draft),
    head_ref: pullRequest.head?.ref,
    head_sha: pullRequest.head?.sha,
    base_ref: pullRequest.base?.ref,
    base_sha: pullRequest.base?.sha,
    merged: Boolean(pullRequest.merged),
    merge_commit_sha: pullRequest.merge_commit_sha,
    author_login: pullRequest.user?.login,
  };
}
