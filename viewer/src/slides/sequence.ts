import type { SequenceRow, SequenceSlide } from '../../../src/model.ts'
import { clamp, h, head, Narrative, pips, svg, type GoOptions, type SlideView, type ViewContext } from '../dom.ts'
import { icon } from '../icons.ts'

interface RowState {
  r: SequenceRow
  group: SVGGElement
  maskPath: SVGPathElement
  head?: SVGPathElement
  label: HTMLElement
  ring: HTMLElement
  packet: HTMLElement
  from: [number, number]
  to: [number, number]
  shown: boolean
}

const EASE = 'cubic-bezier(.45,.05,.25,1)'

export function sequenceView(slide: SequenceSlide, ctx: ViewContext): SlideView {
  const narrative = new Narrative()
  const stage = h('div', { class: 'seq' })
  const visual = h('div', { class: 'visual' }, stage)
  const el = h('section', { class: 'slide slide-seq' }, head(slide), h('div', { class: 'split' }, narrative.el, visual))
  let rows: RowState[] = []
  let phaseEl: HTMLElement
  let step = -1

  function attached() {
    const W = visual.clientWidth
    const H = visual.clientHeight
    const n = slide.participants.length
    const xs = slide.participants.map((_, i) => (W * (i + 0.5)) / n)
    const cardW = Math.min(230, W / n - 28)
    const top = 160
    const rowH = clamp((H - top - 24) / slide.slots, 54, 100)
    const yOf = (slot: number) => top + slot * rowH + rowH / 2

    const root = svg('svg', { class: 'seq-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` })
    const defs = svg('defs')
    root.append(defs)
    for (const x of xs) root.append(svg('line', { class: 'lifeline', x1: x, x2: x, y1: 132, y2: H - 8 }))
    stage.append(root)

    phaseEl = h('div', { class: 'seq-phase', 'data-ref': 'phase' })
    stage.append(phaseEl)

    slide.participants.forEach((p, i) => {
      stage.append(
        h(
          'div',
          { class: 'seq-part', style: `left:${xs[i] - cardW / 2}px;width:${cardW}px`, 'data-ref': 'participant', 'data-label': `${p.label} (id: ${p.id})` },
          p.icon ? h('span', { class: 'seq-icon', html: icon(p.icon, 18) }) : null,
          h('div', { class: 'seq-part-text' }, h('b', {}, p.label), p.detail ? h('small', {}, p.detail) : null),
        ),
      )
    })

    rows = slide.rows.map((r) => {
      const y = yOf(r.slot)
      const x1 = xs[r.from]
      const x2 = xs[r.to]
      const dir = Math.sign(x2 - x1) || 1
      const group = svg('g', { class: `seq-row tone-${r.tone} ${r.kind}` })
      const mask = svg('mask', { id: `m-${slide.id}-${r.id}`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H })
      let d: string
      let from: [number, number]
      let to: [number, number]
      let headPath: SVGPathElement | undefined
      const label = h('div', { class: `seq-label tone-${r.tone} ${r.kind}`, 'data-ref': `sequence ${r.kind}`, 'data-label': `${slide.participants[r.from].label} → ${slide.participants[r.to].label}: ${r.labelHtml.replace(/<[^>]+>/g, '')}` }, h('span', { class: 'seq-text', html: r.labelHtml }))
      if (r.asideHtml) label.append(h('small', { html: r.asideHtml }))

      if (r.kind === 'note') {
        const left = Math.min(x1, x2) - 92
        const right = Math.max(x1, x2) + 92
        d = `M${left} ${y} L${right} ${y}`
        from = [left, y]
        to = [right, y]
        label.classList.add('note-box')
        label.style.cssText = `left:${left}px;top:${y - rowH * 0.36}px;width:${right - left}px;height:${rowH * 0.72}px`
      } else if (r.from === r.to) {
        d = `M${x1 + 4} ${y - 12} C${x1 + 96} ${y - 14}, ${x1 + 96} ${y + 20}, ${x1 + 12} ${y + 18}`
        from = [x1 + 4, y - 12]
        to = [x1 + 12, y + 18]
        headPath = svg('path', { class: 'seq-head', d: `M${x1 + 22} ${y + 12} L${x1 + 9} ${y + 18} L${x1 + 22} ${y + 25}` })
        label.style.cssText = `left:${x1 + 108}px;top:${y - 16}px;transform-origin:left center`
        label.classList.add('self')
      } else {
        const a = x1 + dir * 6
        const b = x2 - dir * 8
        d = `M${a} ${y} L${b} ${y}`
        from = [a, y]
        to = [b, y]
        headPath = svg('path', { class: 'seq-head', d: `M${b - dir * 12} ${y - 7} L${b} ${y} L${b - dir * 12} ${y + 7}` })
        label.style.cssText = `left:${(x1 + x2) / 2}px;top:${y - 38}px`
        label.classList.add('centered')
      }
      const maskPath = svg('path', { d, stroke: 'white', 'stroke-width': 24, fill: 'none', pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 0 })
      mask.append(maskPath)
      defs.append(mask)
      const linePath = svg('path', { class: 'seq-line', d, mask: `url(#${mask.id})` })
      group.append(linePath)
      if (headPath) group.append(headPath)
      root.append(group)
      const ring = h('div', { class: `seq-ring tone-${r.tone}`, style: `left:${to[0]}px;top:${to[1]}px` })
      const packet = h('div', { class: `packet tone-${r.tone}` })
      stage.append(label, ring, packet)
      if (r.kind === 'note') label.style.setProperty('--y', '0px')
      return { r, group, maskPath, head: headPath, label, ring, packet, from, to, shown: false }
    })
  }

  function go(k: number, { instant, direction }: GoOptions) {
    const previous = step
    step = k
    for (const row of rows) {
      const { r } = row
      const shown = r.enter <= k && (r.exit === undefined || k < r.exit)
      const now = r.enter === k
      row.group.classList.toggle('now', now)
      row.label.classList.toggle('now', now)
      if (shown === row.shown && !(now && direction === 1 && !instant && previous !== k)) {
        row.group.classList.toggle('on', shown)
        row.label.classList.toggle('on', shown)
        continue
      }
      row.shown = shown
      row.group.classList.toggle('on', shown)
      row.label.classList.toggle('on', shown)
      if (shown && now && direction === 1 && !instant) reveal(row)
      else row.maskPath.setAttribute('stroke-dashoffset', '0')
    }
    const phase = slide.phases[slide.stepPhase[k] ?? 0]
    if (phase?.title) {
      const html = `<span class="tone-dot tone-${phase.tone}"></span>${phase.title}`
      if (phaseEl.innerHTML !== html) {
        phaseEl.innerHTML = html
        phaseEl.className = `seq-phase tone-${phase.tone}`
        if (!instant) phaseEl.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: EASE })
      }
    }
    const s = slide.steps[k]
    const title = phase?.title ? `<span class="tone-text tone-${phase.tone}">${phase.title}</span>` : s.titleHtml
    const current = slide.rows.filter((r) => r.enter === k).map((r) => r.labelHtml).join(' · ')
    narrative.set(`Step ${k + 1} <span class="of">/ ${slide.steps.length}</span>${pips(slide.steps.length, k)}`, title, s.noteHtml ?? (current ? `<p class="n-quote">${current}</p>` : undefined), instant)
  }

  function reveal(row: RowState) {
    const duration = row.r.kind === 'note' ? 420 : 620
    row.maskPath.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration, easing: EASE, fill: 'backwards' })
    row.maskPath.setAttribute('stroke-dashoffset', '0')
    row.label.animate([{ opacity: 0, translate: '0 8px', filter: 'blur(4px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0)' }], { duration: 420, delay: 180, easing: EASE, fill: 'backwards' })
    if (row.head) row.head.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: duration - 120, fill: 'backwards' })
    if (row.r.kind === 'note') return
    const [x1, y1] = row.from
    const [x2, y2] = row.to
    row.packet.animate(
      [
        { transform: `translate(${x1}px, ${y1}px) scale(.4)`, opacity: 0 },
        { transform: `translate(${x1 + (x2 - x1) * 0.1}px, ${y1 + (y2 - y1) * 0.1}px) scale(1)`, opacity: 1, offset: 0.1 },
        { transform: `translate(${x2}px, ${y2}px) scale(1)`, opacity: 1, offset: 0.92 },
        { transform: `translate(${x2}px, ${y2}px) scale(.3)`, opacity: 0 },
      ],
      { duration: duration + 60, easing: EASE },
    )
    row.ring.animate(
      [
        { transform: 'translate(-50%, -50%) scale(.2)', opacity: 0.95 },
        { transform: 'translate(-50%, -50%) scale(1.9)', opacity: 0 },
      ],
      { duration: 620, delay: duration - 40, easing: 'cubic-bezier(.2,.7,.2,1)' },
    )
  }

  return { el, steps: slide.steps.length, attached, go }
}
