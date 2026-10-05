// Side panel. Chat: ask about the change (Ask mode) or plan code changes (Plan
// mode), which Claude drafts as a plan deck of slides. Plan: review that plan,
// send it to an agent to implement, and read the agent's replies.
import type { CompiledDeck } from '../../src/model.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'
import { markdown } from './markdown.ts'

type Status = 'draft' | 'open' | 'working' | 'done' | 'declined'

interface Item {
  id: string
  status: Status
  createdAt: string
  slideId?: string
  step?: number
  target?: { kind: string; label: string }
  plan?: { id: string; revision: number }
  text: string
  thread: { from: 'user' | 'agent'; text: string; at: string }[]
}

type Mode = 'ask' | 'plan'

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  at: string
  context?: { deckId?: string; slideId?: string; slideIndex?: number; step?: number; target?: { kind: string; label: string } }
  mode?: Mode | 'implement'
  tools?: { id: string; name: string; label: string; done: boolean }[]
  status?: 'streaming' | 'done' | 'error' | 'stopped'
}

export type ChatEvent =
  | { op: 'message'; message: ChatMessage }
  | { op: 'delta'; messageId: string; text: string }
  | { op: 'tool'; messageId: string; tool: NonNullable<ChatMessage['tools']>[number] }
  | { op: 'end'; message: ChatMessage }
  | { op: 'cleared' }

const SUGGESTIONS: Record<Mode, string[]> = {
  ask: ['Explain this step more simply', 'Why does this change matter?', 'Tighten the narration on this slide', 'Add a callout on the most important line'],
  plan: ['Add a test that covers this change', 'Make this value configurable', 'Handle the error case here', 'Split this function in two'],
}

