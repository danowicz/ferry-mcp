#!/usr/bin/env node
// ferry serve | build | export <deck-id> [out.html] | list | delete <deck-id>… | mcp
import { buildViewer } from './build.ts'
import { ensureServer, holdOpen, openInBrowser } from './server.ts'
import { exportDeck } from './export.ts'
import { deleteDeck, ferryHome, listDecks, loadDeck } from './store.ts'
import { join } from 'node:path'

const [command = 'serve', ...args] = process.argv.slice(2)

switch (command) {
  case 'serve': {
    await buildViewer()
    const url = await ensureServer()
    holdOpen()
    console.log(`Ferry viewer on ${url}`)
    if (args.includes('--open')) openInBrowser(url)
    break
  }
  case 'build':
    await buildViewer(true)
    console.log('Built dist/viewer.js and dist/viewer.css')
    break
  case 'export': {
    const [id, out] = args
    if (!id) throw new Error('usage: ferry export <deck-id> [out.html]')
    const result = await exportDeck(await loadDeck(id), out ?? join(ferryHome(), 'exports', `${id}.html`))
    console.log(`Exported ${result.path} (${Math.round(result.bytes / 1024)} KB)`)
    break
  }
  case 'list':
    for (const deck of await listDecks()) console.log(`${deck.id}\t${deck.title}\t${deck.slideCount} slides`)
    break
  case 'delete':
    if (!args.length) throw new Error('usage: ferry delete <deck-id> [more deck ids]')
    for (const id of args) {
      const { title } = await loadDeck(id)
      await deleteDeck(id)
      console.log(`Deleted ${id}\t${title}`)
    }
    break
  case 'mcp':
    await import('./index.ts')
    break
  default:
    console.log('usage: ferry [serve [--open] | build | export <deck-id> [out.html] | list | delete <deck-id>… | mcp]')
}
