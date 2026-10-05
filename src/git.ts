import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileStatus } from './model.ts'

export function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || error.message).trim()}`))
      else resolve(stdout)
    })
  })
}

export interface Range {
  repo: string
  /** Commit holding the old content. */
  before: string
  /** Commit holding the new content; null for the working tree. */
  after: string | null
  label: string
}

/**
 * Resolve a review range. Like a pull request, a branch base compares against
 * its merge-base with head, so unrelated base-branch commits stay out.
 */
export async function resolveRange(repo: string, base = 'HEAD', head?: string): Promise<Range> {
  await git(repo, ['rev-parse', '--git-dir']).catch(() => {
    throw new Error(`${repo} is not a git repository`)
  })
  const target = head ?? 'HEAD'
  let before = (await git(repo, ['rev-parse', '--verify', `${base}^{commit}`])).trim()
  const targetSha = (await git(repo, ['rev-parse', '--verify', `${target}^{commit}`]).catch(() => '')).trim()
  if (targetSha && targetSha !== before) {
    const mergeBase = (await git(repo, ['merge-base', before, targetSha]).catch(() => '')).trim()
    if (mergeBase) before = mergeBase
  }
  return { repo, before, after: head ? targetSha || head : null, label: head ? `${base}…${head}` : `${base} → working tree` }
}

export interface ChangedFile {
  path: string
  oldPath?: string
  status: FileStatus
  additions: number
  deletions: number
  binary: boolean
}

const STATUS: Record<string, FileStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' }

export async function changedFiles(range: Range): Promise<ChangedFile[]> {
  const refs = range.after ? [range.before, range.after] : [range.before]
  const [numstat, nameStatus] = await Promise.all([
    git(range.repo, ['diff', '--numstat', '-M', '-z', ...refs, '--']),
    git(range.repo, ['diff', '--name-status', '-M', '-z', ...refs, '--']),
  ])
  const files = new Map<string, ChangedFile>()

  const ns = nameStatus.split('\0')
  for (let i = 0; i < ns.length - 1; ) {
    const code = ns[i++]
    const kind = code[0]
    if (kind === 'R' || kind === 'C') {
      const oldPath = ns[i++]
      const path = ns[i++]
      files.set(path, { path, oldPath, status: STATUS[kind], additions: 0, deletions: 0, binary: false })
    } else {
      const path = ns[i++]
      files.set(path, { path, status: STATUS[kind] ?? 'modified', additions: 0, deletions: 0, binary: false })
    }
  }

  // numstat -z: "add\tdel\tpath\0" or, for renames, "add\tdel\t\0old\0new\0".
  const parts = numstat.split('\0')
  for (let i = 0; i < parts.length - 1; ) {
    const [add, del, inlinePath] = parts[i++].split('\t')
    let path = inlinePath
    if (!path) {
      i++ // old path
      path = parts[i++]
    }
    const file = files.get(path)
    if (!file) continue
    file.binary = add === '-'
    file.additions = Number(add) || 0
    file.deletions = Number(del) || 0
  }

  if (!range.after) {
    const untracked = (await git(range.repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    for (const path of untracked) {
      const text = await readFile(join(range.repo, path), 'utf8').catch(() => null)
      const binary = text === null || text.includes('\0')
      files.set(path, { path, status: 'added', additions: binary ? 0 : countLines(text!), deletions: 0, binary })
    }
  }
  return [...files.values()]
}

export async function fileAt(repo: string, ref: string | null, path: string): Promise<string | null> {
  if (ref === null) return readFile(join(repo, path), 'utf8').catch(() => null)
  return git(repo, ['show', `${ref}:${path}`]).catch(() => null)
}

export async function describeRange(range: Range): Promise<{ subject?: string; branch?: string; author?: string }> {
  const branch = (await git(range.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || undefined
  const ref = range.after ?? 'HEAD'
  const log = (await git(range.repo, ['log', '-1', '--format=%s%x00%an', ref]).catch(() => '')).trim()
  const [subject, author] = log.split('\0')
  return { subject: range.after ? subject : undefined, branch, author: author || undefined }
}

export function countLines(text: string): number {
  if (!text) return 0
  const n = text.split('\n').length
  return text.endsWith('\n') ? n - 1 : n
}

const GENERATED = [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/, /(^|\/)(dist|build|vendor|node_modules)\//, /\.min\.(js|css)$/, /\.snap$/]

export function isNoise(path: string): boolean {
  return GENERATED.some((pattern) => pattern.test(path))
}
