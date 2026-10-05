// Standalone export: one HTML file with the viewer, fonts, and deck inlined.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { buildViewer, FONT_FILES, viewerAsset } from './build.ts'
import type { StoredDeck } from './store.ts'
import { escapeHtml } from './text.ts'

export async function exportDeck(deck: StoredDeck, path: string): Promise<{ path: string; bytes: number }> {
  await buildViewer()
  let css = await readFile(viewerAsset('viewer.css'), 'utf8')
  for (const [name, file] of Object.entries(FONT_FILES)) {
    const data = (await readFile(file)).toString('base64')
    css = css.split(`/fonts/${name}`).join(`data:font/woff2;base64,${data}`)
  }
  const js = await readFile(viewerAsset('viewer.js'), 'utf8')
  const { source, ...compiled } = deck
  void source
  const data = JSON.stringify(compiled).replace(/</g, '\\u003c')
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(deck.title)}</title>
<style>${css}</style>
</head>
<body>
<div id="app"></div>
<script id="ferry-deck" type="application/json">${data}</script>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, html)
  return { path, bytes: Buffer.byteLength(html) }
}
