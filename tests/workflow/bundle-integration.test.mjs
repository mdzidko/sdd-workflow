import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../../workflow/lib/operations.mjs';
import { fails, git, repository, succeeds } from './helpers.mjs';

const bundleRoot = fileURLToPath(new URL('../../workflow/bundle/', import.meta.url));

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(absolute)));
    else files.push(absolute);
  }
  return files.sort();
}

test('bundle inspection reports a versioned entry skill and requires installation in an unrelated project', async (t) => {
  const repo = await repository(t);
  const inspected = succeeds(await repo.run('bundle.inspect'), 'bundle.inspect');
  assert.match(inspected.manifest.bundle_version, /^\d+\.\d+\.\d+$/);
  assert.equal(inspected.manifest.entry_skill, 'sdlc-workflow');
  assert.equal(inspected.installation_required, true);
  assert.ok(inspected.manifest.resources.length > 0);
});

test('installation copies declared assets and runnable operations while preserving existing project configuration', async (t) => {
  const repo = await repository(t);
  await repo.write('AGENTS.md', '# Existing project instructions\n');
  await repo.write('.codex/config.toml', 'model = "existing-project-model"\n');
  const installed = succeeds(await repo.run('bundle.install'), 'bundle.install');
  assert.equal(installed.requires_reload, true);
  assert.equal(installed.native_invocation_verified, false);

  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'manifest.json'), 'utf8'));
  for (const resource of manifest.resources) {
    const source = path.join(bundleRoot, resource.source);
    const sources = resource.kind === 'directory' ? await filesUnder(source) : [source];
    for (const sourceFile of sources) {
      const destination =
        resource.kind === 'directory'
          ? path.join(repo.projectRoot, resource.destination, path.relative(source, sourceFile))
          : path.join(repo.projectRoot, resource.destination);
      assert.deepEqual(
        await readFile(destination),
        await readFile(sourceFile),
        `Installed bytes differ for ${resource.destination}`,
      );
    }
  }
  assert.equal(
    await readFile(path.join(repo.projectRoot, 'AGENTS.md'), 'utf8'),
    '# Existing project instructions\n',
  );
  assert.equal(
    await readFile(path.join(repo.projectRoot, '.codex/config.toml'), 'utf8'),
    'model = "existing-project-model"\n',
  );

  const output = execFileSync(
    process.execPath,
    [
      path.join(repo.projectRoot, 'scripts/workflow/run.mjs'),
      'workflow.init',
      '--project',
      repo.projectRoot,
    ],
    { cwd: repo.projectRoot, input: '{}', encoding: 'utf8', windowsHide: true },
  );
  const initialized = JSON.parse(output);
  succeeds(initialized, 'workflow.init');
  assert.equal(initialized.data.profile.repository.base_branch, 'main');
});

test('workflow setup installs into a new folder, creates a local base commit, and leaves project initialization for Codex', async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'codex-workflow-setup-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CEILING_DIRECTORIES: path.dirname(projectRoot),
    GIT_AUTHOR_NAME: 'Workflow Setup Test',
    GIT_AUTHOR_EMAIL: 'workflow-setup@example.invalid',
    GIT_COMMITTER_NAME: 'Workflow Setup Test',
    GIT_COMMITTER_EMAIL: 'workflow-setup@example.invalid',
  };

  const setup = succeeds(
    await execute({ operation: 'workflow.setup', input: {} }, { projectRoot, env }),
    'workflow.setup',
  );

  assert.equal(setup.mode, 'NEW_LOCAL_PROJECT');
  assert.equal(setup.base_branch, 'main');
  assert.equal(setup.remote_created, false);
  assert.equal(setup.native_invocation_verified, false);
  assert.ok(setup.initial_commit);
  assert.match(git(projectRoot, 'log', '-1', '--format=%s'), /initialize project workflow/);
  assert.equal(git(projectRoot, 'branch', '--show-current'), 'main');
  assert.equal(git(projectRoot, 'remote'), '');
  assert.equal(git(projectRoot, 'status', '--porcelain'), '');
  await access(path.join(projectRoot, '.agents/skills/sdlc-workflow/SKILL.md'));
  await access(path.join(projectRoot, 'workflow/lib/operations.mjs'));
  await assert.rejects(access(path.join(projectRoot, '.workflow/project.json')), {
    code: 'ENOENT',
  });
});

