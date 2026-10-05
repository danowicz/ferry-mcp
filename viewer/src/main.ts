import './styles.css'
import type { CompiledDeck, Slide, ThemeName } from '../../src/model.ts'
import { Clock } from './motion.ts'
import { h, type SlideView, type ViewContext } from './dom.ts'
import { icon } from './icons.ts'
import { FeedbackPanel } from './feedback.ts'
import { diffView } from './slides/diff.ts'
import { sequenceView } from './slides/sequence.ts'
import { flowView } from './slides/flow.ts'
import { filesView } from './slides/files.ts'
import { compareView, markdownView, metricsView, pointsView, sectionView, titleView, type DeckInfo } from './slides/basic.ts'

const THEMES: ThemeName[] = ['midnight', 'tokyo', 'evergreen', 'paper']
const W = 1920
const H = 1080

const clock = new Clock()
const app = document.getElementById('app')!
const embedded = document.getElementById('ferry-deck')

function createView(slide: Slide, ctx: ViewContext & { deck: DeckInfo }): SlideView {
  switch (slide.type) {
    case 'title':
      return titleView(slide, ctx)
    case 'section':
      return sectionView(slide)
    case 'points':
      return pointsView(slide)
    case 'files':
      return filesView(slide)
    case 'diff':
      return diffView(slide, ctx)
    case 'sequence':
      return sequenceView(slide, ctx)
    case 'flow':
      return flowView(slide, ctx)
    case 'metrics':
      return metricsView(slide, ctx)
    case 'compare':
      return compareView(slide, ctx)
    case 'markdown':
      return markdownView(slide)
  }
}

function setTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme
}

const LOGO = `<svg viewBox="0 0 32 32" class="logo" aria-hidden="true"><path d="M5 20.5c3.6 3 7.4 3 11 0s7.4-3 11 0" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8 25.5c2.7 2 5.3 2 8 0s5.3-2 8 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".45"/><circle cx="16" cy="10.5" r="3.6" fill="currentColor"/></svg>`

// ── player ────────────────────────────────────────────────────────────────

class Player {
  deck: CompiledDeck
  index = 0
  step = 0
  view: SlideView | null = null
  stage = h('div', { class: 'stage' })
  private slides = h('div', { class: 'slides' })
  viewport = h('div', { class: 'viewport' })
  feedback: FeedbackPanel | null = null
  private feedbackCounts = new Map<string, number>()
  private feedbackButton: HTMLElement | null = null
  private progress = h('div', { class: 'progress' })
  private counter = h('div', { class: 'counter' })
  private barTitle = h('div', { class: 'bar-title' })
  private live = h('span', { class: 'live', title: 'Live: updates as the agent edits this deck' })
  private notes = h('div', { class: 'notes-drawer' })
  private overview = h('div', { class: 'overview' })
  private help = h('div', { class: 'help' })
  private toast = h('div', { class: 'toast' })
  private voice = h('div', { class: 'voice-pill' })
  private awakeUntil = 0
  private running = false
  private voiceOn = false
  private voiceTimer = 0
  private toastTimer = 0
  private toastTarget = -1

