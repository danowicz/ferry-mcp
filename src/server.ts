// The viewer server: serves the presentation app, deck JSON, and live updates.
// Several MCP processes may run at once; the first one listens and the others
// reuse it, because every process reads the same deck directory.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { buildViewer, FONT_FILES, ROOT, viewerAsset } from './build.ts'
import { decksDir, deleteDeck, listDecks, loadDeck } from './store.ts'
import { feedbackDir, isListening, loadFeedback, newItem, updateFeedback } from './feedback.ts'
import { activeMessage, clearChat, loadChat, sendChat, stopChat } from './chat.ts'

const VERSION = '0.1.0'
const DEFAULT_PORT = Number(process.env.FERRY_PORT ?? 4747)

let server: Server | null = null
let baseUrl: string | null = null
const clients = new Set<ServerResponse>()
let watcher: FSWatcher | null = null

const PAGE = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#14110f"/><path d="M7 20c3 2.5 6 2.5 9 0s6-2.5 9 0" stroke="#ff8a3d" stroke-width="2.6" fill="none" stroke-linecap="round"/><circle cx="16" cy="11" r="3.2" fill="#ff8a3d"/></svg>')}">
<link rel="stylesheet" href="/assets/viewer.css">
</head>
<body>
<div id="app"></div>
<script src="/assets/viewer.js"></script>
</body>
</html>`

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, cache = 'no-store') {
  res.writeHead(status, { 'content-type': type, 'cache-control': cache })
  res.end(body)
}

function json(res: ServerResponse, value: unknown, status = 200) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

function broadcast(message: object) {
  const line = `data: ${JSON.stringify(message)}\n\n`
  for (const client of clients) client.write(line)
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  // JSON only: browsers must preflight cross-origin JSON, which we never allow,
  // so other websites cannot inject feedback that agents would act on.
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('expected application/json')
  const origin = req.headers.origin
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error('cross-origin request refused')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('request too large')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

const str = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : undefined)

async function feedbackRoute(req: IncomingMessage, res: ServerResponse, deckId: string, rest: string[]) {
  const method = req.method ?? 'GET'
  if (method === 'GET' && rest.length === 0) {
    return json(res, { ...(await loadFeedback(deckId)), listening: await isListening(deckId) })
  }
  const input = method === 'GET' ? {} : await body(req)
  if (method === 'POST' && rest.length === 0) {
    const text = str(input.text, 4000)?.trim()
    if (!text) return json(res, { error: 'text is required' }, 400)
    const target = input.target as { kind?: unknown; label?: unknown } | undefined
    const item = newItem({
      text,
      slideId: str(input.slideId, 120),
      step: typeof input.step === 'number' ? input.step : undefined,
      target: target && typeof target.label === 'string' ? { kind: str(target.kind, 40) ?? 'element', label: target.label.slice(0, 400) } : undefined,
      status: input.send === true ? 'open' : 'draft',
    })
    await updateFeedback(deckId, (data) => data.items.push(item))
    return json(res, item, 201)
  }
  if (method === 'POST' && rest[0] === 'send') {
    const sent = await updateFeedback(deckId, (data) => {
      const now = new Date().toISOString()
      const drafts = data.items.filter((i) => i.status === 'draft')
      for (const item of drafts) Object.assign(item, { status: 'open', updatedAt: now })
      return drafts.length
    })
    return json(res, { sent })
  }
  const id = rest[0]
  if (method === 'DELETE' && id) {
    await updateFeedback(deckId, (data) => (data.items = data.items.filter((i) => i.id !== id)))
    return json(res, { deleted: id })
  }
  if (method === 'POST' && id) {
    const item = await updateFeedback(deckId, (data) => {
      const found = data.items.find((i) => i.id === id)
      if (!found) return null
      const now = new Date().toISOString()
      const text = str(input.text, 4000)?.trim()
      if (text && found.status === 'draft') found.text = text
      const reply = str(input.reply, 4000)?.trim()
      if (reply) {
        found.thread.push({ from: 'user', text: reply, at: now })
        if (found.status !== 'draft') found.status = 'open'
      }
      if (input.status === 'open' && found.status !== 'open') found.status = 'open'
      found.updatedAt = now
      return found
    })
    return item ? json(res, item) : json(res, { error: `no feedback ${id}` }, 404)
  }
  return json(res, { error: 'not found' }, 404)
}

async function chatRoute(req: IncomingMessage, res: ServerResponse, deckId: string, action: string) {
  const method = req.method ?? 'GET'
  if (method === 'GET' && !action) {
    const log = await loadChat(deckId)
    const active = activeMessage(deckId)
    return json(res, { messages: active ? [...log.messages, active] : log.messages, running: !!active })
  }
  const input = await body(req)
  if (method === 'POST' && !action) {
    const text = str(input.text, 8000)?.trim()
    if (!text) return json(res, { error: 'text is required' }, 400)
    const target = input.target as { kind?: unknown; label?: unknown } | undefined
    const message = await sendChat(
      deckId,
      {
        text,
        context: {
          slideId: str(input.slideId, 120),
          step: typeof input.step === 'number' ? input.step : undefined,
          target: target && typeof target.label === 'string' ? { kind: str(target.kind, 40) ?? 'element', label: target.label.slice(0, 400) } : undefined,
        },
      },
      (event) => broadcast({ type: 'chat', id: deckId, ...event }),
    )
    return json(res, message, 201)
  }
  if (method === 'POST' && action === 'stop') return json(res, { stopped: stopChat(deckId) })
  if (method === 'DELETE' && !action) {
    await clearChat(deckId)
    broadcast({ type: 'chat', id: deckId, op: 'cleared' })
    return json(res, { cleared: true })
  }
  return json(res, { error: 'not found' }, 404)
}

async function handle(req: IncomingMessage, url: URL, res: ServerResponse) {
  const path = url.pathname
  const chat = path.match(/^\/api\/decks\/([a-z0-9-]+)\/chat(?:\/([a-z]+))?$/)
  if (chat) {
    try {
      return await chatRoute(req, res, chat[1], chat[2] ?? '')
    } catch (error) {
      return json(res, { error: (error as Error).message }, 400)
    }
  }
  const feedback = path.match(/^\/api\/decks\/([a-z0-9-]+)\/feedback(?:\/(.*))?$/)
  if (feedback) {
    try {
      return await feedbackRoute(req, res, feedback[1], (feedback[2] ?? '').split('/').filter(Boolean))
    } catch (error) {
      return json(res, { error: (error as Error).message }, 400)
    }
  }
  if (path === '/api/health') return json(res, { ferry: true, version: VERSION, mcpCommand: `node ${join(ROOT, 'bin', 'ferry.js')}` })
  if (path === '/api/decks') return json(res, await listDecks())
  if (path.startsWith('/api/decks/')) {
    const id = decodeURIComponent(path.slice('/api/decks/'.length))
    if (req.method === 'DELETE') {
      try {
        await body(req) // JSON from localhost pages only, like the feedback API
        stopChat(id)
        await deleteDeck(id)
        return json(res, { deleted: id })
      } catch (error) {
        return json(res, { error: (error as Error).message }, 400)
      }
    }
    try {
      const { source, ...deck } = await loadDeck(id)
      void source
      return json(res, deck)
    } catch (error) {
      return json(res, { error: (error as Error).message }, 404)
    }
  }
  if (path === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(`retry: 1000\n\n`)
    clients.add(res)
    res.on('close', () => clients.delete(res))
    return
  }
  if (path === '/assets/viewer.js' || path === '/assets/viewer.css') {
    await buildViewer()
    const file = path.endsWith('.js') ? 'viewer.js' : 'viewer.css'
    return send(res, 200, await readFile(viewerAsset(file)), path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8')
  }
  if (path.startsWith('/fonts/')) {
    const file = FONT_FILES[path.slice('/fonts/'.length)]
    if (file) return send(res, 200, await readFile(file), 'font/woff2', 'public, max-age=31536000, immutable')
  }
  if (path === '/' || path.startsWith('/d/')) return send(res, 200, PAGE('Ferry'), 'text/html; charset=utf-8')
  send(res, 404, 'Not found', 'text/plain')
}

async function isFerry(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) })
    return response.ok && (await response.json()).ferry === true
  } catch {
    return false
  }
}

function listen(port: number): Promise<Server | 'in-use'> {
  return new Promise((resolve, reject) => {
    const candidate = createServer((req, res) => {
      handle(req, new URL(req.url ?? '/', 'http://localhost'), res).catch((error) => {
        if (!res.headersSent) send(res, 500, String(error?.stack ?? error), 'text/plain')
      })
    })
    candidate.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve('in-use') : reject(error)))
    candidate.listen(port, '127.0.0.1', () => resolve(candidate))
  })
}

async function watchDecks() {
  await mkdir(decksDir(), { recursive: true })
  await mkdir(feedbackDir(), { recursive: true })
  const pending = new Map<string, NodeJS.Timeout>()
  const debounce = (key: string, run: () => void) => {
    clearTimeout(pending.get(key))
    pending.set(key, setTimeout(() => (pending.delete(key), run()), 40))
  }
  watcher = watch(decksDir(), { persistent: false }, (_event, name) => {
    if (!name?.endsWith('.json')) return
    const id = name.slice(0, -5)
    debounce(`deck:${id}`, () => broadcast({ type: 'deck', id }))
  })
  // Feedback changes and agent presence (a heartbeat file while an agent waits).
  const presence = new Map<string, boolean>()
  const checkPresence = async (id: string) => {
    const listening = await isListening(id)
    if (presence.get(id) === listening) return
    presence.set(id, listening)
    broadcast({ type: 'presence', id, listening })
  }
  watch(feedbackDir(), { persistent: false }, (_event, name) => {
    if (name?.endsWith('.json')) {
      const id = name.slice(0, -5)
      debounce(`fb:${id}`, () => broadcast({ type: 'feedback', id }))
    } else if (name?.endsWith('.listening')) checkPresence(name.slice(0, -10))
  })
  setInterval(() => {
    for (const id of presence.keys()) checkPresence(id)
    for (const client of clients) client.write(': keep-alive\n\n')
  }, 3000).unref()
}

/** Returns the URL of a running viewer, starting one in this process if needed. */
export async function ensureServer(): Promise<string> {
  if (baseUrl && (server || (await isFerry(baseUrl)))) return baseUrl
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 20; port++) {
    const url = `http://localhost:${port}`
    const result = await listen(port)
    if (result === 'in-use') {
      if (await isFerry(url)) return (baseUrl = url)
      continue
    }
    server = result
    server.unref()
    if (!watcher) await watchDecks()
    return (baseUrl = url)
  }
  throw new Error('no free port for the Ferry viewer')
}

/** Keeps the process alive for a standalone `ferry serve`. */
export function holdOpen() {
  server?.ref()
}

export function openInBrowser(url: string) {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  spawn(command, args as string[], { stdio: 'ignore', detached: true }).unref()
}
