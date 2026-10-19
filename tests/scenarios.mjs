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
// Realistic, distinct skill names: routing works on names and descriptions.
const SKILLS = ['android', 'postgres', 'docx', 'pptx', 'xlsx', 'pdf', 'kotlin', 'swift', 'terraform', 'docker']
const entryOf = (name) => `skill_${slug(name)}_entry`
const sectionsOf = (name, ids) => ids.filter((id) => id.startsWith(`skill_${slug(name)}_`) && id !== entryOf(name))
const isEntry = (id) => id.endsWith('_entry')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const user = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const verdicts = (call, pick) => call.ids.map((id) => ({ confidence: 0.9, reason: 'scenario', ...pick(id, call), id }))
const ruleText = (name, number) => `Rule ${number} of ${name} must hold.`
const bodyOf = (name, count = SECTION_TRIGGERS.length) => [`# ${name}`, ...Array.from({ length: count }, (_, index) => ruleText(name, index + 1))].join('\n')
const noticeText = (step) => step.messages.filter((message) => message.source?.kind === 'eng-protocol').map((message) => message.content[0].text).join('\n')

/** A plain promise gate that rejects when `signal` aborts. */
function gated(gate, signal) {
  if (!signal) return gate
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'))
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    gate.then(resolve, reject)
  })
}

