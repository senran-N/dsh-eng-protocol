import { AdaptiveRegistry, LatencyTracker, classifyError, withRetry } from './adaptive.js'
import { enforceable, renderGuidance } from './cards.js'
import { decisionRoute } from './config.js'
import { callJson } from './model.js'
import { errorMessage, hash, messageId, oneLine } from './text.js'
import { hasUnmitigatedDestructiveCommand } from './events.js'
import { edgeApplies, edgeKey, graphContext, normalizeEdgeDecisions, orderByDependencies } from './topology.js'

const STATES = ['needed', 'addressing', 'satisfied', 'inapplicable', 'unknown']
// The judge must be at least this sure before it may clear a local critical preset.
const CLEARANCE_CONFIDENCE = 0.8

/** Judge instructions. */
export function decisionSystem() {
  return `You are the runtime judge for a coding agent's engineering protocol.
Your purpose is to help the agent complete the user's task correctly with fewer avoidable corrections. You are responsible for deciding applicability; do not outsource it to the user as a checklist.
You receive bounded session evidence, the action and its execution stage, candidate obligations, and their local dependency graph. Reconstruct the task, determine the current stage, check evidence, then propose the next useful action.

States:
- needed: concrete evidence shows the obligation is not met and the next action would violate or omit it. A reminder can still change the outcome.
- addressing: the agent is already handling it; a reminder would be noise.
- satisfied: the evidence shows the obligation is already met.
- inapplicable: the card does not apply to this task or action.
- unknown: the evidence is insufficient to decide.

Return JSON only:
{"task":{"goal":"current user goal","constraints":["active constraint"],"phase":"current stage","remaining":["unfinished requirement"],"sourceRefs":["request:1"]},"cards":[{"id":"...","state":"needed|addressing|satisfied|inapplicable|unknown","confidence":0.0,"reason":"specific evidence and applicability, not a restatement of the rule","nextAction":"one concrete in-scope action, only for needed","evidence":[{"ref":"event:1","quote":"exact relevant words from that evidence"}]}],"relations":[{"id":"type:source:target","state":"applies|inapplicable|unknown","confidence":0.0,"reason":"why this relation applies now","action":"shared action for fuses only","evidence":[{"ref":"event:1","quote":"exact relevant words"}]}]}
Write cards first so completed assessments survive a cut response. Keep each reason to one short sentence and each quote to the shortest decisive excerpt. Include one compact task interpretation per response, not a separate task summary per card. Omit nextAction for states other than needed. Do not copy whole source paragraphs or reprint the input graph.

STAGE CONTRACT:
- request: use the newest tool evidence to choose the next useful step. Identify outstanding prerequisites; do not demand future-stage deliverables before work begins.
- tool with no outcome: the action is PROPOSED. Check what it would skip or violate now; inspect actual arguments, paths, authorization and applicable exceptions. Do not demand another check that is already complete or underway.
- tool with outcome: the action ALREADY RAN. The new outcome supersedes assumptions made before execution. Withdraw reminders whose duty this result completed. Never ask to do a prerequisite retroactively or pretend this result is a failed command because a rule was missed; identify only a concrete remaining repair, diagnostic or validation step. A background handoff is still running, not completion.
- settle: the agent is stopping. Review required deliverables and outstanding dependencies against the latest edit/check revision and user scope. Known unmet work warrants a concrete continuation; missing history stays unknown.

GRAPH CONTRACT:
- contains scopes duties to a loaded skill; it never means a prerequisite has been completed.
- requires points prerequisite -> dependent: assess both independently, then the runtime schedules the unmet prerequisite first. blocks is conditional: satisfied OR genuinely inapplicable releases its dependent. An unknown endpoint is missing evidence, not a proven violation.
- covers means full discharge of the SAME obligation in this scope; only confidently needed and actually actionable covering advice may replace a duplicate. Do not claim completion by following an edge.
- arbitrates points an exception/precedence rule -> the rule it qualifies. Decide whether the stated condition applies from source wording AND current evidence. Never suppress a critical guard, invent precedence, or treat a skill as authority over the user. If contradictory duties cannot be resolved, use unknown for the relation and identify the missing fact.
- fuses means one action fulfills both independent duties. Report applies only with a concrete shared action and evidence that BOTH apply now. Preserve both completion obligations. Sequential prerequisites are not a fusion.
- Return relation assessments for arbitrates/fuses when both endpoint definitions are visible, including RELATED RULES across a split. Do not emit extra card assessments for these neighbors. Missing or conflicting relation answers leave edges advisory.
- PREVIOUS DELIVERIES are records of advice, not proof of compliance. Compare subsequent actions and results. A duplicate prompt, unchanged proposal, or lack of acknowledgment alone does not establish a new omission. Do not turn an earlier judge opinion into factual evidence.

Rules:
- taskRequests preserves the user's instructions in order. Later instructions amend or replace earlier ones; a short continuation such as "continue" retains the earlier task and constraints. Judge the current task, not a superseded task.
- evidenceCoverage reports omitted history. Retained text is complete, but an omitted event is not evidence that an obligation was never addressed. Use unknown when deciding would require missing history.
- Use concrete evidence from the transcript, not the card title alone.
- First reconstruct the current task: active goal, user constraints, stage and remaining requirements. Report these in task, including sourceRefs from EVIDENCE REFERENCES. This is your interpretation, not verified fact. Do not replace a deliverable with an intermediate action.
- Read timeline in order. Distinguish an initial failed experiment from the edits and applicable validation that followed it. Tool execution success alone does not prove semantic correctness or task completion. A plan or progress claim alone does not prove a duty was carried out.
- A tool result with status blocked / executed false and source eng-protocol is a protocol intervention BEFORE dispatch, not a shell failure, lost output, or broken tool. No command ran. Independent eng-protocol advisory contexts are reminders, not tool results. Neither justifies echo probes, tool switching, or a failed/stuck diagnosis by itself.
- For needed, addressing or satisfied, cite the relevant evidence reference(s) and copy a short exact quote from each. References must exist in EVIDENCE REFERENCES; do not invent citations. Quotes are checked against that source. Use unknown if decisive evidence is missing. Proposed action evidence describes intent, not a completed operation.
- Prefer unknown over needed when the evidence is weak or merely suspicious.
- Do not mark needed just because a risk exists in general; the next action must be able to violate the obligation now.
- Do not invent files, commands, user statements, or test results.
- Assess every candidate independently, including all applicable entry cards. Delivery follows dependencies and merges validated shared actions; never hide a needed assessment to keep the reminder short. Do not repeat generic checklists or ask the agent to prove every rule applies.
- Read rules, notApplicable, source pointers and relations as evidence about obligations. A grounded quote verifies the source text, not that its condition holds now. Treat compiler interpretations as fallible.
- A skill card's quote is the skill's own wording, verified against its text (grounded: true). Judge against the quote first; a card with grounded: false is the compiler's paraphrase and deserves less weight. checkpoint: true marks something the skill requires BEFORE the action: needed when the action about to run would skip it.
- Entry cards (entry: true) decide whether a skill's scope covers the current task. Compare meaning across languages and terminology; lexical overlap is not required. With loaded: true the skill's instructions are already in the conversation: inapplicable when the current task is outside that skill's scope, otherwise addressing. With loaded: false: needed when the current task, action, or failure clearly falls inside its description or guidance and loading it can guide the remaining work. Do not require an actual violation or repeated failures before recommending an applicable skill. Knowing the topic or claiming to follow best practices is not evidence that a skill was loaded. addressing requires a concrete load already in progress. Do not mark needed merely because a skill is loosely related, and never recommend model-loading a user-invocation-only skill.
- On failed/stuck/heartbeat boundaries, actively reconsider skills and obligations the main model may have missed. A fresh failure can invalidate an earlier addressing or satisfied verdict: inspect the failure and the agent's actual response. An ordinary expected test failure or useful investigation is not by itself a violation. A skill loaded for the task remains in scope across unrelated intermediate actions.
- addressing requires observable work that directly carries out THIS obligation, not general activity, a plan, a progress claim, or merely mentioning what remains. Assess the agent's behavior against the rule, not its self-description.
- At boundary=settle the main agent is STOPPING NOW; it is not mid-analysis. For skill obligations use satisfied only with concrete completion evidence, needed when a required part is still missing, inapplicable for an obligation outside the current task, or unknown when you cannot tell. Do not use addressing to excuse an unfinished required report, unrun validation, or an unresolved prerequisite at delivery. Disclosing that a required part is missing does not complete it unless the user waived it or an actual external blocker prevents it.
- Confidence measures certainty of your assessment, not certainty that the main agent will comply. A confirmed unloaded skill whose description clearly matches the current task warrants a confident needed assessment; a lack of future tool output does not make that scope match uncertain.
- If the user explicitly authorized this exact operation, halt is satisfied; say so in the reason.
- If a failed check is followed by an edit that weakens, skips, mocks away, hardcodes, or suppresses the failing assertion, test, or type/lint error, anti_reward_hacking is needed even when the agent calls it a fix.
- If the agent has established a different root cause and the proposed edit still applies the earlier guessed change (for example loosening a threshold or timeout), refuted_premise is needed.
- At delivery, if the latest relevant change lacks a completed applicable check, verify is needed. During implementation, an applicable check currently running is addressing; an intermediate edit is not by itself a reason to demand the final test suite. A check before the last change does not cover it: compare check editRevision with current editRevision.
- A running, cancelled, or unknown check is NOT a passed check. Background job launch is not completion. Compare check cwd/scope against the edited files and action cwd: passing tests in another directory cannot verify this project's edits without explicit evidence of coverage.
- Source pointers marked precise:false are an unverified input range, not proof that a specific obligation appears at that exact line. Coverage counts describe extraction and retention, never semantic completeness.

CALIBRATION EXAMPLES (illustrations, not additional obligations):
- Rule: back up production before applying a migration. Action: edit a migration file locally. The production backup gate is inapplicable to this edit; the matching topic alone does not make it needed.
- Rule: run a relevant check before delivery. Evidence: that check started and is still running. During implementation it is addressing, not needed or satisfied; at settle, wait for the result before claiming completion.
- An assertion failed, then the agent edits its test to add coverage for the bug. This alone does not establish test weakening. Read the actual change before judging anti_reward_hacking.
- Two rules require validating behavior and attaching the validation report. A command known to perform both can be a shared action. Two unrelated commands cannot be fused merely because both are validation.
- A source says publishing is optional when the user requests a local draft, and the user requested a local draft. A grounded arbitrates edge may apply. A reminder saying "publish" does not negate the user's scope.`
}

