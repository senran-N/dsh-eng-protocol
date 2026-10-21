import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdaptiveRegistry } from '../lib/adaptive.js'
import { decisionRoute, normalizeConfig } from '../lib/config.js'
import { decisionPrompt, evaluateDecision, evidencePayload, evidenceReferences, normalizeAssessments } from '../lib/decide.js'
import { SessionLedger } from '../lib/events.js'
import { Aftermath } from '../lib/aftermath.js'
import { BLOCK_INFO } from '../lib/intervention.js'
import { appendDecision, loadEvidence, readDecisions } from '../lib/store.js'
import { decisionsPayload, registerDashboard } from '../lib/dashboard.js'

const route = { provider: 'mock', model: 'mock' }
const agent = { options: route, session: { id: 's', header: { cwd: 'C:/project' } } }
const card = (id, extra = {}) => ({ id, title: id, when: 'editing', rules: ['Verify the result'], triggers: ['edit'], ...extra })
const stateOf = (timeoutMs = 500) => ({ config: normalizeConfig({ decision: { ...route, timeoutMs } }, process.cwd()), adaptive: new AdaptiveRegistry() })
const idsOf = (prompt) => JSON.parse(prompt.split('CANDIDATE CARDS:\n')[1].split('\n\nCritical cards')[0]).map((item) => item.id)
const answer = (prompt, state = 'satisfied') => ({ cards: idsOf(prompt).map((id) => ({ id, state, confidence: 0.9 })) })
function fakeLlm(reply) {
  const calls = []
  return { calls, async prepareCall(config) { return { config, async *stream({ messages, signal }) {
    const prompt = messages[0].content[0].text
    calls.push(prompt)
    yield { type: 'text-delta', text: JSON.stringify(await reply(prompt, signal, calls.length)) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } } }
}
const decide = (llm, state, cards, extra = {}) => evaluateDecision({ get: () => llm }, state, { agent, cooldowns: new Map() }, {
  boundary: 'tool', triggers: ['edit'], candidates: cards, ledger: {}, graph: { cards, relations: [], revision: 'r' }, ...extra,
})
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
  })
}
const eventCall = (callId, name, args, seq) => ({ type: 'tool/call', seq, data: { callId, name, arguments: args } })
const eventResult = (callId, content, seq, isError = false) => ({ type: 'tool/result', seq, data: { message: { source: { callId }, content, isError } } })

test('the judge receives chronological failure, diagnosis, actual edit and later validation evidence', () => {
  const ledger = new SessionLedger(agent)
  ledger.observe([{ role: 'user', source: { kind: 'user' }, content: 'Fix the parser and verify it without weakening the test.' }])
  for (const event of [
    eventCall('failed', 'pwsh', { command: 'npm test' }, 1), eventResult('failed', 'Parser assertion failed', 2, true),
    { type: 'assistant/message', seq: 3, data: { message: { content: 'The parser loses the final token; preserve the assertion.' } } },
    eventCall('fix', 'edit', { path: 'src/parser.js', old_string: 'dropTail()', new_string: 'keepTail()' }, 4), eventResult('fix', 'edited', 5),
    eventCall('verified', 'pwsh', { command: 'npm test' }, 6), eventResult('verified', 'All parser tests passed', 7),
  ]) ledger.push(event)
  ledger.observe([])
  const evidence = evidencePayload({ ledger: ledger.summary() })
  const text = decisionPrompt({ ledger: ledger.summary() }, [card('verify')])
  assert.match(text, /dropTail\(\)/)
  assert.match(text, /keepTail\(\)/)
  assert.match(text, /preserve the assertion/)
  assert.deepEqual(evidence.timeline.filter((item) => item.callId).map((item) => item.callId), ['failed', 'failed', 'fix', 'fix', 'verified', 'verified'])
  const refs = evidenceReferences(evidence)
  assert.equal(refs.get('tool:verified').text, 'All parser tests passed')
  assert.equal(evidence.checks.at(-1).editRevision, 1)
  assert.equal(evidence.editRevision, 1)
})

