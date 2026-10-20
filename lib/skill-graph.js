import { ACTION_TRIGGERS, BUILTIN_CARDS, normalizeCard, normalizeRelation, SKILL_ROUTE_TRIGGERS, TRIGGERS } from './cards.js'
import { commandPatterns, pathPatterns } from './match.js'
import { foldKey, locateQuote, parseSkillSource, quoteOf, statementsOf } from './skill-source.js'
import { hash, nowIso, record } from './text.js'

const BUILTIN_IDS = new Set(BUILTIN_CARDS.map((card) => card.id))
const RELATIONS = new Set(['requires', 'blocks', 'covers', 'arbitrates', 'fuses'])
const ORDERING = new Set(['requires', 'blocks'])
// An obligation the model gave no moment for is still checked at a new request and before delivery.
const FALLBACK_TRIGGERS = ['turn', 'settle']
// A citation wider than this many statements is a section summary, not an obligation.
const MAX_CITED = 6

/** Lowercase identifier segment; non-ASCII names get a stable hash suffix. */
export function slug(value) {
  const text = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return text || `s_${hash(value).slice(0, 8)}`
}

/** Preserve canonical host names; disambiguate names whose spelling would collapse. */
export function skillPrefix(name) {
  return `skill_${slug(name)}${/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? '' : `_${hash(name).slice(0, 10)}`}`
}

// What an entry card's `satisfied` means at runtime; the judge reads it.
const ENTRY_SATISFIED = 'The skill is loaded and its instructions are being followed.'

/**
 * A skill's entry card, built from the host's own catalog metadata with no
 * model call. Routing needs nothing more: the description and guidance are
 * what the host shows the main model too, and a positive verdict asks the
 * model to load the skill itself instead of handing it a paraphrase.
 */
export function entryCard(skill) {
  const invocable = skill.invocation?.modelInvocable !== false
  const description = String(skill.description ?? '').trim()
  const guidance = typeof skill.whenToUse === 'string' ? skill.whenToUse.trim() : ''
  return {
    id: `${skillPrefix(skill.name)}_entry`,
    title: `技能：${skill.name}`,
    when: [description || skill.name, guidance && `适用：${guidance}`].filter(Boolean).join('\n'),
    rules: [invocable
      ? `用 \`skill\` 工具加载 \`${skill.name}\`，按它的完整说明行动；目录里的一句描述不是它的要求。`
      : `\`${skill.name}\` 只能由用户显式调用（/${skill.name}）；不要凭描述猜测它的要求。`],
    triggers: [...SKILL_ROUTE_TRIGGERS],
    phase: 'always',
    priority: 2,
    critical: false,
    entry: true,
    source: skill.path ?? skill.name,
    skill: skill.name,
    modelInvocable: invocable,
    satisfiedWhen: ENTRY_SATISFIED,
  }
}

/**
 * Fail-closed dependency hygiene: a card whose prerequisite was dropped leaves
 * the graph too, instead of surviving as an ungated obligation. Cycles are
 * excluded with all their participants. Every removal is reported.
 */
function excludeBrokenDependencies(cards, relations, diagnostics, seeds = []) {
  const byId = new Map(cards.map((card) => [card.id, card]))
  const gateOf = new Map()
  for (const edge of relations) {
    if (!ORDERING.has(edge.type) || !byId.has(edge.source) || !byId.has(edge.target)) continue
    if (!gateOf.has(edge.target)) gateOf.set(edge.target, [])
    gateOf.get(edge.target).push(edge.source)
  }
  const broken = new Set(seeds)
  const excluded = new Set()
  const resolved = new Map()
  const reasonFor = (id, seen = new Set()) => {
    if (broken.has(id) || excluded.has(id)) return 'gate-invalid'
    if (seen.has(id)) return 'cycle'
    if (resolved.has(id)) return resolved.get(id)
    seen.add(id)
    for (const gate of gateOf.get(id) ?? []) {
      const upstream = reasonFor(gate, new Set(seen))
      if (upstream) {
        const reason = upstream === 'cycle' ? 'cycle' : 'gate-invalid'
        resolved.set(id, reason)
        return reason
      }
    }
    resolved.set(id, undefined)
    return undefined
  }
  for (const id of byId.keys()) if (reasonFor(id)) excluded.add(id)
  for (const id of excluded) diagnostics.push({ code: 'dependency-excluded', id, reason: reasonFor(id) ?? 'gate-invalid' })
  return cards.filter((card) => !excluded.has(card.id))
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const strings = (value) => (Array.isArray(value) ? value : [value]).map(text).filter(Boolean)
// Emphasis marks only; code spans keep their backticks.
const plain = (value) => String(value ?? '').replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/\s+/g, ' ').trim()

