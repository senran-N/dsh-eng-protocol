/** Read local retained logs and zstd session frames without executing tools or calling models. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { isProtocolBlock } from '../lib/intervention.js'

const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const home = option('--home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const stateDir = option('--state-dir') ?? join(home, 'storages', 'eng-protocol')
const counts = values => Object.fromEntries([...values.reduce((out, value) => out.set(value, (out.get(value) ?? 0) + 1), new Map())]
  .sort((a, b) => b[1] - a[1]))
const list = async path => readdir(path, { recursive: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })

// Match the host's concatenated standard-frame container. Node may return an
// empty/partial buffer for an incomplete frame, so decompression alone cannot
// establish that all durable bytes were read.
function frameEnd(buffer, start) {
  let offset = start
  const take = bytes => {
    const at = offset
    offset += bytes
    if (offset > buffer.length) throw new Error(`incomplete zstd frame at byte ${start}`)
    return at
  }
  if (buffer.readUInt32LE(take(4)) !== 0xfd2fb528) throw new Error(`invalid zstd magic at byte ${start}`)
  const descriptor = buffer[take(1)]
  if (descriptor & 0x18) throw new Error(`reserved zstd header bit at byte ${start}`)
  const single = Boolean(descriptor & 0x20)
  const sizeFlag = descriptor >>> 6
  const dictionary = descriptor & 3
  take((single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (sizeFlag ? 1 << sizeFlag : single ? 1 : 0))
  for (;;) {
    const header = buffer.readUIntLE(take(3), 3)
    const type = (header >>> 1) & 3
    if (type === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`)
    take(type === 1 ? 1 : header >>> 3)
    if (header & 1) break
  }
  if (descriptor & 4) take(4)
  return offset
}
const summary = { capturedAt: new Date().toISOString(), logFiles: [], errors: [], sessions: { files: 0, events: 0, types: {},
  skillLoads: {}, failedSkillLoads: 0, protocolNotices: 0, typedProtocolBlocks: 0, legacyProtocolErrorText: 0,
  surfaceReplacements: 0, backgroundNotices: 0, jobOutputResults: 0 } }
const records = []
for (const file of ['decisions.jsonl.1', 'decisions.jsonl']) {
  let text
  try { text = await readFile(join(stateDir, file), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  let parsed = 0, invalid = 0
  for (const line of text.split('\n').filter(line => line.trim())) {
    try { records.push(JSON.parse(line)); parsed += 1 }
    catch { invalid += 1 }
  }
  summary.logFiles.push({ file, parsed, invalid })
}
const decisions = records.filter(row => row.kind === 'decision')
summary.decisions = {
  count: decisions.length, sessions: new Set(decisions.map(row => row.sessionId)).size,
  firstAt: decisions[0]?.ts, lastAt: decisions.at(-1)?.ts,
  blocked: decisions.filter(row => row.blocked === true).length,
  injected: decisions.filter(row => row.injected === true).length,
  withErrors: decisions.filter(row => row.error).length,
  deadlineExpired: decisions.filter(row => row.deadlineExpired).length,
  boundaries: counts(decisions.map(row => row.boundary)), triggers: counts(decisions.flatMap(row => row.triggers ?? [])),
  withCitations: decisions.filter(row => row.citationCoverage).length,
  withRequestSizes: decisions.filter(row => Number.isFinite(row.requestChars)).length,
}
const evidenceKeys = [...new Set(decisions.map(row => row.evidenceKey).filter(Boolean))]
summary.evidence = { referenced: evidenceKeys.length, readable: 0, missingOrInvalid: 0, withRelations: 0 }
for (const key of evidenceKeys) {
  if (!/^[a-f0-9]{64}$/.test(key)) { summary.evidence.missingOrInvalid += 1; continue }
  try {
    const snapshot = JSON.parse(await readFile(join(stateDir, 'evidence', `${key}.json`), 'utf8'))
    summary.evidence.readable += 1
    if (Array.isArray(snapshot.relations)) summary.evidence.withRelations += 1
  } catch { summary.evidence.missingOrInvalid += 1 }
}

const textOf = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text').map(block => block.text).join('\n')
const types = [], loaded = []
for (const file of (await list(join(home, 'sessions'))).filter(file => /session\.v\d+\.jsonl\.zstd$/.test(file))) {
  const buffer = await readFile(join(home, 'sessions', file))
  const calls = new Map()
  let offset = 0
  summary.sessions.files += 1
  try {
    // The first frame is only the header. Decode each complete event frame.
    while (offset < buffer.length) {
      const end = frameEnd(buffer, offset)
      const decoded = zstdDecompressSync(buffer.subarray(offset, end))
      offset = end
      for (const line of decoded.toString('utf8').split('\n').filter(line => line.trim())) {
        const event = JSON.parse(line)
        if (event.type === 'session') continue
        summary.sessions.events += 1
        types.push(event.type)
        if (event.surfaceOp?.op === 'replace') { summary.sessions.surfaceReplacements += 1; continue }
        const data = event.data ?? {}
        if (event.type === 'tool/call') calls.set(data.callId, data)
        if (event.type === 'user/message') {
          if (data.source?.kind === 'eng-protocol') summary.sessions.protocolNotices += 1
          if (data.source?.kind === 'tool-jobs') summary.sessions.backgroundNotices += 1
        }
        if (event.type !== 'tool/result') continue
        const message = data.message ?? {}
        const callId = message.source?.callId ?? message.toolCallId ?? data.callId
        const call = calls.get(callId)
        calls.delete(callId)
        if (isProtocolBlock(data)) summary.sessions.typedProtocolBlocks += 1
        else if (message.isError && /^Error:\s*<eng-protocol\b/.test(textOf(message.content))) summary.sessions.legacyProtocolErrorText += 1
        if (call?.name === 'job_output') summary.sessions.jobOutputResults += 1
        if (call?.name !== 'skill') continue
        if (message.isError || data.error) summary.sessions.failedSkillLoads += 1
        else {
          const input = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
          if (typeof input?.name === 'string') loaded.push(input.name)
        }
      }
    }
  } catch (error) {
    // A session may still be appending. Report the incomplete frame, not a
    // claim that the whole session was scanned.
    summary.errors.push({ file, offset, error: error.message })
  }
}
summary.sessions.types = counts(types)
summary.sessions.skillLoads = counts(loaded)
summary.sessions.successfulSkillLoads = loaded.length
const output = `${JSON.stringify(summary, null, 2)}\n`
if (option('--out')) await writeFile(option('--out'), output, 'utf8')
process.stdout.write(output)
if (summary.errors.length || summary.logFiles.some(file => file.invalid)) process.exitCode = 1