export function evidencePayload(snapshot) {
  const ledger = snapshot.ledger ?? {}
  return {
    boundary: snapshot.boundary,
    stage: snapshot.outcome ? 'after-action' : snapshot.action ? 'before-action' : snapshot.boundary,
    outcome: snapshot.outcome,
    previousDeliveries: snapshot.previousDeliveries ?? [],
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
          command: snapshot.action.command,
          excerpt: snapshot.action.excerpt,
        }
      : undefined,
    turn: ledger.turn,
    step: ledger.step,
    loadedSkills: [...(snapshot.activeSkills ?? [])],
    user: ledger.user ?? '',
    taskRequests: ledger.taskRequests ?? [ledger.user ?? ''],
    evidenceCoverage: ledger.evidenceCoverage,
    lastAssistant: ledger.assistant ?? '',
    filesRead: ledger.filesRead ?? [],
    filesEdited: ledger.filesEdited ?? [],
    checks: ledger.checks ?? [],
    failures: ledger.failures ?? [],
    failureStreak: ledger.failureStreak ?? 0,
    stopping: snapshot.boundary === 'settle',
    editRevision: ledger.editRevision,
    recentTools: ledger.recent ?? [],
    timeline: ledger.timeline ?? [],
  }
}

/** Stable references to the exact evidence the judge received. */
export function evidenceReferences(evidence) {
  const refs = new Map()
  const add = (ref, value, meta = {}) => {
    if (value == null) return
    refs.set(ref, { ref, text: typeof value === 'string' ? value : JSON.stringify(value), ...meta })
  }
  ;(evidence.taskRequests ?? []).forEach((text, index) => add(`request:${index + 1}`, text, { kind: 'user' }))
  add('assistant:latest', evidence.lastAssistant, { kind: 'assistant' })
  if (evidence.action) add(evidence.outcome ? 'action:executed' : 'action:proposed', evidence.action.excerpt ?? evidence.action.command ?? evidence.action,
    { kind: evidence.outcome ? 'executed' : 'proposed', callId: evidence.action.callId })
  if (evidence.outcome) add('outcome:current', evidence.outcome.output || evidence.outcome, { kind: 'result', callId: evidence.outcome.callId })
  for (const item of evidence.timeline ?? []) add(item.ref, item.text ?? item, { kind: item.kind, callId: item.callId, seq: item.seq })
  for (const [group, items] of [['tool', evidence.recentTools], ['check', evidence.checks], ['failure', evidence.failures]]) {
    ;(items ?? []).forEach((item, index) => add(`${group}:${item.callId ?? index + 1}`,
      item.output ?? item.summary ?? item.excerpt ?? item.command ?? item, { kind: group, callId: item.callId }))
  }
  return refs
}

