// Adaptive control, resumable compilation and retry: no budgets, real recovery.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ENG_PROTOCOL_RETRY_BASE_MS = '1'
const { AdaptiveLimiter, AdaptiveRegistry, LatencyTracker, classifyError, withRetry } = await import('../lib/adaptive.js')
const { cancelCompile, compileSkill, graphFor, refreshSkills, skillPrefix } = await import('../lib/compiler.js')
const { normalizeConfig, saveUserSettings } = await import('../lib/config.js')
const { evaluateDecision } = await import('../lib/decide.js')
const { BUILTIN_CARDS } = await import('../lib/cards.js')
const { cachePath } = await import('../lib/store.js')
const { compileSummary } = await import('../lib/dashboard.js')

const route = { provider: 'mock', model: 'mock' }
const config = normalizeConfig({}, process.cwd())
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fake host LLM: `reply(prompt, index)` returns text, `{ text, finish }`, or throws. */
function fakeLlm(reply) {
  const prompts = []
  return {
    prompts,
    async prepareCall(callConfig) {
      return {
        config: callConfig,
        async *stream({ messages }) {
          const prompt = messages[0].content[0].text
          prompts.push({ prompt, maxTokens: callConfig.maxTokens })
          const out = await reply(prompt, prompts.length - 1, callConfig)
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
const smallParts = () => {
  const control = new AdaptiveRegistry().for('compiler', route)
  control.size.value = 2000
  return control
}

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

test('output cut at the model cap splits the part instead of failing', async () => {
  const control = new AdaptiveRegistry().for('compiler', route)
  const llm = fakeLlm((prompt) => bodyOf(prompt).length > 3000
    ? { text: '{"entry":{"when":"w","points":["a"', finish: 'max-tokens' }
    : compiled(prompt))
  const skill = longSkill()
  const graph = await compileSkill(llm, route, skill, config, undefined, { control })
  assert.ok(graph.coverage.splits >= 1, 'the oversized part was halved')
  const accepted = llm.prompts.map((item) => bodyOf(item.prompt)).filter((body) => body.length <= 3000)
  assert.equal(accepted.reduce((sum, body) => sum + body.length, 0), skill.content.length, 'every character still reaches the compiler')
  assert.ok(accepted.every((body) => skill.content.includes(body)))
  assert.ok(control.size.current < 24000, 'later skills start with a smaller part size')
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
  const checkpoint = { parts: {} }
  const skill = longSkill()
  const failing = fakeLlm((prompt) => {
    if (bodyOf(prompt).includes('END')) throw Object.assign(new Error('bad key'), { status: 401 })
    return compiled(prompt)
  })
  await assert.rejects(compileSkill(failing, route, skill, config, undefined, { control: smallParts(), checkpoint }), /bad key/)
  const saved = Object.keys(checkpoint.parts).length
  assert.ok(saved >= 2, 'finished parts were checkpointed before the failure')
  const healthy = fakeLlm((prompt) => compiled(prompt))
  const graph = await compileSkill(healthy, route, skill, config, undefined, { control: smallParts(), checkpoint })
  assert.equal(healthy.prompts.length, 1, 'only the failed part is sent again')
  assert.match(bodyOf(healthy.prompts[0].prompt), /END/)
  assert.equal(graph.coverage.resumedParts, saved)
})

test('editing the end of a skill recompiles only the changed part', async () => {
  const checkpoint = { parts: {} }
  const first = fakeLlm((prompt) => compiled(prompt))
  await compileSkill(first, route, longSkill('END'), config, undefined, { control: smallParts(), checkpoint })
  const second = fakeLlm((prompt) => compiled(prompt))
  const graph = await compileSkill(second, route, longSkill('CHANGED'), config, undefined, { control: smallParts(), checkpoint })
  assert.equal(second.prompts.length, 1)
  assert.match(bodyOf(second.prompts[0].prompt), /CHANGED/)
  assert.ok(graph.coverage.resumedParts >= 2)
})

/** A minimal state + ctx around refreshSkills, with a cache dir of its own. */
async function project({ reply, skills = ['alpha', 'beta'], content = (name) => `# ${name}\nbody` }) {
  const root = await mkdtemp(join(tmpdir(), 'eng-adaptive-'))
  const cfg = normalizeConfig({ stateDir: root }, root)
  const llm = fakeLlm(reply)
  const host = { skills, content }
  const ctx = {
    logger: { warn() {}, info() {} },
    get: (name) => name === 'llm' ? llm : {
      async list() { return host.skills.map((name) => ({ name, description: name, path: `/s/${name}/SKILL.md` })) },
      async get(name) { return { name, description: name, path: `/s/${name}/SKILL.md`, content: host.content(name) } },
    },
  }
  const state = { config: cfg, graphs: new Map(), compileStatus: new Map(), compileAbort: new AbortController() }
  const agent = { options: route, session: { id: 's', header: { cwd: root } } }
  const status = () => state.skillViews.get(agent).compileStatus.get(root)
  return { root, cfg, llm, host, ctx, state, agent, status, done: () => rm(root, { recursive: true, force: true }) }
}

test('a failed skill keeps a hint, schedules a retry, and a retry compiles only it', async () => {
  let broken = true
  const env = await project({ reply: (prompt) => (broken && prompt.includes('SKILL NAME: beta') ? (() => { throw Object.assign(new Error('upstream 502'), { status: 502 }) })() : compiled(prompt)) })
  try {
    await refreshSkills(env.ctx, env.state, env.agent)
    const entry = env.status().skills.beta
    assert.equal(entry.state, 'failed')
    assert.equal(entry.kind, 'server')
    assert.match(entry.hint, /自动再试/)
    assert.ok(Date.parse(entry.nextRetryAt) > Date.now(), 'a background retry is scheduled')
    assert.equal(entry.attempts, 4, 'transient failures were retried before giving up')
    assert.match(compileSummary(env.status()), /1 个 skill 没准备好，其余 1 个正常，.* 会自动再试/)
    broken = false
    const before = env.llm.prompts.length
    const graph = await refreshSkills(env.ctx, env.state, env.agent, { queue: true })
    assert.equal(env.llm.prompts.length - before, 1, 'the cached skill is not recompiled')
    assert.equal(graph.graphs.length, 2)
    assert.equal(env.status().skills.beta.state, 'done')
    const cache = JSON.parse(await readFile(cachePath(env.cfg, env.root), 'utf8'))
    assert.deepEqual(Object.keys(cache.failures), [], 'the failure record is cleared on success')
  } finally { await env.done() }
})

test('a changed skill that fails to recompile keeps guarding with its last good graph', async () => {
  let fail = false
  const env = await project({ skills: ['alpha'], reply: (prompt) => (fail ? (() => { throw Object.assign(new Error('bad key'), { status: 401 }) })() : compiled(prompt)) })
  try {
    await refreshSkills(env.ctx, env.state, env.agent)
    fail = true
    env.host.content = () => '# alpha\nchanged body'
    const graph = await refreshSkills(env.ctx, env.state, env.agent)
    assert.equal(graph.graphs.length, 1)
    assert.equal(graph.graphs[0].stale, true)
    assert.equal(env.status().skills.alpha.stale, true)
    assert.equal(env.status().skills.alpha.nextRetryAt, undefined, 'a permanent failure does not auto-retry')
  } finally { await env.done() }
})

test('cancel stops a compile and keeps finished parts for the next run', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await project({ skills: ['alpha', 'beta'], reply: async (prompt) => { if (prompt.includes('SKILL NAME: beta')) await gate; return compiled(prompt) } })
  try {
    const running = refreshSkills(env.ctx, env.state, env.agent)
    await sleep(30)
    assert.equal(cancelCompile(env.state, env.agent), true)
    release()
    await running
    assert.equal(env.status().cancelled, true)
    assert.equal(env.status().skills.beta.state, 'cancelled')
    const before = env.llm.prompts.length
    await refreshSkills(env.ctx, env.state, env.agent)
    assert.equal(env.llm.prompts.length - before, 1, 'alpha finished before the cancel and stays cached')
  } finally { await env.done() }
})

test('a legacy graph without budget losses is migrated instead of recompiled', async () => {
  const env = await project({ skills: ['alpha'], reply: (prompt) => compiled(prompt) })
  try {
    await refreshSkills(env.ctx, env.state, env.agent)
    const path = cachePath(env.cfg, env.root)
    const cache = JSON.parse(await readFile(path, 'utf8'))
    cache.skills.alpha.compilerVersion = 2
    cache.skills.alpha.compileKey = 'old-key'
    await writeFile(path, JSON.stringify(cache))
    const before = env.llm.prompts.length
    await refreshSkills(env.ctx, env.state, env.agent)
    assert.equal(env.llm.prompts.length, before, 'no model call for an equivalent old graph')
    assert.equal(env.status().migrated, 1)
    cache.skills.alpha.omissions = [{ id: 'x', reason: 'budget' }]
    // Old caches never carried part checkpoints.
    cache.partials = {}
    await writeFile(path, JSON.stringify(cache))
    await refreshSkills(env.ctx, env.state, env.agent)
    assert.equal(env.llm.prompts.length, before + 1, 'a graph that lost cards to the old budget is recompiled')
    assert.equal(graphFor(env.state, env.root, env.agent).graphs[0].entry.id, `${skillPrefix('alpha')}_entry`)
  } finally { await env.done() }
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
