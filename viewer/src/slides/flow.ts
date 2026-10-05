import type { FlowSlide, Tone } from '../../../src/model.ts'
import { h, head, Narrative, pips, svg, type GoOptions, type SlideView, type ViewContext } from '../dom.ts'
import { icon } from '../icons.ts'

type Pt = [number, number]
interface Box {
  x: number
  y: number
  w: number
  h: number
}

const TONES: Tone[] = ['plain', 'accent', 'success', 'error', 'warning', 'info', 'muted']
const EASE = 'cubic-bezier(.45,.05,.25,1)'

function connector(a: Box, b: Box, offset = 0): { d: string; mid: Pt } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const horizontal = Math.abs(dx) / (a.w + b.w) >= Math.abs(dy) / (a.h + b.h)
  let s: Pt
  let e: Pt
  let c1: Pt
  let c2: Pt
  if (horizontal) {
    const sx = Math.sign(dx) || 1
    s = [a.x + (sx * a.w) / 2, a.y + offset]
    e = [b.x - (sx * b.w) / 2, b.y + offset]
    const k = Math.max(40, Math.abs(e[0] - s[0]) * 0.45) * sx
    c1 = [s[0] + k, s[1]]
    c2 = [e[0] - k, e[1]]
  } else {
    const sy = Math.sign(dy) || 1
    s = [a.x + offset, a.y + (sy * a.h) / 2]
    e = [b.x + offset, b.y - (sy * b.h) / 2]
    const k = Math.max(36, Math.abs(e[1] - s[1]) * 0.45) * sy
    c1 = [s[0], s[1] + k]
    c2 = [e[0], e[1] - k]
  }
  const mid: Pt = [(s[0] + 3 * c1[0] + 3 * c2[0] + e[0]) / 8, (s[1] + 3 * c1[1] + 3 * c2[1] + e[1]) / 8]
  return { d: `M${s[0].toFixed(1)} ${s[1].toFixed(1)} C${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${e[0].toFixed(1)} ${e[1].toFixed(1)}`, mid }
}

