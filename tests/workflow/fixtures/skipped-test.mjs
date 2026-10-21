import test from 'node:test';

test('rejects a cyclic relationship', { skip: 'Behavior has not been implemented.' }, () => {
  throw new Error('A skipped body must not execute.');
});
