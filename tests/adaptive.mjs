// Adaptive control, resumable compilation and retry: no budgets, real recovery.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ENG_PROTOCOL_RETRY_BASE_MS = '1'
const { AdaptiveLimiter, AdaptiveRegistry, AdaptiveSize, LatencyTracker, classifyError, sleep: waitFor, withRetry } = await import('../lib/adaptive.js')
const { cancelCompile, compileSkill, compileStatusFor, graphFor, memoryParts, refreshSkills, settleCompiles, stopCompiles, wantSkill } = await import('../lib/compiler.js')
const { decisionRoute, normalizeConfig, saveUserSettings } = await import('../lib/config.js')
const { evaluateDecision, packBatches, planRounds } = await import('../lib/decide.js')
const { BUILTIN_CARDS } = await import('../lib/cards.js')
const { compileSummary } = await import('../lib/dashboard.js')

const route = { provider: 'mock', model: 'mock' }
const config = normalizeConfig({}, process.cwd())
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fake host LLM: `reply(prompt, index, callConfig, signal)` returns text, `{ text, finish }`, or throws. */
function fakeLlm(reply) {
  const prompts = []
  return {
    prompts,
    async prepareCall(callConfig) {
      return {
        config: callConfig,
        async *stream({ messages, signal }) {
          const prompt = messages[0].content[0].text
          prompts.push({ prompt, maxTokens: callConfig.maxTokens })
          const out = await reply(prompt, prompts.length - 1, callConfig, signal)
          const { text, finish = 'stop' } = typeof out === 'string' ? { text: out } : out
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: finish } }
        },
      }
    },
  }
}

/** A compile reply with `count` section cards for whatever part was sent. */
function compiled(prompt, count = 2) {
  const part = /PART: (\d+)/.exec(prompt)?.[1] ?? '1'
  const [start, end] = (/body lines (\d+)–(\d+)/.exec(prompt) ?? [0, 1, 1]).slice(1).map(Number)
  return JSON.stringify({
    entry: { title: 'T', when: 'work', notApplicable: 'other work', points: ['p1', 'p2'] },
    cards: Array.from({ length: count }, (_, index) => ({ id: `c${part}_${start}_${index}`, title: `c${index}`, when: 'x', triggers: ['edit'], satisfiedWhen: 'y', rules: ['do'], sourceLines: [start, end] })),
    relations: [],
  })
}

const bodyOf = (prompt) => prompt.split('<skill>\n')[1]?.split('\n</skill>')[0] ?? ''
const longSkill = (marker = 'END') => ({
  name: 'long', path: '/s/long/SKILL.md', hash: 'h',
  content: ['# One', 'a'.repeat(1800), '## Two', 'b'.repeat(1800), '## Three', 'c'.repeat(1800), `## Four\n${marker}`].join('\n'),
})

test('errors are classified for retry and explained in plain language', () => {
  assert.equal(classifyError(Object.assign(new Error('slow down'), { status: 429, retryAfterMs: 2000 })).kind, 'rate-limit')
  assert.equal(classifyError(Object.assign(new Error('x'), { failure: { code: 'AUTH', message: 'bad key', status: 401 } })).kind, 'auth')
  assert.equal(classifyError(new DOMException('The operation was aborted due to timeout', 'TimeoutError')).kind, 'timeout')
  assert.equal(classifyError(Object.assign(new Error('cut'), { code: 'MAX_TOKENS' })).kind, 'truncated')
  assert.equal(classifyError(new Error('400 Incorrect role information')).kind, 'role')
  assert.equal(classifyError(new Error('入口卡缺少 when')).kind, 'bad-output')
  assert.equal(classifyError(new Error('fetch failed: ECONNRESET')).kind, 'network')
  for (const kind of ['auth', 'role', 'model', 'config']) assert.equal(classifyError(Object.assign(new Error('x'), { kind })).retryable, false)
  assert.match(classifyError(Object.assign(new Error('x'), { status: 401 })).hint, /API key/)
})

