import { posix, win32 } from 'node:path'
import { clip, hash, oneLine, remember } from './text.js'

const TEST_PATH = /(^|[\\/])(tests?|__tests__|spec|e2e|integration)([\\/]|$)|\.(test|spec)\.[a-z0-9]+$/i
const DEPENDENCY_PATH = /(^|[\\/])(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.toml|Cargo\.lock|pyproject\.toml|requirements[^\\/]*\.txt|go\.mod|go\.sum|pom\.xml|build\.gradle|gradle\.lockfile|composer\.json|Gemfile|Gemfile\.lock)$/i
const SUSPICIOUS = /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above)\s+instructions|you\s+are\s+now\s+|system\s+prompt|developer\s+message|do\s+not\s+tell\s+the\s+user|<\|?(system|assistant|developer)\|?>/i

// Commands that run a project check, one alternative per entry. The shared
// prefix accepts `cd x &&`, PowerShell `&`, env assignments, and `npx` / `pnpm exec`.
const CHECK_TOOLS = [
  String.raw`node(?:\.exe)?\s+(?:--test\b|[^\s;&|]*(?:test|spec)[^\s;&|]*)`,
  String.raw`(?:vitest|jest|mocha|tsc|eslint|oxlint|biome|pytest|tox|mypy|pyright|ctest|phpunit|rspec)`,
  String.raw`(?:playwright\s+test|ruff\s+check)`,
  String.raw`(?:python3?|py)\s+-m\s+(?:pytest|unittest|mypy|ruff|pyright)`,
  String.raw`(?:uv|poetry|pdm|hatch)\s+run\s+(?:pytest|tox|mypy|pyright|ruff)`,
  String.raw`go\s+(?:test|vet)`,
  String.raw`cargo\s+(?:test|check|clippy|nextest)`,
  String.raw`(?:flutter|dart)\s+(?:test|analyze)`,
  String.raw`(?:dotnet|swift)\s+test`,
  String.raw`deno\s+(?:test|check|lint)`,
  String.raw`(?:\.[\\/])?mvnw?(?:\.cmd)?\s+[^;&|\n]*\b(?:test|verify)`,
  String.raw`(?:\.[\\/])?gradlew?(?:\.bat)?\s+[^;&|\n]*\b(?:test|check)`,
  String.raw`make\s+(?:test|check|lint)`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|check|build)`,
]
const CHECK_COMMAND = new RegExp(String.raw`(?:^|[;&|])\s*(?:&\s*)?(?:\w+=\S*\s+)*(?:npx\s+|pnpm\s+exec\s+)?(?:\$\w+\s+)?(?:${CHECK_TOOLS.join('|')})\b`, 'i')

// Destructive or outward-facing commands: the halt card's local preset applies.
// POSIX shells, PowerShell and cmd are all covered because DSH ships a `pwsh` tool.
const DESTRUCTIVE_COMMANDS = [
  /\brm\s(?:[^;&|\n]*\s)?(?:-[fivdIRr]*[rR][fivdIRr]*\b|--recursive\b)/,
  /\b(?:Remove-Item|rm|ri|rd|rmdir|del|erase)\b[^;|\n]*\s-(?:r|rec\w*)\b/i,
  /\b(?:rd|rmdir|del|erase)\b[^;&|\n]*\s\/s\b/i,
  /\bgit\s+(?:push\b|reset\s+--hard\b|clean\s+-[a-z]*f|checkout\s+(?:--|\.)(?=\s|$)|stash\s+(?:drop|clear)\b|filter-branch\b)/i,
  /\bgit\s+restore\b(?![^;&|\n]*--staged\b)/i,
  /\bgit\s+branch\s+(?:[^;&|\n]*\s)?-[a-zA-Z]*D\b/,
  /\b(?:npm|pnpm|yarn|bun|cargo)\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b/i,
  /\bgh\s+(?:pr\s+(?:create|merge|close)|release\s+(?:create|delete)|repo\s+delete)\b/i,
  /\bkubectl\s+(?:apply|delete|patch|replace)\b|\bterraform\s+(?:apply|destroy)\b|\bhelm\s+(?:install|upgrade|uninstall)\b/i,
  /\bcurl\b[^\n]*(?:-X\s*|--request\s*)(?:POST|PUT|PATCH|DELETE)\b/i,
  /\bcurl\b[^\n]*\s(?:-d|--data(?:-raw|-binary|-urlencode)?|--json|-F|--form)\b/,
  /\bInvoke-(?:RestMethod|WebRequest)\b[^\n]*\s-Method\s+(?:Post|Put|Patch|Delete)\b/i,
  /\b(?:drop\s+(?:table|database)|truncate\s+table)\b/i,
  /\bmkfs\b|\bdd\s+if=|\bFormat-Volume\b/i,
]
// Reversible but authorization-sensitive: worth asking the judge, no local preset.
const SENSITIVE_COMMANDS = [/\bgit\s+commit\b/i]

const EDIT_TOOLS = /^(write|edit|multiedit|str_replace_editor|str_replace_based_edit_tool|str_replace|apply_patch|write_file|edit_file|create_file|replace)$/i
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$|^\+\+\+ b\/([^\t\n]+)|^--- a\/([^\t\n]+)/gm
const MAX_CALL_IDS = 2000

const firstString = (...values) => values.find((value) => typeof value === 'string')
// DSH shell tools: `started background job <id>` (run_in_background) and
// `[still running after Nms; moved to background job <id>]` (timeout promotion).
const BACKGROUND_HANDOFF = /\[still running after[^\]]*\]|started background job\s+\S+|Background job started:/i

/** The few call arguments background-job tracking needs; never file contents. */
function jobArgs(args) {
  if (!args || typeof args !== 'object') return undefined
  const picked = {}
  for (const key of ['run_in_background', 'background', 'job_id']) if (args[key] !== undefined) picked[key] = args[key]
  return Object.keys(picked).length > 0 ? picked : undefined
}
const patchText = (args) => firstString(args.patch, args.input, args.diff)

/** Extract visible text from a content-block array or string. */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim()
}

/** Parse a tool call's raw JSON argument string without throwing. */
export function parseArguments(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || value.trim() === '') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** File paths named by a patch body: apply_patch envelopes or git-style unified diff headers. */
export function patchPaths(patch) {
  if (typeof patch !== 'string') return []
  const paths = new Set()
  for (const match of patch.matchAll(PATCH_HEADER)) {
    const path = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim()
    if (path && path !== '/dev/null') paths.add(path)
  }
  return [...paths]
}

/** True when a shell command runs a project check (tests, type check, lint, build). */
export function isCheckCommand(command) {
  return typeof command === 'string' && CHECK_COMMAND.test(command)
}

// Mitigation flags only excuse a destructive segment when the flagged CLI actually
// short-circuits: `--help` on `curl -d` still sends the request, so curl never counts.
const HELP_AWARE = /\b(?:git|npm|pnpm|yarn|bun|cargo|docker|gh|kubectl|terraform|helm|twine)\b/i
const DRY_RUN_AWARE = /\b(?:git\s+push|terraform\s+(?:apply|destroy)|helm\s+(?:install|upgrade)|kubectl\s+(?:apply|delete|patch|replace)|(?:npm|pnpm|yarn|bun)\s+publish)\b/i
const MITIGATION_FLAG = /(?:^|\s)(?:--dry-run|--help|--version|-WhatIf|-V\b)(?=\s|$)/i
const SEGMENT_SPLIT = /&&|\|\||[;|\r\n]|\$\(/i
const LEADING_CD = /^\s*(?:cd|Set-Location)\s+(["']?)(\.{0,2}[/\\][^\s;&|]*|[A-Za-z]:[/\\][^\s;&|]*|~[^\s;&|]*|[^\s;&|]+)\1\s*(?:[;&|]|$)/i

/**
 * Destructive on its own terms, segment by segment: `git --version; git push`
 * must keep the halt preset even though the whole string contains `--version`.
 * A flag excuses only the segment it appears in, and only for CLIs that honour it.
 */
export function hasUnmitigatedDestructiveCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false
  if (!DESTRUCTIVE_COMMANDS.some((pattern) => pattern.test(command))) return false
  for (const raw of command.split(SEGMENT_SPLIT)) {
    const segment = raw.trim()
    if (!segment || !DESTRUCTIVE_COMMANDS.some((pattern) => pattern.test(segment))) continue
    if (/\s-WhatIf\b/i.test(segment)) continue
    if (/--dry-run/i.test(segment) && DRY_RUN_AWARE.test(segment)) continue
    if (MITIGATION_FLAG.test(segment) && HELP_AWARE.test(segment)) continue
    return true
  }
  return false
}

/** Effective directory of a command: explicit workdir or inline `cd`, against the session cwd. */
export function commandScope(sessionCwd, workdir, command = '') {
  const base = typeof sessionCwd === 'string' && sessionCwd.trim() ? sessionCwd : undefined
  let target = typeof workdir === 'string' && workdir.trim() ? workdir.trim() : undefined
  if (!target) {
    const cd = LEADING_CD.exec(command)
    if (cd && /\S/.test(command.slice(cd.index + cd[0].length))) target = cd[2]
  }
  if (!target) return { cwd: base, known: Boolean(base), source: base ? 'session' : 'unknown' }
  const absolute = /^[A-Za-z]:[/\\]/.test(target) || target.startsWith('/') || target.startsWith('~')
  if (!absolute && !base) return { cwd: target, known: false, source: 'workdir-relative' }
  if (!absolute) {
    const joiner = base.includes('\\') ? win32.join : posix.join
    target = joiner(base, target)
  }
  return { cwd: target, known: true, source: workdir && workdir.trim() === target.trim() ? 'workdir' : 'inline-cd' }
}

/** Classify one tool call into the narrow vocabulary the cards subscribe to. */
export function classifyTool(name, rawArgs, { cwd } = {}) {
  const tool = String(name ?? '').toLowerCase()
  const args = parseArguments(rawArgs)
  const path = firstString(args.path, args.file_path, args.filePath)
  const command = firstString(args.command, args.script)
  const workdir = firstString(args.workdir, args.cwd)
  const base = { tool: name, path, paths: path ? [path] : [], command, args }
  if (command !== undefined || workdir !== undefined) {
    const scope = commandScope(cwd, workdir, command ?? '')
    base.cwd = scope.cwd
    base.workdir = workdir
    base.scope = scope
  } else if (cwd) {
    base.cwd = cwd
  }
  if (EDIT_TOOLS.test(tool)) {
    const paths = path ? [path] : patchPaths(patchText(args))
    return {
      ...base,
      kind: 'edit',
      path: paths[0],
      paths,
      isTest: paths.some((item) => TEST_PATH.test(item)),
      isDependency: paths.some((item) => DEPENDENCY_PATH.test(item)),
    }
  }
  if (/^(read|grep|glob|list|search|find|ls)$/i.test(tool)) {
    return { ...base, kind: 'read', isDependency: path ? DEPENDENCY_PATH.test(path) : false }
  }
  if (/^(bash|pwsh|shell|terminal|exec|run)$/i.test(tool)) {
    const text = command ?? ''
    const isDestructive = DESTRUCTIVE_COMMANDS.some((pattern) => pattern.test(text))
    const isRisky = isDestructive || SENSITIVE_COMMANDS.some((pattern) => pattern.test(text))
    return {
      ...base,
      kind: 'command',
      isCheck: !isRisky && CHECK_COMMAND.test(text),
      isRisky,
      isDestructive,
      isDependency: path ? DEPENDENCY_PATH.test(path) : false,
    }
  }
  if (/^skill$/i.test(tool)) return { ...base, kind: 'skill', skill: typeof args.name === 'string' ? args.name : undefined }
  if (/^(web_search|web_fetch|fetch|search_web)$/i.test(tool)) return { ...base, kind: 'research' }
  if (/^(subagent|workflow|agent|delegate)$/i.test(tool)) return { ...base, kind: 'delegate' }
  return { ...base, kind: 'other' }
}

/** Readable proposed content for the decision model; never the full tool output. */
export function actionExcerpt(action, max = 3200) {
  if (!action) return undefined
  if (action.kind === 'command') return action.command ? clip(action.command, max) : undefined
  if (action.kind !== 'edit') return undefined
  const args = action.args ?? {}
  const parts = []
  if (typeof args.old_string === 'string') parts.push(`OLD:\n${args.old_string}`)
  if (typeof args.new_string === 'string') parts.push(`NEW:\n${args.new_string}`)
  if (typeof args.content === 'string') parts.push(`CONTENT:\n${args.content}`)
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits.slice(0, 4)) {
      if (edit?.old_string) parts.push(`OLD:\n${edit.old_string}`)
      if (edit?.new_string) parts.push(`NEW:\n${edit.new_string}`)
    }
  }
  const patch = patchText(args)
  if (patch) parts.push(`PATCH:\n${patch}`)
  return parts.length > 0 ? clip(parts.join('\n---\n'), max) : undefined
}

/** Map one classified action to the evidence events it produces. */
export function actionTriggers(action, editedCount = 0) {
  const triggers = new Set()
  if (!action || action.kind === 'other') return []
  if (action.kind === 'edit') {
    triggers.add('edit')
    if (editedCount === 0) triggers.add('first_edit')
    if (action.isTest) triggers.add('test_edit')
    if (action.isDependency) triggers.add('dependency')
  } else if (action.kind === 'read') {
    triggers.add('read')
    if (action.isDependency) triggers.add('dependency')
  } else if (action.kind === 'command') {
    if (action.isCheck) triggers.add('check_start')
    if (action.isRisky) triggers.add('risky')
  } else if (action.kind === 'skill') {
    triggers.add('skill')
  } else if (action.kind === 'research') {
    triggers.add('research')
  } else if (action.kind === 'delegate') {
    triggers.add('delegate')
  }
  return [...triggers]
}

/** One initialized per-agent evidence ledger, fed by the live `session/event` stream. */
export class SessionLedger {
  constructor(agent, { heartbeatSteps = 8 } = {}) {
    this.agent = agent
    this.session = agent?.session
    this.heartbeatSteps = heartbeatSteps
    this.heartbeatAt = -1
    this.pending = []
    this.turn = 0
    this.step = 0
    this.quietSteps = 0
    this.lastUser = ''
    this.lastAssistant = ''
    this.lastUserKey = ''
    this.lastSkill = ''
    this.loadedSkills = new Set()
    this.observedSkills = new Set()
    this.editRevision = 0
    this.observations = []
    this.failures = []
    this.failureStreak = 0
    this.lastFailureKey = ''
    this.filesRead = new Set()
    this.filesEdited = new Set()
    this.checks = []
    this.seenCalls = new Set()
    this.consumedCalls = new Set()
    this.eventsSeen = 0
    this.cwd = typeof agent?.session?.header?.cwd === 'string' && agent.session.header.cwd.trim()
      ? agent.session.header.cwd : undefined
    // Causal attribution: consumed counts plus a watermark covering
    // queued-but-unconsumed events, so delivery bookkeeping can neither credit
    // nor blame evidence the model has not seen yet.
    this.evidenceSeq = 0
    this.responseSeq = 0
    this.eventSeq = 0
    this.pendingKind = new Map()
    this.jobs = new Map()
    // Position of the newest session event, so a decision can point into the Trajectory.
    this.lastSeq = undefined
    this.seed()
  }

  /** Session cwd may change mid-session; the host signals this explicitly. */
  setCwd(cwd) {
    if (typeof cwd === 'string' && cwd.trim()) this.cwd = cwd
  }

  /** Attribution watermarks including queued-but-unconsumed evidence. */
  watermark() {
    let evidence = this.evidenceSeq
    let response = this.responseSeq
    for (const kind of this.pendingKind.values()) {
      if (kind === 'response') response += 1
      else evidence += 1
    }
    return { evidenceSeq: evidence, responseSeq: response }
  }

  /** Queue one live event; the next decision drains it. Assign its causal kind on arrival. */
  push(event) {
    if (!event) return
    if (Number.isInteger(event.seq)) this.lastSeq = event.seq
    if (event.type === 'working-directory/change') { this.setCwd(event.data?.cwd); return }
    // Assistant messages and new tool calls are model actions; everything else
    // (results, user input, lifecycle) is evidence about the world.
    this.pendingKind.set(event, event.type === 'assistant/message' || event.type === 'tool/call' ? 'response' : 'evidence')
    this.eventSeq += 1
    this.pending.push(event)
    if (this.pending.length > 240) this.pendingKind.delete(this.pending.shift())
  }

  /** Seed from the already-derived history so a resumed session is not blind. */
  seed() {
    try {
      const messages = typeof this.session?.deriveMessages === 'function' ? this.session.deriveMessages() : []
      for (const message of messages) {
        if (message.role === 'user') {
          const kind = message.source?.kind
          if (kind === 'user') {
            const text = contentText(message.content)
            if (text) {
              this.lastUserKey = hash(text)
              this.lastUser = clip(text, 2000)
            }
          } else if (kind === 'skill-invocation' && typeof message.source.name === 'string') {
            this.lastSkill = message.source.name
            this.loadedSkills.add(this.lastSkill)
          }
        } else if (message.role === 'assistant') {
          const text = contentText(message.content)
          if (text) this.lastAssistant = clip(text, 1600)
          for (const block of Array.isArray(message.content) ? message.content : []) {
            if (block?.type === 'tool-call' && block.id) {
              const action = classifyTool(block.name, block.arguments)
              this.observations.push({
                callId: String(block.id),
                name: block.name,
                kind: action.kind,
                path: action.path,
                paths: action.paths,
                command: action.command,
                skill: action.skill,
                editRevision: this.editRevision,
                status: 'pending',
                fingerprint: hash([block.name, block.arguments]),
              })
              remember(this.seenCalls, String(block.id), MAX_CALL_IDS)
            }
          }
        } else if (message.role === 'tool') {
          const callId = String(message.toolCallId ?? message.source?.callId ?? '')
          const observation = this.observations.find((item) => item.callId === callId)
          if (observation) {
            this.consume({ type: 'tool/result', data: { message: { ...message, source: { ...message.source, callId } } } }, new Set())
          }
        }
      }
      if (this.observations.length > 40) this.observations.splice(0, this.observations.length - 40)
    } catch {
      // A session that cannot derive history still accepts live events.
    }
  }

  /** Drain queued events plus the step's admitted messages into a trigger set. */
  observe(payloadMessages = []) {
    this.observedSkills.clear()
    const triggers = new Set()
    const events = this.pending.splice(0)
    for (const event of events) {
      this.eventsSeen += 1
      const kind = this.pendingKind.get(event)
      this.pendingKind.delete(event)
      if (kind === 'response') this.responseSeq += 1
      else this.evidenceSeq += 1
      this.consume(event, triggers)
    }

    for (const message of payloadMessages) {
      if (message?.role !== 'user') continue
      const kind = message?.source?.kind
      if (kind === 'user') {
        const text = contentText(message.content)
        const key = hash(text)
        if (text && key !== this.lastUserKey) {
          this.lastUserKey = key
          this.lastUser = clip(text, 2000)
          // Newly admitted text is new evidence even when the seeded history
          // already carried an older copy of it.
          this.evidenceSeq += 1
        }
        // A newly admitted human message opens a turn, even when its text is
        // also present in the seeded history of a resumed session.
        triggers.add('turn')
      } else if (kind === 'skill-invocation' && typeof message.source.name === 'string') {
        this.lastSkill = message.source.name
        this.loadedSkills.add(this.lastSkill)
        this.observedSkills.add(this.lastSkill)
        this.evidenceSeq += 1
        triggers.add('skill')
      }
    }

    // Fallback evaluation every `heartbeatSteps` steps of a turn, once per step.
    const every = this.heartbeatSteps
    if (every > 0 && this.quietSteps > 0 && this.quietSteps % every === 0 && this.heartbeatAt !== this.quietSteps) {
      this.heartbeatAt = this.quietSteps
      triggers.add('heartbeat')
    }
    return {
      triggers: [...triggers],
      observations: this.observations.slice(-12),
      lastSkill: this.lastSkill,
      ledger: this.summary(),
    }
  }

  consume(event, triggers) {
    const type = event?.type
    const data = event?.data ?? {}
    if (type === 'turn/start') {
      this.turn = Number.isInteger(data.turn) ? data.turn : this.turn + 1
      this.quietSteps = 0
      this.heartbeatAt = -1
      triggers.add('turn')
      return
    }
    if (type === 'step/start') {
      this.step = Number.isInteger(data.step) ? data.step : this.step + 1
      this.quietSteps += 1
      return
    }
    if (type === 'user/message') {
      const kind = data?.source?.kind
      if (kind === 'user') {
        const text = contentText(data.content)
        const key = hash(text)
        if (text && key !== this.lastUserKey) {
          this.lastUserKey = key
          this.lastUser = clip(text, 2000)
          triggers.add('turn')
        }
      } else if (kind === 'skill-invocation' && typeof data.source.name === 'string') {
        this.lastSkill = data.source.name
        this.loadedSkills.add(this.lastSkill)
        this.observedSkills.add(this.lastSkill)
        triggers.add('skill')
      } else if (kind === 'tool-jobs') {
        // The host's completion notice for a background job.
        const text = contentText(data.content)
        const notice = /background job\s+(\S+)[^\n]*?finished\s+(\[status:[^\]]*\])/i.exec(text)
        if (notice) this.settleJob(notice[1], notice[2], triggers)
      }
      return
    }
    if (type === 'assistant/message') {
      const text = contentText(data?.message?.content)
      if (text) this.lastAssistant = clip(text, 1600)
      return
    }
    if (type === 'tool/call') {
      const callId = String(data.callId ?? '')
      if (!callId || this.seenCalls.has(callId)) return
      remember(this.seenCalls, callId, MAX_CALL_IDS)
      const action = classifyTool(data.name, data.arguments, { cwd: this.cwd })
      const observation = {
        callId,
        name: data.name,
        kind: action.kind,
        path: action.path,
        paths: action.paths,
        command: action.command,
        workdir: action.workdir,
        cwd: action.cwd,
        scope: action.scope,
        skill: action.skill,
        args: jobArgs(action.args),
        editRevision: this.editRevision,
        status: 'pending',
        startedAt: event.time,
        fingerprint: hash([data.name, data.arguments]),
      }
      this.observations.push(observation)
      if (this.observations.length > 40) this.observations.shift()
      this.trackJobStart(observation)
      // The tool boundary already judged this call; its triggers must not fire again at the next step.
      if (!this.consumedCalls.has(callId) && action.kind !== 'skill') this.applyActionTriggers(action, triggers)
      return
    }
    if (type === 'tool/result') {
      const message = data?.message
      const callId = String(message?.source?.callId ?? message?.toolCallId ?? data.callId ?? '')
      const observation = this.observations.find((item) => item.callId === callId)
      const text = contentText(message?.content)
      // A structured error flag wins; the exit-code scan is a fallback for command
      // tools only, because read/grep output legitimately contains such text.
      const structuredError = message?.isError === true || Boolean(data?.error)
      const interrupted = BACKGROUND_HANDOFF.test(text)
      const exit = observation && (observation.kind === 'command' || observation.kind === 'other')
        ? /\[exit code:\s*(\d+)\]|(?:^|\n)\s*exit code:\s*(\d+)/i.exec(text)
        : null
      const exitedNonZero = exit !== null && Number(exit[1] ?? exit[2]) !== 0
      const isError = structuredError || exitedNonZero
      if (observation && /^job_output$/i.test(String(observation.name ?? '')) && !structuredError) {
        this.settleJob(observation.args?.job_id, text, triggers)
      }
      if (observation) {
        // Background handoff: the original call keeps running as a job, so its
        // outcome is still unknown — never 'ok', never a failed check.
        if (interrupted && !structuredError) {
          observation.status = 'running'
          observation.output = clip(text, 1200)
          observation.endedAt = event.time
          this.trackJobHandoff(observation, text)
          return
        }
        observation.status = isError ? 'error' : 'ok'
        observation.output = clip(text, 1200)
        observation.endedAt = event.time
        if (!isError) this.recordFiles(observation)
        if (!isError && observation.skill) {
          this.lastSkill = observation.skill
          this.loadedSkills.add(observation.skill)
          this.observedSkills.add(observation.skill)
          triggers.add('skill')
        }
        if (isCheckCommand(observation.command)) {
          const summary = oneLine(text, 400)
          this.checks.push({
            command: oneLine(observation.command, 240),
            callId,
            jobId: observation.jobId,
            cwd: observation.cwd ?? observation.scope?.cwd ?? this.cwd,
            scope: observation.scope,
            status: isError ? 'failed' : 'passed',
            summary,
            at: event.time,
            editRevision: observation.editRevision,
          })
          if (this.checks.length > 20) this.checks.shift()
          triggers.add('checked')
          if (!isError) {
            this.failureStreak = 0
            this.lastFailureKey = ''
          }
        }
      }
      if (isError) {
        const key = hash([observation?.name, clip(text, 400)])
        this.failureStreak = key === this.lastFailureKey ? this.failureStreak + 1 : 1
        this.lastFailureKey = key
        this.failures.push({ name: observation?.name ?? 'tool', summary: oneLine(text, 400), at: event.time, key })
        if (this.failures.length > 20) this.failures.shift()
        triggers.add('failed')
        if (this.failureStreak >= 2) triggers.add('stuck')
      }
      if (SUSPICIOUS.test(text)) triggers.add('untrusted')
    }
  }

  /**
   * Settle a background job from a `[status: …]` line (job_output result or the
   * host's completion notice). A terminal status settles the check the job came from.
   */
  settleJob(jobId, text, triggers) {
    if (!jobId || !this.jobs.has(String(jobId))) return undefined
    const line = /\[status:\s*([a-z]+)(?:,\s*([^\]]*))?\]\s*\.?\s*$/i.exec(String(text).trim())
      ?? /\[status:\s*([a-z]+)(?:,\s*([^\]]*))?\]/i.exec(String(text))
    const status = line?.[1]?.toLowerCase()
    if (!['completed', 'failed', 'killed'].includes(status)) return undefined
    const exit = /exit code:\s*(-?\d+)/i.exec(line[2] ?? '')
    const job = this.jobs.get(String(jobId))
    const outcome = this.jobFinished(jobId, { status, exitCode: exit ? Number(exit[1]) : undefined, text: oneLine(text, 600) })
    if (outcome && isCheckCommand(job.command)) {
      triggers.add('checked')
      if (outcome === 'failed') triggers.add('failed')
      else { this.failureStreak = 0; this.lastFailureKey = '' }
    }
    return outcome
  }

  /** A background-capable tool call whose arguments requested backgrounding. */
  trackJobStart(observation) {
    if (observation?.kind !== 'command') return
    const args = observation.args ?? {}
    const wantsBackground = args.run_in_background === true || args.background === true
      || (typeof args.run_in_background === 'string' && /^(true|1)$/i.test(args.run_in_background))
    if (wantsBackground) observation.status = 'running'
  }

  /** Parse the host's real handoff phrases and link the job back to the call. */
  trackJobHandoff(observation, text) {
    const started = /(?:started|moved to)\s+background job[:\s]+([\w-]+)|background job started[:\s]+([\w-]+)/i.exec(text)
    const jobId = started?.[1] ?? started?.[2]
    if (jobId && observation.callId) this.jobs.set(String(jobId), observation)
    if (jobId) observation.jobId = jobId
  }

  /**
   * A finished background job settles the check it originated from. `completed`
   * means the process ended — the parsed exit code decides pass or fail.
   */
  jobFinished(jobId, { status, exitCode, text = '' } = {}) {
    const observation = this.jobs.get(String(jobId))
    if (!observation) return undefined
    this.jobs.delete(String(jobId))
    const failed = status === 'failed' || (Number.isInteger(exitCode) ? exitCode !== 0 : status !== 'completed')
    observation.status = failed ? 'error' : 'ok'
    if (text) observation.output = clip(text, 1200)
    if (isCheckCommand(observation.command)) {
      const existing = this.checks.find((check) => check.jobId === String(jobId) && check.status !== 'passed')
      const summary = oneLine(text || `background job ${status} (exit ${exitCode ?? '?'})`, 400)
      if (existing) {
        existing.status = failed ? 'failed' : 'passed'
        existing.summary = summary
      } else {
        this.checks.push({
          command: oneLine(observation.command, 240),
          callId: observation.callId,
          jobId: String(jobId),
          cwd: observation.cwd ?? observation.scope?.cwd ?? this.cwd,
          scope: observation.scope,
          status: failed ? 'failed' : 'passed',
          summary,
          at: new Date().toISOString(),
          editRevision: observation.editRevision,
        })
        if (this.checks.length > 20) this.checks.shift()
      }
      return failed ? 'failed' : 'passed'
    }
    return failed ? 'failed' : 'passed'
  }

  /** Remember the files a successful read or edit touched. */
  recordFiles(observation) {
    const target = observation.kind === 'read' ? this.filesRead : observation.kind === 'edit' ? this.filesEdited : undefined
    if (!target) return
    if (observation.kind === 'edit') this.editRevision += 1
    for (const path of observation.paths ?? (observation.path ? [observation.path] : [])) target.add(path)
  }

  applyActionTriggers(action, triggers) {
    for (const trigger of actionTriggers(action, this.filesEdited.size)) triggers.add(trigger)
  }

  /** Mark an action the tool boundary already judged so the next pre-step does not repeat it. */
  consumeAction(callId) {
    if (callId) remember(this.consumedCalls, String(callId), MAX_CALL_IDS)
  }

  summary() {
    return {
      turn: this.turn,
      step: this.step,
      cwd: this.cwd,
      user: this.lastUser,
      assistant: this.lastAssistant,
      lastSkill: this.lastSkill,
      editRevision: this.editRevision,
      evidenceSeq: this.evidenceSeq,
      responseSeq: this.responseSeq,
      lastSeq: this.lastSeq,
      filesRead: [...this.filesRead].slice(-20),
      filesEdited: [...this.filesEdited].slice(-20),
      checks: this.checks.slice(-6).map((check) => ({ ...check })),
      failures: this.failures.slice(-4),
      failureStreak: this.failureStreak,
      recent: this.observations.slice(-8).map((item) => ({
        name: item.name,
        kind: item.kind,
        path: item.path,
        cwd: item.cwd,
        command: item.command ? oneLine(item.command, 200) : undefined,
        status: item.status,
        output: item.output ? oneLine(item.output, 300) : undefined,
      })),
    }
  }
}
