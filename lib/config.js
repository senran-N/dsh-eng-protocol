import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { errorMessage, list, messageId, record, stringField } from './text.js'

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  // Judge and record every decision, but never inject, block, or continue a turn.
  shadow: false,
  minConfidence: 0.6,
  cooldownSteps: 3,
  heartbeatSteps: 8,
  builtinCards: true,
  // There are no card, candidate, skill-count, token or time budgets to tune:
  // every triggered card is judged, every needed card is delivered, every skill
  // in use is compiled in full. Concurrency, timeouts and batch sizes adapt to
  // what the model route actually does (see lib/adaptive.js).
  skills: {
    enabled: true,
    include: [],
    exclude: [],
    // Keep the hard requirements of loaded skills, in the skill's own words, in
    // the host's standing context so they survive compaction.
    standing: true,
  },
  decision: {
    // The DSH base bundle mounts this route by default. An operator can point
    // the judge at any other registered route; the main agent route is only a
    // fallback when this one is explicitly cleared.
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    temperature: 0.1,
    reasoningEffort: 'off',
    // Hard ceiling for a complete judgment, including expansion and review. It adapts below
    // it from observed latency; this only stops a hung provider from blocking a boundary.
    timeoutMs: 15000,
    cacheTtlMs: 15000,
  },
  compiler: {
    provider: undefined,
    model: undefined,
    temperature: 0.1,
    reasoningEffort: undefined,
    // Fold the system instructions into the user message. The pi-ai adapter
    // sends a reasoning model's system prompt as role `developer`, which some
    // OpenAI-compatible upstreams reject with "Incorrect role information".
    systemAsUser: true,
    // Hard ceiling for one compile call; the adaptive timeout sits below it.
    timeoutMs: 180000,
  },
  enforcement: {
    enabled: true,
    cards: ['halt', 'scope', 'anti_reward_hacking', 'no_cheat', 'trust_boundary', 'refuted_premise'],
    // A skill obligation the skill itself states as "before X, do Y", verified
    // against its text, may soft-block X once like the cards above.
    skillCheckpoints: true,
  },
  dashboard: {
    enabled: true,
    path: '/eng-protocol',
  },
  stateDir: undefined,
  debug: false,
})

const SECTIONS = ['skills', 'decision', 'compiler', 'enforcement', 'dashboard']
const PROJECT_SKILL_FIELDS = ['include', 'exclude']

/**
 * Budget knobs from earlier versions. They are accepted and ignored with a
 * notice instead of failing: the behaviour they bounded is adaptive now.
 */
export const DEPRECATED_FIELDS = {
  maxCards: '每次注入多少张卡不再设上限：所有被判为 needed 的卡都会送达',
  candidates: '候选卡不再按组限额：所有被触发的卡都交给判官，按需自动分批',
  'skills.maxCardsPerSkill': '不再按卡数裁剪 skill：全部义务保留',
  'skills.maxSkills': '不再限制 skill 数量：全部编译',
  'skills.concurrency': '编译并发按上游表现自适应',
  'skills.maxSkillChars': '分段大小自适应：输出被截断时自动二分',
  'decision.maxTokens': '判官输出上限按候选卡数自适应',
  'decision.boundaryBudgetMs': '边界等待由每次判断的自适应超时约束',
  'decision.coalesceReads': '该开关从未生效，已移除',
  'compiler.maxTokens': '编译输出上限自适应，被截断时自动拆分',
}

/** Remove deprecated fields from one raw layer in place, returning the names found. */
export function stripDeprecated(layer) {
  const found = []
  if (!record(layer)) return found
  for (const field of Object.keys(DEPRECATED_FIELDS)) {
    const [section, key] = field.includes('.') ? field.split('.') : [undefined, field]
    if (!section) {
      if (Object.hasOwn(layer, key)) { delete layer[key]; found.push(field) }
    } else if (record(layer[section]) && Object.hasOwn(layer[section], key)) {
      layer[section] = { ...layer[section] }
      delete layer[section][key]
      found.push(field)
    }
  }
  return found
}

/** Deep merge plain objects; arrays and scalars replace the previous value. */
export function mergeConfig(base, patch) {
  if (!record(patch)) return base
  const next = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (record(value) && record(base[key])) next[key] = mergeConfig(base[key], value)
    else next[key] = value
  }
  return next
}

