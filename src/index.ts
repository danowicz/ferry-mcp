#!/usr/bin/env node
// Ferry MCP server over stdio. The live viewer starts lazily on first use.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './mcp.ts'
import { buildViewer } from './build.ts'

const server = createMcpServer()
await server.connect(new StdioServerTransport())
// Exit with the client: the viewer server and file watcher would otherwise keep us alive.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
// Warm the viewer bundle so the first open is instant.
buildViewer().catch((error) => console.error('[ferry] viewer build failed:', error))
