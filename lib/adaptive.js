import { errorMessage } from './text.js'

/**
 * Adaptive control for every auxiliary model call. Nothing here is a budget the
 * operator has to tune: concurrency, timeouts, output size, judge batch size and
 * compile chunk size all start from a safe point and follow what the route
 * actually does — they shrink on overload or truncation and grow back on success.
 * The only fixed numbers are safety rails (a hard timeout ceiling, a minimum
 * chunk) that keep a misbehaving provider from hanging or looping forever.
 */

const RETRYABLE = new Set(['timeout', 'rate-limit', 'overloaded', 'server', 'network', 'bad-output', 'output-limit', 'unknown'])

const HINTS = {
  timeout: '模型回答得太慢，稍后会自动再试。一直这样的话，可以换一个更快的模型。',
  'rate-limit': '模型服务暂时限流，稍后会自动再试，不用处理。',
  overloaded: '模型服务暂时太忙，稍后会自动再试，不用处理。',
  server: '模型服务出错了，稍后会自动再试。',
  network: '连不上模型服务，网络恢复后会自动再试。',
  auth: 'API key 无效或没有权限。请在 DSH 里检查这个模型的 key，改好后点“重试”。',
  model: '找不到这个模型。请在“设置”里检查服务商和模型名称。',
  role: '这个模型服务不接受当前的系统指令格式。请在“设置”里打开“把系统指令并入用户消息”。',
  'output-limit': '模型一次写不了这么多，已经自动调整后再试。',
  truncated: '内容太长，模型一次写不完，已经自动分成小块重新处理。',
  'bad-output': '模型回复的格式不对，会自动再试。',
  effort: '这个模型不支持所选的思考强度，请在“设置”里换一档。',
  config: '还没有可用的模型。请在“设置”里填写模型，或让主对话带着模型启动。',
  aborted: '已取消。',
  unknown: '出了点意外，会自动再试；仍然失败可以展开查看详细错误。',
}

/** What kind of failure this is, whether retrying can help, and what to tell the operator. */
export function classifyError(error) {
  const failure = error?.failure ?? {}
  const code = String(error?.code ?? failure.code ?? '')
  const status = Number(error?.status ?? failure.status) || undefined
  const retryAfterMs = Number(error?.retryAfterMs ?? failure.providerRetryAfterMs) || undefined
  const message = errorMessage(error)
  const text = `${code} ${message}`.toLowerCase()
  let kind = 'unknown'
  if (error?.kind && HINTS[error.kind]) kind = error.kind
  else if (code === 'MAX_TOKENS' || error?.truncated === true) kind = 'truncated'
  else if (code === 'UNSUPPORTED_REASONING_EFFORT' || /does not support reasoning effort/.test(text)) kind = 'effort'
  else if (error?.name === 'TimeoutError' || /timeout|timed out|etimedout|deadline/.test(text)) kind = 'timeout'
  else if (status === 429 || code === 'RATE_LIMIT' || /rate.?limit|too many requests|\b429\b/.test(text)) kind = 'rate-limit'
  else if (status === 401 || status === 403 || code === 'AUTH' || /unauthori[sz]ed|forbidden|api.?key|invalid.*(key|token)|permission denied/.test(text)) kind = 'auth'
  else if (/incorrect role information|developer role|role.*developer/.test(text)) kind = 'role'
  else if (/max_tokens|max tokens|maximum.*(output|completion).*tokens|max_completion_tokens/.test(text) && (status === 400 || status === undefined)) kind = 'output-limit'
  else if (code === 'NO_ADAPTER' || status === 404 || /model.*(not found|does not exist|unknown)|unknown model|no adapter/.test(text)) kind = 'model'
  else if (status === 503 || status === 529 || code === 'OVERLOADED' || /overload|capacity|unavailable/.test(text)) kind = 'overloaded'
  else if ((status && status >= 500) || code === 'SERVER') kind = 'server'
  else if (/econnreset|econnrefused|enotfound|eai_again|socket hang up|network|fetch failed|connection/.test(text)) kind = 'network'
  else if (/未配置|不可用|没有可用的/.test(message)) kind = 'config'
  else if (/json|编译结果|入口卡|缺少/.test(text)) kind = 'bad-output'
  else if (error?.name === 'AbortError') kind = 'aborted'
  return { kind, retryable: RETRYABLE.has(kind), status, code: code || undefined, retryAfterMs, hint: HINTS[kind], message }
}