export interface FeedbackHost {
  deck: CompiledDeck
  index: number
  step: number
  stage: HTMLElement
  viewport: HTMLElement
  goTo(slideIndex: number, step: number): void
  /** Navigates to another deck: the plan, or back to the reviewed deck. */
  openDeck(id: string, slide?: number): void
  layoutChanged(): void
  countsChanged(counts: Map<string, number>): void
  flash(message: string): void
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const rich = (text: string) =>
  escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 50) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export class FeedbackPanel {
  el = h('aside', { class: 'fb tab-chat', 'aria-label': 'Chat and feedback' })
  open = false
  private tab: 'chat' | 'plan' = 'chat'
  private items: Item[] = []
  private listening = false
  private list = h('div', { class: 'fb-list fb-plan' })
  private chatList = h('div', { class: 'fb-list fb-chat' })
  private chat: ChatMessage[] = []
  private running = false
  private chatTab = h('button', { class: 'fb-tab on', html: `${icon('sparkles', 14)}<span>Chat</span>` })
  private planTab = h('button', { class: 'fb-tab', html: `${icon('notes', 14)}<span>Plan</span>` })
  private mode: Mode
  private askMode = h('button', { title: 'Ask about the change; Claude can edit these slides (Shift+Tab)' }, 'Ask')
  private planMode = h('button', { title: 'Plan code changes; Claude drafts them as plan slides (Shift+Tab)' }, 'Plan')
  private chatSend = h('button', { class: 'fb-send', html: `${icon('arrow', 15)}<span>Send</span>` })
  private stopButton = h('button', { class: 'fb-stop', html: '<i></i><span>Stop</span>' })
  private newChat = h('button', { class: 'icon-btn fb-new', title: 'New conversation', 'aria-label': 'New conversation', html: icon('newchat', 16) })
  private renderQueued = false
  private presence = h('div', { class: 'fb-presence' })
  private slideChip = h('button', { class: 'fb-chip fb-chip-slide' })
  private targetChip = h('button', { class: 'fb-chip fb-chip-target' })
  private pickButton = h('button', { class: 'fb-pick', title: 'Pin to an element on the slide (P)', html: `${icon('search', 15)}<span>Pin</span>` })
  private input = h('textarea', { class: 'fb-input', rows: 2, placeholder: 'Ask for a change on this slide…' }) as HTMLTextAreaElement
  private sendButton = h('button', { class: 'fb-send' })
  private planSlides: string[] = []
  private hover = h('div', { class: 'pick-hover' })
  private target: Item['target'] | undefined
  private deckWide = false
  private picking = false

  constructor(private host: FeedbackHost) {
    this.mode = (localStorage.getItem(`ferry-chat-mode:${this.review}`) as Mode | null) ?? (host.deck.planFor ? 'plan' : 'ask')
    this.askMode.addEventListener('click', () => this.setMode('ask'))
    this.planMode.addEventListener('click', () => this.setMode('plan'))
    const close = h('button', { class: 'icon-btn', title: 'Close (C)', html: icon('x', 16) })
    close.addEventListener('click', () => this.toggle(false))
    this.slideChip.addEventListener('click', () => {
      this.deckWide = !this.deckWide
      this.renderContext()
    })
    this.targetChip.addEventListener('click', () => {
      this.target = undefined
      this.renderContext()
    })
    this.pickButton.addEventListener('click', () => this.pick(!this.picking))
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        this.sendChat()
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        this.setMode(this.mode === 'ask' ? 'plan' : 'ask')
      } else if (e.key === 'Escape') this.input.blur()
    })
    this.sendButton.addEventListener('click', () => this.send())
    const copy = h('button', { class: 'fb-copy', title: 'Copy a prompt that asks any agent to implement the plan', html: `${icon('file', 14)}<span>Copy as prompt</span>` })
    copy.addEventListener('click', () => this.copy())
    this.chatTab.addEventListener('click', () => this.setTab('chat'))
    this.planTab.addEventListener('click', () => this.setTab('plan'))
    this.chatSend.addEventListener('click', () => this.sendChat())
    this.stopButton.addEventListener('click', () => this.chatRequest('/stop', 'POST'))
    this.newChat.addEventListener('click', () => this.chatRequest('', 'DELETE'))

    this.el.append(
      h('header', { class: 'fb-head' }, h('div', { class: 'fb-tabs' }, this.chatTab, this.planTab), this.newChat, close),
      this.presence,
      this.chatList,
      this.list,
      h(
        'footer',
        { class: 'fb-compose' },
        h('div', { class: 'fb-context' }, this.slideChip, this.targetChip, this.pickButton),
        this.input,
        h('div', { class: 'fb-actions chat-actions' }, h('div', { class: 'fb-mode' }, this.askMode, this.planMode), this.stopButton, this.chatSend),
        h('div', { class: 'fb-actions plan-actions' }, copy, this.sendButton),
      ),
    )
    document.body.append(this.hover)

    // Pin mode: hover outlines the element under the pointer; click pins it.
    host.viewport.addEventListener('mousemove', (e) => this.picking && this.highlight(this.pickable(e.target as HTMLElement)))
    host.viewport.addEventListener(
      'click',
      (e) => {
        if (!this.picking) return
        e.preventDefault()
        e.stopPropagation()
        const el = this.pickable(e.target as HTMLElement)
        this.target = el ? describe(el) : { kind: 'area', label: 'slide area' }
        this.deckWide = false
        this.pick(false)
        this.renderContext()
        this.input.focus()
      },
      true,
    )
    window.addEventListener('keydown', (e) => {
      if (this.picking && e.key === 'Escape') {
        e.stopPropagation()
        this.pick(false)
      }
    }, true)
    this.setMode(this.mode)
    this.render()
  }

  /** The reviewed deck: chat, plan and delivery are keyed to it, also on its plan's page. */
  private get review() {
    return this.host.deck.planFor ?? this.host.deck.id
  }

  private get planId() {
    return `${this.review}-plan`
  }

  /** Reopens the panel after switching between the deck and its plan. */
  restore() {
    const saved = sessionStorage.getItem('ferry-panel')
    if (saved !== 'chat' && saved !== 'plan') return
    this.setTab(saved)
    this.toggle(true)
  }

  startPlanning() {
    this.setTab('chat')
    this.setMode('plan')
    if (!this.open) this.toggle(true)
  }

  setMode(mode: Mode) {
    this.mode = mode
    localStorage.setItem(`ferry-chat-mode:${this.review}`, mode)
    this.askMode.classList.toggle('on', mode === 'ask')
    this.planMode.classList.toggle('on', mode === 'plan')
    this.el.classList.toggle('mode-plan', mode === 'plan')
    this.renderContext()
    this.renderChat()
  }

  toggle(open = !this.open) {
    this.open = open
    sessionStorage.setItem('ferry-panel', open ? this.tab : '')
    document.querySelector('.player')?.classList.toggle('fb-open', open)
    if (!open) this.pick(false)
    this.host.layoutChanged()
    if (open) {
      this.refresh()
      setTimeout(() => this.input.focus(), 50)
    }
  }

  /** Called by the player after every navigation. */
  moved() {
    if (!this.picking) this.target = undefined
    this.deckWide = false
    this.renderContext()
    this.render()
  }

  setPresence(listening: boolean) {
    this.listening = listening
    this.render()
    this.renderPresence()
  }

  setTab(tab: 'chat' | 'plan') {
    this.tab = tab
    if (this.open) sessionStorage.setItem('ferry-panel', tab)
    this.el.classList.toggle('tab-chat', tab === 'chat')
    this.el.classList.toggle('tab-plan', tab === 'plan')
    this.chatTab.classList.toggle('on', tab === 'chat')
    this.planTab.classList.toggle('on', tab === 'plan')
    this.renderContext()
    this.render()
    this.input.focus()
  }

  // ── chat ────────────────────────────────────────────────────────────────

  private chatUrl(path: string) {
    return `/api/decks/${this.review}/chat${path}`
  }

  private async chatRequest(path: string, method: string, body: object = {}) {
    const response = await fetch(this.chatUrl(path), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) this.host.flash(data.error ?? 'Chat request failed')
    return data
  }

  private async sendChat(text = this.input.value.trim()) {
    if (!text || this.running) return
    const slide = this.host.deck.slides[this.host.index]
    this.input.value = ''
    this.running = true
    this.renderChat()
    const result = await this.chatRequest('', 'POST', {
      text,
      mode: this.mode,
      viewing: this.host.deck.id,
      slideId: this.deckWide ? undefined : slide?.id,
      step: this.deckWide ? undefined : this.host.step,
      target: this.deckWide ? undefined : this.target,
    })
    if (result.error) {
      this.running = false
      this.input.value = text
      this.renderChat()
    }
    this.target = undefined
    this.renderContext()
  }

  /** Streaming updates from the server (SSE). */
  onChat(event: ChatEvent) {
    if (event.op === 'cleared') this.chat = []
    else if (event.op === 'message') {
      if (!this.chat.some((m) => m.id === event.message.id)) this.chat.push(event.message)
      if (event.message.role === 'agent') this.running = true
    } else if (event.op === 'delta') {
      const message = this.chat.find((m) => m.id === event.messageId)
      if (message) message.text += event.text
    } else if (event.op === 'tool') {
      const message = this.chat.find((m) => m.id === event.messageId)
      if (message) {
        message.tools ??= []
        const existing = message.tools.find((t) => t.id === event.tool.id)
        if (existing) Object.assign(existing, event.tool)
        else message.tools.push(event.tool)
      }
    } else if (event.op === 'end') {
      const index = this.chat.findIndex((m) => m.id === event.message.id)
      if (index >= 0) this.chat[index] = event.message
      else this.chat.push(event.message)
      this.running = false
      this.render() // the plan can be sent again
      if (!this.open || this.tab !== 'chat') this.host.flash('Claude replied in Chat')
    }
    if (this.renderQueued) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      this.renderChat()
    })
  }

  private renderChat() {
    this.chatSend.toggleAttribute('disabled', this.running)
    this.el.classList.toggle('running', this.running)
    const atBottom = this.chatList.scrollHeight - this.chatList.scrollTop - this.chatList.clientHeight < 60
    this.chatList.replaceChildren()
    if (!this.chat.length) {
      const chips = h('div', { class: 'fb-suggest' })
      for (const suggestion of SUGGESTIONS[this.mode]) {
        const chip = h('button', {}, suggestion)
        chip.addEventListener('click', () => this.sendChat(suggestion))
        chips.append(chip)
      }
      this.chatList.append(
        h(
          'div',
          { class: 'fb-empty chat' },
          h('div', { class: 'fb-empty-mark', html: icon(this.mode === 'plan' ? 'notes' : 'sparkles', 22) }),
          h('b', {}, this.mode === 'plan' ? 'Plan a change to the code' : 'Ask about what you’re looking at'),
          h('p', {
            html:
              this.mode === 'plan'
                ? 'Describe what should change. Claude reads the code and drafts the change as <b>plan slides</b>; nothing is implemented until you send the plan. <b>Pin</b> to point at a line.'
                : 'A Claude Code agent sees this slide and step, reads the code, and can edit these slides. Switch to <b>Plan</b> (Shift+Tab) to plan code changes. <b>Pin</b> to point at a line or node.',
          }),
          chips,
        ),
      )
    }
    for (const message of this.chat) this.chatList.append(this.bubble(message))
    if (atBottom || this.running) this.chatList.scrollTop = this.chatList.scrollHeight
  }

  private bubble(message: ChatMessage): HTMLElement {
    if (message.role === 'user') {
      const context = message.context
      const inPlan = context?.deckId === this.planId
      const where = context?.slideId ? `${inPlan ? 'Plan slide' : 'Slide'} ${(context.slideIndex ?? 0) + 1} · step ${(context.step ?? 0) + 1}${context.target ? ` · ${context.target.kind}` : ''}` : inPlan ? 'Whole plan' : 'Whole deck'
      const chip = h('button', { class: 'cb-where', title: context?.target ? `${context.target.kind}: ${context.target.label}` : '' }, where)
      chip.addEventListener('click', () => {
        if (context?.slideIndex === undefined) return
        if (context.deckId && context.deckId !== this.host.deck.id) this.host.openDeck(context.deckId, context.slideIndex)
        else this.host.goTo(context.slideIndex, context.step ?? 0)
      })
      const tag = message.mode === 'plan' ? h('span', { class: 'cb-mode' }, 'Plan') : null
      return h('div', { class: 'cb user' }, h('div', { class: 'cb-meta' }, tag, chip), h('div', { class: 'cb-text', html: markdown(message.text) }))
    }
    const streaming = message.status === 'streaming'
    const bubble = h('div', { class: `cb agent ${message.status ?? 'done'}` })
    const doing = message.mode === 'implement' ? '<span class="cb-mode">Implementing</span>' : message.mode === 'plan' ? '<span class="cb-mode">Plan</span>' : ''
    bubble.append(h('div', { class: 'cb-head', html: `${icon('sparkles', 13)}<b>Claude</b>${doing}${streaming && !message.text ? '<span class="cb-thinking">thinking…</span>' : ''}${message.status === 'stopped' ? '<span>stopped</span>' : ''}` }))
    if (message.tools?.length) {
      bubble.append(
        h(
          'div',
          { class: 'cb-tools' },
          ...message.tools.map((tool) => h('div', { class: `cb-tool${tool.done ? ' done' : ''}`, html: `${tool.done ? icon('check', 12) : '<i class="spin"></i>'}<span>${escape(tool.label)}</span>` })),
        ),
      )
    }
    if (message.text) bubble.append(h('div', { class: `cb-text${streaming ? ' caret' : ''}`, html: markdown(message.text) }))
    return bubble
  }

  async refresh() {
    try {
      const planned = !this.host.deck.planFor && this.host.deck.plan?.slideCount
      const [data, chat, plan] = await Promise.all([
        fetch(this.url('')).then((r) => r.json()),
        fetch(this.chatUrl('')).then((r) => r.json()),
        planned ? fetch(`/api/decks/${this.planId}`).then((r) => (r.ok ? r.json() : null)) : null,
      ])
      this.planSlides = (plan?.slides ?? []).map((s: { title?: string; type: string }) => s.title ?? s.type)
      this.items = data.items ?? []
      this.listening = !!data.listening
      this.chat = chat.messages ?? []
      this.running = !!chat.running
    } catch {
      return
    }
    this.renderChat()
    this.render()
    this.renderPresence()
    const counts = new Map<string, number>()
    for (const item of this.items) if (item.slideId && ['draft', 'open', 'working'].includes(item.status) && item.text) counts.set(item.slideId, (counts.get(item.slideId) ?? 0) + 1)
    this.host.countsChanged(counts)
  }

  private url(path: string) {
    return `/api/decks/${this.review}/feedback${path}`
  }

  private async post(path: string, body: object) {
    const response = await fetch(this.url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error((await response.json()).error)
    return response.json()
  }

  private async send() {
    const result = await this.post('/send', {})
    await this.refresh()
    if (result.error) this.host.flash(result.error)
    else if (result.applying) this.host.flash('Claude is implementing the plan · follow along in Chat')
    else if (result.sent) this.host.flash('Plan sent to the agent')
  }

  private async remove(id: string) {
    await fetch(this.url(`/${id}`), { method: 'DELETE', headers: { 'content-type': 'application/json' } })
    await this.refresh()
  }

  private async reply(id: string, text: string) {
    await this.post(`/${id}`, { reply: text })
    await this.refresh()
  }

  private copy() {
    const prompt = `Implement the plan I built in Ferry while reviewing "${this.reviewTitle}": read the plan deck with get_deck (deck_id: ${this.planId}). Its slides propose code changes, with hand-written diffs showing the intended code. Make those changes in the repository, on the checked-out branch, without committing, then tell me what you changed.`
    navigator.clipboard?.writeText(prompt).then(
      () => this.host.flash('Copied — paste it into your agent'),
      () => this.host.flash('Could not copy to the clipboard'),
    )
  }

  private get reviewTitle() {
    return this.host.deck.title.replace(/^Plan: /, '')
  }

  // ── pinning ─────────────────────────────────────────────────────────────

  pick(on: boolean) {
    this.picking = on
    document.querySelector('.player')?.classList.toggle('picking', on)
    this.pickButton.classList.toggle('on', on)
    if (!on) this.hover.classList.remove('on')
  }

  private pickable(el: HTMLElement | null): HTMLElement | null {
    if (!el || !this.host.stage.contains(el) || el.closest('.bar')) return null
    return (el.closest('[data-ref]') as HTMLElement | null) ?? (el.closest('.slide') ? el : null)
  }

  private highlight(el: HTMLElement | null) {
    if (!el || el.classList.contains('slide')) {
      this.hover.classList.remove('on')
      return
    }
    const rect = el.getBoundingClientRect()
    Object.assign(this.hover.style, { left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` })
    this.hover.dataset.label = describe(el).kind
    this.hover.classList.add('on')
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private renderContext() {
    const slide = this.host.deck.slides[this.host.index]
    this.slideChip.innerHTML = this.deckWide || !slide ? `${icon('layers', 13)}<span>Whole deck</span>` : `<span>Slide ${this.host.index + 1} · step ${this.host.step + 1}</span>${icon('x', 12)}`
    this.slideChip.title = this.deckWide ? 'Click to comment on the current slide' : 'Click to comment on the whole deck'
    this.targetChip.style.display = this.target ? '' : 'none'
    if (this.target) this.targetChip.innerHTML = `<span>${escape(this.target.kind)}: ${escape(this.target.label.slice(0, 60))}</span>${icon('x', 12)}`
    this.input.placeholder =
      this.mode === 'plan'
        ? this.target
          ? `What should change in this ${this.target.kind}?`
          : 'Describe a code change to plan…'
        : this.target
          ? `Ask about this ${this.target.kind}…`
          : 'Ask anything about this change…'
  }

  private renderPresence() {
    const working = this.items.filter((i) => i.status === 'working' && i.thread[i.thread.length - 1]?.from !== 'agent').length
    this.presence.classList.toggle('on', this.listening)
    this.presence.classList.toggle('busy', !this.listening && working > 0)
    this.presence.innerHTML = this.listening
      ? '<i></i><span><b>Agent is listening</b> — send the plan and it starts implementing.</span>'
      : working
        ? '<i></i><span><b>Agent is implementing</b> the plan. It replies here when it’s done.</span>'
        : '<i></i><span><b>Send</b> hands the plan to Claude here: it implements it in your repository, on the checked-out branch, without committing. To use your own agent, Copy as prompt.</span>'
  }

  render() {
    const deck = this.host.deck
    const current = deck.slides[this.host.index]?.id
    const onPlan = !!deck.planFor
    const plan = onPlan ? { id: deck.id, slideCount: deck.slides.length, updatedAt: deck.updatedAt } : deck.plan
    const slides = onPlan ? deck.slides.map((s) => s.title ?? s.type) : this.planSlides
    const count = plan?.slideCount ?? 0
    const inFlight = this.items.some((i) => i.plan && (i.status === 'open' || i.status === 'working'))
    const drafts = this.items.filter((i) => i.status === 'draft').length
    this.planTab.innerHTML = `${icon('notes', 14)}<span>Plan</span>${count ? `<em>${count}</em>` : ''}`
    this.planTab.title = 'Review the plan and send it to an agent'
    this.sendButton.innerHTML = `${icon('arrow', 15)}<span>${inFlight ? 'Plan sent' : 'Send plan to agent'}</span>`
    this.sendButton.toggleAttribute('disabled', (!count || inFlight) && !drafts)

    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40
    this.list.replaceChildren()
    if (!count) {
      const start = h('button', { class: 'fb-copy' }, 'Start planning')
      start.addEventListener('click', () => this.startPlanning())
      this.list.append(
        h(
          'div',
          { class: 'fb-plan-card empty' },
          h('b', {}, 'No plan yet'),
          h('p', { html: 'Switch the chat to <b>Plan</b> and describe what should change in the code. Claude drafts it as slides you review and revise here; nothing is implemented until you send the plan.' }),
          start,
        ),
      )
    } else {
      const list = h('ol', { class: 'fb-plan-slides' })
      slides.forEach((title, i) => {
        const item = h('button', {}, h('span', {}, String(i + 1).padStart(2, '0')), h('b', {}, title.replace(/\*/g, '')))
        item.addEventListener('click', () => (onPlan ? this.host.goTo(i, 0) : this.host.openDeck(plan!.id, i)))
        list.append(h('li', { class: onPlan && i === this.host.index ? 'now' : '' }, item))
      })
      const view = h('button', { class: 'fb-copy' }, onPlan ? 'Back to the change' : 'View plan slides')
      view.addEventListener('click', () => this.host.openDeck(onPlan ? this.review : plan!.id))
      this.list.append(
        h(
          'div',
          { class: 'fb-plan-card' },
          h('div', { class: 'fb-plan-head' }, h('b', {}, 'Plan'), h('span', {}, `${count} slide${count === 1 ? '' : 's'} · updated ${ago(plan!.updatedAt)}`)),
          list,
          h('p', { html: 'Revise it in the chat (Plan mode). When it looks right, send it: the agent implements it in your repository.' }),
          view,
        ),
      )
    }
    if (this.items.length) this.list.append(h('div', { class: 'fb-section' }, 'Sent to the agent'))
    for (const item of this.items) this.list.append(this.card(item, item.slideId === current))
    if (atBottom) this.list.scrollTop = this.list.scrollHeight
  }

  private card(item: Item, here: boolean): HTMLElement {
    const deck = this.host.deck
    const index = item.slideId ? deck.slides.findIndex((s) => s.id === item.slideId) : -1
    const lastFromAgent = item.thread[item.thread.length - 1]?.from === 'agent'
    const statusLabel: Record<Status, string> = {
      draft: 'Draft',
      open: 'Sent',
      working: lastFromAgent ? 'Agent asked' : 'Agent working…',
      done: 'Done',
      declined: 'Declined',
    }
    const card = h('div', { class: `fb-item ${item.status}${here ? ' here' : ''}${item.text ? '' : ' agent-only'}` })
    const where = h('button', { class: 'fb-where' }, item.plan ? 'Plan' : item.slideId ? (index >= 0 ? `Slide ${index + 1} · step ${(item.step ?? 0) + 1}` : 'Removed slide') : 'Whole deck')
    where.addEventListener('click', () => (item.plan ? this.host.openDeck(item.plan.id) : index >= 0 && this.host.goTo(index, item.step ?? 0)))
    if (item.text) {
      card.append(h('div', { class: 'fb-meta' }, where, h('span', { class: 'fb-status' }, statusLabel[item.status]), h('span', { class: 'fb-time' }, ago(item.createdAt))))
      if (item.target) card.append(h('div', { class: 'fb-target', html: `${icon('search', 12)}<span>${escape(item.target.kind)}: ${escape(item.target.label)}</span>` }))
      card.append(h('div', { class: 'fb-text', html: rich(item.text) }))
    }
    for (const message of item.thread) {
      card.append(h('div', { class: `fb-msg ${message.from}` }, h('div', { class: 'fb-msg-head', html: `${message.from === 'agent' ? icon('sparkles', 12) : ''}<b>${message.from === 'agent' ? 'Agent' : 'You'}</b><span>${ago(message.at)}</span>` }), h('div', { class: 'fb-msg-text', html: rich(message.text) })))
    }
    if (item.status === 'draft') {
      const del = h('button', { class: 'fb-link' }, 'Delete')
      del.addEventListener('click', () => this.remove(item.id))
      card.append(h('div', { class: 'fb-item-actions' }, del))
    } else if (item.text || item.thread.length) {
      const replyInput = h('input', { class: 'fb-reply', placeholder: item.status === 'done' || item.status === 'declined' ? 'Not quite? Reply to reopen…' : 'Reply…' }) as HTMLInputElement
      replyInput.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && replyInput.value.trim()) this.reply(item.id, replyInput.value.trim())
      })
      card.append(replyInput)
    }
    return card
  }
}

/** A pinned element as the agent will read it. */
function describe(el: HTMLElement): { kind: string; label: string } {
  const kind = el.dataset.ref ?? 'text'
  const label = (el.dataset.label ?? el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return { kind, label: label || kind }
}
