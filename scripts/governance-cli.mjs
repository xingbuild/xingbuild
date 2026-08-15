#!/usr/bin/env node
const { runGovernanceCli } = await import("./lib/governance-cli-runtime.mjs");
process.exitCode = await runGovernanceCli({ argv: process.argv.slice(2), sourceRoot: process.cwd() });
