# Ferry

**Code changes, explained.** Ferry is an MCP server that lets AI agents build animated, narrated presentations of codebase changes. The presentations open in your browser and update live while the agent builds them.

[![Ferry demo: an agent builds a deck live, then walks a sequence diagram and a stepped diff](docs/demo.gif)](docs/demo.mp4)

▶ **[Watch the full demo](docs/demo.mp4)** (1:50): the agent builds the deck live, walks the behavior, architecture and code, then applies a review comment from the viewer.

Ferry carries reviewers from the old code to the new. It's built on a few ideas that make change explainers easy to follow:

- **Maximum stability.** Code keeps its identity between steps. Only changed lines enter or leave. Lines that only change indentation glide sideways instead of being deleted and re-added.
- **Behavior before code.** Sequence diagrams play the broken behavior, then replay the fix in the same slots. After that, a stepped diff shows the change that causes it.
- **Interruptible motion.** Every channel is a closed-form spring. Retargeting keeps the current position *and* velocity, so pressing ← mid-transition reverses smoothly instead of jumping.
- **Plans, not pixels.** Agents send declarative JSON. The server validates it, resolves git, highlights code with Shiki, and returns actionable warnings.

## Install with your agent

Paste this into Claude Code, Codex, Cursor, or any agent that can run shell commands:

```text
Install the Ferry MCP server for me. Clone https://github.com/danowicz/ferry-mcp into ~/.ferry-mcp (or pull if it's already there), then follow ~/.ferry-mcp/INSTALL.md: check Node ≥ 22.18, run npm install and npm test, and register Ferry with the MCP clients I use. Tell me when it's ready and what I need to restart.
```

[INSTALL.md](INSTALL.md) holds the steps the agent follows: prerequisites, verification, and config snippets for each client.

## Install by hand

```sh
git clone https://github.com/danowicz/ferry-mcp.git ~/.ferry-mcp
cd ~/.ferry-mcp && npm install   # Node ≥ 22.18
```

**Claude Code**

```sh
claude mcp add ferry --scope user -- node ~/.ferry-mcp/bin/ferry.js
```

