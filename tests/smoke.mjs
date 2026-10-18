import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILTIN_CARDS, candidateCards, renderGuidance, triggeredCards } from '../lib/cards.js'
import { normalizeCompiled, buildGraph, slug } from '../lib/compiler.js'
import { DEFAULT_CONFIG, loadProjectConfig, normalizeConfig, resolveConfig } from '../lib/config.js'
import { applyPresets, criticalPreset, decisionSystem, normalizeAssessments, selectAssessments } from '../lib/decide.js'
import { SessionLedger, actionTriggers, classifyTool, isCheckCommand } from '../lib/events.js'
import { aggregate, readDecisions } from '../lib/store.js'
import { decisionsPayload, registerDashboard, statsPayload } from '../lib/dashboard.js'

// Never read the developer's real `$DSH_HOME/eng-protocol.json`.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dsh-eng-protocol-home-'))

const checks = []
function test(name, fn) { checks.push({ name, fn }) }

test('config normalizes defaults and rejects invalid values', () => {
  const config = normalizeConfig({ maxCards: 99, minConfidence: 'x', dashboard: { path: 'nope' }, skills: null }, process.cwd())
  // Budget knobs are retired: accepted, removed, and reported — never an error.
  assert.equal(config.maxCards, undefined)
  assert.deepEqual(config.deprecated, ['maxCards'])
  assert.equal(config.minConfidence, 0)
  assert.equal(config.dashboard.path, '/eng-protocol')
  assert.equal(config.skills.enabled, true)
  assert.ok(config.errors.length >= 3)
})

test('built-in cards have valid triggers and ids', () => {
  assert.ok(BUILTIN_CARDS.length >= 12)
  for (const card of BUILTIN_CARDS) {
    assert.ok(card.id && card.title && card.when)
    assert.ok(card.rules.length > 0)
    assert.ok(card.triggers.length > 0)
    for (const trigger of card.triggers) assert.ok(trigger)
  }
})

test('classifyTool distinguishes edit, check and risky commands', () => {
  assert.equal(classifyTool('write', { path: 'src/a.ts', content: 'x' }).kind, 'edit')
  assert.equal(classifyTool('write', { path: 'src/a.test.ts', content: 'x' }).isTest, true)
  assert.equal(classifyTool('pwsh', { command: 'pnpm test' }).isCheck, true)
  assert.equal(classifyTool('pwsh', { command: 'git push origin main' }).isRisky, true)
  assert.equal(classifyTool('read', { path: 'package.json' }).isDependency, true)
  assert.equal(classifyTool('unknown_tool', {}).kind, 'other')
  assert.deepEqual(actionTriggers(classifyTool('write', { path: 'src/a.test.ts' }), 1), ['edit', 'test_edit'])
})

test('compiled skill graph is validated and linked to built-ins', () => {
  const skill = { name: 'android-ui', description: 'Android UI', path: 'C:/skills/android-ui/SKILL.md', hash: 'abc', content: '# UI\nUse Material.' }
  const graph = normalizeCompiled({
    entry: { title: 'Android UI', when: 'Android screen work', notApplicable: 'Flutter work', points: ['Use Material 3', 'Check both themes'] },
    cards: [
      { id: 'layout', title: 'Layout constraints', when: 'editing layout XML', triggers: ['edit'], satisfiedWhen: 'layout builds', rules: ['Prefer ConstraintLayout'], source: 'SKILL.md#Layout' },
      { id: 'a11y', title: 'Accessibility', when: 'adding interactive controls', triggers: ['edit', 'settle'], satisfiedWhen: 'content descriptions exist', rules: ['Add contentDescription'], source: 'SKILL.md#A11y' },
    ],
    relations: [
      { type: 'requires', source: 'layout', target: 'a11y', reason: 'layout first' },
      { type: 'covers', source: 'a11y', target: 'verify', reason: 'same check' },
    ],
  }, skill, normalizeConfig({}, process.cwd()))
  assert.equal(graph.entry.id, `skill_${slug('android-ui')}_entry`)
  assert.equal(graph.cards.length, 2)
  assert.ok(graph.relations.some((edge) => edge.type === 'covers' && edge.target === 'verify'))
  const merged = buildGraph('C:/project', new Map([['android-ui', graph]]))
  assert.ok(merged.cards.length > BUILTIN_CARDS.length)
  assert.ok(merged.relations.length >= 1)
  assert.ok(triggeredCards(merged.cards, ['edit']).length > 0)
})

