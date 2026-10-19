// Model catalog, reasoning-effort fitting, trajectory follow-up and compile visualization.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ENG_PROTOCOL_RETRY_BASE_MS = '1'
const { fitReasoning, callJson } = await import('../lib/model.js')
const { compileSummary, modelsPayload } = await import('../lib/dashboard.js')
const { Aftermath } = await import('../lib/aftermath.js')
const { compileStatusFor, refreshSkills, wantSkill } = await import('../lib/compiler.js')
const { normalizeConfig } = await import('../lib/config.js')
const { classifyError } = await import('../lib/adaptive.js')

const reasoning = (...ids) => ({ reasoning: { efforts: ids.map((id) => ({ id, name: id.toUpperCase() })) } })

test('a requested effort is fitted to what the exact model offers', () => {
  assert.deepEqual(fitReasoning('high', reasoning('low', 'medium', 'high')).effort, 'high')
  const fitted = fitReasoning('high', reasoning('low', 'medium'))
  assert.equal(fitted.effort, 'medium', 'the nearest offered effort, not a rejected request')
  assert.match(fitted.note, /不支持“high”.*MEDIUM/)
  assert.equal(fitReasoning('off', reasoning('low', 'high')).effort, 'low', 'off maps to the lightest option')
  assert.equal(fitReasoning('high', {}).effort, undefined, 'a model without reasoning gets no effort at all')
  assert.equal(fitReasoning(undefined, reasoning('low')).effort, undefined, 'no request keeps the model default')
})

