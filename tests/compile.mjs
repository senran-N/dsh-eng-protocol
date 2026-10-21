// Skill compilation: numbered statements, streamed answers, parts shared by
// text, one queue with priorities, background recovery and plain-language status.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ENG_PROTOCOL_RETRY_BASE_MS = '1'
const { CompileJobs, PRIORITY } = await import('../lib/compile-jobs.js')
const { partKey, skillIdentity, skillKey } = await import('../lib/compile-jobs.js')
const { compileSkill, compileStatusFor, forgetAgent, graphFor, memoryStore, prepareAllSkills, prepareSkill, refreshSkills, settleCompiles, stopCompiles, wantSkill } = await import('../lib/compiler.js')
const { extractPart, extractPrompt, lineReader } = await import('../lib/extract.js')
const { streamModel } = await import('../lib/model.js')
const { parseSkillSource, statementsOf } = await import('../lib/skill-source.js')
const { normalizeConfig } = await import('../lib/config.js')
const { compileSummary, skillDetail } = await import('../lib/dashboard.js')

const route = { provider: 'mock', model: 'mock' }
const config = normalizeConfig({}, process.cwd())
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fake host LLM: `reply(prompt, index, signal)` returns text, `{ text, finish }`, or throws. Text streams line by line. */
function fakeLlm(reply) {
  const prompts = []
  return {
    prompts,
    async prepareCall(callConfig) {
      return {
        config: callConfig,
        async *stream({ messages, signal }) {
          const prompt = messages[0].content[0].text
          prompts.push(prompt)
          const out = await reply(prompt, prompts.length - 1, signal)
          const { text, finish = 'stop' } = typeof out === 'string' ? { text: out } : out
          for (const line of text.split(/(?<=\n)/)) yield { type: 'text-delta', text: line }
          yield { type: 'finish', reason: { kind: finish } }
        },
      }
    },
  }
}

const statementsIn = (prompt) => [...prompt.matchAll(/^\[(\d+)\] (.*)$/gm)].map((match) => ({ n: Number(match[1]), text: match[2] }))
const skillOf = (prompt) => /^SKILL: (.+)$/m.exec(prompt)?.[1]
const sectionOf = (prompt) => /^THIS PART: .*under "(.+)"$/m.exec(prompt)?.[1] ?? ''
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }) }

/** The model's answer: one line per "must" statement, cited by number, then the end marker. */
function answer(prompt, extra = {}) {
  const lines = statementsIn(prompt).filter((item) => /\bmust\b/.test(item.text))
    .map((item) => JSON.stringify({ id: `r${item.n}`, s: [item.n, item.n], title: item.text.slice(0, 24), on: ['edit'], ...extra }))
  return [...lines, '{"end":true}'].join('\n')
}

/** A skill body: `sections` sections of 70 rules each, every section long enough to be its own part. */
function body(name, sections = 1, tag = '') {
  const lines = [`# ${name}`]
  for (let section = 1; section <= sections; section += 1) {
    lines.push(`## Part ${section}`)
    for (let rule = 1; rule <= 70; rule += 1) lines.push(`- Rule ${section}.${rule} of ${name} must hold${tag}.`)
  }
  return lines.join('\n')
}

async function eventually(check, what = 'background work', timeout = 4000) {
  const until = Date.now() + timeout
  while (!(await check())) {
    assert.ok(Date.now() < until, `${what} did not happen in time`)
    await sleep(5)
  }
}

/** A plugin state, a fake host catalog and one agent, with a state directory of their own. */
async function project({ reply = (prompt) => answer(prompt), skills = { alpha: body('alpha'), beta: body('beta') } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'eng-compile-'))
  const cfg = normalizeConfig({ stateDir: join(root, 'state') }, root)
  const llm = fakeLlm(reply)
  const host = { skills: { ...skills }, gets: [] }
  const service = {
    async list() { return Object.keys(host.skills).map((name) => ({ name, description: `${name} skill`, path: `/s/${name}/SKILL.md` })) },
    async get(name) {
      host.gets.push(name)
      return host.skills[name] === undefined ? undefined : { name, description: `${name} skill`, path: `/s/${name}/SKILL.md`, content: host.skills[name] }
    },
  }
  const ctx = { get: (name) => (name === 'llm' ? llm : name === 'skills' ? service : undefined) }
  const state = { config: cfg, graphs: new Map(), compileAbort: new AbortController(), liveAgents: new Set() }
  const agentIn = (id, cwd = root, target = state) => {
    const agent = { options: route, session: { id, header: { cwd } } }
    target.liveAgents.add(agent)
    return agent
  }
  const agent = agentIn('s')
  return {
    root, cfg, llm, host, ctx, state, agent, agentIn,
    status: (who = agent, cwd = root, target = state) => compileStatusFor(target, who, cwd),
    rules: (name, who = agent, cwd = root, target = state) => graphFor(target, cwd, who).cards.filter((card) => card.skill === name && !card.entry),
    async use(name, who = agent, target = state) {
      await refreshSkills(ctx, target, who)
      await wantSkill(ctx, target, who, name)
    },
    async done() {
      await stopCompiles(state)
      await rm(root, { recursive: true, force: true })
    },
  }
}

