import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initialize, repository, stateBytes, succeeds } from './helpers.mjs';

const routeExpectations = [
  ['PROJECT_INIT', 'initialization', ['product_acceptance', 'architecture_acceptance']],
  ['FEATURE', 'feature', ['business_specification_acceptance']],
  ['BUGFIX', 'defect', ['squash_merge_acceptance']],
  ['MAINTENANCE', 'maintenance', ['squash_merge_acceptance']],
  ['WORKFLOW_CHANGE', 'workflow_change', ['explicit_activation']],
];

test('change.route returns the correct advisory playbook without mutating workflow state', async (t) => {
  const repo = await repository(t);
  await initialize(repo);

  for (const [index, [kind, routeName, humanGates]] of routeExpectations.entries()) {
    const changeId = `C-${String(index + 1).padStart(3, '0')}`;
    await repo.run('change.start', {
      id: changeId,
      kind,
      description: `Exercise ${routeName} routing`,
    });
    const before = await stateBytes(repo);
    const route = succeeds(await repo.run('change.route', { change_id: changeId }), 'change.route');

    assert.equal(route.change_id, changeId);
    assert.equal(route.kind, kind);
    assert.equal(route.route, routeName);
    assert.equal(route.advisory_only, true);
    assert.equal(route.gate_authority, 'none');
    assert.ok(route.sequence.length > 0);
    assert.ok(humanGates.every((gate) => route.human_gates.includes(gate)));
    assert.equal(await stateBytes(repo), before, 'Routing must not alter durable workflow state.');
  }
});

test('route playbooks preserve initialization, defect, and maintenance edge-case rules', async () => {
  const routesPath = new URL(
    '../../workflow/bundle/skills/sdlc-workflow/references/routes.md',
    import.meta.url,
  );
  const routes = await readFile(routesPath, 'utf8');
  const foundations = await readFile(
    new URL('../../workflow/bundle/skills/sdlc-foundations/SKILL.md', import.meta.url),
    'utf8',
  );
  const specification = await readFile(
    new URL('../../workflow/bundle/skills/sdlc-specification/SKILL.md', import.meta.url),
    'utf8',
  );
  const planning = await readFile(
    new URL('../../workflow/bundle/skills/sdlc-planning/SKILL.md', import.meta.url),
    'utf8',
  );

  assert.match(routes, /product acceptance before finalizing architecture/i);
  assert.match(
    routes,
    /architecture acceptance before creating the application\/repository bootstrap/i,
  );
  assert.match(routes, /expected behavior is ambiguous[\s\S]*return to feature specification/i);
  assert.match(routes, /exact target deployment already contains the fix[\s\S]*no-file outcome/i);
  assert.match(routes, /unknown impact requires broader application and system verification/i);
  assert.match(routes, /Do not create an empty commit for a verified no-op/i);
  assert.match(
    routes,
    /explicit `NO_FILE` plan[\s\S]*both test-author and implementer tasks need current GREEN evidence/i,
  );
  assert.match(routes, /file-changing plans[\s\S]*behavioral RED before implementation/i);
  assert.match(foundations, /explicit product acceptance before final architecture/i);
  assert.match(specification, /do not label the behavior a defect by assumption/i);
  assert.match(planning, /verified no-op may complete without a file change or empty commit/i);
});
