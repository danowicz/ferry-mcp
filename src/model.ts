// The compiled render model: what the viewer consumes.
// Authoring input (schema.ts) is normalized into these values by compile.ts.

export const THEMES = ['midnight', 'tokyo', 'evergreen', 'paper'] as const
export type ThemeName = (typeof THEMES)[number]

export type Tone = 'plain' | 'accent' | 'success' | 'error' | 'warning' | 'info' | 'muted'

/** A highlighted span: [text, palette index]. */
export type Token = [string, number]

/**
 * Palette entries are `color|color|color|color|fontStyle` in THEMES order,
 * deduplicated per slide so token arrays stay small.
 */
export type Palette = string[]

/** One presentation step: a navigation destination with its narration. */
export interface Step {
  title?: string
  /** Inline-formatted HTML. */
  titleHtml?: string
  /** Narration rendered from Markdown. */
  noteHtml?: string
  /** Plain narration for voice playback and speaker notes. */
  say?: string
}

interface SlideBase {
  id: string
  kicker?: string
  title?: string
  titleHtml?: string
  /** Speaker notes (plain text). */
  notes?: string
  steps: Step[]
}

export interface TitleSlide extends SlideBase {
  type: 'title'
  subtitleHtml?: string
  meta: { label: string; value: string }[]
  stats?: { files?: number; additions?: number; deletions?: number }
}

export interface SectionSlide extends SlideBase {
  type: 'section'
  number?: string
  subtitleHtml?: string
}

export interface PointsSlide extends SlideBase {
  type: 'points'
  layout: 'cards' | 'list' | 'checklist'
  reveal: 'stepwise' | 'all'
  points: { titleHtml: string; bodyHtml?: string; tag?: string; tone: Tone }[]
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface FilesSlide extends SlideBase {
  type: 'files'
  files: { path: string; oldPath?: string; status: FileStatus; additions: number; deletions: number; noteHtml?: string }[]
  /** For each step, the indices of highlighted files (empty = none highlighted). */
  highlights: number[][]
}

export interface DiffLine {
  id: string
  kind: 'code' | 'fold'
  op: 'keep' | 'add' | 'remove'
  /** Presentation step at which an add appears, a remove leaves, or a shift settles. 0 for plain keeps. */
  step: number
  tokens: Token[]
  text: string
  oldNo?: number
  newNo?: number
  /** Line number shown at each step (0 = not in the file at that step). */
  nos?: number[]
  /** Change block (1-based) this line belongs to. */
  change?: number
  /** Kept line whose indentation changes at `step`: old minus new indent, in characters. */
  shift?: number
}

export interface Callout {
  lineId: string
  /** Character range inside the line to underline; [0, 0] for the whole line. */
  start: number
  end: number
  text: string
  tone: Tone
}

export interface DiffStep extends Step {
  focus: string[]
  callouts: Callout[]
  additions: number
  deletions: number
}

export interface DiffSlide extends SlideBase {
  type: 'diff'
  file?: string
  language: string
  mode: 'morph' | 'review'
  palette: Palette
  lines: DiffLine[]
  steps: DiffStep[]
  additions: number
  deletions: number
}

export interface SequenceRow {
  id: string
  from: number
  to: number
  labelHtml: string
  asideHtml?: string
  kind: 'message' | 'reply' | 'note'
  tone: Tone
  slot: number
  /** Presentation step index at which the row appears. */
  enter: number
  /** Presentation step index at which the row leaves (exclusive end), if any. */
  exit?: number
  phase: number
}

export interface SequenceSlide extends SlideBase {
  type: 'sequence'
  participants: { id: string; label: string; detail?: string; icon?: string }[]
  phases: { title: string; tone: Tone }[]
  /** Phase index per step. */
  stepPhase: number[]
  rows: SequenceRow[]
  slots: number
}

export interface FlowNode {
  id: string
  label: string
  detail?: string
  icon?: string
  shape: 'card' | 'pill' | 'store'
  col: number
  row: number
  /** Visible at each step. */
  visible: boolean[]
  /** Tone at each step. */
  tone: Tone[]
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  label?: string
  dashed: boolean
  visible: boolean[]
  tone: Tone[]
}

export interface FlowStep extends Step {
  packets: { from: string; to: string; label?: string; tone: Tone }[]
  focus: string[]
}

export interface FlowSlide extends SlideBase {
  type: 'flow'
  cols: number
  rows: number
  nodes: FlowNode[]
  edges: FlowEdge[]
  steps: FlowStep[]
}

export interface Metric {
  label: string
  before?: number
  after: number
  unit?: string
  decimals: number
  better?: 'lower' | 'higher'
  noteHtml?: string
}

export interface MetricsSlide extends SlideBase {
  type: 'metrics'
  metrics: Metric[]
}

export type Pane =
  | { kind: 'code'; label: string; tone: Tone; language: string; palette: Palette; lines: Token[][] }
  | { kind: 'markdown'; label: string; tone: Tone; html: string }
  | { kind: 'points'; label: string; tone: Tone; items: string[] }
  | { kind: 'image'; label: string; tone: Tone; src: string }

export interface CompareSlide extends SlideBase {
  type: 'compare'
  before: Pane
  after: Pane
}

export interface MarkdownSlide extends SlideBase {
  type: 'markdown'
  blocks: string[]
  reveal: 'stepwise' | 'all'
}

export type Slide =
  | TitleSlide
  | SectionSlide
  | PointsSlide
  | FilesSlide
  | DiffSlide
  | SequenceSlide
  | FlowSlide
  | MetricsSlide
  | CompareSlide
  | MarkdownSlide

export interface CompiledDeck {
  id: string
  title: string
  subtitle?: string
  repo?: string
  ref?: string
  theme: ThemeName
  createdAt: string
  updatedAt: string
  revision: number
  slides: Slide[]
}
