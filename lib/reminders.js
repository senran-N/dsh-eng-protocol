import { hash } from './text.js'
import { orderByDependencies } from './topology.js'

const normalized = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

// Identical obligations may be compiled under different ids. Keep different
// file/command scopes and exceptions separate, even when their wording matches.
export function reminderKey(card) {
  return hash([card.entry ? ['skill', card.skill] : card.quote
    ? normalized(card.quote) : (card.rules?.length ? card.rules.map(normalized) : card.id),
  card.match ?? null, normalized(card.notApplicable)])
}

function evidenceKey(card, assessment) {
  // A new call id or a reworded judge explanation is not new evidence.
  return hash([reminderKey(card), [...new Set((assessment?.evidence ?? [])
    .filter(item => item.ref !== 'action:proposed' && item.ref !== 'assistant:latest')
    .map(item => normalized(item.quote)))].sort()])
}

export function createReminderState() {
  return { step: undefined, count: 0, history: new Map() }
}

export function compareReminders(left, right) {
  return Number(right.card.critical === true) - Number(left.card.critical === true)
    || (right.card.priority ?? 1) - (left.card.priority ?? 1)
    || (right.assessment?.confidence ?? 0) - (left.assessment?.confidence ?? 0)
}

/** Delivery filtering also runs for cached/deferred verdicts and parallel tools. */
export function reminderSuppression(card, assessment, state, step, config) {
  if (card.critical) return undefined
  if (state.history.get(reminderKey(card))?.has(evidenceKey(card, assessment))) return 'repeat'
  if (config.maxRemindersPerStep != null && (state.step === step ? state.count : 0) >= config.maxRemindersPerStep) return 'limit'
  return undefined
}

/** Only successful deliveries consume the step budget or remember evidence. */
export function rememberReminders(cards, assessments, state, step) {
  if (state.step !== step) { state.step = step; state.count = 0 }
  for (const card of cards) {
    if (card.critical) continue
    const key = reminderKey(card)
    if (!state.history.has(key)) state.history.set(key, new Set())
    state.history.get(key).add(evidenceKey(card, assessments[card.id]))
    state.count += 1
  }
}

export function resolveReminders(cards, assessments, state, minConfidence) {
  for (const card of cards) {
    const assessment = assessments[card.id]
    // An unrelated intermediate action may be inapplicable; it must not
    // re-arm the same warning when the agent returns to its original work.
    if (assessment?.state === 'satisfied' && assessment.confidence >= minConfidence) {
      state.history.delete(reminderKey(card))
    }
  }
}

export function selectReminders(items, state, step, config, relations = []) {
  const preview = { ...state, history: new Map([...state.history].map(([key, values]) => [key, new Set(values)])) }
  const selected = [], suppressed = [], seen = new Set()
  const ranked = [...items].sort(compareReminders)
  const ordered = orderByDependencies(ranked, relations, item => item.card.id)
  // Duplicate ids from deferred/current judgments still need a recorded reason.
  for (const item of [...ordered, ...ranked.filter(item => !ordered.includes(item))]) {
    const key = reminderKey(item.card)
    const reason = seen.has(key) ? 'repeat' : reminderSuppression(item.card, item.assessment, preview, step, config)
    if (reason) { suppressed.push({ ...item, reason }); continue }
    selected.push(item)
    seen.add(key)
    rememberReminders([item.card], { [item.card.id]: item.assessment }, preview, step)
  }
  return { selected, suppressed }
}
