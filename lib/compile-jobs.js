import { AdaptiveLimiter, AdaptiveSize, OVERLOAD_KINDS, classifyError, retryBaseMs, withRetry } from './adaptive.js'
import { EXTRACT_VERSION, extractPart } from './extract.js'
import { normalizeSkill } from './skill-graph.js'
import { parseSkillSource, statementsOf } from './skill-source.js'
import { errorMessage, hash, nowIso } from './text.js'

/**
 * Compile jobs shared by every agent of one plugin instance.
 *
 * A skill compiles part by part. A part is identified by the extraction
 * contract and its own text, so skills (or versions of one skill) that share a
 * section share its compile, and a stored answer is reused wherever that text
 * appears again. Parts run on one lane per model route: skills an agent uses go
 * first, concurrency grows while work queues and halves when the route is
 * congested, and a provider's Retry-After is honoured. Every finished part adds
 * its obligations at once to each skill that contains it.
 *
 * A part that fails is retried in the background (sooner as soon as the route
 * answers again) for as long as some agent wants a skill that contains it. A
 * failure that retrying cannot fix, such as bad credentials or an unknown
 * model, waits for an explicit retry.
 */

// Background retry of a failed part: short at first, never longer than five
// minutes. A provider's Retry-After is honoured on top of this.
const RETRY_STEPS_MS = [10_000, 30_000, 90_000, 300_000]
// How long a streaming compile may stay silent: before its first output (which
// includes waiting upstream), and between chunks once it streams.
const FIRST_OUTPUT_MS = 90_000
const SILENCE_MS = 45_000
// Attempts in one run before a part counts as failed; a silent model gets two.
const ATTEMPTS = 3
const SILENT_ATTEMPTS = 2

/** What an owner wants a skill for: an agent using it outranks a person preparing it. */
export const PRIORITY = { use: 2, prepare: 1 }

/** Identity of one part's compile: the extraction contract and the part's own text, nothing else. */
export function partKey(part, version = EXTRACT_VERSION) {
  return hash(['part', version, part.content])
}

/** Identity of one skill's compile: the skill's name, file and body. */
export function skillKey(source, content) {
  return hash(['skill', EXTRACT_VERSION, source.name, source.path ?? '', content])
}

/** The skill (by name and file) whose previous complete compile guards while a newer text compiles. */
export function skillIdentity(source) {
  return hash([source.name, source.path ?? ''])
}

const routeName = (route) => (route ? `${route.provider}/${route.model}` : undefined)
const BUSY = new Set(['loading', 'queued', 'running'])

export class CompileJobs {
  /**
   * @param store `{ loadPart, savePart, loadSkillRecord, saveSkillRecord, loadLatest, saveLatest }`, keyed as above.
   * @param llm returns the host's model service.
   * @param onUpdate `(job, event)` after a job changed: `started`, `progress`, `part`, `failed` or `complete`.
   */
  constructor({ store, llm, onUpdate }) {
    this.store = store
    this.llm = llm
    this.onUpdate = onUpdate
    this.skills = new Map()
    this.tasks = new Map()
    this.lanes = new Map()
    this.timer = undefined
    this.stopped = false
    // Stored answers and records still being written; `settled` waits for them.
    this.writes = new Set()
    // What the last compile call actually sent, e.g. a reasoning effort fitted to the model.
    this.fit = undefined
  }

  /** Write in the background: a failed write costs a recompile later, never this result. */
  persist(write) {
    const pending = Promise.resolve().then(write).catch(() => undefined)
    this.writes.add(pending)
    pending.finally(() => this.writes.delete(pending))
  }

  /** The shared compile of one skill source (throws for an empty body). */
  job(source, { route, config }) {
    const document = parseSkillSource(source)
    const key = skillKey(source, document.content)
    let job = this.skills.get(key)
    if (!job) {
      job = {
        key, name: source.name, source, document, route, config,
        owners: new Map(), parts: [], result: undefined,
        complete: false, worked: false, startedAt: undefined, runStartedAt: undefined, finishedAt: undefined, durationMs: undefined,
      }
      job.parts = document.parts.map((part) => {
        const statements = statementsOf(document, part)
        const task = this.task(partKey(part), route)
        task.jobs.add(job)
        return { part, statements, task }
      })
      this.skills.set(key, job)
      this.refresh(job)
    }
    // Settings may have changed since: parts still to run use the current route and options.
    job.source = source
    job.config = config
    job.route = route
    for (const { task } of job.parts) if (!['running', 'done'].includes(task.state)) task.route = route
    return job
  }

