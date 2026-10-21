import { execute } from '../../workflow/lib/operations.mjs';

const args = process.argv.slice(2);
const operation = args[0];
const projectIndex = args.indexOf('--project');
const projectRoot = projectIndex < 0 ? process.cwd() : args[projectIndex + 1];
let source = '';
for await (const chunk of process.stdin) source += chunk;
let input;
try {
  input = source.trim() ? JSON.parse(source) : {};
} catch {
  console.log(
    JSON.stringify({
      ok: false,
      operation,
      error: { code: 'INVALID_JSON', message: 'Input must be valid JSON.' },
    }),
  );
  process.exit(1);
}
const result = await execute({ operation, input }, { projectRoot });
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
