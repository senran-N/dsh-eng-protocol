import { extractJson, oneLine } from './text.js'

/** Combine caller cancellation with the configured timeout. */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(500, timeoutMs))
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Abort a streaming call that stops producing output: `firstMs` until its
 * first chunk (which covers queueing upstream), `idleMs` between chunks. A call
 * that keeps streaming is never cut by this; only the hard timeout bounds it.
 */
function silenceWatch(firstMs, idleMs) {
  if (!(firstMs > 0) && !(idleMs > 0)) return { signal: undefined, touch() {}, clear() {} }
  const controller = new AbortController()
  let timer
  const arm = (ms) => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new DOMException('模型长时间没有输出', 'TimeoutError')), ms)
    timer.unref?.()
  }
  arm(firstMs > 0 ? firstMs : idleMs)
  return { signal: controller.signal, touch: () => arm(idleMs > 0 ? idleMs : firstMs), clear: () => clearTimeout(timer) }
}

/** Host adapters should honour abort, but an uncooperative adapter must not stall a boundary. */
async function abortable(promise, signal) {
  signal.throwIfAborted()
  let onAbort
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('模型调用被取消'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([promise, cancelled]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

// Conventional effort order, least to most. Unknown ids sit in the middle.
const EFFORT_LADDER = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const effortRank = (id) => { const index = EFFORT_LADDER.indexOf(id); return index < 0 ? 4 : index }

/**
 * The effort to send for a requested one, given the model's declared efforts:
 * the requested id when offered, else the nearest offered one (ties go lower),
 * and nothing when the model has no selectable reasoning. `note` says what
 * changed, in words a person can read.
 */
export function fitReasoning(requested, info) {
  const offered = (info?.reasoning?.efforts ?? []).map((effort) => effort.id)
  const name = (id) => info?.reasoning?.efforts?.find((effort) => effort.id === id)?.name ?? id
  if (!requested) return { effort: undefined, offered }
  if (offered.length === 0) {
    return { effort: undefined, offered, note: requested === 'off' ? undefined : `这个模型没有思考强度可选，已按默认方式调用` }
  }
  if (offered.includes(requested)) return { effort: requested, offered }
  const target = effortRank(requested)
  const best = [...offered].sort((a, b) => Math.abs(effortRank(a) - target) - Math.abs(effortRank(b) - target) || effortRank(a) - effortRank(b))[0]
  return { effort: best, offered, note: `这个模型不支持“${requested}”，已改用最接近的“${name(best)}”` }
}

/** An error that keeps the host's machine-readable failure facts for retry decisions. */
function failureError(failure, fallback) {
  const error = new Error(failure?.message || fallback)
  if (failure?.code) error.code = failure.code
  if (failure?.status) error.status = failure.status
  if (failure?.providerRetryAfterMs) error.retryAfterMs = failure.providerRetryAfterMs
  return error
}

/**
 * One auxiliary model call through the host's LLM seam, returning the text and
 * whether the provider stopped at its output cap. The call is not part of the
 * main conversation; callers own its prompt and validate its JSON. `onDelta`
 * receives the answer text as it streams; `firstChunkTimeoutMs` and
 * `idleTimeoutMs` end a call that goes silent, below the hard `timeoutMs`.
 */
export async function streamModel(llm, route, options) {
  if (!llm || typeof llm.prepareCall !== 'function') throw new Error('DSH llm 服务不可用')
  if (!route?.provider || !route?.model) throw new Error('还没有可用的模型：请在“设置”里选择服务商和模型')
  const silence = silenceWatch(options.firstChunkTimeoutMs, options.idleTimeoutMs)
  const timed = withTimeout(options.signal, options.timeoutMs ?? 6000)
  const signal = silence.signal ? AbortSignal.any([timed, silence.signal]) : timed
  const timing = { started: performance.now(), outputChars: 0 }
  try {
    return await streamWith(llm, route, options, signal, silence, timing)
  } finally {
    silence.clear()
    const { started, ...measured } = timing
    const elapsed = performance.now() - started
    options.onTiming?.({ ...measured, modelMs: Math.round(elapsed),
      ...(timing.firstTextMs === undefined ? {} : { generationMs: Math.max(0, Math.round(elapsed - timing.firstTextMs)) }) })
  }
}

async function streamWith(llm, route, options, signal, silence, timing) {
  signal.throwIfAborted()
  // DSH validates the effort against the exact model and rejects anything it
  // does not list. Choose from what this model actually offers, using the
  // capability the host hands to `configure`, instead of sending a guess.
  const fit = { requested: options.reasoningEffort }
  const prepared = await abortable(llm.prepareCall({
    provider: route.provider,
    model: route.model,
    maxTokens: options.maxTokens ?? 1200,
    temperature: options.temperature ?? 0.1,
  }, signal, (controls, info) => {
    Object.assign(fit, fitReasoning(options.reasoningEffort, info))
    return fit.effort ? { ...controls, reasoningEffort: fit.effort } : controls
  }), signal)
  timing.prepareMs = Math.round(performance.now() - timing.started)
  options.onFit?.(fit)
  signal.throwIfAborted()
  // The pi-ai openai-completions adapter turns a top-level `system` string into
  // a message whose role is `developer` for reasoning models (it derives that
  // from the model catalog, not from us). Several OpenAI-compatible upstreams
  // reject `developer` with "Incorrect role information", so some routes need
  // the instructions folded into the first user message instead: that keeps the
  // wire request to roles the upstream certainly accepts.
  const fold = options.systemAsUser === true && typeof options.system === 'string' && options.system.trim() !== ''
  const prompt = fold ? `${options.system.trim()}\n\n${options.prompt}` : options.prompt
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  let text = ''
  let streamedBlock = ''
  const iterator = prepared.stream({
    ...prepared.config,
    messages,
    ...(fold ? {} : { system: options.system }),
    signal,
  })[Symbol.asyncIterator]()
  let complete = false
  let truncated = false
  try {
    while (true) {
      const next = await abortable(iterator.next(), signal)
      if (next.done) { complete = true; break }
      const chunk = next.value
      signal.throwIfAborted()
      timing.firstChunkMs ??= Math.round(performance.now() - timing.started)
      // Any chunk, reasoning included, shows the call is alive.
      silence.touch()
      if (chunk.type === 'text-delta') {
        if (chunk.text) timing.firstTextMs ??= Math.round(performance.now() - timing.started)
        text += chunk.text
        timing.outputChars = text.length
        streamedBlock += chunk.text
        options.onDelta?.(chunk.text)
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
        // Adapters may stream some blocks and emit other blocks only at end.
        // Complete a partial block without replaying deltas already delivered.
        const remainder = chunk.block.text.startsWith(streamedBlock) ? chunk.block.text.slice(streamedBlock.length) : ''
        if (remainder) {
          timing.firstTextMs ??= Math.round(performance.now() - timing.started)
          text += remainder; timing.outputChars = text.length; options.onDelta?.(remainder)
        }
        streamedBlock = ''
      } else if (chunk.type === 'finish') {
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          throw failureError(chunk.reason.failure, `模型调用${chunk.reason.kind === 'aborted' ? '被取消' : '失败'}`)
        }
        if (chunk.reason?.kind === 'max-tokens') truncated = true
      }
    }
  } catch (error) {
    // Keep complete assessments already streamed when the call hits its time
    // limit. User cancellation still wins at the decision boundary.
    if (error && typeof error === 'object') error.partial = partialJson(text)
    throw error
  } finally {
    // Do not await a stalled provider's cleanup after cancellation.
    if (!complete) void Promise.resolve().then(() => iterator.return?.()).catch(() => {})
  }
  signal.throwIfAborted()
  return { text: text.trim(), truncated }
}

/** One auxiliary model call; resolves with its text. */
export async function callModel(llm, route, options) {
  return (await streamModel(llm, route, options)).text
}

/** Text that opens a JSON object but never closes it reads as cut off mid-output. */
function looksCut(text) {
  const start = text.indexOf('{')
  if (start < 0) return false
  let depth = 0, quoted = false, escaped = false
  for (const ch of text.slice(start)) {
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = quoted; continue }
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '{') depth += 1
    else if (!quoted && ch === '}') depth -= 1
  }
  return depth > 0
}

