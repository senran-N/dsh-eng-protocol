/**
 * dsh-eng-protocol — event-driven engineering protocol guidance for DeepSeek Harness.
 *
 * The plugin compiles the host's loaded skills into decision cards, detects
 * evidence locally, asks a small decision model only about the cards that the
 * evidence can trigger, and injects a short reminder at the request, tool, or
 * delivery boundary. Every decision is logged; the dashboard renders the card
 * topology and the trigger trail.
 */
import { AdaptiveRegistry, sleep } from './lib/adaptive.js'
import { agentCwd, resolveConfig } from './lib/config.js'
import { candidateCards, isEntryCard, renderGuidance } from './lib/cards.js'
import { cancelCompile, forgetAgent, graphFor, graphReady, refreshSkills } from './lib/compiler.js'
import { evaluateDecision, sourceSummary } from './lib/decide.js'
import { SessionLedger, actionExcerpt, actionTriggers, classifyTool } from './lib/events.js'
import { Aftermath } from './lib/aftermath.js'
import { appendDecision } from './lib/store.js'
import { errorMessage, hash, messageId, oneLine } from './lib/text.js'
import { compileSummary, registerDashboard } from './lib/dashboard.js'

export const name = 'eng-protocol'

const SOURCE = 'eng-protocol'
const HELP_TEXT = [
  '/protocol                 现在的状态',
  '/protocol cards           当前生效的规则',
  '/protocol skills          每个 skill 准备好了没有',
  '/protocol retry           重试没准备好的 skill（做完的部分不重做）',
  '/protocol rebuild [名称]  重新编译全部 skill，或只编译某一个',
  '/protocol cancel          暂停编译（做完的部分会保留）',
  '/protocol on | off        在这个会话里打开或关闭',
  '/protocol shadow          在这个会话里只观察：照常检查和记录，但不提醒、不拦下',
  '/protocol help            显示这份说明',
].join('\n')
const SKILL_STATE = { cached: '已就绪', done: '已就绪', queued: '等待中', compiling: '准备中', retrying: '稍后再试', failed: '没准备好', cancelled: '已暂停' }

/** Wait for `promise`, giving up quietly after `ms` or when `signal` aborts. */
function waitAtMost(promise, ms, signal) {
  return Promise.race([Promise.resolve(promise).catch(() => undefined), sleep(ms, signal).catch(() => undefined)])
}

/** Wait until a set of in-flight judgments settles; each one carries its own adaptive deadline. */
async function settleInflight(item, signal) {
  while (item.inflight?.size > 0 && !signal?.aborted) {
    await Promise.race([Promise.allSettled([...item.inflight]), sleep(60_000, signal).catch(() => undefined)])
  }
}

const MODE_TEXT = {
  live: '已在这个会话里打开：需要时会提醒，危险操作会先拦下。',
  shadow: '这个会话进入影子模式：照常检查和记录，但不提醒、不拦下，用来对比效果。',
  off: '已在这个会话里关闭。',
}

/** A durable, model-visible context message; the source makes it a `context` row in Chat/Trajectory. */
function notice(text, summary) {
  return {
    id: messageId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE, form: 'notice', summary: oneLine(summary, 118) },
  }
}

