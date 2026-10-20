import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyError } from '../lib/adaptive.js'
import { decisionPrompt, evaluateDecision } from '../lib/decide.js'
import { normalizeConfig } from '../lib/config.js'
import { commandScope, SessionLedger } from '../lib/events.js'
import { buildGraph, normalizeCompiled } from '../lib/skill-graph.js'
import { streamModel } from '../lib/model.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveUserSettings } from '../lib/config.js'
import { Aftermath } from '../lib/aftermath.js'
import { zstdCompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const call = (id, command) => ({ type: 'tool/call', data: { callId: id, name: 'pwsh', arguments: { command } } })
const result = (id, isError, content = 'done') => ({ type: 'tool/result', data: { message: { source: { callId: id }, isError, content } } })

test('entry routing does not send thousands of unselected membership edges', () => {
  const entry = { id: 'skill_demo_entry', skill: 'demo', entry: true }
  const relations = Array.from({ length: 5000 }, (_, i) => ({ type: 'contains', source: entry.id, target: `rule_${i}` }))
  relations.push({ type: 'requires', source: 'prerequisite', target: 'rule_0' })
  const prompt = decisionPrompt({ ledger: {}, graph: { relations } }, [entry])
  assert.ok(prompt.length < 5000, `an entry-only prompt grew to ${prompt.length} characters`)
  const rulePrompt = decisionPrompt({ ledger: {}, graph: { relations } }, [{ id: 'rule_0' }])
  const sent = JSON.parse(rulePrompt.split('RELATIONS (missing endpoints are not proof of completion):\n')[1].split('\n\nASSESSMENTS')[0])
  assert.deepEqual(sent, [relations[0], relations.at(-1)], 'the selected duty keeps membership and prerequisite context')
})

test('decision records measure actual batch prompts and retain their graph evidence', async () => {
  const prompts = []
  const cards = [{ id: 'duty', title: 'Duty' }]
  const relations = [{ type: 'requires', source: 'prerequisite', target: 'duty' }]
  const llm = { async prepareCall(config) { return { config, async *stream({ messages, system }) {
    prompts.push({ prompt: messages[0].content[0].text, system })
    yield { type: 'text-delta', text: JSON.stringify({ cards: [{ id: 'duty', state: 'unknown', confidence: 0.5 }] }) }
  } } } }
  const config = normalizeConfig({ decision: { provider: 'mock', model: 'mock' } })
  const out = await evaluateDecision({ get: () => llm }, { config }, { agent: { session: { id: 'audit' } } }, {
    candidates: cards, ledger: {}, triggers: ['turn'], graph: { cards, relations, revision: 'r' },
  })
  assert.equal(out.record.attempts[0].inputChars, prompts[0].prompt.length + prompts[0].system.length)
  assert.equal(out.record.requestChars, out.record.attempts[0].inputChars)
  assert.equal(out.record.maxRequestChars, out.record.requestChars)
  assert.deepEqual(out.evidenceSnapshot.relations, relations)
})

test('a success of the same operation breaks its failure streak, including background completion', () => {
  for (const background of [false, true]) {
    const ledger = new SessionLedger({ session: { header: { cwd: 'C:/project' } } })
    ledger.push(call('fail1', 'node migrate.js'))
    ledger.push(result('fail1', true))
    ledger.observe()
    ledger.push(call('success', 'node migrate.js'))
    ledger.push(result('success', false, background ? 'started background job job-1' : 'done'))
    if (background) ledger.push({ type: 'user/message', data: { source: { kind: 'tool-jobs' }, content: 'background job job-1 finished [status: completed, exit code: 0].' } })
    ledger.observe()
    ledger.push(call('fail2', 'node migrate.js'))
    ledger.push(result('fail2', true))
    const observed = ledger.observe()
    assert.equal(observed.ledger.failureStreak, 1)
    assert.ok(!observed.triggers.includes('stuck'))
  }
})

test('an unrelated successful read does not hide a repeatedly failing command', () => {
  const ledger = new SessionLedger({})
  for (const e of [call('f1', 'node migrate.js'), result('f1', true),
    { type: 'tool/call', data: { callId: 'read', name: 'read', arguments: { path: 'migrate.js' } } }, result('read', false),
    call('f2', 'node migrate.js'), result('f2', true)]) ledger.push(e)
  assert.ok(ledger.observe().triggers.includes('stuck'))
})

test('check scope resolves inline directory changes from the explicit workdir and preserves spaces', () => {
  assert.equal(commandScope('C:/project', 'C:/other', 'cd "nested repo"; npm test').cwd, 'C:/other/nested repo')
  assert.equal(commandScope('C:\\project', undefined, 'Set-Location -LiteralPath "D:\\other repo"; npm test').cwd, 'D:\\other repo')
  assert.equal(commandScope('/project', '/other', 'cd nested && cd ../final && npm test').cwd, '/other/final')
  assert.equal(commandScope('C:\\project', '\\\\server\\share', 'npm test').cwd, '\\\\server\\share')
})

test('provider membership RPM limits reduce route pressure even when HTTP status is 400', () => {
  const error = Object.assign(new Error('400: {"code":"tier_limit_exceeded","message":"membership rpm limit exceeded: 101/100"}'), { status: 400 })
  assert.equal(classifyError(error).kind, 'rate-limit')
  assert.equal(classifyError(error).retryable, true)
  assert.equal(classifyError(Object.assign(new Error('invalid field'), { status: 400 })).kind, 'unknown')
})

test('every prerequisite participates in exclusion, regardless of relation order', () => {
  const skill = { name: 'demo', content: '# Rules\nFirst duty.\nSecond duty.\nThird duty.' }
  const cards = [
    { id: 'missing', quote: 'This is absent from the skill.' },
    { id: 'first', s: 2 }, { id: 'second', s: 3 }, { id: 'third', s: 4 },
  ]
  const relations = [
    { type: 'requires', source: 'missing', target: 'first' },
    { type: 'requires', source: 'first', target: 'third' },
    { type: 'requires', source: 'second', target: 'third' },
  ]
  for (const ordered of [relations, [...relations].reverse()]) {
    const compiled = normalizeCompiled({ cards, relations: ordered }, skill)
    assert.deepEqual(compiled.cards.map(c => c.id), ['skill_demo_second'])
  }
})

test('an obligation named entry cannot overwrite its skill routing card', () => {
  const skill = { name: 'demo', content: '# Rules\nAlways verify the output.' }
  const compiled = normalizeCompiled({ cards: [{ id: 'entry', s: 2 }] }, skill)
  const graph = buildGraph('/project', new Map([['demo', { summary: skill, compiled }]]))
  assert.equal(new Set(graph.cards.map(c => c.id)).size, graph.cards.length)
  assert.ok(graph.relations.every(e => e.source !== e.target))
})

test('mixed streamed and completed text blocks preserve the complete model answer once', async () => {
  for (const chunks of [
    [{ type: 'text-delta', text: 'first' }, { type: 'block-end', block: { type: 'text', text: 'first' } }, { type: 'block-end', block: { type: 'text', text: 'second' } }],
    [{ type: 'block-end', block: { type: 'text', text: 'first' } }, { type: 'text-delta', text: 'second' }, { type: 'block-end', block: { type: 'text', text: 'second' } }],
  ]) {
    const llm = { async prepareCall(config) { return { config, async *stream() { yield* chunks } } } }
    let streamed = ''
    const answer = await streamModel(llm, { provider: 'mock', model: 'mock' }, { prompt: 'x', onDelta: d => { streamed += d } })
    assert.equal(answer.text, 'firstsecond')
    assert.equal(streamed, answer.text)
  }
})

test('simultaneous settings saves preserve both patches and never overwrite unreadable config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eng-audit-settings-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const config = normalizeConfig({}, dir)
    const file = join(dir, 'eng-protocol.json')
    await Promise.all([
      saveUserSettings({ decision: { timeoutMs: 9000 } }, config, dir),
      saveUserSettings({ runtime: { cooldownSteps: 7 } }, config, dir),
    ])
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.decision?.timeoutMs, 9000)
    assert.equal(saved.cooldownSteps, 7)
    await writeFile(file, '{broken')
    await assert.rejects(saveUserSettings({ runtime: { cooldownSteps: 8 } }, config, dir), /配置.*读取失败/)
    assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('resuming a background check retains completion from notices and job_output', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'launch', name: 'pwsh', arguments: { command: 'npm test', run_in_background: true } }] },
    { role: 'tool', toolCallId: 'launch', content: 'started background job pwsh-audit' },
  ]
  const completions = [
    [{ role: 'user', source: { kind: 'tool-jobs' }, content: 'background job pwsh-audit finished [status: completed, exit code: 0].' }],
    [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'poll', name: 'job_output', arguments: { job_id: 'pwsh-audit' } }] },
      { role: 'tool', toolCallId: 'poll', content: 'Tests passed\n[status: completed, exit code: 0]' },
    ],
  ]
  for (const ending of completions) {
    const ledger = new SessionLedger({ session: { deriveMessages: () => [...messages, ...ending] } })
    assert.equal(ledger.summary().checks.at(-1)?.status, 'passed')
    assert.equal(ledger.summary().recent.find(r => r.callId === 'launch').status, 'ok')
    assert.equal(ledger.jobs.size, 0)
  }
})