test('withRetry backs off on transient failures and stops at permanent ones', async () => {
  let calls = 0
  const retries = []
  const value = await withRetry(async () => {
    calls += 1
    if (calls < 3) throw Object.assign(new Error('busy'), { status: 503 })
    return 'ok'
  }, { onRetry: (info) => retries.push(info.info.kind) })
  assert.equal(value, 'ok')
  assert.deepEqual(retries, ['overloaded', 'overloaded'])
  calls = 0
  await assert.rejects(withRetry(async () => { calls += 1; throw Object.assign(new Error('nope'), { status: 401 }) }), (error) => error.classified.kind === 'auth' && error.attempts === 1)
  assert.equal(calls, 1)
})

test('the limiter is AIMD: halves on overload, grows back after successes, never exceeds capacity', async () => {
  const limiter = new AdaptiveLimiter({ initial: 4, min: 1, max: 6 })
  let active = 0, peak = 0
  await Promise.all(Array.from({ length: 12 }, () => limiter.run(async () => {
    active += 1; peak = Math.max(peak, active)
    await sleep(2)
    active -= 1
  })))
  assert.equal(peak, 4)
  limiter.overload()
  assert.equal(limiter.capacity, 2)
  for (let index = 0; index < 2; index += 1) limiter.succeed()
  assert.equal(limiter.capacity, 3)
  const aborted = new AbortController()
  const blockers = [limiter.acquire(), limiter.acquire(), limiter.acquire()]
  await Promise.all(blockers)
  const waiting = limiter.acquire(aborted.signal)
  aborted.abort(new Error('gone'))
  await assert.rejects(waiting, /gone/)
  assert.equal(limiter.snapshot().queued, 0, 'an aborted waiter leaves the queue')
})

test('timeouts follow observed latency below the hard ceiling', () => {
  const latency = new LatencyTracker()
  assert.equal(latency.timeout(15000), 15000, 'no samples: the ceiling applies')
  for (const ms of [400, 500, 600, 700]) latency.record(ms)
  const adaptive = latency.timeout(15000)
  assert.ok(adaptive >= 3000 && adaptive < 15000, `adaptive timeout ${adaptive}`)
  latency.record(40000)
  assert.equal(latency.timeout(15000), 15000, 'never above the ceiling')
})

test('a skill keeps every obligation: no card budget exists any more', async () => {
  const llm = fakeLlm((prompt) => compiled(prompt, 40))
  const graph = await compileSkill(llm, route, { name: 'big', content: '# Big\nmany rules', path: '/s/SKILL.md', hash: 'h' }, config)
  assert.equal(graph.cards.length, 40)
  assert.deepEqual(graph.omissions, [])
  assert.ok(!graph.warnings.some((warning) => warning.includes('预算')))
})

test('output cut at the model cap splits the part, remembers the split, and never resends it whole', async () => {
  const llm = fakeLlm((prompt) => bodyOf(prompt).length > 3000
    ? { text: '{"cards":[{"id":"x"', finish: 'max-tokens' }
    : compiled(prompt))
  const skill = longSkill()
  const parts = memoryParts()
  const graph = await compileSkill(llm, route, skill, config, undefined, { parts })
  assert.ok(graph.coverage.splits >= 1, 'the oversized part was halved')
  const accepted = llm.prompts.map((item) => bodyOf(item.prompt)).filter((body) => body.length <= 3000)
  assert.equal(accepted.reduce((sum, body) => sum + body.length, 0), skill.content.length, 'every character still reaches the compiler')
  assert.ok(accepted.every((body) => skill.content.includes(body)))
  const again = fakeLlm(() => { throw new Error('no model call expected') })
  const resumed = await compileSkill(again, route, skill, config, undefined, { parts })
  assert.equal(again.prompts.length, 0, 'the split and both halves resume from their checkpoints')
  assert.equal(resumed.cards.length, graph.cards.length)
})

test('transient compile failures are retried with progress reported', async () => {
  const llm = fakeLlm((prompt, index) => {
    if (index === 0) throw Object.assign(new Error('rate limited'), { status: 429 })
    if (index === 1) return 'not json at all'
    return compiled(prompt)
  })
  const phases = []
  const graph = await compileSkill(llm, route, { name: 'flaky', content: '# A\nbody', path: '/s/SKILL.md', hash: 'h' }, config, undefined, { onProgress: (progress) => phases.push(progress.phase) })
  assert.equal(graph.cards.length, 2)
  assert.equal(llm.prompts.length, 3)
  assert.equal(phases.filter((phase) => phase === 'retrying').length, 2)
})

