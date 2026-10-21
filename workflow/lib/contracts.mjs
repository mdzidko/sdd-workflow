import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { identifier, requireValue } from './support.mjs';

export const bundleRoot = fileURLToPath(new URL('../bundle/', import.meta.url));
export async function catalog() {
  return JSON.parse(
    await fs.readFile(new URL('../bundle/contracts/artifact-types.json', import.meta.url), 'utf8'),
  );
}

export function validateProfile(value) {
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    'VALIDATION_FAILED',
    'The project profile must be an object.',
  );
  const repository = value.repository ?? { remote: 'origin', base_branch: 'main' };
  requireValue(
    typeof repository.base_branch === 'string' &&
      repository.base_branch.length > 0 &&
      !repository.base_branch.startsWith('-'),
    'VALIDATION_FAILED',
    'A valid integration branch is required.',
  );
  requireValue(
    typeof repository.remote === 'string' && /^[\w.-]+$/.test(repository.remote),
    'VALIDATION_FAILED',
    'The Git remote must be a configured remote name.',
  );
  requireValue(
    Array.isArray(value.applications ?? []),
    'VALIDATION_FAILED',
    'Applications must be an array.',
  );
  const commands = value.commands ?? {};
  requireValue(
    commands && typeof commands === 'object' && !Array.isArray(commands),
    'VALIDATION_FAILED',
    'Commands must be named profiles.',
  );
  for (const entry of Object.values(commands))
    requireValue(
      entry &&
        typeof entry.command === 'string' &&
        Array.isArray(entry.args) &&
        entry.args.every((arg) => typeof arg === 'string') &&
        (entry.timeout_ms === undefined ||
          (Number.isInteger(entry.timeout_ms) &&
            entry.timeout_ms > 0 &&
            entry.timeout_ms <= 300_000)),
      'VALIDATION_FAILED',
      'Each command profile needs command, string arguments, and a bounded timeout.',
    );
  function rejectSecrets(object) {
    for (const [key, field] of Object.entries(object)) {
      requireValue(
        !/^(token|password|secret|api_key|access_token|private_key)$/i.test(key),
        'VALIDATION_FAILED',
        'Profiles must reference credentials, not store secret values.',
      );
      if (field && typeof field === 'object') rejectSecrets(field);
    }
  }
  rejectSecrets(value);
  return {
    ...value,
    schema_version: '1',
    bundle_version: '0.1.24',
    repository,
    applications: value.applications ?? [],
    commands,
  };
}

function matchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object')
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

