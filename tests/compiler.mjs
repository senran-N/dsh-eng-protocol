import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSkillSource } from '../lib/skill-source.js'
import { buildGraph, compileSkill, normalizeCompiled, refreshSkills, skillPrefix } from '../lib/compiler.js'
import { normalizeConfig } from '../lib/config.js'
import { candidateCards } from '../lib/cards.js'
import { decisionPrompt, selectAssessments } from '../lib/decide.js'
import { SessionLedger } from '../lib/events.js'
import { cachePath } from '../lib/store.js'
import { callModel } from '../lib/model.js'

const config = normalizeConfig({}, process.cwd())
const skill = { name: 'demo', content: '# Scope\nUse this.\n## Verify\nRun the checks.', path: '/skills/demo/SKILL.md', hash: 'source' }
const card = (id, triggers = ['edit']) => ({ id, title: id, when: 'editing code', triggers, rules: ['Check the actual behavior'], satisfiedWhen: 'applicable checks pass', sourceLines: [3, 4] })
const raw = (cards = [card('verify')], relations = []) => ({ entry: { when: 'code changes', notApplicable: 'documentation only', points: ['read first', 'verify changes'] }, cards, relations })
const needed = { state: 'needed', confidence: 0.9 }
const tracker = () => ({ decisionTick: 5, cooldowns: new Map() })

test('Markdown indexing ignores fenced headings and chunks all characters without loss', () => {
  const content = '\uFEFF# Scope\r\n```md\r\n# Not a section\r\n```\r\nDetails\r\n-------\r\n[guide](references/guide.md)\r\n' + 'x'.repeat(4500) + '\r\n## Final\r\nDo not skip this.'
  const parsed = parseSkillSource({ content, name: 'long' }, 2000)
  assert.deepEqual(parsed.headings.map((heading) => heading.title), ['Scope', 'Details', 'Final'])
  assert.equal(parsed.references[0].target, 'references/guide.md')
  assert.equal(parsed.chunks.map((chunk) => chunk.content).join(''), parsed.content)
  assert.ok(parsed.chunks.every((chunk) => chunk.content.length <= 2000))
  assert.match(parsed.chunks.at(-1).content, /Do not skip this/)
  assert.throws(() => parseSkillSource({ name: 'empty', content: '  ' }), /正文为空/)
})

test('stable identities distinguish punctuation, mixed scripts and case', () => {
  const names = ['web-ui', 'web_ui', 'Web-UI', 'web/界面', 'web/文档', '界面']
  assert.equal(new Set(names.map(skillPrefix)).size, names.length)
  assert.equal(skillPrefix('web-ui'), 'skill_web_ui')
})

test('normalization preserves source and boundaries, rejects invalid obligations and hostile flags', () => {
  const graph = normalizeCompiled(raw([
    { ...card('broken'), satisfiedWhen: '' },
    { ...card('Good Card'), entry: true, critical: true, notApplicable: 'no executable change' },
    card('later'),
  ], [{ type: 'requires', source: 'Good Card', target: 'later' }]), skill, config)
  assert.equal(graph.cards.length, 2)
  assert.equal(graph.cards[0].entry, false)
  assert.equal(graph.cards[0].critical, false)
  assert.equal(graph.cards[0].notApplicable, 'no executable change')
  assert.deepEqual(graph.cards[0].sourceRef, { path: skill.path, startLine: 3, endLine: 4, precise: false, basis: 'model-lines', lineMode: 'absolute', supportVerified: false, claimedLines: [3, 4] })
  assert.equal(graph.relations[0].source, graph.cards[0].id, 'raw local ids resolve after normalization')
  assert.ok(graph.warnings.some((warning) => warning.includes('完成证据')))
})

