import assert from 'node:assert/strict'
import { test } from 'node:test'
import { actionExcerpt, classifyTool, SessionLedger } from '../lib/events.js'
import { decisionPrompt, normalizeAssessments, selectAssessments } from '../lib/decide.js'
import { entryCard, normalizeCompiled } from '../lib/compiler.js'
import { renderGuidance, renderStanding } from '../lib/cards.js'
import { classifyError, withRetry } from '../lib/adaptive.js'
import { aggregate } from '../lib/store.js'

const long = (tail) => 'Detailed evidence.\n'.repeat(300) + tail
const ledgerOf = (messages = []) => new SessionLedger({ session: { deriveMessages: () => messages } })
const user = (content) => ({ role: 'user', source: { kind: 'user' }, content })
const evidenceOf = (ledger, action) => JSON.parse(decisionPrompt({ ledger: ledger.summary(), action }, []).split('CURRENT EVIDENCE:\n')[1].split('\n\nCANDIDATE CARDS:')[0])
const result = (callId, content) => ({ type: 'tool/result', data: { message: { source: { callId }, content } } })

test('live decision evidence preserves long instructions, report tails and tool conclusions', () => {
  const ledger = ledgerOf()
  const request = long('REQUIRE ROLLBACK INSTRUCTIONS')
  const report = long('ROLLBACK PROVIDED AND VERIFIED')
  const output = long('CHECK CONCLUSION AT END')
  ledger.observe([user(request)])
  ledger.push({ type: 'assistant/message', data: { message: { content: report } } })
  ledger.push({ type: 'tool/call', data: { callId: 'test', name: 'pwsh', arguments: { command: 'npm test' } } })
  ledger.push(result('test', output))
  ledger.observe([])
  const evidence = evidenceOf(ledger)
  assert.equal(evidence.user, request)
  assert.equal(evidence.lastAssistant, report)
  assert.equal(evidence.recentTools[0].output, output)
  assert.equal(evidence.checks[0].summary, output)
  assert.equal(evidence.recentTools[0].callId, 'test')
})

test('resumed sessions and continuation turns preserve ordered user constraints without duplicate copies', () => {
  const request = long('Provide a rollback plan')
  const ledger = ledgerOf([user(request), { role: 'assistant', content: long('Report at end') }])
  ledger.push({ type: 'user/message', data: { source: { kind: 'user' }, content: '继续' } })
  ledger.observe([user('继续')])
  let evidence = evidenceOf(ledger)
  assert.deepEqual(evidence.taskRequests, [request, '继续'])
  assert.equal(evidence.user, '继续')
  assert.equal(evidence.lastAssistant, long('Report at end'))
  ledger.observe([user('改为只写文档，无需改数据库')])
  evidence = evidenceOf(ledger)
  assert.equal(evidence.taskRequests.at(-1), '改为只写文档，无需改数据库')
})

test('proposed edits retain every edit and the full command through the judge boundary', () => {
  const edits = Array.from({ length: 7 }, (_, index) => ({ old_string: `old-${index}`, new_string: long(`edit-${index}-tail`) }))
  const action = classifyTool('multiedit', { path: 'src/app.js', edits })
  action.excerpt = actionExcerpt(action)
  const evidence = evidenceOf(ledgerOf(), action)
  for (let index = 0; index < edits.length; index += 1) assert.ok(evidence.action.excerpt.includes(edits[index].new_string))
  const command = long('git push origin main')
  const shell = classifyTool('pwsh', { command })
  shell.excerpt = actionExcerpt(shell)
  const shellEvidence = evidenceOf(ledgerOf(), shell)
  assert.equal(shellEvidence.action.command, command)
  assert.equal(shellEvidence.action.excerpt, command)
})

test('bursty event queues are drained losslessly and omitted history is explicitly counted', () => {
  const ledger = ledgerOf()
  for (let i = 0; i < 150; i += 1) {
    ledger.push({ type: 'tool/call', data: { callId: String(i), name: 'pwsh', arguments: { command: 'npm test' } } })
    ledger.push(result(String(i), long(`conclusion-${i}`)))
  }
  const observed = ledger.observe([])
  assert.equal(ledger.eventsSeen, 300)
  const evidence = evidenceOf(ledger)
  assert.equal(evidence.evidenceCoverage.omittedTools, 142)
  assert.equal(evidence.evidenceCoverage.omittedChecks, 144)
  assert.equal(evidence.recentTools.length, 8)
  assert.equal(evidence.recentTools.at(-1).output, long('conclusion-149'))
  assert.equal(observed.ledger.responseSeq, 150)
})

test('long failure and background completion details survive evidence collection', () => {
  const ledger = ledgerOf()
  ledger.push({ type: 'tool/call', data: { callId: 'bg', name: 'pwsh', arguments: { command: 'npm test' } } })
  ledger.push(result('bg', 'started background job job-1'))
  ledger.observe([])
  const output = long('failure cause at end\n[status: completed, exit code: 1]')
  ledger.settleJob('job-1', output, new Set())
  const evidence = evidenceOf(ledger)
  assert.equal(evidence.checks[0].summary, output)
  assert.equal(evidence.checks[0].status, 'failed')
  assert.equal(evidence.failures[0].summary, output)
})

