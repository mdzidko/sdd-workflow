import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '../../workflow/lib/operations.mjs';

export function git(projectRoot, ...args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export async function repository(t, options = {}) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'codex-workflow-test-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  git(projectRoot, 'init');
  git(projectRoot, 'config', 'user.name', 'Workflow Test');
  git(projectRoot, 'config', 'user.email', 'workflow-test@example.invalid');
  git(projectRoot, 'config', 'commit.gpgsign', 'false');
  git(projectRoot, 'checkout', '-b', options.baseBranch ?? 'main');
  await writeFile(path.join(projectRoot, 'README.md'), '# Example project\n');
  git(projectRoot, 'add', 'README.md');
  git(projectRoot, 'commit', '-m', 'Initialize fixture project');

  const context = { projectRoot, ...options.context };
  const run = (operation, input = {}) => execute({ operation, input }, context);
  const write = async (relativePath, content) => {
    const absolutePath = path.join(projectRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  };
  return { projectRoot, run, write, git: (...args) => git(projectRoot, ...args) };
}

export function succeeds(result, operation) {
  assert.equal(result.operation, operation);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(typeof result.data, 'object');
  return result.data;
}

export function fails(result, operation, expectedCode) {
  assert.equal(result.operation, operation);
  assert.equal(result.ok, false, 'The unsafe or invalid request must be rejected.');
  assert.equal(typeof result.error?.code, 'string');
  assert.ok(result.error.code.length > 0);
  assert.notEqual(
    result.error.code,
    'NOT_IMPLEMENTED',
    'A stub is not evidence that a safety rule is enforced.',
  );
  if (expectedCode) assert.equal(result.error.code, expectedCode);
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0);
  return result.error;
}

export async function initialize(repo, overrides = {}) {
  return succeeds(
    await repo.run('workflow.init', {
      profile: {
        repository: { remote: 'origin', base_branch: 'main' },
        applications: [],
        commands: {},
        ...overrides,
      },
    }),
    'workflow.init',
  );
}

export async function startFeature(repo, input = {}) {
  return succeeds(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Allow adding a person.',
      ...input,
    }),
    'change.start',
  );
}

export async function stateBytes(repo) {
  return readFile(path.join(repo.projectRoot, '.workflow/state.json'), 'utf8');
}
