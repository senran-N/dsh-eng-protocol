import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AdaptiveRegistry } from '../lib/adaptive.js'
import { normalizeConfig, decisionRoute } from '../lib/config.js'
import { evaluateDecision } from '../lib/decide.js'
import { partialJson } from '../lib/model.js'

const route = { provider: 'mock', model: 'mock' }
const agent = { options: route }
const card = id => ({ id, title: id, rules: ['Verify the actual result'], triggers: ['edit'] })
const idsOf = prompt => JSON.parse(prompt.split('CANDIDATE CARDS:\n')[1].split('\n\nCritical cards')[0]).map(card => card.id)
const answer = ids => ({ cards: ids.map(id => ({ id, state: 'satisfied', confidence: 0.9 })) })
function fakeLlm(reply) {
  const calls = []
  return { calls, async prepareCall(config) { return { config, async *stream({ messages, signal }) {
    const prompt = messages[0].content[0].text
    const call = { ids: idsOf(prompt), maxTokens: config.maxTokens }
    calls.push(call)
    const result = await reply(call, calls.length, signal)
    yield { type: 'text-delta', text: typeof result.text === 'string' ? result.text : JSON.stringify(result) }
    yield { type: 'finish', reason: { kind: result.finish ?? 'stop' } }
  } } } }
}
const stateOf = timeoutMs => ({ config: normalizeConfig({ decision: { ...route, timeoutMs: timeoutMs ?? 2000 } }), adaptive: new AdaptiveRegistry() })
const controlOf = state => state.adaptive.for('judge', decisionRoute(agent, state.config))
const decide = (llm, state, cards) => evaluateDecision({ get: () => llm }, state, { agent, cooldowns: new Map() }, {
  boundary: 'tool', triggers: ['edit'], candidates: cards, ledger: {}, graph: { cards, relations: [], revision: 'r' },
})
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
  signal?.addEventListener('abort', stop, { once: true })
})

test('a one-card judgment has enough space for task understanding, citations and relationships', async () => {
  const llm = fakeLlm(({ ids, maxTokens }) => maxTokens < 2048
    ? { text: '{"cards":[', finish: 'max-tokens' } : answer(ids))
  const result = await decide(llm, stateOf(), [card('single')])
  assert.equal(result.assessments.single.state, 'satisfied')
  assert.equal(result.record.error, undefined)
  assert.equal(llm.calls.length, 1)
})

test('splitting a truncated answer retains the output allowance instead of shrinking it with the batch', async () => {
  const llm = fakeLlm(({ ids, maxTokens }) => ids.length > 8 || maxTokens < 4096
    ? { text: '{"cards":[', finish: 'max-tokens' } : answer(ids))
  const result = await decide(llm, stateOf(), Array.from({ length: 16 }, (_, i) => card(`r${i}`)))
  assert.equal(result.record.judgeCoverage.answered, 16)
  assert.ok(llm.calls.length <= 3, 'two halves should finish without cascading down to singletons')
  assert.ok(llm.calls.slice(1).every(call => call.maxTokens >= llm.calls[0].maxTokens))
})

test('complete quoted assessments survive a truncated JSON tail and only the missing card is retried', async () => {
  const llm = fakeLlm(({ ids }, n) => n === 1
    ? { text: '{"cards":[{"id":"done","state":"satisfied","confidence":0.9,"reason":"escaped \\" brace } text"},{"id":"missing",', finish: 'max-tokens' }
    : answer(ids))
  const result = await decide(llm, stateOf(), [card('done'), card('missing')])
  assert.equal(result.assessments.done.state, 'satisfied')
  assert.equal(result.assessments.missing.state, 'satisfied')
  assert.deepEqual(llm.calls[1].ids, ['missing'])
  assert.ok(result.record.recoveredAssessments >= 1)
})

test('a singleton that really exhausts the full allowance retries once with more space', async () => {
  const llm = fakeLlm(({ ids, maxTokens }) => maxTokens < 12000
    ? { text: '{"cards":[', finish: 'max-tokens' } : answer(ids))
  const state = stateOf()
  const result = await decide(llm, state, [card('verbose')])
  assert.equal(result.assessments.verbose.state, 'satisfied')
  assert.equal(llm.calls.length, 2)
  assert.ok(llm.calls[1].maxTokens > llm.calls[0].maxTokens)
  assert.equal(controlOf(state).size.current, 24)
})

