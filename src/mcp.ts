import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { join } from 'node:path'
import { z } from 'zod'
import { changedFiles, describeRange, fileAt, isNoise, resolveRange } from './git.ts'
import { lineDiff, summarizeChanges } from './diff.ts'
import { exportDeck } from './export.ts'
import { GUIDE, INSTRUCTIONS } from './guide.ts'
import { ensureServer, openInBrowser } from './server.ts'
import { DeckMetaInput, SlideInput, ThemeSchema } from './schema.ts'
import { assignId, compileInto, deleteDeck, ferryHome, listDecks, loadDeck, newDeck, saveDeck, type SourceSlide, type StoredDeck } from './store.ts'
import { stopChat } from './chat.ts'
import { changePlan, loadFeedback, setListening, updateFeedback, type FeedbackItem } from './feedback.ts'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })

type Extra = {
  signal: AbortSignal
  _meta?: { progressToken?: string | number }
  sendNotification: (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>
}

function tool<A>(fn: (args: A, extra: Extra) => Promise<string>) {
  return async (args: A, extra?: unknown): Promise<ToolResult> => {
    try {
      return text(await fn(args, extra as Extra))
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true }
    }
  }
}

async function deckUrl(deck: StoredDeck, slide?: number): Promise<string> {
  const base = await ensureServer()
  return `${base}/d/${deck.id}${slide ? `#${slide}` : ''}`
}

function outline(deck: StoredDeck): string {
  return deck.slides
    .map((slide, i) => {
      const title = slide.title ? ` "${slide.title.replace(/\*/g, '')}"` : ''
      return `${i + 1}. [${slide.id}] ${slide.type}${title} · ${slide.steps.length} step${slide.steps.length === 1 ? '' : 's'}`
    })
    .join('\n')
}

async function summary(deck: StoredDeck, warnings: string[] = [], lead = ''): Promise<string> {
  const url = await deckUrl(deck)
  const parts = [
    lead,
    `Deck "${deck.title}" (id: ${deck.id}) · ${deck.slides.length} slide${deck.slides.length === 1 ? '' : 's'} · theme ${deck.theme}`,
    `Viewer: ${url}`,
    deck.slides.length ? outline(deck) : 'No slides yet — add_slides next.',
  ]
  if (warnings.length) parts.push(`Warnings (fix these):\n${warnings.map((w) => `- ${w}`).join('\n')}`)
  return parts.filter(Boolean).join('\n\n')
}