test('resumed trajectory retains edits and earlier assistant explanations with stable source ids', () => {
  const ledger = new SessionLedger({ session: { deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: 'Fix it' },
    { role: 'assistant', content: [{ type: 'text', text: 'Root cause established' }, { type: 'tool-call', id: 'e', name: 'edit', arguments: { path: 'x.js', old_string: 'wrong', new_string: 'correct' } }] },
    { role: 'tool', toolCallId: 'e', content: 'Done' },
  ] } })
  assert.deepEqual(ledger.summary().timeline.map((item) => item.kind), ['user', 'assistant', 'tool-call', 'tool-result'])
  assert.match(ledger.summary().timeline[2].text, /correct/)
  const firstRef = ledger.summary().timeline[0].ref
  for (let i = 0; i < 30; i += 1) ledger.push({ type: 'assistant/message', data: { message: { content: `update ${i}` } } })
  ledger.observe([])
  assert.ok(!ledger.summary().timeline.some((item) => item.ref === firstRef))
  assert.equal(ledger.summary().evidenceCoverage.omittedTimeline, 10)
  assert.equal(new Set(ledger.summary().timeline.map((item) => item.ref)).size, 24)
})

test('invented references and mismatched quotations invalidate only the affected assessment', () => {
  const candidates = [card('good'), card('bad')]
  const refs = new Map([['event:1', { text: 'All parser tests passed' }]])
  for (const evidence of [[{ ref: 'event:999', quote: 'passed' }], [{ ref: 'event:1', quote: 'tests were skipped' }], [{ ref: 'event:1' }], 'event:1']) {
    const assessments = normalizeAssessments({ cards: [
      { id: 'good', state: 'satisfied', confidence: 0.9, evidence: [{ ref: 'event:1', quote: 'tests passed' }] },
      { id: 'bad', state: 'needed', confidence: 0.9, evidence },
    ] }, candidates, refs)
    assert.equal(assessments.good.state, 'satisfied')
    assert.equal(assessments.bad.state, 'unknown')
    assert.equal(assessments.bad.confidence, 0)
  }
})

test('task interpretation and exact supporting quotations survive the complete judge and log boundary', async () => {
  const llm = fakeLlm(() => ({ task: { goal: 'Fix parser', constraints: ['keep assertions'], phase: 'validation', remaining: ['report'], sourceRefs: ['request:1'] },
    cards: [{ id: 'verify', state: 'satisfied', confidence: 0.9, evidence: [{ ref: 'tool:test', quote: 'All tests passed' }] }] }))
  const result = await decide(llm, stateOf(), [card('verify')], { ledger: { taskRequests: ['Fix parser; keep assertions'], recent: [{ callId: 'test', output: 'All tests passed' }] } })
  assert.equal(result.record.attempts[0].understanding.goal, 'Fix parser')
  assert.deepEqual(result.record.assessments.verify.evidence, [{ ref: 'tool:test', quote: 'All tests passed' }])
  assert.equal(result.record.citationCoverage.cited, 1)
  assert.equal(result.evidenceSnapshot.references.find((item) => item.ref === 'tool:test').text, 'All tests passed')
})

test('review shares the initial judgment deadline instead of starting another full timeout', async () => {
  const llm = fakeLlm(async (prompt, signal, number) => {
    await delay(380, signal)
    return { cards: idsOf(prompt).map((id) => ({ id, state: 'needed', confidence: number === 1 ? 0.55 : 0.9 })) }
  })
  const result = await decide(llm, stateOf(), [card('skill_parser_entry', { skill: 'parser', entry: true })])
  assert.equal(llm.calls.length, 2)
  assert.equal(result.record.deadlineExpired, true)
  assert.equal(result.cards.length, 0, 'unfinished review cannot invent a high-confidence verdict')
  const review = result.record.attempts.find((item) => item.phase === 'review')
  assert.equal(review.timeoutStage, 'model')
  assert.ok(review.runMs < 300, `review got ${review.runMs}ms instead of remaining time`)
  assert.ok(result.record.latencyMs < 700)
})

