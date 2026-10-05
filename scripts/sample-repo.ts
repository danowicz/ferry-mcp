// Creates examples/sample-repo: a tiny daemon with a restart bug on `main`
// and its fix on `fix/bind-retry`. Used by the demo and smoke test.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'sample-repo')

const run = (...args: string[]) =>
  execFileSync('git', ['-C', SAMPLE, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'Ana Ruiz', GIT_AUTHOR_EMAIL: 'ana@example.com', GIT_COMMITTER_NAME: 'Ana Ruiz', GIT_COMMITTER_EMAIL: 'ana@example.com' },
    stdio: 'pipe',
  })

function write(files: Record<string, string | null>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(SAMPLE, path)
    if (content === null) rmSync(full, { force: true })
    else {
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content.replace(/^\n/, ''))
    }
  }
}

const listen = `
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
}

export class AlreadyRunning extends Error {
  constructor(readonly pid: number) {
    super(\`a server is already running (pid \${pid})\`)
  }
}
`

export function createSampleRepo() {
  rmSync(SAMPLE, { recursive: true, force: true })
  mkdirSync(SAMPLE, { recursive: true })
  run('init', '-q', '-b', 'main')
  write({
    'README.md': `# beacon\n\nA background daemon that every terminal and the desktop app share.\n`,
    'src/log.ts': `export const log = {\n  info: (message: string) => console.log(\`[beacon] \${message}\`),\n  warn: (message: string) => console.warn(\`[beacon] \${message}\`),\n}\n`,
    'src/server/paths.ts': `import { homedir } from 'node:os'\nimport { join } from 'node:path'\n\nexport const registrationPath = (port: number) => join(homedir(), '.beacon', \`\${port}.json\`)\n`,
    'src/server/registry.ts': `
import { readFile } from 'node:fs/promises'
import { registrationPath } from './paths'

export interface Registration {
  pid: number
  port: number
  alive: boolean
}

export async function readRegistration(port: number): Promise<Registration | null> {
  try {
    const { pid } = JSON.parse(await readFile(registrationPath(port), 'utf8'))
    return { pid, port, alive: isAlive(pid) }
  } catch {
    return null
  }
}

export async function waitForIncumbent(port: number, timeout: number): Promise<number | null> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const registration = await readRegistration(port)
    if (registration?.alive) return registration.pid
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
`,
    'src/server/bind.ts': `
import { createServer, type Server } from 'node:net'
import { waitForIncumbent } from './registry'
import { log } from '../log'

export async function bind(port: number): Promise<Server> {
  const server = createServer()
  try {
    await listen(server, port)
    return server
  } catch (error) {
    if (!isAddressInUse(error)) throw error
    log.warn(\`port \${port} is busy, waiting for the incumbent to register\`)
    const incumbent = await waitForIncumbent(port, 15_000)
    if (incumbent) throw new AlreadyRunning(incumbent)
    throw new Error(\`port \${port} stayed busy for 15s\`)
  }
}
${listen}`,
    'src/client/restart.ts': `
import { readRegistration } from '../server/registry'
import { spawnDaemon } from './spawn'

export async function restart(port: number) {
  const old = await readRegistration(port)
  if (old?.alive) process.kill(old.pid, 'SIGTERM')
  return spawnDaemon(port)
}
`,
    'src/client/spawn.ts': `import { spawn } from 'node:child_process'\n\nexport function spawnDaemon(port: number) {\n  return spawn(process.execPath, ['daemon.js', String(port)], { detached: true, stdio: 'ignore' })\n}\n`,
  })
  run('add', '-A')
  run('commit', '-q', '-m', 'beacon: shared background daemon')

  run('checkout', '-q', '-b', 'fix/bind-retry')
  write({
    'src/server/bind.ts': `
import { createServer, type Server } from 'node:net'
import { readRegistration } from './registry'

const RETRY_INTERVAL = 100
const DEADLINE = 15_000

export async function bind(port: number): Promise<Server> {
  const server = createServer()
  const deadline = Date.now() + DEADLINE
  for (;;) {
    try {
      await listen(server, port)
      return server
    } catch (error) {
      if (!isAddressInUse(error)) throw error
    }
    const incumbent = await readRegistration(port)
    if (incumbent?.alive) throw new AlreadyRunning(incumbent.pid)
    if (Date.now() > deadline) throw new Error(\`port \${port} stayed busy for \${DEADLINE / 1000}s\`)
    await sleep(RETRY_INTERVAL)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
${listen}`,
    'src/server/registry.ts': `
import { readFile } from 'node:fs/promises'
import { registrationPath } from './paths'

export interface Registration {
  pid: number
  port: number
  alive: boolean
}

export async function readRegistration(port: number): Promise<Registration | null> {
  try {
    const { pid } = JSON.parse(await readFile(registrationPath(port), 'utf8'))
    return { pid, port, alive: isAlive(pid) }
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
`,
    'test/bind.test.ts': `
import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { bind } from '../src/server/bind'

test('takes the port as soon as the old server lets go', async () => {
  const old = createServer().listen(4999)
  setTimeout(() => old.close(), 300)
  const started = Date.now()
  const server = await bind(4999)
  expect(Date.now() - started).toBeLessThan(1_000)
  server.close()
})

test('still refuses to start next to a live server', async () => {
  const live = createServer().listen(4998)
  await expect(bind(4998)).rejects.toThrow()
  live.close()
})
`,
  })
  run('add', '-A')
  run('commit', '-q', '-m', 'Retry the bind instead of waiting for an incumbent')
  return SAMPLE
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(createSampleRepo())
