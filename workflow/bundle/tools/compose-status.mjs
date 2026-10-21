import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVICE = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
const STATES = new Set(['created', 'running', 'exited', 'restarting', 'paused', 'dead', 'removing']);
const HEALTH = new Set(['healthy', 'unhealthy', 'starting', 'none']);

function records(source) {
  if (!source.trim()) return [];
  try {
    const parsed = JSON.parse(source);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return source
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

export function sanitizeComposeStatus(source) {
  try {
    const services = records(source).map((record) => {
      const service = record.Service ?? record.service;
      const state = String(record.State ?? record.state ?? '').toLowerCase();
      const health = String(record.Health ?? record.health ?? 'none').toLowerCase();
      const exitCode = record.ExitCode ?? record.exit_code;
      if (!SERVICE.test(service ?? '') || !STATES.has(state) || !HEALTH.has(health))
        throw new Error('Invalid Compose status record.');
      return {
        service,
        state,
        health,
        exit_code: Number.isInteger(exitCode) ? exitCode : null,
      };
    });
    return { available: true, services };
  } catch {
    return { available: false, services: [] };
  }
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(`${JSON.stringify(sanitizeComposeStatus(Buffer.concat(chunks).toString('utf8')))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    process.stdout.write('{"available":false,"services":[]}\n');
    process.exitCode = 1;
  });