  constructor(deck: CompiledDeck, live = true) {
    this.deck = deck
    const stored = localStorage.getItem(`ferry-theme:${deck.id}`) as ThemeName | null
    setTheme(stored && THEMES.includes(stored) ? stored : deck.theme)
    document.title = deck.title

    const buttons = h(
      'div',
      { class: 'bar-buttons' },
      live ? (this.feedbackButton = this.button('message', 'Chat & change plan (C)', () => this.feedback?.toggle())) : null,
      this.button('grid', 'Overview (O)', () => this.toggleOverview()),
      this.button('notes', 'Notes (N)', () => this.toggleNotes()),
      this.button('volume', 'Voice narration (V)', () => this.toggleVoice()),
      this.button('sun', 'Theme (T)', () => this.cycleTheme()),
      this.button('maximize', 'Fullscreen (F)', () => this.fullscreen()),
      this.button('keyboard', 'Shortcuts (?)', () => this.toggleHelp()),
    )
    const bar = h('footer', { class: 'bar' }, h('div', { class: 'bar-left' }, h('span', { class: 'bar-logo', html: LOGO }), this.barTitle), this.progress, h('div', { class: 'bar-right' }, this.live, this.counter, buttons))
    this.stage.append(h('div', { class: 'bg' }, h('div', { class: 'bg-glow' }), h('div', { class: 'bg-grid' }), h('div', { class: 'grain' })), this.slides, bar)
    this.viewport.append(this.stage)
    this.help.innerHTML = HELP
    this.help.addEventListener('click', () => this.toggleHelp(false))
    this.toast.addEventListener('click', () => {
      if (this.toastTarget >= 0) this.goSlide(this.toastTarget, 0, 'jump')
      this.toast.classList.remove('on')
    })
    this.voice.addEventListener('click', () => this.toggleVoice(false))
    app.replaceChildren(h('div', { class: 'player' }, this.viewport, this.notes, this.voice, this.toast, this.overview, this.help))
    if (live) {
      const player = this
      this.feedback = new FeedbackPanel({
        get deck() {
          return player.deck
        },
        get index() {
          return player.index
        },
        get step() {
          return player.step
        },
        stage: this.stage,
        viewport: this.viewport,
        goTo: (i, k) => this.goSlide(i, k, 'jump'),
        layoutChanged: () => {
          // Follow the viewport while the panel slides in or out.
          const end = performance.now() + 450
          const follow = () => {
            this.fit()
            if (performance.now() < end) requestAnimationFrame(follow)
          }
          follow()
        },
        countsChanged: (counts) => {
          this.feedbackCounts = counts
          this.renderBar()
        },
        flash: (message) => this.flash(message),
      })
      app.firstElementChild!.append(this.feedback.el)
      this.feedback.refresh()
    }

    this.renderBar()
    this.fit()
    window.addEventListener('resize', () => this.fit())
    window.addEventListener('keydown', (e) => this.key(e))
    this.viewport.addEventListener('click', (e) => this.click(e))
    window.addEventListener('hashchange', () => this.fromHash())

    const [slide, step] = this.parseHash()
    this.goSlide(slide, step, step ? 'jump' : 'forward')
  }