export function flowView(slide: FlowSlide, ctx: ViewContext): SlideView {
  const narrative = new Narrative()
  const stage = h('div', { class: 'flow' })
  const visual = h('div', { class: 'visual' }, stage)
  const el = h('section', { class: 'slide slide-flow' }, head(slide), h('div', { class: 'split' }, narrative.el, visual))

  const nodeEls = new Map<string, HTMLElement>()
  const boxes = new Map<string, Box>()
  const edgeEls = new Map<string, { group: SVGGElement; mask: SVGPathElement; label?: HTMLElement; d: string; shown: boolean }>()
  let root: SVGSVGElement
  let timers: number[] = []
  let step = -1

  function attached() {
    const W = visual.clientWidth
    const H = visual.clientHeight
    const cellW = W / slide.cols
    const cellH = H / slide.rows
    const nodeW = Math.min(268, cellW - 56)

    root = svg('svg', { class: 'flow-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}` })
    const defs = svg('defs')
    for (const tone of TONES) {
      const marker = svg('marker', { id: `ah-${slide.id}-${tone}`, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', class: `tone-${tone}` })
      marker.append(svg('path', { d: 'M1 1 L9 5 L1 9 z', class: 'ah' }))
      defs.append(marker)
    }
    root.append(defs)
    stage.append(root)

    for (const node of slide.nodes) {
      const height = node.shape === 'pill' ? 68 : node.detail ? 104 : 84
      const box = { x: (node.col + 0.5) * cellW, y: (node.row + 0.5) * cellH, w: node.shape === 'pill' ? Math.min(nodeW, 220) : nodeW, h: height }
      boxes.set(node.id, box)
      const nodeEl = h(
        'div',
        { class: `node ${node.shape}`, style: `left:${box.x - box.w / 2}px;top:${box.y - box.h / 2}px;width:${box.w}px;height:${box.h}px`, 'data-ref': 'node', 'data-label': `${node.label} (id: ${node.id})` },
        node.icon ? h('span', { class: 'node-icon', html: icon(node.icon, 20) }) : null,
        h('div', { class: 'node-text' }, h('b', {}, node.label), node.detail ? h('small', {}, node.detail) : null),
        h('i', { class: 'node-status' }),
      )
      nodeEls.set(node.id, nodeEl)
      stage.append(nodeEl)
    }

    const pairs = new Set(slide.edges.map((e) => `${e.from}->${e.to}`))
    for (const edge of slide.edges) {
      const both = pairs.has(`${edge.to}->${edge.from}`)
      const { d, mid } = connector(boxes.get(edge.from)!, boxes.get(edge.to)!, both ? (edge.from < edge.to ? -10 : 10) : 0)
      const mask = svg('mask', { id: `fm-${slide.id}-${edge.id.replace(/[^a-z0-9]/gi, '_')}`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H })
      const maskPath = svg('path', { d, stroke: 'white', 'stroke-width': 30, fill: 'none', pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 0 })
      mask.append(maskPath)
      defs.append(mask)
      const group = svg('g', { class: 'edge', mask: `url(#${mask.id})` })
      const path = svg('path', { class: `edge-path${edge.dashed ? ' dashed' : ''}`, d })
      group.append(path)
      root.append(group)
      let label: HTMLElement | undefined
      if (edge.label) {
        label = h('div', { class: 'edge-label', style: `left:${mid[0]}px;top:${mid[1]}px`, 'data-ref': 'edge', 'data-label': `${edge.id}: ${edge.label}` }, edge.label)
        stage.append(label)
      }
      edgeEls.set(edge.id, { group, mask: maskPath, label, d, shown: false })
    }
  }

  function setTone(target: Element, tone: Tone) {
    for (const t of TONES) target.classList.toggle(`tone-${t}`, t === tone)
  }

  function go(k: number, { instant, direction }: GoOptions) {
    for (const t of timers) clearTimeout(t)
    timers = []
    stage.querySelectorAll('.flow-packet').forEach((e) => e.remove())
    root.querySelectorAll('.trail').forEach((e) => e.remove())
    const previous = step
    step = k
    const s = slide.steps[k]
    const focus = new Set(s.focus)
    const forward = direction === 1 && !instant && previous !== k
    const arrivals = new Map<string, number>()
    if (forward) s.packets.forEach((p, i) => arrivals.set(p.to, 300 + i * 220 + 900))

    for (const node of slide.nodes) {
      const nodeEl = nodeEls.get(node.id)!
      const shown = node.visible[k]
      const wasShown = nodeEl.classList.contains('on')
      nodeEl.classList.toggle('on', shown)
      if (shown && !wasShown && !instant) nodeEl.animate([{ opacity: 0, transform: 'translateY(10px) scale(.96)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' })
      nodeEl.classList.toggle('dim', focus.size > 0 && !focus.has(node.id))
      const tone = node.tone[k]
      const arrival = arrivals.get(node.id)
      if (arrival && !nodeEl.classList.contains(`tone-${tone}`)) timers.push(window.setTimeout(() => setTone(nodeEl, tone), arrival / ctx.clock.speed))
      else setTone(nodeEl, tone)
    }

    for (const edge of slide.edges) {
      const state = edgeEls.get(edge.id)!
      const shown = edge.visible[k]
      state.group.classList.toggle('on', shown)
      state.label?.classList.toggle('on', shown)
      const dim = focus.size > 0 && !focus.has(edge.id)
      state.group.classList.toggle('dim', dim)
      state.label?.classList.toggle('dim', dim)
      setTone(state.group, edge.tone[k])
      const path = state.group.querySelector('path')!
      path.setAttribute('marker-end', `url(#ah-${slide.id}-${edge.tone[k]})`)
      if (shown && !state.shown && !instant) {
        state.mask.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 700, delay: 120, easing: EASE, fill: 'backwards' })
        state.label?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 600, fill: 'backwards' })
      }
      state.shown = shown
    }

    if (forward) s.packets.forEach((p, i) => send(p.from, p.to, p.tone, p.label, 300 + i * 220))

    narrative.set(`Step ${k + 1} <span class="of">/ ${slide.steps.length}</span>${pips(slide.steps.length, k)}`, s.titleHtml, s.noteHtml, instant)
  }

  function send(from: string, to: string, tone: Tone, label: string | undefined, delay: number) {
    const edge = edgeEls.get(`${from}->${to}`)
    const reverse = edgeEls.get(`${to}->${from}`)
    let d = edge?.d
    if (!d && reverse) d = reversePath(reverse.d)
    if (!d) d = connector(boxes.get(from)!, boxes.get(to)!).d
    const duration = 900
    const trail = svg('path', { class: `trail tone-${tone}`, d, pathLength: 1 })
    root.append(trail)
    const dot = h('div', { class: `packet flow-packet tone-${tone}`, style: `offset-path:path("${d}")` })
    if (label) dot.append(h('span', { class: 'packet-label' }, label))
    stage.append(dot)
    const speed = ctx.clock.speed
    const options = { duration: duration / speed, delay: delay / speed, easing: EASE, fill: 'both' as const }
    dot.animate(
      [
        { offsetDistance: '0%', opacity: 0, transform: 'scale(.4)' },
        { offsetDistance: '8%', opacity: 1, transform: 'scale(1)', offset: 0.08 },
        { offsetDistance: '100%', opacity: 1, transform: 'scale(1)', offset: 0.94 },
        { offsetDistance: '100%', opacity: 0, transform: 'scale(.4)' },
      ],
      options,
    )
    trail.animate([{ strokeDashoffset: 0.22, opacity: 0.9 }, { strokeDashoffset: -0.98, opacity: 0.9, offset: 0.9 }, { strokeDashoffset: -1, opacity: 0 }], options)
    const target = nodeEls.get(to)
    if (target) {
      target.style.setProperty('--hit', `var(--${tone === 'plain' ? 'accent' : tone})`)
      target.animate(
        [
          { boxShadow: '0 0 0 0 color-mix(in srgb, var(--hit) 70%, transparent), 0 0 0 0 transparent' },
          { boxShadow: '0 0 0 6px color-mix(in srgb, var(--hit) 0%, transparent), 0 0 46px 2px color-mix(in srgb, var(--hit) 45%, transparent)', offset: 0.35 },
          { boxShadow: '0 0 0 10px transparent, 0 0 0 0 transparent' },
        ],
        { duration: 900 / speed, delay: (delay + duration * 0.92) / speed, easing: 'ease-out' },
      )
    }
    timers.push(
      window.setTimeout(() => {
        dot.remove()
        trail.remove()
      }, (delay + duration + 100) / speed),
    )
  }

  return { el, steps: slide.steps.length, attached, go }
}

function reversePath(d: string): string {
  const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
  const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = n
  return `M${ex} ${ey} C${c2x} ${c2y}, ${c1x} ${c1y}, ${sx} ${sy}`
}
