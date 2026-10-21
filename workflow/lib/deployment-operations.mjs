import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  atomicWrite,
  hash,
  identifier,
  posix,
  redact,
  requireValue,
  safePath,
  WorkflowError,
} from './support.mjs';
import { load, save } from './state.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40,64}$/;
const SERVICE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function parseComposeJson(source) {
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {}
  const records = source
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return records;
}

function deliveryConfig(profile) {
  const config = profile.delivery?.compose;
  requireValue(
    config && typeof config === 'object',
    'DEPLOYMENT_NOT_CONFIGURED',
    'Configure delivery.compose during project initialization before deploying locally.',
  );
  requireValue(
    typeof config.file === 'string' &&
      config.file.length > 0 &&
      typeof config.project_name === 'string' &&
      PROJECT.test(config.project_name) &&
      Number.isInteger(config.readiness_timeout_ms) &&
      config.readiness_timeout_ms >= 1_000 &&
      config.readiness_timeout_ms <= 600_000 &&
      Array.isArray(config.verification_profiles) &&
      config.verification_profiles.length > 0 &&
      config.verification_profiles.every((item) => typeof item === 'string' && item.length > 0),
    'DEPLOYMENT_NOT_CONFIGURED',
    'Compose delivery needs a project-relative file, a stable project_name, a bounded readiness_timeout_ms, and verification_profiles.',
  );
  return config;
}

function releaseImages(manifest) {
  requireValue(
    manifest &&
      manifest.schema_version === '1' &&
      typeof manifest.version === 'string' &&
      /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
        manifest.version,
      ) &&
      Array.isArray(manifest.images) &&
      manifest.images.length > 0,
    'INVALID_RELEASE_MANIFEST',
    'A versioned release manifest with images is required.',
  );
  requireValue(
    manifest.tag === `v${manifest.version}` &&
      SHA.test(manifest.source_sha ?? '') &&
      (manifest.prerelease === undefined || manifest.prerelease === manifest.version.includes('-')),
    'INVALID_RELEASE_MANIFEST',
    'The release tag, source commit, or prerelease flag does not match the manifest version.',
  );
  const ids = new Set();
  const services = new Set();
  return manifest.images.map((item) => {
    requireValue(
      item &&
        typeof item.image_id === 'string' &&
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(item.image_id) &&
        !ids.has(item.image_id) &&
        typeof item.service === 'string' &&
        SERVICE.test(item.service) &&
        !services.has(item.service) &&
        typeof item.image === 'string' &&
        /^[a-z0-9][a-z0-9._/-]*$/.test(item.image) &&
        DIGEST.test(item.digest) &&
        item.reference === `${item.image}@${item.digest}`,
      'INVALID_RELEASE_MANIFEST',
      'Each release image needs unique identifiers and an exact image@sha256 digest reference.',
    );
    ids.add(item.image_id);
    services.add(item.service);
    return {
      image_id: item.image_id,
      service: item.service,
      image: item.image,
      digest: item.digest,
    };
  });
}

function releaseMigrations(manifest, images) {
  const migrations = manifest.migrations ?? [];
  requireValue(
    Array.isArray(migrations),
    'INVALID_RELEASE_MANIFEST',
    'Release migrations must be an ordered array.',
  );
  const ids = new Set();
  const services = new Set();
  const imageServices = new Set(images.map((item) => item.service));
  const normalized = migrations.map((migration) => {
    requireValue(
      migration &&
        typeof migration.id === 'string' &&
        /^[a-z0-9][a-z0-9-]{0,62}$/.test(migration.id) &&
        !ids.has(migration.id) &&
        typeof migration.service === 'string' &&
        SERVICE.test(migration.service) &&
        !services.has(migration.service) &&
        imageServices.has(migration.service) &&
        ['backward-compatible', 'forward-only'].includes(migration.compatibility) &&
        ['roll-forward', 'restore-backup', 'manual'].includes(migration.recovery_strategy) &&
        typeof migration.recovery_instructions === 'string' &&
        migration.recovery_instructions.trim().length > 0,
      'INVALID_RELEASE_MANIFEST',
      'Every migration needs a unique ID, a digest-pinned service, compatibility policy, and explicit recovery instructions.',
    );
    ids.add(migration.id);
    services.add(migration.service);
    return {
      id: migration.id,
      service: migration.service,
      compatibility: migration.compatibility,
      recovery_strategy: migration.recovery_strategy,
      recovery_instructions: migration.recovery_instructions.trim(),
      status: 'PENDING',
    };
  });
  requireValue(
    images.some((item) => !services.has(item.service)),
    'INVALID_RELEASE_MANIFEST',
    'A release must contain at least one application image outside its migration services.',
  );
  return normalized;
}