test('layer expansion preserves answered entries while distinguishing model and queue timeouts', async () => {
  const state = stateOf()
  const control = state.adaptive.for('judge', decisionRoute(agent, state.config))
  control.size.value = 1
  control.limiter.limit = 1
  control.limiter.max = 1
  const cards = [card('skill_x_entry', { entry: true, skill: 'x' }), card('x1', { skill: 'x' }), card('x2', { skill: 'x' })]
  const relations = cards.slice(1).map((item) => ({ type: 'contains', source: cards[0].id, target: item.id }))
  const llm = fakeLlm(async (prompt, signal, number) => { await delay(number === 1 ? 300 : 400, signal); return answer(prompt, 'needed') })
  const result = await decide(llm, state, cards, { graph: { cards, relations, revision: 'r' } })
  assert.equal(result.assessments.skill_x_entry.state, 'needed')
  assert.equal(result.assessments.x1.state, 'unknown')
  assert.equal(result.assessments.x2.state, 'unknown')
  assert.deepEqual(new Set(result.record.timeoutStages), new Set(['budget', 'model']))
  assert.equal(llm.calls.length, 2, 'the queued batch must not call the model after the deadline')
})

test('queue-only timeouts never run the model or shrink its candidate capacity', async () => {
  const state = stateOf()
  const control = state.adaptive.for('judge', decisionRoute(agent, state.config))
  control.limiter.limit = 1
  await control.limiter.acquire()
  const keepAlive = setTimeout(() => {}, 1500)
  try {
    const llm = fakeLlm((prompt) => answer(prompt))
    const result = await decide(llm, state, [card('a'), card('b')])
    assert.equal(llm.calls.length, 0)
    assert.deepEqual(result.record.timeoutStages, ['queue'])
    assert.equal(result.record.attempts[0].runMs, 0)
    assert.ok(result.record.queueMs >= 450)
    assert.equal(control.size.current, 24)
    assert.equal(control.limiter.waiters.length, 0)
  } finally { clearTimeout(keepAlive); control.limiter.release() }
})

test('fast small judgments cannot shorten the deadline learned for a much larger input', async () => {
  const state = stateOf(10000)
  const llm = fakeLlm((prompt) => answer(prompt))
  let small
  for (let i = 0; i < 5; i += 1) small = await decide(llm, state, [card('x')])
  assert.equal(small.record.deadlineMs, 2500)
  const large = await decide(llm, state, [card('x')], { ledger: { user: 'large task evidence '.repeat(6000) } })
  assert.equal(large.record.deadlineMs, 10000)
})

test('a calibrated stalled request retries within the deadline without treating our retry timer as provider congestion', async () => {
  const state = stateOf(4500)
  const control = state.adaptive.for('judge', decisionRoute(agent, state.config))
  for (let i = 0; i < 4; i++) await decide(fakeLlm(prompt => answer(prompt)), state, [card('x')])
  for (const latency of control.judgmentLatency.values()) latency.samples = [600, 600, 600, 1400]
  const llm = fakeLlm(async (prompt, signal, number) => {
    if (number === 1) await delay(10000, signal)
    return answer(prompt)
  })
  const result = await decide(llm, state, [card('x')])
  assert.equal(llm.calls.length, 2)
  assert.equal(result.assessments.x.state, 'satisfied')
  assert.equal(result.record.error, undefined)
  assert.equal(result.record.deadlineExpired, undefined)
  assert.equal(result.record.attempts[0].errorKind, 'timeout')
  assert.equal(result.record.attempts[1].status, 'answered')
  assert.ok(result.record.latencyMs < 4500)
  assert.equal(control.limiter.epoch, 0, 'a local retry cutoff is not a provider congestion response')
  assert.equal(control.limiter.snapshot().active, 0)
})