/** Plain-language hint for a failure kind. */
export function errorHint(kind) {
  return HINTS[kind] ?? HINTS.unknown
}

/** Sleep that rejects on abort. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
    const timer = setTimeout(done, Math.max(0, ms))
    timer.unref?.()
    function done() { signal?.removeEventListener('abort', stop); resolve() }
    function stop() { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')) }
    signal?.addEventListener('abort', stop, { once: true })
  })
}

/** Base delay for retries; tests shorten it through the environment. */
export function retryBaseMs() {
  const value = Number(process.env.ENG_PROTOCOL_RETRY_BASE_MS)
  return Number.isFinite(value) && value >= 0 ? value : 1000
}

/**
 * Run `task(attempt)` with exponential backoff and jitter for transient
 * failures. Permanent failures (bad credentials, unknown model) and caller
 * cancellation fail at once. The thrown error carries `classified` and `attempts`.
 */
export async function withRetry(task, { signal, attempts = 4, baseMs = retryBaseMs(), maxDelayMs = 30_000, onRetry, retryable = (info) => info.retryable } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task(attempt)
    } catch (error) {
      if (signal?.aborted) throw error
      const info = classifyError(error)
      if (error && typeof error === 'object') {
        error.classified = info
        error.attempts = attempt
      }
      if (attempt >= attempts || !retryable(info)) throw error
      const backoff = Math.min(maxDelayMs, baseMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5)
      const delayMs = Math.round(Math.max(info.retryAfterMs ?? 0, backoff))
      onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error, info })
      await sleep(delayMs, signal)
    }
  }
}

/**
 * AIMD concurrency limiter: additive increase after a window of successes,
 * multiplicative decrease on overload, and an optional pause honouring a
 * provider's Retry-After. Waiters are served in FIFO order and leave on abort.
 */
export class AdaptiveLimiter {
  constructor({ initial = 2, min = 1, max = 8 } = {}) {
    this.limit = initial
    this.min = min
    this.max = max
    this.active = 0
    this.waiters = []
    this.successes = 0
    this.pausedUntil = 0
    this.timer = undefined
  }

  get capacity() { return Math.max(this.min, Math.floor(this.limit)) }

  pump() {
    const wait = this.pausedUntil - Date.now()
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; this.pump() }, wait)
        this.timer.unref?.()
      }
      return
    }
    while (this.waiters.length > 0 && this.active < this.capacity) {
      const waiter = this.waiters.shift()
      waiter.signal?.removeEventListener('abort', waiter.onAbort)
      this.active += 1
      waiter.resolve(performance.now() - waiter.at)
    }
  }

  /** Resolve with the milliseconds spent waiting for a slot. */
  acquire(signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
      const waiter = { resolve, signal, at: performance.now() }
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(signal.reason ?? new Error('aborted'))
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      this.waiters.push(waiter)
      this.pump()
    })
  }

  release() {
    this.active = Math.max(0, this.active - 1)
    this.pump()
  }

  /** Run `task(waitMs)` inside one slot. */
  async run(task, signal) {
    const waited = await this.acquire(signal)
    try { return await task(waited) } finally { this.release() }
  }

  succeed() {
    this.successes += 1
    if (this.successes >= this.capacity) {
      this.successes = 0
      if (this.limit < this.max) { this.limit = Math.min(this.max, this.limit + 1); this.pump() }
    }
  }

  overload(retryAfterMs) {
    this.successes = 0
    this.limit = Math.max(this.min, this.limit / 2)
    if (retryAfterMs > 0) this.pausedUntil = Math.max(this.pausedUntil, Date.now() + retryAfterMs)
  }

  snapshot() {
    return { limit: this.capacity, active: this.active, queued: this.waiters.length, pausedMs: Math.max(0, this.pausedUntil - Date.now()) }
  }
}

/** Rolling latency window that turns observed durations into a timeout. */
export class LatencyTracker {
  constructor(window = 40) {
    this.window = window
    this.samples = []
  }

  record(ms) {
    if (!Number.isFinite(ms) || ms < 0) return
    this.samples.push(ms)
    if (this.samples.length > this.window) this.samples.shift()
  }

