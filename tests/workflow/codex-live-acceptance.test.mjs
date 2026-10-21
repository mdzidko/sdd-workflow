import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { initialize, repository, startFeature, succeeds } from './helpers.mjs';

export function parseCodexEvents(jsonl) {
  const lines = jsonl.split(/\r?\n/);
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      if (index === lines.length - 1 && !jsonl.endsWith('\n') && !jsonl.endsWith('\r')) break;
      throw error;
    }
  }
  return events;
}

export function summarizeCodexUsage(events) {
  const turns = events.filter((event) => event.type === 'turn.completed');
  const usages = turns
    .map((event) => event.usage)
    .filter(
      (usage) =>
        usage &&
        Number.isSafeInteger(usage.input_tokens) &&
        usage.input_tokens >= 0 &&
        Number.isSafeInteger(usage.output_tokens) &&
        usage.output_tokens >= 0,
    );
  return {
    available: usages.length > 0,
    turn_count: turns.length,
    measured_turn_count: usages.length,
    input_tokens: usages.reduce((sum, usage) => sum + usage.input_tokens, 0),
    output_tokens: usages.reduce((sum, usage) => sum + usage.output_tokens, 0),
    total_tokens: usages.reduce(
      (sum, usage) =>
        sum +
        (Number.isSafeInteger(usage.total_tokens)
          ? usage.total_tokens
          : usage.input_tokens + usage.output_tokens),
      0,
    ),
  };
}

function collectText(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectText);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectText);
  return [];
}

test('Codex JSONL recovery preserves complete events and discards only a truncated final record', () => {
  const complete = { type: 'thread.started', thread_id: 'thread-1' };
  assert.deepEqual(parseCodexEvents(`${JSON.stringify(complete)}\n{"type":"turn`), [complete]);
  assert.throws(() => parseCodexEvents('{"type":\n{"type":"thread.started"}\n'));
});

test('Codex CLI usage summary aggregates best-effort token counts without inventing missing usage', () => {
  assert.deepEqual(
    summarizeCodexUsage([
      { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } },
      { type: 'turn.completed', usage: null },
    ]),
    {
      available: true,
      turn_count: 2,
      measured_turn_count: 1,
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
    },
  );
  assert.deepEqual(summarizeCodexUsage([{ type: 'turn.completed', usage: null }]), {
    available: false,
    turn_count: 1,
    measured_turn_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  });
});