  task(key, route) {
    let task = this.tasks.get(key)
    if (task) return task
    task = {
      key, route, state: 'loading', jobs: new Set(), records: undefined, found: 0,
      failures: 0, error: undefined, note: undefined, permanent: false, nextRetryAt: undefined, notBefore: 0, retryReason: undefined,
      controller: undefined, promise: undefined, fresh: false,
    }
    this.tasks.set(key, task)
    task.promise = this.store.loadPart(key).catch(() => undefined).then((stored) => {
      if (task.state !== 'loading') return
      if (stored) task.records = { obligations: stored.obligations, relations: stored.relations }
      task.state = stored && !task.fresh ? 'done' : 'idle'
      this.schedule(task)
      this.settle(task, 'part')
    })
    return task
  }

  /** An owner (an agent's view) wants this skill compiled. */
  want(job, owner, priority = PRIORITY.use) {
    job.owners.set(owner, Math.max(job.owners.get(owner) ?? 0, priority))
    job.startedAt ??= nowIso()
    for (const { task } of job.parts) this.schedule(task)
    this.arm()
  }

  /** An owner no longer needs this skill. Waiting parts nobody needs leave the queue; running ones finish and are kept. */
  release(job, owner) {
    if (!job.owners.delete(owner)) return
    for (const { task } of job.parts) {
      if (task.state === 'queued' && this.priority(task) <= 0) task.controller?.abort(new Error('没有会话再需要这个 skill'))
    }
    if (job.owners.size === 0) {
      this.skills.delete(job.key)
      for (const { task } of job.parts) {
        task.jobs.delete(job)
        if (task.jobs.size === 0 && !BUSY.has(task.state)) this.tasks.delete(task.key)
      }
    }
    this.arm()
  }

  /** Retry this skill's failed parts now; a provider's Retry-After still holds. */
  retry(job) {
    for (const { task } of job.parts) {
      if (task.state !== 'failed') continue
      task.permanent = false
      task.nextRetryAt = new Date(Math.max(Date.now(), task.notBefore ?? 0)).toISOString()
      this.schedule(task)
    }
    this.arm()
  }

  /** Compile every part of this skill again. Their current answers keep guarding until the new ones arrive. */
  rebuild(job) {
    job.complete = false
    job.worked = false
    job.runStartedAt = undefined
    job.finishedAt = undefined
    job.durationMs = undefined
    for (const { task } of job.parts) {
      if (task.state === 'running' || task.state === 'queued') continue
      if (task.state === 'loading') { task.fresh = true; continue }
      task.state = 'idle'
      task.permanent = false
      task.failures = 0
      task.error = undefined
      task.note = undefined
      this.schedule(task)
    }
    this.refresh(job)
    this.onUpdate?.(job, 'progress')
  }

  /** Whether none of the job's parts is loading, queued or running. */
  idle(job) {
    return job.parts.every(({ task }) => !BUSY.has(task.state))
  }

  /** Resolves once none of the job's parts is loading, queued or running, and what they produced is stored. */
  async settled(job) {
    for (;;) {
      const busy = job.parts.map(({ task }) => task).filter((task) => BUSY.has(task.state))
      if (busy.length === 0) break
      await Promise.allSettled(busy.map((task) => task.promise))
    }
    while (this.writes.size > 0) await Promise.allSettled([...this.writes])
  }

  /** The compile of a skill's previous text, rebuilt from its stored parts; undefined when there is none. */
  async previous(source, current) {
    const key = await this.store.loadLatest(skillIdentity(source)).catch(() => undefined)
    if (!key || key === current) return undefined
    const record = await this.store.loadSkillRecord(key).catch(() => undefined)
    if (!record || record.name !== source.name) return undefined
    const document = parseSkillSource(record)
    const parts = []
    for (const part of document.parts) {
      const key = partKey(part, record.extract ?? 1)
      const records = this.tasks.get(key)?.records ?? await this.store.loadPart(key).catch(() => undefined)
      if (!records) return undefined
      parts.push({ part, statements: statementsOf(document, part), records })
    }
    return { ...normalizeSkill({ ...source, content: record.content }, document, parts), compiledAt: record.compiledAt }
  }