/** The statements a record cites: `[first, last]`, a single number or "a-b". */
function citation(raw) {
  const value = raw.s ?? raw.statements
  if (Number.isInteger(value)) return [value, value]
  if (Array.isArray(value) && value.length > 0 && value.every(Number.isInteger)) return [Math.min(...value), Math.max(...value)]
  const match = typeof value === 'string' ? /^\s*(\d+)\s*(?:[-–~,]\s*(\d+))?\s*$/.exec(value) : undefined
  return match ? [Number(match[1]), Number(match[2] ?? match[1])] : undefined
}

/** The exact source text behind one record: cited statements, or (fallback) a quote found verbatim in the part. */
function sourceSpan(raw, document, part, statements) {
  const cited = citation(raw)
  if (cited) {
    if (cited[1] - cited[0] >= MAX_CITED) return { broad: true }
    return quoteOf(document, statements, cited[0], cited[1])
  }
  const located = locateQuote(part.content, raw.quote)
  if (!located) return undefined
  const start = part.start + located.start
  const end = part.start + located.end
  return { quote: document.content.slice(start, end), start, end, startLine: document.lineAt(start), endLine: document.lineAt(end - 1) }
}

/**
 * Turn what the model returned for each part of one skill into runtime cards.
 * Every card is grounded by construction: its quote is the cited source text
 * and its lines are where that text really is. A record without a usable
 * source is left out; missing optional fields get defaults instead of costing
 * the obligation. Parts not compiled yet (`records` undefined) contribute nothing.
 *
 * `parts` is `[{ part, statements, records: { obligations, relations } }]` in document order.
 */
