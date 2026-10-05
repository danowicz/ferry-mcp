// Normalizes authoring input into the render model: assigns identities,
// resolves git sources, highlights code, and decides every slide's steps.
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { changedFiles, fileAt, isNoise, resolveRange } from './git.ts'
import { condense, lineDiff, type Entry } from './diff.ts'
import { detab, highlight, languageFor, PaletteBuilder } from './highlight.ts'
import type {
  Callout,
  CompareSlide,
  DiffLine,
  DiffSlide,
  DiffStep,
  FilesSlide,
  FlowSlide,
  MarkdownSlide,
  MetricsSlide,
  Pane,
  PointsSlide,
  SectionSlide,
  SequenceSlide,
  Slide,
  Step,
  TitleSlide,
  Tone,
} from './model.ts'
import type { SlideInput } from './schema.ts'
import { escapeHtml, inline, markdown, plain } from './text.ts'

export interface Compiled {
  slide: Slide
  warnings: string[]
}

export interface CompileContext {
  /** 1-based chapter number for auto-numbered sections. */
  section: number
}

type Input<T extends SlideInput['type']> = Extract<SlideInput, { type: T }>

export async function compileSlide(input: SlideInput & { id: string }, ctx: CompileContext): Promise<Compiled> {
  const warnings: string[] = []
  const warn = (message: string) => warnings.push(`slide "${input.id}": ${message}`)
  let slide: Slide
  switch (input.type) {
    case 'title':
      slide = await compileTitle(input)
      break
    case 'section':
      slide = compileSection(input, ctx)
      break
    case 'points':
      slide = compilePoints(input)
      break
    case 'files':
      slide = await compileFiles(input, warn)
      break
    case 'diff':
      slide = await compileDiff(input, warn)
      break
    case 'sequence':
      slide = compileSequence(input, warn)
      break
    case 'flow':
      slide = compileFlow(input, warn)
      break
    case 'metrics':
      slide = compileMetrics(input)
      break
    case 'compare':
      slide = await compileCompare(input, warn)
      break
    case 'markdown':
      slide = compileMarkdown(input)
      break
  }
  if (!slide.steps.length) slide.steps = [{}]
  if (input.notes && !slide.steps[0].say) slide.steps[0].say = input.notes
  return { slide, warnings }
}

function base(input: SlideInput & { id: string }) {
  return { id: input.id, kicker: input.kicker, title: input.title, titleHtml: inline(input.title), notes: input.notes }
}

function step(title?: string, note?: string, extra?: string): Step {
  const say = [plain(note), plain(extra)].filter(Boolean).join(' ') || undefined
  return { title, titleHtml: inline(title), noteHtml: markdown(note), say }
}

// ── title / section ───────────────────────────────────────────────────────

async function compileTitle(input: Input<'title'> & { id: string }): Promise<TitleSlide> {
  let stats = input.stats
  if (input.git && !stats) {
    const range = await resolveRange(input.git.repo, input.git.base, input.git.head)
    const files = await changedFiles(range)
    stats = {
      files: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    }
  }
  return {
    ...base(input),
    type: 'title',
    subtitleHtml: inline(input.subtitle),
    meta: Object.entries(input.meta ?? {}).map(([label, value]) => ({ label, value })),
    stats,
    steps: [{ say: plain([input.title.replace(/\*/g, ''), input.subtitle].filter(Boolean).join('. ')) }],
  }
}

function compileSection(input: Input<'section'> & { id: string }, ctx: CompileContext): SectionSlide {
  return {
    ...base(input),
    type: 'section',
    number: input.number ?? String(ctx.section).padStart(2, '0'),
    subtitleHtml: inline(input.subtitle),
    steps: [{ say: plain([input.title.replace(/\*/g, ''), input.subtitle].filter(Boolean).join('. ')) }],
  }
}

// ── points ────────────────────────────────────────────────────────────────

const TAG_TONES: Record<string, Tone> = {
  feat: 'accent', feature: 'accent', fix: 'success', bugfix: 'success', perf: 'info', performance: 'info',
  refactor: 'plain', test: 'info', tests: 'info', docs: 'muted', breaking: 'error', security: 'warning',
  chore: 'muted', risk: 'warning', deprecation: 'warning',
}