  private button(name: string, title: string, action: () => void) {
    const b = h('button', { class: 'icon-btn', title, 'aria-label': title, html: icon(name, 17) })
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      action()
    })
    return b
  }

  private fit() {
    const scale = Math.min(this.viewport.clientWidth / W, this.viewport.clientHeight / H)
    this.stage.style.transform = `translate(-50%, -50%) scale(${scale})`
  }

  private parseHash(): [number, number] {
    const match = location.hash.match(/^#(\d+)(?:\.(\d+))?/)
    if (!match) return [0, 0]
    const slide = Math.min(Math.max(0, Number(match[1]) - 1), this.deck.slides.length - 1)
    return [slide, Math.max(0, Number(match[2] ?? 1) - 1)]
  }

  private fromHash() {
    const [slide, step] = this.parseHash()
    if (slide !== this.index || step !== this.step) this.goSlide(slide, step, 'jump')
  }

  private ctx(still = false): ViewContext & { deck: DeckInfo } {
    return { clock, still, wake: () => this.wake(), deck: this.deck }
  }

  goSlide(index: number, step: number, how: 'forward' | 'backward' | 'jump') {
    const slide = this.deck.slides[index]
    if (!slide) {
      this.slides.replaceChildren(h('div', { class: 'empty-deck' }, h('div', { class: 'empty-logo', html: LOGO }), h('h1', {}, this.deck.title), h('p', {}, 'Waiting for slides… they appear here as the agent adds them.')))
      this.view = null
      this.renderBar()
      return
    }
    this.slides.querySelector('.empty-deck')?.remove()
    const old = this.view
    if (old) {
      old.el.classList.add('leave')
      old.el.classList.toggle('back', how === 'backward')
      setTimeout(() => {
        old.el.remove()
        old.destroy?.()
      }, 320)
    }
    const view = createView(slide, this.ctx())
    view.el.classList.add('enter')
    if (how === 'backward') view.el.classList.add('back')
    this.slides.append(view.el)
    view.attached?.()
    this.view = view
    this.index = index
    this.step = Math.min(step, view.steps - 1)
    if (how === 'forward' && this.step === 0) view.go(0, { instant: false, direction: 1 })
    else view.go(this.step, { instant: true, direction: 0 })
    this.wake()
    this.afterMove()
  }

  goStep(step: number) {
    if (!this.view) return
    const direction = step === this.step + 1 ? 1 : step === this.step - 1 ? -1 : 0
    this.step = step
    this.view.go(step, { instant: false, direction })
    this.wake()
    this.afterMove()
  }

  next() {
    if (!this.view) return
    if (this.step < this.view.steps - 1) this.goStep(this.step + 1)
    else if (this.index < this.deck.slides.length - 1) this.goSlide(this.index + 1, 0, 'forward')
    else if (this.voiceOn) this.toggleVoice(false)
  }

  prev() {
    if (!this.view) return
    if (this.step > 0) this.goStep(this.step - 1)
    else if (this.index > 0) this.goSlide(this.index - 1, Infinity, 'backward')
  }

  private afterMove() {
    this.feedback?.moved()
    history.replaceState(null, '', `#${this.index + 1}${this.step ? `.${this.step + 1}` : ''}`)
    this.renderBar()
    this.renderNotes()
    if (this.voiceOn) this.speak()
  }

  private wake() {
    this.awakeUntil = performance.now() + 1200
    if (this.running) return
    this.running = true
    const tick = () => {
      const busy = this.view?.frame?.(clock.now()) ?? false
      if (busy || performance.now() < this.awakeUntil) requestAnimationFrame(tick)
      else this.running = false
    }
    requestAnimationFrame(tick)
  }

  renderBar() {
    const { deck } = this
    this.barTitle.innerHTML = `<b>${escape(deck.title)}</b>${deck.repo || deck.ref ? `<span>${escape([deck.repo, deck.ref].filter(Boolean).join(' · '))}</span>` : ''}`
    const n = deck.slides.length
    if (this.progress.childElementCount !== n) {
      this.progress.replaceChildren(
        ...deck.slides.map((_, i) => {
          const seg = h('button', { class: 'seg', title: `Slide ${i + 1}` }, h('i'))
          seg.addEventListener('click', (e) => {
            e.stopPropagation()
            this.goSlide(i, 0, i > this.index ? 'forward' : 'jump')
          })
          return seg
        }),
      )
    }
    const steps = this.view?.steps ?? 1
    ;[...this.progress.children].forEach((seg, i) => {
      const fill = i < this.index ? 1 : i > this.index ? 0 : (this.step + 1) / steps
      ;(seg as HTMLElement).style.setProperty('--fill', String(fill))
      seg.classList.toggle('now', i === this.index)
      const count = this.feedbackCounts.get(deck.slides[i].id) ?? 0
      seg.classList.toggle('has-fb', count > 0)
      seg.setAttribute('title', `${i + 1}. ${(deck.slides[i].title ?? deck.slides[i].type).replace(/\*/g, '')}`)
    })
    const pendingFeedback = [...this.feedbackCounts.values()].reduce((a, b) => a + b, 0)
    if (this.feedbackButton) {
      if (pendingFeedback) this.feedbackButton.dataset.count = String(pendingFeedback)
      else delete this.feedbackButton.dataset.count
    }
    this.counter.innerHTML = n ? `<b>${String(this.index + 1).padStart(2, '0')}</b><span>/ ${String(n).padStart(2, '0')}</span>` : ''
  }

  private renderNotes() {
    const slide = this.deck.slides[this.index]
    if (!slide) return
    const step = slide.steps[this.step]
    this.notes.innerHTML = `<div class="notes-head"><span>Slide ${this.index + 1} · step ${this.step + 1} of ${slide.steps.length}</span><b>${slide.titleHtml ?? slide.type}</b></div><div class="notes-body">${step?.say ? `<p>${escape(step.say)}</p>` : '<p class="muted">No narration for this step.</p>'}${slide.notes ? `<p class="notes-extra">${escape(slide.notes)}</p>` : ''}</div>`
  }

  private key(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.target as HTMLElement).closest?.('input, textarea, [contenteditable]')) return
    const k = e.key
    if (this.overview.classList.contains('on') && k !== 'o' && k !== 'O' && k !== 'Escape') return
    if (k === 'ArrowRight' || k === ' ' || k === 'PageDown' || k === 'Enter' || k === 'l') {
      if (e.shiftKey && k === 'ArrowRight') this.nextSlide()
      else this.next()
    } else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace' || k === 'h') {
      if (e.shiftKey && k === 'ArrowLeft') this.prevSlide()
      else this.prev()
    } else if (k === 'ArrowDown' || k === 'j') this.nextSlide()
    else if (k === 'ArrowUp' || k === 'k') this.prevSlide()
    else if (k === 'Home') this.goSlide(0, 0, 'jump')
    else if (k === 'End') this.goSlide(this.deck.slides.length - 1, 0, 'jump')
    else if (k === 'o' || k === 'O' || k === 'g') this.toggleOverview()
    else if (k === 'Escape') {
      this.toggleOverview(false)
      this.toggleHelp(false)
    } else if ((k === 'c' || k === 'C') && this.feedback) this.feedback.toggle()
    else if ((k === 'p' || k === 'P') && this.feedback?.open) this.feedback.pick(true)
    else if (k === 't' || k === 'T') this.cycleTheme()
    else if (k === 'n' || k === 'N') this.toggleNotes()
    else if (k === 'v' || k === 'V') this.toggleVoice()
    else if (k === 'f' || k === 'F') this.fullscreen()
    else if (k === 's' || k === 'S') this.toggleSlow()
    else if (k === 'r' || k === 'R') this.goSlide(this.index, 0, 'forward')
    else if (k === '?') this.toggleHelp()
    else return
    e.preventDefault()
  }

  private nextSlide() {
    if (this.index < this.deck.slides.length - 1) this.goSlide(this.index + 1, 0, 'forward')
  }

  private prevSlide() {
    if (this.index > 0) this.goSlide(this.index - 1, 0, 'jump')
  }

  private click(e: MouseEvent) {
    const target = e.target as HTMLElement
    if (target.closest('button, a, .wipe') || getSelection()?.toString()) return
    const rect = this.viewport.getBoundingClientRect()
    if (e.clientX - rect.left < rect.width * 0.25) this.prev()
    else this.next()
  }

  private cycleTheme() {
    const current = document.documentElement.dataset.theme as ThemeName
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]
    setTheme(next)
    localStorage.setItem(`ferry-theme:${this.deck.id}`, next)
    this.flash(`Theme · ${next}`)
  }

  private toggleSlow() {
    clock.setSpeed(clock.speed === 1 ? 0.25 : 1)
    this.flash(clock.speed === 1 ? 'Normal speed' : 'Slow motion · ¼×')
  }

  private fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen()
    else document.documentElement.requestFullscreen?.()
  }

  private toggleNotes(on = !this.notes.classList.contains('on')) {
    this.notes.classList.toggle('on', on)
  }

  private toggleHelp(on = !this.help.classList.contains('on')) {
    this.help.classList.toggle('on', on)
  }

  toggleOverview(on = !this.overview.classList.contains('on')) {
    this.overview.classList.toggle('on', on)
    if (!on) {
      setTimeout(() => this.overview.replaceChildren(), 300)
      return
    }
    const grid = h('div', { class: 'ov-grid' })
    this.deck.slides.forEach((slide, i) => {
      const frame = h('div', { class: 'ov-frame' })
      const thumb = h('button', { class: `ov-thumb${i === this.index ? ' now' : ''}` }, frame, h('div', { class: 'ov-cap' }, h('b', {}, String(i + 1).padStart(2, '0')), h('span', { html: slide.titleHtml ?? slide.type })))
      thumb.addEventListener('click', () => {
        this.toggleOverview(false)
        this.goSlide(i, 0, 'forward')
      })
      grid.append(thumb)
      // Render each slide at rest, scaled down.
      requestAnimationFrame(() => {
        const inner = h('div', { class: 'ov-inner' }, h('div', { class: 'bg' }, h('div', { class: 'bg-glow' })))
        frame.append(inner)
        const view = createView(slide, this.ctx(true))
        view.el.classList.add('still')
        inner.append(view.el)
        view.attached?.()
        view.go(view.steps - 1, { instant: true, direction: 0 })
        view.frame?.(clock.now())
        inner.style.transform = `scale(${frame.clientWidth / W})`
      })
    })
    this.overview.replaceChildren(h('div', { class: 'ov-head' }, h('span', { html: LOGO }), h('b', {}, this.deck.title), h('span', { class: 'muted' }, `${this.deck.slides.length} slides · click to open · Esc to close`)), grid)
  }

  // ── voice narration ────────────────────────────────────────────────────

  private toggleVoice(on = !this.voiceOn) {
    this.voiceOn = on
    this.voice.classList.toggle('on', on)
    this.voice.innerHTML = `${icon('volume', 15)}<span>Narrating</span><small>click or V to stop</small>`
    if (on) this.speak()
    else {
      speechSynthesis?.cancel()
      clearTimeout(this.voiceTimer)
    }
  }

  private speak() {
    clearTimeout(this.voiceTimer)
    if (!('speechSynthesis' in window)) return this.flash('Voice is not supported in this browser')
    speechSynthesis.cancel()
    const slide = this.deck.slides[this.index]
    const text = slide?.steps[this.step]?.say
    const advance = () => {
      this.voiceTimer = window.setTimeout(() => this.voiceOn && this.next(), 700)
    }
    if (!text) {
      this.voiceTimer = window.setTimeout(() => this.voiceOn && this.next(), 2600)
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.voice = pickVoice()
    utterance.rate = 1.02
    utterance.onend = advance
    speechSynthesis.speak(utterance)
  }

  // ── live updates ───────────────────────────────────────────────────────

  update(next: CompiledDeck) {
    const before = new Map(this.deck.slides.map((s) => [s.id, JSON.stringify(s)]))
    const currentId = this.deck.slides[this.index]?.id
    const currentJson = currentId ? before.get(currentId) : undefined
    const themeChanged = next.theme !== this.deck.theme
    this.deck = next
    if (themeChanged && !localStorage.getItem(`ferry-theme:${next.id}`)) setTheme(next.theme)
    const added = next.slides.map((s, i) => [s, i] as const).filter(([s]) => !before.has(s.id))
    const changed = next.slides.map((s, i) => [s, i] as const).filter(([s]) => before.has(s.id) && before.get(s.id) !== JSON.stringify(s))
    let index = next.slides.findIndex((s) => s.id === currentId)
    if (index < 0) index = Math.min(this.index, next.slides.length - 1)
    const same = index >= 0 && JSON.stringify(next.slides[index]) === currentJson
    if (!this.view || !same) this.goSlide(Math.max(0, index), this.step, this.view ? 'jump' : 'forward')
    else {
      this.index = index
      this.afterMove()
    }
    const first = added[0] ?? changed[0]
    if (first) {
      const verb = added.length ? 'Added' : 'Updated'
      const count = added.length || changed.length
      const name = (first[0].title ?? first[0].type).replace(/\*/g, '')
      this.flash(`${verb} ${count > 1 ? `${count} slides` : `“${name}”`} · slide ${first[1] + 1}`, first[1])
    }
  }

  flash(message: string, target = -1) {
    this.toastTarget = target
    this.toast.innerHTML = `<span class="toast-dot"></span>${escape(message)}${target >= 0 && target !== this.index ? '<small>click to view</small>' : ''}`
    this.toast.classList.add('on')
    clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('on'), 2600)
  }

  setLive(on: boolean) {
    this.live.classList.toggle('on', on)
  }
}

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'))
  const preferred = [/premium/i, /enhanced/i, /Ava|Zoe|Evan|Samantha|Daniel|Karen|Google US English|Aria|Jenny|Guy/]
  for (const pattern of preferred) {
    const voice = voices.find((v) => pattern.test(v.name))
    if (voice) return voice
  }
  return voices[0] ?? null
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const HELP = `<div class="help-card"><h2>Keyboard</h2><dl>
<dt><kbd>→</kbd><kbd>Space</kbd></dt><dd>Next step</dd>
<dt><kbd>←</kbd></dt><dd>Previous step</dd>
<dt><kbd>↓</kbd><kbd>↑</kbd></dt><dd>Next / previous slide</dd>
<dt><kbd>C</kbd></dt><dd>Chat with the agent · change plan</dd>
<dt><kbd>P</kbd></dt><dd>Pin a comment to an element (panel open)</dd>
<dt><kbd>O</kbd></dt><dd>Overview</dd>
<dt><kbd>N</kbd></dt><dd>Speaker notes</dd>
<dt><kbd>V</kbd></dt><dd>Voice narration (auto-advances)</dd>
<dt><kbd>T</kbd></dt><dd>Cycle theme</dd>
<dt><kbd>S</kbd></dt><dd>Slow motion</dd>
<dt><kbd>R</kbd></dt><dd>Replay slide</dd>
<dt><kbd>F</kbd></dt><dd>Fullscreen</dd>
</dl><p>Interrupt any animation: motion retargets from where it is, so ← mid-transition never jumps.</p></div>`