test('negative process exit codes remain failures in the ledger and follow-up', () => {
  const ledger = new SessionLedger({})
  const after = new Aftermath()
  after.watch({ decisionId: 'd', selected: ['verify'] })
  const events = [call('crash', 'npm test'), result('crash', false, 'process crashed\n[exit code: -1073741819]')]
  let followup
  for (const event of events) { ledger.push(event); followup = after.push(event) }
  assert.ok(ledger.observe().triggers.includes('failed'))
  assert.equal(ledger.summary().checks.at(-1).status, 'failed')
  assert.equal(followup[0].actions[0].status, 'error')
})

test('surface replacements cannot fabricate new edits, failures, skill loads or follow-up actions', () => {
  const ledger = new SessionLedger({})
  const events = [
    { type: 'tool/call', seq: 1, data: { callId: 'edit', name: 'write', arguments: { path: 'a.js' } } },
    { ...result('edit', false), seq: 2 },
    { ...call('check', 'npm test'), seq: 3 }, { ...result('check', true, 'test failure'), seq: 4 },
    { type: 'tool/call', seq: 5, data: { callId: 'load', name: 'skill', arguments: { name: 'demo' } } },
    { ...result('load', false, 'skill text'), seq: 6 },
  ]
  for (const event of events) ledger.push(event)
  ledger.observe()
  const before = ledger.summary()
  const after = new Aftermath()
  after.watch({ decisionId: 'd', selected: ['verify'], deliverySeq: 6 })
  for (const original of events) {
    const replacement = { ...original, seq: original.seq + 100, surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq } }
    ledger.push(replacement)
    assert.deepEqual(after.push(replacement), [])
  }
  const observed = ledger.observe()
  assert.deepEqual(observed.triggers, [])
  assert.equal(observed.ledger.editRevision, before.editRevision)
  assert.equal(observed.ledger.failureStreak, before.failureStreak)
  assert.equal(observed.ledger.checks.length, before.checks.length)
  assert.equal(observed.ledger.timeline.length, before.timeline.length)
  assert.equal(observed.ledger.evidenceSeq, before.evidenceSeq)
  assert.equal(observed.ledger.responseSeq, before.responseSeq)
  assert.equal(observed.ledger.lastSeq, 106)
})