test('workflow setup commits only workflow-owned files on an existing clean integration branch', async (t) => {
  const repo = await repository(t, { baseBranch: 'integration' });
  await repo.write('README.md', '# Existing product\n');
  repo.git('add', 'README.md');
  repo.git('commit', '-m', 'Add existing product description');
  const base = repo.git('rev-parse', 'HEAD');

  const setup = succeeds(
    await repo.run('workflow.setup', { base_branch: 'integration' }),
    'workflow.setup',
  );

  assert.equal(setup.mode, 'EXISTING_REPOSITORY');
  assert.equal(setup.base_branch, 'integration');
  assert.equal(setup.initial_commit, repo.git('rev-parse', 'HEAD'));
  assert.equal(repo.git('rev-parse', 'HEAD^'), base);
  assert.equal(repo.git('show', 'HEAD:README.md'), '# Existing product');
  assert.equal(repo.git('status', '--porcelain'), '');
  assert.equal(repo.git('remote'), '');
});

test('workflow setup rejects a dirty existing project before installing any files', async (t) => {
  const repo = await repository(t);
  await repo.write('README.md', '# Uncommitted project change\n');

  fails(await repo.run('workflow.setup'), 'workflow.setup', 'DIRTY_WORKTREE');

  await assert.rejects(
    access(path.join(repo.projectRoot, '.agents/skills/sdlc-workflow/SKILL.md')),
    {
      code: 'ENOENT',
    },
  );
  assert.equal(repo.git('status', '--porcelain'), 'M README.md');
});

test('workflow setup preserves a conflicting user-owned asset and creates no commit', async (t) => {
  const repo = await repository(t);
  await repo.write('.agents/skills/sdlc-workflow/SKILL.md', '# User-owned skill\n');
  repo.git('add', '.agents/skills/sdlc-workflow/SKILL.md');
  repo.git('commit', '-m', 'Add an existing skill');
  const base = repo.git('rev-parse', 'HEAD');

  fails(await repo.run('workflow.setup'), 'workflow.setup', 'INSTALL_CONFLICT');

  assert.equal(repo.git('rev-parse', 'HEAD'), base);
  assert.equal(
    repo.git('show', 'HEAD:.agents/skills/sdlc-workflow/SKILL.md'),
    '# User-owned skill',
  );
  assert.equal(repo.git('status', '--porcelain'), '');
  await assert.rejects(access(path.join(repo.projectRoot, 'workflow/lib/operations.mjs')), {
    code: 'ENOENT',
  });
});

test('workflow setup is idempotent and does not add another installation commit', async (t) => {
  const repo = await repository(t);
  const first = succeeds(await repo.run('workflow.setup'), 'workflow.setup');
  const second = succeeds(await repo.run('workflow.setup'), 'workflow.setup');
  const installedRunnerOutput = execFileSync(
    process.execPath,
    [
      path.join(repo.projectRoot, 'scripts/workflow/run.mjs'),
      'workflow.setup',
      '--project',
      repo.projectRoot,
    ],
    { cwd: repo.projectRoot, input: '{}', encoding: 'utf8', windowsHide: true },
  );
  const installedRunner = JSON.parse(installedRunnerOutput);

  assert.equal(second.mode, 'ALREADY_SETUP');
  assert.equal(installedRunner.ok, true, JSON.stringify(installedRunner.error));
  assert.equal(installedRunner.data.mode, 'ALREADY_SETUP');
  assert.equal(second.initial_commit, first.initial_commit);
  assert.equal(repo.git('rev-list', '--count', 'main'), '2');
});

test('workflow setup refuses nonempty unversioned folders and refuses its own source repository', async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'codex-workflow-nonrepo-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeFile(path.join(projectRoot, 'README.md'), 'User-owned project file\n');

  fails(
    await execute(
      { operation: 'workflow.setup', input: {} },
      { projectRoot, env: { GIT_CEILING_DIRECTORIES: path.dirname(projectRoot) } },
    ),
    'workflow.setup',
    'TARGET_NOT_GIT',
  );
  fails(
    await execute(
      { operation: 'workflow.setup', input: {} },
      { projectRoot: path.resolve(bundleRoot, '../..') },
    ),
    'workflow.setup',
    'INVALID_TARGET',
  );
  assert.equal(
    await readFile(path.join(projectRoot, 'README.md'), 'utf8'),
    'User-owned project file\n',
  );
  await assert.rejects(access(path.join(projectRoot, '.agents')), { code: 'ENOENT' });
});