function compilePoints(input: Input<'points'> & { id: string }): PointsSlide {
  const reveal = input.reveal ?? 'stepwise'
  const points = input.points.map((p) => ({
    titleHtml: inline(p.title)!,
    bodyHtml: inline(p.body),
    tag: p.tag,
    tone: p.tone ?? TAG_TONES[p.tag?.toLowerCase() ?? ''] ?? 'accent',
  }))
  const steps =
    reveal === 'stepwise'
      ? input.points.map((p) => ({ say: plain([p.title, p.body].filter(Boolean).join('. ')) }))
      : [{ say: plain(input.points.map((p) => p.title).join('. ')) }]
  return { ...base(input), type: 'points', layout: input.layout ?? 'cards', reveal, points, steps }
}

// ── files ─────────────────────────────────────────────────────────────────

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*').replace(/\?/g, '.')
  return new RegExp(`(^|/)${escaped}$`)
}

export function pathMatches(path: string, pattern: string): boolean {
  if (pattern.includes('*') || pattern.includes('?')) return globToRegExp(pattern).test(path)
  return path === pattern || path.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`) || path.endsWith(`/${pattern}`)
}

async function compileFiles(input: Input<'files'> & { id: string }, warn: (m: string) => void): Promise<FilesSlide> {
  let files: FilesSlide['files'] = (input.files ?? []).map((f) => ({
    path: f.path,
    oldPath: f.oldPath,
    status: f.status ?? 'modified',
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    noteHtml: inline(f.note),
  }))
  if (input.git) {
    const range = await resolveRange(input.git.repo, input.git.base, input.git.head)
    const notes = new Map(files.map((f) => [f.path, f]))
    files = (await changedFiles(range)).map((f) => ({ ...f, noteHtml: notes.get(f.path)?.noteHtml }))
    if (!files.length) warn(`no changed files in ${range.label}`)
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const groups = input.groups ?? []
  const highlights = groups.map((group) => {
    const hits = files.flatMap((f, i) => (group.paths.some((p) => pathMatches(f.path, p)) ? [i] : []))
    if (!hits.length) warn(`group "${group.title}" matches no files`)
    return hits
  })
  const steps = groups.length ? groups.map((g) => step(g.title, g.note)) : [{}]
  return { ...base(input), type: 'files', files, highlights: groups.length ? highlights : [[]], steps }
}

// ── diff ──────────────────────────────────────────────────────────────────

type CodeRef = string | number | [number, number]

async function compileDiff(input: Input<'diff'> & { id: string }, warn: (m: string) => void): Promise<DiffSlide> {
  const sources = [input.git, input.after !== undefined || input.before !== undefined, input.lines, input.code !== undefined].filter(Boolean).length
  if (sources !== 1) throw new Error(`diff slide "${input.id}" needs exactly one source: git, before+after, lines, or code`)

  const file = input.file ?? input.git?.path
  const language = languageFor(file, input.language)
  const palette = new PaletteBuilder()
  const context = input.context ?? 3
  const stepInputs = input.steps ?? []

  let entries: Entry[]
  let beforeTokens: Awaited<ReturnType<typeof highlight>> = []
  let afterTokens: Awaited<ReturnType<typeof highlight>> = []
  /** Explicit per-line steps (lines mode). */
  const explicit = new Map<Entry, number>()

  if (input.lines) {
    let oldNo = 1
    let newNo = 1
    entries = input.lines.map((line) => {
      const op = line.op ?? 'keep'
      const text = detab(line.text)
      const entry: Entry = op === 'add' ? { op, text, newNo: newNo++ } : op === 'remove' ? { op, text, oldNo: oldNo++ } : { op, text, oldNo: oldNo++, newNo: newNo++ }
      if (op !== 'keep') explicit.set(entry, line.step ?? 1)
      return entry
    })
    const tokens = await highlight(entries.map((e) => e.text).join('\n'), language, palette)
    entries.forEach((entry, i) => ((entry as Entry & { tokens?: unknown }).tokens = tokens[i]))
  } else if (input.code !== undefined) {
    const tokens = await highlight(input.code, language, palette)
    entries = detab(input.code)
      .replace(/\n$/, '')
      .split('\n')
      .map((text, i) => ({ op: 'keep' as const, text, oldNo: i + 1, newNo: i + 1, tokens: tokens[i] }))
  } else {
    let before = input.before ?? ''
    let after = input.after ?? ''
    if (input.git) {
      const range = await resolveRange(input.git.repo, input.git.base, input.git.head)
      before = (await fileAt(range.repo, range.before, input.git.path)) ?? ''
      after = (await fileAt(range.repo, range.after, input.git.path)) ?? ''
      if (before === after) warn(`${input.git.path} has no changes in ${range.label}`)
    }
    before = detab(before)
    after = detab(after)
    entries = lineDiff(before, after, context)
    beforeTokens = await highlight(before, language, palette)
    afterTokens = await highlight(after, language, palette)
  }

  // Changes → steps. Explicit steps[].changes win; otherwise each git-style
  // hunk is one step (clamped to the steps the author wrote).
  const changeCount = entries.reduce((n, e) => Math.max(n, e.change ?? 0), 0)
  const hunkOf = new Map(entries.filter((e) => e.change).map((e) => [e.change!, e.hunk!]))
  const changeStep = new Map<number, number>()
  stepInputs.forEach((s, i) =>
    s.changes?.forEach((c) => {
      if (c > changeCount) warn(`step ${i + 1} lists change ${c}, but ${file ?? 'the code'} has ${changeCount} change${changeCount === 1 ? '' : 's'} (see inspect_changes)`)
      else changeStep.set(c, i + 1)
    }),
  )
  const assigned = changeStep.size > 0
  for (let c = 1; c <= changeCount; c++) {
    if (changeStep.has(c)) continue
    const step = stepInputs.length ? Math.min(hunkOf.get(c)!, stepInputs.length) : hunkOf.get(c)!
    if (assigned) warn(`change ${c} is not listed in any step; it is applied in step ${step}`)
    changeStep.set(c, step)
  }
  const stepOf = (entry: Entry) => explicit.get(entry) ?? (entry.change ? changeStep.get(entry.change)! : 0)
  const changeSteps = Math.max(stepInputs.length, 0, ...entries.map(stepOf))

  const toLine = (entry: Entry, id: string): DiffLine => ({
    id,
    kind: 'code',
    op: entry.op,
    step: stepOf(entry),
    tokens:
      (entry as Entry & { tokens?: DiffLine['tokens'] }).tokens ??
      (entry.op === 'remove' ? beforeTokens[entry.oldNo! - 1] : afterTokens[entry.newNo! - 1]) ??
      [[entry.text, palette.add('')]],
    text: entry.text,
    oldNo: entry.oldNo,
    newNo: entry.newNo,
    change: entry.change,
    shift: entry.shift,
  })

  // Lines that steps point at stay unfolded, even far from any change.
  const pinned = new Set<Entry>()
  if (!input.lines && input.code === undefined) {
    const full = entries.map((entry, i) => toLine(entry, `e${i}`))
    const fullVisible = (line: DiffLine, k: number) =>
      line.op === 'keep' || (line.op === 'add' ? k >= line.step : (input.mode ?? 'morph') === 'review' ? k <= line.step : k < line.step)
    stepInputs.forEach((s, i) => {
      for (const ref of [...(s.focus ?? []), ...(s.callouts ?? []).map((c) => c.at)])
        for (const hit of resolveRef(full, ref, i + 1, fullVisible)) pinned.add(entries[Number(hit.line.id.slice(1))])
    })
  }
  const display = input.lines || input.code !== undefined ? entries : condense(entries, context, pinned)
  const lines: DiffLine[] = display.map((entry, i) =>
    'fold' in entry
      ? { id: `f${i}`, kind: 'fold', op: 'keep', step: 0, tokens: [[`${entry.fold} unchanged line${entry.fold === 1 ? '' : 's'}`, palette.add('')]], text: '' }
      : toLine(entry, `l${i}`),
  )

  const mode = input.mode ?? 'morph'
  const visible = (line: DiffLine, k: number) =>
    line.op === 'keep' || (line.op === 'add' ? k >= line.step : mode === 'review' ? k <= line.step : k < line.step)

  const steps: DiffStep[] = []
  const intro = input.intro
  const hasChanges = lines.some((l) => l.op !== 'keep')
  steps.push({
    ...step(intro?.title ?? (hasChanges ? 'Before' : undefined), intro?.note),
    focus: [],
    callouts: [],
    additions: 0,
    deletions: 0,
  })
  for (let k = 1; k <= changeSteps; k++) {
    const s = stepInputs[k - 1]
    const changed = lines.filter((l) => l.step === k && l.op !== 'keep')
    const resolve = (ref: CodeRef, purpose: string) => {
      const found = resolveRef(lines, ref, k, visible)
      if (!found.length) warn(`step ${k}: ${purpose} ${JSON.stringify(ref)} matches no visible line`)
      return found
    }
    const focus = (s?.focus ?? []).flatMap((ref) => resolve(ref, 'focus').map((hit) => hit.line.id))
    const callouts: Callout[] = (s?.callouts ?? []).flatMap((c) => {
      const hit = resolve(c.at, 'callout')[0]
      return hit ? [{ lineId: hit.line.id, start: hit.start, end: hit.end, text: c.text, tone: c.tone ?? 'accent' }] : []
    })
    steps.push({
      ...step(s?.title, s?.note),
      focus: [...new Set(focus)],
      callouts,
      additions: changed.filter((l) => l.op === 'add').length,
      deletions: changed.filter((l) => l.op === 'remove').length,
    })
  }
  if (mode === 'review' && lines.some((l) => l.op === 'remove' && l.step === changeSteps)) {
    steps.push({ ...step('Result', undefined), focus: [], callouts: [], additions: 0, deletions: 0 })
  }
  // Line numbers as they read at each step: lines present in the file at
  // step k are numbered in order (folded lines included, struck lines not).
  const present = (entry: Entry, k: number) => {
    const at = stepOf(entry)
    return entry.op === 'keep' || (entry.op === 'add' ? k >= at : k < at)
  }
  const numbers = new Map<Entry, number[]>()
  for (let k = 0; k < steps.length; k++) {
    let n = 0
    for (const entry of entries) {
      if (!present(entry, k)) continue
      n++
      let list = numbers.get(entry)
      if (!list) numbers.set(entry, (list = new Array(steps.length).fill(0)))
      list[k] = n
    }
  }
  display.forEach((entry, i) => {
    if (!('fold' in entry)) lines[i].nos = numbers.get(entry) ?? new Array(steps.length).fill(0)
  })

  if (lines.length > 400) warn(`${lines.length} lines on one slide; lower \`context\` or split the change across slides`)

  return {
    ...base(input),
    type: 'diff',
    file,
    language,
    mode,
    palette: palette.palette,
    lines,
    steps,
    additions: lines.filter((l) => l.op === 'add').length,
    deletions: lines.filter((l) => l.op === 'remove').length,
  }
}