/** Recover only complete top-level fields/array members from a cut JSON object.
 * Never close strings or synthesize missing values. Callers still validate each
 * recovered assessment and its citations exactly like a complete response.
 */
export function partialJson(text) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  const skip = at => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; return at }
  const endOf = at => {
    const stack = []
    let quoted = false, escaped = false
    for (let i = at; i < text.length; i++) {
      const ch = text[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') { quoted = false; if (!stack.length) return i + 1 }
      } else if (ch === '"') quoted = true
      else if (ch === '{' || ch === '[') stack.push(ch)
      else if (ch === '}' || ch === ']') {
        if (!stack.length) return i
        if (stack.pop() !== (ch === '}' ? '{' : '[')) return undefined
        if (!stack.length) return i + 1
      } else if (!stack.length && (ch === ',' || /\s/.test(ch))) return i
    }
    return undefined
  }
  const out = {}
  let at = skip(start + 1)
  while (at < text.length && text[at] === '"') {
    const keyEnd = endOf(at)
    if (!keyEnd) break
    let key
    try { key = JSON.parse(text.slice(at, keyEnd)) } catch { break }
    at = skip(keyEnd)
    if (text[at] !== ':') break
    at = skip(at + 1)
    if (['cards', 'assessments', 'relations'].includes(key) && text[at] === '[') {
      const items = []
      at = skip(at + 1)
      while (text[at] !== ']' && at < text.length) {
        const end = endOf(at)
        if (!end) break
        try { items.push(JSON.parse(text.slice(at, end))) } catch { break }
        at = skip(end)
        if (text[at] !== ',') break
        at = skip(at + 1)
      }
      out[key] = items
      if (text[at] !== ']') break
      at++
    } else {
      const end = endOf(at)
      if (!end) break
      try { if (key === 'task') out.task = JSON.parse(text.slice(at, end)) } catch { break }
      at = end
    }
    at = skip(at)
    if (text[at] !== ',') break
    at = skip(at + 1)
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Call the model and parse one JSON object. Output stopped at the token cap (or
 * an object that never closes) throws a `truncated` error so callers can split
 * the work instead of retrying the same oversized request.
 */
export async function callJson(llm, route, options) {
  const { text, truncated } = await streamModel(llm, route, options)
  const value = extractJson(text)
  if (value === undefined || (truncated && looksCut(text))) {
    const cut = truncated || looksCut(text)
    const error = new Error(cut
      ? `模型输出在上限处被截断（${text.length} 字符）`
      : `模型没有返回合法 JSON：${oneLine(text, 240) || '（空响应）'}`)
    if (cut) { error.code = 'MAX_TOKENS'; error.truncated = true; error.partial = partialJson(text) }
    else error.kind = 'bad-output'
    throw error
  }
  return value
}
