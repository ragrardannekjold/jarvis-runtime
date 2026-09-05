import { safeClaudeReadinessReadback } from "./claude-readiness.mjs";

process.stdout.write(`${safeClaudeReadinessReadback(process.env)}\n`);
