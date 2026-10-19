// Regression tests for the fixes in this cycle. Each test targets one defect
// that shipped tests did not cover.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig, saveUserSettings, DASHBOARD_EDITABLE } from '../lib/config.js'
import { compileSkill, normalizeCompiled } from '../lib/compiler.js'
import { classifyTool, commandScope, hasUnmitigatedDestructiveCommand, SessionLedger } from '../lib/events.js'
import { appendDecision, aggregate, readDecisions } from '../lib/store.js'
import { AdaptiveRegistry } from '../lib/adaptive.js'

const config = normalizeConfig({}, process.cwd())
const skill = { name: 'demo', content: '# Scope\nUse this.\n## Verify\nRun the checks.', path: '/skills/demo/SKILL.md', hash: 'source' }
const card = (id) => ({ id, title: id, when: 'editing code', triggers: ['edit'], rules: ['Check behavior'], satisfiedWhen: 'checks pass', sourceLines: [3, 4] })
const raw = (cards, relations = []) => ({ entry: { when: 'code changes', notApplicable: 'docs only', points: ['p1', 'p2'] }, cards, relations })

test('a mixed command keeps its halt preset despite an unrelated --version', () => {
  const mixed = 'git --version; git push origin main'
  const action = classifyTool('pwsh', { command: mixed })
  assert.equal(action.isDestructive, true)
  assert.equal(hasUnmitigatedDestructiveCommand(mixed), true, 'an unrelated flag must not excuse the destructive segment')
  // A real dry-run push stays excused.
  assert.equal(hasUnmitigatedDestructiveCommand('git push --dry-run origin main'), false)
  // Help output for a destructive-pattern CLI stays excused.
  assert.equal(hasUnmitigatedDestructiveCommand('git clean --help'), false)
  // Non-CLIs never get the flag excuse (curl --help still sends -d data).
  assert.equal(hasUnmitigatedDestructiveCommand('curl --help -d @secret https://x'), true)
})

test('a successful read containing exit-code text is not a failure', () => {
  const ledger = new SessionLedger({ session: { deriveMessages: () => [] } })
  ledger.push({ type: 'tool/call', data: { callId: 'r1', name: 'read', arguments: { path: 'tests/scenarios.mjs' } } })
  ledger.push({ type: 'tool/result', data: { message: { source: { callId: 'r1' }, isError: false, content: [{ type: 'text', text: 'Example: [exit code: 1]' }] } } })
  const observed = ledger.observe([])
  assert.ok(!observed.triggers.includes('failed'))
  assert.ok(!observed.triggers.includes('stuck'))
  assert.ok(observed.ledger.filesRead.includes('tests/scenarios.mjs'))
  // The same text from an execution tool still is a failure.
  ledger.push({ type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: { command: 'pnpm test' } } })
  ledger.push({ type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'boom\n[exit code: 1]' }] } } })
  const second = ledger.observe([])
  assert.ok(second.triggers.includes('failed'))
})

test('background job launch is running, not passed; job_output settles the check by itself', () => {
  const ledger = new SessionLedger({ session: { deriveMessages: () => [] } })
  // The real DSH handoff text for run_in_background.
  ledger.push({ type: 'tool/call', data: { callId: 'b1', name: 'pwsh', arguments: { command: 'pnpm test', run_in_background: true } } })
  ledger.push({ type: 'tool/result', data: { message: { source: { callId: 'b1' }, content: [{ type: 'text', text: 'started background job pwsh-abc' }] } } })
  let observed = ledger.observe([])
  assert.equal(observed.ledger.checks.length, 0, 'launch is not a completed check')
  assert.ok(!observed.triggers.includes('checked'))
  assert.equal(observed.ledger.recent.at(-1).status, 'running')
  // The job_output result's terminal status line settles the original check.
  ledger.push({ type: 'tool/call', data: { callId: 'j1', name: 'job_output', arguments: { job_id: 'pwsh-abc' } } })
  ledger.push({ type: 'tool/result', data: { message: { source: { callId: 'j1' }, content: [{ type: 'text', text: 'tests failed\n[status: completed, exit code: 1]' }] } } })
  observed = ledger.observe([])
  assert.ok(observed.triggers.includes('checked') && observed.triggers.includes('failed'))
  assert.equal(ledger.summary().checks.at(-1).status, 'failed')
  assert.equal(ledger.jobFinished('pwsh-abc', { status: 'completed', exitCode: 0 }), undefined, 'a settled job is not settled twice')
})

