import type { Callout, DiffLine, DiffSlide } from '../../../src/model.ts'
import { Spring } from '../motion.ts'
import { clamp, h, head, Narrative, pips, svg, tokens, type GoOptions, type SlideView, type ViewContext } from '../dom.ts'
import { icon } from '../icons.ts'

const PAD = 18
/** How long a removed line stays red before it collapses. */
const HOLD = 0.42

interface LineState {
  d: DiffLine
  el: HTMLElement
  no: HTMLElement | null
  code: HTMLElement | null
  inner: HTMLElement
  h: Spring
  op: Spring
  mark: Spring
  dim: Spring
  x: Spring
  /** Indentation offset in characters (re-indented lines glide into place). */
  indent: Spring
  y: number
  /** Current horizontal offset of the code in pixels. */
  ox: number
  written: string
}

interface CalloutState {
  c: Callout
  line: LineState
  group: HTMLElement
  box: HTMLElement
  label: HTMLElement
  path: SVGPathElement
  dot: HTMLElement
  side: 'right' | 'below' | 'above'
  width: number
  height: number
}

export function diffView(slide: DiffSlide, ctx: ViewContext): SlideView {
  const { clock } = ctx
  const review = slide.mode === 'review'
  const narrative = new Narrative()
  const linesEl = h('div', { class: 'ed-lines' })
  const calloutLayer = h('div', { class: 'callouts' })
  const leaderSvg = svg('svg', { class: 'leaders' })
  calloutLayer.append(leaderSvg)
  const thumb = h('div', { class: 'ruler-thumb' })
  const ruler = h('div', { class: 'ruler' }, thumb)
  const body = h('div', { class: 'ed-body' }, linesEl, calloutLayer, ruler)

  const path = slide.file ?? ''
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
  const name = path.slice(dir.length) || slide.language
  const bar = h(
    'div',
    { class: 'ed-bar', 'data-ref': 'file header', 'data-label': path || slide.language },
    h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
    h('span', { class: 'ed-file', html: `${icon('file', 15)}<span class="ed-dir">${dir}</span><b>${name}</b>` }),
    h('span', { class: 'ed-spacer' }),
    slide.additions ? h('span', { class: 'chip add' }, `+${slide.additions}`) : null,
    slide.deletions ? h('span', { class: 'chip del' }, `−${slide.deletions}`) : null,
    h('span', { class: 'ed-lang' }, slide.language),
  )
  const editor = h('div', { class: 'editor' }, bar, body)
  const el = h('section', { class: 'slide slide-diff' }, head(slide), h('div', { class: 'split' }, narrative.el, editor))

  const changeSteps = slide.steps.length - 1
  const visible = (d: DiffLine, k: number) =>
    d.op === 'keep' || (d.op === 'add' ? k >= d.step : review ? k <= d.step : k < d.step)
  const markTarget = (d: DiffLine, k: number) => {
    if (d.op === 'add') return k === d.step ? 1 : k > d.step ? 0.22 : 0
    if (d.op === 'remove') return review && k === d.step ? 1 : 0
    return 0
  }

  const indentTarget = (d: DiffLine, k: number) => (d.shift && k < d.step ? d.shift : 0)

  const lines: LineState[] = slide.lines.map((d) => {
    const inner = h('div', { class: 'ln-inner' })
    let noEl: HTMLElement | null = null
    let codeEl: HTMLElement | null = null
    if (d.kind === 'fold') {
      inner.append(h('span', { class: 'ln-no' }), h('span', { class: 'ln-sign' }), h('span', { class: 'ln-fold' }, h('i'), h('span', {}, `⋯  ${d.tokens[0]?.[0] ?? ''}`), h('i')))
    } else {
      const code = h('span', { class: 'ln-code' })
      codeEl = code
      code.append(tokens(d.tokens, slide.palette))
      noEl = h('span', { class: 'ln-no' }, d.nos?.[0] ? String(d.nos[0]) : '')
      inner.append(noEl, h('span', { class: 'ln-sign' }, d.op === 'add' ? '+' : d.op === 'remove' ? '−' : ''), code)
    }
    const lineEl = h('div', { class: `ln ${d.op}${d.kind === 'fold' ? ' fold' : ''}`, 'data-ref': d.kind === 'fold' ? 'folded lines' : `${d.op === 'add' ? 'added' : d.op === 'remove' ? 'removed' : 'code'} line`, 'data-label': d.kind === 'fold' ? d.tokens[0]?.[0] : d.text.trim() || '(blank line)' }, inner)
    linesEl.append(lineEl)
    const shown = visible(d, 0) ? 1 : 0
    return {
      d,
      el: lineEl,
      no: noEl,
      code: codeEl,
      inner,
      h: new Spring(shown, { precision: 0.0005 }),
      op: new Spring(shown),
      mark: new Spring(markTarget(d, 0)),
      dim: new Spring(0),
      x: new Spring(0, { precision: 0.05 }),
      indent: new Spring(indentTarget(d, 0), { precision: 0.005 }),
      y: 0,
      ox: 0,
      written: '',
    }
  })
  const byId = new Map(lines.map((l) => [l.d.id, l]))
  const scroll = new Spring(0, { precision: 0.1 })

  let LH = 30
  let charW = 12
  let codeLeft = 80
  let bodyW = 1200
  let bodyH = 700
  let step = 0
  let callouts: CalloutState[] = []
  let renumberTimer = 0

  function attached() {
    bodyW = body.clientWidth
    bodyH = body.clientHeight
    const codeLines = slide.lines.filter((l) => l.kind === 'code')
    const maxChars = Math.max(40, ...codeLines.map((l) => l.text.trimEnd().length))
    const maxNo = Math.max(1, ...codeLines.flatMap((l) => l.nos ?? [l.newNo ?? l.oldNo ?? 0]))
    const digits = String(maxNo).length
    const available = bodyW - 40 - (digits + 4) * 11
    const fontSize = clamp(Math.floor(available / (maxChars * 0.6 + 1)), 13, codeLines.length < 18 ? 24 : 21)
    LH = Math.round(fontSize * 1.68)
    const probe = h('span', { class: 'ln-code', style: `font-size:${fontSize}px;position:absolute;visibility:hidden;white-space:pre` }, 'x'.repeat(100))
    body.append(probe)
    charW = probe.offsetWidth / 100 || fontSize * 0.6
    probe.remove()
    const gutter = Math.ceil((digits + 1) * charW + 18)
    codeLeft = gutter + 26
    editor.style.setProperty('--fs', `${fontSize}px`)
    editor.style.setProperty('--lh', `${LH}px`)
    editor.style.setProperty('--gutter', `${gutter}px`)
  }

  /** Target y of every line at step k (no motion). */
  function layout(k: number) {
    const ys = new Map<string, number>()
    let y = PAD
    for (const l of lines) {
      ys.set(l.d.id, y)
      if (visible(l.d, k)) y += LH
    }
    return { ys, total: y + PAD }
  }

  function scrollTarget(k: number) {
    const { ys, total } = layout(k)
    const s = slide.steps[k]
    const interest = new Set<string>()
    for (const l of lines) if (l.d.step === k && k > 0) interest.add(l.d.id)
    if (k === 0) for (const l of lines) if (l.d.step === 1) interest.add(l.d.id)
    for (const id of s.focus ?? []) interest.add(id)
    for (const c of s.callouts ?? []) interest.add(c.lineId)
    const max = Math.max(0, total - bodyH)
    if (!interest.size || max === 0) return clamp(scroll.destination, 0, max)
    const positions = [...interest].map((id) => ys.get(id)!).filter((y) => y !== undefined)
    const top = Math.min(...positions)
    const bottom = Math.max(...positions) + LH
    const target = bottom - top > bodyH - LH * 3 ? top - LH * 2 : (top + bottom) / 2 - bodyH / 2
    return clamp(target, 0, max)
  }

  function rulerTicks(k: number) {
    ruler.querySelectorAll('.tick').forEach((t) => t.remove())
    const { ys, total } = layout(k)
    ruler.classList.toggle('on', total > bodyH + 2)
    if (total <= bodyH + 2) return
    for (const l of lines) {
      if (l.d.op === 'keep' || !visible(l.d, k)) continue
      const tick = h('i', { class: `tick ${l.d.op}${l.d.step === k ? ' now' : ''}`, style: `top:${(ys.get(l.d.id)! / total) * 100}%;height:${Math.max(2, (LH / total) * bodyH)}px` })
      ruler.append(tick)
    }
    ruler.dataset.total = String(total)
  }

  function go(k: number, { instant, direction }: GoOptions) {
    const t = clock.now()
    const prev = step
    step = k
    const forward = direction === 1 && !instant
    const leaving = new Set(lines.filter((l) => visible(l.d, prev) && !visible(l.d, k)))
    const entering = new Set(lines.filter((l) => !visible(l.d, prev) && visible(l.d, k)))
    const hold = forward && !review && [...leaving].some((l) => l.d.op === 'remove') ? HOLD : 0
    const s = slide.steps[k]
    const focus = new Set(s.focus ?? [])
    if (focus.size) for (const c of s.callouts ?? []) focus.add(c.lineId)

    for (const l of lines) {
      const shown = visible(l.d, k) ? 1 : 0
      const mark = markTarget(l.d, k)
      const dim = focus.size && !focus.has(l.d.id) ? 1 : 0
      l.el.classList.toggle('struck', review && l.d.op === 'remove' && k === l.d.step)

      if (instant) {
        l.h.snap(shown, t)
        l.op.snap(shown, t)
        l.mark.snap(mark, t)
        l.dim.snap(dim, t)
        l.x.snap(0, t)
        l.indent.snap(indentTarget(l.d, k), t)
        continue
      }
      l.indent.to(indentTarget(l.d, k), t, { duration: 0.62, delay: forward ? hold : 0 })
      if (forward && leaving.has(l) && l.d.op === 'remove') {
        l.mark.to(1, t, { duration: 0.22 })
        l.h.to(0, t, { delay: hold, duration: 0.55 })
        l.op.to(0, t, { delay: hold, duration: 0.3 })
      } else if (forward && entering.has(l)) {
        l.h.to(1, t, { delay: hold, duration: 0.6 })
        l.op.snap(0, t)
        l.op.to(1, t, { delay: hold + 0.16, duration: 0.45 })
        l.x.snap(-16, t)
        l.x.to(0, t, { delay: hold + 0.16, duration: 0.55 })
        l.mark.to(mark, t, { delay: hold + 0.1, duration: 0.3 })
        l.el.classList.remove('sweep')
        setTimeout(() => {
          void l.el.offsetWidth
          l.el.classList.add('sweep')
        }, (hold + 0.25) * 1000 / clock.speed)
      } else {
        l.h.to(shown, t, { duration: 0.55 })
        l.op.to(shown, t, { duration: shown ? 0.5 : 0.3 })
        l.mark.to(mark, t, { duration: 0.5 })
        l.x.to(0, t, { duration: 0.4 })
      }
      l.dim.to(dim, t, { duration: 0.45 })
    }

    // Renumber once removed lines have had their moment.
    clearTimeout(renumberTimer)
    const renumber = () => {
      for (const l of lines) {
        const n = l.d.nos?.[k]
        if (l.no && (n || l.el.classList.contains('struck'))) l.no.textContent = n ? String(n) : ''
      }
    }
    if (instant || !hold) renumber()
    else renumberTimer = window.setTimeout(renumber, ((hold + 0.15) * 1000) / clock.speed)

    const target = scrollTarget(k)
    if (instant) scroll.snap(target, t)
    else scroll.to(target, t, { duration: 0.85, delay: forward ? hold * 0.6 : 0 })

    const label = k === 0 ? (changeSteps ? 'Before' : 'Walkthrough') : `${slide.lines.some((l) => l.op !== 'keep') ? 'Change' : 'Step'} ${k} <span class="of">/ ${changeSteps}</span>`
    const stats = k > 0 && (s.additions || s.deletions) ? `${s.additions ? `<span class="add">+${s.additions}</span>` : ''}${s.deletions ? `<span class="del">−${s.deletions}</span>` : ''} <span class="muted">in this step</span>` : undefined
    narrative.set(`${label}${pips(slide.steps.length, k)}`, s.titleHtml, s.noteHtml, instant, stats)
    rulerTicks(k)
    setCallouts(s.callouts ?? [], instant ? 0 : forward ? hold + (entering.size ? 0.6 : 0.2) : 0.15)
    ctx.wake()
  }

  function setCallouts(next: Callout[], delay: number) {
    for (const old of callouts) {
      old.group.classList.remove('on')
      old.path.classList.remove('on')
      setTimeout(() => {
        old.group.remove()
        old.path.remove()
      }, 300)
    }
    callouts = []
    for (const c of next) {
      const line = byId.get(c.lineId)
      if (!line) continue
      const box = h('div', { class: 'co-box' })
      const dot = h('div', { class: 'co-dot' })
      const label = h('div', { class: 'co-label' }, c.text)
      const group = h('div', { class: `co tone-${c.tone}` }, box, dot, label)
      const p = svg('path', { class: `co-path tone-${c.tone}`, pathLength: 1 })
      calloutLayer.append(group)
      leaderSvg.append(p)
      const state: CalloutState = { c, line, group, box, label, path: p, dot, side: 'right', width: label.offsetWidth, height: label.offsetHeight }
      state.side = chooseSide(state)
      callouts.push(state)
      group.style.setProperty('--d', `${delay}s`)
      p.style.setProperty('--d', `${delay + 0.12}s`)
      requestAnimationFrame(() => {
        group.classList.add('on')
        p.classList.add('on')
      })
    }
  }

  function chooseSide(s: CalloutState): CalloutState['side'] {
    const textEnd = codeLeft + s.line.d.text.trimEnd().length * charW
    const anchorEnd = codeLeft + s.c.end * charW
    if (Math.max(textEnd, anchorEnd) + 44 + s.width < bodyW - 28) return 'right'
    const { ys } = layout(step)
    const visibleLines = lines.filter((l) => visible(l.d, step))
    const i = visibleLines.indexOf(s.line)
    const x0 = codeLeft + s.c.start * charW
    const overlap = (l?: LineState) => {
      if (!l) return 0
      const end = codeLeft + l.d.text.trimEnd().length * charW
      return Math.max(0, Math.min(end, x0 + s.width) - x0)
    }
    const y = ys.get(s.line.d.id)!
    if (y - s.height - 12 < scroll.destination + 4) return 'below'
    return overlap(visibleLines[i + 1]) <= overlap(visibleLines[i - 1]) ? 'below' : 'above'
  }

  function placeCallouts(scrollY: number) {
    for (const s of callouts) {
      const y = s.line.y - scrollY
      const mid = y + LH / 2
      const x0 = codeLeft + s.line.ox + s.c.start * charW - 4
      const x1 = codeLeft + s.line.ox + s.c.end * charW + 4
      s.box.style.transform = `translate(${x0}px, ${y + 2}px)`
      s.box.style.width = `${Math.max(8, x1 - x0)}px`
      s.box.style.height = `${LH - 4}px`
      let lx: number
      let ly: number
      let d: string
      if (s.side === 'right') {
        const textEnd = codeLeft + s.line.ox + s.line.d.text.trimEnd().length * charW
        const start = textEnd > x1 + charW ? textEnd + 12 : x1
        lx = Math.max(textEnd, x1) + 44
        ly = mid - s.height / 2
        d = `M${start} ${mid} L${lx} ${mid}`
        s.dot.style.transform = `translate(${start}px, ${mid}px)`
      } else {
        const below = s.side === 'below'
        lx = clamp(x0, codeLeft, bodyW - s.width - 28)
        ly = below ? y + LH + 14 : y - s.height - 14
        const ax = Math.min(x0 + 14, x1)
        const ay = below ? y + LH - 2 : y + 2
        d = `M${ax} ${ay} L${ax} ${below ? ly : ly + s.height}`
        s.dot.style.transform = `translate(${ax}px, ${ay}px)`
      }
      s.label.style.transform = `translate(${lx}px, ${ly}px)`
      if (s.path.getAttribute('d') !== d) s.path.setAttribute('d', d)
    }
  }

  function frame(now: number): boolean {
    let y = PAD
    let busy = false
    for (const l of lines) {
      const hv = l.h.value(now)
      const top = y
      l.y = top
      y += hv * LH
      const op = l.op.value(now)
      const mark = l.mark.value(now)
      const dim = l.dim.value(now)
      const x = l.x.value(now)
      const indent = l.indent.value(now)
      l.ox = x + indent * charW
      busy ||= !(l.h.settled(now) && l.op.settled(now) && l.mark.settled(now) && l.dim.settled(now) && l.x.settled(now) && l.indent.settled(now))
      const hidden = hv < 0.002 && op < 0.01
      const key = hidden ? 'h' : `${top.toFixed(2)}|${hv.toFixed(3)}|${op.toFixed(3)}|${mark.toFixed(3)}|${dim.toFixed(3)}|${l.ox.toFixed(2)}`
      if (key === l.written) continue
      l.written = key
      if (hidden) {
        l.el.style.display = 'none'
        continue
      }
      l.el.style.display = ''
      l.el.style.transform = `translate3d(0, ${top}px, 0)`
      l.el.style.height = `${hv * LH}px`
      l.el.style.setProperty('--m', mark.toFixed(3))
      l.inner.style.opacity = (op * (1 - 0.68 * dim)).toFixed(3)
      if (l.code) l.code.style.transform = l.ox ? `translateX(${l.ox}px)` : ''
    }
    const total = y + PAD
    const sy = scroll.value(now)
    busy ||= !scroll.settled(now)
    linesEl.style.transform = `translate3d(0, ${-sy}px, 0)`
    if (total > bodyH) {
      thumb.style.top = `${(sy / total) * 100}%`
      thumb.style.height = `${(bodyH / total) * 100}%`
    }
    placeCallouts(sy)
    return busy
  }

  return { el, steps: slide.steps.length, attached, go, frame }
}
