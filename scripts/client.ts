// Minimal MCP client used by the demo and smoke test: spawns Ferry over stdio.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export async function connect(env: Record<string, string> = {}) {
  const client = new Client({ name: 'ferry-demo', version: '0.1.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'bin', 'ferry.js')], env: { ...process.env, ...env } as Record<string, string>, stderr: 'inherit' }))
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    const text = result.content.map((c) => c.text).join('\n')
    if (result.isError) throw new Error(`${name}: ${text}`)
    return text
  }
  return { client, call }
}