function resolveRef(
  lines: DiffLine[],
  ref: CodeRef,
  k: number,
  visible: (line: DiffLine, k: number) => boolean,
): { line: DiffLine; start: number; end: number }[] {
  const code = lines.filter((l) => l.kind === 'code')
  const whole = (line: DiffLine) => ({ line, start: line.text.length - line.text.trimStart().length, end: line.text.length })
  if (typeof ref === 'string') {
    const hits = code.filter((l) => l.text.includes(ref))
    const rank = (l: DiffLine) => (visible(l, k) ? 0 : 2) + (l.step === k ? 0 : 1)
    const best = hits.sort((a, b) => rank(a) - rank(b))[0]
    if (!best || !visible(best, k)) return []
    const start = best.text.indexOf(ref)
    return [{ line: best, start, end: start + ref.length }]
  }
  const [from, to] = typeof ref === 'number' ? [ref, ref] : ref
  const hits = code.filter((l) => l.newNo !== undefined && l.newNo >= from && l.newNo <= to && visible(l, k) && l.op !== 'remove')
  if (hits.length) return hits.map(whole)
  return code.filter((l) => l.op === 'remove' && l.oldNo! >= from && l.oldNo! <= to && visible(l, k)).map(whole)
}

// ── sequence ──────────────────────────────────────────────────────────────