// ── home ──────────────────────────────────────────────────────────────────

interface DeckSummary {
  id: string
  title: string
  subtitle?: string
  repo?: string
  ref?: string
  theme: ThemeName
  updatedAt: string
  slideCount: number
}

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

async function home() {
  setTheme((localStorage.getItem('ferry-theme:home') as ThemeName) ?? 'midnight')
  document.title = 'Ferry'
  const [decks, health] = await Promise.all([fetch('/api/decks').then((r) => r.json() as Promise<DeckSummary[]>), fetch('/api/health').then((r) => r.json())])
  const grid = h('div', { class: 'home-grid' })
  decks.forEach((deck, i) => {
    const card = h(
      'a',
      { class: 'home-card', href: `/d/${deck.id}`, 'data-theme': deck.theme, style: `--i:${i}` },
      h('div', { class: 'hc-art' }, h('div', { class: 'aurora' }, h('i'), h('i')), h('span', { class: 'hc-count' }, `${deck.slideCount} slides`)),
      h('div', { class: 'hc-body' }, h('h2', {}, deck.title), deck.subtitle ? h('p', {}, deck.subtitle) : null, h('div', { class: 'hc-meta' }, h('span', {}, [deck.repo, deck.ref].filter(Boolean).join(' · ') || deck.id), h('span', {}, ago(deck.updatedAt)))),
    )
    grid.append(card)
  })
  const cmd = health.mcpCommand ?? 'node /path/to/ferry/bin/ferry.js'
  const empty = h(
    'div',
    { class: 'home-empty' },
    h('h2', {}, 'No decks yet'),
    h('p', {}, 'Connect Ferry to your agent, then ask it to explain a change:'),
    h('pre', {}, `claude mcp add ferry -- ${cmd}`),
    h('p', { class: 'muted' }, '“Explain the changes on this branch with a Ferry presentation.”'),
  )
  app.replaceChildren(
    h(
      'div',
      { class: 'home' },
      h('div', { class: 'aurora page' }, h('i'), h('i'), h('i')),
      h(
        'header',
        { class: 'home-head' },
        h('div', { class: 'home-brand' }, h('span', { html: LOGO }), h('b', {}, 'Ferry')),
        h('h1', { html: 'Code changes, <em>explained</em>.' }),
        h('p', {}, 'Animated walkthroughs your agents build over MCP — the code keeps its identity while it changes, so every reviewer can follow along.'),
      ),
      decks.length ? grid : empty,
    ),
  )
}

