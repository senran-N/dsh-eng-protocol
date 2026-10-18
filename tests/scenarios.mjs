import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { BUILTIN_CARDS } from '../lib/cards.js'
import { slug } from '../lib/compiler.js'
import { aggregate } from '../lib/store.js'

// End-to-end scenarios against a fake DSH host: real `apply()`, fake LLM and skills.
const root = await mkdtemp(join(tmpdir(), 'dsh-eng-protocol-scenarios-'))
// Never read the developer's real `$DSH_HOME/eng-protocol.json`.
process.env.DSH_HOME = root
const BUILTIN = new Set(BUILTIN_CARDS.map((card) => card.id))
const SECTION_TRIGGERS = [['edit'], ['edit', 'settle'], ['first_edit'], ['check_start'], ['failed'], ['settle'], ['edit', 'checked']]
const entryOf = (name) => `skill_${slug(name)}_entry`
const sectionsOf = (name, ids) => ids.filter((id) => id.startsWith(`skill_${slug(name)}_`) && id !== entryOf(name))
const isEntry = (id) => id.endsWith('_entry')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const verdicts = (call, pick) => call.ids.map((id) => ({ confidence: 0.9, reason: 'scenario', ...pick(id, call), id }))

/** A plain promise gate that rejects when `signal` aborts. */
function gated(gate, signal) {
  if (!signal) return gate
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'))
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    gate.then(resolve, reject)
  })
}