export async function validateArtifact(artifact) {
  requireValue(
    artifact &&
      artifact.schema_version === '1' &&
      typeof artifact.type === 'string' &&
      typeof artifact.title === 'string' &&
      artifact.title.trim() &&
      artifact.data &&
      typeof artifact.data === 'object' &&
      !Array.isArray(artifact.data),
    'VALIDATION_FAILED',
    'The artifact envelope is incomplete or invalid.',
  );
  identifier(artifact.id);
  identifier(artifact.change_id);
  const canonical = JSON.parse(
    await fs.readFile(new URL('../bundle/contracts/artifact.schema.json', import.meta.url), 'utf8'),
  );
  requireValue(
    canonical.properties.status.enum.includes(artifact.status),
    'VALIDATION_FAILED',
    'The artifact status is invalid.',
  );
  requireValue(
    Object.keys(artifact).every((key) => Object.hasOwn(canonical.properties, key)),
    'VALIDATION_FAILED',
    'The artifact envelope contains unsupported fields.',
  );
  const type = (await catalog()).types[artifact.type];
  requireValue(type, 'VALIDATION_FAILED', 'The artifact type is not registered.');
  for (const field of type.required)
    requireValue(
      Object.hasOwn(artifact.data, field),
      'VALIDATION_FAILED',
      `Missing artifact data field: ${field}.`,
    );
  for (const [field, rule] of Object.entries(type.fields)) {
    if (Object.hasOwn(artifact.data, field))
      requireValue(
        matchesType(artifact.data[field], rule.type),
        'VALIDATION_FAILED',
        `Invalid artifact field type: ${field}.`,
      );
  }
  const entries =
    artifact.type === 'requirements'
      ? artifact.data.requirements
      : artifact.type === 'scenarios'
        ? artifact.data.scenarios
        : undefined;
  if (Array.isArray(entries)) {
    const ids = new Set();
    for (const item of entries) {
      requireValue(
        item && typeof item === 'object' && typeof item.id === 'string' && !ids.has(item.id),
        'VALIDATION_FAILED',
        'Artifact entries need unique stable IDs.',
      );
      identifier(item.id);
      ids.add(item.id);
      if (artifact.type === 'requirements')
        requireValue(
          typeof item.description === 'string' && item.description.trim(),
          'VALIDATION_FAILED',
          'Each requirement needs a meaningful description.',
        );
      if (artifact.type === 'scenarios')
        requireValue(
          Array.isArray(item.requirement_ids) &&
            item.requirement_ids.length > 0 &&
            ['given', 'when', 'then'].every(
              (key) => typeof item[key] === 'string' && item[key].trim(),
            ),
          'VALIDATION_FAILED',
          'Each scenario needs requirement references and observable Given/When/Then fields.',
        );
    }
    requireValue(
      entries.length > 0,
      'VALIDATION_FAILED',
      'A business artifact must contain at least one entry.',
    );
  }
  if (artifact.type === 'defect-report') {
    const deploymentId = artifact.data.already_fixed_deployment_id;
    const testId = artifact.data.already_fixed_test_id;
    requireValue(
      (deploymentId === undefined && testId === undefined) ||
        (typeof deploymentId === 'string' &&
          deploymentId.trim() &&
          typeof testId === 'string' &&
          testId.trim()),
      'VALIDATION_FAILED',
      'An already-fixed defect needs both an exact verified deployment ID and a passing test identity.',
    );
    if (deploymentId !== undefined) identifier(deploymentId);
  }
  return { valid: true, type: artifact.type, id: artifact.id };
}

