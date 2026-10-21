import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactEvidence } from '../lib/prompt.js'
import { decisionPrompt, evaluateDecision, evidencePayload, evidenceReferences } from '../lib/decide.js'
import { normalizeConfig } from '../lib/config.js'
import { streamModel } from '../lib/model.js'
import { expandEvidence, evidenceOfPrompt } from './helpers/prompt.mjs'

const route = { provider: 'mock', model: 'mock' }
const long = '保留全部上下文，包括引号 "、反斜线 \\ 与换行。\n'.repeat(80) + 'DECISIVE TAIL'
const snapshot = {
  boundary: 'tool', triggers: ['checked'], activeSkills: new Set(),
  ledger: { user: long, taskRequests: [long, '现在只分析，不再修改'], assistant: long,
    timeline: [
      { ref: 'event:1', kind: 'result', callId: 'a', seq: 1, text: long },
      { ref: 'event:2', kind: 'result', callId: 'b', seq: 2, text: long },
    ],
    checks: [{ callId: 'a', status: 'failed', editRevision: 1, summary: long }, { callId: 'b', status: 'passed', editRevision: 2, summary: long }],
    recent: [{ callId: 'b', output: long }], evidenceCoverage: { omittedTimeline: 3 },
  },
}

test('compact evidence preserves all bytes, chronology, amendment and distinct results', () => {
  const original = evidencePayload(snapshot)
  const before = structuredClone(original)
  const compact = compactEvidence(original)
  assert.deepEqual(expandEvidence(compact), original)
  assert.deepEqual(original, before, 'wire packing cannot mutate audit evidence')
  assert.equal(JSON.stringify(compact).split('DECISIVE TAIL').length - 1, 1)
  assert.ok(JSON.stringify(compact).length < JSON.stringify(original).length / 3)
  const sent = evidenceOfPrompt(decisionPrompt(snapshot, []))
  assert.deepEqual(sent, JSON.parse(JSON.stringify(original)))
  assert.equal(sent.checks[0].status, 'failed')
  assert.equal(sent.checks[1].editRevision, 2)
  assert.equal(sent.taskRequests.at(-1), '现在只分析，不再修改')
  assert.deepEqual(evidenceReferences(sent), evidenceReferences(original))
})

test('unique text stays literal and dictionary-like opaque tool data stays unambiguous', () => {
  const unique = { user: long, taskRequests: ['continue'] }
  assert.equal(compactEvidence(unique), unique)
  const opaque = { user: long, taskRequests: [long], outcome: { error: { $text: 't1' } } }
  assert.equal(compactEvidence(opaque), opaque)
  const data = { user: long + '{"$text":"t1"}', taskRequests: [long + '{"$text":"t1"}'] }
  assert.deepEqual(expandEvidence(compactEvidence(data)), data, 'text that resembles protocol syntax remains text')
})

test('real judge path sends compact evidence but validates original source ids and retains full audit evidence', async () => {
  const cards = [{ id: 'verify', title: 'Verify result', rules: ['Verify'], triggers: ['checked'] }]
  let prompt
  const llm = { async prepareCall(config) { return { config, async *stream({ messages }) {
    prompt = messages[0].content[0].text
    yield { type: 'text-delta', text: JSON.stringify({ cards: [{ id: 'verify', state: 'satisfied', confidence: 0.9,
      evidence: [{ ref: 'check:b', quote: 'DECISIVE TAIL' }] }] }) }
  } } } }
  const result = await evaluateDecision({ get: () => llm }, { config: normalizeConfig({ decision: route }) },
    { agent: { options: route }, cooldowns: new Map() }, { ...snapshot, candidates: cards, graph: { cards, relations: [], revision: 'r' } })
  assert.ok(prompt.includes('"_texts"'))
  assert.equal(result.assessments.verify.state, 'satisfied')
  assert.equal(result.record.error, undefined)
  assert.equal(result.evidenceSnapshot.input.checks[1].summary, long)
  assert.equal(result.evidenceSnapshot.references.find(r => r.ref === 'check:b').text, long)
  const timing = result.record.attempts[0]
  for (const key of ['prepareMs', 'firstChunkMs', 'firstTextMs', 'generationMs', 'modelMs', 'outputChars']) assert.equal(typeof timing[key], 'number', key)
})

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
test('timing separates preparation, reasoning and first answer text, including block-only output', async () => {
  let timing
  const llm = { async prepareCall(config) {
    await delay(20)
    return { config, async *stream() {
      await delay(20)
      yield { type: 'reasoning-delta', text: 'thinking' }
      await delay(20)
      yield { type: 'text-delta', text: 'yes' }
      await delay(20)
      yield { type: 'block-end', block: { type: 'text', text: 'yes!' } }
      yield { type: 'block-end', block: { type: 'text', text: 'done' } }
    } }
  } }
  const output = await streamModel(llm, route, { timeoutMs: 1000, onTiming: value => { timing = value } })
  assert.equal(output.text, 'yes!done')
  assert.equal(timing.outputChars, 8)
  assert.ok(timing.prepareMs >= 10)
  assert.ok(timing.firstChunkMs >= timing.prepareMs + 10)
  assert.ok(timing.firstTextMs >= timing.firstChunkMs + 10)
  assert.ok(timing.generationMs >= 10)
})

test('silent cancelled streams report elapsed work without inventing a first answer', async () => {
  const controller = new AbortController()
  let timing
  const llm = { async prepareCall(config) { return { config, async *stream() {
    yield { type: 'reasoning-delta', text: 'thinking' }
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await new Promise(() => {})
  } } } }
  await assert.rejects(streamModel(llm, route, { timeoutMs: 1000, signal: controller.signal, onTiming: value => { timing = value } }), /cancelled/)
  assert.equal(typeof timing.firstChunkMs, 'number')
  assert.equal(timing.firstTextMs, undefined)
  assert.equal(timing.generationMs, undefined)
  assert.equal(timing.outputChars, 0)
  assert.equal(typeof timing.modelMs, 'number')
})
