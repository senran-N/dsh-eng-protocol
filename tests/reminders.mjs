import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createReminderState, rememberReminders, resolveReminders, selectReminders } from '../lib/reminders.js'
import { normalizeConfig } from '../lib/config.js'
import { selectAssessments } from '../lib/decide.js'
import { enforceable, renderGuidance } from '../lib/cards.js'
import { aggregate } from '../lib/store.js'

const config = normalizeConfig({ maxRemindersPerStep: 3 })
const item = (id, extra = {}, evidence = []) => ({ card: { id, priority: 2, rules: [id], ...extra }, assessment: { state: 'needed', confidence: 0.9, evidence } })
const deliver = (items, state, step, options = config) => {
  const result = selectReminders(items, state, step, options)
  rememberReminders(result.selected.map(item => item.card), Object.fromEntries(items.map(item => [item.card.id, item.assessment])), state, step)
  return result
}

test('all ordinary deliveries in a step share three slots; critical cards still arrive', () => {
  const state = createReminderState()
  const first = deliver([item('low', { priority: 1 }), item('high', { priority: 3 })], state, 1)
  assert.deepEqual(first.selected.map(item => item.card.id), ['high', 'low'])
  const second = deliver([item('third'), item('fourth'), item('halt', { critical: true })], state, 1)
  assert.deepEqual(second.selected.map(item => item.card.id), ['halt', 'third'])
  assert.deepEqual(second.suppressed.map(item => item.reason), ['limit'])
  assert.equal(deliver([item('fourth')], state, 2).selected.length, 1, 'limited items are not falsely recorded as delivered')
  assert.equal(deliver([item('halt', { critical: true })], state, 2, { maxRemindersPerStep: 0 }).selected.length, 1)
})

test('unchanged advice stays quiet after cooldown; new evidence and resolved recurrence can remind', () => {
  const state = createReminderState()
  const original = item('verify', {}, [{ ref: 'tool:t1', quote: 'test A failed' }])
  deliver([original], state, 1)
  const replay = item('verify', {}, [{ ref: 'tool:t2', quote: 'test A failed' }])
  assert.equal(deliver([replay], state, 20).suppressed[0].reason, 'repeat')
  const changed = item('verify', {}, [{ ref: 'tool:t3', quote: 'test B failed' }])
  assert.equal(deliver([changed], state, 21).selected.length, 1)
  resolveReminders([original.card], { verify: { state: 'addressing', confidence: 0.9 } }, state, 0.6)
  assert.equal(deliver([changed], state, 22).selected.length, 0, 'progress alone does not reset deduplication')
  resolveReminders([original.card], { verify: { state: 'inapplicable', confidence: 0.9 } }, state, 0.6)
  assert.equal(deliver([changed], state, 22).selected.length, 0, 'an unrelated intermediate action does not reset deduplication')
  resolveReminders([original.card], { verify: { state: 'satisfied', confidence: 0.9 } }, state, 0.6)
  assert.equal(deliver([original], state, 23).selected.length, 1, 'a confirmed resolution can recur')
})

test('duplicate source obligations merge across ids without merging different scopes', () => {
  const state = createReminderState()
  const selected = deliver([
    item('a', { quote: 'Run the tests.' }), item('b', { quote: 'Run   the tests.' }),
    item('c', { quote: 'Run the tests.', match: { paths: ['**/*.sql'] } }),
  ], state, 1)
  assert.deepEqual(selected.selected.map(item => item.card.id), ['a', 'c'])
  assert.equal(selected.suppressed[0].card.id, 'b')
})

test('selection without delivery consumes neither history nor budget', () => {
  const state = createReminderState()
  selectReminders([item('a'), item('b'), item('c')], state, 1, config)
  assert.equal(state.history.size, 0)
  assert.equal(state.count, 0)
  assert.equal(deliver([item('a'), item('b'), item('c')], state, 1).selected.length, 3)
})

test('unknown and addressing duties never produce a recovery or final checklist', () => {
  const cards = Array.from({ length: 20 }, (_, index) => ({ ...item(`duty-${index}`).card, skill: 'loaded', grounded: true }))
  for (const boundary of ['tool', 'settle']) for (const state of ['unknown', 'addressing']) {
    const assessments = Object.fromEntries(cards.map(card => [card.id, { state, confidence: 0.9 }]))
    assert.equal(selectAssessments(assessments, cards, [], config, {
      boundary, triggers: ['failed'], active: new Set(['loaded']), cooldowns: new Map(),
    }).selected.length, 0)
  }
})

test('skill checkpoints and scope advise by default; explicit enforcement still works', () => {
  const card = { skill: 'x', id: 'checkpoint', grounded: true, checkpoint: true }
  assert.equal(enforceable(card, config.enforcement), false)
  assert.equal(enforceable({ id: 'scope' }, config.enforcement), false)
  assert.equal(enforceable(card, { ...config.enforcement, skillCheckpoints: true }), true)
  assert.equal(enforceable(card, { ...config.enforcement, cards: ['checkpoint'] }), true)
  assert.equal(enforceable({ id: 'halt' }, config.enforcement), true)
})

test('compact skill advice keeps the exact source and concrete reason without repeating the checklist', () => {
  const card = { id: 'x', skill: 'x', title: 'Validate', grounded: true, quote: 'Run tests unless documentation only.',
    rules: ['Run the tests'], satisfiedWhen: 'Tests pass', notApplicable: 'Documentation only' }
  const text = renderGuidance([card], { boundary: 'tool', triggers: ['edit'], assessments: { x: { reason: 'The last change has no completed test.' } } })
  assert.ok(text.includes(card.quote))
  assert.match(text, /The last change has no completed test/)
  assert.doesNotMatch(text, /完成证据：|不适用：|Run the tests/)
})

test('shadow follow-up counts only the reminders that would actually be delivered', () => {
  const totals = aggregate([{ kind: 'decision', sessionId: 's', turn: 1, shadow: true, wouldInject: true,
    selected: ['shown', 'limited'], wouldDeliverCards: ['shown'], evidenceSeq: 1, responseSeq: 1,
    deliveryEvidenceSeq: 1, deliveryResponseSeq: 1, deliveredAt: '2026-10-21T00:00:00Z' }])
  assert.equal(totals.followUp.pending, 1)
})