test('topology rejects cycles, external prerequisites and duplicate edges; membership is explicit', () => {
  const graph = normalizeCompiled(raw([card('a'), card('b')], [
    { type: 'requires', source: 'a', target: 'b' },
    { type: 'requires', source: 'a', target: 'b' },
    { type: 'blocks', source: 'b', target: 'a' },
    { type: 'requires', source: 'halt', target: 'a' },
    { type: 'requires', source: 'entry', target: 'a' },
  ]), skill, config)
  assert.equal(graph.relations.length, 1)
  const merged = buildGraph('/project', new Map([['demo', graph]]))
  assert.equal(merged.relations.filter((edge) => edge.type === 'contains').length, 2)
  const changed = structuredClone(graph)
  changed.cards[0].rules = ['A different obligation']
  assert.notEqual(buildGraph('/project', new Map([['demo', changed]])).revision, merged.revision)
  const other = normalizeCompiled(raw(), { ...skill, name: 'other' }, config)
  assert.equal(buildGraph('/project', new Map([['demo', graph], ['other', other]])).revision,
    buildGraph('/project', new Map([['other', other], ['demo', graph]])).revision)
})

test('candidate closure judges prerequisites even when only the dependent event fires', () => {
  const graph = normalizeCompiled(raw([card('read', ['read']), card('ship', ['settle'])], [
    { type: 'requires', source: 'read', target: 'ship' },
  ]), skill, config)
  const merged = buildGraph('/project', new Map([['demo', graph]]))
  const candidates = candidateCards(merged.cards, { triggers: ['settle'], active: new Set(['demo']), relations: merged.relations }).filter((item) => item.skill)
  assert.deepEqual(candidates.map((item) => item.id), ['skill_demo_read', 'skill_demo_ship'])
  const states = { skill_demo_read: { state: 'satisfied', confidence: 0.9 }, skill_demo_ship: needed }
  assert.deepEqual(selectAssessments(states, candidates, merged.relations, config, tracker()).selected.map((item) => item.id), ['skill_demo_ship'])
  states.skill_demo_read.confidence = 0.1
  assert.equal(selectAssessments(states, candidates, merged.relations, config, tracker()).selected.length, 0)
  const prompt = decisionPrompt({ graph: merged, ledger: {}, triggers: ['settle'] }, candidates)
  assert.match(prompt, /Check the actual behavior/)
  assert.match(prompt, /requires/)
})

test('covers suppresses only when a qualified covering reminder is selected', () => {
  const cards = [{ id: 'domain', priority: 2 }, { id: 'verify', priority: 2 }]
  const relations = [{ type: 'covers', source: 'domain', target: 'verify' }]
  const states = { domain: { ...needed, confidence: 0.1 }, verify: needed }
  assert.deepEqual(selectAssessments(states, cards, relations, config, tracker()).selected.map((item) => item.id), ['verify'])
  states.domain = needed
  const cooling = tracker()
  cooling.cooldowns.set('domain', 4)
  assert.deepEqual(selectAssessments(states, cards, relations, config, cooling).selected.map((item) => item.id), ['verify'])
  assert.deepEqual(selectAssessments(states, cards, relations, config, tracker()).selected.map((item) => item.id), ['domain'])
  cards[1].critical = true
  assert.ok(selectAssessments(states, cards, relations, config, tracker()).selected.some((item) => item.id === 'verify'))
})

test('check evidence carries the edit revision at start, including later concurrent edits', () => {
  const ledger = new SessionLedger({ session: { deriveMessages: () => [] } })
  const call = (id, name, args) => ledger.push({ type: 'tool/call', data: { callId: id, name, arguments: args } })
  const done = (id) => ledger.push({ type: 'tool/result', data: { message: { source: { callId: id }, content: 'ok' } } })
  call('edit1', 'write', { path: 'src/a.js' }); done('edit1')
  call('check', 'pwsh', { command: 'npm test' })
  call('edit2', 'write', { path: 'src/b.js' }); done('edit2'); done('check')
  ledger.observe()
  assert.equal(ledger.summary().editRevision, 2)
  assert.equal(ledger.summary().checks.at(-1).editRevision, 1)
})

test('cancellation releases the caller even if a provider ignores its signal', async () => {
  const controller = new AbortController()
  const stalled = { prepareCall: () => new Promise(() => {}) }
  const pending = callModel(stalled, { provider: 'mock', model: 'mock' }, { prompt: 'x', signal: controller.signal })
  controller.abort(new Error('cancelled by next turn'))
  await assert.rejects(pending, /cancelled by next turn/)
})
