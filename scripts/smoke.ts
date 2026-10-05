// End-to-end check of every MCP tool against an isolated FERRY_HOME.
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { connect } from './client.ts'
import { createSampleRepo } from './sample-repo.ts'

const home = mkdtempSync(join(tmpdir(), 'ferry-smoke-'))
const repo = createSampleRepo()
const { client, call } = await connect({ FERRY_HOME: home, FERRY_PORT: '4790' })
const ok = (name: string) => console.log(`✓ ${name}`)

const tools = (await client.listTools()).tools.map((t) => t.name)
assert.ok(tools.includes('add_slides') && tools.includes('draft_deck_from_git'))
ok(`${tools.length} tools listed`)

assert.match(await call('authoring_guide'), /Ferry authoring guide/)
ok('authoring_guide')

const inspected = await call('inspect_changes', { repo, base: 'main', head: 'fix/bind-retry' })
assert.match(inspected, /change 3 @ line \d+ +\+7 −4 ~7 re-indented/)
ok('inspect_changes reports change blocks and re-indents')

const drafted = await call('draft_deck_from_git', { repo, base: 'main', head: 'fix/bind-retry' })
const id = drafted.match(/id: ([a-z0-9-]+)/)![1]
assert.match(drafted, /3\. \[.*\] diff/)
ok('draft_deck_from_git')

const added = await call('add_slides', {
  deck_id: id,
  after: 'what-changed',
  slides: [
    { type: 'points', title: 'Bad callout', points: [{ title: 'x' }] },
    { type: 'diff', title: 'Missing ref', git: { repo, path: 'src/server/bind.ts', base: 'main', head: 'fix/bind-retry' }, steps: [{ changes: [9], callouts: [{ at: 'nonexistent()', text: 'nope' }] }] },
  ],
})
assert.match(added, /Warnings/)
assert.match(added, /lists change 9/)
assert.match(added, /"nonexistent\(\)" matches no visible line/)
ok('add_slides returns actionable warnings')

const updated = await call('update_slide', { deck_id: id, slide_id: 'missing-ref', slide: { type: 'diff', title: 'Fixed', code: 'const a = 1\nconst b = 2', steps: [{ focus: [2], callouts: [{ at: 'b = 2', text: 'two' }] }] } })
assert.doesNotMatch(updated, /Warnings/)
ok('update_slide')

const bad = (await client.callTool({ name: 'update_slide', arguments: { deck_id: id, slide_id: 'missing-ref', slide: { type: 'diff' } } })) as { isError?: boolean; content: { text: string }[] }
assert.ok(bad.isError && /exactly one source/.test(bad.content[0].text))
ok('update_slide rejects a diff without a source')

await call('reorder_slides', { deck_id: id, order: ['bad-callout'] })
await call('remove_slides', { deck_id: id, slide_ids: ['missing-ref'] })
await call('update_deck', { deck_id: id, theme: 'tokyo', ref: 'PR #1' })
const deck = await call('get_deck', { deck_id: id })
assert.match(deck, /1\. \[bad-callout\]/)
assert.match(deck, /theme tokyo/)
assert.doesNotMatch(deck, /missing-ref\]/)
ok('reorder_slides, remove_slides, update_deck, get_deck')

assert.match(await call('list_decks'), new RegExp(id))
ok('list_decks')

const url = (await call('open_deck', { deck_id: id, launch: false })).match(/http:\/\/\S+/)![0]
const health = await fetch(new URL('/api/health', url)).then((r) => r.json())
assert.equal(health.ferry, true)
const compiled = await fetch(new URL(`/api/decks/${id}`, url)).then((r) => r.json())
assert.equal(compiled.theme, 'tokyo')
assert.ok(compiled.slides.every((s: { steps: unknown[] }) => s.steps.length > 0))
const js = await fetch(new URL('/assets/viewer.js', url))
assert.equal(js.status, 200)
ok(`viewer serves deck and bundle at ${url}`)

const out = join(home, 'export.html')
assert.match(await call('export_deck', { deck_id: id, path: out }), /Exported/)
const html = readFileSync(out, 'utf8')
assert.ok(existsSync(out) && html.includes('ferry-deck') && html.includes('data:font/woff2;base64') && !html.includes('/fonts/'))
ok(`export_deck (${Math.round(html.length / 1024)} KB, fonts inlined)`)

// Feedback loop: the viewer posts, the agent waits, resolves, and replies.
const api = new URL(`/api/decks/${id}/feedback`, url)
const post = (path: string, body: object) => fetch(new URL(path, api.href + '/'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
assert.match(await call('wait_for_feedback', { deck_id: id, timeout_seconds: 5 }), /No feedback yet/)
const waiting = call('wait_for_feedback', { deck_id: id, timeout_seconds: 30 })
await new Promise((resolve) => setTimeout(resolve, 1500))
assert.equal((await fetch(api).then((r) => r.json())).listening, true)
const refused = await fetch(api, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"text":"x"}' })
assert.equal(refused.status, 400)
const item = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Shorten the title', slideId: 'bad-callout', step: 0, target: { kind: 'slide title', label: 'Bad callout' } }) }).then((r) => r.json())
assert.equal(item.status, 'draft')
assert.equal((await post('send', {})).sent, 1)
const plan = await waiting
assert.match(plan, new RegExp(`\\[${item.id}\\] Slide 1 "Bad callout"`))
assert.match(plan, /Pinned to slide title: Bad callout/)
assert.match(plan, /Current authoring JSON/)
ok('wait_for_feedback receives a change plan sent from the viewer API')

await call('reply_feedback', { deck_id: id, id: item.id, text: 'How short?' })
await post(item.id, { reply: 'Two words.' })
assert.match(await call('get_feedback', { deck_id: id }), /User replied: Two words\./)
assert.match(await call('resolve_feedback', { deck_id: id, items: [{ id: item.id, reply: 'Renamed to "Bad callout".' }] }), /Resolved 1/)
const after = await fetch(api).then((r) => r.json())
assert.equal(after.items[0].status, 'done')
assert.deepEqual(after.items[0].thread.map((m: { from: string }) => m.from), ['agent', 'user', 'agent'])
ok('reply_feedback, user replies, get_feedback, resolve_feedback')

const chatApi = new URL(`/api/decks/${id}/chat`, url)
assert.deepEqual(await fetch(chatApi).then((r) => r.json()), { messages: [], running: false })
assert.equal((await fetch(chatApi, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400)
assert.equal((await fetch(chatApi, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"text":"hi"}' })).status, 400)
ok('chat API guards (empty message, cross-origin)')

const prompts = await client.listPrompts()
assert.ok(prompts.prompts.some((p) => p.name === 'explain_changes'))
const resources = await client.listResources()
assert.ok(resources.resources.some((r) => r.uri === 'ferry://guide'))
ok('prompt and resource registered')

await client.close()
console.log(`\nAll checks passed (FERRY_HOME=${home})`)
