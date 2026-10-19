import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { messageId, nowIso } from './text.js'

const FORMAT = 1
const MAX_LOG_BYTES = 8 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
// Parsed windows keyed by project and limit, valid while both log files keep their size and mtime.
const readCache = new Map()
// One queue per resolved log path: append+rotation runs serially, so two
// concurrent appends can no longer interleave stat→rename windows and delete a
// freshly rotated backup. Cross-process writers are out of scope for now.
const writeQueues = new Map()

/** What one decision did: `blocked`, `injected`, `shadow` (would have acted), `failed`, or `quiet`. */
export function decisionOutcome(record) {
  if (record?.blocked) return 'blocked'
  if (record?.injected) return 'injected'
  if (record?.shadow && (record.wouldInject || record.wouldBlock)) return 'shadow'
  if (record?.error) return 'failed'
  return 'quiet'
}

/** Visit a file's lines from the last one backwards; `visit` returns false to stop. Returns false when stopped. */
async function readLinesBackwards(path, visit) {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return true
  }
  try {
    let position = (await handle.stat()).size
    let rest = Buffer.alloc(0)
    while (position > 0) {
      const length = Math.min(CHUNK_BYTES, position)
      position -= length
      const chunk = Buffer.alloc(length)
      await handle.read(chunk, 0, length, position)
      // Work in bytes so a multi-byte character split across chunks stays whole.
      const buffer = rest.length > 0 ? Buffer.concat([chunk, rest]) : chunk
      let end = buffer.length
      while (end > 0) {
        const newline = buffer.lastIndexOf(10, end - 1)
        if (newline < 0) break
        const line = buffer.subarray(newline + 1, end).toString('utf8').trim()
        end = newline
        if (line && visit(line) === false) return false
      }
      rest = buffer.subarray(0, end)
    }
    const first = rest.toString('utf8').trim()
    return !(first && visit(first) === false)
  } finally {
    await handle.close()
  }
}

/** Ensure the plugin-owned state directory exists. */
export async function ensureStateDir(config) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
}

/*
 * Compiled skills are stored by content, one file per entry, shared by every
 * project, agent and session: the compile key already names the route, the
 * compiler options and the exact skill source. A file is written once by
 * whoever compiled it (atomic rename), so concurrent writers can neither lose
 * each other's results nor delete them, and a user-level skill compiled in one
 * project is reused in every other one.
 *
 *   skills/<compileKey>.json      a compiled skill graph
 *   skills/parts/<partKey>.json   one compiled part of a long skill (resume point)
 *   skills/latest/<identity>.json the newest good compile of one skill (by name and path)
 */
const SKILLS_DIR = 'skills'
const KEY = /^[a-f0-9]{16,128}$/

export function compiledPath(config, key) {
  return join(config.stateDir, SKILLS_DIR, `${key}.json`)
}

function partPath(config, key) {
  return join(config.stateDir, SKILLS_DIR, 'parts', `${key}.json`)
}

function latestPath(config, identity) {
  return join(config.stateDir, SKILLS_DIR, 'latest', `${identity}.json`)
}

