// Builds a showcase deck the way an agent would: through the MCP tools.
// Run `npm run serve` first to keep the viewer alive after this exits.
import { connect } from './client.ts'
import { createSampleRepo } from './sample-repo.ts'
import { deck, slides } from './showcase.ts'

const repo = createSampleRepo()
const git = { repo, base: 'main', head: 'fix/bind-retry' }
const { client, call } = await connect()

const created = await call('create_deck', deck)
const id = created.match(/id: ([a-z0-9-]+)/)![1]

const result = await call('add_slides', { deck_id: id, slides: slides(git) })

console.log(result)
const opened = await call('open_deck', { deck_id: id, launch: false })
console.log(opened)
await client.close()