test(
  'installed entry skill, native handoff and fresh-process Codex resume',
  { skip: process.env.WORKFLOW_LIVE_CODEX !== '1' },
  async (t) => {
    const repo = await repository(t);
    succeeds(await repo.run('bundle.install'), 'bundle.install');
    repo.git('add', '-A');
    repo.git('commit', '-m', 'test: install workflow bundle');
    await initialize(repo);
    await startFeature(repo);

    const marker = `CODEX_SPECIALIST_HANDOFF_${randomUUID()}`;
    const probe = `# Codex acceptance probe\n\nReturn this exact marker: ${marker}\n`;
    await repo.write('acceptance-probe.md', probe);
    const repositoryStatus = repo.git('status', '--porcelain');

    const prompt = [
      'Use the installed $sdlc-workflow entry skill for this read-only acceptance check.',
      'Make exactly one native Codex handoff to the project custom agent named sdlc_spec_reviewer.',
      'Tell that specialist to read only acceptance-probe.md and return its exact marker.',
      'Do not read the probe file yourself. Wait for the specialist and return only its marker.',
      'Do not read the probe yourself. The specialist may use shell only for read-only file inspection; no one may modify files or access the network.',
    ].join(' ');
    const sandboxMode = process.env.WORKFLOW_CODEX_SANDBOX || 'read-only';
    assert.ok(
      ['read-only', 'workspace-write'].includes(sandboxMode),
      'WORKFLOW_CODEX_SANDBOX must be read-only or workspace-write.',
    );
    const approvalPolicy = sandboxMode === 'workspace-write' ? 'on-request' : 'never';
    const expectVerified = process.env.WORKFLOW_CODEX_EXPECT_VERIFIED === '1';
    assert.ok(
      !expectVerified || sandboxMode === 'workspace-write',
      'WORKFLOW_CODEX_EXPECT_VERIFIED=1 requires WORKFLOW_CODEX_SANDBOX=workspace-write.',
    );
    const codexCommand = process.env.CODEX_EXECUTABLE || 'codex';
    // The disposable project is untrusted by default, so bind the installed role file for this run only.
    const result = spawnSync(
      codexCommand,
      [
        '--config',
        `agents.sdlc_spec_reviewer.config_file="${repo.projectRoot.replaceAll('\\', '/')}/.codex/agents/sdlc_spec_reviewer.toml"`,
        '--cd',
        repo.projectRoot,
        '--sandbox',
        sandboxMode,
        '--ask-for-approval',
        approvalPolicy,
        'exec',
        '--json',
        prompt,
      ],
      {
        cwd: repo.projectRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    const events = parseCodexEvents(result.stdout ?? '');
    const threadId = events.find((event) => event.type === 'thread.started')?.thread_id;
    const usage = summarizeCodexUsage(events);
    console.log(
      `[codex-live] best-effort turn usage: ${usage.available ? JSON.stringify(usage) : 'unavailable from this client run'}`,
    );
    try {
      assert.equal(
        result.error,
        undefined,
        `Codex CLI could not complete the bounded read-only invocation: ${result.error?.message}`,
      );
      assert.equal(
        result.status,
        0,
        `Codex CLI exited unsuccessfully. stderr: ${(result.stderr ?? '').slice(-2_000)}`,
      );
      assert.match(threadId ?? '', /^[0-9a-f-]{36}$/i, 'Codex did not report the test session ID.');
      assert.ok(
        events.some(
          (event) => event.item?.type === 'collab_tool_call' && event.item.tool === 'wait',
        ),
        `No native specialist orchestration event was recorded. Codex JSONL: ${result.stdout.slice(-5_000)}`,
      );
      assert.ok(
        result.stdout.includes(marker),
        `The delegated specialist result was not returned. Codex JSONL: ${result.stdout.slice(-5_000)}`,
      );
      assert.deepEqual(await readFile(`${repo.projectRoot}/acceptance-probe.md`, 'utf8'), probe);
      assert.equal(
        repo.git('status', '--porcelain'),
        repositoryStatus,
        'The read-only acceptance run changed project files.',
      );

      const resumePrompt = [
        'Resume this workflow session from its durable conversation state.',
        'Use the installed sdlc-workflow entry skill and invoke workflow.resume for change_id F-001.',
        'Call `node scripts/workflow/run.mjs workflow.resume --project .` with `{"change_id":"F-001"}` on stdin.',
        'Read acceptance-probe.md and report its exact marker, change ID, and whether repository verification succeeded.',
        'If Git inspection is unavailable, report the returned recovery instruction and do not mutate anything.',
        'Do not modify files or access the network.',
      ].join(' ');
      const resumed = spawnSync(
        codexCommand,
        [
          '--config',
          `agents.sdlc_spec_reviewer.config_file="${repo.projectRoot.replaceAll('\\', '/')}/.codex/agents/sdlc_spec_reviewer.toml"`,
          '--cd',
          repo.projectRoot,
          '--sandbox',
          sandboxMode,
          '--ask-for-approval',
          approvalPolicy,
          'exec',
          'resume',
          '--json',
          threadId,
          resumePrompt,
        ],
        {
          cwd: repo.projectRoot,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      const resumedEvents = parseCodexEvents(resumed.stdout ?? '');
      const resumedText = collectText(resumedEvents).join('\n');
      console.log(
        `[codex-resume] repository verification: ${resumedText.includes('"verified":true') ? 'passed' : 'unavailable; workflow mutation remains blocked'}`,
      );
      assert.equal(
        resumed.error,
        undefined,
        `Codex CLI could not resume the saved session: ${resumed.error?.message}`,
      );
      assert.equal(
        resumed.status,
        0,
        `Codex CLI resume exited unsuccessfully. stderr: ${(resumed.stderr ?? '').slice(-2_000)}`,
      );
      assert.ok(
        resumedEvents.some(
          (event) => event.type === 'thread.started' && event.thread_id === threadId,
        ),
        'Codex did not resume the original saved session in the new process.',
      );
      assert.ok(
        resumed.stdout.includes(marker),
        `The resumed session did not read the project marker. Codex JSONL: ${resumed.stdout.slice(-5_000)}`,
      );
      assert.ok(
        resumedText.includes('"operation":"workflow.resume"') &&
          resumedText.includes('"change":{"id":"F-001"'),
        `The resumed session did not invoke workflow.resume and return the durable change. Codex JSONL: ${resumed.stdout.slice(-5_000)}`,
      );
      assert.match(
        resumedText,
        /"verified":(?:true|false)/,
        `The resumed operation did not report repository verification status. Codex JSONL: ${resumed.stdout.slice(-5_000)}`,
      );
      if (expectVerified)
        assert.ok(
          resumedText.includes('"verified":true'),
          `Git identity was not restored inside the workspace-write sandbox. Codex JSONL: ${resumed.stdout.slice(-5_000)}`,
        );
      if (resumedText.includes('"verified":false'))
        assert.ok(
          resumedText.includes('GIT_ACCESS_UNAVAILABLE') &&
            resumedText.includes('Restore Git access'),
          `An unverified repository did not block the next action. Codex JSONL: ${resumed.stdout.slice(-5_000)}`,
        );
      assert.equal(
        repo.git('status', '--porcelain'),
        repositoryStatus,
        'The read-only resumed session changed project files.',
      );
    } finally {
      if (threadId) {
        const cleanup = spawnSync(codexCommand, ['delete', '--force', threadId], {
          cwd: repo.projectRoot,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 64 * 1024,
        });
        assert.equal(
          cleanup.status,
          0,
          `Codex could not remove its test session ${threadId}: ${(cleanup.stderr ?? '').slice(-1_000)}`,
        );
      }
    }
  },
);