test('critical preset catches destructive commands and test weakening', () => {
  const command = (text) => ({ action: classifyTool('pwsh', { command: text }), ledger: { checks: [] } })
  assert.equal(criticalPreset(command('git clean -f')).halt.state, 'needed')
  assert.equal(criticalPreset(command('git push --dry-run')).halt, undefined)
  assert.equal(criticalPreset(command('Remove-Item build -Recurse -WhatIf')).halt, undefined)
  // Sensitive but reversible: the judge decides, no local floor.
  assert.equal(criticalPreset(command('git commit -m wip')).halt, undefined)
  const weakening = criticalPreset({ action: { kind: 'edit', isTest: true }, ledger: { checks: [{ status: 'failed' }] } })
  assert.equal(weakening.anti_reward_hacking.state, 'needed')
  const afterGreen = criticalPreset({ action: { kind: 'edit', isTest: true }, ledger: { checks: [{ status: 'failed' }, { status: 'passed' }] } })
  assert.equal(afterGreen.anti_reward_hacking, undefined)
})

test('a preset is a floor: only a confident clearance from the judge lifts it', () => {
  const preset = { halt: { state: 'needed', confidence: 1, reason: 'local' } }
  const confident = { halt: { state: 'satisfied', confidence: 0.95, reason: 'user asked to push' } }
  assert.deepEqual(applyPresets(confident, preset, 0.6), ['halt'])
  assert.equal(confident.halt.state, 'satisfied')
  const unsure = { halt: { state: 'satisfied', confidence: 0.6 } }
  assert.deepEqual(applyPresets(unsure, preset, 0.6), [])
  assert.equal(unsure.halt.state, 'needed')
  const unknown = { halt: { state: 'unknown', confidence: 0.9 } }
  applyPresets(unknown, preset, 0.6)
  assert.equal(unknown.halt.state, 'needed')
  // A preset for a card that is not a candidate changes nothing.
  const absent = {}
  assert.deepEqual(applyPresets(absent, preset, 0.6), [])
  assert.deepEqual(absent, {})
})

test('destructive commands are recognized in POSIX, PowerShell and cmd forms', () => {
  const destructive = [
    'rm -rf build', 'rm -fr build', 'rm -r -f build', 'rm --recursive build', 'rm -Recurse build',
    'Remove-Item -Recurse -Force build', 'Remove-Item build -Recurse', 'del /s /q build', 'rmdir /s /q out',
    'git push origin main', 'git reset --hard HEAD~1', 'git clean -fd', 'git checkout -- src/a.ts', 'git checkout .',
    'git restore .', 'git stash drop', 'git branch -D feat', 'npm publish', 'gh pr create --fill',
    'curl -X POST https://x', 'curl https://x -d "{}"', 'Invoke-RestMethod -Uri x -Method Post', 'DROP TABLE users',
  ]
  const harmless = [
    'rm file.txt', 'rm -f file.txt', 'rm -Force file.txt', 'Remove-Item a.txt', 'del /q a.txt', 'git status',
    'git checkout main', 'git restore --staged a.ts', 'git branch -d feat', 'git stash list', 'curl -O https://x',
    'curl -s -D headers.txt https://x', 'terraform plan',
  ]
  for (const text of destructive) assert.equal(classifyTool('pwsh', { command: text }).isDestructive, true, text)
  for (const text of harmless) assert.equal(classifyTool('pwsh', { command: text }).isRisky, false, text)
  const commit = classifyTool('bash', { command: 'git commit -am fix' })
  assert.deepEqual([commit.isRisky, commit.isDestructive], [true, false])
})

test('check commands cover common runners and wrappers', () => {
  const checks = [
    'pnpm test', 'cd sub && pnpm test', 'cargo test', 'go test ./...', 'python -m pytest -q', 'uv run pytest',
    'node tests/smoke.mjs', 'node --test', 'make test', './gradlew test', '.\\gradlew.bat check', 'mvn -q verify',
    'CI=1 npx vitest run', 'npx tsc --noEmit', 'pnpm exec vitest',
  ]
  for (const text of checks) assert.equal(isCheckCommand(text), true, text)
  for (const text of ['node scripts/build.js', 'echo test', 'git status']) assert.equal(isCheckCommand(text), false, text)
  // A check chained with a risky command is not treated as a plain check.
  assert.equal(classifyTool('bash', { command: 'pnpm build && git push' }).isCheck, false)
})