test('an uncalibrated healthy request is not killed at 65 percent of its deadline', async () => {
  const llm = fakeLlm(async ({ ids }, n, signal) => { await wait(3100, signal); return answer(ids) })
  const state = stateOf(4500)
  const result = await decide(llm, state, [card('slow-but-healthy')])
  assert.equal(result.assessments['slow-but-healthy'].state, 'satisfied')
  assert.equal(llm.calls.length, 1)
  assert.equal(controlOf(state).limiter.epoch, 0)
})

test('successful full batches recover capacity even when a separate batch misses the round deadline', async () => {
  const state = stateOf(500)
  const control = controlOf(state)
  control.size.value = 1
  const llm = fakeLlm(async ({ ids }, n, signal) => {
    if (ids[0] === 'slow') await wait(5000, signal)
    return answer(ids)
  })
  for (let i = 0; i < 8; i++) await decide(llm, state, [card('fast'), card('slow')])
  assert.ok(control.size.current > 1, 'partial rounds must not trap every later judgment in singleton batches')
})

test('partial recovery never invents missing values or parses quoted/nested cards as top-level judgments', () => {
  assert.deepEqual(partialJson('{"cards":[{"id":"unfinished","state":"satisfied","confidence":'), { cards: [] })
  assert.equal(partialJson(JSON.stringify({ diagnostic: { cards: [{ id: 'fake', confidence: 1 }] } }).slice(0, -1)), undefined)
  const raw = '{"task":{"goal":"text saying \\"cards\\": [{fake}]"},"cards":[{"id":"ok","state":"unknown","confidence":0},'
  assert.deepEqual(partialJson(raw).cards, [{ id: 'ok', state: 'unknown', confidence: 0 }])
})

test('a deadline keeps fully streamed assessments, validates their citations and leaves the torn tail unknown', async () => {
  const state = stateOf(500)
  const llm = { async prepareCall(config) { return { config, async *stream({ signal }) {
    yield { type: 'text-delta', text: '{"cards":[{"id":"good","state":"satisfied","confidence":0.9},'
      + '{"id":"forged","state":"needed","confidence":0.9,"evidence":[{"ref":"invented","quote":"passed"}]},{"id":"unfinished",' }
    await wait(5000, signal)
  } } } }
  const result = await decide(llm, state, ['good', 'forged', 'unfinished'].map(card))
  assert.equal(result.assessments.good.state, 'satisfied')
  assert.equal(result.assessments.forged.state, 'unknown')
  assert.equal(result.assessments.unfinished.state, 'unknown')
  assert.equal(result.record.recoveredAssessments, 1)
  assert.equal(result.record.deadlineExpired, true)
  assert.equal(result.record.attempts[0].status, 'partial')
  assert.equal(result.record.attempts[0].maxTokens, 8192)
})

test('a real provider output limit lowers the request allowance without changing the card batch capacity', async () => {
  const state = stateOf()
  const llm = fakeLlm(({ ids, maxTokens }) => {
    if (maxTokens > 4096) throw Object.assign(new Error('max_tokens exceeds output limit'), { status: 400 })
    return answer(ids)
  })
  const result = await decide(llm, state, [card('limited')])
  assert.equal(result.assessments.limited.state, 'satisfied')
  assert.deepEqual(llm.calls.map(call => call.maxTokens), [8192, 4096])
  assert.equal(controlOf(state).size.current, 24)
})

test('a calibrated retry timer detects silence without killing a response that is still streaming', async () => {
  const state = stateOf(4500)
  for (let i = 0; i < 4; i++) await decide(fakeLlm(({ ids }) => answer(ids)), state, [card('streaming')])
  const control = controlOf(state)
  for (const tracker of control.judgmentLatency.values()) tracker.samples = [600, 600, 600, 1400]
  let calls = 0
  const llm = { async prepareCall(config) { return { config, async *stream({ signal }) {
    calls++
    yield { type: 'text-delta', text: '{"cards":[' }
    for (let i = 0; i < 6; i++) { await wait(500, signal); yield { type: 'text-delta', text: ' ' } }
    yield { type: 'text-delta', text: '{"id":"streaming","state":"satisfied","confidence":0.9}]}' }
  } } } }
  const result = await decide(llm, state, [card('streaming')])
  assert.equal(calls, 1)
  assert.equal(result.assessments.streaming.state, 'satisfied')
  assert.ok(result.record.attempts[0].stallTimeoutMs < result.record.attempts[0].runMs)
  assert.equal(control.limiter.epoch, 0)
})
