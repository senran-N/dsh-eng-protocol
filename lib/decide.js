import { AdaptiveRegistry, classifyError, withRetry } from './adaptive.js'
import { candidateCards, renderGuidance } from './cards.js'
import { decisionRoute } from './config.js'
import { callJson } from './model.js'
import { clip, errorMessage, messageId, oneLine } from './text.js'
import { hasUnmitigatedDestructiveCommand } from './events.js'

const STATES = ['needed', 'addressing', 'satisfied', 'inapplicable', 'unknown']
// The judge must be at least this sure before it may clear a local critical preset.
const CLEARANCE_CONFIDENCE = 0.8

/** Judge instructions. */
export function decisionSystem() {
  return `You are the runtime judge for a coding agent's engineering protocol.
You receive bounded evidence from the current session, the exact action about to run (if any), and a small set of candidate decision cards.
For each candidate, decide whether a reminder could still change the next action.

States:
- needed: concrete evidence shows the obligation is not met and the next action would violate or omit it. A reminder can still change the outcome.
- addressing: the agent is already handling it; a reminder would be noise.
- satisfied: the evidence shows the obligation is already met.
- inapplicable: the card does not apply to this task or action.
- unknown: the evidence is insufficient to decide.

Return JSON only:
{"cards":[{"id":"...","state":"needed|addressing|satisfied|inapplicable|unknown","confidence":0.0,"reason":"short evidence-based reason"}]}

Rules:
- Use concrete evidence from the transcript, not the card title alone.
- Prefer unknown over needed when the evidence is weak or merely suspicious.
- Do not mark needed just because a risk exists in general; the next action must be able to violate the obligation now.
- Do not invent files, commands, user statements, or test results.
- Assess every candidate independently, including all applicable entry cards. Every confident needed card is delivered, so mark needed only when a reminder would change the next action; never hide a needed assessment to keep the reminder short.
- Read rules, notApplicable, source pointers and relations as evidence about obligations. requires/blocks point from prerequisite to dependent; contains is scope membership only. arbitrates/fuses are advisory and never automatic suppression.
- Entry cards (entry: true) decide whether a skill's scope applies to the current task: inapplicable when the task is outside that skill's scope; needed when the skill applies and its operating points are not yet being followed; addressing or satisfied when it applies and the agent is already following it.
- If the user explicitly authorized this exact operation, halt is satisfied; say so in the reason.
- If a failed check is followed by an edit that weakens, skips, mocks away, hardcodes, or suppresses the failing assertion, test, or type/lint error, anti_reward_hacking is needed even when the agent calls it a fix.
- If the agent has established a different root cause and the proposed edit still applies the earlier guessed change (for example loosening a threshold or timeout), refuted_premise is needed.
- If the latest change has no completed applicable check, verify is needed; a check that ran before that change does not cover it. Compare each check's editRevision (when it started) with the current editRevision; a smaller revision cannot verify later edits.
- A running, cancelled, or unknown check is NOT a passed check. Background job launch is not completion. Compare check cwd/scope against the edited files and action cwd: passing tests in another directory cannot verify this project's edits without explicit evidence of coverage.
- Source pointers marked precise:false are an unverified input range, not proof that a specific obligation appears at that exact line. Coverage counts describe extraction and retention, never semantic completeness.`
}

function evidencePayload(snapshot) {
  const ledger = snapshot.ledger ?? {}
  return {
    boundary: snapshot.boundary,
    cwd: snapshot.cwd ?? ledger.cwd,
    triggers: snapshot.triggers,
    action: snapshot.action
      ? {
          tool: snapshot.action.tool,
          kind: snapshot.action.kind,
          path: snapshot.action.path,
          paths: snapshot.action.paths,
          cwd: snapshot.action.cwd ?? snapshot.action.workdir ?? snapshot.action.args?.workdir ?? snapshot.cwd,
          workdir: snapshot.action.workdir ?? snapshot.action.args?.workdir,
          scope: snapshot.action.scope,
          callId: snapshot.action.callId,
          jobId: snapshot.action.jobId,
          command: snapshot.action.command ? oneLine(snapshot.action.command, 500) : undefined,
          excerpt: snapshot.action.excerpt ? clip(snapshot.action.excerpt, 2400) : undefined,
        }
      : undefined,
    turn: ledger.turn,
    step: ledger.step,
    user: clip(ledger.user ?? '', 1800),
    lastAssistant: clip(ledger.assistant ?? '', 900),
    filesRead: (ledger.filesRead ?? []).slice(-12),
    filesEdited: (ledger.filesEdited ?? []).slice(-12),
    checks: (ledger.checks ?? []).slice(-4),
    failures: (ledger.failures ?? []).slice(-3),
    failureStreak: ledger.failureStreak ?? 0,
    editRevision: ledger.editRevision,
    recentTools: (ledger.recent ?? []).slice(-6),
  }
}