function docker(context, projectRoot, args, timeout = 30_000) {
  const options = {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...(context.env ?? {}) },
  };
  const result = context.dockerRunner
    ? context.dockerRunner('docker', args, options)
    : spawnSync('docker', args, options);
  if (result.error || result.status !== 0) {
    const safeOutput = redact(
      { output: `${result.stderr ?? ''}`.slice(-4_000) },
      context.env ?? process.env,
    ).output;
    throw new WorkflowError(
      result.error?.code === 'ETIMEDOUT' ? 'DOCKER_TIMEOUT' : 'DOCKER_FAILED',
      `Docker command failed${result.status === null ? '' : ` with exit code ${result.status}`}.${safeOutput ? ` ${safeOutput}` : ''}`,
    );
  }
  return result.stdout ?? '';
}

function composeArgs(config, composeFile, overrideFile, args) {
  return [
    'compose',
    '--project-name',
    config.project_name,
    '--file',
    composeFile,
    '--file',
    overrideFile,
    ...args,
  ];
}

async function prepareDeployment(input, context) {
  const { profile, state } = await load(context.projectRoot);
  const config = deliveryConfig(profile);
  const deploymentId = identifier(input.deployment_id);
  const manifestPath = await safePath(context.projectRoot, input.manifest_path, {
    protectedAccess: true,
  });
  const composePath = await safePath(context.projectRoot, config.file, { protectedAccess: true });
  const [manifestBytes, composeBytes] = await Promise.all([
    fs.readFile(manifestPath),
    fs.readFile(composePath),
  ]);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const images = releaseImages(manifest);
  const migrations = releaseMigrations(manifest, images);
  const overridePath = await safePath(
    context.projectRoot,
    `.workflow-runtime/deployments/${deploymentId}.compose.json`,
    { protectedAccess: true },
  );
  const deployments = (state.receipts.deployments ??= {});
  const previous = deployments[deploymentId];
  const manifestHash = hash(manifestBytes);
  const composeFileHash = hash(composeBytes);
  const composeConfigHash = hash(config);
  requireValue(
    !previous ||
      (previous.manifest_hash === manifestHash &&
        previous.compose_file === config.file &&
        previous.compose_file_hash === composeFileHash &&
        previous.compose_config_hash === composeConfigHash),
    'DEPLOYMENT_CONFLICT',
    'This deployment ID already refers to another release or Compose configuration.',
  );
  const composeFile = posix(path.relative(context.projectRoot, composePath));
  const overrideFile = posix(path.relative(context.projectRoot, overridePath));
  return {
    profile,
    state,
    config,
    deploymentId,
    manifestPath,
    manifest,
    images,
    migrations,
    overridePath,
    composeFile,
    overrideFile,
    deployments,
    previous,
    manifestHash,
    composeFileHash,
    composeConfigHash,
  };
}

function assertComposeImages(source, expectedImages) {
  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new WorkflowError(
      'COMPOSE_CONFIG_INVALID',
      'Docker Compose did not return valid JSON configuration.',
    );
  }
  const services = config.services ?? {};
  const required = new Map(expectedImages.map((item) => [item.service, item]));
  for (const [service, definition] of Object.entries(services)) {
    if (!definition.image) continue;
    const expected = required.get(service);
    requireValue(
      expected && definition.image === `${expected.image}@${expected.digest}`,
      'COMPOSE_IMAGE_UNPINNED',
      `Compose service ${service} is not pinned to an image digest in the release manifest.`,
    );
    required.delete(service);
  }
  requireValue(
    required.size === 0,
    'COMPOSE_SERVICE_MISSING',
    'The Compose model is missing one or more release-manifest services.',
  );
  return expectedImages.map((item) => item.service);
}

function assertReady(source, services) {
  const records = parseComposeJson(source);
  const byService = new Map(records.map((record) => [record.Service ?? record.service, record]));
  const pending = services.filter((service) => {
    const record = byService.get(service);
    return (
      !record ||
      String(record.State ?? record.state).toLowerCase() !== 'running' ||
      String(record.Health ?? record.health).toLowerCase() !== 'healthy'
    );
  });
  return { ready: pending.length === 0, pending };
}

