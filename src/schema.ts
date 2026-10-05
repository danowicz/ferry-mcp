// Authoring input: what agents send. Validated here, compiled by compile.ts.
import { z } from 'zod'
import { THEMES } from './model.ts'

export const ToneSchema = z
  .enum(['plain', 'accent', 'success', 'error', 'warning', 'info', 'muted'])
  .describe('Semantic color. success/error/warning keep their meaning in every theme.')

const md = (what: string) => z.string().describe(`${what} (Markdown: **bold**, \`code\`, *emphasis*, lists)`)

const common = {
  id: z.string().optional().describe('Stable slide id. Generated from the title when omitted.'),
  kicker: z.string().optional().describe('Small eyebrow above the title, e.g. "Fix 2 of 4 · server/bind.ts".'),
  title: z
    .string()
    .optional()
    .describe('Slide headline. Wrap a phrase in *asterisks* to set it in the accent serif italic.'),
  notes: z.string().optional().describe('Speaker notes: shown in the notes drawer (N) and read aloud in voice mode.'),
}

/** A reference to code lines: substring match, 1-based line number in the new file, or an inclusive range. */
const CodeRef = z
  .union([z.string(), z.number().int(), z.tuple([z.number().int(), z.number().int()])])
  .describe('A substring to find ("retryBind("), a 1-based line number in the new file (42), or a range ([40, 48]).')

const GitFileSource = z
  .object({
    repo: z.string().describe('Absolute path to the git repository.'),
    path: z.string().describe('File path relative to the repository root.'),
    base: z.string().optional().describe('Base ref. Default "HEAD". Branch names use their merge-base with head, like a PR.'),
    head: z.string().optional().describe('Head ref. Omit to use the working tree (uncommitted changes included).'),
  })
  .describe('Read the change straight from git. Each hunk becomes a step unless steps[].changes says otherwise.')

const GitRange = z.object({
  repo: z.string().describe('Absolute path to the git repository.'),
  base: z.string().optional().describe('Base ref, default "HEAD".'),
  head: z.string().optional().describe('Head ref; omit for the working tree.'),
})

export const TitleInput = z
  .object({
    type: z.literal('title'),
    ...common,
    title: z.string(),
    subtitle: md('One or two sentences: what changed and why it matters').optional(),
    meta: z
      .record(z.string(), z.string())
      .optional()
      .describe('Facts shown as chips, e.g. {"Author": "ana", "Branch": "fix/bind", "PR": "#482"}.'),
    stats: z
      .object({ files: z.number().int().optional(), additions: z.number().int().optional(), deletions: z.number().int().optional() })
      .optional()
      .describe('Change size; rolls in as counters. Filled from `git` when given.'),
    git: GitRange.optional().describe('Fill stats from this git range.'),
  })
  .describe('Opening hero slide.')

export const SectionInput = z
  .object({
    type: z.literal('section'),
    ...common,
    title: z.string(),
    subtitle: md('Short framing line').optional(),
    number: z.string().optional().describe('Large chapter mark, e.g. "02". Auto-numbered when omitted.'),
  })
  .describe('Chapter divider between groups of slides.')

export const PointsInput = z
  .object({
    type: z.literal('points'),
    ...common,
    points: z
      .array(
        z.object({
          title: z.string(),
          body: md('Supporting sentence').optional(),
          tag: z
            .string()
            .optional()
            .describe('Change kind chip: feat, fix, refactor, perf, test, docs, breaking, security, chore, or any short word.'),
          tone: ToneSchema.optional(),
        }),
      )
      .min(1),
    layout: z.enum(['cards', 'list', 'checklist']).optional().describe('cards (default, ≤6 points), list, or checklist (review/test plans).'),
    reveal: z.enum(['stepwise', 'all']).optional().describe('stepwise (default) reveals one point per step.'),
  })
  .describe('Key points: an overview of the changes, review focus, risks, or a test plan.')

