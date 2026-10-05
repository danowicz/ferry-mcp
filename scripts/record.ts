// Records the demo video: an agent builds the showcase deck over MCP while the
// viewer updates live, walks it, applies a review comment, and ends on the
// overview. Captions run in a band under the 1920×1080 stage. Needs ffmpeg.
// usage: node scripts/record.ts [out.mp4]
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { launchBrowser } from './browser.ts'
import { connect } from './client.ts'
import { createSampleRepo } from './sample-repo.ts'
import { deck, slides } from './showcase.ts'

const out = process.argv[2] ?? join(import.meta.dirname, '..', 'docs', 'demo.mp4')
const BAND = 120
const home = mkdtempSync(join(tmpdir(), 'ferry-record-'))
const frameDir = join(home, 'frames')
mkdirSync(frameDir)

const git = { repo: createSampleRepo(), base: 'main', head: 'fix/bind-retry' }
const showcase = slides(git)
const { client, call } = await connect({ FERRY_HOME: home, FERRY_PORT: '4870' })
const id = (await call('create_deck', deck)).match(/id: ([a-z0-9-]+)/)![1]
const url = (await call('open_deck', { deck_id: id, launch: false })).match(/http\S+/)![0]

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 + BAND } })
await page.addInitScript(stage, BAND)
await page.goto(url)
await page.waitForSelector('.bar-logo, .empty-logo')
await page.evaluate(() => window.rec.card(`<h1>Ferry</h1><h2>Code changes, <em>explained.</em></h2><p>An MCP server that lets your coding agent build animated, narrated walkthroughs of a change — live in your browser.</p>`))
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(600)

