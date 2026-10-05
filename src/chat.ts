// Viewer chat: each deck gets its own Claude Code conversation, run headless
// with `claude -p` in the deck's repository. The agent reads code and edits
// the deck through Ferry's MCP tools; replies stream to the viewer over SSE.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { ROOT } from './build.ts'
import { ferryHome, loadDeck, type StoredDeck } from './store.ts'

export interface ChatTool {
  id: string
  name: string
  label: string
  done: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  at: string
  /** What the user was looking at. */
  context?: { slideId?: string; slideIndex?: number; step?: number; target?: { kind: string; label: string } }
  tools?: ChatTool[]
  status?: 'streaming' | 'done' | 'error' | 'stopped'
}

export interface ChatLog {
  deckId: string
  sessionId?: string
  messages: ChatMessage[]
}

export type ChatEvent =
  | { op: 'message'; message: ChatMessage }
  | { op: 'delta'; messageId: string; text: string }
  | { op: 'tool'; messageId: string; tool: ChatTool }
  | { op: 'end'; message: ChatMessage }
  | { op: 'cleared' }

const chatDir = () => join(ferryHome(), 'chat')
const logPath = (deckId: string) => {
  if (!/^[a-z0-9-]+$/.test(deckId)) throw new Error(`invalid deck id "${deckId}"`)
  return join(chatDir(), `${deckId}.json`)
}

export async function loadChat(deckId: string): Promise<ChatLog> {
  try {
    return JSON.parse(await readFile(logPath(deckId), 'utf8'))
  } catch {
    return { deckId, messages: [] }
  }
}

async function saveChat(log: ChatLog) {
  await mkdir(chatDir(), { recursive: true })
  const path = logPath(log.deckId)
  const temp = `${path}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(log, null, 1))
  await rename(temp, path)
}

interface Run {
  child: ChildProcess
  message: ChatMessage
  stopped: boolean
}
const runs = new Map<string, Run>()

export function activeMessage(deckId: string): ChatMessage | undefined {
  return runs.get(deckId)?.message
}

let claudeBin: string | null | undefined
function findClaude(): string | null {
  if (claudeBin !== undefined) return claudeBin
  const candidates = [process.env.FERRY_CLAUDE_BIN, join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean) as string[]
  claudeBin = candidates.find((path) => existsSync(path)) ?? null
  if (!claudeBin) {
    try {
      claudeBin = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || null
    } catch {
      claudeBin = null
    }
  }
  return claudeBin
}

/** The repository the deck explains: the first git source, else the home directory. */
function repoOf(deck: StoredDeck): string {
  for (const slide of deck.source) {
    const git = (slide as { git?: { repo?: string } }).git
    if (git?.repo && isAbsolute(git.repo) && existsSync(git.repo)) return git.repo
  }
  if (deck.repo && isAbsolute(deck.repo) && existsSync(deck.repo)) return deck.repo
  return homedir()
}

const TOOLS = [
  'mcp__ferry__get_deck',
  'mcp__ferry__update_slide',
  'mcp__ferry__add_slides',
  'mcp__ferry__remove_slides',
  'mcp__ferry__reorder_slides',
  'mcp__ferry__update_deck',
  'mcp__ferry__inspect_changes',
  'mcp__ferry__authoring_guide',
  'Read',
  'Grep',
  'Glob',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git status:*)',
  'Bash(git blame:*)',
]
const DENIED = ['Edit', 'Write', 'NotebookEdit', 'mcp__ferry__wait_for_feedback', 'mcp__ferry__open_deck', 'mcp__ferry__draft_deck_from_git', 'mcp__ferry__create_deck', 'mcp__ferry__export_deck']

function systemPrompt(deck: StoredDeck, repo: string): string {
  return `You are Ferry's built-in assistant, chatting with the user inside the Ferry presentation viewer while they review the deck "${deck.title}" (deck_id: ${deck.id}). The repository it explains is ${repo}.

Each user message starts with a bracketed note saying which slide and step they are looking at, and anything they pinned.
- Answer questions about the slides and the code directly and concisely. Your reply renders in a narrow chat panel: short paragraphs, \`code\`, small lists; no headings or tables.
- Read code with Read, Grep, Glob, and git (log/diff/show/blame) when it helps. Never modify repository files.
- To change the deck, use the Ferry tools with deck_id "${deck.id}": get_deck (with slide_id) first, then update_slide with the complete revised slide; add_slides/remove_slides/reorder_slides/update_deck as needed. Call authoring_guide if unsure about slide shapes. The viewer updates live while the user watches.
- After changing the deck, say in one sentence what changed. Ask before large restructures.`
}

function contextNote(deck: StoredDeck, context: ChatMessage['context']): string {
  if (!context?.slideId) return '[Viewing the deck overview]'
  const index = deck.slides.findIndex((s) => s.id === context.slideId)
  const slide = deck.slides[index]
  if (!slide) return `[Viewing slide "${context.slideId}"]`
  const step = context.step ?? 0
  const parts = [
    `Viewing slide ${index + 1}/${deck.slides.length}${slide.title ? ` "${slide.title.replace(/\*/g, '')}"` : ''} (${slide.type}, id ${slide.id}), step ${step + 1}/${slide.steps.length}${slide.steps[step]?.title ? ` "${slide.steps[step].title}"` : ''}`,
  ]
  if (context.target) parts.push(`pinned ${context.target.kind}: ${context.target.label}`)
  return `[${parts.join('; ')}]`
}

