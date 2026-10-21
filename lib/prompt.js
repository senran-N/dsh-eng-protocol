/**
 * Share identical long strings inside a judge's evidence payload. Every byte,
 * record, source id and position is retained; this is not a history summary.
 * The dictionary precedes the records so references are defined before use.
 */
export function compactEvidence(evidence) {
  const counts = new Map()
  let reserved = false
  const count = value => {
    if (typeof value === 'string' && value.length >= 160) counts.set(value, (counts.get(value) ?? 0) + 1)
    else if (value && typeof value === 'object') {
      // An opaque error/value supplied by a tool may already use these keys.
      // Leave it literal rather than introducing ambiguous dictionary syntax.
      if (Object.hasOwn(value, '$text') || Object.hasOwn(value, '_texts')) reserved = true
      Object.values(value).forEach(count)
    }
  }
  count(evidence)
  const repeated = [...counts].filter(([, n]) => n > 1)
  if (reserved || repeated.length === 0) return evidence
  const ids = new Map(repeated.map(([text], i) => [text, `t${i + 1}`]))
  const replace = value => {
    if (typeof value === 'string') return ids.has(value) ? { $text: ids.get(value) } : value
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]))
    return value
  }
  return { _texts: Object.fromEntries([...ids].map(([text, id]) => [id, text])), ...replace(evidence) }
}
