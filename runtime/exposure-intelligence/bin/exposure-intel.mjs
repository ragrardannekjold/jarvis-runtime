#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { createExposureEngine } from "../src/engine.mjs";
import { verifyEvidence } from "../src/evidence.mjs";
import { ExposureError, publicError } from "../src/errors.mjs";
import { stableStringify } from "../src/util.mjs";

const HELP = `Usage:
  exposure-intel collect --asset <domain|cidr> --allowlist <file> [options]
  exposure-intel verify --evidence <file>

Collect options:
  --execute                    Perform provider API reads (default is dry-run)
  --provider auto|shodan|censys|netlas  Provider selection (default: auto)
  --page-size 1..100           Censys page size (default: 100)
  --max-pages 1..50            Pages in this run (default: 1)
  --base-dir <directory>       State/evidence directory (default: current directory)
  --acknowledge-ambiguous      Retry only after reviewing an ambiguous evidence event

Credentials are read only from SHODAN_API_KEY, CENSYS_PLATFORM_TOKEN,
optional CENSYS_ORGANIZATION_ID, and NETLAS_API_KEY environment variables.
No command in this package performs active scanning.`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") return { command: "help", options: {} };
  const booleanFlags = new Set(["execute", "acknowledge-ambiguous"]);
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new ExposureError(`Unexpected argument: ${token}`, { code: "INVALID_CLI_ARGUMENT" });
    const key = token.slice(2);
    if (Object.hasOwn(options, key)) throw new ExposureError(`Duplicate option: --${key}`, { code: "INVALID_CLI_ARGUMENT" });
    if (booleanFlags.has(key)) {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new ExposureError(`Missing value for --${key}`, { code: "INVALID_CLI_ARGUMENT" });
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function rejectUnknown(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new ExposureError(`Unknown option: --${key}`, { code: "INVALID_CLI_ARGUMENT" });
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (command === "verify") {
    rejectUnknown(options, new Set(["evidence"]));
    if (!options.evidence) throw new ExposureError("--evidence is required.", { code: "EVIDENCE_PATH_REQUIRED" });
    const result = await verifyEvidence(path.resolve(options.evidence));
    process.stdout.write(`${stableStringify(result)}\n`);
    return;
  }
  if (command !== "collect") throw new ExposureError(`Unknown command: ${command}`, { code: "INVALID_CLI_COMMAND" });
  rejectUnknown(options, new Set([
    "asset", "allowlist", "execute", "provider", "page-size", "max-pages", "base-dir", "acknowledge-ambiguous",
  ]));
  if (!options.asset) throw new ExposureError("--asset is required.", { code: "ASSET_REQUIRED" });
  if (!options.allowlist) throw new ExposureError("--allowlist is required.", { code: "ALLOWLIST_REQUIRED" });
  const pageSize = options["page-size"] === undefined ? 100 : Number(options["page-size"]);
  const maxPages = options["max-pages"] === undefined ? 1 : Number(options["max-pages"]);
  const baseDir = path.resolve(options["base-dir"] ?? process.cwd());
  const engine = createExposureEngine({ baseDir });
  const result = await engine.collect({
    asset: options.asset,
    allowlistPath: path.resolve(options.allowlist),
    execute: Boolean(options.execute),
    provider: options.provider ?? "auto",
    pageSize,
    maxPages,
    acknowledgeAmbiguous: Boolean(options["acknowledge-ambiguous"]),
  });
  process.stdout.write(`${stableStringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${stableStringify({ ok: false, error: publicError(error) })}\n`);
  process.exitCode = 1;
});
