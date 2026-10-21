import assert from 'node:assert/strict'
import { test } from 'node:test'
import { candidateCards, renderGuidance } from '../lib/cards.js'
import { normalizeConfig, decisionRoute } from '../lib/config.js'
import { evaluateDecision, selectAssessments, evidenceReferences, evidencePayload } from '../lib/decide.js'
import { normalizeSkill } from '../lib/skill-graph.js'
import { parseSkillSource, statementsOf } from '../lib/skill-source.js'
import { edgeKey, normalizeEdgeDecisions, prerequisitesClear } from '../lib/topology.js'
import { AdaptiveRegistry } from '../lib/adaptive.js'
import { createReminderState, selectReminders } from '../lib/reminders.js'

const config = normalizeConfig({ cooldownSteps: 0 })
const needed = { state: 'needed', confidence: 0.9 }
const satisfied = { state: 'satisfied', confidence: 0.9 }
const duty = (id, extra = {}) => ({ id, title: id, skill: 'demo', triggers: ['edit'], rules: [id], grounded: true, quote: `${id} is required.`, ...extra })
const evidence = [{ ref: 'request:1', quote: 'Use one report for both checks; the user waived publishing.' }]
const refs = new Map(evidence.map(item => [item.ref, { text: item.quote }]))
const edgeDecision = (edge, extra = {}) => ({ id: edgeKey(edge), state: 'applies', confidence: 0.95, evidence, ...extra })
const select = (cards, relations, assessments, edgeDecisions = {}) => selectAssessments(assessments, cards, relations, config,
  { step: 1, cooldowns: new Map(), active: new Set(['demo']), edgeDecisions })

test('related duties join a triggered candidate, while unloaded and out-of-scope neighbors stay out', () => {
  const cards = [duty('verify', { skill: undefined }), duty('specific', { triggers: ['settle'] }),
    duty('exception', { triggers: ['settle'] }), duty('unloaded', { skill: 'other', triggers: ['settle'] }),
    duty('sql-only', { triggers: ['settle'], match: { paths: ['**/*.sql'] } })]
  const relations = [
    { type: 'covers', source: 'specific', target: 'verify' },
    { type: 'arbitrates', source: 'exception', target: 'specific' },
    { type: 'fuses', source: 'specific', target: 'unloaded' },
    { type: 'fuses', source: 'specific', target: 'sql-only' },
  ]
  const candidates = candidateCards(cards, { triggers: ['edit'], active: new Set(['demo']), relations, action: { path: 'app.js' } })
  assert.deepEqual(candidates.map(card => card.id), ['verify', 'specific', 'exception'])
})

test('known unmet prerequisites lead; unknown prerequisites neither hide advice nor justify a tool denial', () => {
  const cards = [duty('deploy', { priority: 10 }), duty('backup')]
  const relations = [{ type: 'requires', source: 'backup', target: 'deploy' }]
  assert.deepEqual(select(cards, relations, { deploy: needed, backup: needed }).selected.map(card => card.id), ['backup'])
  const unknown = { deploy: needed, backup: { state: 'unknown', confidence: 0 } }
  assert.deepEqual(select(cards, relations, unknown).selected.map(card => card.id), ['deploy'])
  assert.equal(prerequisitesClear(cards[0], relations, unknown, 0.6), false)
  assert.equal(prerequisitesClear(cards[0], relations, { backup: satisfied }, 0.6), true)
  assert.equal(prerequisitesClear(cards[0], [{ ...relations[0], type: 'blocks' }], { backup: { state: 'inapplicable', confidence: 0.9 } }, 0.6), true)
})

test('a source-backed exception needs current quoted evidence and cannot silence a critical guard', () => {
  const cards = [duty('waiver'), duty('publish')]
  const edge = { type: 'arbitrates', source: 'waiver', target: 'publish', grounded: true }
  const assessments = { waiver: satisfied, publish: needed }
  const decisions = normalizeEdgeDecisions([edgeDecision(edge)], [edge], refs)
  assert.equal(select(cards, [edge], assessments, decisions).selected.length, 0)
  for (const raw of [undefined, [], [edgeDecision(edge, { evidence: [] })], [edgeDecision(edge, { evidence: [{ ref: 'request:9', quote: 'waived' }] })]]) {
    assert.equal(select(cards, [edge], assessments, normalizeEdgeDecisions(raw, [edge], refs)).selected.length, 1)
  }
  assert.equal(select(cards, [{ ...edge, grounded: false }], assessments, decisions).selected.length, 1)
  assert.equal(select([cards[0], { ...cards[1], critical: true }], [edge], assessments, decisions).selected.length, 1)
  assert.equal(select(cards, [edge], { ...assessments, waiver: { state: 'unknown', confidence: 0 } }, decisions).selected.length, 1)
})

