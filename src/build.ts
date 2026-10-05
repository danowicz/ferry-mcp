import { build } from 'esbuild'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'viewer', 'src')
const OUT = join(ROOT, 'dist')
const modules = join(ROOT, 'node_modules')

export const FONT_FILES: Record<string, string> = {
  'inter.woff2': join(modules, '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'),
  'inter-ext.woff2': join(modules, '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2'),
  'mono.woff2': join(modules, '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2'),
  'mono-italic.woff2': join(modules, '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-italic.woff2'),
  'serif.woff2': join(modules, '@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2'),
  'serif-italic.woff2': join(modules, '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2'),
}

export function viewerAsset(name: 'viewer.js' | 'viewer.css'): string {
  return join(OUT, name)
}

async function newestSource(dir: string): Promise<number> {
  let newest = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? await newestSource(path) : (await stat(path)).mtimeMs)
  }
  return newest
}

let building: Promise<void> | null = null

/** Bundles the viewer when its sources are newer than the last build. */
export async function buildViewer(force = false): Promise<void> {
  if (building) return building
  building = (async () => {
    const built = await stat(viewerAsset('viewer.js')).then((s) => s.mtimeMs, () => 0)
    const model = (await stat(join(ROOT, 'src', 'model.ts'))).mtimeMs
    if (!force && built && built >= Math.max(await newestSource(SRC), model)) return
    await build({
      entryPoints: { viewer: join(SRC, 'main.ts') },
      outdir: OUT,
      bundle: true,
      format: 'iife',
      target: 'es2022',
      minify: true,
      sourcemap: false,
      loader: { '.svg': 'text' },
      external: ['/fonts/*'],
      logLevel: 'silent',
    })
  })().finally(() => (building = null))
  return building
}
