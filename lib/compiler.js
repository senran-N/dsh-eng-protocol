import { agentCwd, compilerRoute, loadProjectConfig, skillAllowed } from './config.js'
import { CompileJobs, PRIORITY, skillIdentity } from './compile-jobs.js'
import { buildGraph } from './skill-graph.js'
import { loadLatest, loadPart, loadPreparation, loadSkillRecord, saveLatest, savePart, savePreparation, saveSkillRecord } from './store.js'
import { errorMessage, nowIso } from './text.js'

export { buildGraph, entryCard, normalizeCompiled, normalizeSkill, skillPrefix, slug } from './skill-graph.js'

/**
 * Skills, per agent. Each agent sees its own catalog (the host's catalog is
 * scope-sensitive, even for agents sharing a cwd); new skills route on their
 * catalog entry alone. Previously compiled skills and saved manual requests
 * are restored on discovery, checking the current source and reusing stored
 * parts. Otherwise a skill is read in full only once the agent loads it (or a
 * person asks to prepare it). Its rules join the graph part by part as they are
 * ready. A changed skill keeps guarding with its previous compile until the new
 * text is complete. Compiles themselves are shared by every agent and project
 * (see compile-jobs.js).
 */

// Skill definitions read in parallel.
const READ_CONCURRENCY = 8
// Entries kept in each agent's activity log.
const LOG_LIMIT = 80

function jobsOf(ctx, state) {
  state.compileContext = ctx
  state.compileJobs ??= new CompileJobs({
    store: {
      loadPart: (key) => loadPart(state.config, key),
      savePart: (key, value) => savePart(state.config, key, value),
      loadSkillRecord: (key) => loadSkillRecord(state.config, key),
      saveSkillRecord: (key, value) => saveSkillRecord(state.config, key, value),
      loadLatest: (identity) => loadLatest(state.config, identity),
      saveLatest: (identity, key) => saveLatest(state.config, identity, key),
    },
    llm: () => state.compileContext?.get?.('llm'),
    onUpdate: (job, event) => jobChanged(state, job, event),
  })
  return state.compileJobs
}

function viewFor(state, agent) {
  state.skillViews ??= new WeakMap()
  let view = state.skillViews.get(agent)
  if (!view) {
    view = {
      agent,
      cwd: agentCwd(agent),
      project: undefined,
      summaries: new Map(),
      sources: new Map(),
      // Skills this agent loaded (or the user invoked), and skills a person asked to prepare.
      wanted: new Set(),
      requested: new Set(),
      // Source identities checked for completed compiles or saved manual requests.
      restored: new Set(),
      jobs: new Map(),
      // The previous complete compile of a skill whose current text is still compiling.
      stale: new Map(),
      failures: new Map(),
      listed: false,
      listError: undefined,
      log: [],
      queue: Promise.resolve(),
      ready: undefined,
      graph: undefined,
      updatedAt: undefined,
    }
    state.skillViews.set(agent, view)
  }
  return view
}

/** Run catalog work for one view in order: a refresh and a skill load never interleave. */
function serial(view, task) {
  const run = view.queue.catch(() => undefined).then(task)
  view.queue = run.then(() => undefined, () => undefined)
  return run
}