// ---- the model contract -------------------------------------------------------

test('the prompt numbers the statements, lists the moments and asks for JSON Lines', () => {
  const document = parseSkillSource({ name: 'pg', content: '# Postgres\n## Migrations\nAlways take a snapshot before a migration.' })
  const part = document.parts[0]
  const prompt = extractPrompt({ skill: { name: 'pg', description: 'db' }, document, part, statements: statementsOf(document, part) })
  assert.match(prompt, /^\[3\] Always take a snapshot before a migration\.$/m)
  assert.match(prompt, /^edit — about to change a file$/m)
  assert.match(prompt, /^halt — /m, 'built-in cards are listed for "covers"')
  assert.match(prompt, /\{"end":true\}/)
})

test('a cut-off answer keeps every complete line and continues after the last statement it reached', async () => {
  const document = parseSkillSource({ name: 'long', content: body('long') })
  const part = document.parts[0]
  const statements = statementsOf(document, part)
  const llm = fakeLlm((prompt, index) => {
    const lines = answer(prompt).split('\n').filter((line) => !line.includes('"end"'))
    if (index === 0) return { text: `${lines.slice(0, 30).join('\n')}\n{"id":"r99","s":[9`, finish: 'max-tokens' }
    return [...lines, '{"end":true}'].join('\n')
  })
  // [1] # long  [2] ## Part 1  [3]…[72] the rules: the cut answer reached statement 32.
  const out = await extractPart(llm, route, { skill: { name: 'long' }, document, part, statements }, { timeoutMs: 5000 })
  assert.equal(llm.prompts.length, 2)
  assert.match(llm.prompts[1], /CONTINUE: obligations stated before statement 33 are already recorded/)
  assert.doesNotMatch(llm.prompts[1], /^\[32\] /m, 'the continuation shows only what is left')
  assert.equal(out.obligations.length, 70, 'nothing lost and nothing twice')
  assert.deepEqual(out.obligations.map((item) => item.s[0]), Array.from({ length: 70 }, (_, index) => index + 3))
})

test('one malformed line costs only itself; an answer with nothing readable is bad output', async () => {
  const records = []
  const reader = lineReader((value) => records.push(value))
  reader.push('```jsonl\n{"id":"a","s":[1,1]}\n{"id":"b","s":[2,\n')
  reader.push('{"id":"c","s":[3,3]},\nnot json\n{"end":true}')
  reader.end()
  assert.deepEqual(records.map((item) => item.id), ['a', 'c'])
  assert.deepEqual([reader.state.bad, reader.state.ended], [2, true])
  const document = parseSkillSource({ name: 'x', content: '# X\nYou must do it.' })
  const part = document.parts[0]
  const prose = fakeLlm(() => 'I think the skill says you must do it.')
  await assert.rejects(extractPart(prose, route, { skill: { name: 'x' }, document, part, statements: statementsOf(document, part) }, { timeoutMs: 5000 }),
    (error) => error.kind === 'bad-output')
})

test('truncation after the final obligation still completes relations with original source and stable ids', async () => {
  const document = parseSkillSource({ name: 'migration', content: '# Migration\nTake a snapshot.\nRun the migration only after taking a snapshot.' })
  const part = document.parts[0]
  const llm = fakeLlm((prompt, index) => {
    if (index === 0) return { text: '{"id":"backup","s":[2,2]}\n{"id":"migrate","s":[3,3]}\n', finish: 'max-tokens' }
    assert.match(prompt, /"id":"backup"/)
    assert.match(prompt, /Run the migration only after taking a snapshot/)
    assert.match(prompt, /EARLIER SOURCE/)
    return '{"rel":"requires","from":"backup","to":"migrate","s":[3,3]}\n{"end":true}'
  })
  const records = await extractPart(llm, route, { skill: { name: 'migration' }, document, part, statements: statementsOf(document, part) })
  assert.equal(llm.prompts.length, 2)
  assert.equal(records.obligations.length, 2)
  assert.deepEqual(records.relations, [{ rel: 'requires', from: 'backup', to: 'migrate', s: [3, 3] }])
})