function relationsFor(graph, candidates) {
  return graphContext(graph, candidates).edges
}

export function decisionPrompt(snapshot, candidates) {
  const evidence = evidencePayload(snapshot)
  const loaded = snapshot.activeSkills ?? new Set()
  const describe = (card) => ({
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
    sourceRef: card.sourceRef,
  })
  const cards = candidates.map(describe)
  const critical = candidates.filter((card) => card.critical === true).map((card) => card.id)
  const relations = relationsFor(snapshot.graph, candidates)
  return `CURRENT EVIDENCE:
${JSON.stringify(evidence, null, 2)}

CANDIDATE CARDS:
${JSON.stringify(cards, null, 2)}

Critical cards that must have an answer: ${critical.length > 0 ? critical.join(', ') : '(none)'}

EVIDENCE REFERENCES (use only these ids; their text is in CURRENT EVIDENCE):
${JSON.stringify([...evidenceReferences(evidence).keys()])}

RELATIONS (missing endpoints are not proof of completion):
${JSON.stringify(relations.map(edge => ({ ...edge, id: edgeKey(edge) })))}

RELATED RULES (context only; do not emit extra card assessments):
${JSON.stringify(graphContext(snapshot.graph, candidates).neighbors.map(describe))}

ASSESSMENTS ALREADY MADE AT THIS SAME BOUNDARY:
${JSON.stringify(snapshot.priorAssessments ?? {})}

${snapshot.review ? `REVIEW OF A POSSIBLY MISSED SKILL REMINDER:
${snapshot.review}
Reassess from the evidence. Keep the earlier verdict if warranted; do not inflate confidence to pass a threshold. For scope, assess whether loading the confirmed-unloaded skill can guide this task. At delivery the agent is stopping, so ongoing work cannot satisfy an unfinished duty. Explain the concrete evidence that supports your final state.` : ''}

Return exactly one entry for every candidate id above. Do not omit candidates. Return the JSON object.`
}