test('a known slow workload keeps its full wait when there is no room for a useful retry', async () => {
  const state = stateOf(4500)
  const cards = [card('x')]
  for (let i = 0; i < 4; i += 1) await decide(fakeLlm((prompt) => answer(prompt)), state, cards)
  const control = state.adaptive.for('judge', decisionRoute(agent, state.config))
  for (const latency of control.judgmentLatency.values()) latency.samples = [3000, 3100, 3200, 3300]
  const llm = fakeLlm(async (prompt, signal) => { await delay(3100, signal); return answer(prompt) })
  const result = await decide(llm, state, cards)
  assert.equal(llm.calls.length, 1, 'a normal slow answer must not be killed for an infeasible retry')
  assert.equal(result.assessments.x.state, 'satisfied')
  assert.equal(result.record.error, undefined)
  assert.ok(result.record.attempts[0].timeoutMs > 4000)
})

test('missing assessments are repaired once without rechecking or losing valid answers', async () => {
  const llm = fakeLlm((prompt, signal, number) => number === 1
    ? { cards: [{ id: 'good', state: 'needed', confidence: 0.9 }] }
    : answer(prompt))
  const state = stateOf()
  const result = await decide(llm, state, [card('good'), card('missing')])
  assert.equal(llm.calls.length, 2)
  assert.deepEqual(idsOf(llm.calls[1]), ['missing'])
  assert.equal(result.assessments.good.state, 'needed')
  assert.equal(result.assessments.missing.state, 'satisfied')
  assert.equal(result.record.repairs, 1)
  assert.equal(result.record.error, undefined)
  assert.equal(state.adaptive.for('judge', decisionRoute(agent, state.config)).size.current, 24,
    'a small malformed answer must not collapse the capacity for later large tasks')
})

test('a full batch repairs a missing answer without mistaking it for a capacity error', async () => {
  const state = stateOf()
  const cards = Array.from({ length: 24 }, (_, index) => card(`x${index}`))
  const llm = fakeLlm((prompt, signal, number) => {
    const result = answer(prompt)
    if (number === 1) result.cards.pop()
    return result
  })
  const result = await decide(llm, state, cards)
  assert.equal(result.record.error, undefined)
  assert.deepEqual(idsOf(llm.calls[1]), ['x23'])
  assert.equal(Object.keys(result.assessments).length, 24)
  assert.equal(state.adaptive.for('judge', decisionRoute(agent, state.config)).size.current, 24)
})

test('repeated forged citations remain unknown after one repair and never erase good answers', async () => {
  const llm = fakeLlm((prompt) => ({ cards: idsOf(prompt).map((id) => ({ id, state: 'needed', confidence: 0.9,
    ...(id === 'bad' ? { evidence: [{ ref: 'invented:1', quote: 'passed' }] } : {}) })) }))
  const result = await decide(llm, stateOf(), [card('good'), card('bad')])
  assert.equal(llm.calls.length, 2)
  assert.equal(result.assessments.good.state, 'needed')
  assert.equal(result.assessments.bad.state, 'unknown')
  assert.equal(result.assessments.bad.confidence, 0)
  assert.deepEqual(result.cards.map((item) => item.id), ['good'])
  assert.match(result.record.error, /1 条判断缺失或格式无效/)
})

test('large catalogs bound queued requests and repair invalid answers before the catalog tail', async () => {
  const state = stateOf(3000)
  const control = state.adaptive.for('judge', decisionRoute(agent, state.config))
  control.size.value = 1
  control.limiter.limit = 1
  let peakQueued = 0
  const llm = fakeLlm(async (prompt, signal, number) => {
    peakQueued = Math.max(peakQueued, control.limiter.waiters.length)
    await delay(2, signal)
    return number === 1 ? { cards: [] } : answer(prompt)
  })
  const cards = Array.from({ length: 120 }, (_, index) => card(`x${index}`))
  const result = await decide(llm, state, cards)
  assert.ok(peakQueued <= 11, `bounded worker pool queued ${peakQueued} requests`)
  const repairIndex = llm.calls.findIndex((prompt, index) => index > 0 && idsOf(prompt).includes('x0'))
  assert.ok(repairIndex > 0 && repairIndex < 12, `repair was call ${repairIndex + 1}`)
  assert.deepEqual(result.record.judgeCoverage, { total: 120, answered: 120, unresolved: 0, scopeSkipped: 0 })
  assert.equal(result.record.error, undefined)
})

