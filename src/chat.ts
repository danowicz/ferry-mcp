// Viewer chat: each deck gets its own Claude Code conversation, run headless
// with `claude -p` in the deck's repository. The agent reads code and edits
// the deck through Ferry's MCP tools; replies stream to the viewer over SSE.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { ROOT } from './build.ts'
import { deckGit, ensurePlan, ferryHome, loadDeck, loadPlan, planIdFor, type StoredDeck } from './store.ts'
import { changePlan, updateFeedback } from './feedback.ts'

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
  /** What the user was looking at: a slide of the reviewed deck, or of its plan (deckId). */
  context?: { deckId?: string; slideId?: string; slideIndex?: number; step?: number; target?: { kind: string; label: string } }
  mode?: ChatMode
  tools?: ChatTool[]
  status?: 'streaming' | 'done' | 'error' | 'stopped'
}

export interface ChatLog {
  deckId: string
  /** Ask and Plan share a Claude Code session; Implement keeps its own, since it may edit code. */
  sessionId?: string
  implementSessionId?: string
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

const READ = ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git status:*)', 'Bash(git blame:*)', 'Bash(git branch --show-current)']
const DECK = ['mcp__ferry__update_slide', 'mcp__ferry__add_slides', 'mcp__ferry__remove_slides', 'mcp__ferry__reorder_slides', 'mcp__ferry__update_deck']
const NEVER = ['NotebookEdit', 'mcp__ferry__wait_for_feedback', 'mcp__ferry__open_deck', 'mcp__ferry__draft_deck_from_git', 'mcp__ferry__create_deck', 'mcp__ferry__export_deck', 'mcp__ferry__delete_deck']

export type ChatMode = 'ask' | 'plan' | 'implement'
interface ModeSpec {
  tools: string[]
  denied: string[]
  prompt: (deck: StoredDeck, repo: string, planId: string) => string
  /** The one deck this mode may edit. */
  scope?: (deck: StoredDeck, planId: string) => string
}
/** Ask edits the reviewed deck, Plan edits the plan deck, Implement edits code and no deck. */
const MODES: Record<ChatMode, ModeSpec> = {
  ask: {
    tools: ['mcp__ferry__get_deck', ...DECK, 'mcp__ferry__inspect_changes', 'mcp__ferry__authoring_guide', ...READ],
    denied: ['Edit', 'Write', ...NEVER],
    prompt: askPrompt,
    scope: (deck) => deck.id,
  },
  plan: {
    tools: ['mcp__ferry__get_deck', ...DECK, 'mcp__ferry__inspect_changes', 'mcp__ferry__authoring_guide', ...READ],
    denied: ['Edit', 'Write', ...NEVER],
    prompt: planPrompt,
    scope: (_deck, planId) => planId,
  },
  implement: {
    tools: ['Edit', 'Write', 'mcp__ferry__get_deck', 'mcp__ferry__get_feedback', 'mcp__ferry__resolve_feedback', 'mcp__ferry__reply_feedback', ...READ],
    denied: [...DECK, ...NEVER],
    prompt: implementPrompt,
  },
}

const CONTEXT = 'Each user message starts with a bracketed note saying which slide and step they are looking at (in the reviewed deck or in the plan) and anything they pinned.'
const PANEL = 'Your reply renders in a narrow chat panel: short paragraphs, `code`, small lists; no headings or tables.'

function askPrompt(deck: StoredDeck, repo: string): string {
  return `You are Ferry's built-in assistant, chatting with the user inside the Ferry presentation viewer while they review the deck "${deck.title}" (deck_id: ${deck.id}). The repository it explains is ${repo}.

${CONTEXT}
- Answer questions about the slides and the code directly and concisely. ${PANEL}
- Read code with Read, Grep, Glob, and git (log/diff/show/blame) when it helps. Never modify repository files.
- To change the deck, use the Ferry tools with deck_id "${deck.id}": get_deck (with slide_id) first, then update_slide with the complete revised slide; add_slides/remove_slides/reorder_slides/update_deck as needed. Call authoring_guide if unsure about slide shapes. The viewer updates live while the user watches.
- After changing the deck, say in one sentence what changed. Ask before large restructures.
- If the user asks for a change to the code, explain that code changes are planned first: they switch the chat to Plan mode (Shift+Tab) and you draft the change as plan slides.`
}