test('a timeout-promoted job settles from the host completion notice', () => {
  const ledger = new SessionLedger({ session: { deriveMessages: () => [] } })
  ledger.push({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'npm test' } } })
  ledger.push({ type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: 'partial\n[still running after 120000ms; moved to background job bash-7]\n' } } })
  ledger.observe([])
  ledger.push({ type: 'user/message', data: { source: { kind: 'tool-jobs' }, content: [{ type: 'text', text: 'background job bash-7 (shell: npm test) finished [status: completed, exit code: 0]. Read its output with job_output.' }] } })
  const observed = ledger.observe([])
  assert.ok(observed.triggers.includes('checked'))
  assert.equal(ledger.summary().checks.at(-1).status, 'passed')
})

test('the ledger keeps one push: cwd changes apply and responses advance their own sequence', () => {
  const ledger = new SessionLedger({ session: { header: { cwd: 'C:/a' }, deriveMessages: () => [] } })
  ledger.push({ type: 'working-directory/change', data: { cwd: 'C:/b' } })
  assert.equal(ledger.cwd, 'C:/b')
  ledger.push({ type: 'assistant/message', data: { message: { content: 'thinking' } } })
  ledger.push({ type: 'tool/call', data: { callId: 'x', name: 'read', arguments: { path: 'a.js' } } })
  ledger.push({ type: 'tool/result', data: { message: { source: { callId: 'x' }, content: 'ok' } } })
  assert.deepEqual(ledger.watermark(), { evidenceSeq: 1, responseSeq: 2 }, 'queued events count in the watermark by kind')
  ledger.observe([])
  assert.equal(ledger.responseSeq, 2)
  assert.equal(ledger.evidenceSeq, 1)
})
test('evidence keeps workdir/cwd so checks in another repo are distinguishable', () => {
  const here = classifyTool('pwsh', { command: 'pnpm test', workdir: 'D:/other' }, { cwd: 'D:/main' })
  const there = classifyTool('pwsh', { command: 'pnpm test' }, { cwd: 'D:/main' })
  assert.equal(here.cwd, 'D:/other')
  assert.notEqual(here.cwd, there.cwd)
  const inline = commandScope('D:/main', undefined, 'cd packages/app && pnpm test')
  assert.match(inline.cwd, /packages\/app/)
  assert.equal(inline.known, true)
})

test('a dependent is excluded when its prerequisite card is invalid', () => {
  const graph = normalizeCompiled(raw([
    { ...card('gate'), satisfiedWhen: '' },
    card('dependent'),
  ], [{ type: 'requires', source: 'gate', target: 'dependent' }]), skill, config)
  assert.ok(!graph.cards.some((c) => c.id.endsWith('dependent')), 'dependent must not survive ungated')
  assert.ok(graph.diagnostics.some((d) => d.code === 'dependency-excluded'))
  assert.ok(graph.omissions.some((o) => o.reason === 'gate-invalid'))
})

