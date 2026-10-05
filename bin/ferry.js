#!/usr/bin/env node
// `ferry` with no arguments speaks MCP over stdio; subcommands are in src/cli.ts.
const args = process.argv.slice(2)
if (args.length === 0) await import('../src/index.ts')
else await import('../src/cli.ts')