test('a prompt-version upgrade keeps the legacy compile guarding while new parts are prepared', async () => {
  const source = { name: 'legacy', path: '/skills/legacy/SKILL.md', content: '# Legacy\nYou must preserve the contract.' }
  const document = parseSkillSource(source)
  const store = memoryStore()
  const legacyKey = 'old-skill-key'
  await store.saveLatest(skillIdentity(source), legacyKey)
  await store.saveSkillRecord(legacyKey, { ...source, compiledAt: '2026-01-01' })
  await store.savePart(partKey(document.parts[0], 1), { obligations: [{ id: 'contract', s: [2, 2], on: ['edit'] }], relations: [] })
  const jobs = new CompileJobs({ store, llm: () => fakeLlm(prompt => answer(prompt)) })
  try {
    assert.notEqual(partKey(document.parts[0]), partKey(document.parts[0], 1))
    const old = await jobs.previous(source, skillKey(source, document.content))
    assert.equal(old.cards.length, 1)
    assert.equal(old.cards[0].quote, 'You must preserve the contract.')
    assert.equal(old.compiledAt, '2026-01-01')
  } finally { await jobs.stop() }
})

test('a call that goes silent is cut off; a call that keeps streaming never is', async () => {
  const streaming = { async prepareCall(cfg) { return { config: cfg, async *stream() {
    for (let index = 0; index < 8; index += 1) { await sleep(40); yield { type: 'text-delta', text: `{"n":${index}}\n` } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } } }
  const seen = []
  const done = await streamModel(streaming, route, { prompt: 'x', timeoutMs: 5000, firstChunkTimeoutMs: 200, idleTimeoutMs: 100, onDelta: (text) => seen.push(text) })
  assert.equal(seen.length, 8, 'every chunk reaches the caller as it arrives')
  assert.match(done.text, /"n":7/)
  const stalled = { async prepareCall(cfg) { return { config: cfg, async *stream({ signal }) {
    yield { type: 'text-delta', text: '{"n":0}\n' }
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } } } }
  const started = performance.now()
  await assert.rejects(streamModel(stalled, route, { prompt: 'x', timeoutMs: 5000, firstChunkTimeoutMs: 200, idleTimeoutMs: 100 }),
    (error) => error.name === 'TimeoutError' && /没有输出/.test(error.message))
  assert.ok(performance.now() - started < 1500)
})

// ---- one skill ------------------------------------------------------------------

test('every obligation the skill states becomes a grounded rule with its exact text and lines', async () => {
  const llm = fakeLlm((prompt) => answer(prompt))
  const graph = await compileSkill(llm, route, { name: 'big', content: body('big'), path: '/s/big/SKILL.md' }, config)
  assert.equal(llm.prompts.length, 1)
  assert.equal(graph.cards.length, 70, 'no card budget')
  assert.ok(graph.cards.every((card) => card.grounded && card.sourceRef.precise))
  assert.equal(graph.cards[0].quote, 'Rule 1.1 of big must hold.')
  assert.equal(graph.cards[0].source, '/s/big/SKILL.md#body:L3-L3')
})

test('stored answers are reused by text: a rename, a move, a new description or model, and edits elsewhere cost nothing', async () => {
  const store = memoryStore()
  const llm = fakeLlm((prompt) => answer(prompt))
  const content = body('docs', 3)
  await compileSkill(llm, route, { name: 'docs', content, path: '/a/docs/SKILL.md', description: 'one' }, config, { store })
  assert.equal(llm.prompts.length, 3, 'one call per section')
  const moved = await compileSkill(llm, { provider: 'other', model: 'better' }, { name: 'renamed', content, path: '/b/x/SKILL.md', description: 'two' }, config, { store })
  assert.equal(llm.prompts.length, 3)
  assert.equal(moved.cards.length, 210)
  assert.ok(moved.cards.every((card) => card.id.startsWith('skill_renamed_')))
  const edited = content.replace('Rule 1.5 of docs must hold.', 'Rule 1.5 of docs must hold, and be logged.')
  const graph = await compileSkill(llm, route, { name: 'docs', content: edited, path: '/a/docs/SKILL.md' }, config, { store })
  assert.equal(llm.prompts.length, 4, 'only the edited section is sent again')
  assert.match(llm.prompts[3], /be logged/)
  assert.equal(graph.cards.length, 210)
})

test('a compile interrupted by a failure resumes from the parts already done', async () => {
  const store = memoryStore()
  const content = body('resume', 2)
  const failing = fakeLlm((prompt) => (sectionOf(prompt).endsWith('Part 2') ? fail(401, 'bad key') : answer(prompt)))
  await assert.rejects(compileSkill(failing, route, { name: 'resume', content }, config, { store }), (error) => error.kind === 'auth')
  assert.equal(store.parts.size, 1, 'the finished part was stored before the failure')
  const healthy = fakeLlm((prompt) => answer(prompt))
  const graph = await compileSkill(healthy, route, { name: 'resume', content }, config, { store })
  assert.equal(healthy.prompts.length, 1, 'only the failed part is sent again')
  assert.match(sectionOf(healthy.prompts[0]), /Part 2$/)
  assert.equal(graph.cards.length, 140)
})

test('transient failures are retried inside the run; failures retrying cannot fix stop at once', async () => {
  const llm = fakeLlm((prompt, index) => (index === 0 ? fail(429, 'rate limited') : index === 1 ? 'not an answer at all' : answer(prompt)))
  const graph = await compileSkill(llm, route, { name: 'flaky', content: body('flaky') }, config)
  assert.equal(llm.prompts.length, 3)
  assert.equal(graph.cards.length, 70)
  const denied = fakeLlm(() => fail(401, 'bad key'))
  await assert.rejects(compileSkill(denied, route, { name: 'denied', content: body('denied') }, config), (error) => error.kind === 'auth')
  assert.equal(denied.prompts.length, 1)
})

test('skills an agent uses jump ahead of skills a person asked to prepare', async () => {
  const order = []
  const llm = fakeLlm(async (prompt) => { order.push(skillOf(prompt)); await sleep(5); return answer(prompt) })
  const jobs = new CompileJobs({ store: memoryStore(), llm: () => llm, onUpdate: () => {} })
  const lane = jobs.lane(route)
  Object.assign(lane.limiter, { limit: 1, min: 1, max: 1 })
  try {
    const later = jobs.job({ name: 'later', content: body('later', 3) }, { route, config })
    const now = jobs.job({ name: 'now', content: body('now') }, { route, config })
    jobs.want(later, 'person', PRIORITY.prepare)
    await eventually(() => order.length === 1, 'the first prepared part')
    jobs.want(now, 'agent', PRIORITY.use)
    await Promise.all([jobs.settled(later), jobs.settled(now)])
    assert.deepEqual(order, ['later', 'now', 'later', 'later'], 'the skill in use goes next')
  } finally { await jobs.stop() }
})

// ---- skills for an agent --------------------------------------------------------

test('reading a catalog reads no skill body and calls no model; a skill compiles once the agent uses it', async () => {
  const env = await project()
  try {
    const graph = await refreshSkills(env.ctx, env.state, env.agent, { wait: true })
    assert.deepEqual(env.host.gets, [], 'routing needs the catalog entry only')
    assert.equal(env.llm.prompts.length, 0)
    assert.deepEqual(graph.graphs.map((skill) => [skill.name, skill.cards.length]), [['alpha', 0], ['beta', 0]])
    assert.ok(graph.graphs.every((skill) => skill.entry.entry))
    assert.equal(env.status().skills.alpha.state, 'standby')
    assert.equal(compileSummary(env.status()), '2 个 skill 用到时自动准备')
    await wantSkill(env.ctx, env.state, env.agent, 'alpha')
    await settleCompiles(env.state, env.agent)
    assert.deepEqual(env.host.gets, ['alpha'])
    assert.equal(env.llm.prompts.length, 1)
    assert.equal(env.status().skills.alpha.state, 'ready')
    assert.equal(env.status().skills.beta.state, 'standby')
    assert.equal(env.rules('alpha').length, 70)
    assert.equal(compileSummary(env.status()), '用到的 1 个 skill 都已就绪')
    assert.ok(env.status().log.some((item) => item.skill === 'alpha' && /已就绪，整理出 70 条规则/.test(item.text)))
    // A person can prepare a skill nobody has loaded yet.
    await prepareSkill(env.ctx, env.state, env.agent, 'beta')
    await settleCompiles(env.state, env.agent)
    assert.deepEqual([env.status().skills.beta.state, env.status().skills.beta.inUse], ['ready', true])
  } finally { await env.done() }
})

test('prepare all adds only idle skills, keeps existing work and stays within the selected agent', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await project({
    skills: Object.fromEntries(['alpha', 'beta', 'gamma', 'delta'].map((name) => [name, body(name)])),
    reply: async (prompt) => { if (skillOf(prompt) !== 'alpha') await gate; return answer(prompt) },
  })
  try {
    const other = env.agentIn('other')
    await refreshSkills(env.ctx, env.state, other)
    await env.use('alpha')
    await settleCompiles(env.state, env.agent)
    await prepareSkill(env.ctx, env.state, env.agent, 'beta')
    await eventually(() => env.status().skills.beta.state === 'compiling')
    await Promise.all([
      prepareAllSkills(env.ctx, env.state, env.agent),
      prepareAllSkills(env.ctx, env.state, env.agent),
    ])
    assert.equal(env.status().standby, 0)
    assert.equal(env.status().skills.alpha.state, 'ready')
    assert.equal(env.status().inUse, 4)
    assert.deepEqual(env.host.gets.slice().sort(), ['alpha', 'beta', 'delta', 'gamma'], 'existing bodies are not re-read')
    assert.equal(env.status(other).standby, 4, 'the other session is untouched')
    assert.deepEqual([...env.state.skillViews.get(env.agent).wanted], ['alpha'], 'preparation does not mark skills loaded')
    release()
    await settleCompiles(env.state, env.agent)
    assert.equal(env.status().ready, 4)
    assert.deepEqual(env.llm.prompts.map(skillOf).sort(), ['alpha', 'beta', 'delta', 'gamma'], 'each skill compiles once')
    await prepareAllSkills(env.ctx, env.state, env.agent)
    assert.equal(env.llm.prompts.length, 4, 'clicking again preserves finished work')
  } finally { release(); await env.done() }
})

test('prepare all reads an initial catalog and respects the project skill exclusions', async () => {
  const env = await project()
  try {
    env.cfg.skills.exclude = ['beta']
    await prepareAllSkills(env.ctx, env.state, env.agent)
    await settleCompiles(env.state, env.agent)
    assert.deepEqual(env.host.gets, ['alpha'])
    assert.deepEqual(Object.keys(env.status().skills), ['alpha'])
    assert.equal(env.status().ready, 1)
  } finally { await env.done() }
})

test('a missing skill body in prepare all does not stop the other skills', async () => {
  const env = await project({ skills: { alpha: '', beta: body('beta') } })
  try {
    await prepareAllSkills(env.ctx, env.state, env.agent)
    await settleCompiles(env.state, env.agent)
    assert.equal(env.status().skills.alpha.state, 'failed')
    assert.equal(env.status().skills.beta.state, 'ready')
    assert.equal(env.status().standby, 0)
  } finally { await env.done() }
})

test('a fresh plugin instance restores completed skills without clicking prepare or calling the model', async () => {
  const env = await project()
  const restarted = { config: env.cfg, graphs: new Map(), compileAbort: new AbortController(), liveAgents: new Set() }
  try {
    // Cover old caches too: loading a skill saves a complete compile without a manual request.
    await env.use('alpha')
    await prepareSkill(env.ctx, env.state, env.agent, 'beta')
    await settleCompiles(env.state, env.agent)
    await stopCompiles(env.state)
    const calls = env.llm.prompts.length
    env.host.skills.gamma = body('gamma')
    env.host.gets.length = 0
    const later = env.agentIn('later', env.root, restarted)
    await refreshSkills(env.ctx, restarted, later, { wait: true })
    const status = env.status(later, env.root, restarted)
    assert.deepEqual([status.ready, status.standby], [2, 1])
    assert.equal(env.rules('alpha', later, env.root, restarted).length, 70)
    assert.equal(env.rules('beta', later, env.root, restarted).length, 70)
    assert.deepEqual(env.host.gets.sort(), ['alpha', 'beta'], 'only previously compiled skill bodies are checked')
    assert.equal(env.llm.prompts.length, calls, 'restoring disk caches makes no model call')
    assert.equal(restarted.skillViews.get(later).wanted.size, 0, 'cached rules do not imply the agent loaded a skill')
  } finally { await stopCompiles(restarted); await env.done() }
})

test('an unfinished manual preparation resumes after restart and only compiles the missing part', async () => {
  let broken = true
  const env = await project({
    skills: { long: body('long', 3) },
    reply: (prompt) => broken && sectionOf(prompt).endsWith('Part 3') ? fail(401, 'bad key') : answer(prompt),
  })
  const restarted = { config: env.cfg, graphs: new Map(), compileAbort: new AbortController(), liveAgents: new Set() }
  try {
    await prepareAllSkills(env.ctx, env.state, env.agent)
    await settleCompiles(env.state, env.agent)
    assert.equal(env.status().skills.long.state, 'failed')
    assert.equal(env.rules('long').length, 140)
    const calls = env.llm.prompts.length
    await stopCompiles(env.state)
    broken = false
    const later = env.agentIn('later', env.root, restarted)
    await refreshSkills(env.ctx, restarted, later, { wait: true })
    assert.equal(env.status(later, env.root, restarted).ready, 1)
    assert.equal(env.rules('long', later, env.root, restarted).length, 210)
    assert.equal(env.llm.prompts.length, calls + 1)
    assert.ok(sectionOf(env.llm.prompts.at(-1)).endsWith('Part 3'))
  } finally { await stopCompiles(restarted); await env.done() }
})

test('cache recovery respects the new agent catalog and exclusions in the same folder', async () => {
  const env = await project()
  const restarted = { config: env.cfg, graphs: new Map(), compileAbort: new AbortController(), liveAgents: new Set() }
  try {
    await prepareAllSkills(env.ctx, env.state, env.agent)
    await settleCompiles(env.state, env.agent)
    await stopCompiles(env.state)
    const calls = env.llm.prompts.length
    env.cfg.skills.exclude = ['beta']
    env.host.gets.length = 0
    const later = env.agentIn('later', env.root, restarted)
    await refreshSkills(env.ctx, restarted, later, { wait: true })
    assert.deepEqual(Object.keys(env.status(later, env.root, restarted).skills), ['alpha'])
    assert.deepEqual(env.host.gets, ['alpha'])
    assert.equal(env.llm.prompts.length, calls)
    // An agent with an empty scoped catalog cannot recover another agent's rules.
    const hidden = env.agentIn('hidden', env.root, restarted)
    const scoped = { get: (name) => name === 'skills' ? { async list() { return [] }, async get() { assert.fail('an invisible skill must not be read') } } : env.ctx.get(name) }
    await refreshSkills(scoped, restarted, hidden, { wait: true })
    assert.equal(env.status(hidden, env.root, restarted).total, 0)
    assert.equal(graphFor(restarted, env.root, hidden).graphs.length, 0)
  } finally { await stopCompiles(restarted); await env.done() }
})

test('a long skill joins the graph part by part while it compiles', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await project({
    skills: { long: body('long', 3) },
    reply: async (prompt) => { if (sectionOf(prompt).endsWith('Part 3')) await gate; return answer(prompt) },
  })
  try {
    await env.use('long')
    await eventually(() => env.rules('long').length === 140, 'the first two parts')
    const working = env.status().skills.long
    assert.equal(working.state, 'compiling')
    assert.ok(working.progress > 0.5 && working.progress < 1, `progress ${working.progress}`)
    assert.match(skillDetail(working), /^\d+%，已找到 140 条规则$/)
    assert.equal(graphFor(env.state, env.root, env.agent).graphs[0].partial, true)
    release()
    await settleCompiles(env.state, env.agent)
    assert.equal(env.rules('long').length, 210)
    assert.equal(env.status().skills.long.state, 'ready')
  } finally { release(); await env.done() }
})