export function decisionPrompt(snapshot, candidates) {
  const cards = candidates.map((card) => ({
    id: card.id,
    title: card.title,
    when: card.when,
    rules: card.rules,
    notApplicable: card.notApplicable,
    source: card.source,
    triggers: card.triggers,
    skill: card.skill,
    entry: card.entry === true ? true : undefined,
    critical: card.critical === true,
    satisfiedWhen: card.satisfiedWhen,
  }))
  const critical = candidates.filter((card) => card.critical === true).map((card) => card.id)
  const ids = new Set(candidates.map((card) => card.id))
  const relations = (snapshot.graph?.relations ?? []).filter((edge) => ids.has(edge.source) || ids.has(edge.target))
  return `CURRENT EVIDENCE:
${JSON.stringify(evidencePayload(snapshot), null, 2)}

CANDIDATE CARDS:
${JSON.stringify(cards, null, 2)}

Critical cards that must have an answer: ${critical.length > 0 ? critical.join(', ') : '(none)'}

RELATIONS (missing endpoints are not proof of completion):
${JSON.stringify(relations)}

ASSESSMENTS ALREADY MADE AT THIS SAME BOUNDARY:
${JSON.stringify(snapshot.priorAssessments ?? {})}

Return exactly one entry for every candidate id above. Do not omit candidates. Return the JSON object.`
}

/** Normalize model output into one assessment per candidate. */
export function normalizeAssessments(raw, candidates) {
  const byId = new Map(candidates.map((card) => [card.id, card]))
  const values = Array.isArray(raw?.cards)
    ? raw.cards
    : Array.isArray(raw?.assessments)
      ? raw.assessments
      : Object.entries(raw ?? {}).map(([id, value]) => ({ id, ...(typeof value === 'object' ? value : { state: value }) }))
  const assessments = {}
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const id = typeof value.id === 'string' ? value.id : undefined
    if (!id || !byId.has(id)) continue
    const state = STATES.includes(value.state) ? value.state : 'unknown'
    const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
      ? Math.min(1, Math.max(0, value.confidence))
      : state === 'needed' ? 0.7 : 0.5
    assessments[id] = {
      state,
      confidence,
      reason: typeof value.reason === 'string' ? oneLine(value.reason, 400) : undefined,
    }
  }
  for (const card of candidates) {
    if (!assessments[card.id]) assessments[card.id] = { state: 'unknown', confidence: 0, reason: '模型没有返回该卡片的判断' }
  }
  return assessments
}

/**
 * Apply thresholds, relations, coverage and cooldowns. There is no count cap:
 * every card that is confidently needed, in scope, unblocked, uncovered and not
 * cooling down is selected. `tracker` is the agent's own decision tick and
 * cooldown map, so sessions never throttle each other.
 */
