import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const phases = ['task', 'increment', 'merge', 'release'];
const categories = ['unit', 'contract', 'integration', 'e2e', 'image', 'release'];
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/;
const safePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !path.isAbsolute(value) &&
  !value.split(/[\\/]/).some((part) => part === '..' || part === '.');

export function buildCiMatrix(profile, changedPaths) {
  if (!profile || !Array.isArray(profile.applications) || !profile.commands || Array.isArray(profile.commands))
    throw new Error('Project profile needs applications and named commands.');
  const applications = new Map();
  for (const app of profile.applications) {
    if (!app || !safeId.test(app.id ?? '') || !safePath(app.path) || applications.has(app.id))
      throw new Error('Each application needs a unique ID and project-relative application path.');
    applications.set(app.id, app.path.replaceAll('\\', '/').replace(/\/$/, ''));
  }
  if (!Array.isArray(changedPaths) || changedPaths.some((entry) => !safePath(entry)))
    throw new Error('Changed paths must be project-relative paths without traversal.');

  const knownImpact = changedPaths.length > 0 && changedPaths.every((changed) =>
    [...applications.values()].some((appPath) => changed.replaceAll('\\', '/').startsWith(`${appPath}/`) || changed.replaceAll('\\', '/') === appPath),
  );
  const affected = knownImpact
    ? new Set([...applications].filter(([, appPath]) => changedPaths.some((changed) =>
        changed.replaceAll('\\', '/').startsWith(`${appPath}/`) || changed.replaceAll('\\', '/') === appPath,
      )).map(([id]) => id))
    : new Set(applications.keys());
  const include = [];
  for (const [name, command] of Object.entries(profile.commands)) {
    if (!safeId.test(name)) throw new Error('Test profile names must be stable IDs.');
    if (!command || !Object.hasOwn(command, 'category') && !Object.hasOwn(command, 'cadence') && !Object.hasOwn(command, 'application_ids')) continue;
    if (!categories.includes(command.category) || !phases.includes(command.cadence) || !Array.isArray(command.application_ids) || command.application_ids.length === 0)
      throw new Error(`Test profile ${name} needs a supported category, cadence, and application_ids.`);
    if (typeof command.command !== 'string' || !/^(?:[A-Za-z0-9_.-]+|(?:\.\.?[\\/])?[A-Za-z0-9_./\\-]+)$/.test(command.command) || !Array.isArray(command.args) || !command.args.every((arg) => typeof arg === 'string'))
      throw new Error(`Test profile ${name} needs a safe executable and string argument array.`);
    if (command.timeout_ms !== undefined && (!Number.isInteger(command.timeout_ms) || command.timeout_ms < 1 || command.timeout_ms > 300_000))
      throw new Error(`Test profile ${name} has an invalid bounded timeout.`);
    const ids = command.application_ids;
    if ((ids.includes('*') && ids.length !== 1) || new Set(ids).size !== ids.length || (!ids.includes('*') && ids.some((id) => !applications.has(id))))
      throw new Error(`Test profile ${name} references an unknown application or mixes the system-wide marker with application IDs.`);
    if (phases.indexOf(command.cadence) > phases.indexOf('merge')) continue;
    const scope = ids.includes('*') ? ['*'] : ids.filter((id) => affected.has(id));
    for (const application_id of scope) {
      include.push({
        profile: name,
        category: command.category,
        application_id,
        application_key: application_id === '*' ? 'system' : application_id,
        working_directory: application_id === '*' ? '.' : applications.get(application_id),
      });
    }
  }
  include.sort((a, b) => phases.indexOf(profile.commands[a.profile].cadence) - phases.indexOf(profile.commands[b.profile].cadence) || a.category.localeCompare(b.category) || a.profile.localeCompare(b.profile) || a.application_id.localeCompare(b.application_id));
  if (include.length === 0) throw new Error('No eligible CI test profiles cover the detected project impact.');
  const matrices = {
    focused: include.filter(
      (entry) => entry.application_id !== '*' && ['unit', 'contract'].includes(entry.category),
    ),
    fast: include.filter(
      (entry) => entry.application_id !== '*' && entry.category === 'integration',
    ),
    acceptance: include.filter(
      (entry) => entry.application_id !== '*' && entry.category === 'e2e',
    ),
    system: include.filter((entry) => entry.application_id === '*'),
  };
  const emptyMatrices = Object.entries(matrices)
    .filter(([, entries]) => entries.length === 0)
    .map(([name]) => name);
  if (emptyMatrices.length > 0)
    throw new Error(
      `Required CI matrices are empty: ${emptyMatrices.join(', ')}. Configure focused, fast, acceptance, and system test profiles for the impacted applications.`,
    );
  return {
    include,
    matrices,
    impact_known: knownImpact,
    application_ids: [...affected].sort(),
  };
}

async function main(args) {
  const [mode, ...rest] = args;
  if (mode === 'run' && rest.length === 0) {
    const profile = JSON.parse(await fs.readFile('.workflow/ci-profile.json', 'utf8'));
    const name = process.env.WORKFLOW_TEST_PROFILE;
    const applicationId = process.env.WORKFLOW_TEST_APPLICATION;
    const command = profile.commands?.[name];
    if (!command || !command.application_ids?.includes(applicationId) && !command.application_ids?.includes('*'))
      throw new Error('The requested test profile is not registered for this application.');
    const workingDirectory = applicationId === '*' ? '.' : profile.applications.find((app) => app.id === applicationId)?.path;
    if (!workingDirectory || !safePath(workingDirectory)) throw new Error('The application working directory is invalid.');
    const result = spawnSync(command.command, command.args, {
      cwd: workingDirectory,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      timeout: command.timeout_ms ?? 300_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key) && key !== 'NODE_OPTIONS')),
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  if (mode !== 'matrix' || rest.length !== 4 || rest[0] !== '--profile' || rest[2] !== '--changed-paths')
    throw new Error('Usage: ci-test-matrix.mjs matrix --profile <path> --changed-paths <json-path>');
  const profile = JSON.parse(await fs.readFile(rest[1], 'utf8'));
  const changedPaths = JSON.parse(await fs.readFile(rest[3], 'utf8'));
  process.stdout.write(`${JSON.stringify(buildCiMatrix(profile, changedPaths))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
