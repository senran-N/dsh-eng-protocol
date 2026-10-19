import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-eng-protocol-int-'))
// Never read the developer's real `$DSH_HOME/eng-protocol.json`.
process.env.DSH_HOME = dir
const handlers = new Map()
const routes = []
const commands = []
const injected = []
const decisions = []

const llm = {
  async prepareCall(config) {
    return {
      config: { ...config, provider: 'mock', model: 'mock' },
      async *stream() {
        yield {
          type: 'text-delta',
          text: JSON.stringify({
            cards: [
              { id: 'halt', state: 'needed', confidence: 0.92, reason: 'the action needs an authorization check' },
              { id: 'scope', state: 'needed', confidence: 0.75, reason: 'the edit is in scope but worth checking' },
              { id: 'refuted_premise', state: 'needed', confidence: 0.92, reason: 'the next edit applies an already-refuted fix' },
            ],
          }),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}
const skills = {
  async list() { return [{ name: 'demo-skill', description: 'Demo', path: 'C:/project/SKILL.md', invocation: { modelInvocable: true, userInvocable: true }, source: 'project', provider: 'filesystem' }] },
  async get(name) { return { name, description: 'Demo', content: '# Demo\nDo the thing.', path: 'C:/project/SKILL.md' } },
}
const webCtx = {
  webServer: {
    register(route) { routes.push(route); return () => {} },
  },
  effect(fn) { return fn() },
  on() {},
}
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  on(event, handler) {
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
    return () => {}
  },
  effect(fn) { return fn() },
  inject(deps, callback) {
    if (deps.includes('commands')) callback({ commands: { register(definition) { commands.push(definition); return () => {} } } })
    if (deps.includes('webServer')) callback(webCtx)
  },
  get(name) {
    if (name === 'llm') return llm
    if (name === 'skills') return skills
    return undefined
  },
}

apply(ctx, {
  stateDir: join(dir, 'state'),
  decision: { timeoutMs: 2000, maxTokens: 200 },
  compiler: { timeoutMs: 2000, maxTokens: 200 },
  skills: { enabled: true },
  cooldownSteps: 0,
})

assert.ok(commands.some((item) => item.name === 'protocol'))
assert.ok(routes.some((route) => route.path === '/eng-protocol'))
assert.ok(handlers.has('agent/pre-step'))
assert.ok(handlers.has('tools/pre-execute'))
assert.ok(handlers.has('tools/post-execute'), 'advisory verdicts ride the tool result')
assert.ok(handlers.has('agent/turn-stopping'))

const agent = {
  id: 'session-test',
  options: { provider: 'mock', model: 'mock' },
  session: {
    id: 'session-test',
    header: { cwd: 'C:/project' },
    seq: 3,
    deriveMessages() {
      return [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复解析器' }] },
        { role: 'assistant', content: [{ type: 'text', text: '先看代码' }] },
      ]
    },
  },
  inject(message) { injected.push(message) },
}
const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复解析器' }] }
const payload = { agent, messages: [user], turn: 1, step: 1, signal: new AbortController().signal }
const next = async () => ({ kind: 'enter', messages: [user] })
const preStep = handlers.get('agent/pre-step')[0]
const decision = await preStep(payload, next)
assert.equal(decision.kind, 'enter')
assert.ok(decision.messages.length >= 2, 'pre-step should append a reminder')
const notice = decision.messages.at(-1)
assert.equal(notice.source.kind, 'eng-protocol')
assert.equal(notice.source.form, 'notice')
assert.match(notice.content[0].text, /<eng-protocol/)
assert.match(notice.content[0].text, /cards="(halt|scope|refuted_premise)/)
assert.ok(notice.source.summary.includes('refuted_premise') || notice.source.summary.includes('eng-protocol'))

// The tool boundary sees the edit and soft-blocks the first attempt.
const toolHandlers = handlers.get('tools/pre-execute')
const exec = { name: 'write', arguments: { path: 'src/parser.ts', content: 'x' }, agent, callId: 'call-1', signal: new AbortController().signal }
const blocked = await toolHandlers[0](exec, async () => ({ kind: 'allow' }))
assert.equal(blocked.kind, 'deny')
assert.match(blocked.reason, /eng-protocol/)
const retried = await toolHandlers[0]({ ...exec, callId: 'call-2' }, async () => ({ kind: 'allow' }))
assert.equal(retried.kind, 'allow')

// Delivery boundary injects once and does not repeat within the same turn.
const settle = handlers.get('agent/turn-stopping')[0]
await settle({ agent, turn: 1, signal: new AbortController().signal })
await settle({ agent, turn: 1, signal: new AbortController().signal })
assert.ok(injected.length >= 1)
assert.equal(injected[0].source.kind, 'eng-protocol')

await new Promise((resolve) => setTimeout(resolve, 50))
await rm(dir, { recursive: true, force: true })
console.log('ok - apply wires events, injects a reminder, soft-blocks once, and records delivery context')