function planPrompt(deck: StoredDeck, repo: string, planId: string): string {
  return `You are Ferry's built-in assistant in Plan mode. The user is reviewing the deck "${deck.title}" (deck_id: ${deck.id}), which explains code changes in ${repo}, and is planning further changes to that code. The plan is its own deck (deck_id: ${planId}): slides that propose the changes. Nothing is implemented until the user sends the plan to an agent.

${CONTEXT}
- Never modify repository files. Read the code with Read, Grep, Glob, and git (log/diff/show/status/blame) so the plan matches it.
- Edit only the plan deck "${planId}" with Ferry's tools: get_deck, add_slides, update_slide, remove_slides, reorder_slides, update_deck. Call authoring_guide once if unsure about slide shapes.
- Shape the plan: a "title" slide with the goal, then a "points" slide listing the planned changes (keep it current as the plan grows). For each code change, a "diff" slide with "file" and hand-written "before"/"after" code (copy the real current code into "before"), with steps, notes and callouts that explain it. Add "sequence" or "flow" slides when behavior changes, and a "points" checklist for tests and risks.
- Give every slide a short title. When the user asks to change the plan, revise the existing slides instead of piling on new ones.
- ${PANEL} Say in one or two sentences what you added to or changed in the plan.`
}

function implementPrompt(deck: StoredDeck, repo: string): string {
  return `You are Ferry's built-in agent. The user reviewed the deck "${deck.title}" (deck_id: ${deck.id}) in the Ferry viewer and sent code changes to make in the codebase at ${repo}: usually a plan they built as slides, sometimes individual requests.
- Make the changes with Edit and Write. Read code with Read, Grep, Glob, and git (log/diff/show/status/blame). Keep changes minimal and in the style of the surrounding code.
- Never commit or push, never touch files outside the repository, and don't change any slides.
- Resolve each item with resolve_feedback: "done" with the files you changed, or "declined" with why. If something is unclear, ask with reply_feedback instead of guessing.
- Your final message renders in a narrow chat panel: sum up the code changes in one or two sentences.`
}