test('a failing part leaves the rest usable and recovers in the background', async () => {
  let broken = true
  const env = await project({
    skills: { long: body('long', 2) },
    reply: (prompt) => (broken && sectionOf(prompt).endsWith('Part 2') ? fail(502, 'upstream 502') : answer(prompt)),
  })
  try {
    await env.use('long')
    await settleCompiles(env.state, env.agent)
    const failed = env.status().skills.long
    assert.equal(failed.state, 'retrying')
    assert.equal(failed.rules, 70, 'the part that worked is in use')
    assert.equal(failed.kind, 'server')
    assert.match(skillDetail(failed), /^70 条规则可用。模型服务出错了/)
    assert.ok(Date.parse(failed.nextRetryAt) > Date.now())
    assert.equal(env.rules('long').length, 70)
    assert.match(compileSummary(env.status()), /部分就绪，其余部分稍后自动补齐/)
    broken = false
    await eventually(() => env.status().skills.long.state === 'ready', 'the background retry')
    assert.equal(env.rules('long').length, 140)
  } finally { await env.done() }
})

test('a route that answers again wakes its waiting failures without waiting out their backoff', async () => {
  process.env.ENG_PROTOCOL_RETRY_BASE_MS = '100'
  let broken = true, release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await project({
    reply: async (prompt) => {
      if (skillOf(prompt) === 'beta') { await gate; return answer(prompt) }
      return broken ? fail(502, 'upstream 502') : answer(prompt)
    },
  })
  try {
    await refreshSkills(env.ctx, env.state, env.agent)
    await wantSkill(env.ctx, env.state, env.agent, 'beta')
    await wantSkill(env.ctx, env.state, env.agent, 'alpha')
    await eventually(() => env.status().skills.alpha.state === 'retrying', 'the failure')
    const due = Date.parse(env.status().skills.alpha.nextRetryAt)
    broken = false
    release()
    await eventually(() => env.status().skills.alpha.state === 'ready', 'the recovery')
    assert.ok(Date.now() < due, 'woken before its backoff ran out')
  } finally {
    process.env.ENG_PROTOCOL_RETRY_BASE_MS = '1'
    release()
    await env.done()
  }
})