/** Normalize model output into one assessment per candidate. */
export function normalizeAssessments(raw, candidates, references) {
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
    let valid = STATES.includes(value.state) && typeof value.confidence === 'number'
      && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1
    const cited = Array.isArray(value.evidence) ? value.evidence : []
    const badCitation = references && ((value.evidence !== undefined && !Array.isArray(value.evidence))
      || cited.some((item) => !item || typeof item.ref !== 'string' || !references.has(item.ref)
        || typeof item.quote !== 'string' || !item.quote.trim() || !references.get(item.ref).text.includes(item.quote)))
    if (badCitation) valid = false
    assessments[id] = {
      state: valid ? value.state : 'unknown',
      confidence: valid ? value.confidence : 0,
      reason: badCitation ? '模型引用的证据不存在或引文不匹配，保留为未知'
        : !valid ? '模型返回的状态或置信度无效，无法判断'
        : typeof value.reason === 'string' ? oneLine(value.reason, 400) : undefined,
      ...(valid && value.state === 'needed' && typeof value.nextAction === 'string' && value.nextAction.trim()
        ? { nextAction: oneLine(value.nextAction, 500) } : {}),
      ...(valid && cited.length > 0 ? { evidence: cited.map(({ ref, quote }) => ({ ref, ...(quote ? { quote } : {}) })) } : {}),
      ...(!valid ? { invalid: true } : {}),
    }
  }
  for (const card of candidates) {
    if (!assessments[card.id]) assessments[card.id] = { state: 'unknown', confidence: 0, reason: '模型没有返回该卡片的判断', invalid: true }
  }
  return assessments
}

/**
 * Select confidently needed obligations. Unknown and addressing stay in the
 * audit; missing evidence must not turn into a checklist. Ordinary skill and
 * builtin reminders share cooldowns at every boundary. Delivery applies a
 * separate per-step budget and evidence deduplication, including cached results.
 */
