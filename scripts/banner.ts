// Renders docs/banner.png, the README header, with the viewer's fonts and palette.
// usage: node scripts/banner.ts [out.png]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FONT_FILES } from '../src/build.ts'
import { launchBrowser } from './browser.ts'

const out = process.argv[2] ?? join(import.meta.dirname, '..', 'docs', 'banner.png')
const font = (name: string) => `url(data:font/woff2;base64,${readFileSync(FONT_FILES[name]).toString('base64')}) format('woff2')`

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 20.5c3.6 3 7.4 3 11 0s7.4-3 11 0" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8 25.5c2.7 2 5.3 2 8 0s5.3-2 8 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".45"/><circle cx="16" cy="10.5" r="3.6" fill="currentColor"/></svg>`

// The fix from the demo deck, as the viewer would show it mid-walkthrough.
const k = (s: string) => `<i class="k">${s}</i>`
const f = (s: string) => `<i class="f">${s}</i>`
const n = (s: string) => `<i class="n">${s}</i>`
const lines: [number, '' | '+' | '-', string][] = [
  [7, '', `${k('export async function')} ${f('bind')}(port: ${k('number')}) {`],
  [8, '', `  ${k('const')} server = ${f('createServer')}()`],
  [9, '+', `  ${k('const')} deadline = Date.${f('now')}() + DEADLINE`],
  [10, '+', `  ${k('for')} (;;) {<b class="callout">retry until the deadline</b>`],
  [11, '', `    ${k('try')} {`],
  [12, '', `      ${k('await')} ${f('listen')}(server, port)`],
  [13, '', `      ${k('return')} server`],
  [14, '', `    } ${k('catch')} (error) {`],
  [15, '-', `      ${k('return')} ${f('waitForIncumbent')}(port, ${n('15_000')})`],
  [16, '+', `      ${k('if')} (incumbent?.alive) ${k('throw')} ${k('new')} ${f('AlreadyRunning')}()`],
  [17, '+', `      ${k('await')} ${f('sleep')}(RETRY_INTERVAL)`],
]
const code = lines.map(([no, mark, text]) => `<div class="ln ${mark === '+' ? 'add' : mark === '-' ? 'del' : ''}"><span class="no">${no}</span><span class="mk">${mark}</span><span class="tx">${text}</span></div>`).join('')
const segments = Array.from({ length: 12 }, (_, i) => `<i class="${i < 4 ? 'on' : i === 4 ? 'now' : ''}"></i>`).join('')