test('a provider Retry-After is honoured even when the route answers again', async () => {
  let broken = true, release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await project({
    reply: async (prompt) => {
      if (skillOf(prompt) === 'beta') { await gate; return answer(prompt) }
      return broken ? fail(503, 'busy', { retryAfterMs: 300 }) : answer(prompt)
    },
  })
  try {
    await refreshSkills(env.ctx, env.state, env.agent)
    await wantSkill(env.ctx, env.state, env.agent, 'beta')
    await wantSkill(env.ctx, env.state, env.agent, 'alpha')
    await eventually(() => env.status().skills.alpha.state === 'retrying', 'the failure')
    const waiting = env.status().skills.alpha
    assert.equal(waiting.retryReason, 'provider')
    broken = false
    release()
    await eventually(() => env.status().skills.alpha.state === 'ready', 'the retry')
    assert.ok(Date.now() >= Date.parse(waiting.nextRetryAt) - 5, 'not before the provider allowed it')
  } finally { release(); await env.done() }
})

test('a failure retrying cannot fix waits for an explicit retry and says what to do', async () => {
  let denied = true
  const env = await project({ skills: { alpha: body('alpha') }, reply: (prompt) => (denied ? fail(401, 'bad key') : answer(prompt)) })
  try {
    await env.use('alpha')
    await settleCompiles(env.state, env.agent)
    const failed = env.status().skills.alpha
    assert.deepEqual([failed.state, failed.nextRetryAt], ['failed', undefined])
    assert.match(failed.hint, /API key/)
    assert.match(skillDetail(failed), /API key/)
    assert.equal(compileSummary(env.status()), '1 个 skill 没准备好')
    await sleep(60)
    assert.equal(env.llm.prompts.length, 1, 'nothing retries on its own')
    denied = false
    await refreshSkills(env.ctx, env.state, env.agent, { retry: true, wait: true })
    assert.equal(env.status().skills.alpha.state, 'ready')
  } finally { await env.done() }
})