function createHost({ skills = [], config = {}, cardOverrides = {} } = {}) {
  const handlers = new Map()
  const commands = []
  const contexts = []
  const steps = new Map()
  const host = {
    calls: [],
    compileCalls: 0,
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
          // Compile instructions arrive folded into the user message (the
          // compiler avoids the `developer` role), so detect by prompt content.
          if (/^\s*You compile one SKILL\.md/.test(`${system ?? ''}${prompt}`)) {
            const name = /SKILL NAME: (.+)/.exec(prompt)[1].trim()
            host.compileCalls += 1
            if (host.compileGate?.(name)) await gated(host.compileGate(name), signal)
            // One obligation per "Rule N" line of the body, quoted verbatim.
            const body = prompt.split('<skill>\n')[1].split('\n</skill>')[0]
            const cards = [...body.matchAll(/^Rule (\d+) of \S+ must hold\.$/gm)].map((match) => {
              const number = Number(match[1])
              const local = `s${number}`
              return {
                id: local, title: `${name} ${local}`, quote: match[0], when: 'x',
                triggers: SECTION_TRIGGERS[(number - 1) % SECTION_TRIGGERS.length], satisfiedWhen: 'y', rules: ['do it'],
                ...cardOverrides[name]?.[local],
              }
            })
            out = { cards, relations: [] }
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
    async list({ scope } = {}) { return (host.skillsByAgent?.[scope?.id] ?? host.skillNames).map((name) => ({ name, description: `Guidance for ${name} projects`, path: `C:/skills/${name}/SKILL.md` })) },
    async get(name) { return { name, description: `Guidance for ${name} projects`, content: bodyOf(name), path: `C:/skills/${name}/SKILL.md`, ...host.skillOverrides?.[name] } },
  }
  const webCtx = { webServer: { register() { return () => {} } }, effect(fn) { return fn() }, on() {} }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return () => {} },
    effect(fn) { return fn() },
    inject(deps, callback) {
      if (deps.includes('commands')) callback({ commands: { register(definition) { commands.push(definition); return () => {} } } })
      if (deps.includes('webServer')) callback(webCtx)
      if (deps.includes('systemPrompt')) callback({ systemPrompt: { context(definition) { contexts.push(definition); return () => {} } }, effect(fn) { return fn() } })
    },
    get(name) { return name === 'llm' ? llm : name === 'skills' ? skillsService : undefined },
  }
  apply(ctx, { stateDir: host.stateDir, cooldownSteps: 0, ...config })
  const on = (name) => handlers.get(name)[0]
  const signal = () => new AbortController().signal
  // Steps restart at 1 with every human turn, as in the host loop.
  const nextStep = (agent, messages) => {
    const step = messages.some((message) => message?.source?.kind === 'user') ? 1 : (steps.get(agent.id) ?? 0) + 1
    steps.set(agent.id, step)
    return step
  }

  Object.assign(host, {
    agent(id, cwd = 'C:/project') {
      const injected = []
      return { id, injected, options: { provider: 'mock', model: 'mock' }, session: { id, header: { cwd }, deriveMessages: () => [] }, inject(message) { injected.push(message) } }
    },
    preStep: (agent, messages = []) => on('agent/pre-step')({ agent, messages, step: nextStep(agent, messages), signal: signal() }, async () => ({ kind: 'enter', messages })),
    preExec: (agent, name, args, callId) => on('tools/pre-execute')({ agent, name, arguments: args, callId, signal: signal() }, async () => ({ kind: 'allow' })),
    postExec: (agent, name, args, callId, result = { isError: false, content: [] }) => on('tools/post-execute')({ agent, name, arguments: args, callId, signal: signal() }, result, async () => ({ kind: 'accept' })),
    settle: (agent, turn) => on('agent/turn-stopping')({ agent, turn, signal: signal() }),
    emit: (agent, event) => on('session/event')(agent.session, event),
    dispose: (agent) => on('agent/disposed')({ agent }),
    skillsChanged: () => on('skills/change')(),
    command: (agent, rawInput) => commands[0].handler({ agent, rawInput }),
    standing: (agent) => contexts[0].text({ agent }),
    standingSpec: () => contexts[0],
    async cardIds(agent) {
      const result = await host.command(agent, 'cards')
      return result.text.split('\n').slice(1).map((line) => line.split('\t')[1])
    },
    async sections(agent, name) { return sectionsOf(name, await host.cardIds(agent)) },
    async until(predicate, what) {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (await predicate()) return
        await sleep(10)
      }
      throw new Error(`timed out waiting for ${what}`)
    },
    /** Start the agent and wait until its catalog is read: one entry card per skill (compiled ones may already have more). */
    async ready(agent) {
      await host.preStep(agent, [])
      const expected = (host.skillsByAgent?.[agent.id] ?? host.skillNames).length
      await host.until(async () => (await host.cardIds(agent)).filter(isEntry).length === expected, `${expected} skills`)
    },
    /** The model loads a skill through the host's `skill` tool; the next step observes it. */
    async load(agent, name, callId = `load-${name}-${agent.id}`) {
      await host.preExec(agent, 'skill', { name }, callId)
      host.emit(agent, { type: 'tool/call', data: { callId, name: 'skill', arguments: { name } } })
      host.emit(agent, { type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'text', text: `<skill_content name="${name}">` }] } } })
      return host.preStep(agent)
    },
    async compiled(agent, name, count = SECTION_TRIGGERS.length) {
      await host.until(async () => (await host.sections(agent, name)).length === count, `${name} compiled`)
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

test('a turn judges the built-ins and only the skills the request points at; nothing compiles', async () => {
  const host = createHost({ skills: SKILLS })
  const agent = host.agent('A')
  await host.ready(agent)
  await host.preStep(agent, [user('实现一个新功能')])
  let ids = host.calls.at(-1).ids
  assert.deepEqual(ids.filter(isEntry), [], 'no skill is relevant, none is judged')
  assert.equal(ids.filter((id) => BUILTIN.has(id)).length, 11)
  await host.preStep(agent, [user('migrate the postgres schema')])
  ids = host.calls.at(-1).ids
  assert.deepEqual(ids.filter(isEntry), [entryOf('postgres')])
  assert.equal(host.compileCalls, 0, 'routing needs no compiled skill')
})

test('a routed skill gets a load nudge, never a paraphrase; once loaded its entry only decides scope', async () => {
  const host = createHost({ skills: SKILLS })
  const agent = host.agent('A')
  await host.ready(agent)
  host.verdict = (id) => ({ state: id === entryOf('postgres') ? 'needed' : 'unknown' })
  const step = await host.preStep(agent, [user('migrate the postgres schema')])
  const text = noticeText(step)
  assert.match(text, /加载 skill：postgres/)
  assert.match(text, /用 `skill` 工具加载 `postgres`/)
  assert.doesNotMatch(text, /Rule \d of postgres/, 'no compiled text stands in for the skill')
  await host.load(agent, 'postgres')
  const next = await host.preStep(agent, [user('continue the postgres migration')])
  assert.doesNotMatch(noticeText(next), /加载 skill：postgres/)
})

test('loading a skill puts it in scope without a judge call and compiles it once for every agent', async () => {
  const host = createHost({ skills: SKILLS })
  const agent = host.agent('A')
  await host.ready(agent)
  await host.preStep(agent, [user('处理 docx 报告')])
  const judged = host.calls.length
  await host.load(agent, 'docx')
  assert.equal(host.calls.length, judged, 'a skill load is not a judge question')
  await host.compiled(agent, 'docx')
  assert.equal(host.compileCalls, 1)
  assert.match((await host.command(agent, 'status')).text, /正在用的 skill：docx/)
  await host.preExec(agent, 'edit', { path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'e1')
  assert.ok(sectionsOf('docx', host.calls.at(-1).ids).length > 0)
  assert.ok(!host.calls.at(-1).ids.some((id) => id.startsWith('skill_') && !id.startsWith('skill_docx_')), 'no other skill is in scope')
  // A second agent (a subagent, another session) finds the compile already stored.
  const other = host.agent('B')
  await host.ready(other)
  assert.equal((await host.sections(other, 'docx')).length, SECTION_TRIGGERS.length, 'stored obligations are visible at once')
  await host.load(other, 'docx')
  await host.compiled(other, 'docx')
  assert.equal(host.compileCalls, 1, 'compiled once, shared by content')
})

test('a loaded skill keeps its obligations until a new task is judged outside it', async () => {
  const host = createHost({ skills: SKILLS })
  const agent = host.agent('A')
  await host.ready(agent)
  await host.preStep(agent, [user('处理 docx 报告')])
  await host.load(agent, 'docx')
  await host.compiled(agent, 'docx')
  host.verdict = (id) => ({ state: id === entryOf('docx') ? 'addressing' : 'unknown' })
  for (let index = 1; index <= 6; index += 1) {
    await host.preExec(agent, 'edit', { path: `src/f${index}.ts`, old_string: 'a', new_string: 'b' }, `e${index}`)
    assert.ok(sectionsOf('docx', host.calls.at(-1).ids).length > 0, `edit ${index} still sees docx`)
  }
  host.verdict = (id) => ({ state: isEntry(id) ? 'inapplicable' : 'unknown' })
  await host.preStep(agent, [user('换一个完全无关的任务')])
  assert.ok(host.calls.at(-1).ids.includes(entryOf('docx')), 'a loaded skill is re-checked at a new turn')
  await host.preExec(agent, 'edit', { path: 'src/other.ts', old_string: 'a', new_string: 'b' }, 'e7')
  assert.deepEqual(sectionsOf('docx', host.calls.at(-1).ids), [])
})

test('standing context carries the loaded skills\' verified requirements, checkpoints first, only in live mode', async () => {
  const host = createHost({
    skills: ['postgres', 'docx'],
    cardOverrides: { postgres: { s2: { checkpoint: true }, s3: { quote: 'An invented sentence that is not in the body.' } } },
  })
  const agent = host.agent('A')
  await host.ready(agent)
  assert.equal(host.standing(agent), '', 'nothing before a skill is loaded')
  assert.equal(host.standingSpec().interpolate, false, 'quoted skill text is never a prompt template')
  await host.load(agent, 'postgres')
  await host.compiled(agent, 'postgres')
  const text = host.standing(agent)
  assert.match(text, /^<eng-protocol-standing>/)
  assert.match(text, /## postgres/)
  assert.match(text.split('\n').find((line) => line.startsWith('- ')), /^- 动手前：「Rule 2 of postgres must hold\.」（L3）$/, 'checkpoints lead')
  assert.doesNotMatch(text, /invented/, 'only verified quotes stand')
  assert.doesNotMatch(text, /docx/, 'skills that are not loaded stay out')
  assert.equal(host.standing(host.agent('stranger')), '', 'an agent the plugin does not track gets nothing')
  await host.command(agent, 'shadow')
  assert.equal(host.standing(agent), '', 'shadow mode never touches the conversation')
})

test('a grounded skill checkpoint blocks the matching action once; an ungrounded one only advises', async () => {
  const host = createHost({
    skills: ['postgres'],
    cardOverrides: { postgres: { s1: { checkpoint: true, paths: ['**/*.sql'] }, s7: { checkpoint: true, quote: 'Never an invented sentence.' } } },
  })
  const agent = host.agent('A')
  await host.ready(agent)
  await host.preStep(agent, [user('migrate the postgres schema')])
  await host.load(agent, 'postgres')
  await host.compiled(agent, 'postgres')
  host.verdict = (id) => ({ state: ['skill_postgres_s1', 'skill_postgres_s7'].includes(id) ? 'needed' : 'unknown' })
  // Not a .sql file: the checkpoint's file predicate keeps it out of the question entirely.
  assert.equal((await host.preExec(agent, 'edit', { path: 'src/app.ts' }, 'ts')).kind, 'allow')
  assert.ok(!host.calls.at(-1).ids.includes('skill_postgres_s1'))
  assert.ok(host.calls.at(-1).ids.includes('skill_postgres_s7'), 'the ungrounded card is still judged, as advice')
  const denied = await host.preExec(agent, 'edit', { path: 'db/migrations/002.sql' }, 'sql1')
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /skill_postgres_s1/)
  assert.match(denied.reason, /原文（SKILL\.md L2）：「Rule 1 of postgres must hold\.」/)
  assert.equal((await host.preExec(agent, 'edit', { path: 'db/migrations/002.sql' }, 'sql2')).kind, 'allow', 'one soft block, then the retry goes through')
})

test('an advisory verdict rides the tool\'s own result, not the next step', async () => {
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
  const post = host.postExec(agent, 'pwsh', { command: 'pnpm test' }, 't1')
  open()
  host.gate = undefined
  const decision = await post
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.additionalContexts.length, 1)
  assert.equal(decision.additionalContexts[0].source.kind, 'eng-protocol')
  assert.match(decision.additionalContexts[0].content[0].text, /\[card: verify\]/)
  const step = await host.preStep(agent)
  assert.equal(noticeText(step), '', 'delivered once, next to the result it concerns')
  assert.ok((await host.decisions()).some((record) => record.boundary === 'tool' && record.injected && record.deliveredCards.includes('verify')))
})

test('parallel calls in one step deliver a shared reminder once', async () => {
  const host = createHost()
  const agent = host.agent('P')
  await host.preStep(agent, [user('跑两组测试')])
  host.verdict = (id, call) => ({ state: id === 'verify' && call.boundary === 'tool' ? 'needed' : 'unknown' })
  await host.preExec(agent, 'pwsh', { command: 'pnpm test --filter a' }, 'a')
  await host.preExec(agent, 'pwsh', { command: 'pnpm test --filter b' }, 'b')
  const first = await host.postExec(agent, 'pwsh', { command: 'pnpm test --filter a' }, 'a')
  const second = await host.postExec(agent, 'pwsh', { command: 'pnpm test --filter b' }, 'b')
  assert.match(first.additionalContexts[0].content[0].text, /\[card: verify\]/)
  assert.equal(second.additionalContexts, undefined, 'the same card is not repeated within the step')
})

test('cooldowns count real steps of the turn, not judge calls', async () => {
  const host = createHost({ config: { cooldownSteps: 2 } })
  const agent = host.agent('cool')
  host.verdict = (id) => ({ state: id === 'thrashing' ? 'needed' : 'unknown' })
  await host.preStep(agent, [user('修复解析器')])
  const fail = (callId) => {
    host.emit(agent, { type: 'tool/call', data: { callId, name: 'pwsh', arguments: { command: 'node build.js' } } })
    host.emit(agent, { type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'text', text: 'boom\n[exit code: 1]' }] } } })
  }
  fail('f1')
  assert.match(noticeText(await host.preStep(agent)), /\[card: thrashing\]/, 'step 2: delivered')
  fail('f2')
  assert.doesNotMatch(noticeText(await host.preStep(agent)), /\[card: thrashing\]/, 'step 3: still cooling down')
  fail('f3')
  assert.match(noticeText(await host.preStep(agent)), /\[card: thrashing\]/, 'step 4: due again')
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
  await host.until(() => host.calls.some((call) => call.boundary === 'tool'), 'the tool judgment')
  const before = host.calls.length
  const step = await host.preStep(agent, [])
  assert.equal(host.calls.length, before + 1, 'the failure is judged')
  assert.ok(host.calls.at(-1).triggers.includes('failed'))
  assert.ok(!host.calls.at(-1).triggers.includes('edit'))
  // No tool result carried this verdict (post-execute never ran), so the next step does.
  assert.match(noticeText(step), /\[card: local_version_truth\]/)
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