function phaseTone(title: string): Tone {
  if (/before|bug|broken|old|current|problem|today/i.test(title)) return 'error'
  if (/after|fix|new|now|solution|proposed/i.test(title)) return 'success'
  return 'accent'
}

function compileSequence(input: Input<'sequence'> & { id: string }, warn: (m: string) => void): SequenceSlide {
  const index = new Map(input.participants.map((p, i) => [p.id, i]))
  const phasesIn = input.phases ?? (input.rows ? [{ title: '', rows: input.rows }] : [])
  if (!phasesIn.length) throw new Error(`sequence slide "${input.id}" needs rows or phases`)
  const rows: SequenceSlide['rows'] = []
  const steps: Step[] = []
  const stepPhase: number[] = []
  let slot = 0
  let maxSlot = 0

  phasesIn.forEach((phase, p) => {
    const replace = p > 0 && ('replace' in phase ? phase.replace !== false : true)
    if (replace) {
      for (const row of rows) if (row.exit === undefined) row.exit = steps.length
      slot = 0
    }
    phase.rows.forEach((row, r) => {
      const from = index.get(row.from)
      const to = index.get(row.to)
      if (from === undefined || to === undefined) {
        warn(`row "${row.label}" references unknown participant ${from === undefined ? row.from : row.to}`)
        return
      }
      const joinPrevious = row.with_previous && r > 0 && steps.length > 0
      if (!joinPrevious) {
        const note = [r === 0 ? 'note' in phase ? phase.note : undefined : undefined, row.caption].filter(Boolean).join('\n\n')
        steps.push(step(phase.title || undefined, note || undefined, note ? undefined : row.label))
        stepPhase.push(p)
      } else if (row.caption) {
        const last = steps[steps.length - 1]
        last.noteHtml = [last.noteHtml, markdown(row.caption)].filter(Boolean).join('')
        last.say = [last.say, plain(row.caption)].filter(Boolean).join(' ')
      }
      rows.push({
        id: `r${rows.length}`,
        from,
        to,
        labelHtml: inline(row.label)!,
        asideHtml: row.aside ? escapeHtml(row.aside) : undefined,
        kind: row.kind ?? 'message',
        tone: row.tone ?? (row.kind === 'reply' ? 'muted' : 'plain'),
        slot,
        enter: steps.length - 1,
        phase: p,
      })
      maxSlot = Math.max(maxSlot, slot)
      slot++
    })
  })

  return {
    ...base(input),
    type: 'sequence',
    participants: input.participants,
    phases: phasesIn.map((p) => ({ title: p.title, tone: ('tone' in p && p.tone) || phaseTone(p.title) })),
    stepPhase,
    rows,
    slots: maxSlot + 1,
    steps,
  }
}