/** A newly admitted human message starts a turn. */
function startsTurn(messages) {
  return messages.some((message) => message?.role === 'user' && message?.source?.kind === 'user')
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig, process.cwd())
  const state = {
    ctx,
    config,
    graphs: new Map(),
    compileRuns: new Map(),
    compileStatus: new Map(),
    projectConfigs: new Map(),
    compileAbort: new AbortController(),
    agents: new WeakMap(),
    sessions: new Map(),
    agentBySession: new Map(),
    modeBySession: new Map(),
    // Adaptive concurrency, timeouts and sizes per model route, shared by the
    // judge and the compiler; see lib/adaptive.js.
    adaptive: new AdaptiveRegistry(),
    // Recent identical judge calls within the TTL reuse the earlier verdicts.
    judgeCache: new Map(),
    started: new WeakSet(),
    liveAgents: new Set(),
    lastCwd: process.cwd(),
    lastAgent: undefined,
    lastAgentByCwd: new Map(),
    lastCwdBySession: new Map(),
    lastDecision: undefined,
    recordDecision(record) {
      state.lastDecision = record
      void appendDecision(state.config, record).catch((error) => warn('决策日志写入失败', error))
    },
    recordAftermath(records) {
      for (const record of records) void appendDecision(state.config, record).catch((error) => warn('后续动作写入失败', error))
    },
  }
  function warn(what, error) {
    ctx.logger?.warn?.(`eng-protocol: ${what}：${errorMessage(error)}`)
  }
  if (config.errors.length > 0) {
    ctx.logger?.warn?.(`eng-protocol: 配置存在问题，已使用修正后的值：${config.errors.join('；')}`)
  }
  // Fields from older versions are ignored silently; only a debug log names them.
  if (config.deprecated.length > 0) ctx.logger?.debug?.(`eng-protocol: ignored retired config fields: ${config.deprecated.join(', ')}`)

  /** `live` injects and blocks, `shadow` only judges and records, `off` does nothing. Overridable per session. */
  function modeFor(agent) {
    const override = state.modeBySession.get(agent?.session?.id)
    if (override) return override
    if (!state.config.enabled) return 'off'
    return state.config.shadow ? 'shadow' : 'live'
  }

  function agentState(agent) {
    let item = state.agents.get(agent)
    if (item) return item
    const cwd = agentCwd(agent)
    item = {
      agent,
      cwd,
      ledger: new SessionLedger(agent, { heartbeatSteps: state.config.heartbeatSteps }),
      chain: Promise.resolve(),
      // Aborts tool-boundary judgments still running when their turn ends.
      deferred: new AbortController(),
      // Reminders judged at the tool boundary, delivered at the next step.
      pending: [],
      // Calls soft-blocked this turn; the same call goes through on retry.
      retryKeys: new Set(),
      settledTurn: undefined,
      // Skills in scope for this agent, until an entry card is judged inapplicable.
      activeSkills: new Set(),
      // This agent's decision clock and card cooldowns.
      decisionTick: 0,
      cooldowns: new Map(),
      scopeVersions: new Map(),
      pendingEntries: new Set(),
      disposed: false,
      // What the agent did after each reminder, read from the session events.
      aftermath: new Aftermath(),
    }
    item.activeSkills = new Set(item.ledger.loadedSkills)
    state.agents.set(agent, item)
    state.liveAgents.add(agent)
    if (agent?.session) {
      state.sessions.set(agent.session, item.ledger)
      if (agent.session.id) state.agentBySession.set(agent.session.id, agent)
    }
    state.lastAgent = agent
    state.lastCwd = cwd
    state.lastAgentByCwd.set(cwd, agent)
    if (agent?.session?.id) state.lastCwdBySession.set(agent.session.id, cwd)
    return item
  }

  function cancelDeferred(item) {
    item.deferred.abort()
    item.deferred = new AbortController()
  }

  function discardPending(item, reason) {
    for (const entry of item.pending.splice(0)) finish(item, entry.result, 'live', [], reason)
  }

  function ensureCompile(agent) {
    if (state.started.has(agent)) return
    state.started.add(agent)
    void refreshSkills(ctx, state, agent).catch((error) => warn('skill 图编译失败', error))
    // The first step waits for the cached graph (no model call) so it already
    // sees real skill cards instead of a built-ins-only graph.
    const item = state.agents.get(agent)
    if (item) item.firstCompile = graphReady(state, agent)
  }

  /** Drain evidence. A new human turn resets the per-turn soft-block memory and stale deferred reminders. */
  function observe(item, messages) {
    const triggers = new Set(item.ledger.observe(messages).triggers)
    if (triggers.has('turn')) {
      state.recordAftermath(item.aftermath.flush('new-turn'))
      item.retryKeys.clear()
      discardPending(item, 'new-turn')
      item.cooldowns.clear()
      item.scopeVersions.clear()
      item.pendingEntries.clear()
    }
    return triggers
  }

  /** A skill the agent loads is in scope until its entry card is judged inapplicable. */
  function noteSkillLoad(item, triggers) {
    if (triggers.has('skill')) {
      for (const name of item.ledger.observedSkills) item.activeSkills.add(name)
    }
  }

  function candidatesFor(item, triggers) {
    const ledger = item.ledger
    const graph = graphFor(state, item.cwd, item.agent)
    const names = new Set(graph.graphs.map((skill) => skill.name))
    const view = state.skillViews?.get(item.agent)
    const ready = view?.compileStatus.has(item.cwd) && !view.compileRuns.has(item.cwd)
    for (const name of item.activeSkills) if (!names.has(name) && ready) item.activeSkills.delete(name)
    for (const skill of graph.graphs) {
      const version = hash([skill.sourceHash, skill.entry])
      if (item.scopeVersions.get(skill.name) !== version && (ledger.lastUser || item.activeSkills.has(skill.name))) {
        item.scopeVersions.set(skill.name, version)
        item.pendingEntries.add(skill.entry.id)
      }
    }
    return candidateCards(graph.cards, {
      triggers: [...triggers],
      budget: state.config.candidates,
      active: item.activeSkills,
      pendingEntries: item.pendingEntries,
      relations: graph.relations,
      invoked: triggers.has('skill') ? ledger.lastSkill : '',
      query: [ledger.lastUser, ...[...ledger.filesEdited].slice(-12), ...[...ledger.filesRead].slice(-12)].join('\n'),
    })
  }

  function updateActiveSkills(item, candidates, assessments = {}) {
    for (const card of candidates) {
      if (!isEntryCard(card)) continue
      const assessment = assessments[card.id]
      if (!assessment) continue
      item.pendingEntries.delete(card.id)
      if (assessment.confidence < state.config.minConfidence) continue
      const verdict = assessment.state
      if (verdict === 'inapplicable') item.activeSkills.delete(card.skill)
      else if (verdict === 'needed' || verdict === 'addressing' || verdict === 'satisfied') item.activeSkills.add(card.skill)
    }
  }

  function snapshot(item, boundary, triggers, action, candidates, signal) {
    return {
      cwd: item.cwd,
      boundary,
      triggers,
      action,
      candidates,
      graph: graphFor(state, item.cwd, item.agent),
      ledger: item.ledger.summary(),
      activeSkills: new Set(item.activeSkills),
      signal,
    }
  }

  /** One cache key per agent, boundary, candidates, evidence position and action fingerprint. */
  function judgeCacheKey(item, boundary, triggers, action, candidates) {
    const ledger = item.ledger
    const actionPart = action ? hash([action.tool, action.command ?? action.path, action.cwd ?? '']) : ''
    return hash([
      item.agent?.session?.id ?? item.agent?.id, item.cwd, boundary,
      candidates.map((card) => card.id).join(','),
      ledger.turn, ledger.step, ledger.editRevision, ledger.failureStreak,
      ledger.evidenceSeq, ledger.responseSeq, actionPart,
    ])
  }

  /**
   * Judge one boundary for one agent. Judgments run concurrently under the
   * route's adaptive limiter, each with its own adaptive deadline, so a burst
   * of tool-boundary judgments never queues behind one another. Identical
   * recent tool-boundary calls reuse cached verdicts instead of another call.
   */
  function judge(item, boundary, triggers, action, signal, candidates = candidatesFor(item, triggers), { onSettled } = {}) {
    if (candidates.length === 0) return Promise.resolve(undefined)
    const list = [...triggers]
    // Only the tool boundary caches: the production waste was repeated read
    // triggers for identical actions at one evidence position. Request/settle
    // judgments drive scope progression and must re-run even on stale evidence.
    const cacheKey = boundary === 'tool' ? judgeCacheKey(item, boundary, triggers, action, candidates) : ''
    const ttl = boundary === 'tool' ? state.config.decision.cacheTtlMs : 0
    if (ttl > 0) {
      const cached = state.judgeCache.get(cacheKey)
      if (cached && Date.now() - cached.at < ttl) {
        cached.hits = (cached.hits ?? 0) + 1
        const record = { ...cached.result.record, cacheHit: true, latencyMs: 0, decisionId: messageId() }
        const result = { ...cached.result, record }
        // A cache hit settles exactly like a fresh judgment would.
        onSettled?.(result)
        return Promise.resolve(result)
      }
    }
    const captured = snapshot(item, boundary, list, action, candidates, AbortSignal.any([signal, item.deferred.signal].filter(Boolean)))
    const inflight = (item.inflight ??= new Set())
    // The settle callback runs inside this promise, so a boundary waiting on
    // in-flight judgments observes the pushed pending reminder in the same step.
    const promise = (async () => {
      if (item.disposed || captured.signal.aborted) return undefined
      return evaluateDecision(ctx, state, item, captured)
    })().then((result) => {
      inflight.delete(promise)
      if (result && !result.cancelled) {
        updateActiveSkills(item, candidates, result.assessments)
        if (!result.record?.error) {
          state.judgeCache.set(cacheKey, { at: Date.now(), result, hits: 0 })
          if (state.judgeCache.size > 64) state.judgeCache.delete(state.judgeCache.keys().next().value)
        }
      }
      onSettled?.(result)
      return result
    }, (error) => {
      inflight.delete(promise)
      throw error
    })
    inflight.add(promise)
    return promise
  }

  /** Close a decision record for the mode it ran in, then log it. */
  function finish(item, result, mode, deliveredCards = [], disposition) {
    const record = result.record
    record.injected = mode === 'live' && deliveredCards.length > 0
    record.deliveredCards = deliveredCards.map((card) => card.id)
    if (disposition) record.delivery = disposition
    if (mode === 'shadow') {
      record.shadow = true
      record.wouldInject = Boolean(result.guidance)
    }
    // Causal delivery watermarks: only judgments strictly after both sequences
    // may later count as this reminder's follow-up. The watermark includes
    // queued-but-unconsumed evidence so pre-delivery work cannot self-attribute.
    const watermark = item.ledger.watermark()
    record.deliveryEvidenceSeq = watermark.evidenceSeq
    record.deliveryResponseSeq = watermark.responseSeq
    record.deliveredAt = new Date().toISOString()
    if (['delivered', 'blocked'].includes(disposition) || (mode === 'shadow' && record.wouldInject)) record.deliveryRecorded = true
    for (const card of mode === 'shadow' ? result.cards : deliveredCards) item.cooldowns.set(card.id, item.decisionTick)
    state.recordDecision(record)
    if (record.deliveryRecorded) item.aftermath.watch(record)
  }

  function delivery(boundary, triggers, result) {
    return { boundary, triggers: [...triggers], cards: result.cards, text: result.guidance, result }
  }

  /** Notices for this step; a card already carried by an earlier one is not repeated. */
  function noticesFor(item, deliveries, assessments = {}, send) {
    const seen = new Set()
    const notices = []
    const current = new Map(graphFor(state, item.cwd, item.agent).cards.map((card) => [card.id, card]))
    const eligible = (card) => current.has(card.id) && hash(current.get(card.id)) === hash(card)
      && (!card.skill || card.entry || item.activeSkills.has(card.skill))
      && !(['satisfied', 'addressing', 'inapplicable'].includes(assessments[card.id]?.state)
        && assessments[card.id].confidence >= state.config.minConfidence)
    const all = [...new Map(deliveries.flatMap((entry) => entry.cards).filter(eligible).map((card) => [card.id, card])).values()]
      .sort((a, b) => Number(b.critical) - Number(a.critical) || (b.priority ?? 1) - (a.priority ?? 1))
    // No count cap: every eligible card is delivered once, critical first.
    const allowed = new Set(all.map((card) => card.id))
    for (const entry of deliveries) {
      const cards = entry.cards.filter((card) => !seen.has(card.id) && allowed.has(card.id) && eligible(card))
      if (cards.length === 0) { finish(item, entry.result, 'live', [], 'superseded'); continue }
      for (const card of cards) seen.add(card.id)
      const text = cards.length === entry.cards.length
        ? entry.text
        : renderGuidance(cards, { boundary: entry.boundary, triggers: entry.triggers })
      const message = notice(text, sourceSummary(cards, entry.triggers))
      try {
        if (send) send(message)
        notices.push(message)
        finish(item, entry.result, 'live', cards, 'delivered')
      } catch (error) {
        finish(item, entry.result, 'live', [], 'delivery-failed')
        warn('提醒投递失败', error)
      }
    }
    return notices
  }

  ctx.on('agent/created', ({ agent }) => {
    agentState(agent)
    if (modeFor(agent) !== 'off') ensureCompile(agent)
  })

  // ---- request boundary -------------------------------------------------
  ctx.on('agent/pre-step', async (payload, next) => {
    const mode = modeFor(payload.agent)
    if (mode === 'off') return next()
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const item = agentState(payload.agent)
    item.cwd = agentCwd(payload.agent)
    state.lastCwd = item.cwd
    ensureCompile(payload.agent)
    // The first step of a session may arrive before the cached graph is
    // published. That needs no model call; the hard timeout only guards a host
    // whose skill catalog never answers.
    if (item.firstCompile) {
      await waitAtMost(item.firstCompile, state.config.decision.timeoutMs, payload.signal)
      item.firstCompile = undefined
    }
    // Deferred tool-boundary judgments land before this step; at a new human
    // turn the ones still running belong to the previous turn and are cancelled.
    if (startsTurn(decision.messages)) cancelDeferred(item)
    try {
      // Tool-boundary judgments still running land before this step. They run
      // in parallel, each bounded by its own adaptive deadline, so the wait is
      // the slowest one — never the sum of a queue.
      await settleInflight(item, AbortSignal.any([payload.signal, item.deferred.signal]))
      const triggers = observe(item, decision.messages)
      if (Number.isInteger(payload.turn)) item.ledger.turn = payload.turn
      if (Number.isInteger(payload.step)) item.ledger.step = payload.step
      noteSkillLoad(item, triggers)
      // Deferred reminders never replace this step's own judgment.
      const candidates = candidatesFor(item, triggers)
      const deliveries = item.pending.splice(0)
      let latestAssessments = {}
      const signal = AbortSignal.any([payload.signal, item.deferred.signal])
      if (triggers.size > 0 || candidates.length > 0) {
        try {
          const result = await judge(item, 'request', triggers, undefined, signal, candidates)
          if (result && !result.cancelled) {
            latestAssessments = result.assessments
            if (mode === 'live' && result.guidance) deliveries.push(delivery('request', triggers, result))
            else finish(item, result, mode)
          }
        } catch (error) {
          warn('请求前判断失败', error)
        }
      }
      const live = mode === 'live' && modeFor(payload.agent) === 'live' && !signal.aborted && !item.disposed
      const notices = live ? noticesFor(item, deliveries, latestAssessments) : []
      if (!live) for (const entry of deliveries) finish(item, entry.result, 'live', [], 'cancelled')
      if (notices.length === 0) return decision
      return { ...decision, messages: [...decision.messages, ...notices] }
    } catch (error) {
      warn('请求前边界处理失败', error)
      return decision
    }
  })

  // ---- tool boundary ----------------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    const mode = modeFor(exec?.agent)
    if (mode === 'off') return next()
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    if (!exec?.agent || !exec?.name) return downstream
    const item = agentState(exec.agent)
    const action = classifyTool(exec.name, exec.arguments, { cwd: item.cwd })
    if (action.kind === 'other') return downstream
    action.excerpt = actionExcerpt(action)
    action.callId = exec.callId
    const triggers = observe(item, [])
    for (const trigger of action.kind === 'skill' ? [] : actionTriggers(action, item.ledger.filesEdited.size)) triggers.add(trigger)
    noteSkillLoad(item, triggers)
    const candidates = candidatesFor(item, triggers)
    if (candidates.length === 0) return downstream
    item.ledger.consumeAction(exec.callId)
    const enforced = new Set(state.config.enforcement.cards)
    const key = hash([exec.name, exec.arguments])
    const canDeny = state.config.enforcement.enabled
      && (action.kind === 'edit' || action.kind === 'command')
      && !item.retryKeys.has(key)
    const possibleSkills = new Set(candidates.filter(isEntryCard).map((card) => card.skill))
    const waitForDecision = mode === 'live' && canDeny && (candidates.some((card) => enforced.has(card.id))
      || graphFor(state, item.cwd, item.agent).cards.some((card) => possibleSkills.has(card.skill) && enforced.has(card.id)))
    const settle = (result) => {
      if (!result || result.cancelled || item.disposed || modeFor(exec.agent) !== mode) return undefined
      const deny = canDeny && (mode !== 'live' || waitForDecision) && result.cards.some((card) => enforced.has(card.id))
      // One soft block per call and turn; the identical retry goes through.
      if (deny) item.retryKeys.add(key)
      result.record.blocked = mode === 'live' && deny
      if (mode === 'shadow' && deny) result.record.wouldBlock = true
      if (mode !== 'live') { finish(item, result, mode); return undefined }
      if (deny) {
        finish(item, result, mode, result.cards, 'blocked')
        return { kind: 'deny', reason: result.guidance }
      }
      if (result.guidance) item.pending.push(delivery('tool', triggers, result))
      else finish(item, result, mode)
      return undefined
    }
    // Only a judgment that can still deny this call is worth waiting for. The
    // rest runs alongside the tool and reaches the model at the next step.
    if (!waitForDecision) {
      void judge(item, 'tool', triggers, action, AbortSignal.any([exec.signal, item.deferred.signal]), candidates, { onSettled: settle })
        .catch((error) => warn('执行前判断失败', error))
      return downstream
    }
    try {
      // Awaited path: settle decides the deny result, so it must not also run
      // as a deferred callback — pass no onSettled here.
      return (await judge(item, 'tool', triggers, action, AbortSignal.any([exec.signal, item.deferred.signal]), candidates).then((result) => settle(result) ?? downstream)) ?? downstream
    } catch (error) {
      warn('执行前判断失败', error)
      return downstream
    }
  })

  // ---- delivery boundary ------------------------------------------------
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const mode = modeFor(agent)
    // Delivery review continues the turn, so like a soft block it is an
    // intervention: `enforcement.enabled = false` switches both off.
    if (mode === 'off' || !state.config.enforcement.enabled) return
    const item = agentState(agent)
    if (item.settledTurn === turn) return
    item.settledTurn = turn
    try {
      await settleInflight(item, AbortSignal.any([signal, item.deferred.signal].filter(Boolean)))
      const triggers = observe(item, [])
      triggers.add('settle')
      noteSkillLoad(item, triggers)
      const result = await judge(item, 'settle', triggers, undefined, AbortSignal.any([signal, item.deferred.signal].filter(Boolean)))
      if (result?.cancelled) return
      if (mode !== 'live') { if (result) finish(item, result, mode); return }
      const deliveries = item.pending.splice(0)
      if (result?.guidance) deliveries.push(delivery('settle', triggers, result))
      else if (result) finish(item, result, mode)
      if (modeFor(agent) !== 'live' || signal.aborted || item.disposed || typeof agent.inject !== 'function') {
        for (const entry of deliveries) finish(item, entry.result, 'live', [], 'cancelled')
        return
      }
      noticesFor(item, deliveries, result?.assessments, (message) => agent.inject(message))
    } catch (error) {
      warn('交付前判断失败', error)
    }
  })

  // ---- evidence stream --------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const ledger = state.sessions.get(session)
    if (!ledger) return
    ledger.push(event)
    const item = state.agents.get(ledger.agent)
    if (item) state.recordAftermath(item.aftermath.push(event))
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload
    const item = state.agents.get(agent)
    if (!item) return
    item.deferred.abort()
    item.disposed = true
    discardPending(item, 'disposed')
    state.recordAftermath(item.aftermath.flush('disposed'))
    if (item.ledger.session) state.sessions.delete(item.ledger.session)
    if (item.agent?.session?.id) state.agentBySession.delete(item.agent.session.id)
    state.agents.delete(agent)
    state.liveAgents.delete(agent)
    state.started.delete(agent)
    forgetAgent(state, agent)
    if (state.lastAgent === agent) state.lastAgent = undefined
    for (const [cwd, last] of state.lastAgentByCwd) {
      if (last === agent) state.lastAgentByCwd.delete(cwd)
    }
  })

  // ---- skill changes ----------------------------------------------------
  ctx.on('skills/change', () => {
    // Restarting is cheap: unchanged skills are cache hits and finished parts resume.
    for (const agent of state.liveAgents) {
      void refreshSkills(ctx, state, agent, { restart: true }).catch((error) => warn('skill 变更后重编译失败', error))
    }
  })

  // ---- dashboard --------------------------------------------------------
  registerDashboard(ctx, state)

  // ---- /protocol command ------------------------------------------------
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'eng-protocol',
      name: 'protocol',
      description: '查看决策卡、编译进度和 skill 拓扑；支持 status / cards / skills / retry / rebuild / cancel / on / off / shadow / help',
      input: { hint: 'status | cards | skills | retry | rebuild [skill] | cancel | on | off | shadow | help' },
      handler: async ({ agent, rawInput }) => {
        const [action = 'status', ...rest] = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
        const argument = rest.join(' ')
        if (action === 'help' || action === '?') return { kind: 'success', text: HELP_TEXT }
        if (action === 'on' || action === 'off' || action === 'shadow') {
          const sessionId = agent?.session?.id
          if (!sessionId) return { kind: 'error', text: '没有找到当前会话' }
          const mode = action === 'on' ? 'live' : action
          state.modeBySession.set(sessionId, mode)
          const item = state.agents.get(agent)
          if (item && mode !== 'live') {
            discardPending(item, 'mode-change')
            cancelDeferred(item)
          }
          return { kind: 'success', text: MODE_TEXT[mode] }
        }
        const cwd = agent ? agentCwd(agent) : state.lastCwd
        const status = () => state.skillViews?.get(agent)?.compileStatus.get(cwd) ?? state.compileStatus.get(cwd)
        if (['rebuild', 'retry', 'cancel'].includes(action) && !agent) return { kind: 'error', text: '这个会话还没开始运行，先发一条消息再试。' }
        if (action === 'rebuild') {
          const names = graphFor(state, cwd, agent).graphs.map((graph) => graph.name)
          if (argument && !names.includes(argument) && !Object.hasOwn(status()?.skills ?? {}, argument)) {
            return { kind: 'error', text: `没有叫 ${argument} 的 skill。现有的是：${names.join('、') || '（没有）'}` }
          }
          void refreshSkills(ctx, state, agent, { force: true, ...(argument ? { only: [argument] } : {}) }).catch((error) => warn('skill 图重建失败', error))
          return { kind: 'success', text: `${argument ? `正在重新编译 ${argument}` : '正在重新编译全部 skill'}，期间旧规则照常工作。进度可以用 /protocol skills 查看。` }
        }
        if (action === 'retry') {
          const failed = Object.entries(status()?.skills ?? {}).filter(([, entry]) => entry.state === 'failed').map(([name]) => name)
          void refreshSkills(ctx, state, agent, { queue: true }).catch((error) => warn('skill 重试失败', error))
          return { kind: 'success', text: failed.length > 0
            ? `正在重试：${failed.join('、')}。上次做完的部分不会重做。`
            : '所有 skill 都准备好了；也顺便看了一遍有没有新加或改过的 skill。' }
        }
        if (action === 'cancel') {
          return cancelCompile(state, agent)
            ? { kind: 'success', text: '已暂停。做完的部分都保存了，/protocol retry 可以接着做。' }
            : { kind: 'success', text: '现在没有在编译。' }
        }
        const graph = graphFor(state, cwd, agent)
        if (action === 'cards') {
          const lines = graph.cards.map((card) => `${card.skill ? 'skill' : 'builtin'}\t${card.id}\t${card.title}\t${card.triggers.join(',')}`)
          return { kind: 'success', text: [`决策卡 ${graph.cards.length} 张（来自 skill ${graph.cards.filter((card) => card.skill).length} 张，通用 ${graph.cards.filter((card) => !card.skill).length} 张）`, ...lines].join('\n') }
        }
        if (action === 'skills') {
          const current = status()
          const entries = Object.entries(current?.skills ?? {}).sort(([a], [b]) => a.localeCompare(b))
          if (entries.length === 0) return { kind: 'success', text: '这个项目还没有 skill。' }
          const lines = entries.map(([name, entry]) => {
            const detail = entry.state === 'failed'
              ? `${entry.hint ?? ''}${entry.stale ? ' 在此之前仍用旧版规则。' : ''}`
              : entry.state === 'retrying' ? entry.hint ?? ''
                : entry.state === 'compiling' && entry.parts > 1 ? `已完成 ${Math.round((entry.partsDone ?? 0) / entry.parts * 100)}%`
                  : ''
            return `${SKILL_STATE[entry.state] ?? entry.state}\t${name}${detail ? `\t${detail}` : ''}`
          })
          return { kind: 'success', text: [compileSummary(current), ...lines].join('\n') }
        }
        if (action !== 'status') return { kind: 'error', text: `没有“${action}”这个命令。\n\n${HELP_TEXT}` }
        const current = status()
        const item = agent ? state.agents.get(agent) : undefined
        return {
          kind: 'success',
          text: [
            `Eng Protocol：${{ live: '守护中', shadow: '影子模式（只观察，不打扰）', off: '已关闭' }[modeFor(agent)]}`,
            `生效的规则：${graph.cards.length} 条（来自 ${graph.graphs.length} 个 skill，另有 ${graph.cards.filter((card) => !card.skill).length} 条通用规则）`,
            `skill：${compileSummary(current)}`,
            `这个会话正在用的 skill：${item && item.activeSkills.size > 0 ? [...item.activeSkills].join('、') : '暂时没有'}`,
            `检查用的模型：${state.config.decision.provider && state.config.decision.model ? `${state.config.decision.provider}/${state.config.decision.model}` : '跟主对话用同一个'}`,
            `面板：${state.config.dashboard.path}　更多命令：/protocol help`,
          ].join('\n'),
        }
      },
    })
  })

  ctx.effect(() => () => {
    state.compileAbort.abort()
    for (const agent of state.liveAgents) {
      const item = state.agents.get(agent)
      item.disposed = true
      item.deferred.abort()
      discardPending(item, 'disposed')
    state.recordAftermath(item.aftermath.flush('disposed'))
      forgetAgent(state, agent)
    }
    state.liveAgents.clear()
    state.sessions.clear()
    state.graphs.clear()
    state.compileRuns.clear()
  }, 'eng-protocol: teardown')

  ctx.logger?.info?.(`eng-protocol: 已加载；面板 ${state.config.dashboard.path}`)
}