function note(view, skill, text, level = 'info') {
  view.log.push({ at: nowIso(), skill, text, level })
  if (view.log.length > LOG_LIMIT) view.log.shift()
  view.updatedAt = nowIso()
}

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))} 秒`

const compiledOf = (job) => ({
  ...job.result,
  compiledAt: job.finishedAt,
  sourceHash: job.key,
  document: { lineCount: job.document.lineCount, headings: job.document.headings, references: job.document.references },
})

/** Rebuild one agent's graph from its catalog and compiles. */
function publish(state, view) {
  const config = view.project?.config ?? state.config
  const entries = new Map()
  for (const [name, summary] of view.summaries) {
    const source = view.sources.get(name)
    const job = view.jobs.get(name)
    const entry = { summary, ...(source && !source.error ? { source } : {}) }
    if (job?.complete) entry.compiled = compiledOf(job)
    else if (view.stale.has(name)) entry.stale = view.stale.get(name)
    else if (job?.result?.cards.length) entry.partial = compiledOf(job)
    entries.set(name, entry)
  }
  view.graph = buildGraph(view.cwd, entries, config?.builtinCards !== false)
  state.graphs?.set(view.cwd, view.graph)
  view.updatedAt = nowIso()
  return view.graph
}

/** A compile changed: tell every agent that uses it, in words, and republish their graphs. */
function jobChanged(state, job, event) {
  for (const view of job.owners.keys()) {
    const name = [...view.jobs].find(([, value]) => value === job)?.[0]
    if (!name) continue
    view.updatedAt = nowIso()
    if (event === 'progress') continue
    if (event === 'started') note(view, name, '开始准备')
    if (event === 'complete') {
      view.stale.delete(name)
      view.failures.delete(name)
      const kept = state.compileJobs.status(job).kept
      if (job.worked && !kept) note(view, name, `已就绪，整理出 ${job.result.cards.length} 条规则${job.durationMs ? `，用时 ${seconds(job.durationMs)}` : ''}`, 'ok')
    }
    if (event === 'failed') {
      const status = state.compileJobs.status(job)
      const key = `${status.state}:${status.kind}`
      if (view.failures.get(name) !== key) {
        view.failures.set(name, key)
        if (status.state === 'failed') note(view, name, `没准备好：${status.hint}`, 'bad')
        else if (status.state === 'retrying') note(view, name, `有一部分还没准备好：${status.hint}`, 'warn')
        else if (status.kept) note(view, name, `重新编译没完成，继续用之前的规则：${status.hint}`, 'warn')
      }
    }
    publish(state, view)
  }
}

async function mapLimit(items, limit, task) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Read one skill's full definition. A failed re-read keeps the last good text. */
async function readSource(ctx, state, view, name) {
  const summary = view.summaries.get(name)
  const previous = view.sources.get(name)
  try {
    const definition = await ctx.get('skills').get(name, { cwd: view.cwd, scope: view.agent, signal: state.compileAbort?.signal })
    if (!definition) throw new Error('宿主未返回 skill 定义')
    if (definition.name !== name) throw new Error('skill 定义名称与目录不一致')
    const content = typeof definition.content === 'string' ? definition.content : ''
    if (!content.trim()) throw new Error('skill 正文为空')
    view.sources.set(name, { ...summary, ...definition, path: definition.path ?? summary.path, content })
  } catch (error) {
    if (previous && !previous.error) return
    view.sources.set(name, { ...summary, error: errorMessage(error) })
  }
}

function detach(state, view, name) {
  const job = view.jobs.get(name)
  if (job) state.compileJobs?.release(job, view)
  view.jobs.delete(name)
  view.stale.delete(name)
  view.failures.delete(name)
}

/** Compile the skill's current text for this view; a new text replaces the old job, whose result guards meanwhile. */
function attach(ctx, state, view, name, { rebuild = false, retry = false } = {}) {
  const source = view.sources.get(name)
  if (!source || source.error) { detach(state, view, name); return }
  const jobs = jobsOf(ctx, state)
  const config = view.project?.config ?? state.config
  let job
  try {
    job = jobs.job(source, { route: compilerRoute(view.agent, config), config })
  } catch (error) {
    view.sources.set(name, { ...source, error: errorMessage(error) })
    detach(state, view, name)
    return
  }
  const previous = view.jobs.get(name)
  if (previous !== job) {
    if (previous?.complete) view.stale.set(name, compiledOf(previous))
    if (previous) jobs.release(previous, view)
    view.jobs.set(name, job)
    view.failures.delete(name)
    if (!view.stale.has(name)) {
      void jobs.previous(source, job.key).then((graph) => {
        if (!graph || view.jobs.get(name) !== job || job.complete || view.stale.has(name)) return
        view.stale.set(name, graph)
        publish(state, view)
      }).catch(() => undefined)
    }
  }
  jobs.want(job, view, view.wanted.has(name) ? PRIORITY.use : PRIORITY.prepare)
  if (rebuild) jobs.rebuild(job)
  else if (retry) jobs.retry(job)
}

/** Restore only skills visible to this agent; preparing them never marks them loaded. */
async function restorePreparations(state, view) {
  await mapLimit([...view.summaries], READ_CONCURRENCY, async ([name, source]) => {
    const identity = skillIdentity(source)
    if (view.restored.has(identity) || view.wanted.has(name) || view.requested.has(name)) return
    view.restored.add(identity)
    const [requested, key] = await Promise.all([
      loadPreparation(state.config, view.cwd, identity),
      loadLatest(state.config, identity),
    ])
    const record = key ? await loadSkillRecord(state.config, key) : undefined
    if (requested || (record && skillIdentity(record) === identity)) view.requested.add(name)
  })
}

/** Keep manual preparation across restart, even if compilation has not finished. */
async function rememberPreparation(state, view, name) {
  const source = view.summaries.get(name)
  if (!source) return
  try {
    await savePreparation(state.config, view.cwd, skillIdentity(source))
  } catch (error) {
    note(view, name, `准备请求未能保存，重启后可能需要再次准备：${errorMessage(error)}`, 'bad')
  }
}

/**
 * Read one agent's catalog. Skills it uses, manually requested skills and
 * previously compiled skills are restored; `rebuild` (true, or names) compiles them again
 * from scratch and `retry` retries their failed parts now.
 */
async function readCatalog(ctx, state, view, { rebuild, retry }) {
  const cwd = agentCwd(view.agent)
  if (cwd !== view.cwd) {
    for (const name of [...view.jobs.keys()]) detach(state, view, name)
    view.cwd = cwd
    view.summaries = new Map()
    view.sources = new Map()
    view.requested.clear()
    view.restored.clear()
  }
  const project = await loadProjectConfig(cwd, state.config)
  view.project = project
  state.projectConfigs?.set(cwd, project)
  const config = project.config
  const service = ctx.get?.('skills')
  if (!service || config.skills.enabled === false) {
    for (const name of [...view.jobs.keys()]) detach(state, view, name)
    view.summaries = new Map()
    view.sources = new Map()
    view.listed = true
    view.listError = undefined
    return publish(state, view)
  }
  try {
    const listed = await service.list({ cwd, scope: view.agent, signal: state.compileAbort?.signal })
    if (!Array.isArray(listed)) throw new Error('宿主返回的 skill 列表不是数组')
    view.summaries = new Map(listed
      .filter((summary) => typeof summary?.name === 'string' && skillAllowed(summary.name, config))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((summary) => [summary.name, summary]))
    view.listError = undefined
  } catch (error) {
    // Keep the last good catalog: a transient listing failure must not drop skills in use.
    view.listError = `skill 列表读取失败：${errorMessage(error)}`
    note(view, undefined, '读不到 skill 列表，先沿用上一次的结果', 'bad')
    return publish(state, view)
  }
  view.listed = true
  await restorePreparations(state, view)
  const named = Array.isArray(rebuild) ? rebuild.filter((name) => view.summaries.has(name)) : []
  for (const name of named) if (!view.wanted.has(name)) view.requested.add(name)
  await mapLimit(named, READ_CONCURRENCY, (name) => rememberPreparation(state, view, name))
  const names = [...new Set([...view.wanted, ...view.requested])].filter((name) => view.summaries.has(name))
  for (const name of [...view.jobs.keys()]) if (!names.includes(name)) detach(state, view, name)
  for (const name of [...view.sources.keys()]) if (!names.includes(name)) view.sources.delete(name)
  await mapLimit(names, READ_CONCURRENCY, (name) => readSource(ctx, state, view, name))
  for (const name of names) attach(ctx, state, view, name, { rebuild: rebuild === true || named.includes(name), retry })
  return publish(state, view)
}

/**
 * Refresh one agent's catalog, restore prepared skills and compile current sources as needed.
 * `rebuild` (true, or skill names) recompiles from scratch while the current
 * rules keep guarding; `retry` retries failed parts now; `wait` also waits for
 * this agent's compiles to settle.
 */
export async function refreshSkills(ctx, state, agent, { rebuild, retry = false, wait = false } = {}) {
  const view = viewFor(state, agent)
  const run = serial(view, () => readCatalog(ctx, state, view, { rebuild, retry }))
  view.ready ??= run.then(() => undefined, () => undefined)
  const graph = await run
  if (!wait) return graph
  await settleCompiles(state, agent)
  return graphFor(state, view.cwd, agent)
}

async function use(ctx, state, view, name) {
  if (!view.listed || !view.summaries.has(name)) return
  if (!view.sources.get(name) || view.sources.get(name).error) await readSource(ctx, state, view, name)
  attach(ctx, state, view, name)
  publish(state, view)
}

/**
 * The agent uses this skill now (it loaded it, or the user invoked it): compile
 * its current text unless that is already stored. Safe before the catalog
 * arrives; the first refresh picks it up.
 */
export function wantSkill(ctx, state, agent, name) {
  const view = viewFor(state, agent)
  view.wanted.add(name)
  view.requested.delete(name)
  if (!view.listed) return Promise.resolve()
  return serial(view, () => use(ctx, state, view, name))
}

/** A person wants to see this skill's rules before any agent loads it. */
export function prepareSkill(ctx, state, agent, name) {
  const view = viewFor(state, agent)
  if (!view.wanted.has(name)) view.requested.add(name)
  return serial(view, async () => {
    if (!view.listed) await readCatalog(ctx, state, view, {})
    await rememberPreparation(state, view, name)
    await use(ctx, state, view, name)
  })
}

/** Prepare every idle skill in this agent's catalog; existing work and finished compiles are kept. */
export function prepareAllSkills(ctx, state, agent) {
  const view = viewFor(state, agent)
  return serial(view, async () => {
    if (!view.listed) await readCatalog(ctx, state, view, {})
    const names = [...view.summaries.keys()].filter((name) => !view.wanted.has(name) && !view.requested.has(name))
    for (const name of names) view.requested.add(name)
    publish(state, view)
    await mapLimit(names, READ_CONCURRENCY, (name) => rememberPreparation(state, view, name))
    await mapLimit(names, READ_CONCURRENCY, (name) => use(ctx, state, view, name))
  })
}

/** Wait until none of this agent's compiles is loading, queued or running (failed parts may wait for a retry). */
export async function settleCompiles(state, agent) {
  const view = state.skillViews?.get(agent)
  if (!view) return
  for (;;) {
    await view.queue
    const jobs = [...view.jobs.values()]
    const busy = jobs.filter((job) => !state.compileJobs?.idle(job))
    if (busy.length === 0) return
    await Promise.all(busy.map((job) => state.compileJobs.settled(job)))
  }
}

/** Resolves once an agent's first catalog is published (no model call involved); immediate before any refresh. */
export function graphReady(state, agent) {
  return state.skillViews?.get(agent)?.ready ?? Promise.resolve()
}

/** Whether this agent's catalog has really been read (a skill missing from it has left). */
export function catalogListed(state, agent) {
  return Boolean(state.skillViews?.get(agent)?.listed)
}

/** Plugin teardown: nothing compiles or retries after the plugin is gone. Resolves once pending writes are done. */
export async function stopCompiles(state) {
  await state.compileJobs?.stop()
}

/** An agent went away: its compiles lose this owner, and a compile nobody waits for leaves the queue. */
export function forgetAgent(state, agent) {
  const view = state.skillViews?.get(agent)
  if (!view) return
  for (const name of [...view.jobs.keys()]) detach(state, view, name)
  state.skillViews.delete(agent)
}

/** What the last compile call actually sent, when it differs from the setting (e.g. a fitted reasoning effort). */
export function compileFitNote(state) {
  return state.compileJobs?.fit?.note
}

const SOURCE_HINT = '读不到这个 skill 的内容，请检查它的 SKILL.md 是否存在、是否为空。'

function skillStatus(state, view, name) {
  const inUse = view.wanted.has(name) || view.requested.has(name)
  const source = view.sources.get(name)
  if (source?.error) return { state: 'failed', kind: 'source', hint: SOURCE_HINT, error: source.error, inUse, stale: view.stale.has(name) }
  const job = view.jobs.get(name)
  if (!job) return { state: inUse ? 'queued' : 'standby', inUse }
  return { ...state.compileJobs.status(job), inUse: true, stale: !job.complete && view.stale.has(name) }
}

/** Compile status of one agent's catalog, or undefined before its first listing. */
export function compileStatusFor(state, agent, cwd) {
  const view = agent ? state.skillViews?.get(agent) : undefined
  if (!view || (cwd && view.cwd !== cwd) || (!view.listed && !view.listError)) return undefined
  const skills = {}
  for (const name of view.summaries.keys()) skills[name] = skillStatus(state, view, name)
  const all = Object.values(skills)
  const count = (...states) => all.filter((item) => states.includes(item.state)).length
  const inUse = all.filter((item) => item.inUse)
  const config = view.project?.config ?? state.config
  const route = compilerRoute(view.agent, config)
  return {
    cwd: view.cwd,
    total: view.summaries.size,
    inUse: inUse.length,
    ready: count('ready'),
    working: count('queued', 'compiling'),
    retrying: count('retrying'),
    failed: count('failed'),
    standby: count('standby'),
    running: count('queued', 'compiling') > 0,
    errors: [view.listError, ...Object.entries(skills).filter(([, item]) => item.state === 'failed').map(([name, item]) => `skill ${name}：${item.hint ?? item.error}`)].filter(Boolean),
    skills,
    log: view.log,
    route: route ? `${route.provider}/${route.model}` : undefined,
    startedAt: inUse.map((item) => item.startedAt).filter(Boolean).sort()[0],
    finishedAt: inUse.map((item) => item.finishedAt).filter(Boolean).sort().at(-1),
    updatedAt: view.updatedAt,
    retryAt: all.map((item) => item.nextRetryAt).filter(Boolean).sort()[0],
  }
}

/** Compile status for a project summary: the most recently active agent in that project. */
export function projectCompileStatus(state, cwd) {
  const views = []
  for (const agent of state.liveAgents ?? []) {
    const view = state.skillViews?.get(agent)
    if (view?.cwd === cwd && (view.listed || view.listError)) views.push(view)
  }
  views.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  return views[0] ? compileStatusFor(state, views[0].agent, cwd) : undefined
}

/**
 * The graph an agent judges against: its own catalog once listed, the
 * built-ins until then. Never another agent's catalog: scopes differ even in
 * one project. Without an agent, the project's most recently published graph.
 */
export function graphFor(state, cwd, agent) {
  if (agent) {
    const view = state.skillViews?.get(agent)
    return view?.graph && view.cwd === cwd ? view.graph : buildGraph(cwd, new Map(), state.config?.builtinCards !== false)
  }
  return state.graphs?.get(cwd) ?? buildGraph(cwd, new Map(), state.config?.builtinCards !== false)
}

/** An in-memory part store, for compiling outside the plugin. */
export function memoryStore() {
  const parts = new Map()
  const records = new Map()
  const latest = new Map()
  return {
    parts,
    loadPart: async (key) => parts.get(key),
    savePart: async (key, value) => { parts.set(key, structuredClone(value)) },
    loadSkillRecord: async (key) => records.get(key),
    saveSkillRecord: async (key, value) => { records.set(key, structuredClone(value)) },
    loadLatest: async (identity) => latest.get(identity),
    saveLatest: async (identity, key) => { latest.set(identity, key) },
  }
}

/**
 * Compile one skill outside any agent (tests, tools): resolves with its graph
 * once every part is done, or rejects with the first failure that remains
 * after the in-run retries. Nothing is retried in the background.
 */
export async function compileSkill(llm, route, skill, config, { signal, store = memoryStore(), onUpdate } = {}) {
  const jobs = new CompileJobs({ store, llm: () => llm, onUpdate: (job, event) => onUpdate?.(jobs.status(job), event) })
  const stop = () => jobs.stop()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const job = jobs.job(skill, { route, config })
    const owner = {}
    jobs.want(job, owner)
    await jobs.settled(job)
    signal?.throwIfAborted()
    const status = jobs.status(job)
    if (status.state !== 'ready') throw Object.assign(new Error(status.error || status.hint || '编译失败'), { kind: status.kind })
    return { name: skill.name, ...compiledOf(job) }
  } finally {
    signal?.removeEventListener('abort', stop)
    await jobs.stop()
  }
}