test('the offline audit reads every zstd frame and reports a torn tail explicitly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eng-audit-records-'))
  try {
    const sessions = join(dir, 'sessions', 'project', 'session')
    await mkdir(sessions, { recursive: true })
    const events = [
      { type: 'session', id: 'audit', version: 4 },
      { type: 'tool/call', data: { callId: 'load', name: 'skill', arguments: { name: 'demo' } } },
      result('load', false, 'skill content'),
      { ...result('load', false, 'trimmed skill content'), surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } },
    ]
    const frames = events.map(event => zstdCompressSync(`${JSON.stringify(event)}\n`))
    const file = join(sessions, 'session.v4.jsonl.zstd')
    await writeFile(file, Buffer.concat(frames))
    const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/audit-records.mjs', import.meta.url)), '--home', dir], { encoding: 'utf8', windowsHide: true })
    const valid = run()
    assert.equal(valid.status, 0, valid.stderr)
    const summary = JSON.parse(valid.stdout)
    assert.equal(summary.sessions.events, 3)
    assert.equal(summary.sessions.skillLoads.demo, 1)
    assert.equal(summary.sessions.surfaceReplacements, 1)
    await writeFile(file, Buffer.concat([...frames, frames[1].subarray(0, 6)]))
    const torn = run()
    assert.equal(torn.status, 1)
    assert.equal(JSON.parse(torn.stdout).errors.length, 1)
    assert.equal(JSON.parse(torn.stdout).sessions.events, 3)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