export function validatePlan(plan, scenarioIds = [], configuredApplicationIds = undefined) {
  requireValue(
    plan &&
      Array.isArray(plan.increments) &&
      plan.increments.length > 0 &&
      Array.isArray(plan.tasks) &&
      plan.tasks.length > 0 &&
      Array.isArray(scenarioIds) &&
      scenarioIds.length > 0,
    'VALIDATION_FAILED',
    'A plan needs functional increments, tasks, and accepted scenario IDs.',
  );
  requireValue(
    plan.outcome === undefined || ['IMPLEMENTATION', 'NO_FILE'].includes(plan.outcome),
    'VALIDATION_FAILED',
    'Plan outcome must be IMPLEMENTATION or NO_FILE.',
  );
  if (plan.outcome === 'NO_FILE')
    requireValue(
      typeof plan.no_file_rationale === 'string' &&
        plan.no_file_rationale.trim() &&
        plan.tasks.every((task) => Array.isArray(task.paths) && task.paths.length === 0),
      'VALIDATION_FAILED',
      'A NO_FILE plan needs a rationale and every task must explicitly own an empty path list.',
    );
  for (const id of scenarioIds) identifier(id);
  requireValue(
    new Set(scenarioIds).size === scenarioIds.length,
    'VALIDATION_FAILED',
    'Accepted scenario IDs must be unique.',
  );
  const acceptedScenarioIds = new Set(scenarioIds);
  const configuredApps =
    configuredApplicationIds === undefined ? undefined : new Set(configuredApplicationIds);
  const increments = new Map();
  for (const increment of plan.increments) {
    identifier(increment.id);
    requireValue(
      !increments.has(increment.id) &&
        typeof increment.goal === 'string' &&
        increment.goal.trim() &&
        Array.isArray(increment.scenario_ids) &&
        increment.scenario_ids.length > 0 &&
        new Set(increment.scenario_ids).size === increment.scenario_ids.length &&
        increment.scenario_ids.every((id) => acceptedScenarioIds.has(id)),
      'VALIDATION_FAILED',
      'Each increment needs a unique ID, observable goal, and unique references to accepted scenarios.',
    );
    if (configuredApps !== undefined) {
      requireValue(
        configuredApps.size <= 1 ||
          (Array.isArray(increment.application_ids) && increment.application_ids.length > 0),
        'VALIDATION_FAILED',
        `Increment ${increment.id} must declare its affected applications in a multi-application project.`,
      );
      if (increment.application_ids !== undefined)
        requireValue(
          Array.isArray(increment.application_ids) &&
            new Set(increment.application_ids).size === increment.application_ids.length &&
            increment.application_ids.every(
              (id) => typeof id === 'string' && configuredApps.has(id),
            ),
          'VALIDATION_FAILED',
          `Increment ${increment.id} contains duplicate or unconfigured application IDs.`,
        );
    }
    increments.set(increment.id, increment);
  }
  const tasks = new Map();
  for (const task of plan.tasks) {
    identifier(task.id);
    requireValue(
      !tasks.has(task.id) &&
        increments.has(task.increment_id) &&
        typeof task.role === 'string' &&
        task.role.trim() &&
        ['depends_on', 'scenario_ids', 'outputs', 'verification_profiles'].every((key) =>
          Array.isArray(task[key]),
        ) &&
        task.scenario_ids.length > 0 &&
        new Set(task.scenario_ids).size === task.scenario_ids.length &&
        task.scenario_ids.every(
          (id) =>
            acceptedScenarioIds.has(id) &&
            increments.get(task.increment_id).scenario_ids.includes(id),
        ) &&
        task.outputs.length > 0 &&
        task.verification_profiles.length > 0,
      'VALIDATION_FAILED',
      'Tasks need unique IDs, a valid increment, accepted scenario coverage, role, dependencies, outputs, and verification profiles.',
    );
    tasks.set(task.id, task);
  }
  const canonicalRole = (role) => role.replace(/^sdlc_/, '');
  for (const increment of increments.values()) {
    const incrementTasks = [...tasks.values()].filter((task) => task.increment_id === increment.id);
    const testAuthors = incrementTasks.filter((task) => canonicalRole(task.role) === 'test_author');
    const implementers = incrementTasks.filter(
      (task) => canonicalRole(task.role) === 'implementer',
    );
    requireValue(
      testAuthors.length > 0 && implementers.length > 0,
      'VALIDATION_FAILED',
      `Increment ${increment.id} needs at least one test-author task and one implementer task.`,
    );
    for (const implementer of implementers)
      requireValue(
        implementer.depends_on.some((id) => {
          const dependency = tasks.get(id);
          return (
            dependency?.increment_id === increment.id &&
            canonicalRole(dependency.role) === 'test_author'
          );
        }),
        'VALIDATION_FAILED',
        `Implementer task ${implementer.id} must directly depend on a test-author task in increment ${increment.id}.`,
      );
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    requireValue(tasks.has(id), 'VALIDATION_FAILED', 'A dependency references an unknown task.');
    requireValue(!visiting.has(id), 'VALIDATION_FAILED', 'Task dependencies contain a cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tasks.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
  const covered = new Set(plan.tasks.flatMap((task) => task.scenario_ids));
  for (const scenarioId of scenarioIds)
    requireValue(
      covered.has(scenarioId) &&
        [...increments.values()].some((increment) => increment.scenario_ids.includes(scenarioId)),
      'VALIDATION_FAILED',
      `Scenario has no implementing/verifying increment: ${scenarioId}.`,
    );
  return { valid: true, tasks: plan.tasks.length, increments: plan.increments.length };
}
