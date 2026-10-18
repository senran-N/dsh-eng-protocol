import { createHash, randomUUID } from 'node:crypto'

/** Stable content hash used for skill-compile cache keys. */
export function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

/** Clip text to a hard maximum, marking the omitted tail. */
export function clip(value, max) {
  if (typeof value !== 'string') return ''
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Collapse whitespace and clip to one line for labels and summaries. */
export function oneLine(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** New opaque identity for a model-visible context message. */
export function messageId() {
  return randomUUID()
}

/** ISO timestamp used by decision records. */
export function nowIso() {
  return new Date().toISOString()
}

/** Parse a JSON object from model output that may be fenced or surrounded by prose. */
export function extractJson(text) {
  if (typeof text !== 'string') return undefined
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const candidates = [unfenced]
  const first = unfenced.indexOf('{')
  const last = unfenced.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(unfenced.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

/** Read a bounded, JSON-serializable value as a plain record. */
export function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** Read an array value, or an empty array. */
export function list(value) {
  return Array.isArray(value) ? value : []
}

/** Read a string field from a record. */
export function stringField(value, key, fallback = '') {
  const item = record(value)?.[key]
  return typeof item === 'string' ? item : fallback
}

/** Read a positive finite number, or the fallback. */
export function numberField(value, key, fallback) {
  const item = record(value)?.[key]
  return typeof item === 'number' && Number.isFinite(item) ? item : fallback
}

/** Keep model-authored card text from opening or closing the reminder envelope. */
export function guardEnvelope(value) {
  return String(value ?? '').replace(/<(\/?)(eng-protocol)/gi, '‹$1$2')
}

/** Error text for logs and decision records. */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Add to an insertion-ordered set, evicting the oldest entries beyond `max`. */
export function remember(set, value, max) {
  set.delete(value)
  set.add(value)
  while (set.size > max) set.delete(set.values().next().value)
}