  /** What one job looks like now, for the panel and `/protocol skills`. */
  status(job) {
    const tasks = job.parts.map(({ task }) => task)
    const total = job.document.content.length
    const done = job.parts.reduce((sum, { part, task }) => sum + (task.state === 'done' ? part.end - part.start : 0), 0)
    const failed = tasks.filter((task) => task.state === 'failed')
    const permanent = failed.find((task) => task.permanent)
    const state = tasks.every((task) => task.state === 'done') ? 'ready'
      : permanent ? 'failed'
        : failed.length > 0 ? 'retrying'
          : tasks.some((task) => task.state === 'running') ? 'compiling' : 'queued'
    const problem = (permanent ?? failed[0])?.error ?? tasks.find((task) => task.note)?.note
    const waiting = failed.filter((task) => !task.permanent && task.nextRetryAt).sort((a, b) => a.nextRetryAt.localeCompare(b.nextRetryAt))[0]
    return {
      state,
      progress: total > 0 ? done / total : 1,
      rules: job.result?.cards.length ?? 0,
      found: tasks.reduce((sum, task) => sum + (task.state === 'running' ? task.found : 0), 0),
      dropped: job.result?.coverage.dropped ?? 0,
      ...(problem ? { kind: problem.kind, hint: problem.hint, error: problem.message } : {}),
      ...(problem && state === 'ready' ? { kept: true } : {}),
      ...(waiting ? { nextRetryAt: waiting.nextRetryAt, retryReason: waiting.retryReason } : {}),
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
    }
  }