test('repeating an identical installation preserves every installed asset', async (t) => {
  const repo = await repository(t);
  succeeds(await repo.run('bundle.install'), 'bundle.install');
  const skillPath = path.join(repo.projectRoot, '.agents/skills/sdlc-workflow/SKILL.md');
  const originalSkill = await readFile(skillPath);
  const repeated = succeeds(await repo.run('bundle.install'), 'bundle.install');
  assert.equal(repeated.requires_reload, true);
  assert.equal(repeated.native_invocation_verified, false);
  assert.deepEqual(await readFile(skillPath), originalSkill);
});

test('a conflict discovered late in the install inventory prevents every earlier installation write', async (t) => {
  const repo = await repository(t);
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'manifest.json'), 'utf8'));
  const lastFile = manifest.resources.filter((resource) => resource.kind === 'file').at(-1);
  await repo.write(lastFile.destination, 'Existing user-owned file that must survive.\n');
  fails(await repo.run('bundle.install'), 'bundle.install', 'INSTALL_CONFLICT');
  assert.equal(
    await readFile(path.join(repo.projectRoot, lastFile.destination), 'utf8'),
    'Existing user-owned file that must survive.\n',
  );
  await assert.rejects(access(path.join(repo.projectRoot, manifest.resources[0].destination)), {
    code: 'ENOENT',
  });
  await assert.rejects(access(path.join(repo.projectRoot, 'scripts/workflow/run.mjs')), {
    code: 'ENOENT',
  });
});

test('file installation and caller claims cannot certify live native invocation or a permission boundary', async (t) => {
  const repo = await repository(t);
  succeeds(await repo.run('bundle.install'), 'bundle.install');
  const preflight = succeeds(
    await repo.run('bundle.preflight', {
      capabilities: { native_invocation: true, permission_boundary: true, custom_agents: true },
    }),
    'bundle.preflight',
  );
  assert.equal(preflight.ready, false);
  for (const capability of ['native_invocation', 'permission_boundary']) {
    const check = preflight.checks.find((candidate) => candidate.id === capability);
    assert.ok(check, `Missing capability check: ${capability}`);
    assert.equal(check.status, 'UNVERIFIED');
    assert.ok(check.message.length > 0);
  }
});

test('native agent definitions declare unique names and reference skills present in the bundle', async () => {
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'manifest.json'), 'utf8'));
  const agents = manifest.resources.filter(
    (resource) => resource.source.startsWith('agents/') && resource.source.endsWith('.toml'),
  );
  assert.ok(agents.length >= 2, 'The coordinator needs distinct author and reviewer roles.');
  const names = new Set();
  for (const resource of agents) {
    const body = await readFile(path.join(bundleRoot, resource.source), 'utf8');
    // Parse the deliberately small TOML subset used by the generated definitions.
    const name = body.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
    const instructions = body.match(
      /^developer_instructions\s*=\s*"""\r?\n([\s\S]*?)^"""\s*$/m,
    )?.[1];
    assert.ok(name, `Missing TOML name: ${resource.source}`);
    assert.equal(name, path.basename(resource.source, '.toml'));
    assert.equal(names.has(name), false, `Duplicate native role: ${name}`);
    names.add(name);
    assert.ok(instructions, `Missing developer_instructions: ${resource.source}`);
    const skillNames = [...instructions.matchAll(/\$(sdlc-[a-z-]+)/g)].map((match) => match[1]);
    assert.ok(skillNames.length > 0, `Role has no skill binding: ${name}`);
    for (const skillName of skillNames) {
      const skill = await readFile(path.join(bundleRoot, 'skills', skillName, 'SKILL.md'), 'utf8');
      assert.match(skill, new RegExp(`^name: ${skillName}$`, 'm'));
    }
  }
});
