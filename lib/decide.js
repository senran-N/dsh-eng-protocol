import { AdaptiveRegistry, classifyError, withRetry } from './adaptive.js'
import { renderGuidance } from './cards.js'
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
- A skill card's quote is the skill's own wording, verified against its text (grounded: true). Judge against the quote first; a card with grounded: false is the compiler's paraphrase and deserves less weight. checkpoint: true marks something the skill requires BEFORE the action: needed when the action about to run would skip it.
- Entry cards (entry: true) decide whether a skill's scope covers the current task. With loaded: true the skill's instructions are already in the conversation: inapplicable when the current task is outside that skill's scope, otherwise addressing. With loaded: false: needed only when the task clearly falls inside the skill's scope (description and guidance) so that loading it would change what the agent does next; inapplicable otherwise. Do not mark needed merely because a skill is loosely related.
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
  const loaded = snapshot.activeSkills ?? new Set()
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
    loaded: card.entry === true ? loaded.has(card.skill) : undefined,
    critical: card.critical === true,
    quote: card.quote,
    grounded: card.skill && !card.entry ? card.grounded === true : undefined,
    checkpoint: card.checkpoint === true ? true : undefined,
    match: card.match,
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
 * cooling down is selected. `tracker` carries the agent's own cooldown map, the
 * current step (cooldowns count real steps of the turn) and its loaded skills,
 * so sessions never throttle each other. A loaded skill's entry card only
 * decides scope; it is never delivered.
 */
export function selectAssessments(assessments, candidates, relations, config, tracker) {
  const reasons = {}
  const blocked = new Set()
  const now = tracker.step ?? 0
  const loaded = tracker.active ?? new Set()
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
    else if (card.entry && loaded.has(card.skill)) reasons[card.id] = { kind: 'loaded' }
    else if (!card.entry && card.skill && outOfScope.has(card.skill)) reasons[card.id] = { kind: 'scope' }
    else if (blocked.has(card.id)) return false
    else if (!card.critical && config.cooldownSteps > 0 && tracker.cooldowns.has(card.id)
      && now - tracker.cooldowns.get(card.id) < config.cooldownSteps) reasons[card.id] = { kind: 'cooldown' }
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
 * Cut cards into batches of at most `size`. Cards joined by a relation stay in
 * one batch, so the judge reads both ends of an edge together; `contains` only
 * says which skill a rule belongs to and joins nothing. A group larger than a
 * batch is cut in order. Each group keeps the place of its first card, so the
 * importance order still decides which batch runs first.
 */
export function packBatches(cards, size, relations = []) {
  const at = new Map(cards.map((card, index) => [card.id, index]))
  // Union-find whose root is always the group's first card.
  const root = cards.map((_, index) => index)
  const find = (index) => {
    while (root[index] !== index) {
      root[index] = root[root[index]]
      index = root[index]
    }
    return index
  }
  for (const edge of relations) {
    if (edge.type === 'contains') continue
    const a = at.get(edge.source)
    const b = at.get(edge.target)
    if (a === undefined || b === undefined) continue
    const [low, high] = [find(a), find(b)].sort((x, y) => x - y)
    root[high] = low
  }
  const groups = new Map()
  cards.forEach((card, index) => {
    const key = find(index)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(card)
  })
  const batches = []
  let open = []
  for (const group of groups.values()) {
    if (open.length > 0 && open.length + group.length > size) {
      batches.push(open)
      open = []
    }
    if (group.length <= size) {
      open.push(...group)
      continue
    }
    let index = 0
    for (; index + size <= group.length; index += size) batches.push(group.slice(index, index + size))
    open = group.slice(index)
  }
  if (open.length > 0) batches.push(open)
  return batches
}

/**
 * Layered judging along the graph's `contains` edges, which hang every skill
 * rule under its skill's entry card. When a boundary judges entry cards (a new
 * turn) and the whole set would not fit in one wave of parallel batches, the
 * rules under those entries are held back: the entries are judged first and
 * only the rules of skills still in scope follow. A set that fits in one wave
 * is judged in one round, which is faster than two. A skill invoked this very
 * step is in scope by definition, so its rules are never held back.
 */
export function planRounds(candidates, relations = [], { invoked = '', wave = Infinity } = {}) {
  const entries = new Set(candidates.filter((card) => card.entry && card.skill !== invoked).map((card) => card.id))
  const parent = new Map()
  for (const edge of relations) {
    if (edge.type === 'contains' && entries.has(edge.source)) parent.set(edge.target, edge.source)
  }
  const held = candidates.filter((card) => parent.has(card.id))
  if (held.length === 0 || candidates.length <= wave) return { first: candidates, held: [], parent }
  return { first: candidates.filter((card) => !parent.has(card.id)), held, parent }
}

/**
 * Split held rules by their entry's verdict: a skill confidently judged out of
 * scope keeps its rules unexpanded; any other verdict, a failed one included,
 * expands them.
 */
export function expandHeld(plan, assessments, minConfidence) {
  const open = []
  const skipped = new Map()
  for (const card of plan.held) {
    const entry = plan.parent.get(card.id)
    const verdict = assessments[entry]
    if (verdict?.state === 'inapplicable' && verdict.confidence >= minConfidence) skipped.set(card.id, entry)
    else open.push(card)
  }
  return { open, skipped }
}

/**
 * Judge one batch. Output cut at the model's cap halves the batch (and the
 * route's batch size) instead of failing; transient errors get one quick retry.
 * A call the round's time limit cut off after running more than half of it
 * marks the batch as too big for the route; one cut off while still waiting
 * for a slot says nothing about its size.
 */
async function judgeBatch(context, cards, priorAssessments) {
  const { llm, route, control, config, snapshot, signal, caller, stats, round } = context
  let ran = 0
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
      ran = performance.now() - started
      if (!caller?.aborted) AdaptiveRegistry.observe(control, { ms: ran, error })
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
      const halves = packBatches(cards, Math.ceil(cards.length / 2), snapshot.graph?.relations)
      const parts = await Promise.all(halves.map((half) => judgeBatch(context, half, priorAssessments)))
      return Object.assign({}, ...parts)
    }
    if (round.deadline.aborted && !caller?.aborted && cards.length > 1 && ran >= round.deadlineMs / 2) {
      round.tooBig = Math.max(round.tooBig, cards.length)
    }
    throw error
  }
}

