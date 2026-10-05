// Rolling Number: each digit place is a wheel that turns in place when the
// value changes; unchanged digits stay still and separators slide with layout.
import { h } from './dom.ts'

type Digit = { kind: 'digit'; el: HTMLElement; strip: HTMLElement }
type Cell = Digit | { kind: 'sep'; el: HTMLElement }

export function format(value: number, decimals: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export class Rolling {
  el = h('span', { class: 'roll' })
  private cells: Cell[] = []

  constructor(private decimals = 0) {}

  set(value: number, instant = false, delay = 0) {
    const text = format(value, this.decimals)
    const chars = [...text].reverse()
    const next: Cell[] = chars.map((char, place) => {
      const old = this.cells[place]
      const digit = /\d/.test(char)
      if (digit) {
        const cell: Digit = old?.kind === 'digit' ? old : this.wheel()
        const fresh = cell !== old
        cell.el.style.setProperty('--delay', `${delay + place * 0.045}s`)
        if (fresh && !instant) {
          cell.strip.style.setProperty('--d', '0')
          cell.el.classList.add('fresh')
          requestAnimationFrame(() => requestAnimationFrame(() => {
            cell.el.classList.remove('fresh')
            cell.strip.style.setProperty('--d', char)
          }))
        } else cell.strip.style.setProperty('--d', char)
        return cell
      }
      if (old?.kind === 'sep' && old.el.textContent === char) return old
      return { kind: 'sep', el: h('span', { class: 'roll-sep' }, char) }
    })
    if (instant) this.el.classList.add('instant')
    this.el.replaceChildren(...next.map((c) => c.el).reverse())
    this.cells = next
    if (instant) requestAnimationFrame(() => requestAnimationFrame(() => this.el.classList.remove('instant')))
  }

  private wheel(): Digit {
    const strip = h('span', { class: 'strip' })
    for (let d = 0; d <= 9; d++) strip.append(h('span', {}, String(d)))
    return { kind: 'digit', el: h('span', { class: 'wheel' }, strip), strip }
  }
}
