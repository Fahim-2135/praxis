#!/usr/bin/env node
// `praxis-history`: scan Claude Code's transcripts into Praxis's history file.
//
// The Praxis mod runs this as a child process and reads the file it writes. It prints one JSON
// line describing the scan, so the mod can tell success from failure without parsing prose.
//
//   node bin/praxis-history.mjs [--projects <dir>] [--data <dir>]

import { scanHistory } from "../src/history/scan.mjs";

/** Read `--name value` pairs from argv. */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--projects") options.projectsDir = argv[i + 1];
    else if (argv[i] === "--data") options.dataDir = argv[i + 1];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return options;
}

try {
  const result = await scanHistory(parseArgs(process.argv.slice(2)));
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err?.message ?? err) }) + "\n");
  process.exitCode = 1;
}
