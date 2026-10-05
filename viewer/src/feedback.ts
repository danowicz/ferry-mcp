// Feedback panel: comment on slides, pin comments to elements, collect them
// into a change plan, send it to the agent, and read the agent's replies.
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
  text: string
  thread: { from: 'user' | 'agent'; text: string; at: string }[]
}

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  at: string
  context?: { slideId?: string; slideIndex?: number; step?: number; target?: { kind: string; label: string } }
  tools?: { id: string; name: string; label: string; done: boolean }[]
  status?: 'streaming' | 'done' | 'error' | 'stopped'
}

export type ChatEvent =
  | { op: 'message'; message: ChatMessage }
  | { op: 'delta'; messageId: string; text: string }
  | { op: 'tool'; messageId: string; tool: NonNullable<ChatMessage['tools']>[number] }
  | { op: 'end'; message: ChatMessage }
  | { op: 'cleared' }

const SUGGESTIONS = ['Explain this step more simply', 'Why does this change matter?', 'Tighten the narration on this slide', 'Add a callout on the most important line']

export interface FeedbackHost {
  deck: CompiledDeck
  index: number
  step: number
  stage: HTMLElement
  viewport: HTMLElement
  goTo(slideIndex: number, step: number): void
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
  private planTab = h('button', { class: 'fb-tab', html: `${icon('notes', 14)}<span>Change plan</span>` })
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
  private filterButton = h('button', { class: 'fb-filter fb-only' })
  private hover = h('div', { class: 'pick-hover' })
  private target: Item['target'] | undefined
  private deckWide = false
  private onlyHere = false
  private picking = false

