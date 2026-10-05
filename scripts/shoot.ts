// Visual check: walks a deck in headless Chromium and screenshots every step.
// usage: node scripts/shoot.ts <deck-url> [outDir] [--slides 1,5] [--theme paper] [--mid]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchBrowser } from './browser.ts'

const [url, out = '/tmp/ferry-shots'] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))
const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const only = flag('slides')?.split(',').map(Number)
const theme = flag('theme')
const mid = process.argv.includes('--mid')
mkdirSync(out, { recursive: true })

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
const errors: string[] = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))
if (theme) await page.addInitScript((t) => localStorage.setItem(`ferry-theme:${location.pathname.split('/').pop()}`, t), theme)

await page.goto(url)
await page.waitForTimeout(1500)
const count = await page.locator('.seg').count()
for (let s = 1; s <= count; s++) {
  if (only && !only.includes(s)) continue
  await page.evaluate((n) => (location.hash = `#${n}`), s)
  await page.waitForTimeout(400)
  await page.keyboard.press('r') // replay: enter the slide with its entrance motion
  await page.waitForTimeout(2200)
  let step = 1
  await page.screenshot({ path: join(out, `s${String(s).padStart(2, '0')}-${step}.png`) })
  for (;;) {
    const before = await page.evaluate(() => location.hash)
    await page.keyboard.press('ArrowRight')
    if (mid) {
      await page.waitForTimeout(380)
      await page.screenshot({ path: join(out, `s${String(s).padStart(2, '0')}-${step + 1}-mid.png`) })
    }
    await page.waitForTimeout(mid ? 1800 : 2200)
    const after = await page.evaluate(() => location.hash)
    const slide = Number(after.slice(1).split('.')[0])
    if (slide !== s || after === before) break
    step++
    await page.screenshot({ path: join(out, `s${String(s).padStart(2, '0')}-${step}.png`) })
  }
}
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