export const FilesInput = z
  .object({
    type: z.literal('files'),
    ...common,
    files: z
      .array(
        z.object({
          path: z.string(),
          status: z.enum(['added', 'modified', 'deleted', 'renamed']).optional(),
          additions: z.number().int().optional(),
          deletions: z.number().int().optional(),
          oldPath: z.string().optional(),
          note: z.string().optional().describe('Short annotation shown beside the file.'),
        }),
      )
      .optional()
      .describe('Changed files. Omit and pass `git` to read them from the repository.'),
    git: GitRange.optional(),
    groups: z
      .array(
        z.object({
          title: z.string(),
          note: md('Why these files changed').optional(),
          paths: z.array(z.string()).describe('Path prefixes or globs (src/server/*, *.test.ts) highlighted in this step.'),
        }),
      )
      .optional()
      .describe('Each group becomes a step that highlights its files.'),
  })
  .describe('Map of changed files with status and churn.')

const DiffStepInput = z.object({
  title: z.string().optional().describe('Short step headline.'),
  note: md('Narration for this step: what changes and why').optional(),
  changes: z
    .array(z.number().int().min(1))
    .optional()
    .describe('git/before-after sources: change numbers (from inspect_changes) applied in this step. Default: one git hunk per step.'),
  focus: z.array(CodeRef).optional().describe('Lines to spotlight; everything else dims.'),
  callouts: z
    .array(z.object({ at: CodeRef, text: z.string().describe('2–8 words.'), tone: ToneSchema.optional() }))
    .optional()
    .describe('Labels pinned to code; a string `at` also underlines the matched text.'),
})

export const DiffInput = z
  .object({
    type: z.literal('diff'),
    ...common,
    file: z.string().optional().describe('Displayed file path. Defaults to git.path.'),
    language: z.string().optional().describe('Highlighting language (ts, py, rust, go…). Inferred from the file name.'),
    git: GitFileSource.optional(),
    before: z.string().optional().describe('Old code. With `after`, the server computes the diff and its changes.'),
    after: z.string().optional().describe('New code.'),
    lines: z
      .array(
        z.object({
          text: z.string(),
          op: z.enum(['keep', 'add', 'remove']).optional(),
          step: z.number().int().min(1).optional().describe('Step (1-based into steps) that adds/removes this line. Default 1.'),
        }),
      )
      .optional()
      .describe('Hand-written stepped diff for full control (condensed or illustrative code).'),
    code: z.string().optional().describe('Unchanged code to walk through with focus and callouts only.'),
    intro: z
      .object({ title: z.string().optional(), note: md('Narration for the unchanged code').optional() })
      .optional()
      .describe('The slide opens on the old code; this narrates it before the first change.'),
    steps: z.array(DiffStepInput).optional().describe('Each step applies its changes in order. Keep one idea per step.'),
    context: z.number().int().min(0).max(50).optional().describe('Unchanged lines kept around each hunk (default 3); the rest folds.'),
    mode: z
      .enum(['morph', 'review'])
      .optional()
      .describe('morph (default): removed lines flash red then collapse as new code slides in. review: removed lines stay struck through for their step.'),
  })
  .describe('Animated code change. Code keeps its identity between steps: only changed lines enter or leave. Provide exactly one source: git, before+after, lines, or code.')

const SequenceRowInput = z.object({
  from: z.string().describe('Participant id.'),
  to: z.string().describe('Participant id (same as from for a self-call).'),
  label: z.string(),
  kind: z.enum(['message', 'reply', 'note']).optional().describe('message (solid), reply (dashed), note (box across from..to).'),
  tone: ToneSchema.optional().describe('Colors the arrow and label: error for broken behavior, success for the fix.'),
  caption: md('Narration for the step that reveals this row').optional(),
  aside: z.string().optional().describe('Small muted detail under the label.'),
  with_previous: z.boolean().optional().describe('Reveal together with the previous row.'),
})

export const SequenceInput = z
  .object({
    type: z.literal('sequence'),
    ...common,
    participants: z
      .array(z.object({ id: z.string(), label: z.string(), detail: z.string().optional(), icon: z.string().optional() }))
      .min(1)
      .max(7),
    phases: z
      .array(
        z.object({
          title: z.string().describe('e.g. "Before" or "After the fix".'),
          tone: ToneSchema.optional(),
          note: md('Narration when the phase begins').optional(),
          rows: z.array(SequenceRowInput).min(1),
          replace: z.boolean().optional().describe('Replay in the same slots, fading the previous phase out (default true).'),
        }),
      )
      .optional()
      .describe('Play the broken behavior, then replay the fixed behavior in the same places.'),
    rows: z.array(SequenceRowInput).optional().describe('Single-phase shorthand for phases.'),
  })
  .describe('Sequence diagram that reveals one interaction per step — best for showing runtime behavior before vs after.')

