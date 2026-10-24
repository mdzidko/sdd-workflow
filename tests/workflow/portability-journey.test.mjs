import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { initialize, repository, stateBytes, succeeds } from './helpers.mjs';

const passingFixture = fileURLToPath(new URL('./fixtures/passing-test.mjs', import.meta.url));

test('the unchanged workflow runs in unrelated projects with distinct branches, paths, and app catalogs', async (t) => {
  const projects = [
    {
      baseBranch: 'trunk',
      changeId: 'A-001',
      app: { id: 'catalog', path: 'services/catalog' },
      profileName: 'catalog-unit',
    },
    {
      baseBranch: 'integration',
      changeId: 'M-001',
      app: { id: 'mobile-client', path: 'products/mobile' },
      profileName: 'mobile-fast',
    },
  ];

  for (const project of projects) {
    const repo = await repository(t, { baseBranch: project.baseBranch });
    await repo.write(`${project.app.path}/README.md`, `# ${project.app.id}\n`);
    repo.git('add', '--', project.app.path);
    repo.git('commit', '-m', 'chore: add fixture application');
    await initialize(repo, {
      repository: { remote: 'origin', base_branch: project.baseBranch },
      applications: [project.app],
      commands: {
        [project.profileName]: {
          command: process.execPath,
          args: ['--test', passingFixture],
          timeout_ms: 2_000,
          category: 'unit',
          cadence: 'task',
          application_ids: [project.app.id],
        },
      },
    });
    const change = succeeds(
      await repo.run('change.start', {
        id: project.changeId,
        kind: 'MAINTENANCE',
        description: `Inspect ${project.app.id}`,
      }),
      'change.start',
    );
    succeeds(
      await repo.run('artifact.create', {
        change_id: project.changeId,
        id: 'IMPACT-MAP',
        type: 'impact-map',
        title: `Impact map for ${project.app.id}`,
        data: {
          applications: [
            {
              application_id: project.app.id,
              impact: 'AFFECTED',
              rationale: 'The maintenance request directly affects this application.',
            },
          ],
          contracts: [],
          data_changes: [],
          exclusions: [],
          compatibility: [],
        },
      }),
      'artifact.create',
    );
    succeeds(await repo.accept(project.changeId, 'IMPACT-MAP'), 'decision.accept');
    const state = JSON.parse(await stateBytes(repo));
    const persistedChange = state.changes[project.changeId];
    const impactMap = persistedChange.artifacts.find((artifact) => artifact.id === 'IMPACT-MAP');
    const headSha = repo.git('rev-parse', 'HEAD');
    persistedChange.pull_request = { head_sha: headSha };
    persistedChange.stage_history = [
      {
        to: 'PLANNING',
        evidence: [
          {
            type: 'impact-map',
            artifact_id: impactMap.id,
            content_hash: impactMap.content_hash,
          },
        ],
      },
    ];
    await repo.write('.workflow/state.json', `${JSON.stringify(state, null, 2)}\n`);
    const schedule = succeeds(
      await repo.run('test.schedule', {
        phase: 'task',
        change_id: project.changeId,
      }),
      'test.schedule',
    );
    const execution = succeeds(
      await repo.run('tests.run_scheduled', {
        phase: 'task',
        change_id: project.changeId,
      }),
      'tests.run_scheduled',
    );

    assert.equal(change.change.base_sha, repo.git('rev-parse', project.baseBranch));
    assert.equal(change.change.bundle_hash.length, 64);
    assert.equal(schedule.profiles.length, 1);
    assert.equal(schedule.profiles[0].name, project.profileName);
    assert.equal(execution.passed, true);
    assert.equal(execution.results[0].application_ids[0], project.app.id);
  }
});