test('an interrupted multi-part compile resumes from its checkpoint', async () => {
  const parts = memoryParts()
  const skill = longSkill()
  const failing = fakeLlm((prompt) => {
    if (bodyOf(prompt).includes('END')) throw Object.assign(new Error('bad key'), { status: 401 })
    return compiled(prompt)
  })
  await assert.rejects(compileSkill(failing, route, skill, config, undefined, { parts, partChars: 2000 }), /bad key/)
  const saved = parts.parts.size
  assert.ok(saved >= 2, 'finished parts were checkpointed before the failure')
  const healthy = fakeLlm((prompt) => compiled(prompt))
  const graph = await compileSkill(healthy, route, skill, config, undefined, { parts, partChars: 2000 })
  assert.equal(healthy.prompts.length, 1, 'only the failed part is sent again')
  assert.match(bodyOf(healthy.prompts[0].prompt), /END/)
  assert.equal(graph.coverage.resumedParts, saved)
})

test('editing the end of a skill recompiles only the changed part', async () => {
  const parts = memoryParts()
  const first = fakeLlm((prompt) => compiled(prompt))
  await compileSkill(first, route, longSkill('END'), config, undefined, { parts, partChars: 2000 })
  const second = fakeLlm((prompt) => compiled(prompt))
  const graph = await compileSkill(second, route, longSkill('CHANGED'), config, undefined, { parts, partChars: 2000 })
  assert.equal(second.prompts.length, 1)
  assert.match(bodyOf(second.prompts[0].prompt), /CHANGED/)
  assert.ok(graph.coverage.resumedParts >= 2)
})

/** A minimal state + ctx around refreshSkills, with a state directory of its own. */
async function project({ reply, skills = ['alpha', 'beta'], content = (name) => `# ${name}\nbody` }) {
  const root = await mkdtemp(join(tmpdir(), 'eng-adaptive-'))
  const cfg = normalizeConfig({ stateDir: join(root, 'state') }, root)
  const llm = fakeLlm(reply)
  const host = { skills, content }
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => name === 'llm' ? llm : {
      async list() { return host.skills.map((name) => ({ name, description: name, path: `/s/${name}/SKILL.md` })) },
      async get(name) { return { name, description: name, path: `/s/${name}/SKILL.md`, content: host.content(name) } },
    },
  }
  const state = { config: cfg, graphs: new Map(), compileAbort: new AbortController() }
  const agent = { options: route, session: { id: 's', header: { cwd: root } } }
  const status = (who = agent) => compileStatusFor(state, who, root)
  const done = async () => {
    stopCompiles(state)
    await rm(root, { recursive: true, force: true })
  }
  return { root, cfg, llm, host, ctx, state, agent, status, done }
}

const upstream502 = () => { throw Object.assign(new Error('upstream 502'), { status: 502 }) }
const badKey = () => { throw Object.assign(new Error('bad key'), { status: 401 }) }

test('reading a catalog compiles nothing; a skill compiles once the agent uses it', async () => {
  const env = await project({ reply: (prompt) => compiled(prompt) })
  try {
    const graph = await refreshSkills(env.ctx, env.state, env.agent, { wait: true })
    assert.equal(env.llm.prompts.length, 0, 'no model call for skills nobody loaded')
    assert.deepEqual(graph.graphs.map((skill) => [skill.name, skill.compiled, skill.cards.length]), [['alpha', false, 0], ['beta', false, 0]])
    assert.ok(graph.graphs.every((skill) => skill.entry.entry), 'entry cards come from the catalog alone')
    assert.equal(env.status().skills.alpha.state, 'standby')
    assert.match(compileSummary(env.status()), /用到时再准备/)
    await wantSkill(env.ctx, env.state, env.agent, 'alpha')
    await settleCompiles(env.state, env.agent)
    assert.equal(env.llm.prompts.length, 1)
    assert.equal(env.status().skills.alpha.state, 'done')
    assert.equal(env.status().skills.beta.state, 'standby')
  } finally { await env.done() }
})

