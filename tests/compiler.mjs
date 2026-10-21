import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateQuote, parseSkillSource, quoteOf, renderStatements, statementsOf } from '../lib/skill-source.js'
import { buildGraph, normalizeCompiled, skillPrefix } from '../lib/compiler.js'
import { normalizeConfig } from '../lib/config.js'
import { candidateCards } from '../lib/cards.js'
import { commandMatcher, pathMatcher, pathPatterns } from '../lib/match.js'
import { decisionPrompt, selectAssessments } from '../lib/decide.js'
import { SessionLedger } from '../lib/events.js'
import { callModel } from '../lib/model.js'

const config = normalizeConfig({}, process.cwd())
// Statements: [1] # Scope  [2] Use this.  [3] ## Verify  [4] Run the checks.
const skill = { name: 'demo', content: '# Scope\nUse this.\n## Verify\nRun the checks.', path: '/skills/demo/SKILL.md' }
const card = (id, triggers = ['edit'], s = [4, 4]) => ({ id, title: id, when: 'editing code', triggers, rules: ['Check the actual behavior'], satisfiedWhen: 'applicable checks pass', s })
const raw = (cards = [card('verify')], relations = []) => ({ cards, relations })
const needed = { state: 'needed', confidence: 0.9 }
const tracker = () => ({ step: 5, cooldowns: new Map() })
const BOM = String.fromCharCode(0xFEFF)

test('Markdown indexing ignores fenced headings and covers every character with parts', () => {
  const content = BOM + '# Scope\r\n```md\r\n# Not a section\r\n```\r\nDetails\r\n-------\r\n[guide](references/guide.md)\r\n' + 'x '.repeat(2400) + '\r\n## Final\r\nDo not skip this.'
  const parsed = parseSkillSource({ content, name: 'long' }, { floor: 500, ceiling: 2000 })
  assert.deepEqual(parsed.headings.map((heading) => heading.title), ['Scope', 'Details', 'Final'])
  assert.equal(parsed.references[0].target, 'references/guide.md')
  assert.equal(parsed.parts.map((part) => part.content).join(''), parsed.content)
  assert.ok(parsed.parts.every((part) => part.content.length <= 2000))
  assert.match(parsed.parts.at(-1).content, /Do not skip this/)
  assert.equal(parsed.breadcrumb(parsed.content.indexOf('Do not skip')), 'Scope › Final')
  assert.throws(() => parseSkillSource({ name: 'empty', content: '  ' }), /正文为空/)
})