test('skill scope, grounding, reminders and standing context retain conditions beyond old limits', () => {
  const condition = long('Except when the user explicitly waives this check.')
  const entry = entryCard({ name: 'demo', description: condition, whenToUse: condition })
  assert.ok(entry.when.includes(condition))
  const loadAdvice = renderGuidance([entry], { boundary: 'request', triggers: ['turn'] })
  assert.match(loadAdvice, /加载 skill：demo/)
  assert.ok(!loadAdvice.includes(condition), 'load advice points to the full native skill instead of repeating its catalog description')
  const quotes = Array.from({ length: 9 }, (_, index) => `Requirement ${index}: ${condition}`)
  const skill = { name: 'demo', content: quotes.join('\n'), path: '/skills/demo/SKILL.md', hash: 'long' }
  const compiled = normalizeCompiled({ cards: quotes.map((quote, index) => ({ id: `r${index}`, title: `r${index}`, quote, when: 'editing', triggers: ['edit'], rules: ['Perform the required check'], satisfiedWhen: 'check completed' })), relations: [] }, skill)
  assert.equal(compiled.cards.length, 9)
  assert.ok(compiled.cards.every((card) => card.grounded))
  const standing = renderStanding([compiled])
  const guidance = renderGuidance(compiled.cards, { boundary: 'tool', triggers: ['edit'] })
  for (const quote of quotes) {
    assert.ok(standing.includes(quote))
    assert.ok(guidance.includes(quote))
  }
})

test('missing or invalid confidence cannot fabricate a needed reminder or a completion', () => {
  const candidates = [{ id: 'x', rules: [], triggers: ['edit'] }]
  for (const confidence of [undefined, null, '0.9', NaN, Infinity, -0.1, 1.1]) {
    const assessments = normalizeAssessments({ cards: [{ id: 'x', state: 'needed', confidence }] }, candidates)
    assert.equal(assessments.x.state, 'unknown')
    assert.equal(assessments.x.confidence, 0)
    assert.equal(selectAssessments(assessments, candidates, [], { minConfidence: 0.6, cooldownSteps: 0 }, { cooldowns: new Map() }).selected.length, 0)
  }
  assert.equal(normalizeAssessments({ cards: [{ id: 'x', state: 'invented', confidence: 0.9 }] }, candidates).x.state, 'unknown')
  assert.equal(normalizeAssessments({ cards: [{ id: 'x', state: 'needed', confidence: 0.9 }] }, candidates).x.confidence, 0.9)
})

const delivered = { kind: 'decision', sessionId: 's', injected: true, delivery: 'delivered', turn: 1, selected: ['x'], evidenceSeq: 2, responseSeq: 1, deliveryEvidenceSeq: 2, deliveryResponseSeq: 1, minConfidence: 0.8, deliveredAt: '2026-10-19T00:00:02Z' }
const judged = (state, confidence = 0.9, extra = {}) => ({ kind: 'decision', sessionId: 's', turn: 1, evidenceSeq: 3, responseSeq: 2, judgedAt: '2026-10-19T00:00:03Z', assessments: { x: { state, confidence } }, ...extra })

test('timestamps or evidence without subsequent model behavior cannot inflate completion', () => {
  for (const extra of [{ evidenceSeq: 2, responseSeq: 1 }, { responseSeq: 1 }, { evidenceSeq: 2 }, { judgedAt: '2026-10-19T00:00:01Z' }]) {
    const totals = aggregate([delivered, judged('satisfied', 0.9, extra)])
    assert.equal(totals.followUp.live.resolved, 0)
    assert.equal(totals.followUp.pending, 1)
  }
})

test('addressing and inapplicable remain distinct from satisfied for live and shadow deliveries', () => {
  for (const start of [delivered, { ...delivered, injected: false, shadow: true, wouldInject: true }]) {
    const mode = start.shadow ? 'shadow' : 'live'
    const progress = aggregate([start, judged('addressing')]).followUp
    assert.equal(progress[mode].addressing, 1)
    assert.equal(progress[mode].resolved, 0)
    const skipped = aggregate([start, judged('inapplicable')]).followUp
    assert.equal(skipped[mode].inapplicable, 1)
    assert.equal(skipped[mode].resolved, 0)
    const finished = aggregate([start, judged('addressing'), judged('satisfied', 0.9, { evidenceSeq: 4, responseSeq: 3 })]).followUp
    assert.equal(finished[mode].resolved, 1)
    assert.equal(finished[mode].addressing, 0)
  }
})

test('low or missing confidence and a different turn cannot be credited as completion', () => {
  for (const confidence of [0.7, null, '0.9', 1.1]) {
    const totals = aggregate([delivered, judged('satisfied', confidence)]).followUp
    assert.equal(totals.live.resolved, 0)
    assert.equal(totals.unknown, 1)
  }
  const missing = judged('satisfied')
  delete missing.assessments.x.confidence
  assert.equal(aggregate([delivered, missing]).followUp.unknown, 1)
  const laterTask = aggregate([delivered, judged('satisfied', 0.9, { turn: 2 })]).followUp
  assert.equal(laterTask.expired, 1)
  assert.equal(laterTask.live.resolved, 0)
})

test('provider input capacity errors are distinct and do not retry the same oversized prompt', async () => {
  let calls = 0
  const error = Object.assign(new Error('maximum context length exceeded; reduce max_tokens or input tokens'), { status: 400, code: 'context_length_exceeded' })
  assert.equal(classifyError(error).kind, 'context-limit')
  assert.equal(classifyError(error).retryable, false)
  await assert.rejects(withRetry(async () => { calls += 1; throw error }, { attempts: 3, baseMs: 0 }), /context length/)
  assert.equal(calls, 1)
})
