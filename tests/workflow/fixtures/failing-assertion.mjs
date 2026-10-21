import test from 'node:test';
import assert from 'node:assert/strict';

test('rejects a parent relationship that creates a cycle', () => {
  const actualResult = 'accepted';
  assert.equal(actualResult, 'rejected', 'A cyclic parent relationship must be rejected.');
});