function contextNote(deck: StoredDeck, context: ChatMessage['context'], where = 'slide'): string {
  if (!context?.slideId) return `[Viewing the ${where === 'slide' ? 'deck' : 'plan'} overview]`
  const index = deck.slides.findIndex((s) => s.id === context.slideId)
  const slide = deck.slides[index]
  if (!slide) return `[Viewing ${where} "${context.slideId}"]`
  const step = context.step ?? 0
  const parts = [
    `Viewing ${where} ${index + 1}/${deck.slides.length}${slide.title ? ` "${slide.title.replace(/\*/g, '')}"` : ''} (${slide.type}, id ${slide.id}), step ${step + 1}/${slide.steps.length}${slide.steps[step]?.title ? ` "${slide.steps[step].title}"` : ''}`,
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
    case 'Edit':
      return `Editing ${file || 'a file'}`
    case 'Write':
      return `Writing ${file || 'a file'}`
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
    get_feedback: 'Reading the change plan',
    resolve_feedback: 'Replying to your requests',
    reply_feedback: 'Asking you a question',
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
  input: { text: string; context?: ChatMessage['context']; /** What the agent reads instead of the displayed text. */ prompt?: string; mode?: ChatMode },
  emit: (event: ChatEvent) => void,
  onDone?: () => Promise<void>,
): Promise<ChatMessage> {
  if (runs.has(deckId)) throw new Error('the agent is still answering — wait or press Stop')
  const claude = findClaude()
  if (!claude) throw new Error('Claude Code CLI not found. Install it, or set FERRY_CLAUDE_BIN.')
  const deck = await loadDeck(deckId)
  const modeName = input.mode ?? 'ask'
  const planId = planIdFor(deck.id)
  const plan = modeName === 'plan' ? await ensurePlan(deck) : await loadPlan(deck)
  // The user may be looking at a plan slide rather than the reviewed deck.
  const viewingPlan = input.context?.deckId === planId && plan
  const viewed = viewingPlan ? plan : deck
  const log = await loadChat(deckId)
  const now = () => new Date().toISOString()
  const index = input.context?.slideId ? viewed.slides.findIndex((s) => s.id === input.context!.slideId) : -1
  const user: ChatMessage = { id: `m-${randomBytes(4).toString('hex')}`, role: 'user', text: input.text.trim().slice(0, 8000), at: now(), mode: modeName, context: { ...input.context, deckId: viewed.id, slideIndex: index >= 0 ? index : undefined } }
  const reply: ChatMessage = { id: `m-${randomBytes(4).toString('hex')}`, role: 'agent', text: '', at: now(), mode: modeName, tools: [], status: 'streaming' }
  log.messages.push(user)
  await saveChat(log)
  emit({ op: 'message', message: user })
  emit({ op: 'message', message: reply })

  const repo = deckGit(deck).repo ?? homedir()
  const mode = MODES[modeName]
  const key = modeName === 'implement' ? 'implementSessionId' : 'sessionId'
  const resume = log[key]
  const sessionId = resume ?? randomUUID()
  const scope = mode.scope?.(deck, planId)
  const mcp = JSON.stringify({ mcpServers: { ferry: { command: process.execPath, args: [join(ROOT, 'bin', 'ferry.js'), 'mcp', ...(scope ? ['--scope', scope] : [])] } } })
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--strict-mcp-config',
    '--mcp-config', mcp,
    '--append-system-prompt', mode.prompt(deck, repo, planId),
    '--allowedTools', ...mode.tools,
    '--disallowedTools', ...mode.denied,
    ...(resume ? ['--resume', resume] : ['--session-id', sessionId]),
    ...(process.env.FERRY_CHAT_MODEL ? ['--model', process.env.FERRY_CHAT_MODEL] : []),
  ]
  const child = spawn(claude, args, { cwd: repo, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  const run: Run = { child, message: reply, stopped: false }
  runs.set(deckId, run)
  child.stdin!.end(input.prompt ?? `${contextNote(viewed, user.context, viewingPlan ? 'plan slide' : 'slide')}\n\n${user.text}`)

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
    if (code === 0 || run.stopped) latest[key] = sessionId
    else if (/no conversation found|session/i.test(stderr)) latest[key] = undefined
    await saveChat(latest)
    await onDone?.().catch(() => {})
    emit({ op: 'end', message: reply })
  })
  child.on('error', (error) => {
    stderr += String(error)
  })
  return user
}

/**
 * Hands what the user sent (their plan, plus any open requests) to the built-in
 * agent, for when no agent is listening with wait_for_feedback. Items it leaves
 * unresolved reopen when it finishes, so they can be sent again. Returns how many it took.
 */
export async function implement(deckId: string, emit: (event: ChatEvent) => void): Promise<number> {
  if (runs.has(deckId)) throw new Error('Claude is still answering in Chat — send the plan again when it’s done')
  const deck = await loadDeck(deckId)
  const plan = await loadPlan(deck)
  const taken = await updateFeedback(deckId, (data) => {
    const open = data.items.filter((i) => i.status === 'open')
    for (const item of open) Object.assign(item, { status: 'working', updatedAt: new Date().toISOString() })
    return open
  })
  if (!taken.length) return 0
  const ids = new Set(taken.map((i) => i.id))
  // A request the agent asked about stays "working" until the user replies.
  const reopen = () =>
    updateFeedback(deckId, (data) => {
      for (const item of data.items) if (ids.has(item.id) && item.status === 'working' && item.thread.at(-1)?.from !== 'agent') item.status = 'open'
    })
  const requests = taken.filter((i) => !i.plan).length
  const text = taken.some((i) => i.plan) ? `Implement my plan${requests ? ` and ${requests} more request${requests === 1 ? '' : 's'}` : ''}.` : `Make these ${requests} code change${requests === 1 ? '' : 's'}.`
  try {
    await sendChat(deckId, { text, prompt: changePlan(deck, taken, plan, 'Finally, sum up the code changes in one or two sentences.'), mode: 'implement' }, emit, reopen)
  } catch (error) {
    await reopen()
    throw error
  }
  return taken.length
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
