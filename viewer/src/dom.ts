import type { Palette, Slide, Token } from '../../src/model.ts'
import type { Clock } from './motion.ts'

export interface ViewContext {
  clock: Clock
  /** Thumbnails and exports of a resting state: no entrance motion. */
  still: boolean
  /** Ask the player to keep animating frames. */
  wake(): void
}

export interface GoOptions {
  instant: boolean
  /** 1 forward by one step, -1 back by one, 0 a jump. */
  direction: 1 | -1 | 0
}

export interface SlideView {
  el: HTMLElement
  steps: number
  /** Called once after the element is in the document, before the first go(). */
  attached?(): void
  go(step: number, options: GoOptions): void
  /** Per-frame update while animating; return true to keep receiving frames. */
  frame?(now: number): boolean
  destroy?(): void
}

export type ViewFactory<S extends Slide = Slide> = (slide: S, ctx: ViewContext) => SlideView

type Attrs = Record<string, string | number | boolean | undefined | null> & { html?: string; style?: string }

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'html') el.innerHTML = String(value)
    else if (key === 'class') el.className = String(value)
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) el.append(child)
  return el
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined) el.setAttribute(key, String(value))
  return el
}

/** Wraps every word of rich inline HTML in a mask for staggered entrances. */
export function words(html: string, start = 0): { el: DocumentFragment; count: number } {
  const template = document.createElement('template')
  template.innerHTML = html
  let i = start
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = (child.textContent ?? '').split(/(\s+)/)
        const frag = document.createDocumentFragment()
        for (const part of parts) {
          if (!part) continue
          if (/^\s+$/.test(part)) frag.append(' ')
          else {
            const inner = h('span', { class: 'w-in', style: `--i:${i++}` }, part)
            frag.append(h('span', { class: 'w' }, inner))
          }
        }
        child.replaceWith(frag)
      } else if (child.nodeName === 'CODE') {
        const wrap = h('span', { class: 'w' })
        child.replaceWith(wrap)
        const inner = h('span', { class: 'w-in', style: `--i:${i++}` })
        inner.append(child)
        wrap.append(inner)
      } else walk(child)
    }
  }
  walk(template.content)
  return { el: template.content, count: i - start }
}

export function head(slide: { kicker?: string; titleHtml?: string }, extra?: Node): HTMLElement {
  const el = h('header', { class: 'head' })
  if (slide.kicker) el.append(h('div', { class: 'kicker', 'data-ref': 'kicker' }, h('span', { class: 'kicker-dot' }), h('span', {}, slide.kicker)))
  if (slide.titleHtml) {
    const title = h('h1', { class: 'title', 'data-ref': 'slide title' })
    title.append(words(slide.titleHtml).el)
    el.append(title)
  }
  if (extra) el.append(extra)
  return el
}

const THEME_INDEX = ['midnight', 'tokyo', 'evergreen', 'paper']

/** Renders highlighted tokens; each span carries every theme's color. */
export function tokens(line: Token[], palette: Palette): DocumentFragment {
  const frag = document.createDocumentFragment()
  for (const [text, index] of line) {
    const key = palette[index] ?? ''
    if (!key) {
      frag.append(text)
      continue
    }
    const parts = key.split('|')
    const style = THEME_INDEX.map((_, i) => (parts[i] ? `--c${i}:${parts[i]}` : '')).filter(Boolean).join(';')
    const span = h('span', { class: 't', style })
    const font = Number(parts[4])
    if (font & 1) span.classList.add('it')
    if (font & 2) span.classList.add('bd')
    span.textContent = text
    frag.append(span)
  }
  return frag
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Sets a node's narration panel content with a soft cross-rise. */
export class Narrative {
  el = h('aside', { class: 'narrative' })
  private label = h('div', { class: 'n-label' })
  private body = h('div', { class: 'n-body', 'data-ref': 'narration' })
  private last = ''

  constructor(extra?: HTMLElement) {
    this.el.append(this.label, this.body)
    if (extra) this.el.append(extra)
  }

  set(label: string, title: string | undefined, noteHtml: string | undefined, instant: boolean, footer?: string) {
    const key = `${label}\0${title}\0${noteHtml}\0${footer}`
    if (key === this.last) return
    this.last = key
    this.label.innerHTML = label
    const next = h('div', { class: 'n-content' })
    if (title) next.append(h('h2', { class: 'n-title', html: title }))
    if (noteHtml) next.append(h('div', { class: 'n-note prose', html: noteHtml }))
    if (footer) next.append(h('div', { class: 'n-foot', html: footer }))
    for (const previous of [...this.body.children] as HTMLElement[]) {
      if (instant) previous.remove()
      else if (!previous.classList.contains('out')) {
        previous.classList.add('out')
        previous.style.position = 'absolute'
        setTimeout(() => previous.remove(), 260)
      }
    }
    if (!instant && this.body.childElementCount) next.classList.add('in')
    this.body.append(next)
  }
}

export function pips(total: number, current: number): string {
  if (total <= 1) return ''
  let out = '<span class="pips">'
  for (let i = 0; i < total; i++) out += `<i class="${i < current ? 'past' : i === current ? 'now' : ''}"></i>`
  return `${out}</span>`
}

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}
