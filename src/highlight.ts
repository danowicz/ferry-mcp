import { bundledLanguages, codeToTokensWithThemes, type BundledLanguage, type BundledTheme } from 'shiki'
import { THEMES, type Palette, type Token } from './model.ts'

/** Shiki theme per presentation theme, in THEMES order. */
const SHIKI_THEMES: Record<(typeof THEMES)[number], BundledTheme> = {
  midnight: 'vesper',
  tokyo: 'tokyo-night',
  evergreen: 'everforest-dark',
  paper: 'vitesse-light',
}

const EXTENSIONS: Record<string, string> = {
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', scala: 'scala', sc: 'scala', cs: 'csharp', fs: 'fsharp', c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', hpp: 'cpp', m: 'objective-c', php: 'php', ex: 'elixir', exs: 'elixir',
  erl: 'erlang', hs: 'haskell', ml: 'ocaml', clj: 'clojure', dart: 'dart', lua: 'lua', zig: 'zig',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish', ps1: 'powershell', sql: 'sql', graphql: 'graphql',
  gql: 'graphql', json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', less: 'less', md: 'markdown', mdx: 'mdx', vue: 'vue',
  svelte: 'svelte', astro: 'astro', prisma: 'prisma', proto: 'proto', tf: 'hcl', hcl: 'hcl',
  dockerfile: 'docker', makefile: 'make', nix: 'nix', sol: 'solidity', r: 'r', jl: 'julia',
}

export function languageFor(file: string | undefined, explicit?: string): string {
  if (explicit) return explicit.toLowerCase()
  if (!file) return 'text'
  const base = file.split('/').pop()!.toLowerCase()
  if (base === 'dockerfile') return 'docker'
  if (base === 'makefile') return 'make'
  const ext = base.includes('.') ? base.split('.').pop()! : ''
  return EXTENSIONS[ext] ?? (ext in bundledLanguages ? ext : 'text')
}

/** Builds a palette shared by every highlighted text of one slide. */
export class PaletteBuilder {
  readonly palette: Palette = []
  private index = new Map<string, number>()

  add(key: string): number {
    let i = this.index.get(key)
    if (i === undefined) {
      i = this.palette.length
      this.palette.push(key)
      this.index.set(key, i)
    }
    return i
  }
}

const themes: Record<string, BundledTheme> = Object.fromEntries(THEMES.map((name) => [name, SHIKI_THEMES[name]]))

/** Highlight `code` into one token array per line. */
export async function highlight(code: string, language: string, palette: PaletteBuilder): Promise<Token[][]> {
  const text = detab(code)
  const lang = (language in bundledLanguages ? language : 'text') as BundledLanguage | 'text'
  if (lang === 'text' || text.length > 400_000) return text.split('\n').map((line) => [[line, palette.add('')]])
  try {
    const lines = await codeToTokensWithThemes(text, { lang: lang as BundledLanguage, themes })
    return lines.map((tokens) =>
      merge(
        tokens.map((token) => {
          const variants = THEMES.map((name) => token.variants[name]?.color ?? '')
          const style = token.variants[THEMES[0]]?.fontStyle ?? 0
          return [token.content, palette.add(`${variants.join('|')}|${style}`)] as Token
        }),
      ),
    )
  } catch {
    return text.split('\n').map((line) => [[line, palette.add('')]])
  }
}

function merge(tokens: Token[]): Token[] {
  const out: Token[] = []
  for (const token of tokens) {
    const last = out[out.length - 1]
    if (last && last[1] === token[1]) last[0] += token[0]
    else out.push([token[0], token[1]])
  }
  return out
}

export function detab(text: string): string {
  return text.replace(/\t/g, '    ').replace(/\r\n?/g, '\n')
}
