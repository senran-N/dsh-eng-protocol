import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hash, messageId, nowIso } from './text.js'

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
 * project, agent and session. What is stored is the model's answer for one
 * part of a skill, keyed by the extraction contract and that part's text alone,
 * so a skill moved, renamed, re-described or compiled from another project
 * reuses it, and an edit recompiles only the parts whose text changed. Cards
 * are rebuilt from these answers when a skill is used, so improving how answers
 * become cards never costs a model call. A file is written once by whoever
 * compiled it (atomic rename): concurrent writers can neither lose nor delete
 * each other's results.
 *
 *   skills/v2/parts/<partKey>.json      the model's answer for one part
 *   skills/v2/skills/<skillKey>.json    a complete compile: the skill text it was made from
 *   skills/v2/latest/<identity>.json    the newest complete compile of one skill (by name and path)
 *   skills/v2/prepared/<key>.json       a manual preparation request, keyed by project and skill identity
 */
const SKILLS_DIR = join('skills', 'v2')
const KEY = /^[a-f0-9]{16,128}$/

function partPath(config, key) {
  return join(config.stateDir, SKILLS_DIR, 'parts', `${key}.json`)
}

function skillPath(config, key) {
  return join(config.stateDir, SKILLS_DIR, 'skills', `${key}.json`)
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

/** The model's stored answer for one part (`{ obligations, relations }`); missing or unreadable means not compiled. */
export async function loadPart(config, key) {
  if (!KEY.test(String(key))) return undefined
  const value = await readJson(partPath(config, key))
  return value?.format === FORMAT && Array.isArray(value.obligations) && Array.isArray(value.relations) ? value : undefined
}

export async function savePart(config, key, value) {
  if (!KEY.test(String(key))) throw new Error('无效的分段键')
  await writeJsonAtomic(partPath(config, key), value)
}

/** A complete compile's record: the skill text it was made from (its parts are stored separately). */
export async function loadSkillRecord(config, key) {
  if (!KEY.test(String(key))) return undefined
  const value = await readJson(skillPath(config, key))
  return value?.format === FORMAT && typeof value.content === 'string' ? value : undefined
}

export async function saveSkillRecord(config, key, value) {
  if (!KEY.test(String(key))) throw new Error('无效的编译键')
  await writeJsonAtomic(skillPath(config, key), value)
}

/** The key of the newest complete compile of one skill, for guarding while a changed skill recompiles. */
export async function loadLatest(config, identity) {
  if (!KEY.test(String(identity))) return undefined
  const value = await readJson(latestPath(config, identity))
  return typeof value?.skillKey === 'string' ? value.skillKey : undefined
}

export async function saveLatest(config, identity, skillKey) {
  if (!KEY.test(String(identity)) || !KEY.test(String(skillKey))) return
  await writeJsonAtomic(latestPath(config, identity), { skillKey })
}

/** Whether this project's skill was manually requested, including unfinished work. */
export async function loadPreparation(config, cwd, identity) {
  const value = await readJson(join(config.stateDir, SKILLS_DIR, 'prepared', `${hash([cwd, identity])}.json`))
  return value?.format === FORMAT && value.cwd === cwd && value.identity === identity
}

/** Save a preparation request before work starts, independently of its compile result. */
export async function savePreparation(config, cwd, identity) {
  await writeJsonAtomic(join(config.stateDir, SKILLS_DIR, 'prepared', `${hash([cwd, identity])}.json`), { cwd, identity })
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
export async function appendDecision(config, record, { evidence } = {}) {
  const path = join(config.stateDir, 'decisions.jsonl')
  const stored = { ...record, ts: record.ts ?? nowIso() }
  const snapshot = evidence ? { sessionId: record.sessionId, cwd: record.cwd, ...evidence } : undefined
  if (snapshot) stored.evidenceKey = hash(snapshot)
  return enqueueWrite(path, async () => {
    await ensureStateDir(config)
    if (snapshot) {
      try {
        const evidencePath = join(config.stateDir, 'evidence', `${stored.evidenceKey}.json`)
        if (!(await readJson(evidencePath))) await writeJsonAtomic(evidencePath, snapshot)
      } catch (error) {
        stored.evidenceError = String(error?.message ?? error)
        delete stored.evidenceKey
      }
    }
    let rotated = false
    try {
      const info = await stat(path)
      if (info.size > MAX_LOG_BYTES) { await rename(path, `${path}.1`); rotated = true }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      // No existing log yet.
    }
    const line = JSON.stringify(stored)
    await appendFile(path, `${line}\n`, { encoding: 'utf8' })
    if (rotated) await pruneEvidence(config, path).catch(() => {})
  })
}

/** Rotation keeps only snapshots referenced by the two retained logs. */
async function pruneEvidence(config, path) {
  const referenced = new Set()
  for (const file of [path, `${path}.1`]) await readLinesBackwards(file, (line) => {
    try { const key = JSON.parse(line).evidenceKey; if (key) referenced.add(key) } catch {}
  })
  const dir = join(config.stateDir, 'evidence')
  for (const name of await readdir(dir).catch(() => [])) {
    if (/^[a-f0-9]{64}\.json$/.test(name) && !referenced.has(name.slice(0, -5))) await unlink(join(dir, name))
  }
}

/** Full evidence is stored once by content; previews in the log are only labels. */
export async function loadEvidence(config, key) {
  if (!/^[a-f0-9]{64}$/.test(String(key))) return undefined
  return readJson(join(config.stateDir, 'evidence', `${key}.json`))
}

/**
 * Read recent decision records for one project, newest last. The log is read
 * from its end, continuing into the rotated `.1` file when the current one has
 * too few records, and the parsed window is reused until either file changes.
 * `sessionId` filters before `limit`, so one busy session cannot crowd another
 * out of the window.
 */
export async function readDecisions(config, { cwd, sessionId, limit = 1200, decisionsOnlyLimit = false } = {}) {
  const files = [join(config.stateDir, 'decisions.jsonl'), join(config.stateDir, 'decisions.jsonl.1')]
  const stamp = (await Promise.all(files.map((file) => stat(file).then((info) => `${info.size}:${info.mtimeMs}`, () => '-')))).join('|')
  const key = `${config.stateDir}\u0000${cwd ?? ''}\u0000${sessionId ?? ''}\u0000${limit}\u0000${decisionsOnlyLimit}`
  const cached = readCache.get(key)
  if (cached?.stamp === stamp) return cached.records.slice()
  const matches = (value) => (!cwd || value.cwd === cwd) && (!sessionId || value.sessionId === sessionId)
  const records = []
  let counted = 0
  for (const file of files) {
    const exhausted = await readLinesBackwards(file, (line) => {
      try {
        const value = JSON.parse(line)
        if (matches(value)) {
          records.push(value)
          if (!decisionsOnlyLimit || value.kind === 'decision') counted += 1
        }
      } catch {
        // A torn line from a concurrent append.
      }
      return counted < limit
    })
    if (!exhausted) break
  }
  records.reverse()
  readCache.set(key, { stamp, records })
  if (readCache.size > 32) readCache.delete(readCache.keys().next().value)
  return records.slice()
}

const followUp = () => ({
  live: { resolved: 0, persisting: 0, addressing: 0, inapplicable: 0 },
  shadow: { resolved: 0, persisting: 0, addressing: 0, inapplicable: 0 },
  // Attribution outcomes that must never inflate a success-rate denominator.
  pending: 0, unknown: 0, expired: 0, legacy: 0, unattributed: 0,
})

const mean = (values) => values.length > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0

/**
 * Aggregate the dashboard's headline numbers and per-card counts.
 *
 * Follow-up is an observational signal: after a card is delivered (live) or selected but
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
    if (['resolved', 'persisting', 'addressing', 'inapplicable'].includes(outcome)) {
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
      if (item.turn !== entry.turn) { flush(key, entry, 'expired'); continue }
      // A later timestamp alone proves neither that the model saw a reminder
      // nor that it acted. Both causal watermarks must advance.
      const evidenceAdvanced = item.evidenceSeq > entry.deliveryEvidenceSeq
      const responseAdvanced = item.responseSeq > entry.deliveryResponseSeq
      const predatesDelivery = typeof item.judgedAt === 'string' && typeof entry.deliveredAt === 'string'
        && item.judgedAt < entry.deliveredAt
      if (!evidenceAdvanced || !responseAdvanced || predatesDelivery) continue
      const confidence = assessment.confidence
      if (!Number.isFinite(confidence) || confidence < entry.minConfidence || confidence > 1
        || !['needed', 'satisfied', 'addressing', 'inapplicable'].includes(assessment.state)) {
        entry.lastOutcome = 'unknown'
        continue
      }
      if (assessment.state === 'addressing') {
        entry.lastOutcome = 'addressing'
        continue
      }
      flush(key, entry, assessment.state === 'needed' ? 'persisting'
        : assessment.state === 'satisfied' ? 'resolved' : 'inapplicable')
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
          minConfidence: Number.isFinite(item.minConfidence) && item.minConfidence >= 0 && item.minConfidence <= 1
            ? item.minConfidence : 0.6,
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
    flush(key, entry, entry.lastOutcome ?? 'pending')
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