  quantile(q) {
    if (this.samples.length === 0) return undefined
    const sorted = [...this.samples].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  }

  /**
   * Twice the observed p95 plus slack, never below `floor` nor above the hard
   * `ceiling`. Until enough samples exist the ceiling applies. A timed-out call
   * is recorded at its full duration, so the estimate widens by itself.
   */
  timeout(ceiling, { floor = 3000, minSamples = 4 } = {}) {
    if (this.samples.length < minSamples) return ceiling
    return Math.round(Math.min(ceiling, Math.max(floor, this.quantile(0.95) * 2 + 1500)))
  }

  snapshot() {
    return { samples: this.samples.length, p50: this.quantile(0.5), p95: this.quantile(0.95) }
  }
}

/**
 * A size that halves when the model cannot handle it and creeps back after a
 * streak of successes: judge cards per call, compile characters per part, and
 * the output-token ceiling a route accepts.
 */
export class AdaptiveSize {
  constructor({ initial, min, max, growAfter = 6, growBy = 1.25 }) {
    this.value = initial
    this.min = min
    this.max = max
    this.growAfter = growAfter
    this.growBy = growBy
    this.streak = 0
    this.shrinks = 0
  }

  get current() { return Math.max(this.min, Math.min(this.max, Math.floor(this.value))) }

  /** Shrink below the size that just failed. */
  shrink(failedAt = this.current) {
    this.streak = 0
    this.shrinks += 1
    this.value = Math.max(this.min, Math.floor(Math.min(this.value, failedAt) / 2))
  }

  grow() {
    this.streak += 1
    if (this.streak >= this.growAfter) {
      this.streak = 0
      this.value = Math.min(this.max, Math.ceil(this.value * this.growBy))
    }
  }

  snapshot() { return { current: this.current, shrinks: this.shrinks } }
}

/** All adaptive state for one model route and purpose. */
function createControl(purpose) {
  const judge = purpose === 'judge'
  return {
    limiter: new AdaptiveLimiter(judge ? { initial: 4, min: 1, max: 12 } : { initial: 2, min: 1, max: 8 }),
    latency: new LatencyTracker(),
    output: new AdaptiveSize({ initial: 8192, min: 512, max: 32768, growAfter: 1000 }),
    size: judge
      ? new AdaptiveSize({ initial: 24, min: 1, max: 64, growAfter: 8 })
      : new AdaptiveSize({ initial: 24000, min: 1500, max: 60000, growAfter: 6 }),
    calls: 0,
    failures: 0,
    lastError: undefined,
  }
}

/** Per-route registry; changing the model route starts that route from scratch. */
export class AdaptiveRegistry {
  constructor() {
    this.controls = new Map()
  }

  for(purpose, route) {
    const key = `${purpose}:${route?.provider ?? '?'}/${route?.model ?? '?'}`
    let control = this.controls.get(key)
    if (!control) {
      control = createControl(purpose)
      control.key = key
      control.purpose = purpose
      control.route = route ? `${route.provider}/${route.model}` : undefined
      this.controls.set(key, control)
    }
    return control
  }

  /** Record one finished call's outcome on its control. */
  static observe(control, { ms, error } = {}) {
    control.calls += 1
    if (!error) {
      control.limiter.succeed()
      control.latency.record(ms)
      return
    }
    control.failures += 1
    const info = error.classified ?? classifyError(error)
    control.lastError = { kind: info.kind, message: info.message, at: new Date().toISOString() }
    if (info.kind === 'rate-limit' || info.kind === 'overloaded') control.limiter.overload(info.retryAfterMs)
    if (info.kind === 'timeout') control.latency.record(ms)
    if (info.kind === 'output-limit') control.output.shrink()
  }

  snapshot() {
    return [...this.controls.values()].map((control) => ({
      purpose: control.purpose,
      route: control.route,
      concurrency: control.limiter.snapshot(),
      latency: control.latency.snapshot(),
      outputTokens: control.output.current,
      size: control.size.snapshot(),
      calls: control.calls,
      failures: control.failures,
      lastError: control.lastError,
      effort: control.effort ? { requested: control.effort.requested, used: control.effort.effort, note: control.effort.note } : undefined,
    }))
  }
}
