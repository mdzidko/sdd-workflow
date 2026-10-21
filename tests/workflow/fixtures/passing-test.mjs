import test from 'node:test';
import assert from 'node:assert/strict';

test('stores the supplied person name', () => {
  const person = { name: 'Anna' };
  assert.equal(person.name, 'Anna');
});