test('patch tools expose the files they touch', () => {
  const envelope = classifyTool('apply_patch', { input: '*** Begin Patch\n*** Update File: tests/a.test.ts\n@@\n-x\n+y\n*** Add File: package.json\n+{}\n*** End Patch' })
  assert.deepEqual(envelope.paths, ['tests/a.test.ts', 'package.json'])
  assert.equal(envelope.isTest, true)
  assert.equal(envelope.isDependency, true)
  const diff = classifyTool('apply_patch', { patch: 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n--- not a header\n+y' })
  assert.deepEqual(diff.paths, ['src/x.ts'])
  assert.deepEqual(actionTriggers(envelope, 1), ['edit', 'test_edit', 'dependency'])
})

test('every triggered card is a candidate; order only decides batches', () => {
  const skills = Array.from({ length: 10 }, (_, index) => `skill-${index}`)
  const graphs = new Map(skills.map((name) => {
    const skill = { name, description: name, path: `C:/skills/${name}/SKILL.md`, hash: name, content: '' }
    const graph = normalizeCompiled({
      entry: { title: `Skill ${name}`, when: name === 'skill-6' ? 'android layout xml work' : `work on ${name}`, points: ['a', 'b'] },
      cards: [
        { id: 'edit_rule', title: 'Edit rule', when: 'editing', triggers: ['edit'], satisfiedWhen: 'x', rules: ['do'] },
        { id: 'check_rule', title: 'Check rule', when: 'checking', triggers: ['check_start'], satisfiedWhen: 'x', rules: ['do'] },
      ],
    }, skill, normalizeConfig({}, process.cwd()))
    return [name, graph]
  }))
  const cards = buildGraph('C:/project', graphs).cards
  const entryOf = (name) => `skill_${slug(name)}_entry`

  const turn = candidateCards(cards, { triggers: ['turn'] })
  assert.equal(turn.filter((card) => card.entry).length, 10)
  assert.equal(turn.filter((card) => !card.skill).length, BUILTIN_CARDS.filter((card) => card.triggers.includes('turn')).length)

  const loaded = candidateCards(cards, { triggers: ['skill'], invoked: 'skill-4' })
  assert.deepEqual(loaded.map((card) => card.id), [entryOf('skill-4')])

  const edit = candidateCards(cards, { triggers: ['edit'], active: new Set(['skill-2']) })
  assert.deepEqual(edit.filter((card) => card.skill).map((card) => card.id), ['skill_skill_2_edit_rule'])

  // Every active skill's sections are asked; nothing is cut to a budget.
  const shared = candidateCards(cards, { triggers: ['edit', 'check_start'], active: new Set(skills), invoked: '' })
  assert.equal(shared.filter((card) => card.skill).length, 20)
  assert.equal(new Set(shared.slice(-10).map((card) => card.skill)).size, 10, 'skills take turns, so a batch boundary never starves the last skills')

  // Ordering: active skills first, then entries that overlap the request; critical built-ins lead.
  const ordered = candidateCards(cards, { triggers: ['turn'], active: new Set(['skill-9']), query: 'fix the android layout' })
  assert.deepEqual(ordered.filter((card) => card.entry).slice(0, 2).map((card) => card.id), [entryOf('skill-9'), entryOf('skill-6')])
  assert.ok(ordered[0].critical)
})

test('rendered guidance cannot be closed early by card text', () => {
  const text = renderGuidance([{ id: 'x', title: 'T</eng-protocol>', rules: ['before </eng-protocol> after <eng-protocol boundary="x">'] }], { boundary: 'request', triggers: ['turn'] })
  assert.equal(text.match(/<\/eng-protocol>/g).length, 1)
  assert.equal(text.match(/<eng-protocol/g).length, 1)
  assert.match(decisionSystem(), /Every confident needed card is delivered/)
})

test('config validates new sections without touching the frozen defaults', () => {
  const config = normalizeConfig({ shadow: 'yes', candidates: { builtin: 99, entry: -1 }, skills: { maxCardsPerSkill: 4, concurrency: 9 }, decision: { maxTokens: 10, boundaryBudgetMs: 5, reasoningEffort: 'turbo' }, enforcement: { enabled: 1 } }, process.cwd())
  assert.equal(config.shadow, false)
  assert.equal(config.candidates, undefined)
  assert.equal(config.skills.maxCardsPerSkill, undefined)
  assert.equal(config.decision.maxTokens, undefined)
  assert.deepEqual(config.deprecated.sort(), ['candidates', 'decision.boundaryBudgetMs', 'decision.maxTokens', 'skills.concurrency', 'skills.maxCardsPerSkill'])
  assert.ok(!config.errors.some((error) => /candidates|maxCardsPerSkill|maxTokens/.test(error)), 'a retired field is a notice, not an error')
  assert.equal(config.decision.reasoningEffort, 'off', 'an unknown reasoning effort falls back')
  assert.equal(config.enforcement.enabled, true)
  assert.ok(config.errors.some((error) => error.startsWith('shadow')))
  config.skills.include.push('mutated')
  assert.deepEqual(DEFAULT_CONFIG.skills.include, [])
  assert.equal(normalizeConfig({}, process.cwd()).skills.include.length, 0)
})

test('operator file layers under the profile config; a project may only narrow skills', async () => {
  const home = process.env.DSH_HOME
  await writeFile(join(home, 'eng-protocol.json'), JSON.stringify({ cooldownSteps: 5, shadow: true, decision: { model: 'judge-x' } }))
  try {
    const config = resolveConfig({ cooldownSteps: 2 }, process.cwd())
    assert.equal(config.cooldownSteps, 2)
    assert.equal(config.shadow, true)
    assert.equal(config.decision.model, 'judge-x')
    assert.equal(config.decision.provider, 'deepseek-account')
    assert.equal(config.userConfigPath, join(home, 'eng-protocol.json'))

    const project = await mkdtemp(join(tmpdir(), 'dsh-eng-protocol-project-'))
    await mkdir(join(project, '.dsh'))
    await writeFile(join(project, '.dsh', 'eng-protocol.json'), JSON.stringify({
      enabled: false,
      decision: { provider: 'evil' },
      skills: { include: ['android-ui'], maxSkills: 1 },
    }))
    const layered = await loadProjectConfig(project, config)
    assert.deepEqual(layered.config.skills.include, ['android-ui'])
    assert.equal(layered.config.skills.maxSkills, undefined)
    assert.equal(layered.config.enabled, true)
    assert.equal(layered.config.decision.provider, 'deepseek-account')
    assert.deepEqual(layered.ignored.sort(), ['decision', 'enabled', 'skills.maxSkills'])
    assert.equal((await loadProjectConfig(join(project, 'missing'), config)).config, config)
    await rm(project, { recursive: true, force: true })
  } finally {
    await rm(join(home, 'eng-protocol.json'), { force: true })
  }
})

test('ledger honours heartbeatSteps once per step and skips calls the tool boundary judged', () => {
  const ledger = new SessionLedger({ session: { deriveMessages: () => [] } }, { heartbeatSteps: 2 })
  ledger.push({ type: 'step/start', data: { step: 1 } })
  assert.ok(!ledger.observe([]).triggers.includes('heartbeat'))
  ledger.push({ type: 'step/start', data: { step: 2 } })
  assert.ok(ledger.observe([]).triggers.includes('heartbeat'))
  assert.ok(!ledger.observe([]).triggers.includes('heartbeat'), 'the same step fires once')
  const off = new SessionLedger({}, { heartbeatSteps: 0 })
  for (let step = 1; step <= 16; step += 1) off.push({ type: 'step/start', data: { step } })
  assert.ok(!off.observe([]).triggers.includes('heartbeat'))

  ledger.consumeAction('judged')
  ledger.push({ type: 'tool/call', data: { callId: 'judged', name: 'write', arguments: '{"path":"src/a.ts"}' } })
  ledger.push({ type: 'tool/call', data: { callId: 'fresh', name: 'read', arguments: '{"path":"src/b.ts"}' } })
  assert.deepEqual(ledger.observe([]).triggers, ['read'])
})

test('a resumed session knows which files it already edited', () => {
  const ledger = new SessionLedger({
    session: {
      deriveMessages: () => [
        { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'edit', arguments: '{"path":"src/a.ts"}' }] },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
      ],
    },
  })
  assert.deepEqual([...ledger.filesEdited], ['src/a.ts'])
  assert.ok(!actionTriggers(classifyTool('edit', { path: 'src/b.ts' }), ledger.filesEdited.size).includes('first_edit'))
})