export function selectAssessments(assessments, candidates, relations, config, tracker) {
  const reasons = {}
  const blocked = new Set()
  const outOfScope = new Set(candidates.filter((card) => card.entry
    && assessments[card.id]?.state === 'inapplicable'
    && assessments[card.id].confidence >= config.minConfidence).map((card) => card.skill))
  for (const edge of relations) {
    if (edge.type === 'requires' || edge.type === 'blocks') {
      const source = assessments[edge.source]
      const target = assessments[edge.target]
      if (target?.state === 'needed' && !(source?.confidence >= config.minConfidence
        && (source?.state === 'satisfied' || (edge.type === 'blocks' && source?.state === 'inapplicable')))) {
        blocked.add(edge.target)
        reasons[edge.target] = { kind: 'prerequisite', by: edge.source }
      }
    }
  }
  const eligible = candidates.filter((card) => {
    const assessment = assessments[card.id]
    if (assessment?.state !== 'needed') reasons[card.id] ??= { kind: 'state' }
    else if (assessment.confidence < config.minConfidence) reasons[card.id] = { kind: 'confidence' }
    else if (!card.entry && card.skill && outOfScope.has(card.skill)) reasons[card.id] = { kind: 'scope' }
    else if (blocked.has(card.id)) return false
    else if (!card.critical && config.cooldownSteps > 0 && tracker.cooldowns.has(card.id)
      && tracker.decisionTick - tracker.cooldowns.get(card.id) < config.cooldownSteps) reasons[card.id] = { kind: 'cooldown' }
    else return true
    return false
  })
  const covers = (a, b) => (!b.critical || a.critical) && relations.some((edge) => edge.type === 'covers' && edge.source === a.id && edge.target === b.id)
  const ranked = eligible
    .sort((left, right) => {
      if (covers(left, right)) return -1
      if (covers(right, left)) return 1
      const critical = Number(right.critical === true) - Number(left.critical === true)
      if (critical !== 0) return critical
      const priority = (right.priority ?? 1) - (left.priority ?? 1)
      if (priority !== 0) return priority
      return (assessments[right.id]?.confidence ?? 0) - (assessments[left.id]?.confidence ?? 0)
    })
  const selected = []
  for (const card of ranked) {
    const covering = selected.find((other) => covers(other, card))
    if (covering) {
      reasons[card.id] = { kind: 'covered', by: covering.id }
      continue
    }
    selected.push(card)
  }
  for (const card of selected) {
    reasons[card.id] = { kind: 'selected' }
  }
  for (const card of candidates) reasons[card.id] ??= { kind: 'state' }
  return { selected, reasons }
}

/** Make the source summary visible in the transcript row. */
export function sourceSummary(selected, triggers) {
  const ids = selected.map((card) => card.id)
  return oneLine(`eng-protocol · ${ids.join(', ') || 'no card'} · ${triggers.join(',')}`, 120)
}

/** Local critical evidence that does not depend on the judge's recall. */
export function criticalPreset(snapshot) {
  const preset = {}
  const action = snapshot.action
  if (action?.kind === 'command' && action.isDestructive === true && hasUnmitigatedDestructiveCommand(action.command ?? '')) {
    preset.halt = { state: 'needed', confidence: 1, reason: 'The command is destructive or outward-facing; verify authorization and rollback before running it.' }
  }
  if (action?.kind === 'edit' && action.isTest === true && (snapshot.ledger?.checks ?? []).at(-1)?.status === 'failed') {
    preset.anti_reward_hacking = { state: 'needed', confidence: 1, reason: 'The latest check failed and the next edit touches a test file; verify that the edit does not weaken the test.' }
  }
  return preset
}

/**
 * Presets are a floor, not an override: only a confident satisfied/inapplicable
 * from the judge (for example, the user explicitly authorized this push) clears
 * one. Returns the ids the judge cleared.
 */
export function applyPresets(assessments, preset, minConfidence) {
  const cleared = []
  const threshold = Math.max(CLEARANCE_CONFIDENCE, minConfidence)
  for (const [id, value] of Object.entries(preset)) {
    const judged = assessments[id]
    if (!judged) continue
    if ((judged.state === 'satisfied' || judged.state === 'inapplicable') && judged.confidence >= threshold) {
      cleared.push(id)
      continue
    }
    assessments[id] = value
  }
  return cleared
}

// Transient failures worth one quick retry inside a judgment's deadline.
const JUDGE_RETRY = new Set(['network', 'server', 'rate-limit', 'overloaded', 'bad-output', 'output-limit'])

/** Output tokens one judge call needs for `count` assessments. */
const outputFor = (count) => 320 + 110 * count

/**
 * Judge one batch. Output cut at the model's cap halves the batch (and the
 * route's batch size) instead of failing; transient errors get one quick retry.
 */
