import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, hash, safePath, WorkflowError, requireValue } from './support.mjs';

export async function stateFile(root, name) {
  return safePath(root, `.workflow/${name}`, { protectedAccess: true });
}

export async function readJson(file, code = 'STATE_CORRUPT') {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    throw new WorkflowError(
      error.code === 'ENOENT' ? 'NOT_INITIALIZED' : code,
      error.code === 'ENOENT'
        ? 'Initialize this project before using workflow operations.'
        : 'The durable record is invalid. It has not been overwritten.',
    );
  }
}

export async function load(root) {
  const profile = await readJson(await stateFile(root, 'project.json'));
  const state = await readJson(await stateFile(root, 'state.json'));
  requireValue(
    state.schema_version === '1' &&
      Number.isInteger(state.revision) &&
      state.changes &&
      state.runs &&
      Array.isArray(state.events) &&
      state.receipts,
    'STATE_CORRUPT',
    'The durable state does not match its versioned contract.',
  );
  return { profile, state };
}

export async function save(root, state, operation, details = {}) {
  state.revision += 1;
  state.events.push({
    id: randomUUID(),
    revision: state.revision,
    operation,
    at: new Date().toISOString(),
    ...details,
  });
  await atomicWrite(await stateFile(root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  // This rebuildable projection is not a second source of truth.
  await atomicWrite(
    await stateFile(root, 'events.jsonl'),
    state.events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
}

export async function withLock(root, action) {
  const lockPath = await stateFile(root, 'operation.lock');
  const recoveryPath = await stateFile(root, 'operation.recovery.lock');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await requireNoRecoveryIntent(root);
  try {
    await fs.access(recoveryPath);
    throw new WorkflowError(
      'RESOURCE_LOCKED',
      'A lock recovery is in progress. Retry after its durable receipt has been recorded.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new WorkflowError(
        'RESOURCE_LOCKED',
        'Another operation or interrupted lock owns this project. Inspect and reconcile it before retrying.',
      );
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
        token: randomUUID(),
      }),
    );
    try {
      await requireNoRecoveryIntent(root);
      await fs.access(recoveryPath);
      await handle.close();
      handle = null;
      await fs.rm(lockPath, { force: true });
      throw new WorkflowError(
        'RESOURCE_LOCKED',
        'A lock recovery started concurrently. The operation was not run; retry after recovery finishes.',
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return await action();
  } finally {
    if (handle) {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    }
  }
}

function processStatus(pid) {
  try {
    process.kill(pid, 0);
    return 'ACTIVE';
  } catch (error) {
    if (error.code === 'ESRCH') return 'INACTIVE';
    return 'UNKNOWN';
  }
}

async function readLock(root, name) {
  const file = await stateFile(root, name);
  let contents;
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'ABSENT', file };
    throw error;
  }
  let record;
  try {
    record = JSON.parse(contents);
  } catch {
    return { status: 'INVALID', file, lock_id: hash(contents) };
  }
  if (
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.created_at !== 'string' ||
    !Number.isFinite(Date.parse(record.created_at))
  )
    return { status: 'INVALID', file, lock_id: hash(contents) };
  const owner_status = processStatus(record.pid);
  return {
    status: owner_status === 'INACTIVE' ? 'STALE' : owner_status,
    file,
    lock_id: hash(contents),
    owner_pid: record.pid,
    created_at: record.created_at,
  };
}

