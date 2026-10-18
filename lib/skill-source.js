export const DEFAULT_PART_CHARS = 24000

/** The host has already parsed frontmatter. Index its Markdown body without executing references. */
export function parseSkillSource(skill, maxChars = DEFAULT_PART_CHARS) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars 必须是正整数')
  const content = String(skill.content ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!content.trim()) throw new Error(`skill ${skill.name} 正文为空`)
  const lines = content.split('\n')
  const headings = []
  const references = []
  let fence
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], size: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) fence = undefined
      continue
    }
    if (fence) continue
    const atx = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    const setext = index > 0 && lines[index - 1].trim() && /^ {0,3}(=+|-+)\s*$/.exec(line)
    if (atx) headings.push({ line: index + 1, level: atx[1].length, title: atx[2] })
    else if (setext) headings.push({ line: index, level: setext[1][0] === '=' ? 1 : 2, title: lines[index - 1].trim() })
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      references.push({ target: match[1], line: index + 1 })
    }
  }
  // Every character is sent, including a very long line. Prefer heading/line boundaries.
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) if (content[index] === '\n') starts.push(index + 1)
  const headingOffsets = headings.map((item) => starts[item.line - 1])
  const lineAt = (offset) => {
    let low = 0, high = starts.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (starts[mid] <= offset) low = mid + 1
      else high = mid
    }
    return low
  }
  /** One part of the body by character offsets, with its line coordinates. */
  const chunkAt = (offset, end) => {
    const startLine = lineAt(offset), endLine = lineAt(end - 1)
    return {
      content: content.slice(offset, end), startLine, endLine,
      startOffset: offset, endOffset: end,
      startColumn: offset - starts[startLine - 1] + 1,
      endColumn: end - starts[endLine - 1],
      partialStart: offset > starts[startLine - 1],
      partialEnd: end < content.length && content[end - 1] !== '\n',
    }
  }
  /** A cut at most `limit` characters after `offset`: a heading late in the window, else a line end. */
  const boundary = (offset, limit) => {
    let end = Math.min(content.length, offset + limit)
    if (end < content.length) {
      const heading = headingOffsets.findLast((at) => at > offset + limit / 2 && at <= end)
      const newline = content.lastIndexOf('\n', end - 1) + 1
      if (heading) end = heading
      else if (newline > offset) end = newline
    }
    return end
  }
  /**
   * Cover the whole body with parts of at most `limit` characters. Ranges that
   * a previous run already compiled (`saved`, as [start, end] offsets) are kept
   * verbatim, so an interrupted compile resumes on exactly the same parts even
   * after the adaptive part size changed.
   */
  const plan = (limit, saved = []) => {
    const ranges = saved
      .filter((range) => Array.isArray(range) && Number.isInteger(range[0]) && Number.isInteger(range[1])
        && range[0] >= 0 && range[1] > range[0] && range[1] <= content.length)
      .sort((a, b) => a[0] - b[0])
    const chunks = []
    for (let offset = 0; offset < content.length;) {
      const hit = ranges.find((range) => range[0] === offset)
      if (hit) { chunks.push(chunkAt(hit[0], hit[1])); offset = hit[1]; continue }
      const next = ranges.find((range) => range[0] > offset)?.[0] ?? content.length
      const end = Math.min(next, boundary(offset, limit))
      chunks.push(chunkAt(offset, end))
      offset = end
    }
    return chunks
  }
  /** Halve one part: the heading nearest its middle, else the nearest line end, else the middle character. */
  const split = (chunk) => {
    const { startOffset: from, endOffset: to } = chunk
    if (to - from < 2) return [chunk]
    const middle = from + Math.floor((to - from) / 2)
    const near = (candidates) => candidates.filter((at) => at > from && at < to)
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0]
    const window = (to - from) / 4
    const heading = near(headingOffsets.filter((at) => Math.abs(at - middle) <= window))
    const lineStarts = []
    for (let line = lineAt(from); line < starts.length && starts[line] < to; line += 1) lineStarts.push(starts[line])
    const cut = heading ?? near(lineStarts.filter((at) => Math.abs(at - middle) <= window)) ?? middle
    return [chunkAt(from, cut), chunkAt(cut, to)]
  }
  const chunks = plan(maxChars)
  return { content, lineCount: lines.length, headings, references, chunks, plan, split, chunkAt }
}

/** A model pointer is a claim, not proof that those lines support the obligation. */
export function sourcePointer(candidate, skill, document, warnings = []) {
  const range = candidate.sourceLines
  const start = skill.startLine ?? 1
  const end = skill.endLine ?? document.lineCount
  const shape = Array.isArray(range) && range.length === 2 && range.every(Number.isInteger)
    && range[0] >= 1 && range[1] >= range[0]
  const absolute = shape && range[0] >= start && range[1] <= end
  const relative = shape && range[1] <= end - start + 1
  const requestedMode = candidate.sourceLineMode
  let resolved, lineMode
  if (requestedMode === 'absolute' && absolute) {
    resolved = range
    lineMode = 'absolute'
  } else if (requestedMode === 'part' && relative) {
    resolved = range.map((line) => line + start - 1)
    lineMode = 'part'
  } else if (requestedMode == null && absolute && (!relative || start === 1)) {
    resolved = range
    lineMode = 'absolute'
  } else if (requestedMode == null && relative && !absolute) {
    resolved = range.map((line) => line + start - 1)
    lineMode = 'part-inferred'
    warnings.push(`卡片 ${candidate.id ?? candidate.title} 使用局部行号，已按输入起点 ${start} 转换；位置仍是模型声明`)
  }
  if (!resolved) {
    const why = requestedMode == null && absolute && relative && start !== 1 ? '原文行号存在局部/全局歧义' : '缺少有效原文行号'
    warnings.push(`卡片 ${candidate.id ?? candidate.title} ${why}，已回退到输入范围 ${start}–${end}`)
  }
  const [startLine, endLine] = resolved ?? [start, end]
  const pointer = {
    path: skill.path ?? skill.name, startLine, endLine,
    precise: false,
    basis: resolved ? 'model-lines' : 'input-range',
    lineMode: lineMode ?? 'input',
    supportVerified: false,
  }
  if (shape) pointer.claimedLines = [...range]
  if (skill.partialStart || skill.partialEnd) pointer.partialInput = true
  // Quote matching can verify a textual location, never semantic completeness.
  const quote = typeof candidate.sourceQuote === 'string' ? candidate.sourceQuote.replace(/\r\n?/g, '\n') : ''
  if (resolved && quote.trim()) {
    const partText = String(skill.content ?? document.content).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    const first = partText.indexOf(quote)
    const unique = first >= 0 && partText.indexOf(quote, first + 1) < 0
    const quoteStart = first < 0 ? 0 : start + partText.slice(0, first).split('\n').length - 1
    const quoteEnd = quoteStart + quote.split('\n').length - 1
    if (unique && quoteStart === startLine && quoteEnd === endLine) {
      pointer.precise = true
      pointer.basis = 'verified-quote'
      pointer.quoteVerified = true
    } else {
      warnings.push(`卡片 ${candidate.id ?? candidate.title} 的原文摘录无法唯一匹配所声明行号；保留未验证位置`)
    }
  }
  return pointer
}