const html = `<!doctype html><html><head><style>
  @font-face { font-family: Inter; src: ${font('inter.woff2')}; font-weight: 100 900; }
  @font-face { font-family: 'JetBrains Mono'; src: ${font('mono.woff2')}; font-weight: 100 800; }
  @font-face { font-family: 'Instrument Serif'; src: ${font('serif.woff2')}; }
  @font-face { font-family: 'Instrument Serif'; src: ${font('serif-italic.woff2')}; font-style: italic; }
  html, body { margin: 0; background: transparent; -webkit-font-smoothing: antialiased; }
  .banner { position: relative; width: 1280px; height: 360px; overflow: hidden; border-radius: 22px; color: #f4efe8; font-family: Inter;
    background: radial-gradient(ellipse 620px 360px at 92% -12%, rgba(255,138,61,.30), transparent 70%), radial-gradient(ellipse 520px 300px at 4% 118%, rgba(114,184,255,.10), transparent 70%), #0b0a09; }
  .banner::before { content: ''; position: absolute; inset: 0; background-image: radial-gradient(rgba(255,236,214,.07) 1px, transparent 1.2px); background-size: 22px 22px; mask-image: linear-gradient(90deg, #000, transparent 75%); }
  .banner::after { content: ''; position: absolute; inset: 0; border-radius: 22px; box-shadow: inset 0 0 0 1px rgba(255,236,214,.09); pointer-events: none; }
  .copy { position: absolute; left: 72px; top: 54px; width: 560px; }
  .brand { display: flex; align-items: center; gap: 18px; }
  .brand svg { width: 58px; height: 58px; color: #ff8a3d; margin-top: 6px; }
  .brand h1 { margin: 0; font: 400 112px/0.9 'Instrument Serif'; letter-spacing: -0.02em; }
  h2 { margin: 22px 0 0; font: 500 36px/1.15 Inter; letter-spacing: -0.035em; }
  h2 em { font: italic 400 1.22em/1 'Instrument Serif'; letter-spacing: 0; color: #ff8a3d; }
  p { margin: 16px 0 0; max-width: 500px; text-wrap: balance; font: 400 18px/1.5 Inter; color: #a39a8f; letter-spacing: -0.005em; }
  .bar { position: absolute; left: 72px; bottom: 40px; display: flex; align-items: center; gap: 18px; font: 600 12px/1 'JetBrains Mono'; letter-spacing: .16em; color: #6f675e; }
  .segs { display: flex; gap: 5px; }
  .segs i { width: 22px; height: 3px; border-radius: 2px; background: rgba(255,236,214,.12); }
  .segs i.on { background: rgba(255,199,153,.55); }
  .segs i.now { background: linear-gradient(90deg, #ff8a3d 55%, rgba(255,236,214,.12) 55%); }
  .editor { position: absolute; left: 690px; top: 46px; width: 660px; height: 340px; border-radius: 18px; background: #0f0e0c; border: 1px solid rgba(255,236,214,.12);
    box-shadow: 0 40px 90px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.04); overflow: hidden; }
  .ed-bar { height: 44px; display: flex; align-items: center; gap: 12px; padding: 0 18px; border-bottom: 1px solid rgba(255,236,214,.07); background: #131210; font: 500 13px/1 'JetBrains Mono'; color: #8a8075; }
  .dots { display: flex; gap: 7px; margin-right: 6px; } .dots i { width: 10px; height: 10px; border-radius: 50%; background: rgba(255,236,214,.14); }
  .ed-bar b { color: #ece6de; font-weight: 500; }
  .pill { margin-left: 10px; padding: 4px 8px; border-radius: 6px; font-size: 12px; } .pill.a { color: #5fd38f; background: rgba(95,211,143,.12); } .pill.d { margin-left: -4px; color: #ff6e64; background: rgba(255,110,100,.12); }
  .body { padding: 10px 0; }
  .ln { position: relative; display: flex; height: 24.5px; align-items: center; font: 400 14px/1 'JetBrains Mono'; color: #ece6de; white-space: pre; font-variant-ligatures: none; }
  .ln.add { background: rgba(95,211,143,.10); box-shadow: inset 3px 0 #5fd38f; }
  .ln.del { background: rgba(255,110,100,.10); box-shadow: inset 3px 0 #ff6e64; }
  .ln.del .tx { opacity: .55; text-decoration: line-through rgba(255,110,100,.5); }
  .no { width: 44px; text-align: right; color: #5c554d; font-size: 12px; }
  .mk { width: 26px; text-align: center; color: #5c554d; } .add .mk { color: #5fd38f; } .del .mk { color: #ff6e64; }
  .k { font-style: normal; color: #ff9d5c; } .f { font-style: normal; color: #ffc799; } .n { font-style: normal; color: #f5b945; }
  .callout { position: relative; margin-left: 46px; padding: 5px 10px; border-radius: 7px; font: 600 12px/1 Inter; color: #ffc799; background: #2a1c12; border: 1px solid rgba(255,138,61,.45); }
  .callout::before { content: ''; position: absolute; right: 100%; top: 50%; width: 34px; height: 1.5px; background: #ff8a3d; }
  .callout::after { content: ''; position: absolute; right: calc(100% + 30px); top: calc(50% - 3.5px); width: 7px; height: 7px; border-radius: 50%; background: #ff8a3d; }
  .fade { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(90deg, transparent 80%, #0b0a09), linear-gradient(180deg, transparent 72%, #0b0a09 99%); }
</style></head><body>
<div class="banner">
  <div class="copy">
    <div class="brand">${LOGO}<h1>Ferry</h1></div>
    <h2>Code changes, <em>explained.</em></h2>
    <p>An MCP server that lets your coding agent build animated, live‑updating walkthroughs of any change.</p>
  </div>
  <div class="bar"><span class="segs">${segments}</span>SLIDE 05 / 12</div>
  <div class="editor"><div class="ed-bar"><span class="dots"><i></i><i></i><i></i></span>src/server/ <b>bind.ts</b><span class="pill a">+13</span><span class="pill d">−6</span></div><div class="body">${code}</div></div>
  <div class="fade"></div>
</div></body></html>`

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 360 }, deviceScaleFactor: 2 })
await page.setContent(html)
await page.evaluate(() => document.fonts.ready)
await page.locator('.banner').screenshot({ path: out, omitBackground: true })
await browser.close()
console.log(`Rendered ${out}`)
