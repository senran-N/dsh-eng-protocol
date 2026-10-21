/// Adaptive control and retry for auxiliary model calls: no budgets, real recovery.
// Skill compilation has its own suite (compile.mjs).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ENG_PROTOCOL_RETRY_BASE_MS = '1'
const { AdaptiveLimiter, AdaptiveRegistry, AdaptiveSize, LatencyTracker, classifyError, sleep: waitFor, withRetry } = await import('../lib/adaptive.js')
const { decisionRoute, normalizeConfig, saveUserSettings } = await import('../lib/config.js')
const { evaluateDecision, packBatches, planRounds } = await import('../lib/decide.js')
const { BUILTIN_CARDS } = await import('../lib/cards.js')

const route = { provider: 'mock', model: 'mock' }
const config = normalizeConfig({}, process.cwd())
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fake host LLM: `reply(prompt, index, callConfig, signal)` returns text, `{ text, finish }`, or throws. */
function fakeLlm(reply) {
  const prompts = []
  return {
    prompts,
    async prepareCall(callConfig) {
      return {
        config: callConfig,
        async *stream({ messages, signal }) {
          const prompt = messages[0].content[0].text
          prompts.push({ prompt, maxTokens: callConfig.maxTokens })
          const out = await reply(prompt, prompts.length - 1, callConfig, signal)
          const { text, finish = 'stop' } = typeof out === 'string' ? { text: out } : out
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: finish } }
        },
      }
    },
  }
}

test('errors are classified for retry and explained in plain language', () => {
  assert.equal(classifyError(Object.assign(new Error('slow down'), { status: 429, retryAfterMs: 2000 })).kind, 'rate-limit')
  assert.equal(classifyError(Object.assign(new Error('x'), { failure: { code: 'AUTH', message: 'bad key', status: 401 } })).kind, 'auth')
  assert.equal(classifyError(new DOMException('The operation was aborted due to timeout', 'TimeoutError')).kind, 'timeout')
  assert.equal(classifyError(new DOMException('模型长时间没有输出', 'TimeoutError')).kind, 'timeout')
  assert.equal(classifyError(Object.assign(new Error('cut'), { code: 'MAX_TOKENS' })).kind, 'truncated')
  assert.equal(classifyError(new Error('400 Incorrect role information')).kind, 'role')
  assert.equal(classifyError(new Error('入口卡缺少 when')).kind, 'bad-output')
  assert.equal(classifyError(new Error('fetch failed: ECONNRESET')).kind, 'network')
  for (const kind of ['auth', 'role', 'model', 'config', 'truncated']) assert.equal(classifyError(Object.assign(new Error('x'), { kind })).retryable, false)
  assert.match(classifyError(Object.assign(new Error('x'), { status: 401 })).hint, /API key/)
})

test('withRetry backs off on transient failures and stops at permanent ones', async () => {
  let calls = 0
  const retries = []
  const value = await withRetry(async () => {
    calls += 1
    if (calls < 3) throw Object.assign(new Error('busy'), { status: 503 })
    return 'ok'
  }, { onRetry: (info) => retries.push(info.info.kind) })
  assert.equal(value, 'ok')
  assert.deepEqual(retries, ['overloaded', 'overloaded'])
  calls = 0
  await assert.rejects(withRetry(async () => { calls += 1; throw Object.assign(new Error('nope'), { status: 401 }) }), (error) => error.classified.kind === 'auth' && error.attempts === 1)
  assert.equal(calls, 1)
})