/** Resolve `~` and relative paths against the project directory. */
export function expandPath(value, cwd) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const expanded = value.startsWith('~/') || value === '~' ? join(homedir(), value.slice(1)) : value
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
}

/** DSH home directory, honouring the documented environment variable. */
export function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** Normalize one configuration layer and reject values that would silently mislead. */
export function normalizeConfig(raw, cwd = process.cwd()) {
  // Start from a private copy: the frozen defaults are shallow, and the checks below assign into sections.
  const layer = structuredClone(record(raw) ?? {})
  const deprecated = stripDeprecated(layer)
  const config = mergeConfig(structuredClone(DEFAULT_CONFIG), layer)
  const errors = []
  for (const key of SECTIONS) {
    if (!record(config[key])) {
      errors.push(`${key} 必须是对象，已使用默认值`)
      config[key] = structuredClone(DEFAULT_CONFIG[key])
    }
  }

  const integer = (value, name, min, max) => {
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
      if (value < min || value > max) errors.push(`${name} 超出 ${min}–${max}，已截断`)
      return Math.min(max, Math.max(min, value))
    }
    errors.push(`${name} 必须是 ${min}–${max} 之间的整数`)
    return min
  }
  const number = (value, name, min, max) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value < min || value > max) errors.push(`${name} 超出 ${min}–${max}，已截断`)
      return Math.min(max, Math.max(min, value))
    }
    errors.push(`${name} 必须是 ${min}–${max} 之间的数字`)
    return min
  }
  const flag = (value, name, fallback) => {
    if (typeof value === 'boolean') return value
    errors.push(`${name} 必须是 true 或 false，已使用 ${fallback}`)
    return fallback
  }
  const strings = (value, name) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
      errors.push(`${name} 必须是字符串数组`)
      return []
    }
    return value.map((item) => item.trim())
  }

  config.enabled = flag(config.enabled, 'enabled', true)
  config.shadow = flag(config.shadow, 'shadow', false)
  config.builtinCards = flag(config.builtinCards, 'builtinCards', true)
  config.debug = flag(config.debug, 'debug', false)
  config.minConfidence = number(config.minConfidence, 'minConfidence', 0, 1)
  config.cooldownSteps = integer(config.cooldownSteps, 'cooldownSteps', 0, 100)
  config.heartbeatSteps = integer(config.heartbeatSteps, 'heartbeatSteps', 0, 100)
  config.skills.enabled = flag(config.skills.enabled, 'skills.enabled', true)
  config.skills.include = strings(config.skills.include, 'skills.include')
  config.skills.exclude = strings(config.skills.exclude, 'skills.exclude')
  config.skills.standing = flag(config.skills.standing, 'skills.standing', true)
  config.decision.temperature = number(config.decision.temperature, 'decision.temperature', 0, 2)
  config.decision.timeoutMs = integer(config.decision.timeoutMs, 'decision.timeoutMs', 500, 120000)
  config.decision.cacheTtlMs = integer(config.decision.cacheTtlMs, 'decision.cacheTtlMs', 0, 120000)
  config.compiler.temperature = number(config.compiler.temperature, 'compiler.temperature', 0, 2)
  config.compiler.systemAsUser = flag(config.compiler.systemAsUser, 'compiler.systemAsUser', true)
  config.compiler.timeoutMs = integer(config.compiler.timeoutMs, 'compiler.timeoutMs', 1000, 600000)
  for (const section of ['decision', 'compiler']) {
    const effort = config[section].reasoningEffort
    if (effort !== undefined && (typeof effort !== 'string' || !/^(off|minimal|low|medium|high|max)$/.test(effort))) {
      errors.push(`${section}.reasoningEffort 必须是 off / minimal / low / medium / high / max`)
      config[section].reasoningEffort = DEFAULT_CONFIG[section].reasoningEffort
    }
    for (const key of ['provider', 'model']) {
      const value = config[section][key]
      // null means "follow": the judge follows the main conversation, the compiler follows the judge.
      if (value === null) { config[section][key] = undefined; continue }
      if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
        errors.push(`${section}.${key} 必须是非空字符串，已清除`)
        config[section][key] = undefined
      } else if (typeof value === 'string') config[section][key] = value.trim()
    }
  }
  config.enforcement.enabled = flag(config.enforcement.enabled, 'enforcement.enabled', true)
  config.enforcement.cards = strings(config.enforcement.cards, 'enforcement.cards')
  config.enforcement.skillCheckpoints = flag(config.enforcement.skillCheckpoints, 'enforcement.skillCheckpoints', true)
  config.dashboard.enabled = flag(config.dashboard.enabled, 'dashboard.enabled', true)
  const rawPath = config.dashboard.path
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) errors.push('dashboard.path 必须以 / 开头')
  config.dashboard.path = typeof rawPath === 'string' && rawPath.startsWith('/')
    ? rawPath.replace(/\/+$/, '')
    : '/eng-protocol'
  if (config.dashboard.path.length < 2) config.dashboard.path = '/eng-protocol'
  config.stateDir = expandPath(config.stateDir, cwd) ?? join(dshHome(), 'storages', 'eng-protocol')
  config.cwd = cwd
  config.errors = errors
  config.deprecated = deprecated
  return config
}