const FlowRef = z.string().describe('Node id, or edge id written "from->to".')

export const FlowInput = z
  .object({
    type: z.literal('flow'),
    ...common,
    nodes: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          detail: z.string().optional(),
          icon: z
            .string()
            .optional()
            .describe('server, database, user, browser, cloud, queue, cache, lock, code, file, terminal, bolt, globe, gear, box, phone, key, mail, shield, cpu, layers, git, clock, search, bell, chart, plug, workflow'),
          at: z.tuple([z.number(), z.number()]).optional().describe('[column, row] on a grid, 0-based. Default: left to right.'),
          shape: z.enum(['card', 'pill', 'store']).optional(),
          tone: ToneSchema.optional(),
        }),
      )
      .min(1),
    edges: z
      .array(z.object({ from: z.string(), to: z.string(), label: z.string().optional(), dashed: z.boolean().optional(), tone: ToneSchema.optional() }))
      .optional(),
    steps: z
      .array(
        z.object({
          title: z.string().optional(),
          note: md('Narration').optional(),
          show: z.array(FlowRef).optional().describe('Elements that appear in this step (hidden before it).'),
          hide: z.array(FlowRef).optional().describe('Elements that leave in this step.'),
          status: z.record(z.string(), ToneSchema).optional().describe('Recolor nodes/edges from this step on, e.g. {"cache": "error"}.'),
          packets: z
            .array(z.object({ from: z.string(), to: z.string(), label: z.string().optional(), tone: ToneSchema.optional() }))
            .optional()
            .describe('Light pulses that travel between nodes when the step begins.'),
          focus: z.array(FlowRef).optional().describe('Spotlight these; dim the rest.'),
        }),
      )
      .optional(),
  })
  .describe('Architecture/data-flow diagram with nodes, connectors, status changes and travelling packets.')

export const MetricsInput = z
  .object({
    type: z.literal('metrics'),
    ...common,
    metrics: z
      .array(
        z.object({
          label: z.string(),
          before: z.number().optional(),
          after: z.number(),
          unit: z.string().optional().describe('Suffix such as ms, %, MB, req/s.'),
          decimals: z.number().int().min(0).max(4).optional(),
          better: z.enum(['lower', 'higher']).optional().describe('Colors the delta.'),
          note: z.string().optional(),
        }),
      )
      .min(1)
      .max(6),
  })
  .describe('Before → after numbers that roll in place (latency, bundle size, coverage…).')

const PaneInput = z
  .object({
    label: z.string().optional(),
    tone: ToneSchema.optional(),
    code: z.string().optional(),
    language: z.string().optional(),
    markdown: z.string().optional(),
    points: z.array(z.string()).optional(),
    image: z.string().optional().describe('Absolute image path or URL (screenshots of UI changes). Two images get a draggable wipe.'),
  })
  .describe('One of code, markdown, points, or image.')

export const CompareInput = z
  .object({
    type: z.literal('compare'),
    ...common,
    before: PaneInput,
    after: PaneInput,
    note: md('Narration').optional(),
  })
  .describe('Side-by-side before/after (API shapes, configs, UI screenshots).')

export const MarkdownInput = z
  .object({
    type: z.literal('markdown'),
    ...common,
    body: md('Content').optional(),
    blocks: z.array(z.string()).optional().describe('Markdown blocks revealed one per step.'),
  })
  .describe('Free-form text slide.')

export const SlideInput = z.discriminatedUnion('type', [
  TitleInput,
  SectionInput,
  PointsInput,
  FilesInput,
  DiffInput,
  SequenceInput,
  FlowInput,
  MetricsInput,
  CompareInput,
  MarkdownInput,
])
export type SlideInput = z.infer<typeof SlideInput>

export const ThemeSchema = z.enum(THEMES).describe('midnight (warm dark, default), tokyo, evergreen, or paper (light).')

export const DeckMetaInput = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  repo: z.string().optional().describe('Repository label shown in the footer, e.g. "acme/api".'),
  ref: z.string().optional().describe('Branch, PR, or commit label, e.g. "PR #482".'),
  theme: ThemeSchema.optional(),
})