test('the decision log is read from its end, across chunks and the rotated file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eng-protocol-log-'))
  const config = normalizeConfig({ stateDir: dir }, dir)
  const line = (index, cwd) => JSON.stringify({ kind: 'decision', cwd, ts: `t${index}`, boundary: 'request', error: index % 7 === 0 ? `判官失败：${'理由'.repeat(40)}` : undefined })
  await writeFile(join(dir, 'decisions.jsonl.1'), `${Array.from({ length: 30 }, (_, index) => line(index, 'A')).join('\n')}\n`)
  // ~400 KB of alternating projects: several 256 KB chunks, multi-byte text at arbitrary boundaries, a torn tail.
  await writeFile(join(dir, 'decisions.jsonl'), `${Array.from({ length: 3000 }, (_, index) => line(1000 + index, index % 2 ? 'A' : 'B')).join('\n')}\n{"torn":`)
  assert.deepEqual((await readDecisions(config, { cwd: 'A', limit: 5 })).map((record) => record.ts), ['t3991', 't3993', 't3995', 't3997', 't3999'])
  const all = await readDecisions(config, { cwd: 'A', limit: 5000 })
  assert.equal(all.length, 1530)
  assert.equal(all[0].ts, 't0', 'the rotated file fills the window, oldest first')
  assert.ok(all.filter((record) => record.error).every((record) => record.error.endsWith('理由'.repeat(40))))
  // The parsed window is reused until the log changes.
  await writeFile(join(dir, 'decisions.jsonl'), `\n${line(5000, 'A')}\n`, { flag: 'a' })
  assert.equal((await readDecisions(config, { cwd: 'A', limit: 5 })).at(-1).ts, 't5000')
  assert.deepEqual(await readDecisions(normalizeConfig({ stateDir: join(dir, 'missing') }, dir), { cwd: 'A' }), [])
  await rm(dir, { recursive: true, force: true })
})

