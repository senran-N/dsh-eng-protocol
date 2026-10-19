import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateQuote, parseSkillSource } from '../lib/skill-source.js'
import { buildGraph, normalizeCompiled, skillPrefix } from '../lib/compiler.js'
import { normalizeConfig } from '../lib/config.js'
import { candidateCards } from '../lib/cards.js'
import { commandMatcher, pathMatcher, pathPatterns } from '../lib/match.js'
import { decisionPrompt, selectAssessments } from '../lib/decide.js'
import { SessionLedger } from '../lib/events.js'
import { callModel } from '../lib/model.js'

const config = normalizeConfig({}, process.cwd())
const skill = { name: 'demo', content: '# Scope\nUse this.\n## Verify\nRun the checks.', path: '/skills/demo/SKILL.md', hash: 'source' }
const card = (id, triggers = ['edit']) => ({ id, title: id, when: 'editing code', triggers, rules: ['Check the actual behavior'], satisfiedWhen: 'applicable checks pass', sourceLines: [3, 4] })
const raw = (cards = [card('verify')], relations = []) => ({ cards, relations })
const needed = { state: 'needed', confidence: 0.9 }
const tracker = () => ({ step: 5, cooldowns: new Map() })

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
    { ...card('Good Card'), entry: true, critical: true, notApplicable: 'no executable change', quote: 'Run the checks.' },
    card('later'),
  ], [{ type: 'requires', source: 'Good Card', target: 'later' }]), skill)
  assert.equal(graph.cards.length, 2)
  assert.equal(graph.cards[0].entry, false)
  assert.equal(graph.cards[0].critical, false)
  assert.equal(graph.cards[0].notApplicable, 'no executable change')
  assert.deepEqual(graph.cards[0].sourceRef, { path: skill.path, startLine: 4, endLine: 4, precise: true, basis: 'verified-quote', quoteVerified: true })
  // Without a quote, the model's line claim is only a fallback position, never proof.
  assert.deepEqual(graph.cards[1].sourceRef, { path: skill.path, startLine: 3, endLine: 4, precise: false, basis: 'model-lines', quoteVerified: false })
  assert.equal(graph.cards[1].grounded, false)
  assert.equal(graph.relations[0].source, graph.cards[0].id, 'raw local ids resolve after normalization')
  assert.ok(graph.warnings.some((warning) => warning.includes('完成证据')))
  assert.throws(() => normalizeCompiled({ cards: 'nope' }, skill), /cards/)
})

test('a quote is found despite whitespace, case, Markdown marks and typographic quotes, never despite paraphrase', () => {
  const body = 'Intro.\n\n- **Always** run `pnpm test`\n  before you push.\nUse the “release” branch.'
  const hit = locateQuote(body, 'always run pnpm test before you push.')
  assert.ok(hit)
  assert.equal(body.slice(hit.start, hit.end), '**Always** run `pnpm test`\n  before you push.')
  assert.ok(locateQuote(body, 'Use the "release" branch.'))
  assert.equal(locateQuote(body, 'Always run the tests before pushing.'), undefined, 'a paraphrase is not a quote')
  assert.equal(locateQuote(body, 'run'), undefined, 'a fragment too short to identify a sentence is not a quote')
})

test('part plans are fixed by the text: an edit late in a skill leaves earlier parts intact', () => {
  const sections = (last) => ['# One', 'a'.repeat(1800), '## Two', 'b'.repeat(1800), '## Three', 'c'.repeat(1800), `## Four\n${last}`].join('\n')
  const plan = (text) => parseSkillSource({ name: 'long', content: text }, 2000).chunks.map((chunk) => chunk.content)
  const first = plan(sections('END'))
  assert.deepEqual(plan(sections('END')), first, 'the same text always yields the same parts')
  const edited = plan(sections('CHANGED AT THE END'))
  assert.deepEqual(edited.slice(0, -1), first.slice(0, -1))
  assert.notDeepEqual(edited.at(-1), first.at(-1))
})

test('file and command predicates follow globs and whole words', () => {
  const sql = pathMatcher(pathPatterns(['**/*.sql']))
  assert.equal(sql('D:\\repo\\db\\001_init.sql'), true)
  assert.equal(sql('src/a.ts'), false)
  const migrations = pathMatcher(['migrations/**'])
  assert.equal(migrations('C:/work/app/migrations/2026/01.py'), true, 'a slash glob matches a trailing run of segments')
  assert.equal(migrations('C:/work/app/notmigrations/01.py'), false)
  assert.equal(pathMatcher(['*.{docx,xlsx}'])('reports/Q3.XLSX'), true, 'a bare glob matches the file name, case-insensitively')
  assert.deepEqual(pathPatterns(['a/{b', 42, 'ok/**']), ['ok/**'], 'malformed globs are dropped')
  const alembic = commandMatcher(['alembic upgrade'])
  assert.equal(alembic('cd api && alembic  upgrade head'), true)
  assert.equal(alembic('alembic-upgrade-helper'), false)
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
