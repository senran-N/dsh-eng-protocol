/**
 * dsh-eng-protocol — event-driven engineering protocol guidance for DeepSeek Harness.
 *
 * Skills an agent uses are compiled into grounded decision cards: every
 * obligation is backed by a quote verified against the skill's own text.
 * Evidence is detected locally, a small decision model is asked only about the
 * cards that evidence can trigger, and reminders travel on the host's own
 * channels, each at the moment it can still change something:
 * - standing context (`ctx.systemPrompt.context`): the loaded skills' hard
 *   requirements, re-materialized by the host only when they change or after
 *   compaction removed them;
 * - request (`agent/pre-step`): turn-level checks, skill routing, and verdicts
 *   on tool results;
 * - before an action (`tools/pre-execute`): an enforceable card blocks once;
 * - after an action (`tools/post-execute`): advisory verdicts ride that tool's
 *   own result;
 * - delivery (`agent/turn-stopping`): a final review may continue the turn once.
 * Every decision is logged; the dashboard renders the cards and the trail.
 */
import { sleep } from './lib/adaptive.js'
import { agentCwd, resolveConfig } from './lib/config.js'
import { candidateCards, enforceable, isEntryCard, renderGuidance, renderStanding } from './lib/cards.js'
import { catalogListed, compileStatusFor, forgetAgent, graphFor, graphReady, refreshSkills, stopCompiles, wantSkill } from './lib/compiler.js'
import { evaluateDecision, sourceSummary } from './lib/decide.js'
import { SessionLedger, actionExcerpt, actionTriggers, classifyTool } from './lib/events.js'
import { Aftermath } from './lib/aftermath.js'
import { BLOCK_INFO } from './lib/intervention.js'
import { AdaptiveRegistry } from './lib/adaptive.js'
import { appendDecision } from './lib/store.js'
import { errorMessage, hash, messageId, oneLine } from './lib/text.js'
import { compileSummary, registerDashboard, skillDetail } from './lib/dashboard.js'

export const name = 'eng-protocol'

const SOURCE = 'eng-protocol'
// Runtime-context placement: after the harness's own contexts (100–210).
const STANDING_ORDER = 400
const HELP_TEXT = [
  '/protocol                 现在的状态',
  '/protocol cards           当前生效的规则',
  '/protocol skills          用到的 skill 准备好了没有',
  '/protocol retry           马上重试没准备好的部分',
  '/protocol rebuild [名称]  重新编译用到的 skill，或只编译某一个；期间旧规则照常工作',
  '/protocol on | off        在这个会话里打开或关闭',
  '/protocol shadow          在这个会话里只观察：照常检查和记录，但不提醒、不拦下',
  '/protocol help            显示这份说明',
].join('\n')
const SKILL_STATE = { ready: '已就绪', standby: '用到时准备', queued: '排队中', compiling: '准备中', retrying: '部分就绪', failed: '没准备好' }

/** Wait for `promise`, giving up quietly after `ms` or when `signal` aborts. */
function waitAtMost(promise, ms, signal) {
  return Promise.race([Promise.resolve(promise).catch(() => undefined), sleep(ms, signal).catch(() => undefined)])
}