  constructor(private host: FeedbackHost) {
    const close = h('button', { class: 'icon-btn', title: 'Close (C)', html: icon('x', 16) })
    close.addEventListener('click', () => this.toggle(false))
    this.filterButton.addEventListener('click', () => {
      this.onlyHere = !this.onlyHere
      this.render()
    })
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
        if (this.tab === 'chat') this.sendChat()
        else this.add(e.metaKey || e.ctrlKey)
      } else if (e.key === 'Escape') this.input.blur()
    })
    this.sendButton.addEventListener('click', () => this.send())
    const copy = h('button', { class: 'fb-copy', title: 'Copy the change plan as a prompt for any agent', html: `${icon('file', 14)}<span>Copy as prompt</span>` })
    copy.addEventListener('click', () => this.copy())
    const addToPlan = h('button', { class: 'fb-copy', title: 'Queue this as a request for the agent that built the deck', html: `${icon('notes', 14)}<span>Add to plan</span>` })
    addToPlan.addEventListener('click', () => this.add(false))
    this.chatTab.addEventListener('click', () => this.setTab('chat'))
    this.planTab.addEventListener('click', () => this.setTab('plan'))
    this.chatSend.addEventListener('click', () => this.sendChat())
    this.stopButton.addEventListener('click', () => this.chatRequest('/stop', 'POST'))
    this.newChat.addEventListener('click', () => this.chatRequest('', 'DELETE'))

    this.el.append(
      h('header', { class: 'fb-head' }, h('div', { class: 'fb-tabs' }, this.chatTab, this.planTab), this.newChat, this.filterButton, close),
      this.presence,
      this.chatList,
      this.list,
      h(
        'footer',
        { class: 'fb-compose' },
        h('div', { class: 'fb-context' }, this.slideChip, this.targetChip, this.pickButton),
        this.input,
        h('div', { class: 'fb-actions chat-actions' }, addToPlan, this.stopButton, this.chatSend),
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
    this.renderContext()
    this.render()
  }

  toggle(open = !this.open) {
    this.open = open
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
    this.renderPresence()
  }

  setTab(tab: 'chat' | 'plan') {
    this.tab = tab
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
    return `/api/decks/${this.host.deck.id}/chat${path}`
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
      if (!this.open || this.tab !== 'chat') this.host.flash('The agent replied in Chat')
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
      for (const suggestion of SUGGESTIONS) {
        const chip = h('button', {}, suggestion)
        chip.addEventListener('click', () => this.sendChat(suggestion))
        chips.append(chip)
      }
      this.chatList.append(
        h(
          'div',
          { class: 'fb-empty chat' },
          h('div', { class: 'fb-empty-mark', html: icon('sparkles', 22) }),
          h('b', {}, 'Ask about what you’re looking at'),
          h('p', { html: 'A Claude Code agent sees this slide and step, reads the code, and can edit the deck live. <b>Pin</b> to point at a line or node.' }),
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
      const where = context?.slideId ? `Slide ${(context.slideIndex ?? 0) + 1} · step ${(context.step ?? 0) + 1}${context.target ? ` · ${context.target.kind}` : ''}` : 'Whole deck'
      const chip = h('button', { class: 'cb-where', title: context?.target ? `${context.target.kind}: ${context.target.label}` : '' }, where)
      chip.addEventListener('click', () => context?.slideIndex !== undefined && this.host.goTo(context.slideIndex, context.step ?? 0))
      return h('div', { class: 'cb user' }, chip, h('div', { class: 'cb-text', html: markdown(message.text) }))
    }
    const streaming = message.status === 'streaming'
    const bubble = h('div', { class: `cb agent ${message.status ?? 'done'}` })
    bubble.append(h('div', { class: 'cb-head', html: `${icon('sparkles', 13)}<b>Claude</b>${streaming && !message.text ? '<span class="cb-thinking">thinking…</span>' : ''}${message.status === 'stopped' ? '<span>stopped</span>' : ''}` }))
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
      const [data, chat] = await Promise.all([fetch(this.url('')).then((r) => r.json()), fetch(this.chatUrl('')).then((r) => r.json())])
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
    return `/api/decks/${this.host.deck.id}/feedback${path}`
  }

  private async post(path: string, body: object) {
    const response = await fetch(this.url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error((await response.json()).error)
    return response.json()
  }

  private async add(sendNow = false) {
    const text = this.input.value.trim()
    if (!text) return
    if (this.tab === 'chat') this.host.flash('Added to the change plan')
    const slide = this.host.deck.slides[this.host.index]
    await this.post('', {
      text,
      slideId: this.deckWide ? undefined : slide?.id,
      step: this.deckWide ? undefined : this.host.step,
      target: this.deckWide ? undefined : this.target,
      send: false,
    })
    this.input.value = ''
    this.target = undefined
    this.renderContext()
    if (sendNow) await this.send()
    else await this.refresh()
    this.list.scrollTop = this.list.scrollHeight
  }

  private async send() {
    if (this.input.value.trim()) return this.add(true)
    const result = await this.post('/send', {})
    await this.refresh()
    if (result.sent) this.host.flash(this.listening ? `Sent ${result.sent} request${result.sent === 1 ? '' : 's'} to the agent` : 'Plan sent · no agent is listening — use “Copy as prompt”')
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
    const deck = this.host.deck
    const pending = this.items.filter((i) => i.text && ['draft', 'open', 'working'].includes(i.status))
    const lines = pending.map((item, n) => {
      const index = deck.slides.findIndex((s) => s.id === item.slideId)
      const where = index >= 0 ? `slide ${index + 1} (${item.slideId}), step ${(item.step ?? 0) + 1}` : 'whole deck'
      return `${n + 1}. [${item.id}] ${where}${item.target ? ` — pinned to ${item.target.kind}: ${item.target.label}` : ''}\n   ${item.text}`
    })
    const prompt = `Apply my feedback on the Ferry deck "${deck.title}" (deck_id: ${deck.id}). Call get_feedback with that deck_id for the full change plan, update the slides, then resolve_feedback with a short reply per item.${lines.length ? `\n\n${lines.join('\n')}` : ''}`
    navigator.clipboard?.writeText(prompt).then(
      () => this.host.flash('Copied — paste it into your agent'),
      () => this.host.flash('Could not copy to the clipboard'),
    )
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
      this.tab === 'chat'
        ? this.target
          ? `Ask about this ${this.target.kind}…`
          : 'Ask anything, or ask for a change…'
        : this.deckWide
          ? 'Ask for a change to the whole deck…'
          : this.target
            ? `Comment on this ${this.target.kind}…`
            : 'Ask for a change on this slide…'
  }

  private renderPresence() {
    const working = this.items.filter((i) => i.status === 'working' && i.thread[i.thread.length - 1]?.from !== 'agent').length
    this.presence.classList.toggle('on', this.listening)
    this.presence.classList.toggle('busy', !this.listening && working > 0)
    this.presence.innerHTML = this.listening
      ? '<i></i><span><b>Agent is listening</b> — send your plan and it starts working.</span>'
      : working
        ? `<i></i><span><b>Agent is working</b> on ${working} request${working === 1 ? '' : 's'}. Slides update here as it goes.</span>`
        : '<i></i><span>No agent listening. Send the plan, then tell your agent “apply my Ferry feedback” — or use Copy as prompt.</span>'
  }

  private render() {
    const deck = this.host.deck
    const current = deck.slides[this.host.index]?.id
    const items = this.items.filter((i) => !this.onlyHere || i.slideId === current)
    this.filterButton.textContent = this.onlyHere ? 'This slide' : 'All slides'
    const drafts = this.items.filter((i) => i.status === 'draft').length
    const pending = this.items.filter((i) => i.text && ['draft', 'open', 'working'].includes(i.status)).length
    this.planTab.innerHTML = `${icon('notes', 14)}<span>Change plan</span>${pending ? `<em>${pending}</em>` : ''}`
    this.planTab.title = 'Requests queued for the agent that built the deck'
    this.sendButton.innerHTML = `${icon('arrow', 15)}<span>Send to agent${drafts ? ` · ${drafts}` : ''}</span>`
    this.sendButton.toggleAttribute('disabled', drafts === 0)

    const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40
    this.list.replaceChildren()
    if (!items.length) {
      this.list.append(
        h(
          'div',
          { class: 'fb-empty' },
          h('b', {}, this.onlyHere ? 'No feedback on this slide yet' : 'No feedback yet'),
          h('p', { html: 'Write what should change below. Use <b>Pin</b> to point at a code line, node or row. Comments collect into a <em>change plan</em> you send to the agent.' }),
        ),
      )
    }
    for (const item of items) this.list.append(this.card(item, item.slideId === current))
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
    const where = h('button', { class: 'fb-where' }, item.slideId ? (index >= 0 ? `Slide ${index + 1} · step ${(item.step ?? 0) + 1}` : 'Removed slide') : 'Whole deck')
    where.addEventListener('click', () => index >= 0 && this.host.goTo(index, item.step ?? 0))
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
