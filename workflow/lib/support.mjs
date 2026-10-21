import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export class WorkflowError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function requireValue(condition, code, message) {
  if (!condition) throw new WorkflowError(code, message);
}

export function identifier(value) {
  requireValue(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(value),
    'INVALID_PATH',
    'Identifiers must contain only letters, digits, underscores, and hyphens.',
  );
  return value;
}

export const hash = (value) =>
  createHash('sha256')
    .update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const posix = (value) => value.replaceAll('\\', '/');

const blockedSegments = new Set([
  '.git',
  '.workflow',
  '.workflow-runtime',
  '.aws',
  '.ssh',
  'node_modules',
]);
export function readablePath(relative) {
  return !posix(relative)
    .toLowerCase()
    .split('/')
    .some(
      (part) =>
        blockedSegments.has(part) ||
        part === '.env' ||
        part.startsWith('.env.') ||
        /\.(pem|key|p12|pfx)$/.test(part) ||
        /^(credentials|auth)\.json$/.test(part),
    );
}

export async function safePath(root, relative, { protectedAccess = false } = {}) {
  requireValue(
    typeof relative === 'string' &&
      relative.length > 0 &&
      !relative.includes('\0') &&
      !relative.includes(':') &&
      !path.isAbsolute(relative),
    'INVALID_PATH',
    'A portable project-relative path is required.',
  );
  const parts = posix(relative).split('/');
  requireValue(
    !parts.includes('..') &&
      !parts.some((part) => part.toLowerCase() === '.git') &&
      (protectedAccess || readablePath(relative)),
    'INVALID_PATH',
    'The requested path is outside the permitted project scope.',
  );
  const base = await fs.realpath(root);
  const target = path.resolve(base, relative);
  requireValue(
    target.startsWith(`${base}${path.sep}`),
    'INVALID_PATH',
    'The path must remain inside the project.',
  );
  let cursor = base;
  for (const part of path.relative(base, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      requireValue(
        !(await fs.lstat(cursor)).isSymbolicLink(),
        'INVALID_PATH',
        'Symbolic links are not permitted for workflow file operations.',
      );
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

export async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function git(root, args, { allowFailure = false, env = process.env } = {}) {
  const result = spawnSync('git', ['--literal-pathspecs', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (!allowFailure && (result.error || result.status !== 0))
    throw new WorkflowError(
      'GIT_FAILED',
      result.error?.message || result.stderr.trim() || 'Git operation failed.',
    );
  return allowFailure ? result : result.stdout.trim();
}

export async function sourceFiles(root, { bounded = true } = {}) {
  const raw = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const result = [];
  for (const relative of new Set(raw.split('\0').filter(Boolean))) {
    if (!readablePath(relative)) continue;
    try {
      const absolute = await safePath(root, relative);
      const stat = await fs.lstat(absolute);
      if (stat.isFile() && (!bounded || stat.size < 2 * 1024 * 1024)) result.push(relative);
    } catch (error) {
      if (!['INVALID_PATH', 'ENOENT'].includes(error.code)) throw error;
    }
  }
  return result.sort();
}

export async function fingerprint(root, command) {
  const files = [];
  for (const relative of await sourceFiles(root, { bounded: false }))
    files.push([relative, hash(await fs.readFile(await safePath(root, relative)))]);
  const inputs = [];
  for (const arg of command?.args ?? []) {
    if (typeof arg !== 'string' || arg.startsWith('-')) continue;
    try {
      const absolute = path.resolve(root, arg);
      if ((await fs.stat(absolute)).isFile()) inputs.push([arg, hash(await fs.readFile(absolute))]);
    } catch {
      /* An argument need not be a file. */
    }
  }
  return hash({ files, command, inputs });
}

export async function revision(root) {
  const head = git(root, ['rev-parse', 'HEAD']);
  return git(root, ['status', '--porcelain'])
    ? `${head}+dirty:${(await fingerprint(root)).slice(0, 12)}`
    : head;
}

export function redact(value, env = process.env) {
  let serialized = JSON.stringify(value);
  for (const [key, secret] of Object.entries(env)) {
    if (
      /(TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key) &&
      typeof secret === 'string' &&
      secret.length >= 6
    )
      serialized = serialized.split(secret).join('[REDACTED]');
  }
  return JSON.parse(serialized);
}
