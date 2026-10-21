/** Resolve the judge wire format for fake-host assertions, never for citations. */
export function expandEvidence(value) {
  const { _texts, ...records } = value
  if (!_texts) return value
  const resolve = item => {
    if (Array.isArray(item)) return item.map(resolve)
    if (item && typeof item === 'object') {
      if (Object.keys(item).length === 1 && typeof item.$text === 'string' && Object.hasOwn(_texts, item.$text)) return _texts[item.$text]
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, resolve(v)]))
    }
    return item
  }
  return resolve(records)
}

export const evidenceOfPrompt = prompt => expandEvidence(JSON.parse(prompt.split('CURRENT EVIDENCE:\n')[1].split('\n\nCANDIDATE CARDS:')[0]))
