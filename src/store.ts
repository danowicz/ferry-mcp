import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { compileSlide } from './compile.ts'
import type { CompiledDeck, SectionSlide, Slide, ThemeName } from './model.ts'
import type { SlideInput } from './schema.ts'
import { slugify } from './text.ts'

export type SourceSlide = SlideInput & { id: string }

export interface StoredDeck extends CompiledDeck {
  source: SourceSlide[]
}

export function ferryHome(): string {
  return process.env.FERRY_HOME ?? join(homedir(), '.ferry')
}

export function decksDir(): string {
  return join(ferryHome(), 'decks')
}

function deckPath(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid deck id "${id}"`)
  return join(decksDir(), `${id}.json`)
}

export async function loadDeck(id: string): Promise<StoredDeck> {
  const text = await readFile(deckPath(id), 'utf8').catch(() => {
    throw new Error(`deck "${id}" not found — call list_decks to see existing decks`)
  })
  return JSON.parse(text)
}

export async function saveDeck(deck: StoredDeck): Promise<void> {
  await mkdir(decksDir(), { recursive: true })
  deck.updatedAt = new Date().toISOString()
  deck.revision++
  renumberSections(deck)
  const path = deckPath(deck.id)
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(deck))
  await rename(temp, path)
}

/** Deletes a deck along with its change plan, agent-presence beacon and viewer chat. */
export async function deleteDeck(id: string): Promise<void> {
  await rm(deckPath(id)).catch(() => {
    throw new Error(`deck "${id}" not found — call list_decks to see existing decks`)
  })
  const home = ferryHome()
  const extras = [join(home, 'feedback', `${id}.json`), join(home, 'feedback', `${id}.listening`), join(home, 'chat', `${id}.json`)]
  await Promise.all(extras.map((path) => rm(path, { force: true })))
}

export type DeckSummary = Omit<CompiledDeck, 'slides'> & { slideCount: number; firstSlide?: string }

export async function listDecks(): Promise<DeckSummary[]> {
  const names = await readdir(decksDir()).catch(() => [] as string[])
  const decks = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const deck: StoredDeck = JSON.parse(await readFile(join(decksDir(), name), 'utf8'))
          const { slides, source, ...meta } = deck
          void source
          return { ...meta, slideCount: slides.length, firstSlide: slides[0]?.type }
        } catch {
          return null
        }
      }),
  )
  return (decks.filter(Boolean) as DeckSummary[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function newDeck(meta: { title: string; subtitle?: string; repo?: string; ref?: string; theme?: ThemeName }): StoredDeck {
  const now = new Date().toISOString()
  return {
    id: `${slugify(meta.title, 32)}-${randomBytes(2).toString('hex')}`,
    title: meta.title,
    subtitle: meta.subtitle,
    repo: meta.repo,
    ref: meta.ref,
    theme: meta.theme ?? 'midnight',
    createdAt: now,
    updatedAt: now,
    revision: 0,
    slides: [],
    source: [],
  }
}

/** Gives each incoming slide a deck-unique id, preserving explicit ones. */
export function assignId(deck: StoredDeck, input: SlideInput, taken = new Set(deck.source.map((s) => s.id))): SourceSlide {
  const wanted = slugify(input.id ?? input.title?.replace(/\*/g, '') ?? input.type)
  let id = wanted
  for (let n = 2; taken.has(id); n++) id = `${wanted}-${n}`
  taken.add(id)
  return { ...input, id }
}

export async function compileInto(deck: StoredDeck, slides: SourceSlide[]): Promise<{ compiled: Slide[]; warnings: string[] }> {
  const warnings: string[] = []
  const compiled = await Promise.all(
    slides.map(async (slide) => {
      const result = await compileSlide(slide, { section: 1 })
      warnings.push(...result.warnings)
      return result.slide
    }),
  )
  return { compiled, warnings }
}

function renumberSections(deck: StoredDeck): void {
  let n = 0
  deck.slides.forEach((slide, i) => {
    if (slide.type !== 'section') return
    n++
    const source = deck.source[i] as Extract<SourceSlide, { type: 'section' }> | undefined
    if (!source?.number) (slide as SectionSlide).number = String(n).padStart(2, '0')
  })
}