/** Operator-level layer `$DSH_HOME/eng-protocol.json`; a missing file is not an error. */
export function readUserConfig(path = join(dshHome(), 'eng-protocol.json')) {
  try {
    const config = record(JSON.parse(readFileSync(path, 'utf8')))
    if (!config) throw new Error('配置根节点必须是对象')
    return { path, config }
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: undefined, config: {} }
    return { path, config: {}, error: errorMessage(error) }
  }
}

/** Effective plugin config: defaults ← `$DSH_HOME/eng-protocol.json` ← the profile patch `config`. */
export function resolveConfig(raw, cwd = process.cwd()) {
  const user = readUserConfig()
  const config = normalizeConfig(mergeConfig(user.config, record(raw) ?? {}), cwd)
  config.userConfigPath = user.path
  if (user.error) config.errors.push(`${user.path} 读取失败，已忽略：${user.error}`)
  return config
}

/**
 * Project layer `.dsh/eng-protocol.json`. A repository may only narrow which
 * skills compile (`skills.include` / `skills.exclude`). Models, thresholds and
 * enforcement stay operator-owned, so a cloned repository can neither switch
 * the guard off nor redirect model calls; other fields are reported as ignored.
 */
export async function loadProjectConfig(cwd, base) {
  const path = join(cwd, '.dsh', 'eng-protocol.json')
  let raw
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: base, path: undefined, ignored: [], errors: [] }
    return { config: base, path, ignored: [], errors: [`读取失败，已忽略：${errorMessage(error)}`] }
  }
  const layer = record(raw) ?? {}
  const skills = record(layer.skills) ?? {}
  const ignored = [
    ...Object.keys(layer).filter((key) => key !== 'skills'),
    ...Object.keys(skills).filter((key) => !PROJECT_SKILL_FIELDS.includes(key)).map((key) => `skills.${key}`),
  ]
  const patch = Object.fromEntries(PROJECT_SKILL_FIELDS.filter((key) => key in skills).map((key) => [key, skills[key]]))
  const config = normalizeConfig(mergeConfig(base, { skills: patch }), cwd)
  return { config, path, ignored, errors: config.errors }
}

/** True when a skill name passes the configured include/exclude filters. */
export function skillAllowed(name, config) {
  const include = list(config.skills.include)
  const exclude = list(config.skills.exclude)
  if (include.length > 0 && !include.includes(name)) return false
  return !exclude.includes(name)
}

/**
 * Fields the dashboard may change, keyed by the real config section. Operator
 * safety switches (enforcement, shadow, enabled) and paths stay file-only: a
 * browser tab must not be able to disarm the guard or redirect state. `runtime`
 * is a UI grouping only: its fields are top-level config keys.
 */
export const DASHBOARD_EDITABLE = {
  decision: ['provider', 'model', 'temperature', 'reasoningEffort', 'timeoutMs', 'cacheTtlMs'],
  compiler: ['provider', 'model', 'temperature', 'reasoningEffort', 'systemAsUser', 'timeoutMs'],
  skills: ['include', 'exclude'],
  runtime: ['minConfidence', 'cooldownSteps', 'heartbeatSteps', 'builtinCards'],
}

/** True when a UI section stores its fields at the top level of the config file. */
const FLAT_SECTION = new Set(['runtime'])
const settingsWrites = new Map()

/**
 * Apply an operator-level settings patch from the dashboard and persist it in
 * `$DSH_HOME/eng-protocol.json`. Only the whitelisted fields above are accepted;
 * anything else is rejected rather than silently ignored.
 */