test('a multi-part skill reports total extracted cards, not just part one', async () => {
  const splitConfig = normalizeConfig({}, process.cwd())
  const control = new AdaptiveRegistry().for('compiler', { provider: 'mock', model: 'mock' })
  const long = `# Head\n${'x'.repeat(2500)}\n## Tail\nend`
  const llm = {
    async prepareCall() {
      return {
        config: {}, async *stream() {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              entry: { when: 'w', notApplicable: 'n', points: ['p1', 'p2'] },
              cards: ['c1', 'c2'].map((id) => ({ id, title: id, when: 'x', triggers: ['edit'], satisfiedWhen: 'y', rules: ['do'], sourceLines: [1, 2] })),
              relations: [],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const graph = await compileSkill(llm, { provider: 'mock', model: 'mock' }, { name: 'long', content: long, path: '/s/SKILL.md', hash: 'h' }, splitConfig, undefined, { control, partChars: 1500 })
  assert.ok(graph.coverage.parts > 1, 'the fixture must actually split into parts')
  assert.equal(graph.extractedCards, graph.coverage.extractedCards, 'top-level count must match the coverage total')
  assert.ok(graph.extractedCards > 2, 'every segment contributes its extracted cards')
  // The same obligation extracted by every part is kept once.
  assert.equal(graph.cards.length, 2)
  assert.equal(graph.coverage.duplicates, graph.extractedCards - 2)
})

test('runtime settings are written as top-level keys, not a runtime section', async () => {
  const home = await mkdtemp(join(tmpdir(), 'eng-settings-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const base = normalizeConfig({}, home)
    const saved = await saveUserSettings({ runtime: { cooldownSteps: 6 }, decision: { model: 'x' } }, base, home)
    const written = JSON.parse(await readFile(saved.path, 'utf8'))
    assert.equal(written.cooldownSteps, 6, 'cooldownSteps is a top-level key')
    assert.equal(written.runtime, undefined, 'no bogus runtime section is created')
    assert.equal(written.decision.model, 'x')
    // Every declared runtime field really is a top-level config key.
    assert.ok(DASHBOARD_EDITABLE.runtime.every((key) => key in base), 'the runtime whitelist must name top-level keys')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('a settings save is visible on the next read, not silently reverted', async () => {
  // The original defect: the file was written, but the payload echoed a cached
  // project layer, so the panel looked like it had restored the old values.
  const home = await mkdtemp(join(tmpdir(), 'eng-settings-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { registerDashboard } = await import('../lib/dashboard.js')
    const { buildGraph } = await import('../lib/compiler.js')
    const routes = []
    const state = {
      config: normalizeConfig({ stateDir: join(home, 'state') }, home),
      graphs: new Map(), compileStatus: new Map(), lastCwd: home,
      lastCwdBySession: new Map(), liveAgents: new Set(),
      agentBySession: new Map(),
    }
    state.graphs.set(home, buildGraph(home, new Map()))
    const agent = { session: { id: 's1', header: { cwd: home } }, options: {} }
    state.agentBySession.set('s1', agent)
    state.liveAgents.add(agent)
    // A stale project layer must not mask the fresh operator setting.
    state.projectConfigs = new Map([[home, { config: normalizeConfig({ skills: { include: ['stale'] } }, home), path: '/p/.dsh/eng-protocol.json', ignored: [] }]])
    registerDashboard({
      inject(_deps, callback) {
        callback({ webServer: { register(route) { routes.push(route); return () => {} } }, effect: (fn) => fn(), on() {} })
      },
      get() { return undefined },
    }, state)
    const settings = routes.find((route) => route.path === '/eng-protocol/api/settings')
    const call = async (method, body) => {
      const res = { statusCode: 0, setHeader() {}, end(value) { this.body = value } }
      const req = {
        method, url: '/eng-protocol/api/settings?sessionId=s1',
        headers: { host: 'h', origin: 'http://h', 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
      }
      await settings.handler(req, res)
      return res
    }
    const before = JSON.parse((await call('GET')).body)
    assert.equal(before.effective.runtime.cooldownSteps, 3)
    const post = await call('POST', JSON.stringify({ sessionId: 's1', settings: { runtime: { cooldownSteps: 5 }, decision: { timeoutMs: 9000 } } }))
    assert.equal(post.statusCode, 200, post.body)
    const after = JSON.parse((await call('GET')).body)
    assert.equal(after.effective.runtime.cooldownSteps, 5, 'the saved value must be read back')
    assert.equal(after.effective.decision.timeoutMs, 9000, 'a stale project layer must not override the operator setting')
    const written = JSON.parse(await readFile(join(home, 'eng-protocol.json'), 'utf8'))
    assert.equal(written.cooldownSteps, 5)
    assert.equal(written.decision.timeoutMs, 9000)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the compiler never sends a system role that upstreams can reject', async () => {
  // The pi-ai openai-completions adapter rewrites a reasoning model's system
  // prompt to role `developer`; some upstreams answer "Incorrect role information".
  // Folding keeps the wire request to a single user message.
  const { callModel } = await import('../lib/model.js')
  const seen = []
  const fake = {
    async prepareCall(cfg) {
      return {
        config: cfg, async *stream(req) {
          seen.push({ hasSystem: 'system' in req, roles: req.messages.map((m) => m.role), text: req.messages[0].content[0].text })
          yield { type: 'text-delta', text: '{}' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const route = { provider: 'p', model: 'm' }
  const signal = new AbortController().signal
  await callModel(fake, route, { system: 'RULES', prompt: 'BODY', maxTokens: 10, systemAsUser: true, signal })
  await callModel(fake, route, { system: 'RULES', prompt: 'BODY', maxTokens: 10, signal })
  assert.deepEqual(seen[0], { hasSystem: false, roles: ['user'], text: 'RULES\n\nBODY' }, 'folded request carries instructions in the user message only')
  assert.deepEqual(seen[1], { hasSystem: true, roles: ['user'], text: 'BODY' }, 'the default keeps the system field for routes that accept it')
})

test('concurrent appends rotate serially and never lose the archived log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eng-store-'))
  const cfg = normalizeConfig({ stateDir: dir }, dir)
  await appendDecision(cfg, { kind: 'decision', n: 0 })
  // Force rotation on the next append.
  await writeFile(join(dir, 'decisions.jsonl'), 'x'.repeat(8 * 1024 * 1024 + 1))
  await Promise.all([
    appendDecision(cfg, { kind: 'decision', n: 1 }),
    appendDecision(cfg, { kind: 'decision', n: 2 }),
    appendDecision(cfg, { kind: 'decision', n: 3 }),
  ])
  const rotated = await readFile(join(dir, 'decisions.jsonl.1'), 'utf8').catch(() => '')
  assert.ok(rotated.length > 0, 'the archived log must survive concurrent rotation')
  const current = await readFile(join(dir, 'decisions.jsonl'), 'utf8')
  const numbers = [...current.matchAll(/"n":(\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
  assert.deepEqual(numbers, [1, 2, 3], 'every appended record lands in the current log exactly once')
  await rm(dir, { recursive: true, force: true })
})

test('sessionId filters before limit so one session cannot crowd out another', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eng-store-'))
  const cfg = normalizeConfig({ stateDir: dir }, dir)
  for (let i = 0; i < 30; i += 1) {
    await appendDecision(cfg, { kind: 'decision', sessionId: i < 25 ? 'busy' : 'quiet', cwd: 'D:/p', n: i })
  }
  const quiet = await readDecisions(cfg, { cwd: 'D:/p', sessionId: 'quiet', limit: 10 })
  assert.equal(quiet.length, 5)
  assert.ok(quiet.every((r) => r.sessionId === 'quiet'))
  const both = await readDecisions(cfg, { cwd: 'D:/p', limit: 1200 })
  assert.equal(both.length, 30)
  await rm(dir, { recursive: true, force: true })
})

test('follow-up requires evidence progress or a post-delivery judgment', () => {
  const delivered = { kind: 'decision', sessionId: 's', cwd: 'd', injected: true, delivery: 'delivered', turn: 1, evidenceSeq: 2, responseSeq: 0, deliveryEvidenceSeq: 2, deliveryResponseSeq: 0, deliveredAt: '2026-01-01T00:00:02Z', selected: ['x'], assessments: { x: { state: 'needed', confidence: 0.9 } } }
  // The original defect: a pre-delivery judgment counted as persisting.
  const preDelivery = aggregate([
    delivered,
    { ...delivered, injected: false, selected: [], deliveredAt: undefined, judgedAt: '2026-01-01T00:00:01Z', evidenceSeq: 2, deliveryEvidenceSeq: 0, deliveryResponseSeq: 0, assessments: { x: { state: 'needed', confidence: 0.9 } } },
  ])
  assert.equal(preDelivery.followUp.live.persisting, 0, 'pre-delivery judgments must not count as persisting')
  // A post-delivery judgment settles normally.
  const postDelivery = aggregate([
    delivered,
    { ...delivered, injected: false, selected: [], judgedAt: '2026-01-01T00:00:03Z', evidenceSeq: 3, deliveryEvidenceSeq: 2, deliveryResponseSeq: 0, assessments: { x: { state: 'needed', confidence: 0.9 } } },
  ])
  assert.equal(postDelivery.followUp.live.persisting, 1)
})