test('a changed skill keeps guarding with its previous compile until the new text is complete, after a restart too', async () => {
  let gate, release
  const env = await project({
    skills: { alpha: body('alpha') },
    reply: async (prompt) => { if (gate && /must hold now/.test(prompt)) await gate; return answer(prompt) },
  })
  const restarted = { config: env.cfg, graphs: new Map(), compileAbort: new AbortController(), liveAgents: new Set() }
  try {
    await env.use('alpha')
    await settleCompiles(env.state, env.agent)
    gate = new Promise((resolve) => { release = resolve })
    env.host.skills.alpha = body('alpha', 1, ' now')
    await refreshSkills(env.ctx, env.state, env.agent)
    await eventually(() => env.status().skills.alpha.state === 'compiling', 'the new text to compile')
    assert.equal(env.status().skills.alpha.stale, true)
    assert.equal(env.rules('alpha').length, 70)
    assert.ok(env.rules('alpha').every((card) => !card.quote.includes(' now')), 'the previous rules guard meanwhile')
    assert.match(skillDetail(env.status().skills.alpha), /期间继续用上一版规则/)
    // Another plugin instance (a restart) finds the previous compile on disk.
    const later = env.agentIn('later', env.root, restarted)
    await env.use('alpha', later, restarted)
    await eventually(() => env.rules('alpha', later, env.root, restarted).length === 70, 'the previous compile from disk')
    assert.equal(env.status(later, env.root, restarted).skills.alpha.stale, true)
    release()
    await settleCompiles(env.state, env.agent)
    await settleCompiles(restarted, later)
    assert.ok(env.rules('alpha').every((card) => card.quote.includes(' now')))
    assert.equal(env.status().skills.alpha.stale, false)
  } finally {
    release?.()
    await stopCompiles(restarted)
    await env.done()
  }
})