test('a failed skill keeps a hint, schedules a retry, and a retry compiles only it', async () => {
  let broken = true
  const env = await project({ reply: (prompt) => (broken && prompt.includes('SKILL NAME: beta') ? upstream502() : compiled(prompt)) })
  try {
    for (const name of ['alpha', 'beta']) void wantSkill(env.ctx, env.state, env.agent, name)
    await refreshSkills(env.ctx, env.state, env.agent, { wait: true })
    const entry = env.status().skills.beta
    assert.equal(entry.state, 'failed')
    assert.equal(entry.kind, 'server')
    assert.match(entry.hint, /自动再试/)
    assert.ok(Date.parse(entry.nextRetryAt) > Date.now(), 'a background retry is scheduled')
    assert.equal(entry.attempts, 4, 'transient failures were retried before giving up')
    assert.match(compileSummary(env.status()), /1 个 skill 没准备好，其余 1 个正常，.* 会自动再试/)
    broken = false
    const before = env.llm.prompts.length
    const graph = await refreshSkills(env.ctx, env.state, env.agent, { queue: true, wait: true })
    assert.equal(env.llm.prompts.length - before, 1, 'the compiled skill is not compiled again')
    assert.equal(graph.graphs.filter((skill) => skill.compiled).length, 2)
    assert.equal(env.status().skills.beta.state, 'done')
    assert.equal(env.status().retryAt, undefined, 'the failure record is cleared on success')
  } finally { await env.done() }
})

test('a changed skill that fails to recompile keeps guarding with its last good graph', async () => {
  let fail = false
  const env = await project({ skills: ['alpha'], reply: (prompt) => (fail ? badKey() : compiled(prompt)) })
  try {
    void wantSkill(env.ctx, env.state, env.agent, 'alpha')
    await refreshSkills(env.ctx, env.state, env.agent, { wait: true })
    fail = true
    env.host.content = () => '# alpha\nchanged body'
    const graph = await refreshSkills(env.ctx, env.state, env.agent, { wait: true })
    assert.equal(graph.graphs.length, 1)
    assert.equal(graph.graphs[0].stale, true)
    assert.ok(graph.graphs[0].cards.length > 0, 'the last good obligations keep guarding')
    assert.equal(env.status().skills.alpha.state, 'failed')
    assert.equal(env.status().skills.alpha.stale, true)
    assert.equal(env.status().skills.alpha.nextRetryAt, undefined, 'a permanent failure does not auto-retry')
    // Another session starting now finds the last good compile on disk as well.
    const other = { options: route, session: { id: 's2', header: { cwd: env.root } } }
    assert.equal((await refreshSkills(env.ctx, env.state, other)).graphs[0].stale, true)
  } finally { await env.done() }
})

test('cancel stops a compile and keeps finished parts for the next run', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await project({ skills: ['alpha', 'beta'], reply: async (prompt) => { if (prompt.includes('SKILL NAME: beta')) await gate; return compiled(prompt) } })
  try {
    for (const name of ['alpha', 'beta']) void wantSkill(env.ctx, env.state, env.agent, name)
    await refreshSkills(env.ctx, env.state, env.agent)
    await sleep(30)
    assert.equal(cancelCompile(env.state, env.agent), true)
    release()
    await settleCompiles(env.state, env.agent)
    assert.equal(env.status().cancelled, true)
    assert.equal(env.status().skills.beta.state, 'cancelled')
    assert.equal(env.status().skills.alpha.state, 'done')
    const before = env.llm.prompts.length
    await refreshSkills(env.ctx, env.state, env.agent, { wait: true })
    assert.equal(env.llm.prompts.length, before, 'a paused skill stays paused across a refresh')
    await refreshSkills(env.ctx, env.state, env.agent, { queue: true, wait: true })
    assert.equal(env.llm.prompts.length - before, 1, 'retry resumes only the paused skill')
    assert.equal(env.status().skills.beta.state, 'done')
  } finally { await env.done() }
})