test('active duties are checked before unrelated entries during recovery', async () => {
  const state = stateOf()
  const control = state.adaptive.for('judge', decisionRoute(agent, state.config))
  control.size.value = 1
  control.limiter.limit = 1
  control.limiter.max = 1
  const entries = Array.from({ length: 100 }, (_, index) => card(`entry${index}`, { entry: true, skill: `skill${index}` }))
  const loadedEntry = card('loaded_entry', { entry: true, skill: 'loaded' })
  const duty = card('loaded_duty', { skill: 'loaded' })
  const cards = [...entries, loadedEntry, duty]
  const llm = fakeLlm((prompt) => answer(prompt))
  await decide(llm, state, cards, { triggers: ['failed'], activeSkills: new Set(['loaded']),
    graph: { cards, relations: [{ type: 'contains', source: 'loaded_entry', target: 'loaded_duty' }], revision: 'r' } })
  assert.deepEqual(idsOf(llm.calls[0]), ['loaded_duty'])
  assert.equal(llm.calls.length, 102, 'priority changes order, never silently drops candidates')
})

test('a truncated batch keeps answered split cards if a later split exhausts the shared deadline', async () => {
  const state = stateOf()
  const cards = Array.from({ length: 24 }, (_, index) => card(`x${index}`))
  const llm = fakeLlm(async (prompt, signal, number) => {
    if (number === 1) throw Object.assign(new Error('output cut off'), { kind: 'truncated' })
    if (number === 3) await delay(2000, signal)
    return answer(prompt, 'needed')
  })
  const result = await decide(llm, state, cards)
  assert.equal(result.record.splits, 1)
  assert.equal(result.record.judgeCoverage.answered, 12)
  assert.equal(result.record.judgeCoverage.unresolved, 12)
  assert.equal(result.cards.length, 12, 'a late split cannot discard earlier valid answers')
  assert.equal(result.assessments.x0.state, 'needed')
  assert.equal(result.assessments.x23.state, 'unknown')
  assert.equal(state.adaptive.for('judge', decisionRoute(agent, state.config)).size.current, 12, 'only truncation trained a smaller batch')
})

test('repeated budget expiry cannot collapse batch size or concurrency for the next task', async () => {
  const state = stateOf()
  const control = state.adaptive.for('judge', decisionRoute(agent, state.config))
  const cards = Array.from({ length: 130 }, (_, index) => card(`x${index}`))
  const stalled = fakeLlm(async (prompt, signal) => { await delay(2000, signal); return answer(prompt) })
  for (let i = 0; i < 2; i += 1) {
    const result = await decide(stalled, state, cards)
    assert.equal(result.record.judgeCoverage.unresolved, 130)
    assert.equal(control.size.current, 24)
    assert.equal(control.limiter.capacity, 4)
    assert.equal(control.limiter.waiters.length, 0)
  }
  const recovered = await decide(fakeLlm((prompt) => answer(prompt)), state, cards)
  assert.equal(recovered.record.batches, 6)
  assert.equal(recovered.record.judgeCoverage.answered, 130)
})