function createHost({ skills = [], config = {} } = {}) {
  const handlers = new Map()
  const commands = []
  const host = {
    calls: [],
    skillNames: skills,
    verdict: () => ({ state: 'unknown' }),
    gate: undefined,
    fail: false,
    compileGate: undefined,
    stateDir: join(root, `state-${Math.random().toString(36).slice(2)}`),
  }
  const llm = {
    async prepareCall(callConfig) {
      return {
        config: callConfig,
        async *stream({ messages, system, signal }) {
          const prompt = messages[0].content[0].text
          let out
          // Compile instructions may arrive folded into the user message (the
          // compiler avoids the `developer` role), so detect by prompt content.
          if (`${system ?? ''}\n${prompt}`.startsWith('You compile') || prompt.startsWith('You compile')
            || /^\s*You compile one SKILL\.md/.test(prompt)) {
            const name = /SKILL NAME: (.+)/.exec(prompt)[1].trim()
            if (host.compileGate?.(name)) await gated(host.compileGate(name), signal)
            out = {
              entry: { title: `技能：${name}`, when: `work on ${name}`, notApplicable: 'other work', points: ['p1', 'p2'] },
              cards: SECTION_TRIGGERS.map((triggers, index) => ({ id: `s${index + 1}`, title: `${name} s${index + 1}`, when: 'x', triggers, satisfiedWhen: 'y', rules: ['do it'] })),
              relations: [],
            }
          } else {
            const cards = JSON.parse(prompt.split('CANDIDATE CARDS:\n')[1].split('\n\nCritical cards')[0])
            const evidence = JSON.parse(prompt.split('CURRENT EVIDENCE:\n')[1].split('\n\nCANDIDATE CARDS:')[0])
            const call = { ids: cards.map((card) => card.id), boundary: evidence.boundary, triggers: evidence.triggers, evidence, cards }
            host.calls.push(call)
            if (host.gate) await gated(host.gate, signal)
            if (host.fail) throw new Error('judge offline')
            out = { cards: verdicts(call, host.verdict) }
          }
          yield { type: 'text-delta', text: JSON.stringify(out) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
  const skillsService = {
    async list({ scope } = {}) { return (host.skillsByAgent?.[scope?.id] ?? host.skillNames).map((name) => ({ name, description: `${name} skill`, path: `C:/skills/${name}/SKILL.md` })) },
    async get(name) { return { name, description: `${name} skill`, content: `# ${name}\nbody`, path: `C:/skills/${name}/SKILL.md`, ...host.skillOverrides?.[name] } },
  }
  const webCtx = { webServer: { register() { return () => {} } }, effect(fn) { return fn() }, on() {} }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {} },
    effect(fn) { return fn() },
    inject(deps, callback) {
      if (deps.includes('commands')) callback({ commands: { register(definition) { commands.push(definition); return () => {} } } })
      if (deps.includes('webServer')) callback(webCtx)
    },
    get(name) { return name === 'llm' ? llm : name === 'skills' ? skillsService : undefined },
  }
  apply(ctx, { stateDir: host.stateDir, cooldownSteps: 0, ...config })
  const on = (name) => handlers.get(name)[0]
  const signal = () => new AbortController().signal

  Object.assign(host, {
    agent(id, cwd = 'C:/project') {
      const injected = []
      return { id, injected, options: { provider: 'mock', model: 'mock' }, session: { id, header: { cwd }, deriveMessages: () => [] }, inject(message) { injected.push(message) } }
    },
    preStep: (agent, messages = []) => on('agent/pre-step')({ agent, messages, signal: signal() }, async () => ({ kind: 'enter', messages })),
    preExec: (agent, name, args, callId) => on('tools/pre-execute')({ agent, name, arguments: args, callId, signal: signal() }, async () => ({ kind: 'allow' })),
    settle: (agent, turn) => on('agent/turn-stopping')({ agent, turn, signal: signal() }),
    emit: (agent, event) => on('session/event')(agent.session, event),
    dispose: (agent) => on('agent/disposed')({ agent }),
    skillsChanged: () => on('skills/change')(),
    command: (agent, rawInput) => commands[0].handler({ agent, rawInput }),
    async cardCount(agent) {
      const result = await host.command(agent, 'cards')
      return Number(/决策卡 (\d+) 张/.exec(result.text)[1])
    },
    async until(predicate, what) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await predicate()) return
        await sleep(10)
      }
      throw new Error(`timed out waiting for ${what}`)
    },
    /** Start the agent's project and wait until every skill is compiled. */
    async ready(agent) {
      await host.preStep(agent, [])
      const expected = BUILTIN.size + host.skillNames.length * (1 + SECTION_TRIGGERS.length)
      await host.until(async () => (await host.cardCount(agent)) === expected, `${expected} cards`)
    },
    async decisions() {
      await sleep(30)
      const text = await readFile(join(host.stateDir, 'decisions.jsonl'), 'utf8').catch(() => '')
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
  })
  return host
}

const checks = []
function test(name, fn) { checks.push({ name, fn }) }

const SKILLS = Array.from({ length: 10 }, (_, index) => `skill-${index}`)

test('every skill entry reaches the judge at a turn, next to the built-ins', async () => {
  const host = createHost({ skills: SKILLS })
  const agent = host.agent('A')
  await host.ready(agent)
  await host.preStep(agent, [user('实现一个新功能')])
  const ids = host.calls.at(-1).ids
  assert.equal(ids.filter(isEntry).length, 10)
  assert.equal(ids.filter((id) => BUILTIN.has(id)).length, 11)
})

test('a skill judged in scope keeps its section cards until judged out of scope', async () => {
  const host = createHost({ skills: SKILLS })
  const agent = host.agent('A')
  await host.ready(agent)
  host.verdict = (id) => ({ state: id === entryOf('skill-3') ? 'satisfied' : isEntry(id) ? 'inapplicable' : 'unknown' })
  await host.preStep(agent, [user('处理 skill-3 的工作')])
  for (let index = 1; index <= 12; index += 1) {
    await host.preExec(agent, 'edit', { path: `src/f${index}.ts`, old_string: 'a', new_string: 'b' }, `e${index}`)
    const ids = host.calls.at(-1).ids
    assert.ok(sectionsOf('skill-3', ids).length > 0, `edit ${index} still sees skill-3`)
    assert.ok(!ids.some((id) => id.startsWith('skill_') && !id.startsWith('skill_skill_3_')), 'no other skill is in scope')
  }
  host.verdict = (id) => ({ state: isEntry(id) ? 'inapplicable' : 'unknown' })
  await host.preStep(agent, [user('换一个完全无关的任务')])
  await host.preExec(agent, 'edit', { path: 'src/other.ts', old_string: 'a', new_string: 'b' }, 'e13')
  assert.deepEqual(sectionsOf('skill-3', host.calls.at(-1).ids), [])
})

test('loading a skill asks only about that skill and puts it in scope', async () => {
  const host = createHost({ skills: SKILLS })
  const agent = host.agent('A')
  await host.ready(agent)
  await host.preStep(agent, [{ role: 'user', source: { kind: 'skill-invocation', name: 'skill-7' }, content: [{ type: 'text', text: 'loaded' }] }])
  assert.deepEqual(host.calls.at(-1).ids, [entryOf('skill-7')])
  assert.match((await host.command(agent, 'status')).text, /正在用的 skill：skill-7/)
  await host.preExec(agent, 'edit', { path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'e1')
  assert.ok(sectionsOf('skill-7', host.calls.at(-1).ids).length > 0)
})

test('a deferred reminder does not swallow the next step\'s own triggers', async () => {
  const host = createHost()
  const agent = host.agent('C')
  host.verdict = (id, call) => ({ state: id === 'local_version_truth' && call.boundary === 'tool' ? 'needed' : 'unknown' })
  await host.preStep(agent, [user('升级依赖')])
  const args = { path: 'package.json', old_string: '"x": "1"', new_string: '"x": "2"' }
  assert.equal((await host.preExec(agent, 'edit', args, 'c1')).kind, 'allow')
  // The host reports the call after the hook ran: it must not fire `edit` again.
  host.emit(agent, { type: 'tool/call', time: 1, data: { callId: 'c1', name: 'edit', arguments: JSON.stringify(args) } })
  host.emit(agent, { type: 'tool/result', time: 2, data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'Error: old_string not found' }], isError: true } } })
  const before = host.calls.length
  const step = await host.preStep(agent, [])
  assert.equal(host.calls.length, before + 1, 'the failure is judged')
  assert.ok(host.calls.at(-1).triggers.includes('failed'))
  assert.ok(!host.calls.at(-1).triggers.includes('edit'))
  assert.match(step.messages.at(-1).content[0].text, /\[card: local_version_truth\]/)
})