// ── boot ──────────────────────────────────────────────────────────────────

async function boot() {
  await document.fonts?.ready
  if (embedded) {
    new Player(JSON.parse(embedded.textContent ?? '{}'), false)
    document.querySelector('.live')?.remove()
    return
  }
  const match = location.pathname.match(/^\/d\/([a-z0-9-]+)/)
  if (!match) {
    await home()
    const events = new EventSource('/api/events')
    let timer = 0
    events.onmessage = () => {
      clearTimeout(timer)
      timer = window.setTimeout(home, 200)
    }
    return
  }
  const id = match[1]
  const load = async () => {
    const response = await fetch(`/api/decks/${id}`)
    if (!response.ok) throw new Error((await response.json()).error)
    return (await response.json()) as CompiledDeck
  }
  let player: Player
  try {
    player = new Player(await load())
  } catch (error) {
    app.replaceChildren(h('div', { class: 'home' }, h('header', { class: 'home-head' }, h('div', { class: 'home-brand' }, h('span', { html: LOGO }), h('b', {}, 'Ferry')), h('h1', {}, 'Deck not found'), h('p', {}, String((error as Error).message)), h('p', {}, h('a', { href: '/' }, 'All decks →')))))
    return
  }
  const events = new EventSource('/api/events')
  events.onopen = () => player.setLive(true)
  events.onerror = () => player.setLive(false)
  let revision = player.deck.revision
  events.onmessage = async (message) => {
    const data = JSON.parse(message.data)
    if (data.id !== id) return
    if (data.type === 'feedback') return player.feedback?.refresh()
    if (data.type === 'chat') return player.feedback?.onChat(data)
    if (data.type === 'presence') return player.feedback?.setPresence(data.listening)
    try {
      const deck = await load()
      if (deck.revision === revision) return
      revision = deck.revision
      player.update(deck)
    } catch {
      /* deck deleted or mid-write */
    }
  }
}

boot()