test('the decision trail filters by boundary, outcome, session, card and text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eng-protocol-trail-'))
  const config = normalizeConfig({ stateDir: dir }, dir)
  const records = [
    { sessionId: 's1', boundary: 'request', triggers: ['turn'], candidates: ['halt', 'scope'], selected: ['halt'], injected: true, assessments: { halt: { state: 'needed', reason: 'Needs explicit Authorization' } } },
    { sessionId: 's1', boundary: 'tool', triggers: ['risky'], candidates: ['halt'], selected: ['halt'], injected: true, blocked: true, error: 'judge offline', preset: ['halt'] },
    { sessionId: 's2', boundary: 'settle', triggers: ['settle'], candidates: ['verify'], selected: ['verify'], shadow: true, wouldInject: true },
    { sessionId: 's2', boundary: 'request', triggers: ['turn'], candidates: ['scope'], selected: [] },
    { sessionId: 's3', boundary: 'tool', triggers: ['edit'], candidates: ['scope'], selected: [], error: 'timeout' },
  ].map((record, index) => ({ kind: 'decision', cwd: dir, ts: `2026-10-18T08:0${index}:00.000Z`, ...record }))
  await writeFile(join(dir, 'decisions.jsonl'), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  const state = { config }
  const ask = (query) => decisionsPayload(state, dir, new URLSearchParams(query))
  assert.deepEqual((await ask('')).items.map((record) => record.boundary), ['tool', 'request', 'settle', 'tool', 'request'])
  assert.equal((await ask('boundary=tool')).total, 2)
  assert.deepEqual((await ask('outcome=injected')).items.map((record) => record.boundary), ['request'])
  assert.deepEqual((await ask('outcome=blocked')).items.map((record) => record.sessionId), ['s1'])
  assert.equal((await ask('outcome=failed')).total, 2, 'any decision with a judge error')
  assert.deepEqual((await ask('outcome=shadow')).items.map((record) => record.boundary), ['settle'])
  assert.deepEqual((await ask('outcome=quiet')).items.map((record) => record.sessionId), ['s2'])
  assert.equal((await ask('session=s2')).total, 2)
  assert.equal((await ask('card=scope')).total, 3)
  assert.equal((await ask('q=authorization')).total, 1, 'searches the judge reasons, case-insensitively')
  const page = await ask('limit=2&offset=2')
  assert.deepEqual([page.total, page.items.length, page.items[0].boundary], [5, 2, 'settle'])
  assert.equal((await ask('limit=9999')).items.length, 5)
  await rm(dir, { recursive: true, force: true })
})

test('stats carry one compact point per decision for the activity charts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eng-protocol-series-'))
  const config = normalizeConfig({ stateDir: dir }, dir)
  await writeFile(join(dir, 'decisions.jsonl'), [
    { kind: 'decision', cwd: dir, ts: '2026-10-18T08:00:00.000Z', boundary: 'tool', blocked: true, injected: true, latencyMs: 900, sessionId: 7, triggers: ['risky'] },
    { kind: 'decision', cwd: dir, ts: '2026-10-18T08:05:00.000Z', boundary: 'request', error: 'x', latencyMs: 15000, triggers: ['turn', 'failed'] },
  ].map((record) => JSON.stringify(record)).join('\n'))
  const state = { config, graphs: new Map(), compileStatus: new Map(), lastCwdBySession: new Map() }
  const payload = await statsPayload(state, dir)
  assert.deepEqual(payload.series, [
    { t: '2026-10-18T08:00:00.000Z', b: 'tool', o: 'blocked', e: false, l: 900, s: '7' },
    { t: '2026-10-18T08:05:00.000Z', b: 'request', o: 'failed', e: true, l: 15000, s: '' },
  ])
  assert.deepEqual(payload.totals.byTrigger, { risky: 1, turn: 1, failed: 1 })
  assert.equal(payload.decisions, undefined, 'full records come from /api/decisions')
  await rm(dir, { recursive: true, force: true })
})