test('the halt preset is a floor: explicit authorization clears it, doubt does not', async () => {
  const host = createHost()
  const agent = host.agent('D')
  host.verdict = (id) => (id === 'halt' ? { state: 'satisfied', confidence: 0.95, reason: 'the user asked to commit and push' } : { state: 'unknown' })
  await host.preStep(agent, [user('请把这些改动提交并 push 到 main')])
  assert.equal((await host.preExec(agent, 'pwsh', { command: 'git commit -am "fix parser"' }, 'g1')).kind, 'allow')
  assert.equal((await host.preExec(agent, 'pwsh', { command: 'git push origin main' }, 'g2')).kind, 'allow')
  host.verdict = (id) => (id === 'halt' ? { state: 'satisfied', confidence: 0.6 } : { state: 'unknown' })
  const doubtful = await host.preExec(agent, 'pwsh', { command: 'git push --force origin dev' }, 'g3')
  assert.equal(doubtful.kind, 'deny')
  assert.match(doubtful.reason, /\[card: halt\]/)
  const records = await host.decisions()
  assert.deepEqual(records.find((record) => record.cleared)?.cleared, ['halt'])
})

test('a judge outage still blocks a destructive command once', async () => {
  const host = createHost()
  const agent = host.agent('E')
  host.fail = true
  const denied = await host.preExec(agent, 'pwsh', { command: 'rm -rf build' }, 'r1')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /\[card: halt\]/)
  assert.equal((await host.preExec(agent, 'pwsh', { command: 'rm -rf build' }, 'r2')).kind, 'allow')
  assert.equal((await host.preExec(agent, 'pwsh', { command: 'git push --dry-run' }, 'r3')).kind, 'allow')
  const record = (await host.decisions()).find((item) => item.blocked)
  assert.match(record.error, /judge offline/)
  assert.deepEqual(record.preset, ['halt'])
})

test('soft blocks reset at a new turn', async () => {
  const host = createHost()
  const agent = host.agent('F')
  await host.preStep(agent, [user('任务一')])
  const push = { command: 'git push origin main' }
  assert.equal((await host.preExec(agent, 'pwsh', push, 'p1')).kind, 'deny')
  assert.equal((await host.preExec(agent, 'pwsh', push, 'p2')).kind, 'allow')
  await host.preStep(agent, [user('任务二')])
  assert.equal((await host.preExec(agent, 'pwsh', push, 'p3')).kind, 'deny')
})

