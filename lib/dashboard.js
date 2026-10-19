import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { cancelCompile, compileStatusFor, graphFor, projectCompileStatus, refreshSkills } from './compiler.js'
import { agentCwd, decisionRoute, dshHome, mergeConfig, normalizeConfig, saveUserSettings, DASHBOARD_EDITABLE } from './config.js'
import { aggregate, decisionOutcome, readDecisions } from './store.js'
import { errorMessage, record } from './text.js'

const HERE = dirname(fileURLToPath(import.meta.url))
// Decisions per project the dashboard aggregates; the headline numbers cover this window.
const STATS_WINDOW = 400
const BOUNDARIES = new Set(['request', 'tool', 'settle'])
const OUTCOMES = new Set(['injected', 'blocked', 'shadow', 'failed', 'quiet'])

/** Human duration: 45 秒 / 3 分钟 / 1 小时 5 分. */
export function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`
}

/**
 * Estimated milliseconds until a running compile finishes: the mean time of the
 * skills finished in this run, times the skills still to go, over the current
 * adaptive concurrency. Unknown until at least one skill finished.
 */
export function compileEta(status, concurrency = 1) {
  if (!status?.running) return undefined
  const entries = Object.values(status.skills ?? {})
  const finished = entries.filter((entry) => entry.state === 'done' && Number.isFinite(entry.durationMs))
  const remaining = entries.filter((entry) => ['queued', 'compiling', 'retrying'].includes(entry.state)).length
  if (finished.length === 0 || remaining === 0) return undefined
  const mean = finished.reduce((sum, entry) => sum + entry.durationMs, 0) / finished.length
  return Math.round(mean * remaining / Math.max(1, concurrency))
}

/** One sentence a person can read: is everything ready, and if not, what happens next. */
export function compileSummary(status, concurrency = 1) {
  if (!status) return '还没开始准备 skill'
  const entries = Object.values(status.skills ?? {})
  const count = (...states) => entries.filter((entry) => states.includes(entry.state)).length
  const ready = count('cached', 'done')
  const failed = count('failed')
  const standby = count('standby')
  const total = status.total
  if (status.running) {
    const eta = compileEta(status, concurrency)
    return `${total} 个 skill 已就绪 ${ready} 个，正在准备 ${count('compiling', 'retrying', 'queued')} 个${eta ? `，大约还要 ${formatDuration(eta)}` : ''}`
  }
  if (status.cancelled) return `已暂停，${total} 个 skill 已就绪 ${ready} 个`
  if (failed) {
    const retry = status.retryAt ? `，${new Date(status.retryAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 会自动再试` : ''
    return `${failed} 个 skill 没准备好${ready ? `，其余 ${ready} 个正常` : ''}${retry}`
  }
  if (status.errors?.length && total === 0) return '读不到这个项目的 skill 列表'
  if (!total) return '这个项目没有 skill'
  if (standby === total) return `${total} 个 skill 都在用到时再准备`
  if (standby) return `${ready} 个 skill 已就绪，其余 ${standby} 个用到时再准备`
  return `${total} 个 skill 全部就绪`
}

function integerParam(value, min, max, fallback) {
  const number = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback
}

/** Lowercased text the trail search matches: cards, triggers, boundary, error and the judge's reasons. */
function searchText(record) {
  return [
    record.boundary,
    record.error,
    record.sessionId,
    ...(record.triggers ?? []),
    ...(record.candidates ?? []),
    ...Object.values(record.assessments ?? {}).map((item) => item?.reason),
  ].filter(Boolean).join('\n').toLowerCase()
}

/**
 * The decision trail for one project, newest first, filtered by boundary,
 * outcome (`failed` matches any decision with an error), session, candidate
 * card, and free text; paged by `limit` / `offset`.
 */
export async function decisionsPayload(state, cwd, params, identity) {
  const sessionFilter = identity?.scope === 'session' && identity.sessionId ? identity.sessionId : undefined
  const records = (await readDecisions(state.config, {
    cwd, limit: STATS_WINDOW, ...(sessionFilter ? { sessionId: sessionFilter } : {}),
  })).reverse()
  const boundary = params.get('boundary')
  const outcome = params.get('outcome')
  const session = params.get('session')
  const card = params.get('card')
  const query = (params.get('q') ?? '').trim().toLowerCase()
  const limit = integerParam(params.get('limit'), 1, 200, 50)
  const offset = integerParam(params.get('offset'), 0, STATS_WINDOW, 0)
  // What the agent did after each reminder lives beside the decisions in the same log.
  const after = new Map(records.filter((record) => record.kind === 'aftermath').map((record) => [record.decisionId, record]))
  const items = records.filter((record) => record.kind === 'decision').map((record) => after.has(record.decisionId) ? { ...record, after: after.get(record.decisionId) } : record).filter((record) => {
    if (BOUNDARIES.has(boundary) && record.boundary !== boundary) return false
    if (OUTCOMES.has(outcome) && (outcome === 'failed' ? !record.error : decisionOutcome(record) !== outcome)) return false
    if (session && String(record.sessionId ?? '') !== session) return false
    if (card && !(record.candidates ?? []).includes(card)) return false
    return !query || searchText(record).includes(query)
  })
  return { ok: true, cwd, window: STATS_WINDOW, total: items.length, offset, items: items.slice(offset, offset + limit) }
}

/**
 * Resolve the view's identity from the query string. A session tab always names
 * its session; a project summary must say `scope=project` explicitly. Without
 * either, the dashboard refuses to guess — showing another session's project is
 * worse than showing nothing.
 */
function requestedIdentity(state, req) {
  const url = new URL(String(req.url), 'http://localhost')
  const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
  const requestedCwd = (url.searchParams.get('cwd') ?? '').trim()
  const scope = url.searchParams.get('scope') === 'project' ? 'project' : 'session'
  const agent = sessionId ? state.agentBySession?.get(sessionId) : undefined
  if (scope === 'session') {
    if (!sessionId) return { url, error: '缺少 sessionId：请从会话内的 Eng Protocol 标签页打开面板。' }
    if (!agent) return { url, error: `会话 ${sessionId} 尚未运行或已结束；面板不显示其他会话的项目。` }
    return { url, scope, sessionId, agent, cwd: agentCwd(agent) }
  }
  if (!requestedCwd) return { url, error: '项目视图需要显式 cwd。' }
  if (!state.graphs?.has(requestedCwd)) return { url, error: `未知项目 ${requestedCwd}。` }
  return { url, scope, sessionId: sessionId || undefined, agent, cwd: requestedCwd }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function sendHtml(res, html) {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(html)
}

function sendMethod(res, method) {
  res.statusCode = 405
  res.setHeader('allow', method)
  res.end()
}

async function readBody(req, limit = 32_000) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * A state-changing call must come from the dashboard itself: browsers always
 * send Origin on POST, and a JSON content type cannot be sent cross-site
 * without a preflight this route never answers. Non-browser clients may omit Origin.
 */
function trustedPost(req) {
  const headers = req.headers ?? {}
  if (!/^application\/json\b/i.test(String(headers['content-type'] ?? ''))) return false
  if (!headers.origin) return true
  try {
    return new URL(headers.origin).host === headers.host
  } catch {
    return false
  }
}

function projectList(state) {
  const cwds = new Set(state.graphs.keys())
  for (const cwd of state.lastCwdBySession.values()) cwds.add(cwd)
  return [...cwds].sort()
}

/**
 * Build the dashboard's read model for one project. When `identity` names a
 * session, the graph, compile status and decision window all follow that
 * session's own agent — two agents in one cwd never share a view.
 */
export async function statsPayload(state, cwd, identity) {
  const project = identity?.agent
    ? state.skillViews?.get(identity.agent)?.project
    : state.projectConfigs?.get(cwd)
  const config = project?.config ?? state.config
  const graph = graphFor(state, cwd, identity?.agent)
  const decisions = await readDecisions(state.config, {
    cwd,
    limit: STATS_WINDOW,
    ...(identity?.scope === 'session' && identity.sessionId ? { sessionId: identity.sessionId } : {}),
  })
  const totals = aggregate(decisions)
  // A session view shows its own agent's catalog; a project summary the most recently active one.
  const compile = identity?.agent ? compileStatusFor(state, identity.agent, cwd) : projectCompileStatus(state, cwd)
  const cards = graph.cards.map((card) => ({
    id: card.id,
    title: card.title,
    source: card.source,
    sourceRef: card.sourceRef,
    notApplicable: card.notApplicable,
    modelInvocable: card.modelInvocable,
    skill: card.skill,
    entry: card.entry === true,
    phase: card.phase,
    priority: card.priority,
    critical: card.critical === true,
    checkpoint: card.checkpoint === true,
    grounded: card.skill && !card.entry ? card.grounded === true : undefined,
    quote: card.quote,
    match: card.match,
    triggers: card.triggers,
    when: card.when,
    rules: card.rules,
    satisfiedWhen: card.satisfiedWhen,
    stats: totals.cards[card.id] ?? { selected: 0, injected: 0, blocked: 0 },
  }))
  const skills = graph.graphs.map((item) => ({
    name: item.name,
    description: item.description,
    sourcePath: item.sourcePath,
    sourceHash: item.sourceHash,
    compiledAt: item.compiledAt,
    // Obligations compiled from the skill's text; the entry card is routing only.
    cards: item.cards.length,
    relations: item.relations.length,
    compiled: item.compiled === true,
    stale: item.stale === true,
    warnings: item.warnings ?? [],
    coverage: item.coverage,
    document: item.document,
    invocation: item.invocation,
  }))
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    cwd,
    window: STATS_WINDOW,
    projects: projectList(state),
    config: {
      enabled: config.enabled,
      shadow: config.shadow,
      minConfidence: config.minConfidence,
      cooldownSteps: config.cooldownSteps,
      heartbeatSteps: config.heartbeatSteps,
      skills: config.skills,
      decision: { provider: config.decision.provider, model: config.decision.model, timeoutMs: config.decision.timeoutMs },
      compiler: { provider: config.compiler.provider, model: config.compiler.model, timeoutMs: config.compiler.timeoutMs },
      enforcement: config.enforcement,
      dashboard: config.dashboard,
      userConfigPath: state.config.userConfigPath,
      project: project?.path ? { path: project.path, ignored: project.ignored, errors: project.errors } : undefined,
      errors: state.config.errors,
    },
    adaptive: state.adaptive?.snapshot() ?? [],
    graph: {
      revision: graph.revision,
      updatedAt: graph.updatedAt,
      cards,
      relations: graph.relations,
      builtins: cards.filter((card) => !card.skill).length,
      skillCards: cards.filter((card) => card.skill).length,
    },
    skills,
    compile: compilePayload(state, compile ?? { cwd, total: skills.length, cached: 0, compiled: 0, failed: 0, standby: 0, pending: 0, running: false, errors: [], skills: {} }),
    totals,
    // One compact point per decision in the window, oldest first, for the activity charts.
    series: decisions.filter((record) => record.kind === 'decision').map((record) => ({
      t: record.ts,
      b: record.boundary,
      o: decisionOutcome(record),
      e: Boolean(record.error),
      l: Number(record.latencyMs) || 0,
      s: record.sessionId == null ? '' : String(record.sessionId),
    })),
  }
}

const catalogCache = new Map()

/** Cache one catalog read briefly: the settings form asks for the same lists repeatedly. */
async function cached(key, read) {
  const hit = catalogCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  const value = await read()
  catalogCache.set(key, { at: Date.now(), value })
  if (catalogCache.size > 200) catalogCache.delete(catalogCache.keys().next().value)
  return value
}

/**
 * The host's model catalog for the settings form: registered providers, the
 * models one provider lists, and one model's real capabilities (selectable
 * reasoning efforts, default, context window).
 */
export async function modelsPayload(llm, params) {
  if (!llm || typeof llm.listProviders !== 'function') return { ok: false, error: 'DSH 的模型服务不可用' }
  const provider = params.get('provider') ?? ''
  const model = params.get('model') ?? ''
  if (!provider) {
    const providers = llm.listProviders().map((item) => ({ id: item.id, name: item.name || item.id }))
    return { ok: true, providers }
  }
  if (!model) {
    const models = await cached(`models\u0000${provider}`, () => llm.listModels(provider))
    return { ok: true, provider, models: models.map((item) => ({ id: item.id, name: item.name || item.id, description: item.description })) }
  }
  const info = await cached(`info\u0000${provider}\u0000${model}`, () => llm.resolveModelInfo(provider, model))
  return {
    ok: true, provider, model,
    name: info.name,
    description: info.description,
    contextWindow: info.context?.contextWindow,
    efforts: (info.reasoning?.efforts ?? []).map((effort) => ({ id: effort.id, name: effort.name || effort.id, description: effort.description })),
    defaultEffort: info.reasoning?.defaultEffort,
  }
}

/**
 * Check a settings patch against the real catalog before it is written: the
 * provider must be registered, and a chosen effort must be one this exact
 * model offers. Returns plain-language problems.
 */
async function catalogProblems(llm, patch, config) {
  if (!llm || typeof llm.listProviders !== 'function') return []
  const problems = []
  const providers = new Set(llm.listProviders().map((item) => item.id))
  for (const section of ['decision', 'compiler']) {
    const values = record(patch[section])
    if (!values) continue
    const fallback = section === 'compiler' ? config.decision : {}
    const provider = values.provider !== undefined ? values.provider : config[section].provider ?? fallback.provider
    const model = values.model !== undefined ? values.model : config[section].model ?? fallback.model
    const effort = values.reasoningEffort !== undefined ? values.reasoningEffort : config[section].reasoningEffort
    const label = section === 'decision' ? '检查用的模型' : '编译 skill 用的模型'
    if (provider && !providers.has(provider)) { problems.push(`${label}：DSH 里没有“${provider}”这个服务商`); continue }
    // `off` is always acceptable: the runtime maps it to the model's lightest option.
    if (!provider || !model || !effort || effort === 'off') continue
    try {
      const info = await cached(`info\u0000${provider}\u0000${model}`, () => llm.resolveModelInfo(provider, model))
      const efforts = info.reasoning?.efforts ?? []
      if (efforts.length === 0) problems.push(`${label}：${info.name || model} 没有思考强度可选，请选“模型默认”`)
      else if (efforts.length > 0 && !efforts.some((item) => item.id === effort)) {
        problems.push(`${label}：${info.name || model} 不支持“${effort}”，可选的有 ${efforts.map((item) => item.name || item.id).join('、')}`)
      }
    } catch (error) {
      problems.push(`${label}：读不到 ${provider}/${model} 的信息（${errorMessage(error)}）`)
    }
  }
  return problems
}

/** Compile status plus what a person needs: a summary line, ETA and current concurrency. */
function compilePayload(state, status) {
  const control = state.adaptive?.snapshot().find((entry) => entry.purpose === 'compiler' && entry.route === status.route)
  const concurrency = control?.concurrency.limit ?? 1
  const eta = compileEta(status, concurrency)
  return { ...status, concurrency, eta, summary: compileSummary(status, concurrency) }
}

/** The read model of the editable settings, shared by GET and POST responses. */
function effectiveSettings(config) {
  return {
    decision: {
      provider: config.decision.provider, model: config.decision.model,
      temperature: config.decision.temperature,
      reasoningEffort: config.decision.reasoningEffort, timeoutMs: config.decision.timeoutMs,
      cacheTtlMs: config.decision.cacheTtlMs,
    },
    compiler: {
      provider: config.compiler.provider, model: config.compiler.model,
      temperature: config.compiler.temperature,
      reasoningEffort: config.compiler.reasoningEffort,
      systemAsUser: config.compiler.systemAsUser,
      timeoutMs: config.compiler.timeoutMs,
    },
    skills: {
      include: config.skills.include,
      exclude: config.skills.exclude,
    },
    runtime: {
      minConfidence: config.minConfidence,
      cooldownSteps: config.cooldownSteps, heartbeatSteps: config.heartbeatSteps,
      builtinCards: config.builtinCards,
    },
  }
}

/** Every live per-agent view, so a settings write invalidates all of them. */
function skillViewsOf(state) {
  const views = []
  for (const agent of state.liveAgents ?? []) {
    const view = state.skillViews?.get(agent)
    if (view) views.push(view)
  }
  return views
}

/**
 * Editable settings plus the read-only context an operator needs: which model
 * currently judges, which layer owns it, and which fields a browser may change.
 */
export async function settingsPayload(state, identity) {
  const cwd = identity?.cwd
  const project = (identity?.agent ? state.skillViews?.get(identity.agent)?.project : undefined) ?? state.projectConfigs?.get(cwd)
  // Operator settings always win over a stale per-project snapshot: the file
  // was just written, so echoing an older cached layer would look like the save
  // silently reverted. Project layers may only narrow skills, so merging here is
  // safe — skills.include/exclude from the project still apply.
  const projectSkills = project?.config && project.config !== state.config
    ? { include: project.config.skills?.include ?? [], exclude: project.config.skills?.exclude ?? [] }
    : {}
  const config = project?.config
    ? normalizeConfig(mergeConfig(state.config, { skills: projectSkills }), cwd)
    : state.config
  const route = decisionRoute(identity?.agent, config)
  return {
    ok: true,
    path: state.config.userConfigPath ?? join(dshHome(), 'eng-protocol.json'),
    editable: DASHBOARD_EDITABLE,
    effective: effectiveSettings(config),
    // The route actually used right now, including the main-agent fallback.
    route: route ? `${route.provider}/${route.model}` : '主对话的模型',
    mainRoute: identity?.agent?.options?.provider && identity.agent.options.model
      ? { provider: identity.agent.options.provider, model: identity.agent.options.model } : undefined,
    // What the last call on each route actually sent, e.g. a reasoning effort adjusted to the model.
    used: Object.fromEntries((state.adaptive?.snapshot() ?? []).filter((item) => item.effort?.note).map((item) => [item.purpose === 'judge' ? 'decision' : 'compiler', item.effort.note])),
    userConfigPath: state.config.userConfigPath,
    projectLayer: project?.path ? { path: project.path, ignored: project.ignored } : undefined,
    errors: state.config.errors,
  }
}

/** Serve the dashboard and its JSON API from the host's webserver. */
export function registerDashboard(ctx, state) {
  if (state.config.dashboard.enabled === false) return
  const path = state.config.dashboard.path
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer
    if (!server || typeof server.register !== 'function') return

    webCtx.effect(() => server.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendMethod(res, 'GET')
          return
        }
        try {
          const html = await readFile(join(HERE, '..', 'dashboard.html'), 'utf8')
          sendHtml(res, html.replaceAll('__DASHBOARD_CSS__', `${path}/dashboard.css`))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    }), 'eng-protocol: dashboard page')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: `${path}/dashboard.css`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendMethod(res, 'GET')
          return
        }
        try {
          const css = await readFile(join(HERE, '..', 'dashboard.css'), 'utf8')
          res.statusCode = 200
          res.setHeader('content-type', 'text/css; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(css)
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    }), 'eng-protocol: dashboard styles')

    // Fixed, discoverable config endpoint for the client half: the panel path
    // may be customised, and the iframe must not guess it.
    webCtx.effect(() => server.register({
      kind: 'exact',
      path: '/eng-protocol-bootstrap',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendMethod(res, 'GET')
          return
        }
        sendJson(res, 200, { path: state.config.dashboard.path, enabled: state.config.dashboard.enabled !== false })
      },
    }), 'eng-protocol: dashboard bootstrap')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: `${path}/api/stats`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendMethod(res, 'GET')
          return
        }
        const identity = requestedIdentity(state, req)
        if (identity.error) {
          sendJson(res, 409, { ok: false, error: identity.error })
          return
        }
        try {
          sendJson(res, 200, await statsPayload(state, identity.cwd, identity))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    }), 'eng-protocol: dashboard stats')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: `${path}/api/decisions`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendMethod(res, 'GET')
          return
        }
        const identity = requestedIdentity(state, req)
        if (identity.error) {
          sendJson(res, 409, { ok: false, error: identity.error })
          return
        }
        try {
          sendJson(res, 200, await decisionsPayload(state, identity.cwd, identity.url.searchParams, identity))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: errorMessage(error) })
        }
      },
    }), 'eng-protocol: dashboard decisions')

    webCtx.effect(() => server.register({
      kind: 'exact',
      path: `${path}/api/settings`,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const identity = requestedIdentity(state, req)
          if (identity.error) {
            sendJson(res, 409, { ok: false, error: identity.error })
            return
          }
          try {
            sendJson(res, 200, await settingsPayload(state, identity))
          } catch (error) {
            sendJson(res, 500, { ok: false, error: errorMessage(error) })
          }
          return
        }
        if (req.method !== 'POST') {
          sendMethod(res, 'GET')
          return
        }
        if (!trustedPost(req)) {
          sendJson(res, 403, { ok: false, error: '只接受来自面板本身的 JSON 请求' })
          return
        }
        try {
          const body = await readBody(req)
          const parsed = body.trim() ? JSON.parse(body) : {}
          const identity = requestedIdentity(state, {
            url: `/?${new URLSearchParams({
              ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
              ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
              ...(parsed.scope === 'project' ? { scope: 'project' } : {}),
            })}`,
          })
          if (identity.error) {
            sendJson(res, 409, { ok: false, error: identity.error })
            return
          }
          const problems = await catalogProblems(ctx.get?.('llm'), record(parsed.settings) ?? {}, state.config)
          if (problems.length > 0) {
            sendJson(res, 400, { ok: false, error: problems.join('；') })
            return
          }
          const saved = await saveUserSettings(record(parsed.settings) ?? {}, state.config)
          // Apply immediately for live decisions; existing judgments keep their
          // recorded route so the trail still says which model judged them.
          state.config = normalizeConfig(mergeConfig(state.config, saved.patch), state.config.cwd)
          // Drop cached project layers so the next read reflects the new file
          // instead of an older snapshot (this was why a save looked reverted).
          state.projectConfigs?.clear()
          for (const view of skillViewsOf(state)) view.project = undefined
          sendJson(res, 200, { ok: true, path: saved.path, applied: saved.applied, rejected: saved.rejected, errors: state.config.errors, effective: effectiveSettings(state.config) })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: errorMessage(error) })
        }
      },
    }), 'eng-protocol: dashboard settings')

    /**
     * Compile control: `retry` failed skills (resuming finished parts),
     * `rebuild` from scratch (optionally one `name`), or `cancel` the running
     * compile. The work runs in the background; the panel follows the status.
     */
    const compileAction = (fixedAction) => async (req, res) => {
      if (req.method !== 'POST') {
        sendMethod(res, 'POST')
        return
      }
      if (!trustedPost(req)) {
        sendJson(res, 403, { ok: false, error: '只接受来自面板本身的 JSON 请求' })
        return
      }
      try {
        const body = await readBody(req)
        const parsed = body.trim() ? JSON.parse(body) : {}
        const identity = requestedIdentity(state, {
          url: `/?${new URLSearchParams({
            ...(typeof parsed.sessionId === 'string' ? { sessionId: parsed.sessionId } : {}),
            ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
            ...(parsed.scope === 'project' ? { scope: 'project' } : {}),
          })}`,
        })
        if (identity.error) {
          sendJson(res, 409, { ok: false, error: identity.error })
          return
        }
        const agent = identity.agent
        if (!agent) {
          sendJson(res, 409, { ok: false, error: '这个会话还没开始运行。先在会话里发一条消息，再来编译 skill。' })
          return
        }
        const action = fixedAction ?? parsed.action
        const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined
        const warn = (error) => ctx.logger?.warn?.(`eng-protocol: skill 编译操作 ${action} 失败：${errorMessage(error)}`)
        if (action === 'cancel') {
          sendJson(res, 200, { ok: true, cancelled: cancelCompile(state, agent) })
          return
        }
        if (action === 'retry') void refreshSkills(ctx, state, agent, { queue: true }).catch(warn)
        else if (action === 'rebuild') void refreshSkills(ctx, state, agent, { force: true, ...(name ? { only: [name] } : {}) }).catch(warn)
        else {
          sendJson(res, 400, { ok: false, error: `未知操作：${action}（可用 retry / rebuild / cancel）` })
          return
        }
        sendJson(res, 202, { ok: true, cwd: identity.cwd, sessionId: identity.sessionId, action, name, queued: true })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: errorMessage(error) })
      }
    }
    webCtx.effect(() => server.register({ kind: 'exact', path: `${path}/api/compile`, handler: compileAction() }), 'eng-protocol: dashboard compile control')
    webCtx.effect(() => server.register({
      kind: 'exact',
      path: `${path}/api/models`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendMethod(res, 'GET')
          return
        }
        try {
          const params = new URL(String(req.url), 'http://localhost').searchParams
          const payload = await modelsPayload(ctx.get?.('llm'), params)
          sendJson(res, payload.ok ? 200 : 503, payload)
        } catch (error) {
          sendJson(res, 502, { ok: false, error: errorMessage(error) })
        }
      },
    }), 'eng-protocol: model catalog')
    // Older panels post here; same as `rebuild`.
    webCtx.effect(() => server.register({ kind: 'exact', path: `${path}/api/rebuild`, handler: compileAction('rebuild') }), 'eng-protocol: dashboard rebuild')

    // Diagnostic for the client-half tab: did the host compose this package into
    // the browser boot graph? Only with `debug: true`.
    if (state.config.debug) {
      webCtx.effect(() => server.register({
        kind: 'exact',
        path: `${path}/api/debug`,
        handler: (req, res) => {
          const modules = ctx.get('clientModules')
          const graph = modules && typeof modules.graph === 'function' ? modules.graph() : undefined
          sendJson(res, 200, {
            plugin: import.meta.url,
            clientModules: Boolean(modules),
            entries: graph?.entries?.map((entry) => ({
              id: entry.id,
              url: entry.url,
              inject: entry.inject,
              immediately: entry.immediately,
            })) ?? [],
            batches: graph?.batches?.map((batch) => ({ phase: batch.phase, entries: batch.entries })) ?? [],
          })
        },
      }), 'eng-protocol: client graph diagnostic')
    }

    // A tiny, dependency-free entry point in the existing Web shell. It is a
    // link, not a second application: the dashboard remains its own page.
    webCtx.on('webserver/index-inject', (table) => {
      table.push({
        kind: 'style',
        text: '#eng-protocol-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;gap:7px;align-items:center;padding:9px 12px;border-radius:999px;border:1px solid rgba(127,127,127,.35);background:rgba(24,24,27,.9);color:#e8e8ea;font:12px/1.2 ui-sans-serif,system-ui,sans-serif;text-decoration:none;box-shadow:0 8px 30px rgba(0,0,0,.28);backdrop-filter:blur(8px)}#eng-protocol-fab:hover{border-color:rgba(127,127,127,.65);background:rgba(39,39,42,.96)}#eng-protocol-fab b{font-weight:650;color:#c4b5fd}',
      })
      table.push({
        kind: 'script',
        placement: 'body',
        text: `(function(){if(document.getElementById('eng-protocol-fab'))return;var a=document.createElement('a');a.id='eng-protocol-fab';a.href=${JSON.stringify(path)}+'?theme='+(document.body.hasAttribute('data-ds-dark-theme')?'dark':'light');a.target='_blank';a.rel='noopener';a.title='打开 Eng Protocol 决策卡面板';a.innerHTML='<b>⚖</b><span>Eng Protocol</span>';document.body.appendChild(a)})()`,
      })
    })
  })
}

export { HERE }