test('follow-up separates reminded outcomes from the shadow baseline', () => {
  // Legacy records without causal watermarks never inflate the success rate.
  const totals = aggregate([
    { kind: 'decision', sessionId: 's1', selected: ['verify'], injected: true, delivery: 'delivered', turn: 1, evidenceSeq: 1, responseSeq: 0, deliveryEvidenceSeq: 1, deliveryResponseSeq: 0, assessments: { verify: { state: 'needed' } } },
    { kind: 'decision', sessionId: 's1', selected: [], assessments: { verify: { state: 'unknown' } }, turn: 1, evidenceSeq: 2, responseSeq: 0 },
    { kind: 'decision', sessionId: 's1', selected: [], assessments: { verify: { state: 'satisfied' } }, turn: 1, evidenceSeq: 3, responseSeq: 1 },
    { kind: 'decision', sessionId: 's2', selected: ['halt'], shadow: true, wouldInject: true, delivery: 'delivered', turn: 1, evidenceSeq: 1, responseSeq: 0, deliveryEvidenceSeq: 1, deliveryResponseSeq: 0, assessments: { halt: { state: 'needed' } } },
    { kind: 'decision', sessionId: 's2', selected: ['halt'], shadow: true, wouldInject: true, delivery: 'delivered', turn: 2, evidenceSeq: 5, responseSeq: 2, deliveryEvidenceSeq: 5, deliveryResponseSeq: 2, assessments: { halt: { state: 'needed' } } },
    { kind: 'decision', sessionId: 's3', selected: [], assessments: { halt: { state: 'satisfied' } } },
    // A pre-delivery judgment (responseSeq not advanced) stays pending.
    { kind: 'decision', sessionId: 's4', selected: ['verify'], injected: true, delivery: 'delivered', turn: 1, evidenceSeq: 2, responseSeq: 0, deliveryEvidenceSeq: 2, deliveryResponseSeq: 0, assessments: { verify: { state: 'needed' } } },
    { kind: 'decision', sessionId: 's4', selected: [], assessments: { verify: { state: 'addressing' } }, turn: 1, evidenceSeq: 3, responseSeq: 0 },
  ])
  assert.deepEqual(totals.followUp.live, { resolved: 1, persisting: 0 })
  // Attribution outcomes live on the totals, outside the live/shadow A/B rates.
  // s1's post-delivery `unknown` judgment lands in its own bucket; s4's later
  // `addressing` settles as resolved because new evidence arrived after delivery;
  // s2's second delivery supersedes the first and stays pending.
  assert.equal(totals.followUp.pending, 1)
  assert.equal(totals.followUp.unknown, 1)
  assert.equal(totals.followUp.expired, 0)
  assert.equal(totals.followUp.legacy, 0)
  assert.deepEqual(totals.followUp.shadow, { resolved: 0, persisting: 1 })
  assert.deepEqual(totals.cards.verify.followUp.live, { resolved: 1, persisting: 0 })
  assert.equal(totals.shadow, 2)
  assert.equal(totals.wouldInject, 2)
  // s1's and s4's injected deliveries both land in `live`.
  assert.equal(totals.injected, 2)
})

test('assessment selection applies threshold, covers and cooldown', () => {
  const cards = [
    { id: 'a', priority: 3, critical: true, triggers: ['edit'] },
    { id: 'b', priority: 2, critical: false, triggers: ['edit'] },
    { id: 'c', priority: 1, critical: false, triggers: ['edit'] },
  ]
  const config = normalizeConfig({ maxCards: 2, cooldownSteps: 2 }, process.cwd())
  const state = { decisionTick: 1, cooldowns: new Map() }
  const assessments = {
    a: { state: 'needed', confidence: 0.9 },
    b: { state: 'needed', confidence: 0.8 },
    c: { state: 'needed', confidence: 0.7 },
  }
  const first = selectAssessments(assessments, cards, [{ type: 'covers', source: 'a', target: 'c' }], config, state)
  assert.deepEqual(first.selected.map((card) => card.id), ['a', 'b'])
  // Selection alone does not deliver a reminder; only delivery starts cooldown.
  assert.equal(state.cooldowns.size, 0)
  for (const card of first.selected) state.cooldowns.set(card.id, state.decisionTick)
  state.decisionTick = 2
  const second = selectAssessments({ ...assessments, b: { state: 'needed', confidence: 0.8 } }, cards, [], config, state)
  assert.deepEqual(second.selected.map((card) => card.id), ['a', 'c'])
})