test('a judgment that cannot block runs alongside the tool', async () => {
  const host = createHost()
  const agent = host.agent('G')
  await host.preStep(agent, [user('跑测试')])
  host.verdict = (id, call) => ({ state: id === 'verify' && call.boundary === 'tool' ? 'needed' : 'unknown' })
  let open
  host.gate = new Promise((resolve) => { open = resolve })
  const before = host.calls.length
  const result = await host.preExec(agent, 'pwsh', { command: 'pnpm test' }, 't1')
  assert.equal(result.kind, 'allow', 'the tool runs while the judge is still thinking')
  await host.until(() => host.calls.length === before + 1, 'the judge to receive the call')
  open()
  host.gate = undefined
  const step = await host.preStep(agent, [])
  assert.match(step.messages.at(-1).content[0].text, /\[card: verify\]/)
})

test('a new turn cancels judgments still running for the previous one', async () => {
  const host = createHost()
  const agent = host.agent('H')
  await host.preStep(agent, [user('任务一')])
  host.verdict = (id, call) => ({ state: id === 'verify' && call.boundary === 'tool' ? 'needed' : 'unknown' })
  host.gate = new Promise(() => {})
  await host.preExec(agent, 'pwsh', { command: 'pnpm test' }, 't1')
  host.gate = undefined
  const step = await host.preStep(agent, [user('任务二')])
  assert.ok(!step.messages.some((message) => message.source?.kind === 'eng-protocol' && /\[card: verify\]/.test(message.content[0].text)))
  assert.ok(!(await host.decisions()).some((record) => record.boundary === 'tool' && record.error), 'a cancelled judgment is not logged as a failure')
})

test('sessions are isolated: cooldowns, /protocol off and disposal', async () => {
  const host = createHost({ config: { cooldownSteps: 3 } })
  host.verdict = (id) => ({ state: id === 'scope' ? 'needed' : 'unknown' })
  const a = host.agent('A')
  const b = host.agent('B')
  assert.match((await host.preStep(a, [user('任务')])).messages.at(-1).content[0].text, /\[card: scope\]/)
  assert.match((await host.preStep(b, [user('任务')])).messages.at(-1).content[0].text, /\[card: scope\]/, 'A\'s cooldown does not silence B')

  await host.command(a, 'off')
  const before = host.calls.length
  assert.equal((await host.preStep(a, [user('再来')])).messages.length, 1)
  await host.preStep(b, [user('再来')])
  assert.equal(host.calls.length, before + 1, 'only B is judged')
  await host.command(a, 'on')

  host.dispose(b)
  host.emit(b, { type: 'tool/result', time: 1, data: { message: { source: { callId: 'x' }, content: [{ type: 'text', text: 'boom' }], isError: true } } })
  const afterDispose = host.calls.length
  await host.preStep(b, [])
  assert.equal(host.calls.length, afterDispose, 'events after disposal are not queued')
})

test('shadow mode judges and records without touching the conversation', async () => {
  const host = createHost({ config: { shadow: true } })
  const agent = host.agent('S')
  host.verdict = (id) => ({ state: id === 'halt' ? 'needed' : 'unknown' })
  const step = await host.preStep(agent, [user('清理构建目录')])
  assert.equal(step.messages.length, 1)
  assert.equal((await host.preExec(agent, 'pwsh', { command: 'rm -rf build' }, 's1')).kind, 'allow')
  await host.settle(agent, 1)
  assert.equal(agent.injected.length, 0)
  await host.until(async () => (await host.decisions()).length >= 3, 'three decisions')
  const records = await host.decisions()
  assert.ok(records.every((record) => record.shadow === true && record.injected === false))
  assert.ok(records.some((record) => record.wouldInject))
  assert.ok(records.some((record) => record.wouldBlock && !record.blocked))
  assert.ok(aggregate(records).followUp.shadow.persisting >= 1)

  await host.command(agent, 'on')
  assert.match((await host.preStep(agent, [user('继续')])).messages.at(-1).content[0].text, /\[card: halt\]/)
})

test('a skill change during compilation restarts it without stale writes', async () => {
  const host = createHost({ skills: ['alpha', 'beta'] })
  let release
  const held = new Promise((resolve) => { release = resolve })
  host.compileGate = (name) => (name === 'beta' ? held : undefined)
  const agent = host.agent('A')
  await host.preStep(agent, [])
  const perSkill = 1 + SECTION_TRIGGERS.length
  await host.until(async () => (await host.cardCount(agent)) === BUILTIN.size + perSkill, 'alpha compiled')
  host.compileGate = undefined
  host.skillNames = ['alpha', 'beta', 'gamma']
  host.skillsChanged()
  await host.until(async () => (await host.cardCount(agent)) === BUILTIN.size + 3 * perSkill, 'all three compiled')
  release()
  await sleep(50)
  assert.equal(await host.cardCount(agent), BUILTIN.size + 3 * perSkill, 'the aborted run did not overwrite the graph')
  const status = await host.command(agent, 'status')
  assert.match(status.text, /3 个 skill 全部就绪/)
  assert.doesNotMatch(status.text, /失败/)
})