async function readRecoveryGuardLock(root) {
  // Windows may briefly deny a read while another recovery request removes the
  // same stale guard. Retry that narrow filesystem race; persistent permission
  // failures still surface to the caller and keep recovery blocked.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readLock(root, 'operation.recovery.lock');
    } catch (error) {
      if (error.code !== 'EPERM' || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

async function readRecoveryGuardContents(file) {
  // The guard can be removed between inspection and content verification by a
  // concurrent recovery. Windows may report EPERM while the handle is closing.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'EPERM' || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

export async function inspectOperationLock(root) {
  const [operation, recovery, reconciliation] = await Promise.all([
    readLock(root, 'operation.lock'),
    readLock(root, 'operation.recovery.lock'),
    readRecoveryIntents(root),
  ]);
  const pendingIntent = reconciliation.find((intent) => intent.status === 'PENDING');
  const invalidIntent = reconciliation.find((intent) => intent.status === 'INVALID');
  const reconciliationPending = Boolean(pendingIntent || invalidIntent);
  return {
    operation_lock: Object.fromEntries(Object.entries(operation).filter(([key]) => key !== 'file')),
    recovery_lock: Object.fromEntries(Object.entries(recovery).filter(([key]) => key !== 'file')),
    reconciliation_pending: reconciliationPending,
    reconciliation_lock_id: pendingIntent?.record.recovery_lock_id ?? null,
    recovery_guard_recovery_allowed:
      !invalidIntent &&
      !['INVALID', 'UNKNOWN', 'ACTIVE'].includes(operation.status) &&
      (recovery.status === 'STALE' || Boolean(pendingIntent?.record.recovery_lock_id)),
    recovery_allowed:
      !reconciliationPending && operation.status === 'STALE' && recovery.status === 'ABSENT',
  };
}

export async function recoverOperationLock(root, expectedLockId) {
  const recoveryPath = await stateFile(root, 'operation.recovery.lock');
  const operationPath = await stateFile(root, 'operation.lock');
  await requireNoRecoveryIntent(root);
  let recoveryHandle;
  try {
    recoveryHandle = await fs.open(recoveryPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST')
      throw new WorkflowError(
        'RECOVERY_IN_PROGRESS',
        'Another operation is reconciling the project lock. Inspect it before retrying.',
      );
    throw error;
  }
  let operationLockRemoved = false;
  try {
    await recoveryHandle.writeFile(
      JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
        token: randomUUID(),
      }),
    );
    const current = await readLock(root, 'operation.lock');
    if (current.status === 'ABSENT')
      return { recovered: false, already_clear: true, lock_id: expectedLockId };
    requireValue(
      current.lock_id === expectedLockId,
      'STALE_LOCK_ID',
      'The operation lock changed after inspection. Inspect the current lock before recovery.',
    );
    requireValue(
      current.status === 'STALE',
      current.status === 'INVALID' ? 'LOCK_INVALID' : 'LOCK_OWNER_ACTIVE',
      current.status === 'INVALID'
        ? 'The operation lock owner record is invalid and cannot be safely recovered automatically.'
        : 'The operation lock owner may still be active. No lock was removed.',
    );
    const contents = await fs.readFile(operationPath, 'utf8');
    requireValue(
      hash(contents) === expectedLockId,
      'STALE_LOCK_ID',
      'The operation lock changed during recovery. Inspect the current lock before retrying.',
    );
    await fs.rm(operationPath);
    operationLockRemoved = true;
    const receipt = {
      recovered: true,
      lock_id: expectedLockId,
      previous_owner_pid: current.owner_pid,
      previous_created_at: current.created_at,
      recovered_at: new Date().toISOString(),
    };
    await writeLockRecoveryReceipt(root, receipt);
    return receipt;
  } finally {
    await recoveryHandle.close();
    const receiptPath = await stateFile(root, `lock-recoveries/${expectedLockId}.json`);
    const receiptExists = await fileExists(receiptPath);
    if (!operationLockRemoved || receiptExists) await fs.rm(recoveryPath, { force: true });
  }
}

export async function recoverRecoveryGuard(root, expectedRecoveryLockId) {
  const recoveryPath = await stateFile(root, 'operation.recovery.lock');
  const intentPath = await stateFile(root, `recovery-intents/${expectedRecoveryLockId}.json`);
  let intent = await readRecoveryIntent(root, expectedRecoveryLockId);

  if (intent.status === 'DONE')
    return {
      ...intent.record.receipt,
      lock_id: expectedRecoveryLockId,
      recovered_recovery_guard: true,
      already_recovered: true,
    };

  if (intent.status === 'ABSENT') {
    const current = await readRecoveryGuardLock(root);
    if (current.status === 'ABSENT')
      return {
        recovered_recovery_guard: false,
        already_clear: true,
        lock_id: expectedRecoveryLockId,
      };
    requireValue(
      current.lock_id === expectedRecoveryLockId,
      'STALE_LOCK_ID',
      'The recovery guard changed after inspection. Inspect the current lock before recovery.',
    );
    requireValue(
      current.status === 'STALE',
      current.status === 'INVALID' ? 'LOCK_INVALID' : 'LOCK_OWNER_ACTIVE',
      current.status === 'INVALID'
        ? 'The recovery guard record is invalid and cannot be safely recovered automatically.'
        : 'The recovery guard owner may still be active. No lock was removed.',
    );
    const operation = await readLock(root, 'operation.lock');
    requireValue(
      ['ABSENT', 'STALE'].includes(operation.status),
      operation.status === 'ACTIVE' ? 'LOCK_OWNER_ACTIVE' : 'LOCK_INVALID',
      'An active or unverifiable operation must be reconciled before the recovery guard.',
    );
    intent = {
      status: 'PENDING',
      record: {
        schema_version: '1',
        status: 'PENDING',
        recovery_lock_id: expectedRecoveryLockId,
        previous_owner_pid: current.owner_pid,
        previous_created_at: current.created_at,
        started_at: new Date().toISOString(),
      },
    };
    await createImmutableRecord(intentPath, intent.record);
    intent = await readRecoveryIntent(root, expectedRecoveryLockId);
    // A concurrent recovery may finish after our initial ABSENT read but before this read.
    if (intent.status === 'DONE')
      return {
        ...intent.record.receipt,
        lock_id: expectedRecoveryLockId,
        recovered_recovery_guard: true,
        already_recovered: true,
      };
  }

  requireValue(
    intent.status === 'PENDING' && intent.record.recovery_lock_id === expectedRecoveryLockId,
    intent.status === 'INVALID' ? 'RECOVERY_INTENT_INVALID' : 'STALE_LOCK_ID',
    intent.status === 'INVALID'
      ? 'The durable recovery intent is invalid and requires manual inspection.'
      : 'A different recovery intent is pending; inspect and resume that exact recovery first.',
  );

  const operation = await readLock(root, 'operation.lock');
  requireValue(
    ['ABSENT', 'STALE'].includes(operation.status),
    operation.status === 'ACTIVE' ? 'LOCK_OWNER_ACTIVE' : 'LOCK_INVALID',
    'An active or unverifiable operation must be reconciled before the recovery guard.',
  );
  let current = await readRecoveryGuardLock(root);
  if (current.status !== 'ABSENT') {
    requireValue(
      current.lock_id === expectedRecoveryLockId && current.status === 'STALE',
      current.status === 'INVALID' ? 'LOCK_INVALID' : 'LOCK_OWNER_ACTIVE',
      current.status === 'INVALID'
        ? 'The recovery guard record is invalid and cannot be safely recovered automatically.'
        : 'The recovery guard changed or its owner may still be active. No lock was removed.',
    );
    let contents;
    try {
      contents = await readRecoveryGuardContents(recoveryPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      current = await readRecoveryGuardLock(root);
      requireValue(
        current.status === 'ABSENT',
        'STALE_LOCK_ID',
        'The recovery guard changed during recovery. Inspect the current lock before retrying.',
      );
    }
    if (contents !== undefined) {
      requireValue(
        hash(contents) === expectedRecoveryLockId,
        'STALE_LOCK_ID',
        'The recovery guard changed during recovery. Inspect the current lock before retrying.',
      );
      await fs.rm(recoveryPath, { force: true });
    }
  }

  const receipt = {
    recovered: true,
    recovery_lock_id: expectedRecoveryLockId,
    previous_owner_pid: intent.record.previous_owner_pid,
    previous_created_at: intent.record.previous_created_at,
    started_at: intent.record.started_at,
    recovered_at: new Date().toISOString(),
    resumed: current.status === 'ABSENT',
  };
  const receiptPath = await stateFile(
    root,
    `recovery-guard-recoveries/${expectedRecoveryLockId}.json`,
  );
  await createImmutableRecord(receiptPath, receipt);
  const durableReceipt = await readJson(receiptPath, 'RECOVERY_INTENT_INVALID');
  requireValue(
    durableReceipt.recovered === true &&
      durableReceipt.recovery_lock_id === expectedRecoveryLockId &&
      Number.isInteger(durableReceipt.previous_owner_pid) &&
      durableReceipt.previous_owner_pid > 0 &&
      Number.isFinite(Date.parse(durableReceipt.previous_created_at)) &&
      Number.isFinite(Date.parse(durableReceipt.started_at)) &&
      Number.isFinite(Date.parse(durableReceipt.recovered_at)) &&
      typeof durableReceipt.resumed === 'boolean',
    'RECOVERY_INTENT_INVALID',
    'The recovery receipt is invalid or does not match the inspected recovery guard.',
  );
  const completedIntent = `${JSON.stringify(
    {
      ...intent.record,
      status: 'DONE',
      receipt: durableReceipt,
    },
    null,
    2,
  )}\n`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await atomicWrite(intentPath, completedIntent);
      break;
    } catch (error) {
      const completed = await readRecoveryIntent(root, expectedRecoveryLockId);
      if (
        completed.status === 'DONE' &&
        hash(JSON.stringify(completed.record.receipt)) === hash(JSON.stringify(durableReceipt))
      )
        break;
      if (error.code !== 'EPERM' || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  return {
    ...durableReceipt,
    lock_id: expectedRecoveryLockId,
    recovered_recovery_guard: true,
  };
}

async function createImmutableRecord(file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readRecoveryIntent(root, lockId) {
  const file = await stateFile(root, `recovery-intents/${lockId}.json`);
  try {
    const contents = await fs.readFile(file, 'utf8');
    try {
      const record = JSON.parse(contents);
      if (
        record.schema_version === '1' &&
        record.recovery_lock_id === lockId &&
        ['PENDING', 'DONE'].includes(record.status) &&
        (record.status !== 'DONE' || record.receipt?.recovery_lock_id === lockId)
      )
        return { status: record.status, record, file };
    } catch {}
    return { status: 'INVALID', lock_id: hash(contents), file };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'ABSENT' };
    throw error;
  }
}

async function readRecoveryIntents(root) {
  const directory = await stateFile(root, 'recovery-intents');
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const intents = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      intents.push({ status: 'INVALID', file: entry.name });
      continue;
    }
    const lockId = entry.name.slice(0, -'.json'.length);
    if (!/^[a-f0-9]{64}$/.test(lockId)) {
      intents.push({ status: 'INVALID', file: entry.name });
      continue;
    }
    intents.push(await readRecoveryIntent(root, lockId));
  }
  return intents;
}

async function requireNoRecoveryIntent(root) {
  const intents = await readRecoveryIntents(root);
  if (intents.some((intent) => intent.status !== 'DONE'))
    throw new WorkflowError(
      'RESOURCE_LOCKED',
      'A recovery reconciliation is pending. Inspect and resume that exact recovery before running operations.',
    );
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeLockRecoveryReceipt(root, receipt) {
  await atomicWrite(
    await stateFile(root, `lock-recoveries/${receipt.lock_id}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  try {
    const { state } = await load(root);
    await save(root, state, 'workflow.lock.recover', {
      lock_id: receipt.lock_id,
      recovered: receipt.recovered,
      already_clear: receipt.already_clear,
      recovered_at: receipt.recovered_at,
    });
  } catch (error) {
    if (error.code !== 'NOT_INITIALIZED') throw error;
  }
}

export function findChange(state, id) {
  const change = state.changes[id];
  requireValue(change, 'CHANGE_NOT_FOUND', 'The requested change does not exist.');
  return change;
}