test('compiles are shared by content: two agents wait on one run, other projects reuse it, no scope can delete it', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await project({ skills: ['alpha'], reply: async (prompt) => { await gate; return compiled(prompt) } })
  const elsewhere = await mkdtemp(join(tmpdir(), 'eng-elsewhere-'))
  try {
    // A session and its subagent load the same skill at the same time.
    const subagent = { options: route, session: { id: 'sub', header: { cwd: env.root } } }
    for (const agent of [env.agent, subagent]) void wantSkill(env.ctx, env.state, agent, 'alpha')
    await Promise.all([refreshSkills(env.ctx, env.state, env.agent), refreshSkills(env.ctx, env.state, subagent)])
    await sleep(20)
    release()
    await Promise.all([settleCompiles(env.state, env.agent), settleCompiles(env.state, subagent)])
    assert.equal(env.llm.prompts.length, 1, 'one model run for both agents')
    assert.ok(graphFor(env.state, env.root, subagent).graphs[0].compiled)
    // A user-level skill opened from another project is not compiled again.
    const visitor = { options: route, session: { id: 'v', header: { cwd: elsewhere } } }
    void wantSkill(env.ctx, env.state, visitor, 'alpha')
    assert.ok((await refreshSkills(env.ctx, env.state, visitor, { wait: true })).graphs[0].compiled)
    assert.equal(env.llm.prompts.length, 1, 'no recompile per project')
    // An agent whose scope lists other skills leaves everyone else's compiles alone.
    env.host.skills = ['beta']
    await refreshSkills(env.ctx, env.state, visitor, { wait: true })
    env.host.skills = ['alpha']
    const late = { options: route, session: { id: 'late', header: { cwd: env.root } } }
    assert.ok((await refreshSkills(env.ctx, env.state, late)).graphs[0].compiled, 'still stored')
    assert.equal(env.llm.prompts.length, 1)
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
    await env.done()
  }
})

test('the judge splits a candidate set whose answer would not fit, and judges every card', async () => {
  const cards = Array.from({ length: 30 }, (_, index) => ({ id: `card_${index}`, title: `c${index}`, when: 'w', rules: ['r'], triggers: ['edit'], skill: 'x' }))
  const llm = fakeLlm((prompt) => {
    const ids = JSON.parse(prompt.split('CANDIDATE CARDS:\n')[1].split('\n\nCritical cards')[0]).map((card) => card.id)
    if (ids.length > 8) return { text: '{"cards":[{"id":"card_0"', finish: 'max-tokens' }
    return JSON.stringify({ cards: ids.map((id) => ({ id, state: id === 'card_29' ? 'needed' : 'satisfied', confidence: 0.9 })) })
  })
  const state = { config, adaptive: new AdaptiveRegistry() }
  const tracker = { agent: { options: route }, decisionTick: 0, cooldowns: new Map() }
  const result = await evaluateDecision({ get: () => llm }, state, tracker, {
    boundary: 'tool', triggers: ['edit'], candidates: cards, graph: { cards, relations: [], revision: 'r' }, ledger: {},
  })
  assert.equal(result.record.error, undefined)
  assert.equal(Object.keys(result.assessments).length, 30)
  assert.ok(Object.values(result.assessments).every((item) => item.state !== 'unknown'), 'no card was dropped')
  assert.deepEqual(result.cards.map((card) => card.id), ['card_29'])
  assert.ok(result.record.splits >= 1)
  const judge = state.adaptive.snapshot().find((entry) => entry.purpose === 'judge')
  assert.ok(judge.size.current <= 12, 'the batch size shrinks for the next judgment')
})

const ruleCard = (id, extra = {}) => ({ id, title: id, when: 'w', rules: ['r'], triggers: ['edit'], skill: 'x', ...extra })
const idsOf = (prompt) => JSON.parse(prompt.split('CANDIDATE CARDS:\n')[1].split('\n\nCritical cards')[0]).map((card) => card.id)
/** A judge answer for `ids`: satisfied unless `pick(id)` says otherwise. */
const answer = (ids, pick = () => ({})) => JSON.stringify({ cards: ids.map((id) => ({ id, state: 'satisfied', confidence: 0.9, ...pick(id) })) })
const judgeAgent = { options: route }
const judgeState = (raw = {}) => ({ config: normalizeConfig(raw, process.cwd()), adaptive: new AdaptiveRegistry() })
const judgeControl = (state) => state.adaptive.for('judge', decisionRoute(judgeAgent, state.config))
const decide = (llm, state, cards, snapshot = {}) => evaluateDecision({ get: () => llm }, state, { agent: judgeAgent, cooldowns: new Map() }, {
  boundary: 'tool', triggers: ['edit'], candidates: cards, graph: { cards, relations: [], revision: 'r' }, ledger: {}, ...snapshot,
})