test('fusion delivers one actual action but retains both source obligations and independent status', () => {
  const cards = [duty('test'), duty('report')]
  const edge = { type: 'fuses', source: 'test', target: 'report', grounded: true }
  const decisions = normalizeEdgeDecisions([edgeDecision(edge, { action: 'Run the report command once' })], [edge], refs)
  const assessments = { test: needed, report: needed }
  const selected = select(cards, [edge], assessments, decisions).selected
  assert.equal(selected.length, 2)
  const meta = { boundary: 'tool', triggers: ['edit'], relations: [edge], edgeDecisions: decisions, assessments }
  const text = renderGuidance(selected, meta)
  assert.equal([...text.matchAll(/^### /gm)].length, 1)
  assert.match(text, /Run the report command once/)
  cards.forEach(card => assert.ok(text.includes(card.quote)))
  const after = select(cards, [edge], { ...assessments, test: satisfied }, decisions).selected
  assert.deepEqual(after.map(card => card.id), ['report'])
  assert.doesNotMatch(renderGuidance(after, meta), /一起处理/)
  assert.doesNotMatch(renderGuidance(cards, { ...meta, relations: [edge, { type: 'requires', source: 'test', target: 'report' }] }), /一起处理/)
})

test('default delivery keeps every independent needed duty instead of silently clipping at three', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ card: duty(`duty-${i}`), assessment: needed }))
  assert.equal(config.maxRemindersPerStep, null)
  assert.equal(selectReminders(items, createReminderState(), 1, config).selected.length, 12)
})

test('cross-section literal references resolve only from local source support and a unique endpoint', () => {
  const source = { name: 'demo', path: '/skills/demo/SKILL.md', content: '# Backup\nCreate a usable snapshot.\n' + 'background '.repeat(100)
    + '\n## Migration\nBefore running the migration, complete “Create a usable snapshot”.\nRun the migration.\n' + 'details '.repeat(100) }
  const document = parseSkillSource(source, { floor: 100, ceiling: 2000 })
  assert.equal(document.parts.length, 2)
  const parts = document.parts.map(part => ({ part, statements: statementsOf(document, part), records: { obligations: [], relations: [] } }))
  parts[0].records.obligations.push({ id: 'backup', quote: 'Create a usable snapshot.', on: ['command'] })
  parts[1].records.obligations.push({ id: 'migrate', quote: 'Run the migration.', on: ['command'] })
  parts[1].records.relations.push({ rel: 'requires', from: { quote: 'Create a usable snapshot' }, to: 'migrate',
    quote: 'Before running the migration, complete “Create a usable snapshot”.' })
  const graph = normalizeSkill(source, document, parts)
  assert.equal(graph.relations.length, 1)
  assert.equal(graph.relations[0].source, 'skill_demo_backup')
  assert.equal(graph.relations[0].target, 'skill_demo_migrate')
  assert.equal(graph.relations[0].grounded, true)
  assert.equal(graph.relations[0].sourceRef.startLine, 5)
  parts[1].records.relations[0].quote = 'A fabricated instruction to gate migration.'
  assert.equal(normalizeSkill(source, document, parts).relations.length, 0)
})

test('split judgments retain endpoint definitions; conflicting relation answers never suppress advice', async () => {
  const route = { provider: 'mock', model: 'mock' }
  const agent = { options: route, session: { id: 'topology' } }
  const cards = [duty('waiver'), duty('publish')]
  const edge = { type: 'arbitrates', source: 'waiver', target: 'publish', grounded: true, quote: 'Publishing can be waived.' }
  for (const conflict of [false, true]) {
    const state = { config: normalizeConfig({ decision: route }), adaptive: new AdaptiveRegistry() }
    state.adaptive.for('judge', decisionRoute(agent, state.config)).size.value = 1
    const prompts = []
    const llm = { async prepareCall(config) { return { config, async *stream({ messages }) {
      const prompt = messages[0].content[0].text
      prompts.push(prompt)
      const candidates = JSON.parse(prompt.split('CANDIDATE CARDS:\n')[1].split('\n\nCritical cards')[0])
      const neighbors = JSON.parse(prompt.split('RELATED RULES (context only; do not emit extra card assessments):\n')[1].split('\n\nASSESSMENTS')[0])
      assert.equal(neighbors.length, 1)
      assert.ok(neighbors[0].quote && neighbors[0].rules)
      const id = candidates[0].id
      const raw = { cards: [{ id, ...(id === 'waiver' ? satisfied : needed), evidence }],
        relations: [edgeDecision(edge, { state: conflict && id === 'publish' ? 'unknown' : 'applies' })] }
      yield { type: 'text-delta', text: JSON.stringify(raw) }
    } } } }
    const result = await evaluateDecision({ get: () => llm }, state, { agent, cooldowns: new Map() }, {
      boundary: 'tool', triggers: ['edit'], candidates: cards, activeSkills: new Set(['demo']),
      ledger: { taskRequests: [evidence[0].quote] }, graph: { cards, relations: [edge], revision: 'r' },
    })
    assert.equal(prompts.length, 2)
    assert.deepEqual(result.cards.map(card => card.id), conflict ? ['publish'] : [])
    assert.equal(result.record.edgeDecisions[edgeKey(edge)].state, conflict ? 'unknown' : 'applies')
  }
})

test('post-action evidence labels executed intent separately from the actual result and delivered advice', () => {
  const input = evidencePayload({ boundary: 'tool', action: { command: 'npm test' }, outcome: { output: 'Tests passed' },
    previousDeliveries: [{ card: 'verify', reason: 'run a check' }] })
  const references = evidenceReferences(input)
  assert.equal(input.stage, 'after-action')
  assert.equal(references.has('action:proposed'), false)
  assert.equal(references.get('outcome:current').text, 'Tests passed')
  assert.equal([...references.values()].some(item => item.text.includes('run a check')), false)
})