test('cold compilation enters scope in the same turn and expands obligations at the edit boundary', async () => {
  const host = createHost({ skills: ['late'] })
  const agent = host.agent('late')
  let release
  const gate = new Promise((resolve) => { release = resolve })
  host.compileGate = () => gate
  await host.preStep(agent, [user('work on late')])
  host.verdict = (id) => ({ state: id === entryOf('late') ? 'satisfied' : id === 'skill_late_s1' ? 'needed' : 'unknown' })
  release()
  await host.until(async () => (await host.cardCount(agent)) > BUILTIN.size, 'late compilation')
  await host.preExec(agent, 'edit', { path: 'src/late.ts' }, 'late-edit')
  assert.ok(host.calls.some((call) => call.boundary === 'tool' && call.ids.includes('skill_late_s1')), 'same action sees newly active obligations')
  const step = await host.preStep(agent)
  assert.match(step.messages.at(-1).content[0].text, /\[card: skill_late_s1/)
})

test('newly activated enforced skill cards block before the action, never after allowing it', async () => {
  const host = createHost({ skills: ['gate'], config: { enforcement: { cards: ['skill_gate_s1'] } } })
  const agent = host.agent('gate')
  await host.ready(agent)
  // A seeded user request makes this the first scope-bearing boundary.
  host.emit(agent, { type: 'user/message', data: user('work on gate') })
  host.verdict = (id) => ({ state: id === entryOf('gate') ? 'satisfied' : id === 'skill_gate_s1' ? 'needed' : 'unknown' })
  const result = await host.preExec(agent, 'edit', { path: 'src/gate.ts' }, 'gate-edit')
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /skill_gate_s1/)
})

test('every skill entry is judged at the first boundary, split into adaptive batches', async () => {
  const names = Array.from({ length: 30 }, (_, index) => `skill-${index}`)
  const host = createHost({ skills: names })
  const agent = host.agent('many')
  await host.ready(agent)
  await host.preStep(agent, [user('implement feature')])
  const entries = new Set(host.calls.filter((call) => call.boundary === 'request').flatMap((call) => call.ids.filter(isEntry)))
  assert.equal(entries.size, names.length, 'no entry waits for a later boundary')
  assert.ok(host.calls.filter((call) => call.boundary === 'request').length > 1, 'a large candidate set is split across calls')
  assert.ok(host.calls.every((call) => call.ids.length <= 24), 'each call stays within the starting batch size')
})

test('manual-only skills require explicit invocation and failed skill loads do not activate', async () => {
  const host = createHost({ skills: ['manual', 'failed'] })
  host.skillOverrides = { manual: { invocation: { modelInvocable: false, userInvocable: true } } }
  const agent = host.agent('manual')
  await host.ready(agent)
  await host.preStep(agent, [user('work on manual')])
  assert.ok(!host.calls.at(-1).ids.includes(entryOf('manual')))
  await host.preExec(agent, 'skill', { name: 'failed' }, 'bad-load')
  host.emit(agent, { type: 'tool/call', data: { callId: 'bad-load', name: 'skill', arguments: { name: 'failed' } } })
  host.emit(agent, { type: 'tool/result', data: { message: { source: { callId: 'bad-load' }, isError: true, content: 'not found' } } })
  await host.preStep(agent)
  assert.match((await host.command(agent, '')).text, /正在用的 skill：暂时没有/)
  await host.preStep(agent, [{ role: 'user', source: { kind: 'skill-invocation', name: 'manual' }, content: 'loaded' }])
  assert.ok(host.calls.at(-1).ids.includes(entryOf('manual')))
  assert.match((await host.command(agent, '')).text, /正在用的 skill：manual/)
})