// ── flow ──────────────────────────────────────────────────────────────────

function compileFlow(input: Input<'flow'> & { id: string }, warn: (m: string) => void): FlowSlide {
  const stepsIn = input.steps?.length ? input.steps : [{}]
  const n = stepsIn.length
  const ids = new Set(input.nodes.map((node) => node.id))
  const edgesIn = (input.edges ?? []).filter((e) => {
    const ok = ids.has(e.from) && ids.has(e.to)
    if (!ok) warn(`edge ${e.from}->${e.to} references an unknown node`)
    return ok
  })

  // Placement: explicit [col, row], else the next free cell left to right.
  const anyPlaced = input.nodes.some((node) => node.at)
  const width = anyPlaced ? Math.max(1, ...input.nodes.map((node) => Math.floor(node.at?.[0] ?? 0) + 1)) : input.nodes.length
  const taken = new Set(input.nodes.filter((node) => node.at).map((node) => `${node.at![0]},${node.at![1]}`))
  let cursor = 0
  const place = () => {
    for (;;) {
      const col = cursor % width
      const row = Math.floor(cursor / width)
      cursor++
      if (!taken.has(`${col},${row}`)) {
        taken.add(`${col},${row}`)
        return [col, row] as const
      }
    }
  }

  const appear = new Map<string, number>()
  const leave = new Map<string, number>()
  stepsIn.forEach((s, i) => {
    for (const ref of (s as { show?: string[] }).show ?? []) if (!appear.has(ref)) appear.set(ref, i)
    for (const ref of (s as { hide?: string[] }).hide ?? []) if (!leave.has(ref)) leave.set(ref, i)
  })
  const visibility = (id: string) => Array.from({ length: n }, (_, k) => k >= (appear.get(id) ?? 0) && k < (leave.get(id) ?? Infinity))
  const tones = (id: string, initial: Tone) => {
    let tone = initial
    return stepsIn.map((s) => (tone = (s as { status?: Record<string, Tone> }).status?.[id] ?? tone))
  }
  const known = new Set([...ids, ...edgesIn.map((e) => `${e.from}->${e.to}`)])
  stepsIn.forEach((s, i) => {
    const refs = [...((s as { show?: string[] }).show ?? []), ...((s as { hide?: string[] }).hide ?? []), ...((s as { focus?: string[] }).focus ?? []), ...Object.keys((s as { status?: object }).status ?? {})]
    for (const ref of refs) if (!known.has(ref)) warn(`step ${i + 1} references unknown element "${ref}"`)
  })

  const nodes = input.nodes.map((node) => {
    const [col, row] = node.at ?? place()
    return {
      id: node.id,
      label: node.label,
      detail: node.detail,
      icon: node.icon,
      shape: node.shape ?? 'card',
      col,
      row,
      visible: visibility(node.id),
      tone: tones(node.id, node.tone ?? 'plain'),
    }
  })
  const nodeVisible = new Map(nodes.map((node) => [node.id, node.visible]))
  const edges = edgesIn.map((e) => {
    const id = `${e.from}->${e.to}`
    const own = visibility(id)
    return {
      id,
      from: e.from,
      to: e.to,
      label: e.label,
      dashed: e.dashed ?? false,
      visible: own.map((v, k) => v && nodeVisible.get(e.from)![k] && nodeVisible.get(e.to)![k]),
      tone: tones(id, e.tone ?? 'plain'),
    }
  })
  const steps = stepsIn.map((s) => {
    const typed = s as { title?: string; note?: string; packets?: { from: string; to: string; label?: string; tone?: Tone }[]; focus?: string[] }
    return {
      ...step(typed.title, typed.note),
      packets: (typed.packets ?? []).filter((p) => ids.has(p.from) && ids.has(p.to)).map((p) => ({ ...p, tone: p.tone ?? 'accent' })),
      focus: typed.focus ?? [],
    }
  })
  return {
    ...base(input),
    type: 'flow',
    cols: Math.max(1, ...nodes.map((node) => Math.ceil(node.col) + 1)),
    rows: Math.max(1, ...nodes.map((node) => Math.ceil(node.row) + 1)),
    nodes,
    edges,
    steps,
  }
}

