import { diffArrays } from 'diff'

export interface Entry {
  op: 'keep' | 'add' | 'remove'
  text: string
  oldNo?: number
  newNo?: number
  /** Git-style hunk: changes closer than 2×context lines share one. */
  hunk?: number
  /** Contiguous block of changed lines (adds, removes, re-indents). */
  change?: number
  /** Kept line whose indentation changed: old indent minus new indent, in characters. */
  shift?: number
}

export interface Fold {
  fold: number // hidden unchanged line count
}

export type DisplayEntry = Entry | Fold

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

const indent = (line: string) => line.length - line.trimStart().length

/**
 * Full line diff of two texts. Lines that differ only in indentation are kept
 * (with a shift) so they glide into place instead of leaving and re-entering.
 */
export function lineDiff(before: string, after: string, context: number): Entry[] {
  const a = before ? splitLines(before) : []
  const b = after ? splitLines(after) : []
  const entries: Entry[] = []
  let oi = 0
  let ni = 0
  for (const part of diffArrays(a, b, { comparator: (x: string, y: string) => x.trim() === y.trim() })) {
    for (let i = 0; i < part.value.length; i++) {
      if (part.added) entries.push({ op: 'add', text: b[ni], newNo: ++ni })
      else if (part.removed) entries.push({ op: 'remove', text: a[oi], oldNo: ++oi })
      else {
        const shift = b[ni].trim() ? indent(a[oi]) - indent(b[ni]) : 0
        entries.push({ op: 'keep', text: b[ni], oldNo: ++oi, newNo: ++ni, shift: shift || undefined })
      }
    }
  }
  numberChanges(entries, context)
  return entries
}

const changed = (entry: Entry) => entry.op !== 'keep' || !!entry.shift

/** Numbers contiguous change blocks, then groups them into git-style hunks. */
export function numberChanges(entries: Entry[], context: number): number {
  let change = 0
  let hunk = 0
  let lastChanged = -Infinity
  for (let i = 0; i < entries.length; i++) {
    if (!changed(entries[i])) continue
    if (i !== lastChanged + 1) change++
    if (i - lastChanged - 1 > context * 2 || hunk === 0) hunk++
    entries[i].change = change
    entries[i].hunk = hunk
    lastChanged = i
  }
  return change
}

/** Keep `context` unchanged lines around changes and fold the rest. */
export function condense(entries: Entry[], context: number, pinned: Set<Entry> = new Set()): DisplayEntry[] {
  const keep = new Array(entries.length).fill(false)
  let any = false
  entries.forEach((entry, i) => {
    if (!pinned.has(entry)) return
    for (let j = Math.max(0, i - 1); j <= Math.min(entries.length - 1, i + 1); j++) keep[j] = true
  })
  entries.forEach((entry, i) => {
    if (!changed(entry)) return
    any = true
    for (let j = Math.max(0, i - context); j <= Math.min(entries.length - 1, i + context); j++) keep[j] = true
  })
  if (!any) return entries
  const out: DisplayEntry[] = []
  let hidden = 0
  entries.forEach((entry, i) => {
    if (keep[i]) {
      if (hidden) out.push({ fold: hidden })
      hidden = 0
      out.push(entry)
    } else hidden++
  })
  if (hidden) out.push({ fold: hidden })
  // A fold of one or two lines costs more than it saves.
  return out.flatMap((entry, i) => {
    if (!('fold' in entry) || entry.fold > 2) return [entry]
    return expandFold(entries, out, i)
  })
}

function expandFold(entries: Entry[], out: DisplayEntry[], index: number): Entry[] {
  // Find the entries hidden by out[index]: those between its neighbours.
  const prev = out[index - 1] as Entry | undefined
  const next = out[index + 1] as Entry | undefined
  const start = prev ? entries.indexOf(prev) + 1 : 0
  const end = next ? entries.indexOf(next) : entries.length
  return entries.slice(start, end)
}

export interface ChangeSummary {
  change: number
  hunk: number
  oldStart: number
  newStart: number
  additions: number
  deletions: number
  reindented: number
  preview: string[]
}

export function summarizeChanges(entries: Entry[]): ChangeSummary[] {
  const changes = new Map<number, ChangeSummary>()
  let lastOld = 0
  let lastNew = 0
  for (const entry of entries) {
    if (entry.change) {
      let summary = changes.get(entry.change)
      if (!summary) {
        summary = { change: entry.change, hunk: entry.hunk!, oldStart: entry.oldNo ?? lastOld + 1, newStart: entry.newNo ?? lastNew + 1, additions: 0, deletions: 0, reindented: 0, preview: [] }
        changes.set(entry.change, summary)
      }
      if (entry.op === 'add') summary.additions++
      else if (entry.op === 'remove') summary.deletions++
      else summary.reindented++
      const sign = entry.op === 'add' ? '+' : entry.op === 'remove' ? '-' : '~'
      if (summary.preview.length < 4 && entry.text.trim() && entry.op !== 'keep') summary.preview.push(`${sign} ${entry.text.trim().slice(0, 90)}`)
    }
    if (entry.oldNo) lastOld = entry.oldNo
    if (entry.newNo) lastNew = entry.newNo
  }
  return [...changes.values()]
}