function toolLabel(name: string, input: Record<string, unknown> | undefined): string {
  const file = typeof input?.file_path === 'string' ? (input.file_path as string).split('/').slice(-2).join('/') : ''
  switch (name) {
    case 'Read':
      return `Reading ${file || 'a file'}`
    case 'Grep':
      return `Searching for “${String(input?.pattern ?? '').slice(0, 40)}”`
    case 'Glob':
      return `Finding ${String(input?.pattern ?? 'files')}`
    case 'Bash':
      return `Running ${String(input?.command ?? 'git').slice(0, 48)}`
    case 'ToolSearch':
      return 'Loading tools'
  }
  const ferry = name.replace(/^mcp__ferry__/, '')
  const labels: Record<string, string> = {
    get_deck: 'Reading the deck',
    update_slide: `Updating slide ${input?.slide_id ?? ''}`.trim(),
    add_slides: 'Adding slides',
    remove_slides: 'Removing slides',
    reorder_slides: 'Reordering slides',
    update_deck: 'Updating the deck',
    inspect_changes: 'Inspecting the git changes',
    authoring_guide: 'Reading the authoring guide',
  }
  return labels[ferry] ?? ferry.replace(/_/g, ' ')
}

/** Clean environment for a top-level Claude Code session. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE' || key === 'CLAUDE_PID' || key === 'AI_AGENT' || key === 'CLAUDE_EFFORT') delete env[key]
  return env
}

export async function sendChat(
  deckId: string,
  input: { text: string; context?: ChatMessage['context'] },
  emit: (event: ChatEvent) => void,
): Promise<ChatMessage> {
  if (runs.has(deckId)) throw new Error('the agent is still answering — wait or press Stop')
  const claude = findClaude()
  if (!claude) throw new Error('Claude Code CLI not found. Install it, or set FERRY_CLAUDE_BIN.')
  const deck = await loadDeck(deckId)
  const log = await loadChat(deckId)
  const now = () => new Date().toISOString()
  const index = input.context?.slideId ? deck.slides.findIndex((s) => s.id === input.context!.slideId) : -1
  const user: ChatMessage = { id: `m-${randomBytes(4).toString('hex')}`, role: 'user', text: input.text.trim().slice(0, 8000), at: now(), context: { ...input.context, slideIndex: index >= 0 ? index : undefined } }
  const reply: ChatMessage = { id: `m-${randomBytes(4).toString('hex')}`, role: 'agent', text: '', at: now(), tools: [], status: 'streaming' }
  log.messages.push(user)
  await saveChat(log)
  emit({ op: 'message', message: user })
  emit({ op: 'message', message: reply })

  const repo = repoOf(deck)
  const resume = log.sessionId
  const sessionId = resume ?? randomUUID()
  const mcp = JSON.stringify({ mcpServers: { ferry: { command: process.execPath, args: [join(ROOT, 'bin', 'ferry.js')] } } })
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--strict-mcp-config',
    '--mcp-config', mcp,
    '--append-system-prompt', systemPrompt(deck, repo),
    '--allowedTools', ...TOOLS,
    '--disallowedTools', ...DENIED,
    ...(resume ? ['--resume', resume] : ['--session-id', sessionId]),
    ...(process.env.FERRY_CHAT_MODEL ? ['--model', process.env.FERRY_CHAT_MODEL] : []),
  ]
  const child = spawn(claude, args, { cwd: repo, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  const run: Run = { child, message: reply, stopped: false }
  runs.set(deckId, run)
  child.stdin!.end(`${contextNote(deck, user.context)}\n\n${user.text}`)

  let buffer = ''
  let stderr = ''
  const handle = (event: Record<string, any>) => {
    if (event.type === 'stream_event') {
      const e = event.event
      if (e.type === 'content_block_start') {
        // Separate text written before and after tool calls.
        if (e.content_block?.type === 'text' && reply.text && !reply.text.endsWith('\n\n')) {
          reply.text += '\n\n'
          emit({ op: 'delta', messageId: reply.id, text: '\n\n' })
        }
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        reply.text += e.delta.text
        emit({ op: 'delta', messageId: reply.id, text: e.delta.text })
      }
    } else if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_use' || block.name === 'ToolSearch') continue
        const tool: ChatTool = { id: block.id, name: block.name, label: toolLabel(block.name, block.input), done: false }
        reply.tools!.push(tool)
        emit({ op: 'tool', messageId: reply.id, tool })
      }
    } else if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        const tool = reply.tools!.find((t) => t.id === block.tool_use_id)
        if (!tool) continue
        tool.done = true
        emit({ op: 'tool', messageId: reply.id, tool })
      }
    } else if (event.type === 'result') {
      if (!reply.text.trim() && typeof event.result === 'string') reply.text = event.result
      if (event.is_error) reply.status = 'error'
    }
  }
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        handle(JSON.parse(line))
      } catch {
        /* not JSON */
      }
    }
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)))

  child.on('close', async (code) => {
    runs.delete(deckId)
    if (run.stopped) reply.status = 'stopped'
    else if (reply.status === 'streaming') reply.status = code === 0 ? 'done' : 'error'
    if (reply.status === 'error' && !reply.text.trim()) reply.text = `The agent stopped: ${stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${code}`}`
    for (const tool of reply.tools ?? []) tool.done = true
    const latest = await loadChat(deckId)
    latest.messages.push(reply)
    // Keep the session only once it exists; a failed resume starts fresh next time.
    if (code === 0 || run.stopped) latest.sessionId = sessionId
    else if (/no conversation found|session/i.test(stderr)) latest.sessionId = undefined
    await saveChat(latest)
    emit({ op: 'end', message: reply })
  })
  child.on('error', (error) => {
    stderr += String(error)
  })
  return user
}

export function stopChat(deckId: string): boolean {
  const run = runs.get(deckId)
  if (!run) return false
  run.stopped = true
  run.child.kill('SIGTERM')
  return true
}

export async function clearChat(deckId: string): Promise<void> {
  stopChat(deckId)
  await saveChat({ deckId, messages: [] })
}
