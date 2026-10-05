export const INSTRUCTIONS = `Ferry turns code changes into animated, narrated presentations that open in the user's browser and update live while you build them.

Workflow:
1. inspect_changes (repo, base, head) to see changed files and their numbered changes.
2. create_deck, then add_slides with a story: title → points overview → per key change: behavior (sequence or flow) then code (diff with steps, focus, callouts) → points checklist for review.
3. open_deck to show it. Fix any warnings returned by add_slides.
4. Review loop: call wait_for_feedback. In the viewer (C key) the user plans code changes with the chat in Plan mode, which drafts them as a plan deck, then sends the plan. Implement it in the code, resolve_feedback with a reply, and wait again until they're done.
Shortcut: draft_deck_from_git builds a skeleton deck that you then refine with update_slide.
Call authoring_guide once for slide types and craft rules.`

export const GUIDE = `# Ferry authoring guide

Ferry presents code changes the way a good reviewer explains them: what the system did before, what it does now, and the smallest code delta that makes the difference. Every slide is a sequence of **steps**; the viewer animates between steps (→ next, ← back) and code keeps its identity, so the audience can follow the same lines through a change.

## Story shape (default for a PR or branch)

1. **title** — what changed and why, with stats from \`git\`.
2. **points** — 3–5 key changes, tagged (feat, fix, perf, refactor, breaking…).
3. **files** (optional) — changed files grouped by concern.
4. For each key change (optionally opened by a **section**):
   - behavior first: **sequence** (runtime interaction, before vs after phases) or **flow** (architecture/data flow with status changes and packets),
   - then the code: **diff** with one idea per step, focus and callouts.
5. **metrics** if there are numbers (latency, bundle size, coverage).
6. **points** with \`layout: "checklist"\` — review focus, risks, test plan.

Keep it short: 6–12 slides for a typical PR. Prefer several focused diff slides over one giant file.

## Craft rules

- **One idea per step.** A step's \`note\` is 1–3 sentences of narration; it is displayed beside the visual and read aloud in voice mode.
- **Behavior before code.** Show what the user/system experiences, then the change that causes it.
- **Maximum stability.** Unchanged code stays still; only changed lines enter or leave. Don't re-show a whole file to explain a two-line change: use git sources (auto-condensed with folds) or \`lines\` with only the relevant context.
- **Point, don't paraphrase.** Use \`callouts\` (2–8 words) pinned to the exact token, and \`focus\` to dim everything else.
- **Titles are claims**, not labels: "Retry the bind instead of *waiting*" beats "bind.ts changes". \`*phrase*\` renders in the accent serif italic.
- Use tones semantically: error for broken behavior, success for the fix, warning for risk.
- Condense code honestly. If you hand-write \`lines\`, keep real code; elide with a \`// …\` line rather than inventing.

## Slide types

All slides accept \`id\`, \`kicker\`, \`title\`, \`notes\`.

### title
\`{ type: "title", title, subtitle?, meta?: {"Author": "ana", "PR": "#482"}, stats?: {files, additions, deletions}, git?: {repo, base?, head?} }\`

### section
\`{ type: "section", title, subtitle?, number? }\` — chapter divider (auto-numbered).

### points
\`{ type: "points", title, points: [{title, body?, tag?, tone?}], layout?: "cards"|"list"|"checklist", reveal?: "stepwise"|"all" }\`

### files
\`{ type: "files", title, git?: {repo, base?, head?} | files?: [{path, status, additions, deletions, note?}], groups?: [{title, note?, paths: ["src/server/", "*.test.ts"]}] }\` — each group is a step that highlights its files.

### diff — the centerpiece
Exactly one source:
- \`git: {repo, path, base?, head?}\` — reads the real change. \`inspect_changes\` numbers each file's *changes* (contiguous blocks of added/removed lines). Assign them with \`steps[].changes: [1, 2]\`; without that, each git hunk is one step.
- \`before\` + \`after\` strings — the server computes changes the same way.
- \`lines: [{text, op: "keep"|"add"|"remove", step}]\` — full control over a condensed, stepped diff.
- \`code\` — unchanged code walked through with focus and callouts.

\`\`\`json
{
  "type": "diff",
  "kicker": "Fix 1 of 3 · server/bind.ts",
  "title": "Retry the bind instead of *waiting*",
  "git": { "repo": "/abs/path/repo", "path": "src/server/bind.ts", "base": "main" },
  "intro": { "note": "On **EADDRINUSE** the server waits 15s for an incumbent that is already exiting." },
  "steps": [
    { "title": "Loop instead of wait", "note": "The single wait becomes a loop…", "changes": [1, 2],
      "callouts": [{ "at": "await sleep(100)", "text": "poll every 100 ms", "tone": "success" }] },
    { "title": "Delete the helper", "changes": [3], "focus": ["readRegistration"] }
  ]
}
\`\`\`
The slide opens on the old code (\`intro\` narrates it). Each step applies its changes: in \`morph\` mode (default) removed lines flash red and collapse while new lines open room and slide in green. \`mode: "review"\` keeps removed lines struck through during their step. Code refs (\`focus\`, \`callouts[].at\`) are a substring (also underlined), a 1-based new-file line number, or an inclusive \`[from, to]\` range. Lines that only change indentation (code wrapped in a new block) are kept and glide sideways instead of being deleted and re-added. \`context\` (default 3) controls unchanged lines kept around changes; the rest folds.

### sequence
\`\`\`json
{
  "type": "sequence", "title": "A 404 no longer kills a healthy server",
  "participants": [{"id": "cli", "label": "Client"}, {"id": "srv", "label": "Server", "detail": "v2"}],
  "phases": [
    {"title": "Before", "rows": [
      {"from": "cli", "to": "srv", "label": "GET /health"},
      {"from": "srv", "to": "cli", "label": "404", "kind": "reply", "tone": "error", "caption": "The client assumes the server is outdated…"},
      {"from": "cli", "to": "srv", "label": "SIGTERM", "tone": "error"}]},
    {"title": "After", "rows": [ … same slots, fixed behavior … ]}
  ]
}
\`\`\`
One row is revealed per step (\`with_previous: true\` joins the previous step). A later phase replays in the same slots after fading the previous one (\`replace: false\` to continue below). Phases titled Before/After get error/success tones automatically. Kinds: message, reply (dashed), note (box across from..to). Tones color the arrow: error for broken behavior, success for the fix. \`aside\` adds a muted detail under the arrow.

### flow
\`{ type: "flow", nodes: [{id, label, detail?, icon?, at?: [col,row], shape?: "card"|"pill"|"store", tone?}], edges?: [{from, to, label?, dashed?}], steps?: [{title?, note?, show?: [ids], hide?: [ids], status?: {id: tone}, packets?: [{from, to, label?, tone?}], focus?: [ids]}] }\`
Edge ids are "from->to". Elements listed in a step's \`show\` are hidden until that step. Packets are light pulses that travel when the step begins. Icons: server, database, user, browser, cloud, queue, cache, lock, code, file, terminal, bolt, globe, gear, box, phone, key, mail, shield, cpu, layers, git, clock, search, bell, chart, plug, workflow.

### metrics
\`{ type: "metrics", metrics: [{label, before?, after, unit?, better?: "lower"|"higher", note?}] }\` — numbers roll from before to after; deltas are colored by \`better\`.

### compare
\`{ type: "compare", before: Pane, after: Pane, note? }\`, Pane = \`{label?, tone?, code?+language?, markdown?, points?, image?}\`. Two images (absolute paths or URLs) get a draggable wipe — ideal for UI changes.

### markdown
\`{ type: "markdown", body? | blocks?: [md, …] }\` — blocks reveal one per step.

## Tools

- \`inspect_changes\` — files, churn, and numbered changes with previews. Use the change numbers in \`steps[].changes\`.
- \`create_deck\` / \`update_deck\` — metadata and theme (midnight, tokyo, evergreen, paper).
- \`add_slides\` (optionally \`after\` a slide id), \`update_slide\` (full replacement), \`remove_slides\`, \`reorder_slides\`.
- \`get_deck\` — the authoring JSON you sent, with ids and step counts.
- \`draft_deck_from_git\` — skeleton deck: title, files, one diff per significant file.
- \`open_deck\` — opens the live viewer. Edits appear in the open browser immediately.
- \`export_deck\` — a single self-contained HTML file to attach to a PR or share.

## Review loop

People review the change through the deck, then plan what should change next. **C** opens the panel; in the chat's **Plan** mode they describe code changes (pinning code lines with the crosshair), and Ferry's built-in agent drafts them as a *plan deck* (deck id \`<deck_id>-plan\`): slides proposing the changes with hand-written diffs. They revise it until it's right, then send it to you. Nothing in the repository changes until then.

1. \`wait_for_feedback\` blocks until a plan arrives (the viewer shows that you are listening) and returns it: the plan's outline and every slide's authoring JSON, plus any individual requests with their slide, step, and pinned element. \`get_feedback\` returns pending items without waiting.
2. Implement the plan in the code, on the checked-out branch, without committing. Its diffs show intent; adapt them to the real code where needed.
3. \`resolve_feedback\` with a one-line reply per item ("done": what changed, which files; "declined": why). Replies appear in the viewer next to the request.
4. If a request is ambiguous, \`reply_feedback\` asks the user; their answer comes back through \`wait_for_feedback\`.
5. Call \`wait_for_feedback\` again until the user is happy or it times out.

Viewer keys: → / Space next step · ← previous · ↑ ↓ slides · C feedback · O overview · T theme · N notes · V voice narration · F fullscreen · S slow motion · ? help.
`