test('delivery review reads final assistant and tool evidence before judging', async () => {
  const host = createHost()
  const agent = host.agent('evidence')
  await host.preStep(agent, [user('fix and check')])
  host.emit(agent, { type: 'tool/call', data: { callId: 'check', name: 'pwsh', arguments: { command: 'pnpm test' } } })
  host.emit(agent, { type: 'tool/result', data: { message: { source: { callId: 'check' }, content: '[exit code: 1]' } } })
  host.emit(agent, { type: 'assistant/message', data: { message: { content: 'All tests passed, ready to deliver.' } } })
  await host.settle(agent, 1)
  const call = host.calls.at(-1)
  assert.equal(call.boundary, 'settle')
  assert.equal(call.evidence.checks.at(-1).status, 'failed')
  assert.match(call.evidence.lastAssistant, /All tests passed/)
  assert.ok(call.triggers.includes('failed'))
})

test('deferred reminders are counted only after delivery and cancelled ones do not start cooldown', async () => {
  const host = createHost({ config: { cooldownSteps: 10 } })
  const agent = host.agent('delivery')
  host.verdict = (id, call) => ({ state: id === 'verify' && call.boundary === 'tool' ? 'needed' : 'unknown' })
  await host.preStep(agent, [user('test one')])
  await host.preExec(agent, 'pwsh', { command: 'pnpm test' }, 'one')
  await sleep(20)
  assert.ok(!(await host.decisions()).some((record) => record.boundary === 'tool' && record.injected))
  await host.preStep(agent, [user('test two')])
  const cancelled = (await host.decisions()).find((record) => record.delivery === 'new-turn')
  assert.equal(cancelled.injected, false)
  await host.preExec(agent, 'pwsh', { command: 'pnpm test' }, 'two')
  const next = await host.preStep(agent)
  assert.match(next.messages.at(-1).content[0].text, /\[card: verify\]/)
  assert.ok((await host.decisions()).some((record) => record.injected && record.deliveredCards.includes('verify')))
})

test('two agents in the same cwd compile their own scoped catalogs', async () => {
  const host = createHost({ skills: ['alpha'] })
  host.skillsByAgent = { A: ['alpha'], B: ['beta'] }
  const a = host.agent('A'), b = host.agent('B')
  await host.ready(a)
  await host.ready(b)
  await host.preStep(a, [user('task A')])
  assert.ok(host.calls.at(-1).ids.includes(entryOf('alpha')))
  assert.ok(!host.calls.at(-1).ids.includes(entryOf('beta')))
  await host.preStep(b, [user('task B')])
  assert.ok(host.calls.at(-1).ids.includes(entryOf('beta')))
  assert.ok(!host.calls.at(-1).ids.includes(entryOf('alpha')))
})

test('fresh completion evidence withdraws a queued obsolete reminder', async () => {
  const host = createHost()
  const agent = host.agent('obsolete')
  host.verdict = (id, call) => ({ state: id === 'verify' ? call.boundary === 'tool' ? 'needed' : 'satisfied' : 'unknown' })
  await host.preStep(agent, [user('check')])
  await host.preExec(agent, 'pwsh', { command: 'pnpm test' }, 'check')
  host.emit(agent, { type: 'tool/call', data: { callId: 'check', name: 'pwsh', arguments: { command: 'pnpm test' } } })
  host.emit(agent, { type: 'tool/result', data: { message: { source: { callId: 'check' }, content: 'passed' } } })
  const step = await host.preStep(agent)
  assert.equal(step.messages.length, 0)
  assert.ok((await host.decisions()).some((record) => record.delivery === 'superseded' && !record.injected))
})

test('deferred and fresh notices deliver every needed card exactly once, with no count cap', async () => {
  const host = createHost()
  const agent = host.agent('cap')
  host.verdict = (id, call) => ({ state: call.boundary === 'tool' && id === 'verify' || call.boundary === 'request' && call.triggers.includes('failed') && ['thrashing', 'verify'].includes(id) ? 'needed' : 'unknown' })
  await host.preStep(agent, [user('test')])
  await host.preExec(agent, 'pwsh', { command: 'npm test' }, 't')
  host.emit(agent, { type: 'tool/result', data: { message: { source: { callId: 't' }, content: 'error', isError: true } } })
  const step = await host.preStep(agent)
  const delivered = step.messages.flatMap((message) => [...message.content[0].text.matchAll(/\[card: ([a-z_]+)/g)].map((match) => match[1]))
  assert.deepEqual(delivered.sort(), ['thrashing', 'verify'], 'both needed cards arrive, the shared one only once')
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
await sleep(50)
await rm(root, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
