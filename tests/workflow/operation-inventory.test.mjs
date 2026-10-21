import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handlers } from '../../workflow/lib/operations.mjs';

test('implementation plan inventories every registered CLI operation exactly once', async () => {
  const plan = await readFile('docs/workflow/implementation-plan.md', 'utf8');
  const start = plan.indexOf('## 9. Registered operation surface');
  const end = plan.indexOf('## 10. External setup', start);
  assert.notEqual(start, -1, 'The operation inventory section must exist.');
  assert.notEqual(end, -1, 'The operation inventory must end before external setup.');

  const inventory = plan.slice(start, end);
  const tick = String.fromCharCode(96);
  const documented = inventory.split(tick).filter((_item, index) => index % 2 === 1);
  assert.equal(new Set(documented).size, documented.length, 'Operation names must be unique.');
  assert.deepEqual(
    [...documented].sort(),
    Object.keys(handlers).sort(),
    'Update the operation inventory whenever a CLI handler is added or removed.',
  );
  assert.match(inventory, /fail-closed endpoints/);
  assert.match(inventory, /trusted authority and protected execution boundaries/);
});