export function normalizeSkill(skill, document, parts) {
  const prefix = skillPrefix(skill.name)
  const path = skill.path ?? skill.sourcePath ?? skill.name
  const invocable = skill.invocation?.modelInvocable !== false
  const cards = []
  const edges = []
  const diagnostics = []
  const seeds = []
  const byQuote = new Map()
  const used = new Set([`${prefix}_entry`])
  let extracted = 0
  let compiledParts = 0
  for (const { part, statements, records } of parts) {
    if (!records) continue
    compiledParts += 1
    const local = new Map()
    const dropped = new Set()
    for (const raw of records.obligations ?? []) {
      if (!record(raw)) continue
      extracted += 1
      const label = text(raw.id)
      const span = sourceSpan(raw, document, part, statements)
      if (!span?.quote) {
        diagnostics.push({ code: span?.broad ? 'too-broad' : 'no-source', id: label })
        if (label) { dropped.add(label); dropped.add(slug(label)) }
        continue
      }
      const key = foldKey(span.quote)
      const first = byQuote.get(key)
      if (first) {
        if (label) { local.set(label, first.id); local.set(slug(label), first.id) }
        diagnostics.push({ code: 'duplicate', id: first.id })
        continue
      }
      let triggers = strings(raw.on ?? raw.triggers).filter((trigger) => TRIGGERS.has(trigger))
      if (triggers.length === 0) {
        triggers = [...FALLBACK_TRIGGERS]
        diagnostics.push({ code: 'default-moments', id: label })
      }
      let checkpoint = (raw.before ?? raw.checkpoint) === true
      if (checkpoint && !triggers.some((trigger) => ACTION_TRIGGERS.has(trigger))) {
        // A duty checked at delivery cannot stop an action; it stays a plain obligation.
        checkpoint = false
        diagnostics.push({ code: 'not-before-action', id: label })
      }
      const title = text(raw.title) || plain(span.quote).slice(0, 60)
      const base = slug(label || title)
      let id = `${prefix}_${base}`
      for (let index = 2; used.has(id) || BUILTIN_IDS.has(id); index += 1) id = `${prefix}_${base}_${index}`
      const note = (detail) => diagnostics.push({ code: 'pattern', id, detail })
      const card = normalizeCard({
        id,
        title,
        when: text(raw.when) || document.breadcrumb?.(span.start) || part.section || title,
        rules: strings(raw.do ?? raw.rules).filter((rule) => foldKey(rule) !== key),
        notApplicable: text(raw.not ?? raw.notApplicable) || undefined,
        satisfiedWhen: text(raw.done ?? raw.satisfiedWhen) || undefined,
        triggers,
        skill: skill.name,
        modelInvocable: invocable,
        entry: false,
        critical: false,
        phase: 'implementation',
        priority: checkpoint ? 3 : 2,
        source: `${path}#body:L${span.startLine}-L${span.endLine}`,
        sourceRef: { path, startLine: span.startLine, endLine: span.endLine, precise: true, basis: span.first ? 'statement' : 'quote', quoteVerified: true },
        quote: span.quote,
        grounded: true,
        checkpoint,
        match: { paths: pathPatterns(raw.paths, note), commands: commandPatterns(raw.commands, note) },
      }, 'skill')
      if (!card) { diagnostics.push({ code: 'invalid', id: label }); continue }
      used.add(id)
      byQuote.set(key, card)
      cards.push(card)
      if (label) { local.set(label, id); local.set(slug(label), id) }
    }

    const ids = new Set(cards.map((card) => card.id))
    const resolve = (value, type) => {
      const name = text(value)
      if (name.startsWith('builtin:')) return BUILTIN_IDS.has(name.slice(8)) ? name.slice(8) : undefined
      return local.get(name) ?? local.get(slug(name)) ?? (type === 'covers' && BUILTIN_IDS.has(name) ? name : undefined)
    }
    const reaches = (from, to, seen = new Set()) => {
      if (from === to) return true
      if (seen.has(from)) return false
      seen.add(from)
      return edges.some((edge) => ORDERING.has(edge.type) && edge.source === from && reaches(edge.target, to, seen))
    }
    for (const raw of records.relations ?? []) {
      if (!record(raw)) continue
      const type = text(raw.rel ?? raw.type)
      const from = raw.from ?? raw.source
      const to = raw.to ?? raw.target
      const source = resolve(from, type)
      const target = resolve(to, type)
      if (!RELATIONS.has(type) || !source || !target || source === target) {
        // A prerequisite left out for lack of a source still gates its dependent.
        if (ORDERING.has(type) && target && ids.has(target) && dropped.has(text(from))) seeds.push(target)
        diagnostics.push({ code: 'bad-relation', detail: `${type} ${text(from)} → ${text(to)}` })
        continue
      }
      if (type === 'covers' ? !(ids.has(source) && BUILTIN_IDS.has(target))
        : ORDERING.has(type) ? !(ids.has(source) && ids.has(target)) || reaches(target, source)
          : !(ids.has(source) && (ids.has(target) || BUILTIN_IDS.has(target)))) {
        diagnostics.push({ code: 'bad-relation', detail: `${type} ${source} → ${target}` })
        continue
      }
      if (edges.some((edge) => edge.type === type && edge.source === source && edge.target === target)) continue
      edges.push({ type, source, target, ...(text(raw.reason) ? { reason: text(raw.reason) } : {}) })
    }
  }
  const kept = excludeBrokenDependencies(cards, edges, diagnostics, seeds)
  const keptIds = new Set([...BUILTIN_IDS, ...kept.map((card) => card.id)])
  const relations = edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target))
  const count = (...codes) => diagnostics.filter((item) => codes.includes(item.code)).length
  return {
    cards: kept,
    relations,
    diagnostics,
    coverage: {
      parts: parts.length,
      compiledParts,
      characters: document.content.length,
      extracted,
      cards: kept.length,
      checkpoints: kept.filter((card) => card.checkpoint).length,
      duplicates: count('duplicate'),
      dropped: count('no-source', 'too-broad', 'invalid', 'dependency-excluded'),
    },
  }
}