  /** Plugin teardown: nothing runs or fires after this. Resolves once pending writes are done. */
  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    for (const task of this.tasks.values()) task.controller?.abort(new Error('插件已停止'))
    while (this.writes.size > 0) await Promise.allSettled([...this.writes])
  }

  // ---- internals ---------------------------------------------------------

  priority(task) {
    let best = 0
    for (const job of task.jobs) for (const value of job.owners.values()) best = Math.max(best, value)
    return best
  }

  lane(route) {
    const key = routeName(route) ?? '?'
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = {
        // Never fewer than two at once: one stalled call must not hold up every other compile.
        limiter: new AdaptiveLimiter({ initial: 4, min: 2, max: 64, slowStart: true }),
        output: new AdaptiveSize({ initial: 8192, min: 1024, max: 32768, growAfter: 1000 }),
      }
      this.lanes.set(key, lane)
    }
    return lane
  }

  schedule(task) {
    if (this.stopped || this.priority(task) <= 0) return
    const due = task.state === 'failed' && !task.permanent && Date.parse(task.nextRetryAt) <= Date.now()
    if (task.state !== 'idle' && !due) return
    task.state = 'queued'
    task.found = 0
    const controller = new AbortController()
    task.controller = controller
    task.promise = this.attempt(task, controller.signal)
      .finally(() => { if (task.controller === controller) task.controller = undefined })
  }

  async attempt(task, signal) {
    const lane = this.lane(task.route)
    let silent = 0
    try {
      const llm = this.llm()
      if (!llm || !task.route) throw Object.assign(new Error('还没有可用的模型来编译 skill'), { kind: 'config' })
      const answer = await withRetry(() => lane.limiter.run(async () => {
        // Any skill containing this part can describe it; the most wanted one does.
        const origin = [...task.jobs].sort((a, b) => Math.max(0, ...b.owners.values()) - Math.max(0, ...a.owners.values()))[0]
        if (!origin) throw Object.assign(new Error('没有会话再需要这个 skill'), { kind: 'aborted' })
        const { part, statements } = origin.parts.find((entry) => entry.task === task)
        const options = origin.config.compiler
        task.state = 'running'
        task.found = 0
        this.started(task)
        const epoch = lane.limiter.epoch
        try {
          const value = await extractPart(llm, task.route, { skill: origin.source, document: origin.document, part, statements, total: origin.parts.length }, {
            signal,
            maxTokens: lane.output.current,
            temperature: options.temperature,
            reasoningEffort: options.reasoningEffort,
            systemAsUser: options.systemAsUser,
            timeoutMs: options.timeoutMs,
            firstChunkTimeoutMs: Math.min(options.timeoutMs, FIRST_OUTPUT_MS),
            idleTimeoutMs: Math.min(options.timeoutMs, SILENCE_MS),
            onFit: (fit) => { this.fit = fit },
            onFound: (count) => { task.found = count; this.progress(task) },
          })
          lane.limiter.succeed(epoch)
          return value
        } catch (error) {
          if (!signal.aborted) {
            const info = classifyError(error)
            if (OVERLOAD_KINDS.has(info.kind)) lane.limiter.overload(info.retryAfterMs, epoch)
            if (info.kind === 'output-limit') lane.output.shrink()
          }
          throw error
        }
      }, signal, this.priority(task)), {
        signal,
        attempts: ATTEMPTS,
        retryable: (info) => info.retryable && !(info.kind === 'timeout' && ++silent >= SILENT_ATTEMPTS),
        onRetry: () => { task.state = 'queued'; task.found = 0; this.progress(task) },
      })
      signal.throwIfAborted()
      task.records = { obligations: answer.obligations, relations: answer.relations }
      task.state = 'done'
      task.failures = 0
      task.error = undefined
      task.note = undefined
      task.permanent = false
      task.nextRetryAt = undefined
      task.fresh = false
      const stored = { extract: EXTRACT_VERSION, route: routeName(task.route), ...task.records }
      this.persist(() => this.store.savePart(task.key, stored))
      this.recover(task.route)
      this.settle(task, 'part')
    } catch (error) {
      if (signal.aborted) {
        // Nobody needs it now (or the plugin stopped): it can run again when wanted.
        task.state = task.records ? 'done' : 'idle'
        this.settle(task, 'progress')
        return
      }
      this.fail(task, error)
    }
  }

  fail(task, error) {
    const info = error?.classified ?? classifyError(error)
    const failure = { kind: info.kind, hint: info.hint, message: info.message || errorMessage(error) }
    if (task.records) {
      // A rebuild that failed keeps the part's previous answer and says why.
      task.state = 'done'
      task.note = failure
      this.settle(task, 'failed')
      return
    }
    task.failures += 1
    task.error = failure
    task.permanent = !info.retryable
    task.state = 'failed'
    if (task.permanent) task.nextRetryAt = undefined
    else {
      const now = Date.now()
      task.notBefore = Math.max(now + (info.retryAfterMs ?? 0), this.lane(task.route).limiter.pausedUntil)
      // Scaled with the retry base, which tests shorten through the environment.
      const step = RETRY_STEPS_MS[Math.min(RETRY_STEPS_MS.length - 1, task.failures - 1)] * retryBaseMs() / 1000
      task.nextRetryAt = new Date(Math.max(task.notBefore, now + step)).toISOString()
      task.retryReason = task.notBefore > now ? 'provider' : 'backoff'
    }
    this.settle(task, 'failed')
    this.arm()
  }

  /** The route answered: its waiting failures may try again now, unless the provider asked for longer. */
  recover(route) {
    const name = routeName(route)
    let changed = false
    for (const task of this.tasks.values()) {
      if (task.state !== 'failed' || task.permanent || routeName(task.route) !== name) continue
      const next = Math.max(Date.now(), task.notBefore ?? 0)
      if (next >= Date.parse(task.nextRetryAt)) continue
      task.nextRetryAt = new Date(next).toISOString()
      task.retryReason = next > Date.now() ? 'provider' : 'recovery'
      changed = true
    }
    if (changed) this.arm()
  }

  /** One timer for the earliest background retry still wanted. */
  arm() {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.stopped) return
    let due = Infinity
    for (const task of this.tasks.values()) {
      if (task.state === 'failed' && !task.permanent && this.priority(task) > 0) due = Math.min(due, Date.parse(task.nextRetryAt))
    }
    if (!Number.isFinite(due)) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      for (const task of [...this.tasks.values()]) this.schedule(task)
      this.arm()
    }, Math.max(0, due - Date.now()))
    this.timer.unref?.()
  }

  started(task) {
    for (const job of task.jobs) {
      if (job.worked) continue
      job.worked = true
      job.runStartedAt = Date.now()
      this.onUpdate?.(job, 'started')
    }
    this.progress(task)
  }

  progress(task) {
    for (const job of task.jobs) this.onUpdate?.(job, 'progress')
  }

  settle(task, event) {
    for (const job of [...task.jobs]) {
      const completed = this.refresh(job)
      // A failed rebuild that kept its answer completes the job too: the failure is told first.
      if (event === 'failed' || !completed) this.onUpdate?.(job, event)
      if (completed) this.onUpdate?.(job, 'complete')
    }
    if (task.jobs.size === 0 && !BUSY.has(task.state)) this.tasks.delete(task.key)
  }

  /** Rebuild a job's cards from the answers it has; returns true when it just became complete. */
  refresh(job) {
    job.result = normalizeSkill(job.source, job.document, job.parts.map(({ part, statements, task }) => ({ part, statements, records: task.records })))
    const complete = job.parts.every(({ task }) => task.state === 'done')
    if (!complete) { job.complete = false; return false }
    if (job.complete) return false
    job.complete = true
    job.finishedAt = nowIso()
    job.durationMs = job.runStartedAt ? Date.now() - job.runStartedAt : undefined
    // Remember this text as the skill's newest complete compile, for guarding while a later edit compiles.
    const identity = skillIdentity(job.source)
    const record = { name: job.name, path: job.source.path, content: job.document.content, extract: EXTRACT_VERSION, compiledAt: job.finishedAt }
    this.persist(async () => {
      if (!job.worked && await this.store.loadLatest(identity) === job.key) return
      await this.store.saveSkillRecord(job.key, record)
      await this.store.saveLatest(identity, job.key)
    })
    return true
  }
}