async function insertSlides(deck: StoredDeck, inputs: SlideInput[], after?: string) {
  const sources = inputs.map((input) => assignId(deck, input))
  const { compiled, warnings } = await compileInto(deck, sources)
  let at = deck.slides.length
  if (after) {
    const i = deck.source.findIndex((s) => s.id === after)
    if (i < 0) throw new Error(`no slide "${after}" in deck ${deck.id}`)
    at = i + 1
  }
  deck.source.splice(at, 0, ...sources)
  deck.slides.splice(at, 0, ...compiled)
  return { sources, warnings }
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'ferry', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'authoring_guide',
    {
      title: 'Ferry authoring guide',
      description: 'Slide types, JSON shapes, and storytelling rules for explaining code changes. Read once before building a deck.',
      annotations: { readOnlyHint: true },
    },
    tool(async () => GUIDE),
  )

  server.registerTool(
    'inspect_changes',
    {
      title: 'Inspect git changes',
      description:
        'List changed files (status, churn) and their numbered changes (contiguous blocks of added/removed/re-indented lines) with previews. Change numbers match diff slides with a `git` source: assign them to steps with steps[].changes.',
      inputSchema: {
        repo: z.string().describe('Absolute path to the git repository.'),
        base: z.string().optional().describe('Base ref (default HEAD). A branch name compares from its merge-base, like a PR.'),
        head: z.string().optional().describe('Head ref; omit to include uncommitted working-tree changes.'),
        paths: z.array(z.string()).optional().describe('Only show hunks for these files.'),
        context: z.number().int().optional().describe('Context lines used for hunk numbering (default 3, same as diff slides).'),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ repo, base, head, paths, context }) => {
      const range = await resolveRange(repo, base, head)
      const files = await changedFiles(range)
      if (!files.length) return `No changes in ${range.label}.`
      const info = await describeRange(range)
      const lines = [`Range: ${range.label} (before = ${range.before.slice(0, 10)})${info.branch ? ` · branch ${info.branch}` : ''}`, '']
      const total = files.reduce((n, f) => [n[0] + f.additions, n[1] + f.deletions], [0, 0])
      lines.push(`${files.length} files · +${total[0]} −${total[1]}`, '')
      const detailed = (paths ?? files.filter((f) => !f.binary && !isNoise(f.path)).map((f) => f.path)).slice(0, 25)
      for (const file of files) {
        lines.push(`${file.status.padEnd(8)} ${file.path}${file.oldPath ? ` (from ${file.oldPath})` : ''}  +${file.additions} −${file.deletions}${file.binary ? ' (binary)' : ''}${isNoise(file.path) ? ' (generated/lockfile)' : ''}`)
        if (!detailed.includes(file.path) || file.binary) continue
        const before = (await fileAt(range.repo, range.before, file.oldPath ?? file.path)) ?? ''
        const after = (await fileAt(range.repo, range.after, file.path)) ?? ''
        let hunk = 0
        for (const change of summarizeChanges(lineDiff(before, after, context ?? 3))) {
          if (change.hunk !== hunk) {
            hunk = change.hunk
            lines.push(`    hunk ${hunk} (default step ${hunk})`)
          }
          const reindent = change.reindented ? ` ~${change.reindented} re-indented` : ''
          lines.push(`      change ${change.change} @ line ${change.newStart}  +${change.additions} −${change.deletions}${reindent}`)
          for (const preview of change.preview) lines.push(`          ${preview}`)
        }
      }
      return lines.join('\n')
    }),
  )

  server.registerTool(
    'create_deck',
    {
      title: 'Create deck',
      description: 'Create an empty presentation deck. Returns its id and live viewer URL. Add content with add_slides.',
      inputSchema: DeckMetaInput.shape,
    },
    tool(async (meta) => {
      const deck = newDeck(meta)
      await saveDeck(deck)
      return summary(deck, [], 'Created.')
    }),
  )

  server.registerTool(
    'add_slides',
    {
      title: 'Add slides',
      description:
        'Append slides to a deck (or insert after a slide id). Returns the outline and any warnings (unmatched callouts, unknown ids). Changes appear live in an open viewer. See authoring_guide for slide types.',
      inputSchema: {
        deck_id: z.string(),
        slides: z.array(SlideInput).min(1),
        after: z.string().optional().describe('Insert after this slide id. Default: append.'),
      },
    },
    tool(async ({ deck_id, slides, after }) => {
      const deck = await loadDeck(deck_id)
      const { sources, warnings } = await insertSlides(deck, slides, after)
      await saveDeck(deck)
      return summary(deck, warnings, `Added ${sources.map((s) => s.id).join(', ')}.`)
    }),
  )

  server.registerTool(
    'update_slide',
    {
      title: 'Update slide',
      description: 'Replace one slide with a new definition (send the complete slide). Keeps its id and position.',
      inputSchema: {
        deck_id: z.string(),
        slide_id: z.string(),
        slide: z.record(z.string(), z.unknown()).describe('The complete slide, in the same shape as an add_slides item (see authoring_guide).'),
      },
    },
    tool(async ({ deck_id, slide_id, slide: raw }) => {
      const parsed = SlideInput.safeParse(raw)
      if (!parsed.success) throw new Error(`invalid slide: ${z.prettifyError(parsed.error)}`)
      const slide = parsed.data
      const deck = await loadDeck(deck_id)
      const i = deck.source.findIndex((s) => s.id === slide_id)
      if (i < 0) throw new Error(`no slide "${slide_id}" in deck ${deck_id}. Slides: ${deck.source.map((s) => s.id).join(', ')}`)
      const source = { ...slide, id: slide_id } as SourceSlide
      const { compiled, warnings } = await compileInto(deck, [source])
      deck.source[i] = source
      deck.slides[i] = compiled[0]
      await saveDeck(deck)
      return summary(deck, warnings, `Updated ${slide_id}.`)
    }),
  )

  server.registerTool(
    'remove_slides',
    {
      title: 'Remove slides',
      description: 'Remove slides by id.',
      inputSchema: { deck_id: z.string(), slide_ids: z.array(z.string()).min(1) },
    },
    tool(async ({ deck_id, slide_ids }) => {
      const deck = await loadDeck(deck_id)
      const keep = deck.source.map((s) => !slide_ids.includes(s.id))
      deck.source = deck.source.filter((_, i) => keep[i])
      deck.slides = deck.slides.filter((_, i) => keep[i])
      await saveDeck(deck)
      return summary(deck, [], `Removed ${keep.filter((k) => !k).length} slide(s).`)
    }),
  )

  server.registerTool(
    'reorder_slides',
    {
      title: 'Reorder slides',
      description: 'Set the slide order. Ids you omit keep their relative order after the listed ones.',
      inputSchema: { deck_id: z.string(), order: z.array(z.string()).min(1) },
    },
    tool(async ({ deck_id, order }) => {
      const deck = await loadDeck(deck_id)
      const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length)
      const indices = deck.source.map((_, i) => i).sort((a, b) => rank(deck.source[a].id) - rank(deck.source[b].id) || a - b)
      deck.source = indices.map((i) => deck.source[i])
      deck.slides = indices.map((i) => deck.slides[i])
      await saveDeck(deck)
      return summary(deck, [], 'Reordered.')
    }),
  )

  server.registerTool(
    'update_deck',
    {
      title: 'Update deck',
      description: 'Change deck metadata or theme.',
      inputSchema: {
        deck_id: z.string(),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        repo: z.string().optional(),
        ref: z.string().optional(),
        theme: ThemeSchema.optional(),
      },
    },
    tool(async ({ deck_id, ...meta }) => {
      const deck = await loadDeck(deck_id)
      for (const [key, value] of Object.entries(meta)) if (value !== undefined) (deck as unknown as Record<string, unknown>)[key] = value
      await saveDeck(deck)
      return summary(deck, [], 'Updated.')
    }),
  )

  server.registerTool(
    'get_deck',
    {
      title: 'Get deck',
      description: 'Return the deck outline and the authoring JSON of its slides (or one slide), e.g. to edit with update_slide.',
      inputSchema: { deck_id: z.string(), slide_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ deck_id, slide_id }) => {
      const deck = await loadDeck(deck_id)
      const slides = slide_id ? deck.source.filter((s) => s.id === slide_id) : deck.source
      if (slide_id && !slides.length) throw new Error(`no slide "${slide_id}"`)
      return `${await summary(deck)}\n\nAuthoring JSON:\n${JSON.stringify(slides, null, 1)}`
    }),
  )

  server.registerTool(
    'list_decks',
    {
      title: 'List decks',
      description: 'List saved decks, newest first.',
      annotations: { readOnlyHint: true },
    },
    tool(async () => {
      const decks = await listDecks()
      if (!decks.length) return 'No decks yet. Use create_deck or draft_deck_from_git.'
      const base = await ensureServer()
      return decks.map((d) => `${d.id} · "${d.title}" · ${d.slideCount} slides · updated ${d.updatedAt} · ${base}/d/${d.id}`).join('\n')
    }),
  )

  server.registerTool(
    'delete_deck',
    {
      title: 'Delete deck',
      description: 'Permanently delete a deck, its change plan and its viewer chat. Only do this when the user asks: it cannot be undone.',
      inputSchema: { deck_id: z.string() },
      annotations: { destructiveHint: true },
    },
    tool(async ({ deck_id }) => {
      const deck = await loadDeck(deck_id)
      stopChat(deck_id)
      await deleteDeck(deck_id)
      return `Deleted deck "${deck.title}" (${deck_id}). Open viewers show that it is gone.`
    }),
  )

  server.registerTool(
    'draft_deck_from_git',
    {
      title: 'Draft deck from git',
      description:
        'Create a skeleton deck from a git range: title with stats, a file map, and one stepped diff slide per significant file (one step per hunk). Then refine: add narration, callouts, behavior slides, and a review checklist with update_slide/add_slides.',
      inputSchema: {
        repo: z.string().describe('Absolute path to the git repository.'),
        base: z.string().optional(),
        head: z.string().optional(),
        title: z.string().optional(),
        max_files: z.number().int().min(1).max(30).optional().describe('Diff slides to create, by churn (default 8).'),
        theme: ThemeSchema.optional(),
      },
    },
    tool(async ({ repo, base, head, title, max_files, theme }) => {
      const range = await resolveRange(repo, base, head)
      const files = await changedFiles(range)
      if (!files.length) throw new Error(`no changes in ${range.label}`)
      const info = await describeRange(range)
      const name = repo.split('/').filter(Boolean).pop()!
      const deck = newDeck({ title: title ?? info.subject ?? `Changes on ${info.branch ?? name}`, repo: name, ref: info.branch, theme })
      const git = { repo, base, head }
      const meta: Record<string, string> = {}
      if (info.branch) meta.Branch = info.branch
      if (info.author) meta.Author = info.author
      meta.Range = range.label
      const significant = files
        .filter((f) => !f.binary && !isNoise(f.path) && f.status !== 'deleted')
        .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
        .slice(0, max_files ?? 8)
      const inputs: SlideInput[] = [
        { type: 'title', title: deck.title, meta, git },
        { type: 'files', title: 'What changed', git },
        ...significant.map(
          (file, i): SlideInput => ({
            type: 'diff',
            kicker: `${i + 1} of ${significant.length} · ${file.path}`,
            title: file.path.split('/').pop()!,
            git: { repo, path: file.path, base, head },
          }),
        ),
      ]
      const { warnings } = await insertSlides(deck, inputs)
      await saveDeck(deck)
      return summary(
        deck,
        warnings,
        'Drafted. Next: give each diff slide a claim-style title, an intro note, and steps with notes/callouts (update_slide with the same git source); add points/sequence/flow slides for the story.',
      )
    }),
  )

  server.registerTool(
    'open_deck',
    {
      title: 'Open deck',
      description: "Open the deck in the user's browser (live: later edits appear immediately). Returns the URL.",
      inputSchema: {
        deck_id: z.string(),
        slide: z.number().int().min(1).optional().describe('1-based slide number to open at.'),
        launch: z.boolean().optional().describe('Open a browser window (default true). False just returns the URL.'),
      },
    },
    tool(async ({ deck_id, slide, launch }) => {
      const deck = await loadDeck(deck_id)
      const url = await deckUrl(deck, slide)
      if (launch !== false) openInBrowser(url)
      return `${launch !== false ? 'Opened' : 'Viewer'}: ${url}\nKeys: → next step · ← back · ↑↓ slides · C feedback · O overview · N notes · V voice · T theme\nTo review together, call wait_for_feedback: the user comments in the viewer and sends you a change plan.`
    }),
  )

  server.registerTool(
    'export_deck',
    {
      title: 'Export deck',
      description: 'Write the deck as one self-contained HTML file (viewer, fonts, and code inlined) to share or attach to a PR.',
      inputSchema: {
        deck_id: z.string(),
        path: z.string().optional().describe('Absolute output path. Default ~/.ferry/exports/<id>.html'),
      },
    },
    tool(async ({ deck_id, path }) => {
      const deck = await loadDeck(deck_id)
      const result = await exportDeck(deck, path ?? join(ferryHome(), 'exports', `${deck.id}.html`))
      return `Exported ${result.path} (${Math.round(result.bytes / 1024)} KB). It opens offline in any browser.`
    }),
  )

  // ── feedback loop ──────────────────────────────────────────────────────

  /** Marks pending items as picked up and returns the change plan. */
  async function claim(deck: StoredDeck): Promise<{ plan: string; count: number }> {
    const items = await updateFeedback(deck.id, (data) => {
      const now = new Date().toISOString()
      const pending = data.items.filter((i) => i.status === 'open' || i.status === 'working')
      for (const item of pending) Object.assign(item, { status: 'working', updatedAt: now })
      return pending.map((i) => ({ ...i }))
    })
    return { plan: changePlan(deck, items), count: items.length }
  }

  server.registerTool(
    'wait_for_feedback',
    {
      title: 'Wait for feedback',
      description:
        "Wait until the user sends a change plan from the viewer's feedback panel (C key), then return it: each request with its slide, step, pinned element, and the slide's authoring JSON. Returns at once if requests are already pending. The viewer shows the user that you are listening. Apply the requests, resolve_feedback, then call this again to keep reviewing together.",
      inputSchema: {
        deck_id: z.string(),
        timeout_seconds: z.number().int().min(5).max(3600).optional().describe('How long to wait (default 300). On timeout, tell the user how to send feedback, or wait again.'),
      },
    },
    tool(async ({ deck_id, timeout_seconds }, extra) => {
      const deck = await loadDeck(deck_id)
      const pendingNow = (await loadFeedback(deck_id)).items.some((i) => i.status === 'open' || i.status === 'working')
      if (!pendingNow) {
        const deadline = Date.now() + (timeout_seconds ?? 300) * 1000
        const url = await deckUrl(deck)
        const token = extra?._meta?.progressToken
        let ticks = 0
        await setListening(deck_id, true)
        try {
          for (;;) {
            if (extra?.signal?.aborted) throw new Error('cancelled')
            const data = await loadFeedback(deck_id)
            if (data.items.some((i) => i.status === 'open')) break
            if (Date.now() > deadline) {
              return `No feedback yet (waited ${timeout_seconds ?? 300}s). The user can open ${url}, press C, comment on any slide and press "Send to agent". Call wait_for_feedback again to keep listening, or get_feedback later.`
            }
            await new Promise((resolve) => setTimeout(resolve, 700))
            if (++ticks % 3 === 0) {
              await setListening(deck_id, true)
              if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ticks, message: 'Waiting for feedback from the viewer…' } }).catch(() => {})
            }
          }
        } finally {
          await setListening(deck_id, false)
        }
      }
      return (await claim(await loadDeck(deck_id))).plan
    }),
  )

  server.registerTool(
    'get_feedback',
    {
      title: 'Get feedback',
      description: 'Return pending change requests left in the viewer (without waiting) and mark them as being worked on. Use when the user says they left feedback.',
      inputSchema: { deck_id: z.string() },
    },
    tool(async ({ deck_id }) => (await claim(await loadDeck(deck_id))).plan),
  )

  server.registerTool(
    'resolve_feedback',
    {
      title: 'Resolve feedback',
      description: 'Close change requests after applying them. Each reply appears in the viewer chat next to the request.',
      inputSchema: {
        deck_id: z.string(),
        items: z
          .array(
            z.object({
              id: z.string().describe('Feedback id, e.g. fb-3a9c1e.'),
              status: z.enum(['done', 'declined']).optional().describe('done (default) or declined.'),
              reply: z.string().describe('One or two sentences: what changed, or why not.'),
            }),
          )
          .min(1),
      },
    },
    tool(async ({ deck_id, items }) => {
      const missing: string[] = []
      await updateFeedback(deck_id, (data) => {
        const now = new Date().toISOString()
        for (const update of items) {
          const item = data.items.find((i) => i.id === update.id)
          if (!item) {
            missing.push(update.id)
            continue
          }
          item.status = update.status ?? 'done'
          item.thread.push({ from: 'agent', text: update.reply, at: now })
          item.updatedAt = now
        }
      })
      const left = (await loadFeedback(deck_id)).items.filter((i: FeedbackItem) => i.status === 'open' || i.status === 'working').length
      return [`Resolved ${items.length - missing.length} item(s).`, missing.length ? `Unknown ids: ${missing.join(', ')}` : '', left ? `${left} request(s) still pending — get_feedback to see them.` : 'Nothing pending. Call wait_for_feedback to keep reviewing with the user.'].filter(Boolean).join('\n')
    }),
  )

  server.registerTool(
    'reply_feedback',
    {
      title: 'Reply in feedback chat',
      description: 'Post a message in the viewer chat without closing anything: ask a clarifying question about a request (by id), or say something about the whole deck (no id). The user answers in the viewer; wait_for_feedback returns their answer.',
      inputSchema: {
        deck_id: z.string(),
        id: z.string().optional().describe('Feedback id to answer; omit for a deck-wide message.'),
        text: z.string(),
      },
    },
    tool(async ({ deck_id, id, text: message }) => {
      await updateFeedback(deck_id, (data) => {
        const now = new Date().toISOString()
        let item = id ? data.items.find((i) => i.id === id) : undefined
        if (id && !item) throw new Error(`no feedback ${id}`)
        if (!item) {
          // A deck-wide agent message: a thread without a user request.
          item = { id: `fb-${Math.random().toString(16).slice(2, 8)}`, status: 'done', createdAt: now, updatedAt: now, text: '', thread: [] }
          data.items.push(item)
        } else item.status = 'working' // awaiting the user's answer; their reply reopens it
        item.thread.push({ from: 'agent', text: message, at: now })
        item.updatedAt = now
      })
      return 'Posted. Call wait_for_feedback to receive the answer.'
    }),
  )

  server.registerResource('guide', 'ferry://guide', { title: 'Ferry authoring guide', mimeType: 'text/markdown' }, async (uri) => ({
    contents: [{ uri: uri.href, text: GUIDE, mimeType: 'text/markdown' }],
  }))

  server.registerPrompt(
    'explain_changes',
    {
      title: 'Explain code changes',
      description: 'Build a narrated Ferry presentation that explains a set of code changes.',
      argsSchema: {
        repo: z.string().describe('Absolute repository path'),
        base: z.string().optional().describe('Base ref, e.g. main'),
        head: z.string().optional().describe('Head ref; empty for the working tree'),
        audience: z.string().optional().describe('Who will watch, e.g. "reviewers", "the team", "product"'),
      },
    },
    ({ repo, base, head, audience }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Build a Ferry presentation explaining the changes in ${repo} (${base ?? 'HEAD'} → ${head ?? 'working tree'}) for ${audience ?? 'code reviewers'}.

1. Call authoring_guide, then inspect_changes. Read the changed code until you understand the intent, not just the lines.
2. Decide the story: the problem, the 2–5 key changes, and what reviewers must check.
3. create_deck, then add_slides: title (with git stats) → points overview → for each key change a sequence or flow slide showing behavior before/after, then a diff slide with one idea per step, notes, focus, and callouts → metrics if any → a checklist of review focus, risks, and tests.
4. Fix all warnings, then open_deck and tell the user the URL and the keys (→ ← ↑ ↓, O overview, C feedback).
5. Review together: call wait_for_feedback, apply each change plan the user sends from the viewer, resolve_feedback with short replies, and wait again until they are done.`,
          },
        },
      ],
    }),
  )

  return server
}