export async function saveUserSettings(patch, base, cwd = process.cwd()) {
  const path = resolve(dshHome(), 'eng-protocol.json')
  const key = process.platform === 'win32' ? path.toLowerCase() : path
  const captured = structuredClone(patch)
  const previous = settingsWrites.get(key) ?? Promise.resolve()
  const pending = previous.catch(() => undefined).then(() => writeUserSettings(captured, cwd, path))
  settingsWrites.set(key, pending)
  try { return await pending }
  finally { if (settingsWrites.get(key) === pending) settingsWrites.delete(key) }
}

async function writeUserSettings(patch, cwd, writePath) {
  if (!record(patch)) throw new Error('配置必须是对象')
  const user = readUserConfig(writePath)
  if (user.error) throw new Error(`配置读取失败，未覆盖原文件：${user.error}`)
  const current = record(user.config) ?? {}
  const next = structuredClone(current)
  // Saving from the panel also retires budget fields the file still carries.
  const cleaned = stripDeprecated(next)
  const applied = []
  const rejected = []
  // A section that is not editable at all must be named explicitly, not ignored.
  for (const section of Object.keys(patch)) {
    if (!Object.hasOwn(DASHBOARD_EDITABLE, section)) rejected.push(section)
  }
  for (const [section, keys] of Object.entries(DASHBOARD_EDITABLE)) {
    const values = record(patch[section])
    if (!values) continue
    for (const [key, value] of Object.entries(values)) {
      if (!keys.includes(key)) {
        rejected.push(`${section}.${key}`)
        continue
      }
      if (value === null || value === undefined) {
        // Clearing a field returns it to the layered default.
        if (FLAT_SECTION.has(section)) delete next[key]
        else if (record(next[section])) delete next[section][key]
        else delete next[section]
        applied.push(`${section}.${key}`)
        continue
      }
      // An empty provider/model is an explicit "follow" choice, stored as null.
      const stored = ['decision', 'compiler'].includes(section) && ['provider', 'model'].includes(key) && value === '' ? null : value
      if (FLAT_SECTION.has(section)) {
        next[key] = stored
      } else {
        next[section] = record(next[section]) ? { ...next[section] } : {}
        next[section][key] = stored
      }
      applied.push(`${section}.${key}`)
    }
  }
  if (rejected.length > 0) {
    throw new Error(`这些字段不允许在面板中修改：${rejected.join('、')}`)
  }
  if (applied.length === 0) throw new Error('没有可保存的字段')
  // Validate the merged result before writing: a bad value must never land on
  // disk and only be reported afterwards. Compare each edited value against the
  // normalized result so clamping is a rejection, not a silent rewrite.
  const merged = normalizeConfig(mergeConfig(structuredClone(DEFAULT_CONFIG), next), cwd)
  const problems = [...merged.errors]
  for (const field of applied) {
    const [section, key] = field.split('.')
    const flat = FLAT_SECTION.has(section)
    const stored = flat ? next[key] : next[section]?.[key]
    const normalized = flat ? merged[key] : merged[section]?.[key]
    if (stored !== undefined && stored !== null && JSON.stringify(stored) !== JSON.stringify(normalized)) {
      problems.push(`${field}=${JSON.stringify(stored)} 无效（有效值 ${JSON.stringify(normalized)}）`)
    }
  }
  if (problems.length > 0) throw new Error(`配置未保存，存在无效值：${[...new Set(problems)].join('；')}`)
  await mkdir(dirname(writePath), { recursive: true })
  const temp = `${writePath}.${process.pid}.${messageId()}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(temp, writePath)
  } finally {
    await unlink(temp).catch(error => { if (error?.code !== 'ENOENT') throw error })
  }
  return { path: writePath, applied, rejected, cleaned, errors: [], patch: next }
}

/** Model route for the decision call; explicit empty values fall back to the main agent. */
export function decisionRoute(agent, config) {
  const provider = config.decision.provider || agent?.options?.provider
  const model = config.decision.model || agent?.options?.model
  return provider && model ? { provider, model } : undefined
}

/** Model route for skill compilation. */
export function compilerRoute(agent, config) {
  const provider = config.compiler.provider || config.decision.provider || agent?.options?.provider
  const model = config.compiler.model || config.decision.model || agent?.options?.model
  return provider && model ? { provider, model } : undefined
}

/** Project cwd for an agent, with a deterministic fallback. */
export function agentCwd(agent) {
  return stringField(agent?.session?.header, 'cwd') || process.cwd()
}
