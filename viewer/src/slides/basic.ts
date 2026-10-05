import type { CompareSlide, MarkdownSlide, MetricsSlide, Pane, PointsSlide, SectionSlide, TitleSlide } from '../../../src/model.ts'
import { clamp, h, head, tokens, words, type GoOptions, type SlideView, type ViewContext } from '../dom.ts'
import { icon } from '../icons.ts'
import { format, Rolling } from '../rolling.ts'

export interface DeckInfo {
  title: string
  repo?: string
  ref?: string
}

// ── title ─────────────────────────────────────────────────────────────────

export function titleView(slide: TitleSlide, ctx: ViewContext & { deck: DeckInfo }): SlideView {
  const title = h('h1', { class: 'hero-title', 'data-ref': 'title' })
  title.append(words(slide.titleHtml ?? '').el)
  const kicker = slide.kicker ?? [ctx.deck.repo, ctx.deck.ref].filter(Boolean).join('  ·  ')
  const counters: { roll: Rolling; value: number }[] = []
  let stats: HTMLElement | null = null
  if (slide.stats) {
    stats = h('div', { class: 'hero-stats', 'data-ref': 'stats' })
    const add = (value: number | undefined, label: string, cls: string, sign = '') => {
      if (value === undefined) return
      const roll = new Rolling(0)
      counters.push({ roll, value })
      stats!.append(h('div', { class: `stat ${cls}` }, h('div', { class: 'stat-num' }, sign ? h('span', { class: 'stat-sign' }, sign) : null, roll.el), h('div', { class: 'stat-label' }, label)))
    }
    add(slide.stats.files, slide.stats.files === 1 ? 'file changed' : 'files changed', 'files')
    add(slide.stats.additions, 'additions', 'add', '+')
    add(slide.stats.deletions, 'deletions', 'del', '−')
    const a = slide.stats.additions ?? 0
    const d = slide.stats.deletions ?? 0
    if (a + d > 0) {
      const bar = h('div', { class: 'diffstat' })
      const greens = Math.round((a / (a + d)) * 20)
      for (let i = 0; i < 20; i++) bar.append(h('i', { class: i < greens ? 'add' : 'del', style: `--i:${i}` }))
      stats.append(bar)
    }
  }
  const meta = slide.meta.length
    ? h('div', { class: 'hero-meta' }, ...slide.meta.map((m) => h('span', { class: 'meta-chip', 'data-ref': 'meta', 'data-label': `${m.label}: ${m.value}` }, h('small', {}, m.label), h('b', {}, m.value))))
    : null
  const el = h(
    'section',
    { class: 'slide slide-title' },
    h('div', { class: 'aurora' }, h('i'), h('i'), h('i')),
    h(
      'div',
      { class: 'hero' },
      kicker ? h('div', { class: 'hero-kicker' }, h('span', { class: 'brand-mark', html: icon('pr', 16) }), kicker) : null,
      title,
      slide.subtitleHtml ? h('p', { class: 'hero-sub', 'data-ref': 'subtitle', html: slide.subtitleHtml }) : null,
      meta,
      stats,
    ),
  )
  return {
    el,
    steps: 1,
    go(_k: number, { instant }: GoOptions) {
      for (const [i, c] of counters.entries()) {
        if (instant || ctx.still) c.roll.set(c.value, true)
        else {
          c.roll.set(0, true)
          setTimeout(() => c.roll.set(c.value, false, 0), (650 + i * 120) / ctx.clock.speed)
        }
      }
    },
  }
}

export function sectionView(slide: SectionSlide): SlideView {
  const title = h('h1', { class: 'sec-title', 'data-ref': 'section title' })
  title.append(words(slide.titleHtml ?? '').el)
  const el = h(
    'section',
    { class: 'slide slide-section' },
    h('div', { class: 'aurora quiet' }, h('i'), h('i')),
    h('div', { class: 'sec-num' }, slide.number ?? ''),
    h('div', { class: 'sec-text' }, slide.kicker ? h('div', { class: 'kicker' }, h('span', { class: 'kicker-dot' }), h('span', {}, slide.kicker)) : null, title, slide.subtitleHtml ? h('p', { class: 'sec-sub', html: slide.subtitleHtml }) : null),
  )
  return { el, steps: 1, go() {} }
}

// ── points ────────────────────────────────────────────────────────────────

const CHECK = '<svg viewBox="0 0 24 24" class="check" aria-hidden="true"><circle cx="12" cy="12" r="10.5"/><path d="M7.2 12.4l3.1 3.1 6.5-6.8" pathLength="1"/></svg>'