async function readJson(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Write one JSON file through a temporary sibling and a rename, so readers never see half a file. */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${messageId()}.tmp`
  await writeFile(temp, JSON.stringify({ format: FORMAT, ...value, savedAt: nowIso() }), { encoding: 'utf8' })
  await rename(temp, path)
}

/** A compiled skill graph by compile key; missing or unreadable means not compiled. */
export async function loadCompiled(config, key) {
  if (!KEY.test(String(key))) return undefined
  const value = await readJson(compiledPath(config, key))
  return value?.format === FORMAT && value.compileKey === key ? value : undefined
}

export async function saveCompiled(config, key, graph) {
  if (!KEY.test(String(key))) throw new Error('无效的编译键')
  await writeJsonAtomic(compiledPath(config, key), { ...graph, compileKey: key })
}

/** One compiled part (`{ raw }`) or the note that it had to be split (`{ split: true }`). */
export async function loadPart(config, key) {
  if (!KEY.test(String(key))) return undefined
  const value = await readJson(partPath(config, key))
  return value?.format === FORMAT ? value : undefined
}

export async function savePart(config, key, value) {
  if (!KEY.test(String(key))) throw new Error('无效的分段键')
  await writeJsonAtomic(partPath(config, key), value)
}

/** The compile key of the newest good compile of one skill, for guarding while a changed skill recompiles. */
export async function loadLatest(config, identity) {
  if (!KEY.test(String(identity))) return undefined
  const value = await readJson(latestPath(config, identity))
  return typeof value?.compileKey === 'string' ? value.compileKey : undefined
}

export async function saveLatest(config, identity, compileKey) {
  if (!KEY.test(String(identity)) || !KEY.test(String(compileKey))) return
  await writeJsonAtomic(latestPath(config, identity), { compileKey })
}

/** Serialize append+rotation per log file. The tail never rejects the caller. */
function enqueueWrite(path, task) {
  const key = path.toLowerCase()
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  writeQueues.set(key, next.then(() => undefined, () => undefined))
  return next
}

/**
 * Append one decision record, rotating an oversized log first. Rotation uses
 * rename-over instead of rm-then-rename, so a concurrent reader can see a
 * missing backup for one instant but never loses the archived history.
 */
export async function appendDecision(config, record) {
  const path = join(config.stateDir, 'decisions.jsonl')
  return enqueueWrite(path, async () => {
    await ensureStateDir(config)
    try {
      const info = await stat(path)
      if (info.size > MAX_LOG_BYTES) await rename(path, `${path}.1`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      // No existing log yet.
    }
    const line = JSON.stringify({ ...record, ts: record.ts ?? nowIso() })
    await appendFile(path, `${line}\n`, { encoding: 'utf8' })
  })
}

/**
 * Read recent decision records for one project, newest last. The log is read
 * from its end, continuing into the rotated `.1` file when the current one has
 * too few records, and the parsed window is reused until either file changes.
 * `sessionId` filters before `limit`, so one busy session cannot crowd another
 * out of the window.
 */
export async function readDecisions(config, { cwd, sessionId, limit = 1200 } = {}) {
  const files = [join(config.stateDir, 'decisions.jsonl'), join(config.stateDir, 'decisions.jsonl.1')]
  const stamp = (await Promise.all(files.map((file) => stat(file).then((info) => `${info.size}:${info.mtimeMs}`, () => '-')))).join('|')
  const key = `${config.stateDir}\u0000${cwd ?? ''}\u0000${sessionId ?? ''}\u0000${limit}`
  const cached = readCache.get(key)
  if (cached?.stamp === stamp) return cached.records.slice()
  const matches = (value) => (!cwd || value.cwd === cwd) && (!sessionId || value.sessionId === sessionId)
  const records = []
  for (const file of files) {
    const exhausted = await readLinesBackwards(file, (line) => {
      try {
        const value = JSON.parse(line)
        if (matches(value)) records.push(value)
      } catch {
        // A torn line from a concurrent append.
      }
      return records.length < limit
    })
    if (!exhausted) break
  }
  records.reverse()
  readCache.set(key, { stamp, records })
  if (readCache.size > 32) readCache.delete(readCache.keys().next().value)
  return records.slice()
}

const followUp = () => ({
  live: { resolved: 0, persisting: 0 },
  shadow: { resolved: 0, persisting: 0 },
  // Attribution outcomes that must never inflate a success-rate denominator.
  pending: 0, unknown: 0, expired: 0, legacy: 0, unattributed: 0,
})

const mean = (values) => values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0

/**
 * Aggregate the dashboard's headline numbers and per-card counts.
 *
 * Follow-up is the A/B signal: after a card is delivered (live) or selected but
 * withheld (shadow), a later judgment counts as `resolved` or `persisting`
 * only when its evidence and response sequences are both strictly greater than
 * the delivery's watermarks — the model must have seen the reminder and acted
 * afterwards. Judgments that predate delivery fall into `pending`, `unknown`,
 * `expired`, `legacy` (records without attribution metadata) or `unattributed`
 * (inconsistent metadata), never into the success-rate denominator. Outcomes
 * are bucketed once per (card, delivery); a newer delivery supersedes the old.
 */
export function aggregate(decisions) {
  const totals = {
    decisions: 0,
    injected: 0,
    blocked: 0,
    failed: 0,
    shadow: 0,
    wouldInject: 0,
    latencyMs: 0,
    lastAt: undefined,
    byBoundary: {},
    byTrigger: {},
    cacheHits: 0,
    deadlineExpired: 0,
    queueMs: [],
    blockingMs: [],
    cards: {},
    followUp: followUp(),
  }
  const cardStats = (id) => (totals.cards[id] ??= {
    selected: 0, injected: 0, blocked: 0, lastAt: undefined, followUp: followUp(),
  })
  // Open deliveries keyed by session+card; each carries its causal watermarks.
  const open = new Map()
  const flush = (key, entry, outcome) => {
    open.delete(key)
    const cardId = key.split('\u0000')[1]
    if (['resolved', 'persisting'].includes(outcome)) {
      totals.followUp[entry.mode][outcome] += 1
      cardStats(cardId).followUp[entry.mode][outcome] += 1
    } else {
      totals.followUp[outcome] += 1
      cardStats(cardId).followUp[outcome] += 1
    }
  }
  for (const item of decisions) {
    if (!item || item.kind !== 'decision') continue
    totals.decisions += 1
    totals.latencyMs += Number(item.latencyMs) || 0
    totals.lastAt = item.ts ?? totals.lastAt
    if (item.injected) totals.injected += 1
    if (item.blocked) totals.blocked += 1
    if (item.error) totals.failed += 1
    if (item.shadow) totals.shadow += 1
    if (item.shadow && item.wouldInject) totals.wouldInject += 1
    if (item.cacheHit) totals.cacheHits += 1
    if (item.deadlineExpired) totals.deadlineExpired += 1
    if (Number.isFinite(item.queueMs) && item.queueMs >= 0) totals.queueMs.push(item.queueMs)
    if (Number.isFinite(item.blockingMs) && item.blockingMs >= 0) totals.blockingMs.push(item.blockingMs)
    totals.byBoundary[item.boundary] = (totals.byBoundary[item.boundary] ?? 0) + 1
    for (const trigger of item.triggers ?? []) totals.byTrigger[trigger] = (totals.byTrigger[trigger] ?? 0) + 1
    const session = String(item.sessionId ?? '')
    const validWatermark = (value) => Number.isInteger(value) && value >= 0
    const attributionOk = validWatermark(item.evidenceSeq) && validWatermark(item.responseSeq)
      && Number.isInteger(item.turn)

    // 1. Try to settle open deliveries with this record's assessments.
    for (const [id, assessment] of Object.entries(item.assessments ?? {})) {
      const key = `${session}\u0000${id}`
      const entry = open.get(key)
      if (!entry || !assessment) continue
      if (!attributionOk || !validWatermark(entry.deliveryEvidenceSeq) || !validWatermark(entry.deliveryResponseSeq)
        || !Number.isInteger(entry.turn)) { flush(key, entry, 'legacy'); continue }
      // A judgment qualifies when new evidence arrived, or when it was made
      // strictly after the delivery was recorded — the original defect was
      // counting judgments that predate the delivery they allegedly answer.
      const evidenceAdvanced = item.evidenceSeq > entry.deliveryEvidenceSeq
      const judgedAfter = typeof item.judgedAt === 'string' && typeof entry.deliveredAt === 'string'
        && item.judgedAt >= entry.deliveredAt
      if (!evidenceAdvanced && !judgedAfter) {
        if (Number.isInteger(item.turn) && item.turn > entry.turn) flush(key, entry, 'expired')
        continue
      }
      if (Number.isInteger(item.turn) && item.turn < entry.turn) { flush(key, entry, 'expired'); continue }
      const outcome = assessment.state === 'unknown' ? 'unknown'
        : assessment.state === 'needed' ? 'persisting' : 'resolved'
      flush(key, entry, outcome)
    }

    // 2. Register this record's own deliveries for future settlement.
    const delivered = item.shadow ? (item.wouldInject || item.wouldBlock) : item.injected || item.blocked
    const deliveryEvent = ['delivered', 'blocked'].includes(item.delivery) || (item.shadow && delivered)
    if (delivered && deliveryEvent) {
      const ids = item.shadow ? (item.selected ?? []) : (item.deliveredCards ?? item.selected ?? [])
      for (const id of ids) {
        const key = `${session}\u0000${id}`
        const prior = open.get(key)
        if (prior) flush(key, prior, 'expired')
        open.set(key, {
          turn: item.turn,
          deliveryEvidenceSeq: item.deliveryEvidenceSeq,
          deliveryResponseSeq: item.deliveryResponseSeq,
          deliveredAt: item.deliveredAt,
          mode: item.shadow ? 'shadow' : 'live',
        })
      }
    }

    for (const id of item.selected ?? []) {
      const card = cardStats(id)
      card.selected += 1
      const wasDelivered = !item.deliveredCards || item.deliveredCards.includes(id)
      if (item.injected && wasDelivered) card.injected += 1
      if (item.blocked && wasDelivered) card.blocked += 1
      card.lastAt = item.ts ?? card.lastAt
    }
    for (const id of item.candidates ?? []) cardStats(id)
  }
  // Deliveries that never met a qualifying later judgment stay pending.
  for (const [key, entry] of open) {
    flush(key, entry, 'pending')
  }
  totals.avgLatencyMs = totals.decisions > 0 ? Math.round(totals.latencyMs / totals.decisions) : 0
  totals.avgQueueMs = mean(totals.queueMs)
  totals.avgBlockingMs = mean(totals.blockingMs)
  totals.queueSamples = totals.queueMs.length
  totals.blockingSamples = totals.blockingMs.length
  delete totals.queueMs
  delete totals.blockingMs
  return totals
}