test('a new turn cancels judgments still running for the previous one', async () => {
  const host = createHost()
  const agent = host.agent('H')
  await host.preStep(agent, [user('任务一')])
  host.verdict = (id, call) => ({ state: id === 'verify' && call.boundary === 'tool' ? 'needed' : 'unknown' })
  host.gate = new Promise(() => {})
  await host.preExec(agent, 'pwsh', { command: 'pnpm test' }, 't1')
  host.gate = undefined
  const step = await host.preStep(agent, [user('任务二')])
  assert.doesNotMatch(noticeText(step), /\[card: verify\]/)
  assert.ok(!(await host.decisions()).some((record) => record.boundary === 'tool' && record.error), 'a cancelled judgment is not logged as a failure')
})

test('sessions are isolated: cooldowns, /protocol off and disposal', async () => {
  const host = createHost({ config: { cooldownSteps: 3 } })
  host.verdict = (id) => ({ state: id === 'scope' ? 'needed' : 'unknown' })
  const a = host.agent('A')
  const b = host.agent('B')
  assert.match(noticeText(await host.preStep(a, [user('任务')])), /\[card: scope\]/)
  assert.match(noticeText(await host.preStep(b, [user('任务')])), /\[card: scope\]/, 'A\'s cooldown does not silence B')

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
  assert.equal((await host.postExec(agent, 'pwsh', { command: 'rm -rf build' }, 's1')).additionalContexts, undefined)
  await host.settle(agent, 1)
  assert.equal(agent.injected.length, 0)
  await host.until(async () => (await host.decisions()).length >= 3, 'three decisions')
  const records = await host.decisions()
  assert.ok(records.every((record) => record.shadow === true && record.injected === false))
  assert.ok(records.some((record) => record.wouldInject))
  assert.ok(records.some((record) => record.wouldBlock && !record.blocked))
  assert.ok(aggregate(records).followUp.shadow.persisting >= 1)

  await host.command(agent, 'on')
  assert.match(noticeText(await host.preStep(agent, [user('继续')])), /\[card: halt\]/)
})

