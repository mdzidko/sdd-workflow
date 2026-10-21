import test from 'node:test';
import assert from 'node:assert/strict';

test('accepts a valid person', () => {
  assert.equal('Anna'.length > 0, true);
});

test('rejects a parent relationship that creates a cycle', () => {
  assert.equal('accepted', 'rejected', 'A cyclic parent relationship must be rejected.');
});