test('the call sends the fitted effort through the host configure hook', async () => {
  const seen = []
  const llm = {
    async prepareCall(config, _signal, configure) {
      const controls = configure ? configure({ maxTokens: config.maxTokens, temperature: config.temperature }, { provider: config.provider, id: config.model, name: 'GLM', ...reasoning('low', 'medium') }) : config
      seen.push(controls)
      return { config: { ...config, ...controls }, async *stream() { yield { type: 'text-delta', text: '{"ok":true}' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
    },
  }
  let fit
  await callJson(llm, { provider: 'opendesign', model: 'glm-5.3-flashx' }, { prompt: 'x', reasoningEffort: 'high', onFit: (value) => { fit = value } })
  assert.equal(seen[0].reasoningEffort, 'medium')
  assert.equal(fit.effort, 'medium')
  assert.equal(classifyError(Object.assign(new Error('provider "x" model "y" does not support reasoning effort "high"'), { code: 'UNSUPPORTED_REASONING_EFFORT' })).kind, 'effort')
})

test('the settings catalog lists providers, models and one model\'s real efforts', async () => {
  const llm = {
    listProviders: () => [{ id: 'opendesign', name: 'OpenDesign' }, { id: 'deepseek-account', name: 'DeepSeek' }],
    listModels: async (provider) => [{ provider, id: 'glm-5.3-flashx', name: 'GLM 5.3 Flash' }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: 'GLM 5.3 Flash', context: { contextWindow: 128000 }, ...reasoning('low', 'medium') }),
  }
  const providers = await modelsPayload(llm, new URLSearchParams())
  assert.deepEqual(providers.providers.map((item) => item.id), ['opendesign', 'deepseek-account'])
  const models = await modelsPayload(llm, new URLSearchParams({ provider: 'opendesign' }))
  assert.equal(models.models[0].id, 'glm-5.3-flashx')
  const info = await modelsPayload(llm, new URLSearchParams({ provider: 'opendesign', model: 'glm-5.3-flashx' }))
  assert.deepEqual(info.efforts.map((item) => item.id), ['low', 'medium'])
  assert.equal(info.contextWindow, 128000)
  assert.equal((await modelsPayload(undefined, new URLSearchParams())).ok, false)
})

test('a settings save with an effort the model lacks is refused in plain words', async () => {
  const home = await mkdtemp(join(tmpdir(), 'eng-catalog-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { registerDashboard } = await import('../lib/dashboard.js')
    const { buildGraph } = await import('../lib/compiler.js')
    const routes = []
    const llm = {
      listProviders: () => [{ id: 'opendesign', name: 'OpenDesign' }],
      listModels: async () => [],
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: 'GLM 5.3 Flash', ...reasoning('low', 'medium') }),
    }
    const agent = { session: { id: 's1', header: { cwd: home } }, options: {} }
    const state = { config: normalizeConfig({ stateDir: join(home, 'state') }, home), graphs: new Map([[home, buildGraph(home, new Map())]]), compileStatus: new Map(), lastCwdBySession: new Map(), liveAgents: new Set([agent]), agentBySession: new Map([['s1', agent]]) }
    registerDashboard({ inject(_deps, callback) { callback({ webServer: { register(route) { routes.push(route); return () => {} } }, effect: (fn) => fn(), on() {} }) }, get: (name) => name === 'llm' ? llm : undefined }, state)
    const settings = routes.find((route) => route.path === '/eng-protocol/api/settings')
    const post = async (body) => {
      const res = { statusCode: 0, setHeader() {}, end(value) { this.body = value } }
      await settings.handler({ method: 'POST', url: '/eng-protocol/api/settings', headers: { host: 'h', origin: 'http://h', 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }, res)
      return res
    }
    const bad = await post({ sessionId: 's1', settings: { compiler: { provider: 'opendesign', model: 'glm-5.3-flashx', reasoningEffort: 'high' } } })
    assert.equal(bad.statusCode, 400)
    assert.match(JSON.parse(bad.body).error, /不支持“high”，可选的有 LOW、MEDIUM/)
    const unknown = await post({ sessionId: 's1', settings: { decision: { provider: 'nope' } } })
    assert.match(JSON.parse(unknown.body).error, /没有“nope”这个服务商/)
    const good = await post({ sessionId: 's1', settings: { compiler: { provider: 'opendesign', model: 'glm-5.3-flashx', reasoningEffort: 'medium' }, decision: { provider: '', model: '' } } })
    assert.equal(good.statusCode, 200, good.body)
    assert.equal(state.config.decision.provider, undefined, 'an empty provider follows the main conversation')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('after a reminder, the agent\'s next steps are read from the session events', () => {
  const after = new Aftermath()
  after.watch({ decisionId: 'd1', sessionId: 's', cwd: 'C:/p', boundary: 'tool', blocked: true, callId: 'push', deliveredCards: ['halt'], seq: 40 })
  assert.deepEqual(after.push({ type: 'tool/call', seq: 41, data: { callId: 'push', name: 'bash', arguments: { command: 'git push' } } }), [])
  after.push({ type: 'assistant/message', data: { message: { content: '我先确认一下是否可以推送。' } } })
  after.push({ type: 'tool/call', seq: 43, data: { callId: 'st', name: 'bash', arguments: { command: 'git status' } } })
  after.push({ type: 'tool/result', data: { message: { source: { callId: 'st' }, content: 'clean\n[exit code: 0]' } } })
  const [record] = after.flush('new-turn')
  assert.equal(record.kind, 'aftermath')
  assert.equal(record.decisionId, 'd1')
  assert.equal(record.reply, '我先确认一下是否可以推送。')
  assert.deepEqual(record.actions.map((item) => [item.callId, item.status, item.seq]), [['push', 'blocked', 41], ['st', 'ok', 43]])
  assert.equal(record.actions[1].target, 'git status')
})

test('the trail carries each decision\'s aftermath and the compile view gets parts and a log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eng-visual-'))
  try {
    const { appendDecision } = await import('../lib/store.js')
    const { decisionsPayload } = await import('../lib/dashboard.js')
    const config = normalizeConfig({ stateDir: root }, root)
    await appendDecision(config, { kind: 'decision', decisionId: 'd1', cwd: root, sessionId: 's', boundary: 'tool', injected: true, selected: ['halt'] })
    await appendDecision(config, { kind: 'aftermath', decisionId: 'd1', cwd: root, sessionId: 's', actions: [{ callId: 'c', status: 'ok' }] })
    const trail = await decisionsPayload({ config }, root, new URLSearchParams(), { scope: 'session', sessionId: 's' })
    assert.equal(trail.items.length, 1, 'aftermath records are not trail rows')
    assert.equal(trail.items[0].after.actions[0].callId, 'c')

    const llm = { async prepareCall(cfg) { return { config: cfg, async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ cards: [{ id: 'c', title: 'c', quote: 'Keep the body intact.', when: 'x', triggers: ['edit'], satisfiedWhen: 'y', rules: ['do'] }], relations: [] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } } }
    const state = { config, graphs: new Map(), compileAbort: new AbortController() }
    const agent = { options: { provider: 'mock', model: 'mock' }, session: { id: 's', header: { cwd: root } } }
    const body = '# A\nKeep the body intact.'
    const ctx = { get: (name) => name === 'llm' ? llm : { async list() { return [{ name: 'alpha', description: 'a' }] }, async get() { return { name: 'alpha', description: 'a', content: body } } } }
    void wantSkill(ctx, state, agent, 'alpha')
    await refreshSkills(ctx, state, agent, { wait: true })
    const status = compileStatusFor(state, agent, root)
    assert.deepEqual(status.skills.alpha.segments.map((segment) => segment.state), ['done'])
    assert.equal(status.skills.alpha.length, body.length)
    assert.ok(status.log.some((item) => item.skill === 'alpha' && /准备好了，整理出 1 条规则/.test(item.text)))
    assert.equal(compileSummary(status), '1 个 skill 全部就绪')
  } finally { await rm(root, { recursive: true, force: true }) }
})