test('a skill edited while it compiles: the old compile guards, the new text compiles, nothing stale wins', async () => {
  const host = createHost({ skills: ['alpha'] })
  const agent = host.agent('A')
  await host.ready(agent)
  await host.load(agent, 'alpha')
  await host.compiled(agent, 'alpha')
  let release
  const held = new Promise((resolve) => { release = resolve })
  host.compileGate = () => held
  host.skillOverrides = { alpha: { content: bodyOf('alpha', SECTION_TRIGGERS.length + 1) } }
  host.skillsChanged()
  await host.until(() => host.compileCalls === 2, 'the edited skill to start compiling')
  assert.equal((await host.sections(agent, 'alpha')).length, SECTION_TRIGGERS.length, 'the previous compile keeps guarding meanwhile')
  assert.match((await host.command(agent, 'skills')).text, /(准备中|等待中)\talpha/)
  // A second change notice while compiling joins the same run instead of restarting it.
  host.skillsChanged()
  release()
  await host.compiled(agent, 'alpha', SECTION_TRIGGERS.length + 1)
  await sleep(30)
  assert.equal(host.compileCalls, 2)
  assert.equal((await host.sections(agent, 'alpha')).length, SECTION_TRIGGERS.length + 1)
  assert.match((await host.command(agent, 'status')).text, /1 个 skill 全部就绪/)
})