**Claude Desktop / Cursor / any MCP client** (use the absolute path; clients don't expand `~`)

```json
{
  "mcpServers": {
    "ferry": { "command": "node", "args": ["/Users/you/.ferry-mcp/bin/ferry.js"] }
  }
}
```

Then ask your agent something like:

> Explain the changes on this branch with a Ferry presentation.

The `explain_changes` prompt walks the agent through the whole flow. The viewer starts automatically at <http://localhost:4747> (set `FERRY_PORT` to change it). Decks are stored in `~/.ferry/decks` (set `FERRY_HOME` to change it).

## Tools

| Tool | What it does |
| --- | --- |
| `authoring_guide` | Slide types, JSON shapes, storytelling rules |
| `inspect_changes` | Changed files, churn, and numbered *changes* (blocks of added, removed, or re-indented lines) |
| `create_deck` / `update_deck` | Deck metadata and theme |
| `add_slides` / `update_slide` / `remove_slides` / `reorder_slides` | Edit the deck; warnings flag unmatched callouts, unknown ids, folded targets |
| `get_deck` / `list_decks` | Read back authoring JSON and outlines |
| `draft_deck_from_git` | Skeleton deck: title with stats, file map, one stepped diff per significant file |
| `open_deck` | Opens the live viewer |
| `wait_for_feedback` | Waits until you send a change plan from the viewer, then returns it with slide JSON |
| `get_feedback` | Returns pending requests without waiting |
| `resolve_feedback` | Closes requests with a reply shown in the viewer chat |
| `reply_feedback` | Asks you a question in the viewer chat |
| `export_deck` | One self-contained HTML file (fonts and code inlined, works offline) |

## Chat in the viewer

Press **C** in the viewer. The **Chat** tab is a conversation with a Claude Code agent dedicated to the deck:

- Every message carries what you're looking at: the slide, the step, and anything you **Pin** (a code line, node, row…).
- The agent runs headless (`claude -p`) in the deck's repository, using your existing Claude Code login. It can read the code (Read, Grep, Glob, read-only git) and edit the deck through Ferry's tools. It never modifies repository files.
- Replies stream into the panel along with what the agent is doing ("Reading bind.ts", "Updating slide…"). Slide edits appear live.
- The conversation continues across messages (one Claude Code session per deck). **New chat** starts over, and **Stop** interrupts.
- **Add to plan** turns your text into a change request for the agent that built the deck, instead of the chat agent.

Set `FERRY_CHAT_MODEL` to pick a model (e.g. `sonnet` for faster replies), or `FERRY_CLAUDE_BIN` if `claude` isn't on your PATH. Chat logs are stored in `~/.ferry/chat/`.

## Review together (change plans)

The **Change plan** tab queues requests for *your* agent, the one that built the deck in your Claude Code session:

1. **Comment** on the current slide and step, or switch the chip to *Whole deck*. **Pin** (or **P**) lets you click any element to anchor the comment: a code line, callout, node, edge, sequence row, point, metric or file.
2. Each comment becomes a **draft** in the change plan. **Send to agent** delivers the whole plan (⌘↵ sends right away).
3. If the agent called `wait_for_feedback`, the panel shows **Agent is listening**, and the agent gets the plan immediately: every request with its slide, step, pinned element and the slide's authoring JSON. If no agent is listening, tell your agent "apply my Ferry feedback", or use **Copy as prompt**.
4. The agent edits the slides (they update live), then replies per request. Replies appear in the chat as **Done** or **Declined**. Reply under any request to reopen it. The agent can also ask you questions in the thread.

Slides with open requests get a dot on the progress bar. Feedback is stored in `~/.ferry/feedback/`. The viewer only accepts JSON requests from localhost pages, so other websites can't inject instructions for your agent.

## Slide types

`title` · `section` · `points` (cards, list, checklist) · `files` · **`diff`** (from git, before/after, hand-written lines, or plain code; with steps, focus, callouts, morph or review mode) · `sequence` (before/after phases) · `flow` (architecture with status changes and travelling packets) · `metrics` (rolling numbers) · `compare` (code, points, markdown, or a draggable image wipe for UI changes) · `markdown`.

## Viewer keys

→ / Space: next step · ← back · ↑ ↓ slides · **C** chat & change plan · **P** pin · **O** overview · **N** speaker notes · **V** voice narration (auto-advances) · **T** theme (midnight, tokyo, evergreen, paper) · **S** slow motion · **R** replay · **F** fullscreen · **?** help

## CLI

```sh
node bin/ferry.js serve [--open]        # standalone viewer
node bin/ferry.js list                  # saved decks
node bin/ferry.js export <deck-id> [out.html]
npm run demo                            # builds the showcase deck through MCP
npm run record                          # re-records docs/demo.mp4 (needs ffmpeg and Playwright's Chromium)
npm test                                # end-to-end check of every tool
```

## Layout

```text
src/           MCP server (Node runs TypeScript directly)
  mcp.ts         tools, prompt, resource
  schema.ts      authoring input (zod) — what agents send
  compile.ts     authoring → render model: ids, git, highlighting, steps, warnings
  diff.ts        line diff with re-indent detection, change blocks, folding
  model.ts       render model shared with the viewer
  server.ts      viewer HTTP server + live updates (SSE) + feedback API
  feedback.ts    change requests, agent presence, change-plan formatting
  chat.ts        viewer chat: headless Claude Code per deck, streamed over SSE
viewer/src/    presentation app (bundled with esbuild on demand)
  motion.ts      closed-form interruptible springs
  feedback.ts    side panel: chat tab, change-plan tab, pinning
  markdown.ts    safe Markdown for chat replies
  slides/        one view per slide type
scripts/       demo, smoke test, screenshot walker, demo-video recorder
docs/          demo video and GIF
```