test('ledger turns live events into triggers and failure streaks', () => {
  const session = {
    seq: 0,
    deriveMessages() {
      return [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the parser' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'looking' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"src/parser.ts"}' }] },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'source' }] },
      ]
    },
  }
  const ledger = new SessionLedger({ session })
  assert.equal(ledger.lastUser, 'fix the parser')
  ledger.push({ type: 'tool/call', time: 1, data: { callId: 'c2', name: 'pwsh', arguments: '{"command":"pnpm test"}' } })
  ledger.push({ type: 'tool/result', time: 2, data: { message: { source: { callId: 'c2' }, content: [{ type: 'text', text: '1 failed' }], isError: true }, error: { name: 'ShellError' } } })
  ledger.push({ type: 'tool/call', time: 3, data: { callId: 'c3', name: 'pwsh', arguments: '{"command":"pnpm test"}' } })
  ledger.push({ type: 'tool/result', time: 4, data: { message: { source: { callId: 'c3' }, content: [{ type: 'text', text: '1 failed' }], isError: true }, error: { name: 'ShellError' } } })
  const observed = ledger.observe([])
  assert.ok(observed.triggers.includes('check_start'))
  assert.ok(observed.triggers.includes('checked'))
  assert.ok(observed.triggers.includes('failed'))
  assert.ok(observed.triggers.includes('stuck'))
  assert.ok(observed.ledger.failureStreak >= 2)
})

test('aggregate counts decisions and cards', () => {
  const totals = aggregate([
    { kind: 'decision', boundary: 'request', triggers: ['turn'], selected: ['a'], candidates: ['a', 'b'], injected: true, blocked: false, latencyMs: 10, ts: 't' },
    { kind: 'decision', boundary: 'tool', triggers: ['edit'], selected: [], candidates: ['b'], injected: false, blocked: false, latencyMs: 20, ts: 't2' },
  ])
  assert.equal(totals.decisions, 2)
  assert.equal(totals.injected, 1)
  assert.equal(totals.cards.a.selected, 1)
  assert.equal(totals.avgLatencyMs, 15)
})