async function judgeBatch(context, cards, priorAssessments) {
  const { llm, route, control, config, snapshot, signal, caller, stats } = context
  const call = () => control.limiter.run(async (waited) => {
    stats.queueMs = Math.max(stats.queueMs, Math.round(waited))
    const started = performance.now()
    try {
      const raw = await callJson(llm, route, {
        system: decisionSystem(),
        prompt: decisionPrompt({ ...snapshot, priorAssessments }, cards),
        maxTokens: Math.max(512, Math.min(control.output.current, outputFor(cards.length))),
        temperature: config.decision.temperature,
        reasoningEffort: config.decision.reasoningEffort,
        timeoutMs: config.decision.timeoutMs,
        signal,
        onFit: (fit) => { control.effort = fit },
      })
      AdaptiveRegistry.observe(control, { ms: performance.now() - started })
      stats.calls += 1
      return normalizeAssessments(raw, cards)
    } catch (error) {
      if (!caller?.aborted) AdaptiveRegistry.observe(control, { ms: performance.now() - started, error })
      throw error
    }
  }, signal)
  try {
    return await withRetry(call, { signal, attempts: 2, baseMs: 250, maxDelayMs: 1500, retryable: (info) => JUDGE_RETRY.has(info.kind) })
  } catch (error) {
    const info = error?.classified ?? classifyError(error)
    if (!signal.aborted && info.kind === 'truncated' && cards.length > 1) {
      control.size.shrink(cards.length)
      stats.splits += 1
      const middle = Math.ceil(cards.length / 2)
      const [left, right] = await Promise.all([judgeBatch(context, cards.slice(0, middle), priorAssessments), judgeBatch(context, cards.slice(middle), priorAssessments)])
      return { ...left, ...right }
    }
    throw error
  }
}

/**
 * Judge every card, split into the route's adaptive batch size and run through
 * its adaptive limiter in parallel. A failed batch leaves its cards `unknown`;
 * only when every batch fails does the judgment as a whole fail.
 */
async function judgeCards(context, cards, priorAssessments) {
  const size = context.control.size.current
  const batches = []
  for (let index = 0; index < cards.length; index += size) batches.push(cards.slice(index, index + size))
  context.stats.batches += batches.length
  const settled = await Promise.allSettled(batches.map((batch) => judgeBatch(context, batch, priorAssessments)))
  context.signal.throwIfAborted()
  const assessments = {}
  const failures = []
  settled.forEach((item, index) => {
    if (item.status === 'fulfilled') Object.assign(assessments, item.value)
    else {
      failures.push(item.reason)
      for (const card of batches[index]) assessments[card.id] = { state: 'unknown', confidence: 0, reason: `这条没检查完：${oneLine(errorMessage(item.reason), 160)}` }
    }
  })
  if (failures.length === batches.length) throw failures[0]
  if (failures.length > 0) context.stats.partial.push(`有一部分规则没检查完：${errorMessage(failures[0])}`)
  else context.control.size.grow()
  return assessments
}

/**
 * Run one decision for one agent and return the selected guidance. Never throws.
 * `tracker` is that agent's state (its `agent`, decision tick and cooldowns).
 *
 * The judgment's deadline adapts to the route's observed latency (the configured
 * timeout is only the hard ceiling), and covers queueing for a slot as well as
 * every batch. When the judge is unavailable or fails, the local critical
 * presets still apply: they are facts about the action, not guesses. A decision
 * whose caller signal was aborted comes back `cancelled` and is not recorded.
 */