test('the batch size grows only after full batches answered whole', async () => {
  const llm = fakeLlm((prompt) => answer(idsOf(prompt)))
  const state = judgeState()
  const small = Array.from({ length: 3 }, (_, index) => ruleCard(`small_${index}`))
  for (let run = 0; run < 12; run += 1) await decide(llm, state, small)
  assert.equal(judgeControl(state).size.current, 24, 'a 3-card judgment says nothing about a 24-card batch')
  const full = Array.from({ length: 24 }, (_, index) => ruleCard(`full_${index}`))
  for (let run = 0; run < 8; run += 1) await decide(llm, state, full)
  assert.equal(judgeControl(state).size.current, 30, 'eight full batches answered whole let it grow')
})

test('batches failing at the same size shrink it once; a smaller size failing halves it again', () => {
  const size = new AdaptiveSize({ initial: 24, min: 1, max: 64 })
  for (let batch = 0; batch < 4; batch += 1) size.shrink(24)
  assert.equal(size.current, 12)
  size.shrink(12)
  assert.equal(size.current, 6)
})

test('a time limit keeps the batches that answered, and a batch too slow for it shrinks the next ones', async () => {
  const llm = fakeLlm(async (prompt, index, callConfig, signal) => {
    const ids = idsOf(prompt)
    // The full batch never answers in time; the small one answers at once.
    if (ids.length > 6) await waitFor(5000, signal).catch(() => {})
    return answer(ids, (id) => (id === 'card_29' ? { state: 'needed' } : {}))
  })
  const state = judgeState({ decision: { timeoutMs: 800 } })
  const cards = Array.from({ length: 30 }, (_, index) => ruleCard(`card_${index}`))
  const result = await decide(llm, state, cards)
  assert.equal(result.record.deadlineExpired, true)
  assert.match(result.record.error, /一部分规则没在时限内检查完/)
  assert.deepEqual(result.cards.map((card) => card.id), ['card_29'], 'the batch that answered in time still delivers')
  assert.deepEqual(result.assessments.card_0, { state: 'unknown', confidence: 0, reason: '这条没在时限内检查完' })
  assert.equal(judgeControl(state).size.current, 12, 'the next judgment sends smaller batches')
})

test('a batch cut off while it waited for a slot does not shrink the size', async () => {
  const llm = fakeLlm(async (prompt, index, callConfig, signal) => {
    const ids = idsOf(prompt)
    // The first batch holds the only slot for two thirds of the limit; the
    // second starts late and is cut off soon after through no fault of its size.
    if (ids.length > 6) await sleep(1000)
    else await waitFor(5000, signal).catch(() => {})
    return answer(ids)
  })
  const state = judgeState({ decision: { timeoutMs: 1500 } })
  judgeControl(state).limiter.limit = 1
  const cards = Array.from({ length: 30 }, (_, index) => ruleCard(`card_${index}`))
  const result = await decide(llm, state, cards)
  assert.equal(result.record.deadlineExpired, true)
  assert.equal(result.assessments.card_0.state, 'satisfied')
  assert.equal(result.assessments.card_29.state, 'unknown')
  assert.equal(judgeControl(state).size.current, 24)
})

test('batches keep related rules together; skill membership joins nothing', () => {
  const cards = ['a', 'b', 'c', 'd'].map((id) => ruleCard(id))
  const ids = (batches) => batches.map((batch) => batch.map((card) => card.id))
  assert.deepEqual(ids(packBatches(cards, 2)), [['a', 'b'], ['c', 'd']])
  assert.deepEqual(ids(packBatches(cards, 2, [{ type: 'requires', source: 'b', target: 'd' }])), [['a'], ['b', 'd'], ['c']])
  assert.deepEqual(ids(packBatches(cards, 2, [{ type: 'contains', source: 'b', target: 'd' }])), [['a', 'b'], ['c', 'd']])
  // A group bigger than a batch is cut in order and its tail shares the next batch.
  const chain = [{ type: 'requires', source: 'a', target: 'b' }, { type: 'blocks', source: 'b', target: 'c' }]
  assert.deepEqual(ids(packBatches(cards, 2, chain)), [['a', 'b'], ['c', 'd']])
})