test('dashboard payload and routes serve HTML/CSS/JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-eng-protocol-'))
  const config = normalizeConfig({ stateDir: join(dir, 'state'), dashboard: { path: '/eng-protocol' } }, dir)
  const state = {
    config,
    graphs: new Map(),
    compileStatus: new Map(),
    lastCwd: dir,
    lastAgent: undefined,
    lastAgentByCwd: new Map(),
    lastCwdBySession: new Map(),
  }
  const graph = buildGraph(dir, new Map())
  state.graphs.set(dir, graph)
  const payload = await statsPayload(state, dir)
  assert.equal(payload.ok, true)
  assert.equal(payload.cwd, dir)
  assert.equal(payload.graph.cards.length, BUILTIN_CARDS.length)
  assert.deepEqual(payload.series, [])

  const routes = []
  const webCtx = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect(fn) { return fn() },
    on() {},
  }
  const ctx = { inject(_deps, cb) { cb(webCtx) }, get() { return undefined } }
  registerDashboard(ctx, state)
  assert.deepEqual(routes.map((route) => route.path).sort(), ['/eng-protocol', '/eng-protocol-bootstrap', '/eng-protocol/api/compile', '/eng-protocol/api/decisions', '/eng-protocol/api/models', '/eng-protocol/api/rebuild', '/eng-protocol/api/settings', '/eng-protocol/api/stats', '/eng-protocol/dashboard.css'], 'the debug route needs debug: true')
  const cssRoute = routes.find((route) => route.path === '/eng-protocol/dashboard.css')
  assert.ok(cssRoute)
  let css = ''
  await cssRoute.handler({ method: 'GET', url: '/eng-protocol/dashboard.css' }, { statusCode: 0, setHeader() {}, end(value) { css += value } })
  assert.ok(css.includes('--dsw-alias-bg-base'), 'the panel follows the Harness theme tokens')
  const pageRoute = routes.find((route) => route.path === '/eng-protocol')
  let html = ''
  await pageRoute.handler({ method: 'GET', url: '/eng-protocol' }, { statusCode: 0, setHeader() {}, end(value) { html += value } })
  assert.ok(html.includes('href="/eng-protocol/dashboard.css"'))
  assert.ok(!html.includes('document.write'))
  assert.ok(html.includes('Eng Protocol'))
  assert.match(html, /'<li>' \+ esc\(r\) \+ '<\/li>'/, 'compiled rule text must be escaped')

  // The rebuild endpoint only accepts the dashboard's own JSON requests and answers before compiling.
  const rebuild = routes.find((route) => route.path === '/eng-protocol/api/rebuild')
  const call = async (headers, body = '{}') => {
    const res = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value }, end(value) { this.body = value } }
    const req = { method: 'POST', headers, async *[Symbol.asyncIterator]() { yield Buffer.from(body) } }
    await rebuild.handler(req, res)
    return res
  }
  assert.equal((await call({ host: '127.0.0.1:27480', origin: 'https://evil.example', 'content-type': 'application/json' })).statusCode, 403)
  assert.equal((await call({ host: '127.0.0.1:27480', origin: 'http://127.0.0.1:27480', 'content-type': 'text/plain' })).statusCode, 403)
  assert.equal((await call({ host: '127.0.0.1:27480', origin: 'http://127.0.0.1:27480', 'content-type': 'application/json' })).statusCode, 409, 'without a session identity the panel refuses to guess')
  state.agentBySession = new Map([['s1', { session: { id: 's1', header: { cwd: dir } }, options: {} }]])
  state.compileRuns = new Map()
  state.compileAbort = new AbortController()
  state.projectConfigs = new Map()
  const accepted = await call({ host: '127.0.0.1:27480', origin: 'http://127.0.0.1:27480', 'content-type': 'application/json' }, JSON.stringify({ sessionId: 's1' }))
  assert.equal(accepted.statusCode, 202)
  assert.equal(JSON.parse(accepted.body).queued, true)
  assert.equal(JSON.parse(accepted.body).sessionId, 's1')

  // A stats request for an unknown session is refused instead of falling back
  // to whichever project happened to be active last.
  const stats = routes.find((route) => route.path === '/eng-protocol/api/stats')
  const readStats = async (query) => {
    const res = { statusCode: 0, setHeader() {}, end(value) { this.body = value } }
    await stats.handler({ method: 'GET', url: `/eng-protocol/api/stats${query}` }, res)
    return res
  }
  assert.equal((await readStats('')).statusCode, 409)
  assert.equal((await readStats('?sessionId=ghost')).statusCode, 409)
  const own = await readStats('?sessionId=s1')
  assert.equal(own.statusCode, 200)
  assert.equal(JSON.parse(own.body).cwd, dir)
  const project = await readStats(`?scope=project&cwd=${encodeURIComponent(dir)}`)
  assert.equal(project.statusCode, 200)

  // Settings: GET exposes the effective route; POST only accepts whitelisted
  // fields, validates before writing, and rejects operator-only switches.
  const settings = routes.find((route) => route.path === '/eng-protocol/api/settings')
  const callSettings = async (method, body, headers = {}) => {
    const res = { statusCode: 0, setHeader() {}, end(value) { this.body = value } }
    // A real dashboard POST carries its identity in the body, not the query.
    const req = {
      method, url: '/eng-protocol/api/settings?sessionId=s1',
      headers: { host: '127.0.0.1:27480', origin: 'http://127.0.0.1:27480', 'content-type': 'application/json', ...headers },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
    }
    await settings.handler(req, res)
    return res
  }
  const current = await callSettings('GET')
  assert.equal(current.statusCode, 200)
  const currentBody = JSON.parse(current.body)
  assert.ok(currentBody.editable.decision.includes('provider'))
  assert.ok(!currentBody.editable.runtime.includes('shadow'), 'enforcement switches stay file-only')
  assert.equal((await callSettings('POST', JSON.stringify({ settings: { enabled: false } }), { origin: 'https://evil.example' })).statusCode, 403)
  const rejected = await callSettings('POST', JSON.stringify({ sessionId: 's1', settings: { enforcement: { enabled: false } } }))
  assert.equal(rejected.statusCode, 400, 'a non-whitelisted section is refused')
  assert.match(JSON.parse(rejected.body).error, /不允许/)
  const badValue = await callSettings('POST', JSON.stringify({ sessionId: 's1', settings: { runtime: { minConfidence: 7 } } }))
  assert.equal(badValue.statusCode, 400, 'an out-of-range value is refused before it is written')
  assert.match(JSON.parse(badValue.body).error, /无效值/)
  // Without a session identity a write is refused outright.
  const anonymous = await callSettings('POST', JSON.stringify({ settings: { decision: { model: 'x' } } }), { origin: 'http://127.0.0.1:27480' })
  assert.equal(anonymous.statusCode, 409)
  await rm(join(dir, 'eng-protocol.json'), { force: true })

  const debugRoutes = []
  registerDashboard({ inject(_deps, cb) { cb({ ...webCtx, webServer: { register(route) { debugRoutes.push(route); return () => {} } } }) } }, { ...state, config: { ...config, debug: true } })
  assert.ok(debugRoutes.some((route) => route.path === '/eng-protocol/api/debug'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  await rm(dir, { recursive: true, force: true })
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL - ${name}`)
    console.error(error)
  }
}
if (failed > 0) process.exitCode = 1