async function waitForReadiness(config, composeFile, overrideFile, services, context, root) {
  const now = context.now ?? Date.now;
  const deadline = now() + config.readiness_timeout_ms;
  let lastPending = services;
  while (now() < deadline) {
    const source = docker(
      context,
      root,
      composeArgs(config, composeFile, overrideFile, ['ps', '--format', 'json']),
    );
    const current = assertReady(source, services);
    if (current.ready) return;
    lastPending = current.pending;
    if (context.sleep) await context.sleep(1_000);
    else await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new WorkflowError(
    'DEPLOYMENT_NOT_READY',
    `Compose services did not become healthy before the deadline: ${lastPending.join(', ')}.`,
  );
}

export function registerDeploymentOperations(handlers) {
  handlers['deploy.local'] = async (input, context) => {
    const deployment = await prepareDeployment(input, context);
    const {
      state,
      config,
      deploymentId,
      manifest,
      images,
      migrations,
      overridePath,
      composeFile,
      overrideFile,
      deployments,
      previous,
      manifestHash,
      composeFileHash,
      composeConfigHash,
    } = deployment;
    if (previous?.status === 'READY' || previous?.status === 'VERIFIED')
      return { deployment: previous, already_ready: true };
    requireValue(
      previous?.status !== 'MIGRATION_FAILED',
      'RECOVERY_REQUIRED',
      'A migration failed for this deployment ID. Follow the manifest recovery instructions, then use a new deployment ID after the data is reconciled.',
    );
    requireValue(
      !previous?.migrations?.some((item) => item.status === 'RUNNING'),
      'RECOVERY_REQUIRED',
      'A prior migration attempt has an unknown outcome. Inspect the database and apply its declared recovery instructions before starting a new deployment ID.',
    );
    const composeOverride =
      JSON.stringify(
        {
          services: Object.fromEntries(
            images.map((item) => [item.service, { image: `${item.image}@${item.digest}` }]),
          ),
        },
        null,
        2,
      ) + '\n';
    const completedMigrationIds = new Set(
      (previous?.migrations ?? [])
        .filter((item) => item.status === 'PASSED')
        .map((item) => item.id),
    );
    const deploymentMigrations = migrations.map((item) => ({
      ...item,
      status: completedMigrationIds.has(item.id) ? 'PASSED' : 'PENDING',
      ...(completedMigrationIds.has(item.id)
        ? { completed_at: previous.migrations.find((prior) => prior.id === item.id).completed_at }
        : {}),
    }));
    await atomicWrite(overridePath, composeOverride);
    deployments[deploymentId] = {
      id: deploymentId,
      status: 'PREPARED',
      release_version: manifest.version,
      source_sha: manifest.source_sha,
      manifest_path: input.manifest_path,
      manifest_hash: manifestHash,
      compose_file: config.file,
      compose_file_hash: composeFileHash,
      compose_config_hash: composeConfigHash,
      project_name: config.project_name,
      image_references: images.map((item) => `${item.image}@${item.digest}`),
      migrations: deploymentMigrations,
      prepared_at: new Date().toISOString(),
    };
    await save(context.projectRoot, state, 'deploy.local.prepare', {
      deployment_id: deploymentId,
      manifest_hash: manifestHash,
    });
    try {
      const command = composeArgs(config, composeFile, overrideFile, [
        'config',
        '--format',
        'json',
      ]);
      const model = docker(context, context.projectRoot, command);
      const declaredServices = assertComposeImages(model, images);
      const migrationServices = new Set(migrations.map((item) => item.service));
      const services = declaredServices.filter((service) => !migrationServices.has(service));
      for (let index = 0; index < migrations.length; index += 1) {
        if (deployments[deploymentId].migrations[index].status === 'PASSED') continue;
        const migration = { ...deployments[deploymentId].migrations[index], status: 'RUNNING' };
        deployments[deploymentId].migrations[index] = migration;
        deployments[deploymentId].status = 'MIGRATING';
        await save(context.projectRoot, state, 'deploy.migration.start', {
          deployment_id: deploymentId,
          migration_id: migration.id,
        });
        try {
          docker(
            context,
            context.projectRoot,
            composeArgs(config, composeFile, overrideFile, [
              'run',
              '--rm',
              '--pull',
              'always',
              migration.service,
            ]),
            600_000,
          );
          deployments[deploymentId].migrations[index] = {
            ...migration,
            status: 'PASSED',
            completed_at: new Date().toISOString(),
          };
          await save(context.projectRoot, state, 'deploy.migration.passed', {
            deployment_id: deploymentId,
            migration_id: migration.id,
          });
        } catch (error) {
          deployments[deploymentId].migrations[index] = {
            ...migration,
            status: 'FAILED',
            failure: { code: error.code ?? 'MIGRATION_FAILED', message: error.message },
            failed_at: new Date().toISOString(),
          };
          throw new WorkflowError(
            'MIGRATION_FAILED',
            `Migration ${migration.id} failed. ${migration.recovery_instructions}`,
            { migration_id: migration.id },
          );
        }
      }
      if (migrations.length > 0) {
        deployments[deploymentId].status = 'MIGRATED';
        await save(context.projectRoot, state, 'deploy.migrations.complete', {
          deployment_id: deploymentId,
          migration_ids: migrations.map((item) => item.id),
        });
      }
      docker(
        context,
        context.projectRoot,
        composeArgs(config, composeFile, overrideFile, [
          'up',
          '--detach',
          '--pull',
          'always',
          '--no-build',
          ...services,
        ]),
        600_000,
      );
      await waitForReadiness(
        config,
        composeFile,
        overrideFile,
        services,
        context,
        context.projectRoot,
      );
      deployments[deploymentId] = {
        ...deployments[deploymentId],
        status: 'READY',
        ready_at: new Date().toISOString(),
        services,
      };
      await save(context.projectRoot, state, 'deploy.local.ready', {
        deployment_id: deploymentId,
        services,
      });
      return {
        deployment: deployments[deploymentId],
        message:
          'Compose services report healthy. Verification profiles still need to pass before this deployment is VERIFIED.',
      };
    } catch (error) {
      const latest = await load(context.projectRoot);
      latest.state.receipts.deployments[deploymentId] = {
        ...latest.state.receipts.deployments[deploymentId],
        status: error.code === 'MIGRATION_FAILED' ? 'MIGRATION_FAILED' : 'FAILED',
        migrations: deployments[deploymentId].migrations,
        failure: { code: error.code ?? 'DEPLOYMENT_FAILED', message: error.message },
        failed_migration_id: error.details?.migration_id,
        failed_at: new Date().toISOString(),
      };
      await save(context.projectRoot, latest.state, 'deploy.local.failed', {
        deployment_id: deploymentId,
        error_code: error.code ?? 'DEPLOYMENT_FAILED',
      });
      throw error;
    }
  };

  handlers['deploy.verify'] = async (input, context) => {
    const deploymentId = identifier(input.deployment_id);
    const current = await load(context.projectRoot);
    const record = current.state.receipts.deployments?.[deploymentId];
    requireValue(
      record && ['READY', 'VERIFY_FAILED', 'VERIFIED'].includes(record.status),
      'DEPLOYMENT_NOT_READY',
      'Deploy the exact release locally and wait for healthy Compose services before verification.',
    );
    const { profile } = current;
    const config = deliveryConfig(profile);
    requireValue(
      config.verification_profiles.every((profileName) => profile.commands[profileName]),
      'DEPLOYMENT_NOT_CONFIGURED',
      'Every deployment verification profile must name a registered project command.',
    );
    const manifestPath = await safePath(context.projectRoot, record.manifest_path, {
      protectedAccess: true,
    });
    const actualHash = hash(await fs.readFile(manifestPath));
    requireValue(
      actualHash === record.manifest_hash,
      'DEPLOYMENT_STALE',
      'The release manifest changed after deployment.',
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const images = releaseImages(manifest);
    const services = record.services ?? [];
    const composePath = await safePath(context.projectRoot, config.file, { protectedAccess: true });
    requireValue(
      hash(await fs.readFile(composePath)) === record.compose_file_hash &&
        hash(config) === record.compose_config_hash,
      'DEPLOYMENT_STALE',
      'The Compose file or deployment profile changed after deployment.',
    );
    const overridePath = await safePath(
      context.projectRoot,
      `.workflow-runtime/deployments/${deploymentId}.compose.json`,
      { protectedAccess: true },
    );
    const overrideFileBytes = await fs.readFile(overridePath, 'utf8');
    const expectedOverride =
      JSON.stringify(
        {
          services: Object.fromEntries(
            images.map((item) => [item.service, { image: `${item.image}@${item.digest}` }]),
          ),
        },
        null,
        2,
      ) + '\n';
    requireValue(
      overrideFileBytes === expectedOverride,
      'DEPLOYMENT_STALE',
      'The generated digest-pinned Compose override changed after deployment.',
    );
    const composeFile = posix(path.relative(context.projectRoot, composePath));
    const overrideFile = posix(path.relative(context.projectRoot, overridePath));
    assertComposeImages(
      docker(
        context,
        context.projectRoot,
        composeArgs(config, composeFile, overrideFile, ['config', '--format', 'json']),
      ),
      images,
    );
    await waitForReadiness(
      config,
      composeFile,
      overrideFile,
      services,
      context,
      context.projectRoot,
    );
    const runs = [];
    for (const profileName of config.verification_profiles) {
      const result = await handlers['tests.run']({ profile: profileName }, context);
      const actualTestsExecuted =
        result.run.test_adapter === 'node-test-tap' && result.run.executed_test_count > 0;
      runs.push({
        profile: profileName,
        run_id: result.run.id,
        classification:
          result.run.classification === 'PASS' && !actualTestsExecuted
            ? 'UNVERIFIED_TEST_RUN'
            : result.run.classification,
        test_adapter: result.run.test_adapter,
        executed_test_count: result.run.executed_test_count,
      });
      if (runs.at(-1).classification !== 'PASS') break;
    }
    const latest = await load(context.projectRoot);
    const latestRecord = latest.state.receipts.deployments[deploymentId];
    const passed =
      runs.length === config.verification_profiles.length &&
      runs.every((run) => run.classification === 'PASS');
    latest.state.receipts.deployments[deploymentId] = {
      ...latestRecord,
      status: passed ? 'VERIFIED' : 'VERIFY_FAILED',
      verification_runs: runs,
      verified_at: passed ? new Date().toISOString() : null,
    };
    await save(context.projectRoot, latest.state, 'deploy.verify', {
      deployment_id: deploymentId,
      passed,
      run_ids: runs.map((run) => run.run_id),
    });
    return {
      deployment: latest.state.receipts.deployments[deploymentId],
      passed,
      not_run_profiles: config.verification_profiles.slice(runs.length),
    };
  };

  handlers['deploy.recover'] = async (input, context) => {
    const deploymentId = identifier(input.deployment_id);
    const { state } = await load(context.projectRoot);
    const record = state.receipts.deployments?.[deploymentId];
    requireValue(
      record,
      'DEPLOYMENT_NOT_FOUND',
      'The requested deployment has no recorded attempt.',
    );
    return {
      deployment: record,
      recovery_action: record.migrations?.some((item) => item.status === 'RUNNING')
        ? 'A migration was recorded as running when the workflow stopped, so its outcome is unknown. Inspect the database and follow that migration’s declared recovery instructions before deploying with a new ID.'
        : record.status === 'FAILED' && record.migrations?.some((item) => item.status === 'PASSED')
          ? 'A declared migration already passed. Inspect the application failure and retry deploy.local with this deployment ID; completed migrations are recorded and will not be rerun. No image rollback or data deletion occurs.'
          : record.status === 'PREPARED' || record.status === 'FAILED'
            ? 'Inspect Docker Compose health and the recorded failure, then retry deploy.local with the same ID only after correcting the cause. No containers or data were removed.'
            : record.status === 'READY'
              ? 'Run deploy.verify to execute the configured system verification profiles.'
              : record.status === 'MIGRATION_FAILED'
                ? `Do not retry this deployment ID or roll back images automatically. Apply the declared ${record.migrations?.find((item) => item.status === 'FAILED')?.recovery_strategy ?? 'manual'} recovery: ${record.migrations?.find((item) => item.status === 'FAILED')?.recovery_instructions ?? 'inspect the release manifest and reconcile persistent data with an operator.'}`
                : record.status === 'VERIFY_FAILED'
                  ? 'Correct the failed checks and retry deploy.verify. The running environment and persistent data were preserved.'
                  : 'The deployment is verified. No recovery action is required.',
    };
  };
}