export async function evaluateDecision(ctx, state, tracker, snapshot) {
  const started = performance.now()
  const config = state.config
  const agent = tracker.agent
  const graph = snapshot.graph
  const llm = ctx.get('llm')
  const route = decisionRoute(agent, config)
  state.adaptive ??= new AdaptiveRegistry()
  const control = state.adaptive.for('judge', route)
  const candidates = [...snapshot.candidates]
  const deadlineMs = control.latency.timeout(config.decision.timeoutMs, { floor: 2500 })
  const record = {
    kind: 'decision',
    decisionId: messageId(),
    evidenceSeq: snapshot.ledger?.evidenceSeq,
    responseSeq: snapshot.ledger?.responseSeq,
    judgedAt: new Date().toISOString(),
    queueMs: 0,
    sessionId: agent?.session?.id ?? agent?.id,
    cwd: snapshot.cwd,
    boundary: snapshot.boundary,
    triggers: snapshot.triggers,
    candidates: candidates.map((card) => card.id),
    selected: [],
    assessments: {},
    injected: false,
    blocked: false,
    model: route ? `${route.provider}/${route.model}` : undefined,
    graphRevision: graph.revision,
    turn: snapshot.ledger?.turn,
    step: snapshot.ledger?.step,
    // Where this happened in the session, for "open in Trajectory".
    seq: snapshot.ledger?.lastSeq,
    callId: snapshot.action?.callId,
    deadlineMs,
  }
  const deadline = AbortSignal.timeout(deadlineMs)
  const caller = snapshot.signal
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline
  const stats = { calls: 0, batches: 0, splits: 0, queueMs: 0, partial: [] }
  const finish = (result) => {
    record.latencyMs = Math.round(performance.now() - started)
    record.judgedAt = new Date().toISOString()
    record.queueMs = stats.queueMs
    record.batches = stats.batches
    if (stats.splits) record.splits = stats.splits
    if (deadline.aborted && !caller?.aborted) record.deadlineExpired = true
    return { record, cards: [], guidance: '', assessments: {}, ...result }
  }
  const preset = criticalPreset(snapshot)
  if (caller?.aborted) return finish({ cancelled: true })
  const presetIds = Object.keys(preset).filter((id) => candidates.some((card) => card.id === id))
  const context = { llm, route, control, config, snapshot, signal, caller, stats }
  let assessments
  try {
    if (!llm || !route) throw new Error('还没有可用的检查模型：请在“设置”里填写模型')
    assessments = await judgeCards(context, candidates)
    const active = new Set(snapshot.activeSkills ?? [])
    for (const card of candidates.filter((card) => card.entry)) {
      const verdict = assessments[card.id]
      if (verdict.confidence < config.minConfidence) continue
      if (verdict.state === 'inapplicable') active.delete(card.skill)
      else if (['needed', 'addressing', 'satisfied'].includes(verdict.state)) active.add(card.skill)
    }
    // A skill this judgment just brought into scope gets its section cards judged now.
    const extra = candidateCards(graph.cards, { triggers: snapshot.triggers, active, relations: graph.relations })
      .filter((card) => card.skill && !card.entry && !candidates.some((existing) => existing.id === card.id))
    if (extra.length > 0) {
      candidates.push(...extra)
      record.candidates = candidates.map((card) => card.id)
      record.scopeExpanded = extra.map((card) => card.id)
      try { Object.assign(assessments, await judgeCards(context, extra, assessments)) }
      catch (error) {
        if (caller?.aborted) return finish({ cancelled: true })
        stats.partial.push(`刚用上的 skill 规则没检查完：${errorMessage(error)}`)
        Object.assign(assessments, normalizeAssessments({}, extra))
      }
    }
    if (stats.partial.length > 0) record.error = stats.partial.join('；')
  } catch (error) {
    if (caller?.aborted) return finish({ cancelled: true })
    record.error = deadline.aborted ? `检查超时：模型 ${Math.round(deadlineMs / 1000)} 秒内没有回答，这次没有提醒` : `检查没完成：${errorMessage(error)}`
    record.errorKind = deadline.aborted ? 'timeout' : classifyError(error).kind
    if (presetIds.length === 0) return finish({})
    assessments = Object.fromEntries(candidates.map((card) => [card.id, { state: 'unknown', confidence: 0, reason: '检查模型没回答；危险操作仍按默认先拦下' }]))
  }
  if (caller?.aborted) return finish({ cancelled: true })
  const cleared = applyPresets(assessments, preset, config.minConfidence)
  tracker.decisionTick += 1
  const { selected, reasons } = selectAssessments(assessments, candidates, graph.relations, config, tracker)
  const guidance = selected.length > 0 ? renderGuidance(selected, { boundary: snapshot.boundary, triggers: snapshot.triggers }) : ''
  record.assessments = Object.fromEntries(Object.entries(assessments).map(([id, item]) => [id, { state: item.state, confidence: item.confidence, reason: item.reason }]))
  record.reasons = reasons
  record.preset = presetIds.filter((id) => !cleared.includes(id))
  if (cleared.length > 0) record.cleared = cleared
  record.selected = selected.map((card) => card.id)
  return finish({ cards: selected, guidance, assessments })
}