test('typed protocol blocks are not failed commands, failed checks or loaded skills', () => {
  const ledger = new SessionLedger(agent)
  for (const [id, name, args] of [['check', 'pwsh', { command: 'npm test' }], ['skill', 'skill', { name: 'parser' }]]) {
    ledger.push(eventCall(id, name, args, 1))
    const result = eventResult(id, 'Error: eng-protocol 执行前暂停', 2, true)
    result.data.error = BLOCK_INFO
    ledger.push(result)
  }
  const observed = ledger.observe([])
  assert.equal(observed.triggers.includes('failed'), false)
  assert.equal(observed.triggers.includes('stuck'), false)
  assert.equal(observed.triggers.includes('checked'), false)
  assert.deepEqual(ledger.summary().recent.map((item) => item.status), ['blocked', 'blocked'])
  assert.equal(ledger.summary().checks.length, 0)
  assert.equal(ledger.summary().failures.length, 0)
  assert.equal(ledger.loadedSkills.has('parser'), false)
  assert.equal(ledger.summary().timeline.at(-1).executed, false)
  ledger.push(eventCall('real', 'pwsh', { command: 'npm test' }, 3))
  ledger.push(eventResult('real', 'Error: <eng-protocol> is literal process output', 4, true))
  assert.ok(ledger.observe([]).triggers.includes('failed'), 'text cannot impersonate typed intervention metadata')
  assert.equal(ledger.summary().checks[0].status, 'failed')
})

test('resuming a session retains protocol block identity from durable metadata', () => {
  const result = eventResult('check', 'Error: eng-protocol 执行前暂停', 2, true)
  result.data.error = BLOCK_INFO
  const ledger = new SessionLedger({ session: {
    deriveMessages: () => [{ role: 'assistant', content: [{ type: 'tool-call', id: 'check', name: 'pwsh', arguments: { command: 'npm test' } }] },
      { ...result.data.message, role: 'tool', toolCallId: 'check' }],
    snapshotEvents: () => [result],
  } })
  assert.equal(ledger.summary().recent[0].status, 'blocked')
  assert.deepEqual(ledger.summary().failures, [])
  assert.deepEqual(ledger.summary().checks, [])
})

test('aftermath classifies another protocol intervention without calling it a process error', () => {
  const after = new Aftermath()
  after.watch({ decisionId: 'earlier', sessionId: 's' })
  after.push(eventCall('later', 'pwsh', { command: 'npm test' }, 1))
  const result = eventResult('later', 'Error: eng-protocol 执行前暂停', 2, true)
  result.data.error = BLOCK_INFO
  const [snapshot] = after.push(result)
  assert.equal(snapshot.actions[0].status, 'blocked')
})

test('aftermath reports live immutable progress and background completion rather than launch success', () => {
  const after = new Aftermath()
  after.watch({ decisionId: 'd', sessionId: 's', seq: 5, deliverySeq: 10 })
  assert.deepEqual(after.push(eventCall('old', 'pwsh', { command: 'old action' }, 9)), [])
  const [started] = after.push(eventCall('bg', 'pwsh', { command: 'npm test' }, 11))
  assert.equal(started.ended, 'observing')
  const [handed] = after.push(eventResult('bg', 'started background job bg-1', 12))
  assert.equal(handed.actions[0].status, 'running')
  const [finished] = after.push({ type: 'user/message', seq: 13, data: { source: { kind: 'tool-jobs' }, content: 'background job bg-1 finished [status: completed, exit code: 1].' } })
  assert.equal(finished.actions[0].status, 'error')
  assert.equal(started.actions[0].status, 'running', 'later mutations cannot change an earlier snapshot')
  after.push(eventCall('read', 'read', { path: 'exit-code-example.txt' }, 14))
  const [read] = after.push(eventResult('read', 'documented failure example: [exit code: 1]', 15))
  assert.equal(read.actions.at(-1).status, 'ok', 'text in a read result is not a process exit code')
})

test('job_output settles the original background action and the latest reply remains visible', () => {
  const after = new Aftermath()
  after.watch({ decisionId: 'd', sessionId: 's' })
  after.push(eventCall('bg', 'pwsh', { command: 'npm test' }, 1))
  after.push(eventResult('bg', '[still running after 10ms; moved to background job bg-1]', 2))
  after.push(eventCall('poll', 'job_output', { job_id: 'bg-1' }, 3))
  const [done] = after.push(eventResult('poll', 'All checks passed\n[status: completed, exit code: 0]', 4))
  assert.equal(done.actions[0].status, 'ok')
  after.push({ type: 'assistant/message', seq: 5, data: { message: { content: 'Working on it' } } })
  const [reply] = after.push({ type: 'assistant/message', seq: 6, data: { message: { content: 'Validated and delivered' } } })
  assert.equal(reply.reply, 'Validated and delivered')
})