/** Two loaded skills: `keep` stays in scope, `drop` does not; each has three rules under its entry card. */
function layered() {
  const entry = (skill) => ruleCard(`skill_${skill}_entry`, { skill, entry: true, triggers: ['turn'] })
  const rules = (skill) => Array.from({ length: 3 }, (_, index) => ruleCard(`skill_${skill}_r${index}`, { skill, triggers: ['turn'] }))
  const cards = [entry('keep'), entry('drop'), ...rules('keep'), ...rules('drop')]
  const relations = cards.filter((card) => !card.entry).map((card) => ({ type: 'contains', source: `skill_${card.skill}_entry`, target: card.id }))
  const llm = fakeLlm((prompt) => answer(idsOf(prompt), (id) => (
    id === 'skill_drop_entry' ? { state: 'inapplicable' }
      : id === 'skill_keep_entry' ? { state: 'addressing' }
        : id === 'skill_keep_r0' ? { state: 'needed' } : {})))
  const snapshot = { boundary: 'request', triggers: ['turn'], graph: { cards, relations, revision: 'r' }, activeSkills: new Set(['keep', 'drop']) }
  return { cards, relations, llm, snapshot, asked: () => llm.prompts.map(({ prompt }) => idsOf(prompt)) }
}

test('a new turn too big for one wave judges entry cards first and expands only the skills still in scope', async () => {
  const { cards, llm, snapshot, asked } = layered()
  const state = judgeState()
  // Two cards a batch and two batches at a time: one wave holds four of the eight cards.
  judgeControl(state).size.value = 2
  judgeControl(state).limiter.limit = 2
  const result = await decide(llm, state, cards, snapshot)
  assert.deepEqual(asked()[0], ['skill_keep_entry', 'skill_drop_entry'], 'the entry cards go first, alone')
  assert.deepEqual(asked().slice(1).flat(), ['skill_keep_r0', 'skill_keep_r1', 'skill_keep_r2'], 'only the skill still in scope is expanded')
  assert.match(llm.prompts[1].prompt, /ASSESSMENTS ALREADY MADE AT THIS SAME BOUNDARY:\n\{"skill_keep_entry":\{"state":"addressing"/)
  assert.equal(result.record.rounds, 2)
  assert.deepEqual(result.cards.map((card) => card.id), ['skill_keep_r0'])
  assert.ok(result.record.candidates.includes('skill_drop_r0'), 'the rules left unexpanded are still listed')
  assert.equal(result.record.assessments.skill_drop_r0, undefined, 'and carry no made-up verdict')
  assert.deepEqual(result.record.reasons.skill_drop_r0, { kind: 'scope', by: 'skill_drop_entry' })
})

test('a new turn that fits in one wave is judged in one round', async () => {
  const { cards, llm, snapshot, asked } = layered()
  const result = await decide(llm, judgeState(), cards, snapshot)
  assert.equal(asked().length, 1)
  assert.equal(result.record.rounds, undefined)
  assert.deepEqual(result.cards.map((card) => card.id), ['skill_keep_r0'], 'a skill out of scope still delivers nothing')
})

test('the rules of a skill invoked this very step are never held back', () => {
  const { cards, relations } = layered()
  const plan = planRounds(cards, relations, { invoked: 'drop', wave: 0 })
  assert.deepEqual(plan.held.map((card) => card.id), ['skill_keep_r0', 'skill_keep_r1', 'skill_keep_r2'])
  assert.ok(plan.first.some((card) => card.id === 'skill_drop_r0'))
})

test('retired fields from older versions are ignored and silently removed on save', async () => {
  const home = await mkdtemp(join(tmpdir(), 'eng-deprecated-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await writeFile(join(home, 'eng-protocol.json'), JSON.stringify({ maxCards: 3, skills: { maxCardsPerSkill: 8, include: ['a'] }, decision: { boundaryBudgetMs: 9000 } }))
    const saved = await saveUserSettings({ runtime: { cooldownSteps: 4 } }, config, home)
    assert.deepEqual(saved.cleaned.sort(), ['decision.boundaryBudgetMs', 'maxCards', 'skills.maxCardsPerSkill'])
    const written = JSON.parse(await readFile(saved.path, 'utf8'))
    assert.deepEqual(written, { skills: { include: ['a'] }, decision: {}, cooldownSteps: 4 })
    await assert.rejects(saveUserSettings({ skills: { maxCardsPerSkill: 4 } }, config, home), /不允许/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('builtin ids stay disjoint from compiled skill ids', () => {
  assert.ok(BUILTIN_CARDS.every((card) => !card.id.startsWith('skill_')))
})