test('compiles are shared: two agents wait on one run, another project reuses it, one agent leaving cancels nothing', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const env = await project({ skills: { alpha: body('alpha') }, reply: async (prompt) => { await gate; return answer(prompt) } })
  const elsewhere = await mkdtemp(join(tmpdir(), 'eng-elsewhere-'))
  try {
    const sub = env.agentIn('sub')
    await Promise.all([env.use('alpha'), env.use('alpha', sub)])
    await eventually(() => env.llm.prompts.length === 1, 'the shared run')
    forgetAgent(env.state, env.agent)
    release()
    await settleCompiles(env.state, sub)
    assert.equal(env.llm.prompts.length, 1, 'one model run for both agents')
    assert.equal(env.status(sub).skills.alpha.state, 'ready')
    const visitor = env.agentIn('visitor', elsewhere)
    await env.use('alpha', visitor)
    await settleCompiles(env.state, visitor)
    assert.equal(env.rules('alpha', visitor, elsewhere).length, 70)
    assert.equal(env.llm.prompts.length, 1, 'no recompile per project')
  } finally {
    release()
    await rm(elsewhere, { recursive: true, force: true })
    await env.done()
  }
})

test('a rebuild compiles again while the current rules keep guarding; one that fails keeps them and says why', async () => {
  let mode = 'normal'
  const held = []
  const env = await project({
    skills: { alpha: body('alpha') },
    reply: async (prompt) => {
      if (mode === 'held') await new Promise((resolve) => held.push(resolve))
      if (mode === 'denied') fail(401, 'bad key')
      return answer(prompt, mode === 'held' ? { title: 'fresh' } : {})
    },
  })
  try {
    await env.use('alpha')
    await settleCompiles(env.state, env.agent)
    mode = 'held'
    await refreshSkills(env.ctx, env.state, env.agent, { rebuild: true })
    await eventually(() => held.length === 1, 'the rebuild call')
    assert.equal(env.status().skills.alpha.state, 'compiling')
    assert.equal(env.rules('alpha').length, 70, 'the current rules keep guarding')
    held[0]()
    await settleCompiles(env.state, env.agent)
    assert.ok(env.rules('alpha').every((card) => card.title === 'fresh'))
    mode = 'denied'
    await refreshSkills(env.ctx, env.state, env.agent, { rebuild: ['alpha'], wait: true })
    const kept = env.status().skills.alpha
    assert.deepEqual([kept.state, kept.kept, env.rules('alpha').length], ['ready', true, 70])
    assert.match(skillDetail(kept), /重新编译没完成，继续用之前的规则。API key/)
    assert.ok(env.status().log.some((item) => /重新编译没完成/.test(item.text)))
  } finally { await env.done() }
})

