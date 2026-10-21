import { oneLine } from './text.js'

export const ORDERING = new Set(['requires', 'blocks'])
export const edgeKey = edge => `${edge.type}:${edge.source}:${edge.target}`

/** Keep adjacent definitions when a connected component is split into batches. */
export function graphContext(graph, candidates) {
  const ids = new Set(candidates.map(card => card.id))
  const edges = (graph?.relations ?? []).filter(edge => edge.type === 'contains'
    ? ids.has(edge.target) : ids.has(edge.source) || ids.has(edge.target))
  const adjacent = new Set(edges.flatMap(edge => [edge.source, edge.target]))
  return { edges, neighbors: (graph?.cards ?? []).filter(card => adjacent.has(card.id) && !ids.has(card.id)) }
}

/** A relation cannot suppress or fuse advice merely because the model named it. */
export function normalizeEdgeDecisions(raw, edges, references) {
  const allowed = new Map(edges.map(edge => [edgeKey(edge), edge]))
  const out = {}
  for (const value of Array.isArray(raw) ? raw : []) {
    const edge = allowed.get(value?.id)
    if (!edge || !['arbitrates', 'fuses'].includes(edge.type)) continue
    const evidence = Array.isArray(value.evidence) ? value.evidence : []
    const valid = ['applies', 'inapplicable', 'unknown'].includes(value.state)
      && typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
      && (value.state !== 'applies' || evidence.length > 0)
      && evidence.every(item => typeof item?.ref === 'string' && typeof item.quote === 'string'
        && item.quote.trim() && references.get(item.ref)?.text.includes(item.quote))
    out[value.id] = { ...edge, state: valid ? value.state : 'unknown', confidence: valid ? value.confidence : 0,
      reason: valid ? oneLine(value.reason, 400) : '关系判断缺少有效证据，未用于合并或裁决',
      action: valid && typeof value.action === 'string' ? oneLine(value.action, 500) : undefined,
      evidence: valid ? evidence.map(({ ref, quote }) => ({ ref, quote })) : [] }
  }
  return out
}

export function edgeApplies(edge, decisions, threshold) {
  const verdict = decisions?.[edgeKey(edge)]
  return verdict?.state === 'applies' && verdict.confidence >= threshold && verdict.evidence?.length > 0
}

/** Missing prerequisite evidence is not grounds for a workflow tool denial. */
export function prerequisitesClear(card, edges, assessments, threshold, seen = new Set()) {
  if (card.critical) return true
  if (seen.has(card.id)) return false
  seen.add(card.id)
  return (edges ?? []).filter(edge => ORDERING.has(edge.type) && edge.target === card.id).every(edge => {
    const prior = assessments[edge.source]
    return prior?.confidence >= threshold && (prior.state === 'satisfied' || edge.type === 'blocks' && prior.state === 'inapplicable')
      && prerequisitesClear({ id: edge.source }, edges, assessments, threshold, new Set(seen))
  })
}

/** Follow prerequisites before their dependents, preserving independent priority. */
export function orderByDependencies(items, edges, id = item => item.id) {
  const byId = new Map(items.map(item => [id(item), item]))
  const incoming = new Map()
  for (const edge of edges ?? []) if (ORDERING.has(edge.type) && byId.has(edge.source) && byId.has(edge.target)) {
    if (!incoming.has(edge.target)) incoming.set(edge.target, [])
    incoming.get(edge.target).push(edge.source)
  }
  const seen = new Set(), ordered = []
  const visit = item => {
    if (seen.has(id(item))) return
    seen.add(id(item))
    for (const source of incoming.get(id(item)) ?? []) visit(byId.get(source))
    ordered.push(item)
  }
  items.forEach(visit)
  return ordered
}

/** Fuse only a validated shared action, retaining every member's source text. */
export function guidanceGroups(cards, edges, decisions, threshold) {
  const byId = new Map(cards.map(card => [card.id, card]))
  const groups = cards.map(card => ({ cards: [card], action: undefined }))
  for (const edge of edges ?? []) {
    const verdict = decisions?.[edgeKey(edge)]
    if (edge.type !== 'fuses' || !edgeApplies(edge, decisions, threshold) || !verdict.action
      || !byId.has(edge.source) || !byId.has(edge.target)) continue
    const left = groups.find(group => group.cards.some(card => card.id === edge.source))
    const right = groups.find(group => group.cards.some(card => card.id === edge.target))
    if (left === right || (left.action && left.action !== verdict.action) || (right.action && right.action !== verdict.action)) continue
    // An ordering edge describes separate stages, not one interchangeable action.
    const ids = new Set([...left.cards, ...right.cards].map(card => card.id))
    if (edges.some(other => ORDERING.has(other.type) && ids.has(other.source) && ids.has(other.target))) continue
    left.cards.push(...right.cards)
    left.action = verdict.action
    groups.splice(groups.indexOf(right), 1)
  }
  return groups
}