/**
 * Normalize one answer over a whole skill body treated as a single part: the
 * shape older callers and tests use, `{ cards: [...], relations: [...] }`,
 * where a card cites statements of the whole body (`s`) or quotes it.
 */
export function normalizeCompiled(raw, skill) {
  if (!record(raw) || (raw.cards !== undefined && !Array.isArray(raw.cards))) {
    throw Object.assign(new Error('编译结果缺少 cards 数组'), { kind: 'bad-output' })
  }
  const document = parseSkillSource(skill)
  const part = { index: 0, start: 0, end: document.content.length, content: document.content, startLine: 1, endLine: document.lineCount, section: '' }
  return normalizeSkill(skill, document, [{ part, statements: statementsOf(document, part), records: { obligations: raw.cards ?? [], relations: raw.relations ?? [] } }])
}

/**
 * One agent's runtime graph: the built-ins, then every skill in its catalog as
 * an entry card plus the obligations compiled so far. Values are catalog
 * entries `{ summary, source, compiled, stale, partial }` or plain compiled
 * graphs. A skill whose current text is not complete keeps guarding with its
 * previous compile (`stale`) when there is one, else with what is done (`partial`).
 */
export function buildGraph(cwd, skills, builtinEnabled = true) {
  const graphs = [...skills.entries()].map(([name, value]) => {
    const entry = Array.isArray(value?.cards) && !value.summary ? { summary: value, compiled: value } : value ?? {}
    // The full definition (summary merged with what `get()` returned) is the most complete metadata.
    const summary = entry.source ?? entry.summary ?? {}
    const compiled = entry.compiled ?? entry.stale ?? entry.partial
    return {
      name,
      description: summary.description ?? compiled?.description,
      sourcePath: summary.path ?? summary.sourcePath ?? compiled?.sourcePath,
      sourceHash: compiled?.sourceHash,
      invocation: summary.invocation ?? compiled?.invocation,
      whenToUse: summary.whenToUse ?? compiled?.whenToUse,
      entry: entryCard({ ...summary, name }),
      cards: compiled?.cards ?? [],
      relations: compiled?.relations ?? [],
      compiled: Boolean(entry.compiled),
      stale: !entry.compiled && Boolean(entry.stale),
      partial: !entry.compiled && !entry.stale && Boolean(entry.partial),
      compiledAt: compiled?.compiledAt,
      coverage: compiled?.coverage,
      document: compiled?.document,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const cards = [
    ...(builtinEnabled ? BUILTIN_CARDS : []),
    ...graphs.flatMap((graph) => [graph.entry, ...graph.cards]),
  ]
  const ids = new Set(cards.map((card) => card.id))
  const relations = graphs.flatMap((graph) => [
    ...graph.cards.map((card) => ({ type: 'contains', source: graph.entry.id, target: card.id, reason: 'Skill scope; not a completion prerequisite' })),
    ...graph.relations,
  ]).filter((edge) => ids.has(edge.source) && ids.has(edge.target) && (edge.type === 'contains' || normalizeRelation(edge, ids)))
  return { cwd, cards, relations, graphs, revision: hash({ cards, relations }), updatedAt: nowIso() }
}