export function pointsView(slide: PointsSlide): SlideView {
  const n = slide.points.length
  const list = h('div', { class: `points ${slide.layout}`, style: `--n:${n};--cols:${n <= 3 ? n : n === 4 ? 2 : 3}` })
  const items = slide.points.map((p, i) => {
    const index = String(i + 1).padStart(2, '0')
    let item: HTMLElement
    if (slide.layout === 'checklist') {
      item = h('div', { class: `pt tone-${p.tone}` }, h('span', { class: 'pt-check', html: CHECK }), h('div', { class: 'pt-text' }, h('div', { class: 'pt-title', html: p.titleHtml }), p.bodyHtml ? h('div', { class: 'pt-body', html: p.bodyHtml }) : null), p.tag ? h('span', { class: `tag tone-${p.tone}` }, p.tag) : null)
    } else if (slide.layout === 'list') {
      item = h('div', { class: `pt tone-${p.tone}` }, h('span', { class: 'pt-index' }, index), h('div', { class: 'pt-text' }, h('div', { class: 'pt-title', html: p.titleHtml }), p.bodyHtml ? h('div', { class: 'pt-body', html: p.bodyHtml }) : null), p.tag ? h('span', { class: `tag tone-${p.tone}` }, p.tag) : null)
    } else {
      item = h('div', { class: `pt tone-${p.tone}` }, h('div', { class: 'pt-top' }, h('span', { class: 'pt-index' }, index), p.tag ? h('span', { class: `tag tone-${p.tone}` }, p.tag) : null), h('div', { class: 'pt-title', html: p.titleHtml }), p.bodyHtml ? h('div', { class: 'pt-body', html: p.bodyHtml }) : null)
    }
    item.style.setProperty('--i', String(i))
    item.dataset.ref = `point ${i + 1}`
    list.append(item)
    return item
  })
  const el = h('section', { class: 'slide slide-points' }, head(slide), list)
  return {
    el,
    steps: slide.steps.length,
    go(k: number, { instant }: GoOptions) {
      items.forEach((item, i) => {
        const on = slide.reveal === 'all' || i <= k
        item.classList.toggle('instant', instant)
        item.classList.toggle('on', on)
        item.classList.toggle('now', slide.reveal === 'stepwise' && i === k && n > 1)
        item.style.setProperty('--stagger', slide.reveal === 'all' && !instant ? `${0.25 + i * 0.09}s` : '0.08s')
      })
    },
  }
}

// ── metrics ───────────────────────────────────────────────────────────────