test('the limiter is AIMD: halves on overload, grows back after successes, never exceeds capacity', async () => {
  const limiter = new AdaptiveLimiter({ initial: 4, min: 1, max: 6 })
  let active = 0, peak = 0
  await Promise.all(Array.from({ length: 12 }, () => limiter.run(async () => {
    active += 1; peak = Math.max(peak, active)
    await sleep(2)
    active -= 1
  })))
  assert.equal(peak, 4)
  limiter.overload()
  assert.equal(limiter.capacity, 2)
  for (let index = 0; index < 2; index += 1) limiter.succeed()
  assert.equal(limiter.capacity, 3)
  const aborted = new AbortController()
  const blockers = [limiter.acquire(), limiter.acquire(), limiter.acquire()]
  await Promise.all(blockers)
  const waiting = limiter.acquire(aborted.signal)
  aborted.abort(new Error('gone'))
  await assert.rejects(waiting, /gone/)
  assert.equal(limiter.snapshot().queued, 0, 'an aborted waiter leaves the queue')
})

test('waiters are served by priority, then in arrival order', async () => {
  const limiter = new AdaptiveLimiter({ initial: 1, min: 1, max: 1 })
  await limiter.acquire()
  const order = []
  const runs = [['low-1', 0], ['high', 2], ['low-2', 0], ['mid', 1]].map(([name, priority]) => limiter.run(() => order.push(name), undefined, priority))
  limiter.release()
  await Promise.all(runs)
  assert.deepEqual(order, ['high', 'mid', 'low-1', 'low-2'])
})

test('slow start grows quickly only while work queues, then additively after congestion', async () => {
  const limiter = new AdaptiveLimiter({ initial: 4, min: 1, max: 64, slowStart: true })
  for (let index = 0; index < 40; index += 1) limiter.succeed()
  assert.equal(limiter.capacity, 4, 'no queue means no reason to grow')
  let active = 0, peak = 0
  await Promise.all(Array.from({ length: 300 }, () => limiter.run(async () => {
    active += 1; peak = Math.max(peak, active)
    await sleep(4)
    active -= 1
    limiter.succeed()
  })))
  assert.ok(peak > 16, `a queue of work opened ${peak} slots`)
  const grown = limiter.capacity
  limiter.overload()
  assert.equal(limiter.capacity, Math.max(1, Math.floor(grown / 2)))
  const halved = limiter.capacity
  await Promise.all(Array.from({ length: halved * 3 }, () => limiter.run(async () => { await sleep(2); limiter.succeed() })))
  assert.ok(limiter.capacity > halved && limiter.capacity <= halved + 3, 'after congestion growth is additive')
})

test('one failing cohort reduces concurrency once; stale successes cannot undo it, and fresh failures reduce again', async () => {
  const control = new AdaptiveRegistry().for('judge', route)
  control.limiter.max = 32
  control.limiter.limit = 16
  const epoch = control.limiter.epoch
  for (let i = 0; i < 16; i += 1) AdaptiveRegistry.observe(control, { epoch, error: Object.assign(new Error('busy'), { status: 429 }) })
  assert.equal(control.limiter.capacity, 8)
  for (let i = 0; i < 20; i += 1) AdaptiveRegistry.observe(control, { epoch, ms: 10 })
  assert.equal(control.limiter.capacity, 8)
  AdaptiveRegistry.observe(control, { epoch: control.limiter.epoch, error: new DOMException('slow', 'TimeoutError'), ms: 1000 })
  assert.equal(control.limiter.capacity, 4)
  await Promise.all(Array.from({ length: 12 }, () => control.limiter.run(async () => {
    const current = control.limiter.epoch
    await sleep(2)
    AdaptiveRegistry.observe(control, { epoch: current, ms: 2 })
  })))
  assert.ok(control.limiter.capacity > 4 && control.limiter.capacity < 8, 'recovery is additive after congestion')
})

