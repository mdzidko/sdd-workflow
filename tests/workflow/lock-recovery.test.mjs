import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hash } from '../../workflow/lib/support.mjs';
import { fails, initialize, repository, succeeds } from './helpers.mjs';

test('a stale operation lock is inspected and recovered with a durable receipt', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const owner = { pid: 2_147_483_647, created_at: '2026-01-01T00:00:00.000Z' };
  const lockBytes = `${JSON.stringify(owner)}\n`;
  await repo.write('.workflow/operation.lock', lockBytes);

  const inspection = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(inspection.operation_lock.status, 'STALE');
  assert.equal(inspection.operation_lock.owner_pid, owner.pid);
  assert.equal(inspection.operation_lock.lock_id, hash(lockBytes));
  assert.equal(inspection.recovery_allowed, true);
  fails(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Add a person',
    }),
    'change.start',
    'RESOURCE_LOCKED',
  );

  const recovered = succeeds(
    await repo.run('workflow.lock.recover', {
      expected_lock_id: inspection.operation_lock.lock_id,
    }),
    'workflow.lock.recover',
  );
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.previous_owner_pid, owner.pid);
  const receipt = JSON.parse(
    await readFile(
      path.join(
        repo.projectRoot,
        '.workflow/lock-recoveries',
        `${inspection.operation_lock.lock_id}.json`,
      ),
      'utf8',
    ),
  );
  assert.equal(receipt.lock_id, inspection.operation_lock.lock_id);
  const after = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(after.operation_lock.status, 'ABSENT');
  assert.equal(after.recovery_lock.status, 'ABSENT');
  succeeds(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Add a person',
    }),
    'change.start',
  );
});

test('a stale recovery guard resumes through a durable reconciliation receipt', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const owner = { pid: 2_147_483_647, created_at: '2026-01-01T00:00:00.000Z' };
  const lockBytes = `${JSON.stringify(owner)}\n`;
  await repo.write('.workflow/operation.recovery.lock', lockBytes);

  const inspection = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(inspection.recovery_lock.status, 'STALE');
  assert.equal(inspection.recovery_lock.lock_id, hash(lockBytes));
  assert.equal(inspection.recovery_guard_recovery_allowed, true);
  fails(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Add a person',
    }),
    'change.start',
    'RESOURCE_LOCKED',
  );

  const recovered = succeeds(
    await repo.run('workflow.lock.recover', {
      expected_recovery_lock_id: inspection.recovery_lock.lock_id,
    }),
    'workflow.lock.recover',
  );
  assert.equal(recovered.recovered_recovery_guard, true);
  assert.equal(recovered.lock_id, inspection.recovery_lock.lock_id);
  const receipt = JSON.parse(
    await readFile(
      path.join(
        repo.projectRoot,
        '.workflow/recovery-guard-recoveries',
        `${inspection.recovery_lock.lock_id}.json`,
      ),
      'utf8',
    ),
  );
  assert.equal(receipt.recovery_lock_id, inspection.recovery_lock.lock_id);
  const after = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(after.recovery_lock.status, 'ABSENT');
  assert.equal(after.reconciliation_pending, false);
  succeeds(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Add a person',
    }),
    'change.start',
  );
});

test('a pending recovery intent resumes after the recovery guard was already removed', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const recoveryBytes = `${JSON.stringify({
    pid: 2_147_483_647,
    created_at: '2026-01-01T00:00:00.000Z',
  })}\n`;
  const recoveryLockId = hash(recoveryBytes);
  await repo.write(
    `.workflow/recovery-intents/${recoveryLockId}.json`,
    `${JSON.stringify({
      schema_version: '1',
      status: 'PENDING',
      recovery_lock_id: recoveryLockId,
      previous_owner_pid: 2_147_483_647,
      previous_created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-02T00:00:00.000Z',
    })}\n`,
  );

  const inspection = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(inspection.reconciliation_pending, true);
  assert.equal(inspection.recovery_guard_recovery_allowed, true);
  assert.equal(inspection.reconciliation_lock_id, recoveryLockId);
  fails(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Add a person',
    }),
    'change.start',
    'RESOURCE_LOCKED',
  );

  const recovered = succeeds(
    await repo.run('workflow.lock.recover', {
      expected_recovery_lock_id: recoveryLockId,
    }),
    'workflow.lock.recover',
  );
  assert.equal(recovered.resumed, true);
  const after = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(after.reconciliation_pending, false);
  assert.equal(after.recovery_lock.status, 'ABSENT');
  const completedIntent = JSON.parse(
    await readFile(
      path.join(repo.projectRoot, '.workflow/recovery-intents', `${recoveryLockId}.json`),
      'utf8',
    ),
  );
  assert.equal(completedIntent.status, 'DONE');
  const retry = succeeds(
    await repo.run('workflow.lock.recover', {
      expected_recovery_lock_id: recoveryLockId,
    }),
    'workflow.lock.recover',
  );
  assert.equal(retry.already_recovered, true);
  succeeds(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Add a person',
    }),
    'change.start',
  );
});

test('concurrent recovery requests reconcile the same stale guard idempotently', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const lockBytes = `${JSON.stringify({
    pid: 2_147_483_647,
    created_at: '2026-01-01T00:00:00.000Z',
  })}\n`;
  await repo.write('.workflow/operation.recovery.lock', lockBytes);
  const inspection = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  const request = {
    expected_recovery_lock_id: inspection.recovery_lock.lock_id,
  };

  const results = await Promise.all(
    Array.from({ length: 8 }, () => repo.run('workflow.lock.recover', request)),
  );
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result.error));
  const after = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(after.reconciliation_pending, false);
  assert.equal(after.recovery_lock.status, 'ABSENT');
  const receipt = JSON.parse(
    await readFile(
      path.join(
        repo.projectRoot,
        '.workflow/recovery-guard-recoveries',
        `${inspection.recovery_lock.lock_id}.json`,
      ),
      'utf8',
    ),
  );
  assert.equal(receipt.recovery_lock_id, inspection.recovery_lock.lock_id);
});