// ── capture ──────────────────────────────────────────────────────────────
const cdp = await page.context().newCDPSession(page)
const frames: { file: string; at: number }[] = []
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const file = join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`)
  writeFileSync(file, data, 'base64')
  frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 })
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080 + BAND })

const pause = (ms: number) => page.waitForTimeout(ms)
const caption = (title: string, sub = '') => page.evaluate(([t, s]) => window.rec.caption(t, s), [title, sub])
const slideNow = () => page.evaluate(() => Number(location.hash.slice(1).split('.')[0]) || 1)
const idle = () => page.evaluate(() => window.rec.tool('', ''))
const agent = async (name: string, args: Record<string, unknown>, detail = '') => {
  await page.evaluate(([n, d]) => window.rec.tool(n, d), [name, detail])
  return call(name, { deck_id: id, ...args })
}

const steps: number[] = []
const next = () => page.keyboard.press('ArrowRight')

/** Holds the slide's first step for `first` ms, then plays the rest at `dwell` ms a step, ending on its last step. */
async function walk(dwell: number, first = dwell) {
  await pause(first)
  const count = steps[(await slideNow()) - 1] ?? 1
  for (let step = 1; step < count; step++) {
    await next()
    await pause(dwell)
  }
}

// ── story ────────────────────────────────────────────────────────────────
await pause(3800)
await page.evaluate(() => window.rec.hideCard())
await caption('You ask your agent to *explain* a branch', 'It reads the diff with inspect_changes, then builds a deck through Ferry’s MCP tools.')
await pause(2600)

let outline = ''
for (const [i, slide] of showcase.entries()) {
  outline = await agent('add_slides', { slides: [slide] }, `${slide.type} · “${slide.title.replace(/\*/g, '')}”`)
  if (i === 0) await caption('The deck updates *live* while the agent works', 'Every tool call lands in the open viewer — no reloads.')
  await pause(i === 0 ? 2400 : 750)
}
const rows = [...outline.matchAll(/^\d+\. \[([a-z0-9-]+)\] .* · (\d+) steps?$/gm)]
const ids = rows.map((row) => row[1])
steps.push(...rows.map((row) => Number(row[2])))
await pause(1600)
await idle()

await caption('Step through it like a slide deck', '→ steps · ↑ ↓ slides · every channel is an interruptible spring')
await walk(1500, 600) // title
await next()
await walk(1300, 1200) // overview
await next()
await walk(1400, 1800) // scope
await next()
await walk(1200, 1600) // section
await next()

await caption('Behavior first: the bug plays out…', 'Sequence diagrams replay the broken restart, then the fix in the same slots.')
await walk(1250, 1400)
await next()

await caption('Architecture, with status and travelling packets', 'Press T to switch themes: midnight, tokyo, evergreen, paper.')
await walk(2300, 1600)
for (let i = 0; i < 4; i++) {
  await page.keyboard.press('t')
  await pause(1300)
}
await next()

await caption('Then the code — and it keeps its *identity*', 'Stepped diffs: only changed lines enter or leave; re-indented lines glide sideways.')
await walk(2300, 2200)
await next()
await caption('Review mode for deletions, callouts for the parts that matter')
await walk(1600, 2000)
await next()
await walk(2600, 1400) // tests
await next()

await caption('Numbers roll from before to after')
await walk(1500, 3200) // metrics
await next()

// Review together: comment in the viewer, the agent applies it live.
const listening = agent('wait_for_feedback', { timeout_seconds: 300 }, 'listening for your change plan…')
await caption('Review *together*', 'Press C, comment on a slide, and send the change plan to the agent that built the deck.')
await pause(1800)
await page.keyboard.press('c')
await pause(1400)
await page.locator('.fb-tab', { hasText: 'Change plan' }).click()
await pause(1200)
await page.locator('.fb-input').click()
await page.keyboard.type('Lead with the number people feel: restarts take 140 ms now.', { delay: 34 })
await pause(500)
await page.keyboard.press('Enter')
await pause(1300)
await page.locator('.plan-actions .fb-send').click()
const plan = await listening
const request = plan.match(/fb-[a-z0-9]+/)![0]
await caption('The agent edits the slide, then replies', 'update_slide changes it in place; resolve_feedback answers in the thread.')
await pause(1600)
const compare = showcase.findIndex((slide) => slide.type === 'compare')
await agent('update_slide', { slide_id: ids[compare], slide: { ...showcase[compare], title: 'Restarts take *140 ms* now, not 15 s' } }, '“Restarts take 140 ms now, not 15 s”')
await pause(2200)
await agent('resolve_feedback', { items: [{ id: request, reply: 'Retitled the slide around the 140 ms restart; the before/after points stay.' }] }, 'done · “Retitled the slide…”')
await pause(3600)
await idle()
await page.keyboard.press('c')
await pause(1000)
await walk(2200, 0) // compare: the "after" column
await next()

await caption('End on what reviewers should check')
await walk(1100, 1600)
await pause(600)
await page.keyboard.press('o')
await caption('Every slide at a glance', 'Export any deck as one self-contained HTML file with export_deck.')
await pause(3600)

await page.evaluate(() => window.rec.card(`<h1>Ferry</h1><h2>Install it with <em>one prompt</em></h2><p>Paste the install prompt from the README into Claude Code, Cursor, or any MCP client — then ask:</p><code>Explain the changes on this branch with a Ferry presentation.</code>`))
await pause(5200)

// ── encode ───────────────────────────────────────────────────────────────
const stoppedAt = Date.now() / 1000
await cdp.send('Page.stopScreencast')
await browser.close()
await client.close()

const list = ['ffconcat version 1.0']
frames.forEach((frame, i) => {
  list.push(`file '${frame.file}'`, `duration ${((frames[i + 1]?.at ?? stoppedAt) - frame.at).toFixed(4)}`)
})
list.push(`file '${frames.at(-1)!.file}'`)
writeFileSync(join(home, 'frames.txt'), list.join('\n'))
mkdirSync(dirname(out), { recursive: true })
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(home, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', out], { stdio: 'inherit' })
rmSync(home, { recursive: true, force: true })
console.log(`Recorded ${out} (${frames.length} frames, ${Math.round(stoppedAt - frames[0].at)} s)`)

// ── in-page overlay: caption band, tool-call chip, title cards ───────────
declare global {
  interface Window {
    rec: { caption(title: string, sub: string): void; tool(name: string, detail: string): void; card(html: string): void; hideCard(): void }
  }
}

function stage(band: number) {
  const css = `
    .player { bottom: ${band}px !important; }
    #rec-band { position: fixed; left: 0; right: 0; bottom: 0; height: ${band}px; z-index: 100; display: flex; align-items: center; gap: 48px; padding: 0 64px; box-sizing: border-box; background: #0b0a09; border-top: 1px solid rgba(255,255,255,.07); color: #f4efe8; font-family: Inter, sans-serif; }
    #rec-caption { position: relative; flex: 1; height: 100%; }
    .rec-line { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 8px; transition: opacity .5s, transform .6s cubic-bezier(.2,.8,.2,1); }
    .rec-line.in, .rec-line.out { opacity: 0; transform: translateY(12px); }
    .rec-line.out { transform: translateY(-12px); }
    .rec-line b { font: 600 29px/1.15 Inter; letter-spacing: -0.025em; }
    .rec-line b em { font: italic 400 1.2em/1 'Instrument Serif'; letter-spacing: 0; color: #ff9d5c; }
    .rec-line span { font: 400 19px/1.3 Inter; color: #9d948a; }
    #rec-tool { display: flex; align-items: center; gap: 14px; max-width: 760px; padding: 14px 20px; border-radius: 14px; background: #151311; border: 1px solid rgba(255,255,255,.08); font: 500 17px/1 'JetBrains Mono', monospace; color: #9d948a; white-space: nowrap; overflow: hidden; opacity: 0; transition: opacity .4s; }
    #rec-tool.on { opacity: 1; }
    #rec-tool small { font: 600 12px/1 'JetBrains Mono', monospace; letter-spacing: .14em; color: #6b635b; }
    #rec-tool i { flex: none; width: 9px; height: 9px; border-radius: 50%; background: #ff8a3d; }
    #rec-tool.pulse i { animation: rec-pulse .9s ease-out; }
    #rec-tool b { font-weight: 600; color: #ffc799; }
    #rec-tool span { overflow: hidden; text-overflow: ellipsis; }
    @keyframes rec-pulse { from { box-shadow: 0 0 0 0 rgba(255,138,61,.75); } to { box-shadow: 0 0 0 16px rgba(255,138,61,0); } }
    #rec-card { position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; text-align: center; background: radial-gradient(ellipse 70% 60% at 78% 0%, rgba(255,138,61,.20), transparent 70%), radial-gradient(ellipse 60% 50% at 10% 100%, rgba(114,184,255,.07), transparent 70%), #0b0a09; color: #f4efe8; font-family: Inter, sans-serif; opacity: 0; transition: opacity .9s; }
    #rec-card.on { opacity: 1; }
    #rec-card:not(.on) { pointer-events: none; }
    #rec-card .logo { width: 96px; height: 96px; color: #ff8a3d; }
    #rec-card h1 { margin: -10px 0 0; font: 400 168px/1 'Instrument Serif'; letter-spacing: -0.02em; }
    #rec-card h2 { margin: 0; font: 500 44px/1.2 Inter; letter-spacing: -0.03em; }
    #rec-card h2 em { font: italic 400 1.2em/1 'Instrument Serif'; letter-spacing: 0; color: #ff8a3d; }
    #rec-card p { margin: 8px 0 0; max-width: 1080px; font: 400 27px/1.45 Inter; color: #9d948a; }
    #rec-card code { margin-top: 6px; padding: 16px 26px; border-radius: 14px; font: 500 25px/1 'JetBrains Mono', monospace; color: #ffc799; background: #151311; border: 1px solid rgba(255,255,255,.09); }
  `
  const LOGO = `<svg viewBox="0 0 32 32" class="logo" aria-hidden="true"><path d="M5 20.5c3.6 3 7.4 3 11 0s7.4-3 11 0" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8 25.5c2.7 2 5.3 2 8 0s5.3-2 8 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".45"/><circle cx="16" cy="10.5" r="3.6" fill="currentColor"/></svg>`
  const html = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\*(.+?)\*/g, '<em>$1</em>')
  addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style')
    style.textContent = css
    const bar = Object.assign(document.createElement('div'), { id: 'rec-band', innerHTML: '<div id="rec-caption"></div><div id="rec-tool"></div>' })
    const card = Object.assign(document.createElement('div'), { id: 'rec-card' })
    document.head.append(style)
    card.className = 'on'
    document.body.append(bar, card)
  })
  window.rec = {
    caption(title, sub) {
      const box = document.getElementById('rec-caption')!
      for (const old of box.children) {
        old.classList.add('out')
        setTimeout(() => old.remove(), 600)
      }
      const line = Object.assign(document.createElement('div'), { className: 'rec-line in', innerHTML: `<b>${html(title)}</b>${sub ? `<span>${html(sub)}</span>` : ''}` })
      box.append(line)
      requestAnimationFrame(() => requestAnimationFrame(() => line.classList.remove('in')))
    },
    tool(name, detail) {
      const chip = document.getElementById('rec-tool')!
      if (!name) return chip.classList.remove('on')
      chip.innerHTML = `<small>MCP</small><i></i><b>${html(name)}</b>${detail ? `<span>${html(detail)}</span>` : ''}`
      chip.classList.remove('pulse')
      void chip.offsetWidth
      chip.classList.add('on', 'pulse')
    },
    card(content) {
      const card = document.getElementById('rec-card')!
      card.innerHTML = LOGO + content
      card.classList.add('on')
    },
    hideCard() {
      document.getElementById('rec-card')!.classList.remove('on')
    },
  }
}