/** Wait for `promise`, rejecting as soon as `signal` aborts. */
function unlessAborted(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error('aborted')); return }
    const stop = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', stop, { once: true })
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', stop); resolve(value) },
      (error) => { signal.removeEventListener('abort', stop); reject(error) },
    )
  })
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
    profileConfig: structuredClone(rawConfig),
    // The most recently published graph per project, for the project summary view.
    graphs: new Map(),
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
    recordDecision(record, evidence) {
      state.lastDecision = record
      void appendDecision(state.config, record, { evidence }).catch((error) => warn('决策日志写入失败', error))
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
      // Aborts tool-boundary judgments still running when their turn ends.
      deferred: new AbortController(),
      // Reminders that could not ride a tool result, delivered at the next step.
      pending: [],
      // Tool-boundary verdicts waiting for their tool's result (`tools/post-execute`), by call id.
      claims: new Map(),
      // Calls soft-blocked this turn; the same call goes through on retry.
      retryKeys: new Set(),
      settledTurn: undefined,
      // Skills this agent has loaded (or the user invoked), until judged out of scope.
      activeSkills: new Set(),
      // Confident load recommendations persist until loaded, superseded, or a new task.
      requestedSkills: new Set(),
      // Card id → step of its last delivery; cleared at a new turn.
      cooldowns: new Map(),
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
    for (const [callId, claim] of item.claims) {
      item.claims.delete(callId)
      if (claim.result) finish(item, claim.result, 'live', [], reason)
    }
  }

  /** Settled tool-boundary verdicts that no tool result carried; they ride the next model-visible boundary instead. */
  function drainClaims(item) {
    const out = []
    for (const [callId, claim] of item.claims) {
      if (!claim.settled) continue
      item.claims.delete(callId)
      if (claim.result) out.push(delivery('tool', claim.triggers, claim.result))
    }
    return out
  }

  /** Read the agent's catalog once; restore prepared skills and compile sources as needed. */
  function ensureCatalog(agent) {
    if (state.started.has(agent)) return
    state.started.add(agent)
    const item = agentState(agent)
    // Skills a resumed session had already loaded are in use.
    for (const skill of item.activeSkills) void wantSkill(ctx, state, agent, skill)
    void refreshSkills(ctx, state, agent).catch((error) => warn('skill 目录读取失败', error))
    item.firstCatalog = graphReady(state, agent)
  }

  /** Drain evidence. A new human turn resets the per-turn soft-block memory, cooldowns and stale deferred reminders. */
  function observe(item, messages) {
    const triggers = new Set(item.ledger.observe(messages).triggers)
    if (triggers.has('turn')) {
      state.recordAftermath(item.aftermath.flush('new-turn'))
      item.retryKeys.clear()
      discardPending(item, 'new-turn')
      item.cooldowns.clear()
      item.requestedSkills.clear()
    }
    return triggers
  }

  /**
   * A skill enters scope when the agent actually has its text: the model
   * loaded it, or the user invoked it. That is also when it is compiled, once,
   * for every agent and project that uses the same text.
   */
  function noteSkillLoad(item, triggers) {
    if (!triggers.has('skill')) return
    for (const skill of item.ledger.observedSkills) {
      item.activeSkills.add(skill)
      item.requestedSkills.delete(skill)
      void Promise.resolve().then(() => wantSkill(ctx, state, item.agent, skill)).catch((error) => warn('skill 编译失败', error))
    }
  }

  function candidatesFor(item, triggers, action) {
    const ledger = item.ledger
    const failedPaths = triggers.has('failed') || triggers.has('stuck')
      ? ledger.observations.filter((entry) => entry.status === 'error').slice(-3).flatMap((entry) => entry.paths ?? (entry.path ? [entry.path] : []))
      : []
    const graph = graphFor(state, item.cwd, item.agent)
    const names = new Set(graph.graphs.map((skill) => skill.name))
    // A skill that left the catalog leaves scope, once the catalog has really been read.
    if (catalogListed(state, item.agent)) {
      for (const skill of item.activeSkills) if (!names.has(skill)) item.activeSkills.delete(skill)
    }
    return candidateCards(graph.cards, {
      triggers: [...triggers],
      active: item.activeSkills,
      requested: item.requestedSkills,
      relations: graph.relations,
      invoked: triggers.has('skill') ? ledger.lastSkill : '',
      query: [ledger.lastUser, ...[...ledger.filesEdited].slice(-12), ...[...ledger.filesRead].slice(-12)].join('\n'),
      action,
      files: [...ledger.filesEdited, ...failedPaths].slice(-40),
      commands: ledger.observations.filter((observation) => observation.command).slice(-12).map((observation) => observation.command),
    })
  }

  /** A loaded skill leaves scope when its entry card is confidently judged inapplicable to the task at hand. */
  function updateActiveSkills(item, candidates, assessments = {}) {
    for (const card of candidates) {
      if (!isEntryCard(card) || !item.activeSkills.has(card.skill)) continue
      const assessment = assessments[card.id]
      if (assessment?.state === 'inapplicable' && assessment.confidence >= state.config.minConfidence) {
        item.activeSkills.delete(card.skill)
      }
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
      // Invoked this very step: in scope by definition, so its rules are judged at once.
      invoked: triggers.includes('skill') ? item.ledger.lastSkill : '',
      signal,
    }
  }

  /** One cache key per agent, boundary, candidates, evidence position and action fingerprint. */
  function judgeCacheKey(item, boundary, triggers, action, candidates) {
    const ledger = item.ledger
    const actionPart = action ? hash([action.tool, action.args, action.command, action.path, action.cwd ?? '']) : ''
    return hash([
      item.agent?.session?.id ?? item.agent?.id, item.cwd, boundary,
      graphFor(state, item.cwd, item.agent).revision,
      state.config.decision, state.config.minConfidence, state.config.cooldownSteps,
      item.agent?.options?.provider, item.agent?.options?.model,
      [...item.activeSkills].sort(), [...triggers].sort(),
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
  function judge(item, boundary, triggers, action, signal, candidates = candidatesFor(item, triggers, action), { onSettled } = {}) {
    if (candidates.length === 0) return Promise.resolve(undefined)
    const list = [...triggers]
    // Only the tool boundary caches: repeated triggers for identical actions at
    // one evidence position. Request/settle judgments drive scope and re-run.
    const cacheKey = boundary === 'tool' ? judgeCacheKey(item, boundary, triggers, action, candidates) : ''
    const ttl = boundary === 'tool' ? state.config.decision.cacheTtlMs : 0
    if (ttl > 0) {
      const cached = state.judgeCache.get(cacheKey)
      if (cached && Date.now() - cached.at < ttl) {
        cached.hits = (cached.hits ?? 0) + 1
        const record = { ...cached.result.record, cacheHit: true, cachedFrom: cached.result.record.decisionId,
          callId: action?.callId, latencyMs: 0, decisionId: messageId() }
        const result = { ...cached.result, record }
        // A cache hit settles exactly like a fresh judgment would.
        onSettled?.(result)
        return Promise.resolve(result)
      }
    }
    const captured = snapshot(item, boundary, list, action, candidates, AbortSignal.any([signal, item.deferred.signal].filter(Boolean)))
    const inflight = (item.inflight ??= new Set())
    // The settle callback runs inside this promise, so a boundary waiting on
    // in-flight judgments observes their outcome in the same step.
    const promise = (async () => {
      if (item.disposed || captured.signal.aborted) return undefined
      return evaluateDecision(ctx, state, item, captured)
    })().then((result) => {
      inflight.delete(promise)
      if (result && !result.cancelled) {
        // Only a new task can retire a loaded skill. An unrelated intermediate
        // action or failure is not evidence that the whole task left its scope.
        if (captured.triggers.includes('turn')) updateActiveSkills(item, candidates, result.assessments)
        for (const card of candidates) {
          if (!isEntryCard(card)) continue
          const assessment = result.assessments[card.id]
          if (item.activeSkills.has(card.skill)) item.requestedSkills.delete(card.skill)
          else if (assessment?.confidence >= state.config.minConfidence) {
            if (assessment.state === 'needed' && card.modelInvocable !== false) item.requestedSkills.add(card.skill)
            else if (['inapplicable', 'satisfied'].includes(assessment.state)) item.requestedSkills.delete(card.skill)
          }
        }
        if (ttl > 0 && cacheKey && !result.record?.error) {
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
    record.delivery = disposition
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
    record.deliverySeq = item.ledger.lastSeq
    record.deliveryRecorded = ['delivered', 'blocked'].includes(disposition) || (mode === 'shadow' && record.wouldInject)
    // Cooldowns count real steps of the turn, not judge calls.
    for (const card of mode === 'shadow' ? result.cards : deliveredCards) item.cooldowns.set(card.id, item.ledger.step)
    state.recordDecision(record, result.evidenceSnapshot)
    if (record.deliveryRecorded) item.aftermath.watch(record)
  }

  function delivery(boundary, triggers, result) {
    return { boundary, triggers: [...triggers], cards: result.cards, text: result.guidance, result }
  }

  /**
   * Notices for this step. A card already carried by an earlier one is not
   * repeated, nor one another boundary delivered in this same step (delivery
   * review excepted: it is the last word of the turn). A skill's entry card is
   * delivered only while that skill is not loaded (a load nudge); its
   * obligations only while it is.
   */
  function noticesFor(item, deliveries, assessments = {}, send) {
    const seen = new Set()
    const notices = []
    const current = new Map(graphFor(state, item.cwd, item.agent).cards.map((card) => [card.id, card]))
    const step = item.ledger.step
    const valid = (card, entry) => current.has(card.id) && hash(current.get(card.id)) === hash(card)
      && (!card.skill || (card.entry ? !item.activeSkills.has(card.skill) : item.activeSkills.has(card.skill)))
      && !(['satisfied', 'addressing', 'inapplicable'].includes(assessments[card.id]?.state)
        && assessments[card.id].confidence >= state.config.minConfidence
        && !(assessments[card.id].state === 'addressing' && entry.result.record.reasons?.[card.id]?.kind === 'verification'))
    for (const entry of deliveries) {
      const cards = entry.cards.filter((card) => !seen.has(card.id) && valid(card, entry)
        && (entry.boundary === 'settle' || item.cooldowns.get(card.id) !== step))
      if (cards.length === 0) { finish(item, entry.result, 'live', [], 'superseded'); continue }
      for (const card of cards) seen.add(card.id)
      const text = cards.length === entry.cards.length
        ? entry.text
        : renderGuidance(cards, { boundary: entry.boundary, triggers: entry.triggers, assessments: entry.result.assessments })
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

  /** Standing context for one agent: its loaded skills' grounded requirements, or nothing. */
  function standingText(agent) {
    if (!agent || state.config.skills.standing === false || modeFor(agent) !== 'live') return ''
    const item = state.agents.get(agent)
    if (!item || item.disposed || item.activeSkills.size === 0) return ''
    const graph = graphFor(state, item.cwd, agent)
    const byName = new Map(graph.graphs.map((skill) => [skill.name, skill]))
    return renderStanding([...item.activeSkills].sort().map((skill) => byName.get(skill)).filter(Boolean))
  }

  ctx.on('agent/created', ({ agent }) => {
    agentState(agent)
    if (modeFor(agent) !== 'off') ensureCatalog(agent)
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
    ensureCatalog(payload.agent)
    // The first step may arrive before this agent's catalog is read. That needs
    // no model call; the hard timeout only guards a host whose catalog never answers.
    if (item.firstCatalog) {
      await waitAtMost(item.firstCatalog, state.config.decision.timeoutMs, payload.signal)
      item.firstCatalog = undefined
    }
    // At a new human turn, tool-boundary judgments still running belong to the previous turn.
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
      const candidates = candidatesFor(item, triggers)
      // Tool-boundary verdicts no tool result could carry ride this step instead;
      // they never replace this step's own judgment.
      const deliveries = [...drainClaims(item), ...item.pending.splice(0)]
      let latestAssessments = {}
      const signal = AbortSignal.any([payload.signal, item.deferred.signal])
      if (candidates.length > 0) {
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

  // ---- before an action -------------------------------------------------
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
    const candidates = candidatesFor(item, triggers, action)
    if (candidates.length === 0) return downstream
    item.ledger.consumeAction(exec.callId)
    const key = hash([exec.name, exec.arguments])
    const canDeny = state.config.enforcement.enabled
      && (action.kind === 'edit' || action.kind === 'command')
      && !item.retryKeys.has(key)
    // Scope recommendations use context, never a failed tool result. Only an
    // enforceable obligation can stop execution before the body is dispatched.
    const gate = (card) => enforceable(card, state.config.enforcement)
    // Only a judgment that can still stop this call is worth waiting for.
    const waitForDecision = mode === 'live' && canDeny && candidates.some(gate)
    const claim = { callId: exec.callId, triggers, settled: false, result: undefined, promise: undefined }
    const settle = (result) => {
      claim.settled = true
      if (!result || result.cancelled || item.disposed || modeFor(exec.agent) !== mode) return undefined
      // Uncertain grounded duties may ask the agent to verify, never block it.
      // A parallel identical call may already have consumed this turn's block
      // while this judgment was running. Claim the block only at settlement.
      const deny = canDeny && !item.retryKeys.has(key) && (mode !== 'live' || waitForDecision) && result.cards.some((card) => gate(card)
        && result.assessments[card.id]?.state === 'needed')
      // One soft block per call and turn; the identical retry goes through.
      if (deny) item.retryKeys.add(key)
      result.record.blocked = mode === 'live' && deny
      if (mode === 'shadow' && deny) result.record.wouldBlock = true
      if (mode !== 'live') { finish(item, result, mode); return undefined }
      if (deny) {
        finish(item, result, mode, result.cards, 'blocked')
        const reason = 'eng-protocol 执行前暂停（本次工具未执行，不是命令失败）。\n\n'
          + renderGuidance(result.cards, { boundary: 'tool', triggers: [...triggers], assessments: result.assessments, blocked: true })
        return { kind: 'deny', reason, info: { ...BLOCK_INFO, reason } }
      }
      if (!result.guidance) { finish(item, result, mode); return undefined }
      // Advisory verdicts ride this call's own result; without a call id, the next step.
      if (exec.callId === undefined) item.pending.push(delivery('tool', triggers, result))
      else claim.result = result
      return undefined
    }
    const signal = AbortSignal.any([exec.signal, item.deferred.signal].filter(Boolean))
    if (!waitForDecision) {
      // The rest runs alongside the tool; `tools/post-execute` collects it.
      claim.promise = judge(item, 'tool', triggers, action, signal, candidates, { onSettled: settle })
      if (exec.callId !== undefined) item.claims.set(exec.callId, claim)
      claim.promise.catch((error) => { claim.settled = true; warn('执行前判断失败', error) })
      return downstream
    }
    try {
      // Awaited path: settle decides the deny result, so it must not also run
      // as a deferred callback — pass no onSettled here.
      const verdict = settle(await judge(item, 'tool', triggers, action, signal, candidates))
      if (verdict) return verdict
      if (claim.result && exec.callId !== undefined) {
        claim.promise = Promise.resolve(claim.result)
        item.claims.set(exec.callId, claim)
      }
      return downstream
    } catch (error) {
      warn('执行前判断失败', error)
      return downstream
    }
  })

  // ---- after an action ----------------------------------------------------
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const item = exec?.agent ? state.agents.get(exec.agent) : undefined
    const claim = item && exec.callId !== undefined ? item.claims.get(exec.callId) : undefined
    // Only a root call's own result is sure to reach the model; a nested
    // sub-dispatch leaves its verdict for the next step.
    if (!claim || exec.parent !== undefined) return decision
    if (!claim.settled) {
      try { await unlessAborted(claim.promise, exec.signal) } catch { return decision }
    }
    if (item.claims.get(exec.callId) !== claim) return decision
    item.claims.delete(exec.callId)
    if (!claim.result) return decision
    if (modeFor(exec.agent) !== 'live' || item.disposed) {
      finish(item, claim.result, 'live', [], 'cancelled')
      return decision
    }
    try {
      const notices = noticesFor(item, [delivery('tool', claim.triggers, claim.result)])
      if (notices.length === 0) return decision
      return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), ...notices] }
    } catch (error) {
      warn('执行后提醒失败', error)
      return decision
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
      const bounded = AbortSignal.any([signal, item.deferred.signal].filter(Boolean))
      await settleInflight(item, bounded)
      const triggers = observe(item, [])
      triggers.add('settle')
      noteSkillLoad(item, triggers)
      const result = await judge(item, 'settle', triggers, undefined, bounded)
      if (result?.cancelled) return
      if (mode !== 'live') { if (result) finish(item, result, mode); return }
      const deliveries = [...drainClaims(item), ...item.pending.splice(0)]
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
    // Re-reading a catalog is cheap: unchanged skills keep their stored compile,
    // and only changed skills in use compile again (their old compile guards meanwhile).
    for (const agent of state.liveAgents) {
      if (!state.started.has(agent)) continue
      void refreshSkills(ctx, state, agent).catch((error) => warn('skill 变更后刷新失败', error))
    }
  })

  // ---- standing context -------------------------------------------------
  ctx.inject(['systemPrompt'], (promptCtx) => {
    const prompt = promptCtx.systemPrompt
    if (!prompt || typeof prompt.context !== 'function') return
    promptCtx.effect(() => prompt.context({
      name: 'eng-protocol:skills',
      order: STANDING_ORDER,
      // Skill text may contain `{{...}}`; it is quoted, never a prompt variable.
      interpolate: false,
      text: (assembly) => {
        try { return standingText(assembly?.agent) } catch (error) { warn('常驻要求生成失败', error); return '' }
      },
    }), 'eng-protocol: standing skill requirements')
  })

  // ---- dashboard --------------------------------------------------------
  registerDashboard(ctx, state)

  // ---- /protocol command ------------------------------------------------
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: 'eng-protocol',
      name: 'protocol',
      description: '查看决策卡和 skill 准备情况；支持 status / cards / skills / retry / rebuild / on / off / shadow / help',
      input: { hint: 'status | cards | skills | retry | rebuild [skill] | on | off | shadow | help' },
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
        const status = () => (agent ? compileStatusFor(state, agent, cwd) : undefined)
        if (['rebuild', 'retry'].includes(action) && !agent) return { kind: 'error', text: '这个会话还没开始运行，先发一条消息再试。' }
        if (action === 'rebuild') {
          const names = graphFor(state, cwd, agent).graphs.map((graph) => graph.name)
          if (argument && !names.includes(argument)) {
            return { kind: 'error', text: `没有叫 ${argument} 的 skill。现有的是：${names.join('、') || '（没有）'}` }
          }
          const inUse = Object.entries(status()?.skills ?? {}).filter(([, entry]) => entry.inUse).map(([skill]) => skill)
          if (!argument && inUse.length === 0) return { kind: 'success', text: '这个会话还没用到 skill，没有需要重新编译的。' }
          void refreshSkills(ctx, state, agent, { rebuild: argument ? [argument] : true }).catch((error) => warn('skill 重新编译失败', error))
          return { kind: 'success', text: `${argument ? `正在重新编译 ${argument}` : `正在重新编译 ${inUse.join('、')}`}，期间旧规则照常工作。进度可以用 /protocol skills 查看。` }
        }
        if (action === 'retry') {
          const failed = Object.entries(status()?.skills ?? {}).filter(([, entry]) => ['failed', 'retrying'].includes(entry.state)).map(([skill]) => skill)
          void refreshSkills(ctx, state, agent, { retry: true }).catch((error) => warn('skill 重试失败', error))
          return { kind: 'success', text: failed.length > 0
            ? `正在重试：${failed.join('、')}。已经准备好的部分不会重做。`
            : '没有需要重试的 skill；也顺便看了一遍有没有新加或改过的 skill。' }
        }
        const graph = graphFor(state, cwd, agent)
        if (action === 'cards') {
          const kind = (card) => !card.skill ? 'builtin' : card.entry ? 'entry' : card.checkpoint ? 'skill·动手前' : 'skill'
          const lines = graph.cards.map((card) => `${kind(card)}\t${card.id}\t${card.title}\t${card.triggers.join(',')}`)
          return { kind: 'success', text: [`决策卡 ${graph.cards.length} 张（来自 skill ${graph.cards.filter((card) => card.skill).length} 张，通用 ${graph.cards.filter((card) => !card.skill).length} 张）`, ...lines].join('\n') }
        }
        if (action === 'skills') {
          const current = status()
          const entries = Object.entries(current?.skills ?? {}).sort(([a], [b]) => a.localeCompare(b))
          if (entries.length === 0) return { kind: 'success', text: '这个项目还没有 skill。' }
          const used = entries.filter(([, entry]) => entry.inUse)
          const lines = used.map(([skill, entry]) => `${SKILL_STATE[entry.state] ?? entry.state}\t${skill}\t${skillDetail(entry)}`.trimEnd())
          const idle = entries.length - used.length
          if (idle > 0) lines.push(`${used.length > 0 ? '其余 ' : ''}${idle} 个 skill 还没用到，用到时自动准备`)
          return { kind: 'success', text: [compileSummary(current), ...lines].join('\n') }
        }
        if (action !== 'status') return { kind: 'error', text: `没有“${action}”这个命令。\n\n${HELP_TEXT}` }
        const current = status()
        const item = agent ? state.agents.get(agent) : undefined
        const skillCards = graph.cards.filter((card) => card.skill && !card.entry).length
        return {
          kind: 'success',
          text: [
            `Eng Protocol：${{ live: '守护中', shadow: '影子模式（只观察，不打扰）', off: '已关闭' }[modeFor(agent)]}`,
            `生效的规则：通用 ${graph.cards.filter((card) => !card.skill).length} 条；${graph.graphs.length} 个 skill 已整理出 ${skillCards} 条`,
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
    stopCompiles(state)
    for (const agent of state.liveAgents) {
      const item = state.agents.get(agent)
      if (!item) continue
      item.disposed = true
      item.deferred.abort()
      discardPending(item, 'disposed')
      state.recordAftermath(item.aftermath.flush('disposed'))
      forgetAgent(state, agent)
    }
    state.liveAgents.clear()
    state.sessions.clear()
    state.graphs.clear()
  }, 'eng-protocol: teardown')

  ctx.logger?.info?.(`eng-protocol: 已加载；面板 ${state.config.dashboard.path}`)
}