test('a malformed immutable recovery receipt cannot certify a stale guard recovery', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  await repo.write(
    '.workflow/operation.recovery.lock',
    `${JSON.stringify({ pid: 2_147_483_647, created_at: '2026-01-01T00:00:00.000Z' })}\n`,
  );
  const inspection = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  const recoveryLockId = inspection.recovery_lock.lock_id;
  await repo.write(
    `.workflow/recovery-guard-recoveries/${recoveryLockId}.json`,
    `${JSON.stringify({ recovery_lock_id: recoveryLockId })}\n`,
  );

  fails(
    await repo.run('workflow.lock.recover', {
      expected_recovery_lock_id: recoveryLockId,
    }),
    'workflow.lock.recover',
    'RECOVERY_INTENT_INVALID',
  );
  const after = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(after.reconciliation_pending, true);
});

test('an active recovery guard and a mismatched recovery ID cannot be removed', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const lockBytes = `${JSON.stringify({
    pid: process.pid,
    created_at: new Date().toISOString(),
  })}\n`;
  await repo.write('.workflow/operation.recovery.lock', lockBytes);
  const inspection = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(inspection.recovery_lock.status, 'ACTIVE');
  assert.equal(inspection.recovery_guard_recovery_allowed, false);

  fails(
    await repo.run('workflow.lock.recover', {
      expected_recovery_lock_id: '0'.repeat(64),
    }),
    'workflow.lock.recover',
    'STALE_LOCK_ID',
  );
  fails(
    await repo.run('workflow.lock.recover', {
      expected_recovery_lock_id: inspection.recovery_lock.lock_id,
    }),
    'workflow.lock.recover',
    'LOCK_OWNER_ACTIVE',
  );
  assert.equal(
    await readFile(path.join(repo.projectRoot, '.workflow/operation.recovery.lock'), 'utf8'),
    lockBytes,
  );
});

test('an invalid recovery intent blocks mutations and requires manual reconciliation', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const invalidIntent = '{invalid recovery record\n';
  const intentId = '0'.repeat(64);
  await repo.write(`.workflow/recovery-intents/${intentId}.json`, invalidIntent);

  const inspection = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(inspection.reconciliation_pending, true);
  assert.equal(inspection.recovery_guard_recovery_allowed, false);
  fails(
    await repo.run('change.start', {
      id: 'F-001',
      kind: 'FEATURE',
      description: 'Add a person',
    }),
    'change.start',
    'RESOURCE_LOCKED',
  );
  fails(
    await repo.run('workflow.lock.recover', {
      expected_recovery_lock_id: '0'.repeat(64),
    }),
    'workflow.lock.recover',
    'RECOVERY_INTENT_INVALID',
  );
  assert.equal(
    await readFile(
      path.join(repo.projectRoot, '.workflow/recovery-intents', `${intentId}.json`),
      'utf8',
    ),
    invalidIntent,
  );
});

test('lock recovery refuses an active owner and leaves its lock intact', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const lockBytes = `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`;
  await repo.write('.workflow/operation.lock', lockBytes);
  const inspection = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(inspection.operation_lock.status, 'ACTIVE');
  assert.equal(inspection.recovery_allowed, false);

  fails(
    await repo.run('workflow.lock.recover', {
      expected_lock_id: inspection.operation_lock.lock_id,
    }),
    'workflow.lock.recover',
    'LOCK_OWNER_ACTIVE',
  );
  assert.equal(
    await readFile(path.join(repo.projectRoot, '.workflow/operation.lock'), 'utf8'),
    lockBytes,
  );
  const after = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(after.recovery_lock.status, 'ABSENT');
});

test('lock recovery refuses stale inspection data and malformed owner records', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const lockBytes = `${JSON.stringify({ pid: 2_147_483_647, created_at: '2026-01-01T00:00:00.000Z' })}\n`;
  await repo.write('.workflow/operation.lock', lockBytes);
  fails(
    await repo.run('workflow.lock.recover', { expected_lock_id: '0'.repeat(64) }),
    'workflow.lock.recover',
    'STALE_LOCK_ID',
  );
  assert.equal(
    await readFile(path.join(repo.projectRoot, '.workflow/operation.lock'), 'utf8'),
    lockBytes,
  );

  await repo.write('.workflow/operation.lock', '{invalid\n');
  const inspection = succeeds(await repo.run('workflow.lock.inspect'), 'workflow.lock.inspect');
  assert.equal(inspection.operation_lock.status, 'INVALID');
  fails(
    await repo.run('workflow.lock.recover', {
      expected_lock_id: inspection.operation_lock.lock_id,
    }),
    'workflow.lock.recover',
    'LOCK_INVALID',
  );
  assert.equal(
    await readFile(path.join(repo.projectRoot, '.workflow/operation.lock'), 'utf8'),
    '{invalid\n',
  );
});

test('an absent lock cannot be turned into fabricated recovery evidence', async (t) => {
  const repo = await repository(t);
  await initialize(repo);
  const emptyLockId = 'a'.repeat(64);
  const result = succeeds(
    await repo.run('workflow.lock.recover', { expected_lock_id: emptyLockId }),
    'workflow.lock.recover',
  );
  assert.equal(result.recovered, false);
  assert.equal(result.already_clear, true);
  await assert.rejects(
    readFile(path.join(repo.projectRoot, '.workflow/lock-recoveries', `${emptyLockId}.json`)),
    { code: 'ENOENT' },
  );
});