/** Whether a failure is the round's own time limit running out. */
const lateFor = (round) => (error) => round.deadline.aborted && classifyError(error).kind === 'timeout'

/**
 * Judge every card, packed into the route's adaptive batch size and run through
 * its adaptive limiter in parallel. A failed batch leaves its cards `unknown`;
 * only when every batch fails does the round as a whole fail. When the time
 * limit runs out, the batches that answered in time keep their verdicts.
 */
async function judgeCards(context, cards, priorAssessments) {
  if (cards.length === 0) return {}
  const { control, stats, round, caller } = context
  const size = control.size.current
  const batches = packBatches(cards, size, context.snapshot.graph?.relations)
  stats.batches += batches.length
  const splits = stats.splits
  const settled = await Promise.allSettled(batches.map((batch) => judgeBatch(context, batch, priorAssessments)))
  // A turn that moved on keeps nothing; a time limit only loses the batches it cut off.
  caller?.throwIfAborted()
  if (round.tooBig > 0) control.size.shrink(round.tooBig)
  const late = lateFor(round)
  const assessments = {}
  const failures = []
  settled.forEach((item, index) => {
    if (item.status === 'fulfilled') Object.assign(assessments, item.value)
    else {
      failures.push(item.reason)
      const reason = late(item.reason) ? '这条没在时限内检查完' : `这条没检查完：${oneLine(errorMessage(item.reason), 160)}`
      for (const card of batches[index]) assessments[card.id] = { state: 'unknown', confidence: 0, reason }
    }
  })
  if (failures.length === batches.length) throw failures[0]
  if (failures.length > 0) {
    stats.partial.push(late(failures[0]) ? '有一部分规则没在时限内检查完' : `有一部分规则没检查完：${errorMessage(failures[0])}`)
  } else if (stats.splits === splits && cards.length >= size) {
    // Only a full batch answered whole shows the size works; a 3-card judgment says nothing about 24.
    control.size.grow()
  }
  return assessments
}

/** One round of batches under its own time limit. */
async function judgeRound(context, cards, priorAssessments) {
  const deadline = AbortSignal.timeout(context.deadlineMs)
  const round = { deadline, deadlineMs: context.deadlineMs, tooBig: 0 }
  const signal = context.caller ? AbortSignal.any([context.caller, deadline]) : deadline
  context.stats.rounds += 1
  try {
    return await judgeCards({ ...context, signal, round }, cards, priorAssessments)
  } finally {
    if (deadline.aborted) context.stats.expired = true
  }
}