test('work nobody needs any more leaves the queue; what is already running finishes and is stored', async () => {
  const held = []
  const env = await project({ skills: { wide: body('wide', 8) }, reply: async (prompt) => { await new Promise((resolve) => held.push(resolve)); return answer(prompt) } })
  try {
    await env.use('wide')
    await eventually(() => held.length === 4, 'the first four parts')
    await sleep(30)
    assert.equal(env.llm.prompts.length, 4, 'the other parts wait for a slot')
    forgetAgent(env.state, env.agent)
    for (const open of held.splice(0)) open()
    const parts = join(env.cfg.stateDir, 'skills', 'v2', 'parts')
    await eventually(async () => (await readdir(parts).catch(() => [])).length === 4, 'the finished parts to be stored')
    await sleep(30)
    assert.equal(env.llm.prompts.length, 4, 'nobody needs the rest, so none of it runs')
  } finally { await env.done() }
})

test('status words say what is happening and what to do, never how it works inside', () => {
  const base = { total: 3, inUse: 2, ready: 0, working: 0, retrying: 0, failed: 0, errors: [] }
  assert.equal(compileSummary(undefined), '还没读取 skill 列表')
  assert.equal(compileSummary({ ...base, total: 0, inUse: 0 }), '这个项目没有 skill')
  assert.equal(compileSummary({ ...base, total: 0, inUse: 0, errors: ['x'] }), '读不到这个项目的 skill 列表')
  assert.equal(compileSummary({ ...base, inUse: 0 }), '3 个 skill 用到时自动准备')
  assert.equal(compileSummary({ ...base, working: 1, ready: 1 }), '正在准备 1 个 skill，1 个已就绪')
  assert.equal(compileSummary({ ...base, failed: 1, ready: 1 }), '1 个 skill 没准备好，其余 1 个正常')
  assert.equal(compileSummary({ ...base, ready: 2 }), '用到的 2 个 skill 都已就绪')
  assert.equal(skillDetail({ state: 'standby' }), '')
  assert.equal(skillDetail({ state: 'ready', rules: 12 }), '12 条规则')
  assert.equal(skillDetail({ state: 'queued', progress: 0 }), '0%')
  for (const text of [compileSummary({ ...base, working: 2 }), skillDetail({ state: 'compiling', progress: 0.4, rules: 3, found: 2, stale: true })]) {
    assert.doesNotMatch(text, /段|并发|p95|ms|判官|续传/, text)
  }
})