// ── metrics / compare / markdown ──────────────────────────────────────────

function decimalsOf(value: number | undefined): number {
  if (value === undefined || Number.isInteger(value)) return 0
  return Math.min(2, String(value).split('.')[1]?.length ?? 0)
}

function compileMetrics(input: Input<'metrics'> & { id: string }): MetricsSlide {
  const metrics = input.metrics.map((m) => ({
    label: m.label,
    before: m.before,
    after: m.after,
    unit: m.unit,
    decimals: m.decimals ?? Math.max(decimalsOf(m.before), decimalsOf(m.after)),
    better: m.better,
    noteHtml: inline(m.note),
  }))
  const hasBefore = metrics.some((m) => m.before !== undefined)
  const say = plain(input.metrics.map((m) => `${m.label}: ${m.before !== undefined ? `${m.before} to ` : ''}${m.after}${m.unit ? ` ${m.unit}` : ''}`).join('. '))
  return { ...base(input), type: 'metrics', metrics, steps: hasBefore ? [{ title: 'Before' }, { title: 'After', say }] : [{ say }] }
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }

async function compilePane(pane: Input<'compare'>['before'], fallback: { label: string; tone: Tone }, warn: (m: string) => void): Promise<Pane> {
  const label = pane.label ?? fallback.label
  const tone = pane.tone ?? fallback.tone
  if (pane.code !== undefined) {
    const palette = new PaletteBuilder()
    const language = languageFor(undefined, pane.language)
    const lines = await highlight(pane.code.replace(/\n$/, ''), language, palette)
    return { kind: 'code', label, tone, language, palette: palette.palette, lines }
  }
  if (pane.image) {
    let src = pane.image
    if (isAbsolute(src) && !/^https?:/.test(src)) {
      const mime = MIME[extname(src).toLowerCase()]
      const data = await readFile(src).catch(() => null)
      if (!data || !mime) warn(`cannot read image ${src}`)
      else src = `data:${mime};base64,${data.toString('base64')}`
    }
    return { kind: 'image', label, tone, src }
  }
  if (pane.points) return { kind: 'points', label, tone, items: pane.points.map((p) => inline(p)!) }
  return { kind: 'markdown', label, tone, html: markdown(pane.markdown) ?? '' }
}

async function compileCompare(input: Input<'compare'> & { id: string }, warn: (m: string) => void): Promise<CompareSlide> {
  const before = await compilePane(input.before, { label: 'Before', tone: 'error' }, warn)
  const after = await compilePane(input.after, { label: 'After', tone: 'success' }, warn)
  return { ...base(input), type: 'compare', before, after, steps: [step(before.label, input.note), step(after.label, input.note)] }
}

function compileMarkdown(input: Input<'markdown'> & { id: string }): MarkdownSlide {
  const blocks = input.blocks ?? (input.body ? [input.body] : [])
  return {
    ...base(input),
    type: 'markdown',
    blocks: blocks.map((b) => markdown(b) ?? ''),
    reveal: input.blocks ? 'stepwise' : 'all',
    steps: input.blocks ? blocks.map((b) => ({ say: plain(b) })) : [{ say: plain(input.body) }],
  }
}