/**
 * Run one decision for one agent and return the selected guidance. Never throws.
 * `tracker` is that agent's state (its `agent` and cooldowns).
 *
 * Each round's deadline adapts to the route's observed latency (the configured
 * timeout is only the hard ceiling), and covers queueing for a slot as well as
 * every batch. Usually one round judges every candidate; a new turn too big for
 * one wave judges the entry cards first and expands only the rules of skills
 * still in scope (see `planRounds`). When the judge is unavailable or fails, the
 * local critical presets still apply: they are facts about the action, not
 * guesses. A decision whose caller signal was aborted comes back `cancelled`
 * and is not recorded.
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
  const caller = snapshot.signal
  const stats = { calls: 0, batches: 0, splits: 0, rounds: 0, queueMs: 0, expired: false, partial: [] }
  const finish = (result) => {
    record.latencyMs = Math.round(performance.now() - started)
    record.judgedAt = new Date().toISOString()
    record.queueMs = stats.queueMs
    record.batches = stats.batches
    if (stats.rounds > 1) record.rounds = stats.rounds
    if (stats.splits) record.splits = stats.splits
    if (stats.expired && !caller?.aborted) record.deadlineExpired = true
    return { record, cards: [], guidance: '', assessments: {}, ...result }
  }
  const preset = criticalPreset(snapshot)
  if (caller?.aborted) return finish({ cancelled: true })
  const presetIds = Object.keys(preset).filter((id) => candidates.some((card) => card.id === id))
  const context = { llm, route, control, config, snapshot, caller, stats, deadlineMs }
  const plan = planRounds(candidates, graph.relations, {
    invoked: snapshot.invoked,
    wave: control.size.current * control.limiter.capacity,
  })
  // Rules left unexpanded because their skill was judged out of scope, by entry card.
  const unexpanded = new Map()
  let assessments
  try {
    if (!llm || !route) throw new Error('还没有可用的检查模型：请在“设置”里填写模型')
    assessments = await judgeRound(context, plan.first)
    const { open, skipped } = expandHeld(plan, assessments, config.minConfidence)
    for (const [id, entry] of skipped) unexpanded.set(id, entry)
    if (open.length > 0) {
      // The second round sees the entry verdicts that opened these rules.
      const entries = new Set(open.map((card) => plan.parent.get(card.id)))
      const prior = Object.fromEntries([...entries].map((id) => [id, assessments[id]]))
      try {
        Object.assign(assessments, await judgeRound(context, open, prior))
      } catch (error) {
        if (caller?.aborted) throw error
        // The first round stands; the rules it opened stay undecided.
        const late = classifyError(error).kind === 'timeout'
        const reason = late ? '这条没在时限内检查完' : `这条没检查完：${oneLine(errorMessage(error), 160)}`
        for (const card of open) assessments[card.id] = { state: 'unknown', confidence: 0, reason }
        stats.partial.push(late ? '有一部分规则没在时限内检查完' : `有一部分规则没检查完：${errorMessage(error)}`)
      }
    }
    if (stats.partial.length > 0) record.error = [...new Set(stats.partial)].join('；')
  } catch (error) {
    if (caller?.aborted) return finish({ cancelled: true })
    record.error = stats.expired ? `检查超时：模型 ${Math.round(deadlineMs / 1000)} 秒内没有回答，这次没有提醒` : `检查没完成：${errorMessage(error)}`
    record.errorKind = stats.expired ? 'timeout' : classifyError(error).kind
    if (presetIds.length === 0) return finish({})
    unexpanded.clear()
    assessments = Object.fromEntries(candidates.map((card) => [card.id, { state: 'unknown', confidence: 0, reason: '检查模型没回答；危险操作仍按默认先拦下' }]))
  }
  if (caller?.aborted) return finish({ cancelled: true })
  const cleared = applyPresets(assessments, preset, config.minConfidence)
  const judged = unexpanded.size > 0 ? candidates.filter((card) => !unexpanded.has(card.id)) : candidates
  const { selected, reasons } = selectAssessments(assessments, judged, graph.relations, config, {
    cooldowns: tracker.cooldowns ?? new Map(),
    step: snapshot.ledger?.step ?? 0,
    active: snapshot.activeSkills ?? new Set(),
  })
  for (const [id, entry] of unexpanded) reasons[id] = { kind: 'scope', by: entry }
  const guidance = selected.length > 0 ? renderGuidance(selected, { boundary: snapshot.boundary, triggers: snapshot.triggers }) : ''
  record.assessments = Object.fromEntries(Object.entries(assessments).map(([id, item]) => [id, { state: item.state, confidence: item.confidence, reason: item.reason }]))
  record.reasons = reasons
  record.preset = presetIds.filter((id) => !cleared.includes(id))
  if (cleared.length > 0) record.cleared = cleared
  record.selected = selected.map((card) => card.id)
  return finish({ cards: selected, guidance, assessments })
}