test('Retry-After pauses queued work and cancellation removes its waiter', async () => {
  const limiter = new AdaptiveLimiter({ initial: 4 })
  limiter.overload(80)
  const controller = new AbortController()
  let ran = false
  const cancelled = limiter.run(() => { ran = true }, controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(cancelled, /cancelled/)
  assert.equal(ran, false)
  const started = performance.now()
  await limiter.run(() => { ran = true })
  assert.ok(performance.now() - started >= 60)
  assert.equal(ran, true)
  assert.equal(limiter.snapshot().queued, 0)
})

test('timeouts follow observed latency below the hard ceiling', () => {
  const latency = new LatencyTracker()
  assert.equal(latency.timeout(15000), 15000, 'no samples: the ceiling applies')
  for (const ms of [400, 500, 600, 700]) latency.record(ms)
  const adaptive = latency.timeout(15000)
  assert.ok(adaptive >= 3000 && adaptive < 15000, `adaptive timeout ${adaptive}`)
  latency.record(40000)
  assert.equal(latency.timeout(15000), 15000, 'never above the ceiling')
})

test('the judge splits a candidate set whose answer would not fit, and judges every card', async () => {
  const cards = Array.from({ length: 30 }, (_, index) => ({ id: `card_${index}`, title: `c${index}`, when: 'w', rules: ['r'], triggers: ['edit'], skill: 'x' }))
  const llm = fakeLlm((prompt) => {
    const ids = JSON.parse(prompt.split('CANDIDATE CARDS:\n')[1].split('\n\nCritical cards')[0]).map((card) => card.id)
    if (ids.length > 8) return { text: '{"cards":[{"id":"card_0"', finish: 'max-tokens' }
    return JSON.stringify({ cards: ids.map((id) => ({ id, state: id === 'card_29' ? 'needed' : 'satisfied', confidence: 0.9 })) })
  })
  const state = { config, adaptive: new AdaptiveRegistry() }
  const tracker = { agent: { options: route }, decisionTick: 0, cooldowns: new Map() }
  const result = await evaluateDecision({ get: () => llm }, state, tracker, {
    boundary: 'tool', triggers: ['edit'], candidates: cards, graph: { cards, relations: [], revision: 'r' }, ledger: {},
  })
  assert.equal(result.record.error, undefined)
  assert.equal(Object.keys(result.assessments).length, 30)
  assert.ok(Object.values(result.assessments).every((item) => item.state !== 'unknown'), 'no card was dropped')
  assert.deepEqual(result.cards.map((card) => card.id), ['card_29'])
  assert.ok(result.record.splits >= 1)
  const judge = state.adaptive.snapshot().find((entry) => entry.purpose === 'judge')
  assert.ok(judge.size.current <= 12, 'the batch size shrinks for the next judgment')
})

const ruleCard = (id, extra = {}) => ({ id, title: id, when: 'w', rules: ['r'], triggers: ['edit'], skill: 'x', ...extra })
const idsOf = (prompt) => JSON.parse(prompt.split('CANDIDATE CARDS:\n')[1].split('\n\nCritical cards')[0]).map((card) => card.id)
/** A judge answer for `ids`: satisfied unless `pick(id)` says otherwise. */
const answer = (ids, pick = () => ({})) => JSON.stringify({ cards: ids.map((id) => ({ id, state: 'satisfied', confidence: 0.9, ...pick(id) })) })
const judgeAgent = { options: route }
const judgeState = (raw = {}) => ({ config: normalizeConfig(raw, process.cwd()), adaptive: new AdaptiveRegistry() })
const judgeControl = (state) => state.adaptive.for('judge', decisionRoute(judgeAgent, state.config))
const decide = (llm, state, cards, snapshot = {}) => evaluateDecision({ get: () => llm }, state, { agent: judgeAgent, cooldowns: new Map() }, {
  boundary: 'tool', triggers: ['edit'], candidates: cards, graph: { cards, relations: [], revision: 'r' }, ledger: {}, ...snapshot,
})

test('malformed judge assessments stay unknown and visible rather than acquiring default confidence', async () => {
  const card = ruleCard('missing_confidence')
  const llm = fakeLlm(() => JSON.stringify({ cards: [{ id: card.id, state: 'needed' }] }))
  const result = await decide(llm, judgeState(), [card])
  assert.equal(llm.prompts.length, 2, 'one targeted repair is allowed, never an unbounded retry')
  assert.equal(result.cards.length, 0)
  assert.equal(result.record.assessments[card.id].state, 'unknown')
  assert.equal(result.record.assessments[card.id].confidence, 0)
  assert.match(result.record.error, /判断缺失或格式无效/)
})

test('an oversized judge input reports context-limit without retrying or selecting a fabricated answer', async () => {
  const card = ruleCard('long_context')
  const llm = fakeLlm(() => { throw Object.assign(new Error('maximum context length exceeded'), { code: 'context_length_exceeded', status: 400 }) })
  const result = await decide(llm, judgeState(), [card])
  assert.equal(llm.prompts.length, 1)
  assert.equal(result.cards.length, 0)
  assert.equal(result.record.errorKind, 'context-limit')
  assert.match(result.record.error, /context length/)
  assert.equal(result.record.assessments[card.id].state, 'unknown')
  assert.equal(result.record.assessments[card.id].confidence, 0)
})

test('borderline skill routing is reviewed without weakening the configured confidence threshold', async () => {
  const entry = ruleCard('skill_client_entry', { skill: 'client', entry: true })
  const llm = fakeLlm((prompt, index) => {
    if (index > 0) assert.match(prompt, /REVIEW OF A POSSIBLY MISSED SKILL REMINDER/)
    return answer(idsOf(prompt), () => ({ state: 'needed', confidence: index === 0 ? 0.55 : 0.85 }))
  })
  const result = await decide(llm, judgeState(), [entry])
  assert.equal(llm.prompts.length, 2)
  assert.deepEqual(result.record.reviewed, [entry.id])
  assert.deepEqual(result.cards.map((card) => card.id), [entry.id])
  const uncertain = fakeLlm((prompt) => answer(idsOf(prompt), () => ({ state: 'needed', confidence: 0.55 })))
  assert.equal((await decide(uncertain, judgeState(), [entry])).cards.length, 0, 'unresolved uncertainty still does not inject')
})

test('delivery addressing is reviewed as stopping now; a failed review keeps the original verdict', async () => {
  const card = ruleCard('skill_report_complete', { skill: 'report' })
  const llm = fakeLlm((prompt, index) => {
    const evidence = JSON.parse(prompt.split('CURRENT EVIDENCE:\n')[1].split('\n\nCANDIDATE CARDS:')[0])
    assert.equal(evidence.stopping, true)
    return answer(idsOf(prompt), () => ({ state: index === 0 ? 'addressing' : 'needed', confidence: 0.9 }))
  })
  const result = await decide(llm, judgeState(), [card], { boundary: 'settle', triggers: ['settle'] })
  assert.deepEqual(result.cards.map((card) => card.id), [card.id])
  const failed = fakeLlm((prompt, index) => {
    if (index > 0) throw Object.assign(new Error('bad key'), { status: 401 })
    return answer(idsOf(prompt), () => ({ state: 'addressing', confidence: 0.7 }))
  })
  const kept = await decide(failed, judgeState(), [card], { boundary: 'settle', triggers: ['settle'] })
  assert.equal(kept.assessments[card.id].state, 'addressing')
  assert.equal(kept.cards.length, 0)
  assert.match(kept.record.error, /skill 复核没完成/)
})

test('the batch size grows only after full batches answered whole', async () => {
  const llm = fakeLlm((prompt) => answer(idsOf(prompt)))
  const state = judgeState()
  const small = Array.from({ length: 3 }, (_, index) => ruleCard(`small_${index}`))
  for (let run = 0; run < 12; run += 1) await decide(llm, state, small)
  assert.equal(judgeControl(state).size.current, 24, 'a 3-card judgment says nothing about a 24-card batch')
  const full = Array.from({ length: 24 }, (_, index) => ruleCard(`full_${index}`))
  for (let run = 0; run < 8; run += 1) await decide(llm, state, full)
  assert.equal(judgeControl(state).size.current, 30, 'eight full batches answered whole let it grow')
})

test('batches failing at the same size shrink it once; a smaller size failing halves it again', () => {
  const size = new AdaptiveSize({ initial: 24, min: 1, max: 64 })
  for (let batch = 0; batch < 4; batch += 1) size.shrink(24)
  assert.equal(size.current, 12)
  size.shrink(12)
  assert.equal(size.current, 6)
})

test('a shared time limit keeps answered batches without training smaller batches or provider congestion', async () => {
  const llm = fakeLlm(async (prompt, index, callConfig, signal) => {
    const ids = idsOf(prompt)
    // The full batch never answers in time; the small one answers at once.
    if (ids.length > 6) await waitFor(5000, signal).catch(() => {})
    return answer(ids, (id) => (id === 'card_29' ? { state: 'needed' } : {}))
  })
  const state = judgeState({ decision: { timeoutMs: 800 } })
  const cards = Array.from({ length: 30 }, (_, index) => ruleCard(`card_${index}`))
  const result = await decide(llm, state, cards)
  assert.equal(result.record.deadlineExpired, true)
  assert.match(result.record.error, /一部分规则没在时限内检查完/)
  assert.deepEqual(result.cards.map((card) => card.id), ['card_29'], 'the batch that answered in time still delivers')
  assert.deepEqual(result.assessments.card_0, { state: 'unknown', confidence: 0, reason: '这条没在时限内检查完' })
  assert.equal(judgeControl(state).size.current, 24, 'a shared budget is not evidence of insufficient card capacity')
  assert.equal(judgeControl(state).limiter.epoch, 0, 'our own deadline must not train provider congestion')
})

test('a batch cut off while it waited for a slot does not shrink the size', async () => {
  const llm = fakeLlm(async (prompt, index, callConfig, signal) => {
    const ids = idsOf(prompt)
    // The first batch holds the only slot for two thirds of the limit; the
    // second starts late and is cut off soon after through no fault of its size.
    if (ids.length > 6) await sleep(1000)
    else await waitFor(5000, signal).catch(() => {})
    return answer(ids)
  })
  const state = judgeState({ decision: { timeoutMs: 1500 } })
  judgeControl(state).limiter.limit = 1
  const cards = Array.from({ length: 30 }, (_, index) => ruleCard(`card_${index}`))
  const result = await decide(llm, state, cards)
  assert.equal(result.record.deadlineExpired, true)
  assert.equal(result.assessments.card_0.state, 'satisfied')
  assert.equal(result.assessments.card_29.state, 'unknown')
  assert.equal(judgeControl(state).size.current, 24)
})

test('batches keep related rules together; skill membership joins nothing', () => {
  const cards = ['a', 'b', 'c', 'd'].map((id) => ruleCard(id))
  const ids = (batches) => batches.map((batch) => batch.map((card) => card.id))
  assert.deepEqual(ids(packBatches(cards, 2)), [['a', 'b'], ['c', 'd']])
  assert.deepEqual(ids(packBatches(cards, 2, [{ type: 'requires', source: 'b', target: 'd' }])), [['a'], ['b', 'd'], ['c']])
  assert.deepEqual(ids(packBatches(cards, 2, [{ type: 'contains', source: 'b', target: 'd' }])), [['a', 'b'], ['c', 'd']])
  // A group bigger than a batch is cut in order and its tail shares the next batch.
  const chain = [{ type: 'requires', source: 'a', target: 'b' }, { type: 'blocks', source: 'b', target: 'c' }]
  assert.deepEqual(ids(packBatches(cards, 2, chain)), [['a', 'b'], ['c', 'd']])
})

/** Two loaded skills: `keep` stays in scope, `drop` does not; each has three rules under its entry card. */
function layered() {
  const entry = (skill) => ruleCard(`skill_${skill}_entry`, { skill, entry: true, triggers: ['turn'] })
  const rules = (skill) => Array.from({ length: 3 }, (_, index) => ruleCard(`skill_${skill}_r${index}`, { skill, triggers: ['turn'] }))
  const cards = [entry('keep'), entry('drop'), ...rules('keep'), ...rules('drop')]
  const relations = cards.filter((card) => !card.entry).map((card) => ({ type: 'contains', source: `skill_${card.skill}_entry`, target: card.id }))
  const llm = fakeLlm((prompt) => answer(idsOf(prompt), (id) => (
    id === 'skill_drop_entry' ? { state: 'inapplicable' }
      : id === 'skill_keep_entry' ? { state: 'addressing' }
        : id === 'skill_keep_r0' ? { state: 'needed' } : {})))
  const snapshot = { boundary: 'request', triggers: ['turn'], graph: { cards, relations, revision: 'r' }, activeSkills: new Set(['keep', 'drop']) }
  return { cards, relations, llm, snapshot, asked: () => llm.prompts.map(({ prompt }) => idsOf(prompt)) }
}

test('a new turn too big for one wave judges entry cards first and expands only the skills still in scope', async () => {
  const { cards, llm, snapshot, asked } = layered()
  const state = judgeState()
  // Two cards a batch and two batches at a time: one wave holds four of the eight cards.
  judgeControl(state).size.value = 2
  judgeControl(state).limiter.limit = 2
  const result = await decide(llm, state, cards, snapshot)
  assert.deepEqual(asked()[0], ['skill_keep_entry', 'skill_drop_entry'], 'the entry cards go first, alone')
  assert.deepEqual(asked().slice(1).flat(), ['skill_keep_r0', 'skill_keep_r1', 'skill_keep_r2'], 'only the skill still in scope is expanded')
  assert.match(llm.prompts[1].prompt, /ASSESSMENTS ALREADY MADE AT THIS SAME BOUNDARY:\n\{"skill_keep_entry":\{"state":"addressing"/)
  assert.equal(result.record.rounds, 2)
  assert.deepEqual(result.cards.map((card) => card.id), ['skill_keep_r0'])
  assert.ok(result.record.candidates.includes('skill_drop_r0'), 'the rules left unexpanded are still listed')
  assert.equal(result.record.assessments.skill_drop_r0, undefined, 'and carry no made-up verdict')
  assert.deepEqual(result.record.reasons.skill_drop_r0, { kind: 'scope', by: 'skill_drop_entry' })
})

test('a new turn that fits in one wave is judged in one round', async () => {
  const { cards, llm, snapshot, asked } = layered()
  const result = await decide(llm, judgeState(), cards, snapshot)
  assert.equal(asked().length, 1)
  assert.equal(result.record.rounds, undefined)
  assert.deepEqual(result.cards.map((card) => card.id), ['skill_keep_r0'], 'a skill out of scope still delivers nothing')
})

test('the rules of a skill invoked this very step are never held back', () => {
  const { cards, relations } = layered()
  const plan = planRounds(cards, relations, { invoked: 'drop', wave: 0 })
  assert.deepEqual(plan.held.map((card) => card.id), ['skill_keep_r0', 'skill_keep_r1', 'skill_keep_r2'])
  assert.ok(plan.first.some((card) => card.id === 'skill_drop_r0'))
})

test('retired fields from older versions are ignored and silently removed on save', async () => {
  const home = await mkdtemp(join(tmpdir(), 'eng-deprecated-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await writeFile(join(home, 'eng-protocol.json'), JSON.stringify({ maxCards: 3, skills: { maxCardsPerSkill: 8, include: ['a'] }, decision: { boundaryBudgetMs: 9000 } }))
    const saved = await saveUserSettings({ runtime: { cooldownSteps: 4 } }, config, home)
    assert.deepEqual(saved.cleaned.sort(), ['decision.boundaryBudgetMs', 'maxCards', 'skills.maxCardsPerSkill'])
    const written = JSON.parse(await readFile(saved.path, 'utf8'))
    assert.deepEqual(written, { skills: { include: ['a'] }, decision: {}, cooldownSteps: 4 })
    await assert.rejects(saveUserSettings({ skills: { maxCardsPerSkill: 4 } }, config, home), /不允许/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('builtin ids stay disjoint from compiled skill ids', () => {
  assert.ok(BUILTIN_CARDS.every((card) => !card.id.startsWith('skill_')))
})