export function metricsView(slide: MetricsSlide, ctx: ViewContext): SlideView {
  const n = slide.metrics.length
  const grid = h('div', { class: 'metrics', style: `--cols:${n <= 4 ? n : 3}` })
  const tiles = slide.metrics.map((m, i) => {
    const roll = new Rolling(m.decimals)
    const delta = h('span', { class: 'delta' })
    const from = h('div', { class: 'metric-from' })
    let tone = 'muted'
    if (m.before !== undefined) {
      const change = m.after - m.before
      const pct = m.before !== 0 ? (change / Math.abs(m.before)) * 100 : 0
      const good = m.better ? (m.better === 'lower' ? change < 0 : change > 0) : null
      tone = change === 0 || good === null ? 'muted' : good ? 'success' : 'error'
      const arrow = change < 0 ? '↓' : change > 0 ? '↑' : '→'
      delta.innerHTML = `${arrow} ${m.before !== 0 ? `${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%` : format(Math.abs(change), m.decimals)}`
      from.innerHTML = `was <b>${format(m.before, m.decimals)}${m.unit ? ` ${m.unit}` : ''}</b>`
    }
    const tile = h(
      'div',
      { class: `metric tone-${tone}`, style: `--i:${i}`, 'data-ref': 'metric', 'data-label': m.label },
      h('div', { class: 'metric-label' }, m.label),
      h('div', { class: 'metric-value' }, roll.el, m.unit ? h('span', { class: 'metric-unit' }, m.unit) : null),
      h('div', { class: 'metric-foot' }, m.before !== undefined ? delta : null, from),
      m.noteHtml ? h('div', { class: 'metric-note', html: m.noteHtml }) : null,
    )
    grid.append(tile)
    return { m, roll, tile }
  })
  const el = h('section', { class: 'slide slide-metrics' }, head(slide), grid)
  return {
    el,
    steps: slide.steps.length,
    go(k: number, { instant }: GoOptions) {
      const after = k === slide.steps.length - 1
      tiles.forEach(({ m, roll, tile }, i) => {
        const value = after ? m.after : (m.before ?? 0)
        const fromZero = slide.steps.length === 1 && !instant && !ctx.still
        if (fromZero) {
          roll.set(0, true)
          setTimeout(() => roll.set(value, false), (500 + i * 120) / ctx.clock.speed)
        } else roll.set(value, instant, after ? i * 0.12 : 0)
        tile.classList.toggle('after', after && m.before !== undefined)
      })
    },
  }
}

// ── compare ───────────────────────────────────────────────────────────────

function pane(p: Pane): HTMLElement {
  const label = h('div', { class: `cmp-label tone-${p.tone}` }, h('span', { class: `tone-dot tone-${p.tone}` }), p.label)
  let content: HTMLElement
  if (p.kind === 'code') {
    content = h('pre', { class: 'code cmp-code' })
    const widest = Math.max(30, ...p.lines.map((l) => l.reduce((n, t) => n + t[0].length, 0)))
    content.style.setProperty('--fs', `${clamp(Math.floor(760 / (widest * 0.6)), 13, 22)}px`)
    for (const line of p.lines) {
      const row = h('div', { class: 'cl' })
      row.append(tokens(line, p.palette))
      if (!line.length) row.append(' ')
      content.append(row)
    }
  } else if (p.kind === 'points') {
    content = h('ul', { class: 'cmp-points' }, ...p.items.map((item) => h('li', { html: item })))
  } else if (p.kind === 'image') {
    content = h('div', { class: 'cmp-image' }, h('img', { src: p.src, alt: p.label }))
  } else content = h('div', { class: 'prose cmp-md', html: p.html })
  return h('div', { class: `cmp-pane ${p.kind} tone-${p.tone}`, 'data-ref': `${p.label} pane` }, label, content)
}

export function compareView(slide: CompareSlide, ctx: ViewContext): SlideView {
  const note = h('div', { class: 'cmp-note prose' })
  const s0 = slide.steps[0]
  if (s0.noteHtml) note.innerHTML = s0.noteHtml
  let body: HTMLElement
  let go: (k: number, o: GoOptions) => void
  if (slide.before.kind === 'image' && slide.after.kind === 'image') {
    const after = h('img', { src: slide.after.src, alt: slide.after.label })
    const afterWrap = h('div', { class: 'wipe-after' }, after)
    const handle = h('div', { class: 'wipe-handle' }, h('span', { html: `${icon('left', 14)}${icon('right', 14)}` }))
    const frame = h(
      'div',
      { class: 'wipe' },
      h('img', { src: slide.before.src, alt: slide.before.label }),
      afterWrap,
      handle,
      h('span', { class: `wipe-tag left tone-${slide.before.tone}` }, slide.before.label),
      h('span', { class: `wipe-tag right tone-${slide.after.tone}` }, slide.after.label),
    )
    const set = (x: number, animate: boolean) => {
      frame.classList.toggle('animate', animate)
      frame.style.setProperty('--x', `${x}%`)
    }
    frame.addEventListener('pointerdown', (event) => {
      frame.setPointerCapture(event.pointerId)
      const move = (e: PointerEvent) => {
        const rect = frame.getBoundingClientRect()
        set(clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100), false)
      }
      move(event)
      frame.addEventListener('pointermove', move)
      frame.addEventListener('pointerup', () => frame.removeEventListener('pointermove', move), { once: true })
      event.stopPropagation()
    })
    body = h('div', { class: 'cmp-wipe' }, frame)
    go = (k, { instant }) => set(k === 0 ? 100 : 50, !instant)
  } else {
    const left = pane(slide.before)
    const right = pane(slide.after)
    const arrow = h('div', { class: 'cmp-arrow', html: icon('arrow', 22) })
    body = h('div', { class: 'cmp' }, left, arrow, right)
    go = (k, { instant }) => {
      body.classList.toggle('instant', instant)
      body.classList.toggle('both', k >= 1)
    }
  }
  const el = h('section', { class: 'slide slide-compare' }, head(slide), body, note)
  void ctx
  return { el, steps: slide.steps.length, go }
}

// ── markdown ──────────────────────────────────────────────────────────────

export function markdownView(slide: MarkdownSlide): SlideView {
  const blocks = slide.blocks.map((html, i) => h('div', { class: 'md-block prose', style: `--i:${i}`, 'data-ref': `block ${i + 1}`, html }))
  const el = h('section', { class: 'slide slide-markdown' }, head(slide), h('div', { class: 'md' }, ...blocks))
  return {
    el,
    steps: slide.steps.length,
    go(k: number, { instant }: GoOptions) {
      blocks.forEach((b, i) => {
        b.classList.toggle('instant', instant)
        b.classList.toggle('on', slide.reveal === 'all' || i <= k)
        b.classList.toggle('now', slide.reveal === 'stepwise' && i === k && blocks.length > 1)
      })
    },
  }
}