test('statements number headings, items, rows, code and sentences, and quote back exactly', () => {
  const content = ['# Rules', '- **Always** take a snapshot before running a migration.', '- Never edit an applied migration.', '  Add a new one instead.', '',
    '在迁移之前必须备份。然后再执行！ See e.g. the guide. Use v1.2. Then deploy.', '| a | b |', '|---|---|', '| 1 | 2 |', '```sh', 'alembic upgrade head', '```'].join('\n')
  const document = parseSkillSource({ name: 'x', content })
  const statements = statementsOf(document, document.parts[0])
  assert.deepEqual(statements.map((statement) => statement.kind), ['heading', 'item', 'item', 'text', 'text', 'text', 'text', 'text', 'row', 'row', 'code'])
  const rendered = renderStatements(document, statements)
  assert.match(rendered, /^\[1\] # Rules$/m)
  assert.match(rendered, /^\[6\] See e\.g\. the guide\.$/m, 'an abbreviation does not end a sentence')
  const quote = quoteOf(document, statements, 2, 2)
  assert.equal(quote.quote, '**Always** take a snapshot before running a migration.', 'list markers are dropped, emphasis is kept')
  assert.deepEqual([quote.startLine, quote.endLine], [2, 2])
  assert.equal(quoteOf(document, statements, 3, 3).quote, 'Never edit an applied migration.\n  Add a new one instead.')
  assert.equal(quoteOf(document, statements, 1, 2).quote, quote.quote, 'a heading that only introduces the cited text is left out')
  assert.equal(quoteOf(document, statements, 4, 4).quote, '在迁移之前必须备份。')
  assert.equal(quoteOf(document, statements, 99, 99), undefined)
})

test('stable identities distinguish punctuation, mixed scripts and case', () => {
  const names = ['web-ui', 'web_ui', 'Web-UI', 'web/界面', 'web/文档', '界面']
  assert.equal(new Set(names.map(skillPrefix)).size, names.length)
  assert.equal(skillPrefix('web-ui'), 'skill_web_ui')
})

test('normalization grounds every card, fills what the model left out, and never copies hostile flags', () => {
  const graph = normalizeCompiled(raw([
    { id: 'no-source', title: 'x', triggers: ['edit'] },
    { ...card('Good Card'), entry: true, critical: true, notApplicable: 'no executable change' },
    { id: 'later', s: '2', title: 'Use it' },
    { id: 'wide', s: [1, 9] },
  ], [{ type: 'requires', source: 'Good Card', target: 'later' }]), skill)
  assert.deepEqual(graph.cards.map((item) => item.id), ['skill_demo_good_card', 'skill_demo_later'])
  assert.equal(graph.cards[0].entry, false)
  assert.equal(graph.cards[0].critical, false)
  assert.equal(graph.cards[0].notApplicable, 'no executable change')
  assert.deepEqual(graph.cards[0].sourceRef, { path: skill.path, startLine: 4, endLine: 4, precise: true, basis: 'statement', quoteVerified: true })
  assert.equal(graph.cards[0].source, '/skills/demo/SKILL.md#body:L4-L4')
  // An obligation without moments or completion evidence is kept, with defaults.
  const later = graph.cards[1]
  assert.equal(later.quote, 'Use this.')
  assert.deepEqual(later.triggers, ['turn', 'settle'])
  assert.equal(later.satisfiedWhen, undefined)
  assert.equal(later.when, 'Scope', 'the section is the default context')
  assert.equal(graph.relations[0].source, graph.cards[0].id, 'raw local ids resolve after normalization')
  assert.deepEqual(graph.diagnostics.filter((item) => ['no-source', 'too-broad'].includes(item.code)).map((item) => item.id), ['no-source', 'wide'])
  assert.equal(graph.coverage.dropped, 2)
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

test('parts follow the sections: an edit anywhere leaves every other part intact', () => {
  const sections = (first, last) => ['# Title', `## One\n${first}`, `## Two\n${'b'.repeat(2500)}`, `## Three\n${'c'.repeat(2500)}`, `## Four\n${last}`].join('\n')
  const plan = (text) => parseSkillSource({ name: 'long', content: text }).parts.map((part) => part.content)
  const original = plan(sections('a'.repeat(2500), 'd'.repeat(2500)))
  assert.equal(original.length, 4, 'the title joins the first section; each section is one part')
  assert.deepEqual(plan(sections('a'.repeat(2500), 'd'.repeat(2500))), original, 'the same text always yields the same parts')
  const lateEdit = plan(sections('a'.repeat(2500), `${'d'.repeat(2500)} CHANGED`))
  assert.deepEqual(lateEdit.slice(0, -1), original.slice(0, -1))
  const earlyEdit = plan(sections(`CHANGED ${'a'.repeat(3000)}`, 'd'.repeat(2500)))
  assert.deepEqual(earlyEdit.slice(1), original.slice(1), 'an edit at the start does not shift later parts')
  // A section too long for one part is cut at its own sub-headings first.
  const long = parseSkillSource({ name: 'long', content: ['# T', '## Big', '### A', 'a'.repeat(6000), '### B', 'b'.repeat(6000), '## Small', 's'.repeat(2500)].join('\n') })
  assert.deepEqual(long.parts.map((part) => part.section), ['T', 'T › Big › B', 'T › Small'])
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
  const graph = normalizeCompiled(raw([card('a', ['edit'], [2, 2]), card('b')], [
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
  const graph = normalizeCompiled(raw([card('read', ['read'], [2, 2]), card('ship', ['settle'])], [
    { type: 'requires', source: 'read', target: 'ship' },
  ]), skill, config)
  const merged = buildGraph('/project', new Map([['demo', graph]]))
  const candidates = candidateCards(merged.cards, { triggers: ['settle'], active: new Set(['demo']), relations: merged.relations }).filter((item) => item.skill)
  assert.deepEqual(candidates.map((item) => item.id), ['skill_demo_entry', 'skill_demo_read', 'skill_demo_ship'])
  const states = { skill_demo_read: { state: 'satisfied', confidence: 0.9 }, skill_demo_ship: needed }
  assert.deepEqual(selectAssessments(states, candidates, merged.relations, config, tracker()).selected.map((item) => item.id), ['skill_demo_ship'])
  states.skill_demo_read.confidence = 0.1
  assert.equal(selectAssessments(states, candidates, merged.relations, config, tracker()).selected.length, 1, 'unknown prerequisites do not hide a known unmet duty')
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
