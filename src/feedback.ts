// Feedback: change requests people leave in the viewer, picked up by agents.
// Stored beside decks so any Ferry process (viewer server or MCP) can read and
// write it; a heartbeat file says whether an agent is waiting right now.
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { deckGit, ferryHome, type StoredDeck } from './store.ts'

export type FeedbackStatus = 'draft' | 'open' | 'working' | 'done' | 'declined'

export interface FeedbackTarget {
  /** What was pinned: code line, node, row, point, callout, text… */
  kind: string
  label: string
}

export interface FeedbackMessage {
  from: 'user' | 'agent'
  text: string
  at: string
}

export interface FeedbackItem {
  id: string
  status: FeedbackStatus
  createdAt: string
  updatedAt: string
  /** Absent for deck-wide requests. */
  slideId?: string
  /** 0-based step the viewer was on. */
  step?: number
  target?: FeedbackTarget
  /** Set when the user sent their plan deck: implement it. */
  plan?: { id: string; revision: number }
  text: string
  thread: FeedbackMessage[]
}

export interface FeedbackFile {
  deckId: string
  items: FeedbackItem[]
}

export const feedbackDir = () => join(ferryHome(), 'feedback')
const file = (deckId: string) => {
  if (!/^[a-z0-9-]+$/.test(deckId)) throw new Error(`invalid deck id "${deckId}"`)
  return join(feedbackDir(), `${deckId}.json`)
}
const beacon = (deckId: string) => join(feedbackDir(), `${deckId}.listening`)

export async function loadFeedback(deckId: string): Promise<FeedbackFile> {
  try {
    return JSON.parse(await readFile(file(deckId), 'utf8'))
  } catch {
    return { deckId, items: [] }
  }
}

export async function saveFeedback(data: FeedbackFile): Promise<void> {
  await mkdir(feedbackDir(), { recursive: true })
  const path = file(data.deckId)
  const temp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  await writeFile(temp, JSON.stringify(data, null, 1))
  await rename(temp, path)
}

/** Cross-process lock: the viewer server and MCP processes both write feedback. */
async function withLock<T>(deckId: string, run: () => Promise<T>): Promise<T> {
  await mkdir(feedbackDir(), { recursive: true })
  const lock = join(feedbackDir(), `${deckId}.lock`)
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock)
      break
    } catch {
      const info = await stat(lock).catch(() => null)
      if (info && Date.now() - info.mtimeMs > 5000) await rm(lock, { recursive: true, force: true })
      else if (attempt > 200) throw new Error('feedback store is busy')
      else await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  try {
    return await run()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

export function updateFeedback<T>(deckId: string, change: (data: FeedbackFile) => T): Promise<T> {
  return withLock(deckId, async () => {
    const data = await loadFeedback(deckId)
    const result = change(data)
    await saveFeedback(data)
    return result
  })
}

export function newItem(fields: Pick<FeedbackItem, 'text' | 'slideId' | 'step' | 'target' | 'plan'> & { status?: FeedbackStatus }): FeedbackItem {
  const now = new Date().toISOString()
  return {
    id: `fb-${randomBytes(3).toString('hex')}`,
    status: fields.status ?? 'draft',
    createdAt: now,
    updatedAt: now,
    slideId: fields.slideId,
    step: fields.step,
    target: fields.target,
    plan: fields.plan,
    text: fields.text.trim().slice(0, 4000),
    thread: [],
  }
}

// ── agent presence ────────────────────────────────────────────────────────

export async function setListening(deckId: string, on: boolean): Promise<void> {
  await mkdir(feedbackDir(), { recursive: true })
  if (on) await writeFile(beacon(deckId), String(Date.now()))
  else await rm(beacon(deckId), { force: true })
}

export async function isListening(deckId: string): Promise<boolean> {
  const info = await stat(beacon(deckId)).catch(() => null)
  return !!info && Date.now() - info.mtimeMs < 8000
}

// ── agent-facing change plan: code changes requested while reviewing ──────

export const pending = (item: FeedbackItem) => item.status === 'open' || item.status === 'working'

export function describeItem(deck: StoredDeck, item: FeedbackItem, n: number): string {
  const lines: string[] = []
  const index = item.slideId ? deck.slides.findIndex((s) => s.id === item.slideId) : -1
  if (!item.slideId) lines.push(`${n}. [${item.id}] Deck-wide`)
  else if (index < 0) lines.push(`${n}. [${item.id}] Slide "${item.slideId}" (no longer in the deck)`)
  else {
    const slide = deck.slides[index]
    const step = item.step ?? 0
    const stepTitle = slide.steps[step]?.title
    const title = slide.title ? ` "${slide.title.replace(/\*/g, '')}"` : ''
    lines.push(`${n}. [${item.id}] Slide ${index + 1}${title} (${slide.type}, id ${slide.id}), step ${step + 1}/${slide.steps.length}${stepTitle ? ` "${stepTitle}"` : ''}`)
  }
  if (item.target) lines.push(`   Pinned to ${item.target.kind}: ${item.target.label}`)
  lines.push(`   Request: ${item.text}`)
  for (const message of item.thread) lines.push(`   ${message.from === 'agent' ? 'You replied' : 'User replied'}: ${message.text}`)
  return lines.join('\n')
}

export function changePlan(deck: StoredDeck, items: FeedbackItem[], plan?: StoredDeck, then = 'Finally call wait_for_feedback again to keep reviewing with the user.'): string {
  const list = items.filter(pending)
  if (!list.length) return `No pending feedback on deck "${deck.title}" (${deck.id}).`
  const planItem = plan?.slides.length ? list.find((i) => i.plan) : undefined
  const requests = list.filter((i) => !i.plan)
  const slideIds = [...new Set(requests.map((i) => i.slideId).filter(Boolean))] as string[]
  const sources = slideIds.flatMap((id) => {
    const source = deck.source.find((s) => s.id === id)
    return source ? [`[${id}]\n${JSON.stringify(source)}`] : []
  })
  const { repo, base, head } = deckGit(deck)
  const range = base || head ? `${base ?? 'HEAD'} → ${head ?? 'working tree'}` : 'its changes'
  const branch = head ? ` Check that ${head} is checked out first; if it isn't, ask with reply_feedback before editing.` : ''
  const outline = plan?.slides.map((s, i) => `${i + 1}. ${s.type}${s.title ? ` "${s.title.replace(/\*/g, '')}"` : ''}`).join('\n')
  return [
    `Code changes requested from the Ferry viewer while reviewing deck "${deck.title}" (${deck.id}). The deck explains ${range} in ${repo ?? 'the repository it was built from'}. Make these changes in that codebase, not in the slides.`,
    planItem && plan
      ? `[${planItem.id}] Implement the plan the user built and approved: deck "${plan.title}" (${plan.id}), ${plan.slides.length} slides.\n${outline}\n\nPlan slides (authoring JSON; hand-written diffs show the intended code):\n${plan.source.map((s) => JSON.stringify(s)).join('\n')}`
      : '',
    requests.length ? `Requests:\n${requests.map((item, i) => describeItem(deck, item, i + 1)).join('\n\n')}` : '',
    sources.length ? `Authoring JSON of the slides the requests point at (use it to find the code):\n${sources.join('\n\n')}` : '',
    `Next: make the changes in the code${planItem ? ' as the plan describes, adapting its diffs to the real code where needed' : ''}, on the checked-out branch, without committing.${branch} Don't edit the slides. Then call resolve_feedback with a reply per item — "done" with what changed (which files), or "declined" with why. Ask with reply_feedback if something is unclear. ${then}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
