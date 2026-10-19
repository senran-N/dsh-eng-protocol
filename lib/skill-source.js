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
  /** 1-based line number of a character offset. */
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
   * Cover the whole body with parts of at most `limit` characters. The cut
   * points depend only on the text before them, so the same body always yields
   * the same parts and an edit late in a skill leaves the earlier parts intact.
   */
  const plan = (limit) => {
    const chunks = []
    for (let offset = 0; offset < content.length;) {
      const end = boundary(offset, limit)
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
  return { content, lineCount: lines.length, headings, references, chunks, plan, split, chunkAt, lineAt }
}

// What a model drops or swaps when it copies Markdown: emphasis and code marks,
// typographic quotes, non-breaking spaces. Matching ignores them on both sides.
const IGNORED = new Set(['*', '`', '_'])
const FOLD = new Map([['\u2018', "'"], ['\u2019', "'"], ['\u201C', '"'], ['\u201D', '"']])
export const MIN_QUOTE_CHARS = 8
export const MAX_QUOTE_CHARS = 600

/** Comparison form of a text plus, for every kept character, its offset in the original. */
function foldText(text) {
  let out = ''
  const offsets = []
  let space = false
  for (let index = 0; index < text.length; index += 1) {
    let ch = text[index]
    if (IGNORED.has(ch)) continue
    ch = FOLD.get(ch) ?? ch
    if (/\s/.test(ch)) {
      if (out.length > 0 && !space) { out += ' '; offsets.push(index); space = true }
      continue
    }
    space = false
    out += ch >= 'A' && ch <= 'Z' ? ch.toLowerCase() : ch
    offsets.push(index)
  }
  if (space) { out = out.slice(0, -1); offsets.pop() }
  return { text: out, offsets }
}

/** Comparison key for recognising the same sentence quoted twice. */
export function foldKey(text) {
  return foldText(String(text ?? '')).text
}

/**
 * Find a model-supplied quote in `content`, tolerant of whitespace, ASCII case,
 * Markdown emphasis/code marks and typographic quotes, but not of paraphrase.
 * Returns the original character range of the first match.
 */
export function locateQuote(content, quote) {
  if (typeof quote !== 'string' || typeof content !== 'string') return undefined
  const needle = foldText(quote).text
  if (needle.length < MIN_QUOTE_CHARS || needle.length > MAX_QUOTE_CHARS) return undefined
  const haystack = foldText(content)
  const at = haystack.text.indexOf(needle)
  if (at < 0) return undefined
  let start = haystack.offsets[at]
  let end = haystack.offsets[at + needle.length - 1] + 1
  // Keep the emphasis/code marks that wrap the match, so the excerpt stays balanced Markdown.
  while (start > 0 && IGNORED.has(content[start - 1])) start -= 1
  while (end < content.length && IGNORED.has(content[end])) end += 1
  return { start, end, unique: haystack.text.indexOf(needle, at + 1) < 0 }
}

/**
 * Ground one compiled obligation in the part it came from. A quote found in the
 * text yields the exact source excerpt and the lines it really occupies; the
 * model's own line claims are only a fallback position, never proof.
 */
export function groundCard(candidate, part, document) {
  const path = part.path ?? part.name
  const located = locateQuote(part.content, candidate.quote)
  if (located) {
    const from = (part.startOffset ?? 0) + located.start
    const to = (part.startOffset ?? 0) + located.end
    return {
      grounded: true,
      quote: document.content.slice(from, to),
      sourceRef: {
        path, startLine: document.lineAt(from), endLine: document.lineAt(to - 1),
        precise: true, basis: 'verified-quote', quoteVerified: true,
        ...(located.unique ? {} : { ambiguous: true }),
      },
    }
  }
  const first = part.startLine ?? 1
  const last = part.endLine ?? document.lineCount
  const lines = candidate.sourceLines
  const claimed = Array.isArray(lines) && lines.length === 2 && lines.every(Number.isInteger)
    && lines[0] >= first && lines[1] >= lines[0] && lines[1] <= last
  return {
    grounded: false,
    sourceRef: {
      path, startLine: claimed ? lines[0] : first, endLine: claimed ? lines[1] : last,
      precise: false, basis: claimed ? 'model-lines' : 'input-range', quoteVerified: false,
    },
  }
}