test('trajectory windows count decisions, and use the newest live aftermath instead of an older snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eng-trail-'))
  try {
    const config = normalizeConfig({ stateDir: root }, root)
    const records = []
    for (let i = 0; i < 405; i += 1) {
      records.push({ kind: 'decision', decisionId: `d${i}`, cwd: root, sessionId: 's' })
      records.push({ kind: 'aftermath', decisionId: `d${i}`, cwd: root, sessionId: 's', actions: [{ callId: 'x', status: 'running' }] })
      records.push({ kind: 'aftermath', decisionId: `d${i}`, cwd: root, sessionId: 's', actions: [{ callId: 'x', status: 'error' }] })
    }
    await writeFile(join(root, 'decisions.jsonl'), records.map((item) => JSON.stringify(item)).join('\n') + '\n')
    const trail = await decisionsPayload({ config }, root, new URLSearchParams({ limit: '200' }), { scope: 'session', sessionId: 's' })
    assert.equal(trail.total, 400)
    assert.equal(trail.items[0].decisionId, 'd404')
    assert.equal(trail.items[0].after.actions[0].status, 'error')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('full evidence is deduplicated, served only in its view, and rejects unsafe storage keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eng-evidence-'))
  try {
    const config = normalizeConfig({ stateDir: root }, root)
    const evidence = { input: { user: 'Detailed text '.repeat(1000) + 'FINAL CONDITION' }, cards: [], references: [] }
    for (let i = 0; i < 2; i += 1) await appendDecision(config, { kind: 'decision', cwd: root, sessionId: 's1', decisionId: `d${i}` }, { evidence })
    const records = await readDecisions(config)
    assert.equal(records[0].evidenceKey, records[1].evidenceKey)
    assert.equal((await readdir(join(root, 'evidence'))).length, 1)
    assert.equal((await loadEvidence(config, records[0].evidenceKey)).input.user, evidence.input.user)
    assert.equal(await loadEvidence(config, '../decisions'), undefined)
    const routes = []
    const state = { config, graphs: new Map([[root, {}]]), agentBySession: new Map(['s1', 's2'].map((id) => [id, { session: { id, header: { cwd: root } } }])) }
    registerDashboard({ inject(_deps, callback) { callback({ webServer: { register(route) { routes.push(route) } }, effect(fn) { return fn() }, on() {} }) } }, state)
    const handler = routes.find((route) => route.path.endsWith('/api/evidence')).handler
    const get = async (sessionId, key) => {
      const res = { statusCode: 0, setHeader() {}, end(text) { this.body = JSON.parse(text) } }
      await handler({ method: 'GET', url: `/eng-protocol/api/evidence?${new URLSearchParams({ sessionId, key })}` }, res)
      return res
    }
    assert.equal((await get('s1', records[0].evidenceKey)).body.evidence.input.user, evidence.input.user)
    assert.equal((await get('s2', records[0].evidenceKey)).statusCode, 404)
    assert.equal((await get('s1', '../decisions')).statusCode, 404)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('log rotation prunes unreferenced evidence while retaining the current snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eng-evidence-gc-'))
  try {
    const config = normalizeConfig({ stateDir: root }, root)
    await appendDecision(config, { kind: 'decision', cwd: root, sessionId: 's' }, { evidence: { input: { user: 'old' } } })
    const [old] = await readDecisions(config)
    await writeFile(join(root, 'decisions.jsonl'), 'x'.repeat(8 * 1024 * 1024 + 1))
    await appendDecision(config, { kind: 'decision', cwd: root, sessionId: 's' }, { evidence: { input: { user: 'current' } } })
    const [current] = await readDecisions(config, { limit: 1 })
    assert.equal(await loadEvidence(config, old.evidenceKey), undefined)
    assert.equal((await loadEvidence(config, current.evidenceKey)).input.user, 'current')
  } finally { await rm(root, { recursive: true, force: true }) }
})