test('manual-only skills need explicit invocation; a failed load does not activate', async () => {
  const host = createHost({ skills: ['manual', 'failed'] })
  host.skillOverrides = { manual: { invocation: { modelInvocable: false, userInvocable: true } } }
  const agent = host.agent('manual')
  await host.ready(agent)
  await host.preStep(agent, [user('work on manual')])
  assert.ok(!host.calls.at(-1).ids.includes(entryOf('manual')), 'the model cannot load it, so it is never routed')
  await host.preExec(agent, 'skill', { name: 'failed' }, 'bad-load')
  host.emit(agent, { type: 'tool/call', data: { callId: 'bad-load', name: 'skill', arguments: { name: 'failed' } } })
  host.emit(agent, { type: 'tool/result', data: { message: { source: { callId: 'bad-load' }, isError: true, content: 'not found' } } })
  await host.preStep(agent)
  assert.match((await host.command(agent, '')).text, /正在用的 skill：暂时没有/)
  assert.equal(host.compileCalls, 0)
  await host.preStep(agent, [{ role: 'user', source: { kind: 'skill-invocation', name: 'manual' }, content: 'loaded' }])
  assert.match((await host.command(agent, '')).text, /正在用的 skill：manual/)
  await host.compiled(agent, 'manual')
  assert.equal(host.compileCalls, 1)
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
  assert.match(noticeText(next), /\[card: verify\]/)
  assert.ok((await host.decisions()).some((record) => record.injected && record.deliveredCards.includes('verify')))
})

test('two agents in the same cwd see their own scoped catalogs', async () => {
  const host = createHost({ skills: ['alpha'] })
  host.skillsByAgent = { A: ['alpha'], B: ['beta'] }
  const a = host.agent('A'), b = host.agent('B')
  await host.ready(a)
  await host.ready(b)
  await host.preStep(a, [user('task alpha')])
  assert.ok(host.calls.at(-1).ids.includes(entryOf('alpha')))
  assert.ok(!host.calls.at(-1).ids.includes(entryOf('beta')))
  await host.preStep(b, [user('task beta')])
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
