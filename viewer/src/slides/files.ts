import type { FilesSlide } from '../../../src/model.ts'
import { clamp, h, head, Narrative, pips, plural, type GoOptions, type SlideView } from '../dom.ts'
import { icon } from '../icons.ts'

const BADGE = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }

export function filesView(slide: FilesSlide): SlideView {
  const narrative = new Narrative()
  const list = h('div', { class: 'files' })
  const panel = h('div', { class: 'files-panel' }, list)
  const el = h('section', { class: 'slide slide-files' }, head(slide), h('div', { class: 'split' }, narrative.el, h('div', { class: 'visual' }, panel)))

  // Group files by directory, keeping the sorted order.
  const rows: { el: HTMLElement; file?: number; dir?: string }[] = []
  let currentDir: string | null = null
  const maxChurn = Math.max(1, ...slide.files.map((f) => f.additions + f.deletions))
  slide.files.forEach((file, i) => {
    const slash = file.path.lastIndexOf('/')
    const dir = slash >= 0 ? file.path.slice(0, slash) : ''
    const name = file.path.slice(slash + 1)
    if (dir !== currentDir) {
      currentDir = dir
      if (dir) rows.push({ el: h('div', { class: 'f-dir', html: `${icon('folder', 15)}<span>${dir}/</span>` }), dir })
    }
    const total = file.additions + file.deletions
    const blocks = h('span', { class: 'f-blocks' })
    const filled = total ? Math.max(1, Math.round((total / maxChurn) * 5)) : 0
    const greens = total ? Math.round((file.additions / total) * filled) : 0
    for (let b = 0; b < 5; b++) blocks.append(h('i', { class: b < greens ? 'add' : b < filled ? 'del' : '' }))
    rows.push({
      file: i,
      el: h(
        'div',
        { class: `f-row ${file.status}${dir ? ' nested' : ''}`, 'data-ref': 'file', 'data-label': file.path },
        h('span', { class: `f-badge ${file.status}` }, BADGE[file.status]),
        h('span', { class: 'f-name' }, name, file.oldPath ? h('small', {}, ` ← ${file.oldPath.split('/').pop()}`) : null),
        file.noteHtml ? h('span', { class: 'f-note', html: file.noteHtml }) : h('span', { class: 'f-spacer' }),
        h('span', { class: 'f-churn' }, file.additions ? h('span', { class: 'add' }, `+${file.additions}`) : null, file.deletions ? h('span', { class: 'del' }, `−${file.deletions}`) : null),
        blocks,
      ),
    })
  })
  rows.forEach((row, i) => {
    row.el.style.setProperty('--i', String(Math.min(i, 30)))
    list.append(row.el)
  })
  list.style.setProperty('--row', `${clamp(Math.floor(780 / Math.max(rows.length, 1)), 28, 50)}px`)

  const additions = slide.files.reduce((n, f) => n + f.additions, 0)
  const deletions = slide.files.reduce((n, f) => n + f.deletions, 0)

  return {
    el,
    steps: slide.steps.length,
    go(k: number, { instant }: GoOptions) {
      const lit = new Set(slide.highlights[k] ?? [])
      for (const row of rows) {
        if (row.file !== undefined) {
          row.el.classList.toggle('lit', lit.has(row.file))
          row.el.classList.toggle('dim', lit.size > 0 && !lit.has(row.file))
        } else {
          const anyLit = slide.files.some((f, i) => lit.has(i) && f.path.startsWith(`${row.dir}/`))
          row.el.classList.toggle('dim', lit.size > 0 && !anyLit)
        }
      }
      const s = slide.steps[k]
      const summary = `<span class="add">+${additions}</span><span class="del">−${deletions}</span> <span class="muted">across ${plural(slide.files.length, 'file')}</span>`
      const label = slide.steps.length > 1 ? `Group ${k + 1} <span class="of">/ ${slide.steps.length}</span>${pips(slide.steps.length, k)}` : 'Overview'
      narrative.set(label, s.titleHtml ?? (slide.steps.length === 1 ? plural(slide.files.length, 'file') + ' changed' : undefined), s.noteHtml, instant, lit.size ? `${plural(lit.size, 'file')} highlighted` : summary)
    },
  }
}
