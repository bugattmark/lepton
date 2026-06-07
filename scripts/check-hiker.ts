// Quick diagnostic: does Tier 0 (HikerAPI enrich + media + engagement rate) work, isolated from OpenAI?
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DB_PATH = join(tmpdir(), `lepton-hikcheck-${process.pid}.db`)
await import('../src/db.ts')
const { enrichHandle, hikerAvailable } = await import('../src/sourcing.ts')

console.log('hikerAvailable:', hikerAvailable())
for (const h of ['graceelilyy_', 'ambertutton']) {
  try {
    const e = await enrichHandle(h, { withMedia: true })
    if (!e) { console.log(`@${h}: no profile`); continue }
    console.log(`@${h}: followers=${(e as any).followers} category=${(e as any).category ?? '-'} media=${(e as any).media?.length ?? 0} captions=${(e as any).recentCaptions?.length ?? 0} ER=${(e as any).engagementRate ?? '-'}`)
  } catch (err) {
    console.log(`@${h}: threw ${(err as Error).message}`)
  }
}