export function selectAssessments(assessments, candidates, relations, config, tracker) {
  const reasons = {}
  const blocked = new Set()
  const now = tracker.step ?? 0
  const loaded = tracker.active ?? new Set()
  const byId = new Map(candidates.map(card => [card.id, card]))
  const outOfScope = new Set(candidates.filter((card) => card.entry
    && assessments[card.id]?.state === 'inapplicable'
    && assessments[card.id].confidence >= config.minConfidence).map((card) => card.skill))
  for (const edge of relations) {
    if (edge.type === 'requires' || edge.type === 'blocks') {
      const source = assessments[edge.source]
      const target = assessments[edge.target]
      if (!byId.get(edge.target)?.critical && target?.state === 'needed'
        && source?.confidence >= config.minConfidence && ['needed', 'addressing'].includes(source.state)) {
        blocked.add(edge.target)
        reasons[edge.target] = { kind: 'prerequisite', by: edge.source }
      }
    }
    if (edge.type === 'arbitrates' && edge.grounded === true && !byId.get(edge.target)?.critical
      && !outOfScope.has(byId.get(edge.source)?.skill)
      && edgeApplies(edge, tracker.edgeDecisions, Math.max(0.8, config.minConfidence))
      && assessments[edge.source]?.state === 'satisfied' && assessments[edge.source].confidence >= config.minConfidence) {
      blocked.add(edge.target)
      reasons[edge.target] = { kind: 'arbitrated', by: edge.source }
    }
  }
  const eligible = candidates.filter((card) => {
    const assessment = assessments[card.id]
    if (assessment?.state !== 'needed') reasons[card.id] ??= { kind: 'state' }
    else if (assessment.confidence < config.minConfidence) reasons[card.id] = { kind: 'confidence' }
    else if (card.entry && loaded.has(card.skill)) reasons[card.id] = { kind: 'loaded' }
    else if (!card.entry && card.skill && outOfScope.has(card.skill)) reasons[card.id] = { kind: 'scope' }
    else if (blocked.has(card.id)) return false
    else if (!card.critical && !enforceable(card, config.enforcement)
      && config.cooldownSteps > 0 && tracker.cooldowns.has(card.id)
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
  for (const card of orderByDependencies(ranked, relations)) {
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
  if (snapshot.outcome) return {}
  const preset = {}
  const action = snapshot.action
  if (action?.kind === 'command' && action.isDestructive === true && hasUnmitigatedDestructiveCommand(action.command ?? '')) {
    preset.halt = { state: 'needed', confidence: 1, reason: 'The command is destructive or outward-facing; verify authorization and rollback before running it.' }
  }
  // Editing a test after a failure is not itself test weakening. The judge must
  // compare the actual edit with the contract instead of a blanket local block.
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
const JUDGE_RETRY = new Set(['network', 'server', 'rate-limit', 'overloaded', 'timeout', 'bad-output', 'output-limit'])

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
export function planRounds(candidates, relations = [], { invoked = '', active = new Set(), wave = Infinity } = {}) {
  const entries = new Set(candidates.filter((card) => card.entry && card.skill !== invoked && !active.has(card.skill)).map((card) => card.id))
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
 * Judge one batch. A cut response keeps complete assessments and retries only
 * unfinished cards. Split batches retain the route's full output allowance;
 * a singleton may increase that allowance once, bounded by the route ceiling.
 * Total-budget expiry says nothing about provider congestion or card capacity.
 * Only actual output truncation trains a smaller batch.
 */
async function judgeBatch(context, cards, priorAssessments) {
  const { llm, route, control, config, snapshot, signal, caller, stats, round } = context
  let partialError
  const call = async (number) => {
    const queuedAt = performance.now()
    const attempt = { phase: context.phase, cards: cards.map((card) => card.id), status: 'queued' }
    stats.attempts.push(attempt)
    try {
      return await control.limiter.run(async (waited) => {
        stats.queueMs = Math.max(stats.queueMs, Math.round(waited))
        attempt.queueMs = Math.round(waited)
        attempt.status = 'running'
        const started = performance.now()
        const epoch = control.limiter.epoch
        const remaining = context.expiresAt - started
        if (remaining <= 0) throw new DOMException('判断总时限已用完，未再启动模型请求', 'TimeoutError')
        // A stalled first request must leave time for recovery inside the SAME
        // total deadline. Tiny or late phases use the remaining time directly.
        const typical = context.expectedMs
        const reserve = number === 1 && remaining >= 4000 && typical !== undefined
          && typical * 1.25 + 300 < remaining * 0.35
        const timeoutMs = Math.floor(remaining)
        const stallTimeoutMs = reserve ? Math.floor(remaining * 0.65) : undefined
        attempt.timeoutMs = timeoutMs
        if (stallTimeoutMs) attempt.stallTimeoutMs = stallTimeoutMs
        try {
          const system = decisionSystem()
          const prompt = decisionPrompt({ ...snapshot, priorAssessments }, cards)
          attempt.inputChars = system.length + prompt.length
          // Task interpretation, citations and neighbors still need space in
          // a one-card batch. Reducing output with batch size causes a loop of
          // truncation -> splitting -> even smaller output -> truncation.
          attempt.maxTokens = control.output.current
          stats.calls += 1
          const raw = await callJson(llm, route, {
            system,
            prompt,
            maxTokens: attempt.maxTokens,
            temperature: config.decision.temperature,
            reasoningEffort: config.decision.reasoningEffort,
            timeoutMs,
            firstChunkTimeoutMs: stallTimeoutMs,
            idleTimeoutMs: stallTimeoutMs,
            signal,
            onFit: (fit) => { control.effort = fit },
          })
          const normalized = normalizeAssessments(raw, cards, context.references)
          const edgeDecisions = normalizeEdgeDecisions(raw?.relations, relationsFor(snapshot.graph, cards), context.references)
          attempt.edgeDecisions = edgeDecisions
          for (const [id, decision] of Object.entries(edgeDecisions)) {
            const previous = stats.edgeDecisions[id]
            // Independent split judgments must agree before an edge changes delivery.
            if (previous && (previous.state !== decision.state || previous.action !== decision.action)) {
              stats.edgeDecisions[id] = { ...decision, state: 'unknown', confidence: 0, reason: '跨批关系判断不一致，保留独立规则' }
            } else stats.edgeDecisions[id] = previous
              ? { ...decision, confidence: Math.min(previous.confidence, decision.confidence) } : decision
          }
          const invalid = Object.values(normalized).filter((item) => item.invalid).length
          AdaptiveRegistry.observe(control, { ms: performance.now() - started, epoch,
            ...(invalid > 0 ? { error: Object.assign(new Error('判断缺失或格式无效'), { kind: 'bad-output' }) } : {}) })
          attempt.status = invalid > 0 ? 'invalid' : 'answered'
          if (!invalid && cards.length >= control.size.current) control.size.grow()
          attempt.assessments = Object.fromEntries(Object.entries(normalized).map(([id, item]) => [id,
            { state: item.state, confidence: item.confidence, reason: item.reason }]))
          if (raw?.task && typeof raw.task.goal === 'string' && raw.task.goal.trim()) {
            const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
            const sourceRefs = strings(raw.task.sourceRefs)
            attempt.understanding = { goal: raw.task.goal, constraints: strings(raw.task.constraints),
              phase: typeof raw.task.phase === 'string' ? raw.task.phase : undefined,
              remaining: strings(raw.task.remaining), sourceRefs: sourceRefs.filter((ref) => context.references.has(ref)),
              invalidRefs: sourceRefs.filter((ref) => !context.references.has(ref)) }
          }
          return normalized
        } catch (error) {
          // A late phase may get only milliseconds. Do not train provider
          // congestion from our own shared budget expiring.
          const budgetCut = signal.aborted || (!reserve && classifyError(error).kind === 'timeout' && performance.now() >= context.expiresAt - 10)
          // A locally chosen early retry deadline is not a provider overload.
          if (!budgetCut && !(reserve && classifyError(error).kind === 'timeout')) AdaptiveRegistry.observe(control, { ms: performance.now() - started, error, epoch })
          if (error && typeof error === 'object') {
            error.maxTokens = attempt.maxTokens
            error.attempt = attempt
            if (error.partial) partialError = error
          }
          throw error
        } finally {
          attempt.runMs = Math.round(performance.now() - started)
        }
      }, signal, context.phase === 'repair' ? 10 : 0)
    } catch (error) {
      if (attempt.status === 'queued') {
        attempt.queueMs = Math.round(performance.now() - queuedAt)
        stats.queueMs = Math.max(stats.queueMs, attempt.queueMs)
        attempt.runMs = 0
      }
      attempt.errorKind = classifyError(error).kind
      if (attempt.errorKind === 'timeout') attempt.timeoutStage = attempt.status === 'queued' ? 'queue' : 'model'
      if (round.deadline.aborted && !caller?.aborted) {
        attempt.timeoutStage = attempt.status === 'queued' ? 'queue' : 'model'
        attempt.errorKind = 'timeout'
      }
      attempt.status = caller?.aborted ? 'cancelled' : 'failed'
      throw error
    }
  }
  try {
    const assessments = await withRetry(call, { signal, attempts: 2, baseMs: 250, maxDelayMs: 1500,
      retryable: (info) => !partialError && JUDGE_RETRY.has(info.kind) })
    const invalid = cards.filter((card) => assessments[card.id]?.invalid)
    if (invalid.length > 0 && context.repair !== false && !signal.aborted) {
      // A missing answer or mismatched citation is not an output-capacity error.
      stats.repairs += 1
      // Keep every good answer. Recheck only broken entries, once, against the
      // original evidence; neither a failed repair nor a forged quote can pass.
      try {
        Object.assign(assessments, await judgeBatch({ ...context, repair: false, phase: 'repair', snapshot: { ...snapshot,
          review: 'Repair only these missing or invalid assessments. Cite existing EVIDENCE REFERENCES with exact verbatim quotes. Use unknown when evidence is insufficient.',
        } }, invalid, assessments))
      } catch (error) {
        if (caller?.aborted) throw error
      }
    }
    const missing = Object.values(assessments).filter((item) => item.invalid).length
    if (missing > 0) stats.partial.push(`模型有 ${missing} 条判断缺失或格式无效，保留为未知`)
    return assessments
  } catch (error) {
    const info = error?.classified ?? classifyError(error)
    if (info.kind === 'truncated' || info.kind === 'timeout' && error.partial) {
      const recovered = normalizeAssessments(error.partial, cards, context.references)
      const complete = cards.filter(card => !recovered[card.id].invalid)
      const remaining = cards.filter(card => recovered[card.id].invalid)
      const parts = [Object.fromEntries(complete.map(card => [card.id, recovered[card.id]]))]
      stats.recoveredAssessments += complete.length
      if (complete.length > 0 && error.attempt) {
        error.attempt.status = 'partial'
        error.attempt.recovered = complete.map(card => card.id)
      }
      if (remaining.length === 0) return parts[0]
      if (signal.aborted || info.kind === 'timeout') {
        if (complete.length === 0) throw error
        stats.partial.push('有一部分规则没在时限内检查完')
        return { ...parts[0], ...Object.fromEntries(remaining.map(card => [card.id,
          { state: 'unknown', confidence: 0, reason: '这条没在时限内检查完' }])) }
      }
      const failures = []
      let halves
      if (cards.length === 1 && !context.outputExpanded && !signal.aborted && error.maxTokens < control.output.max) {
        control.output.value = Math.min(control.output.max, Math.max(control.output.current, error.maxTokens * 2))
        stats.outputExpansions += 1
        halves = [remaining]
      } else if (cards.length > 1) {
        // Learned capacity is how many complete answers actually fit; never
        // discard already-answered cards just to retry two arbitrary halves.
        const size = complete.length > 0 ? Math.max(1, complete.length) : Math.ceil(cards.length / 2)
        control.size.shrink(Math.max(2, size * 2))
        stats.splits += 1
        halves = packBatches(remaining, size, snapshot.graph?.relations)
      } else throw error
      // Keep a split inside its original worker too; recursively spawning both
      // halves would defeat the bounded queue under repeated truncation.
      for (const half of halves) {
        try { parts.push(await judgeBatch({ ...context, outputExpanded: context.outputExpanded || cards.length === 1 }, half, priorAssessments)) }
        catch (failure) {
          if (caller?.aborted) throw failure
          failures.push(failure)
          const reason = lateFor(round)(failure) ? '这条没在时限内检查完' : `这条没检查完：${oneLine(errorMessage(failure), 160)}`
          parts.push(Object.fromEntries(half.map((card) => [card.id, { state: 'unknown', confidence: 0, reason }])))
        }
      }
      if (failures.length === halves.length && complete.length === 0) throw failures[0]
      if (failures.length > 0) stats.partial.push(lateFor(round)(failures[0]) ? '有一部分规则没在时限内检查完' : `有一部分规则没检查完：${errorMessage(failures[0])}`)
      return Object.assign({}, ...parts)
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
  const active = context.snapshot.activeSkills ?? new Set()
  const priority = (card) => card.critical ? 4 : !card.skill ? 3 : active.has(card.skill) ? (card.entry ? 1 : 2) : 0
  const ordered = [...cards].sort((left, right) => priority(right) - priority(left))
  const batches = packBatches(ordered, size, context.snapshot.graph?.relations)
  stats.batches += batches.length
  // Bound queued work independently of catalog size. Workers take another
  // batch only after settling their own repair, so repairs do not join the
  // tail of hundreds of eagerly enqueued requests.
  const settled = new Array(batches.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(batches.length, control.limiter.max) }, async () => {
    while (cursor < batches.length && !context.signal.aborted) {
      const index = cursor++
      try { settled[index] = { status: 'fulfilled', value: await judgeBatch(context, batches[index], priorAssessments) } }
      catch (reason) { settled[index] = { status: 'rejected', reason } }
    }
  }))
  for (; cursor < batches.length; cursor += 1) {
    settled[cursor] = { status: 'rejected', reason: context.signal.reason }
    stats.attempts.push({ phase: context.phase, cards: batches[cursor].map((card) => card.id),
      status: 'not-started', errorKind: caller?.aborted ? 'aborted' : 'timeout', timeoutStage: 'budget', queueMs: 0, runMs: 0 })
  }
  // A turn that moved on keeps nothing; a time limit only loses the batches it cut off.
  caller?.throwIfAborted()
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
  }
  return assessments
}

/** All phases share the same deadline; expansion/review never restart the clock. */
async function judgeRound(context, cards, priorAssessments) {
  const deadline = context.deadline
  const round = { deadline, deadlineMs: context.deadlineMs }
  const signal = context.signal
  context.stats.rounds += 1
  try {
    if (signal.aborted) {
      context.stats.attempts.push({ phase: context.phase, cards: cards.map((card) => card.id), status: 'not-started',
        errorKind: context.caller?.aborted ? 'aborted' : 'timeout', timeoutStage: 'budget', queueMs: 0, runMs: 0 })
      signal.throwIfAborted()
    }
    return await judgeCards({ ...context, signal, round }, cards, priorAssessments)
  } finally {
    if (deadline.aborted) context.stats.expired = true
  }
}

/**
 * Run one decision for one agent and return the selected guidance. Never throws.
 * `tracker` is that agent's state (its `agent` and cooldowns).
 *
 * One shared deadline adapts to completed judgments of comparable input size
 * and parallel waves, covering queueing, every batch, expansion and review.
 * Usually one round judges every candidate; a new turn too big for
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
  // Only completed judgments of comparable input size and parallel waves may
  // shorten this judgment. Fast one-card calls cannot train a huge task's deadline.
  const input = evidencePayload(snapshot)
  const references = evidenceReferences(input)
  const inputChars = decisionPrompt(snapshot, candidates).length
  const waves = Math.ceil(Math.ceil(candidates.length / control.size.current) / control.limiter.capacity)
  const workload = `${Math.ceil(Math.log2(Math.max(1, inputChars)))}:${Math.max(1, waves)}`
  control.judgmentLatency ??= new Map()
  if (!control.judgmentLatency.has(workload)) control.judgmentLatency.set(workload, new LatencyTracker())
  const latency = control.judgmentLatency.get(workload)
  const deadlineMs = latency.timeout(config.decision.timeoutMs, { floor: 2500 })
  const deadline = AbortSignal.timeout(deadlineMs)
  const expiresAt = performance.now() + deadlineMs
  const record = {
    kind: 'decision',
    judgeRevision: '2026-10-21-output-recovery',
    minConfidence: config.minConfidence,
    decisionId: messageId(),
    evidenceSeq: snapshot.ledger?.evidenceSeq,
    responseSeq: snapshot.ledger?.responseSeq,
    judgedAt: new Date().toISOString(),
    queueMs: 0,
    sessionId: agent?.session?.id ?? agent?.id,
    cwd: snapshot.cwd,
    boundary: snapshot.boundary,
    stage: input.stage,
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
    inputChars,
    evidenceCoverage: input.evidenceCoverage,
    evidence: [...references.values()].map(({ text, ...item }) => ({ ...item, chars: text.length, hash: hash(text), preview: oneLine(text, 240) })),
  }
  const caller = snapshot.signal
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline
  const stats = { calls: 0, batches: 0, splits: 0, repairs: 0, recoveredAssessments: 0, outputExpansions: 0, rounds: 0, queueMs: 0, expired: false, partial: [], attempts: [], edgeDecisions: {} }
  const finish = (result) => {
    record.latencyMs = Math.round(performance.now() - started)
    record.judgedAt = new Date().toISOString()
    record.queueMs = stats.queueMs
    record.batches = stats.batches
    record.modelCalls = stats.calls
    record.attempts = stats.attempts
    record.requestChars = stats.attempts.reduce((total, attempt) => total + (attempt.inputChars ?? 0), 0)
    record.maxRequestChars = stats.attempts.reduce((max, attempt) => Math.max(max, attempt.inputChars ?? 0), 0)
    const answers = Object.values(record.assessments)
    record.citationCoverage = { cited: answers.filter((item) => item.evidence?.length).length,
      uncited: answers.filter((item) => !item.evidence?.length && item.confidence > 0).length }
    record.timeoutStages = [...new Set(stats.attempts.map((attempt) => attempt.timeoutStage).filter(Boolean))]
    if (stats.rounds > 1) record.rounds = stats.rounds
    if (stats.splits) record.splits = stats.splits
    if (stats.repairs) record.repairs = stats.repairs
    if (stats.recoveredAssessments) record.recoveredAssessments = stats.recoveredAssessments
    if (stats.outputExpansions) record.outputExpansions = stats.outputExpansions
    if (stats.expired && !caller?.aborted) record.deadlineExpired = true
    if (!caller?.aborted && (!record.error || stats.expired)) latency.record(record.latencyMs)
    return { record, evidenceSnapshot: { input, cards: candidates, relatedCards: graphContext(graph, candidates).neighbors,
      relations: relationsFor(graph, candidates), references: [...references.values()] }, cards: [], guidance: '', assessments: {}, ...result }
  }
  const preset = criticalPreset(snapshot)
  if (caller?.aborted) return finish({ cancelled: true })
  const presetIds = Object.keys(preset).filter((id) => candidates.some((card) => card.id === id))
  const expectedMs = latency.samples.length >= 4 ? latency.quantile(0.5) : undefined
  const context = { llm, route, control, config, snapshot, caller, signal, stats, deadlineMs, deadline, expiresAt, expectedMs, references, phase: 'initial' }
  const plan = planRounds(candidates, graph.relations, {
    invoked: snapshot.invoked,
    // A new task rechecks scope first. During an existing task loaded duties
    // must not wait behind a full scan of unrelated catalog entries.
    active: snapshot.triggers.includes('turn') ? undefined : snapshot.activeSkills,
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
        Object.assign(assessments, await judgeRound({ ...context, phase: 'expanded' }, open, prior))
      } catch (error) {
        if (caller?.aborted) throw error
        // The first round stands; the rules it opened stay undecided.
        const late = classifyError(error).kind === 'timeout'
        const reason = late ? '这条没在时限内检查完' : `这条没检查完：${oneLine(errorMessage(error), 160)}`
        for (const card of open) assessments[card.id] = { state: 'unknown', confidence: 0, reason }
        stats.partial.push(late ? '有一部分规则没在时限内检查完' : `有一部分规则没检查完：${errorMessage(error)}`)
      }
    }
    // Real sessions showed two silent misses: clearly applicable entries given
    // borderline confidence, and unfinished duties excused as "mid-analysis"
    // at the stopping boundary. Ask once more with that contradiction explicit;
    // never turn uncertainty into a violation or lower the operator's threshold.
    const review = candidates.filter((card) => card.skill && !unexpanded.has(card.id) && (
      (card.entry && assessments[card.id]?.state === 'needed'
        && assessments[card.id].confidence >= 0.5 && assessments[card.id].confidence < config.minConfidence)
      || (!card.entry && snapshot.boundary === 'settle' && assessments[card.id]?.state === 'addressing')
    ))
    if (review.length > 0) {
      record.reviewed = review.map((card) => card.id)
      const prior = Object.fromEntries(review.map((card) => [card.id, assessments[card.id]]))
      try {
        const reviewed = await judgeRound({ ...context, phase: 'review', snapshot: { ...snapshot,
          review: 'Resolve a borderline skill-scope recommendation or an unfinished obligation marked addressing while the agent is stopping.',
        } }, review, prior)
        for (const card of review) {
          // A failed or missing review answer must not erase the first answer.
          if (reviewed[card.id]?.confidence > 0) assessments[card.id] = reviewed[card.id]
        }
      } catch (error) {
        if (caller?.aborted) throw error
        stats.partial.push(`skill 复核没完成：${oneLine(errorMessage(error), 160)}`)
      }
    }
    if (stats.partial.length > 0) record.error = [...new Set(stats.partial)].join('；')
  } catch (error) {
    if (caller?.aborted) return finish({ cancelled: true })
    record.error = stats.expired ? `检查超时：${Math.round(deadlineMs / 1000)} 秒总时限已用尽，未完成的规则保留为未知` : `检查没完成：${errorMessage(error)}`
    record.errorKind = stats.expired ? 'timeout' : classifyError(error).kind
    unexpanded.clear()
    assessments = Object.fromEntries(candidates.map((card) => [card.id, {
      state: 'unknown', confidence: 0,
      reason: presetIds.length > 0 ? '检查模型没回答；危险操作仍按默认先拦下' : '检查模型未完成判断，不能确认是否满足',
    }]))
  }
  if (caller?.aborted) return finish({ cancelled: true })
  const answered = Object.values(assessments).filter((item) => item.confidence > 0).length
  record.judgeCoverage = { total: candidates.length, answered, unresolved: candidates.length - answered - unexpanded.size, scopeSkipped: unexpanded.size }
  const cleared = applyPresets(assessments, preset, config.minConfidence)
  const judged = unexpanded.size > 0 ? candidates.filter((card) => !unexpanded.has(card.id)) : candidates
  const { selected, reasons } = selectAssessments(assessments, judged, graph.relations, config, {
    cooldowns: tracker.cooldowns ?? new Map(),
    step: snapshot.ledger?.step ?? 0,
    active: snapshot.activeSkills ?? new Set(),
    triggers: snapshot.triggers,
    action: snapshot.action,
    boundary: snapshot.boundary,
    edgeDecisions: stats.edgeDecisions,
  })
  for (const [id, entry] of unexpanded) reasons[id] = { kind: 'scope', by: entry }
  const guidanceMeta = { boundary: snapshot.boundary, triggers: snapshot.triggers, assessments,
    relations: graph.relations, edgeDecisions: stats.edgeDecisions, minConfidence: config.minConfidence }
  const guidance = selected.length > 0 ? renderGuidance(selected, guidanceMeta) : ''
  record.assessments = Object.fromEntries(Object.entries(assessments).map(([id, item]) => [id, { state: item.state, confidence: item.confidence, reason: item.reason,
    ...(item.nextAction ? { nextAction: item.nextAction } : {}), ...(item.evidence ? { evidence: item.evidence } : {}) }]))
  record.edgeDecisions = stats.edgeDecisions
  record.reasons = reasons
  record.preset = presetIds.filter((id) => !cleared.includes(id))
  if (cleared.length > 0) record.cleared = cleared
  record.selected = selected.map((card) => card.id)
  return finish({ cards: selected, guidance, assessments, guidanceMeta })
}
