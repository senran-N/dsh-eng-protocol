/**
 * A skill body as the compiler reads it. The host has already removed the
 * frontmatter; this module indexes the Markdown body, cuts it into parts along
 * its sections, and numbers the statements of a part so the model can cite them
 * by number instead of copying text. Everything here is a pure function of the
 * text: the same body always yields the same parts and the same statements,
 * which is what lets compile results be stored by content.
 */

// A part holds whole sections. A section shorter than the floor joins the next
// one; a section longer than the ceiling is cut at its sub-headings, then at
// paragraphs, then at lines.
export const PART_FLOOR = 2000
export const PART_CEILING = 9000
// A list item longer than this is numbered sentence by sentence; paragraphs always are.
const LONG_ITEM = 400

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const ATX = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
const SETEXT = /^ {0,3}(=+|-+)\s*$/
const BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const ITEM = /^\s{0,6}(?:[-*+]|\d{1,3}[.)])\s+/
const TABLE = /^\s*\|/
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/
const LEAD = /^(?:\s*(?:#{1,6}\s+|>\s?|(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?))+/

/** Index one skill body. Throws on an empty body. */
export function parseSkillSource(skill, { floor = PART_FLOOR, ceiling = PART_CEILING } = {}) {
  if (!(floor > 0 && ceiling >= floor)) throw new Error('分段上下限无效')
  const content = String(skill.content ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!content.trim()) throw new Error(`skill ${skill.name} 正文为空`)
  const lines = content.split('\n')
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) if (content[index] === '\n') starts.push(index + 1)

  // One kind per line: open / code / close (fenced code), heading, rule, blank, text.
  const kinds = new Array(lines.length)
  const headings = []
  const references = []
  let fence
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const marker = FENCE.exec(line)
    if (fence) {
      const closes = marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()
      kinds[index] = closes ? 'close' : 'code'
      if (closes) fence = undefined
      continue
    }
    if (marker) { fence = { char: marker[1][0], size: marker[1].length }; kinds[index] = 'open'; continue }
    if (!line.trim()) { kinds[index] = 'blank'; continue }
    const atx = ATX.exec(line)
    if (atx) {
      kinds[index] = 'heading'
      headings.push({ line: index + 1, level: atx[1].length, title: atx[2], offset: starts[index] })
    } else if (index > 0 && kinds[index - 1] === 'text' && !ITEM.test(lines[index - 1]) && !TABLE.test(lines[index - 1]) && SETEXT.test(line)) {
      kinds[index - 1] = 'heading'
      kinds[index] = 'rule'
      headings.push({ line: index, level: line.trim()[0] === '=' ? 1 : 2, title: lines[index - 1].trim(), offset: starts[index - 1] })
    } else if (BREAK.test(line)) {
      kinds[index] = 'rule'
    } else kinds[index] = 'text'
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) references.push({ target: match[1], line: index + 1 })
  }

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

  // Sections: the preamble, then one per heading of the first level that
  // occurs at least twice (a single title heading is not a section break).
  const major = [1, 2, 3].find((level) => headings.filter((heading) => heading.level === level).length >= 2)
  const cuts = [...new Set([0, ...headings.filter((heading) => major && heading.level <= major).map((heading) => heading.offset)])]
    .sort((a, b) => a - b)
  const units = cuts.map((at, index) => [at, cuts[index + 1] ?? content.length])

  // Finer cut points inside a section that is too long, coarsest first. Fenced code is never cut.
  const lineStarts = (start, end, test) => {
    const out = []
    for (let index = lineAt(start); index < lines.length && starts[index] < end; index += 1) {
      if (kinds[index] !== 'code' && kinds[index] !== 'close' && test(index)) out.push(starts[index])
    }
    return out
  }
  const finders = [
    (start, end) => headings.filter((heading) => (!major || heading.level > major) && heading.offset > start && heading.offset < end).map((heading) => heading.offset),
    (start, end) => lineStarts(start, end, (index) => kinds[index] !== 'blank' && kinds[index - 1] === 'blank'),
    (start, end) => lineStarts(start, end, () => true),
  ]
  /**
   * Join neighbouring pieces while they fit under the ceiling. A piece below
   * the floor (typically a heading) always joins the piece after it, so it
   * stays with the content it introduces; an oversized result is cut again.
   */
  const pack = (start, end, offsets) => {
    const out = []
    let from = start
    for (const at of [...offsets, end]) {
      const last = out.at(-1)
      if (last && (at - last[0] <= ceiling || last[1] - last[0] < floor)) last[1] = at
      else out.push([from, at])
      from = at
    }
    return out
  }
  /** Small neighbours left over from different cut levels join while they fit. */
  const tidy = (pieces) => {
    const out = []
    for (const piece of pieces) {
      const last = out.at(-1)
      if (last && piece[1] - last[0] <= ceiling && (last[1] - last[0] < floor || piece[1] - piece[0] < floor)) last[1] = piece[1]
      else out.push([...piece])
    }
    return out
  }
  /** Cover [start, end) with pieces no longer than the ceiling, preferring the coarsest boundaries. */
  const fit = (start, end, level = 0) => {
    if (end - start <= ceiling) return [[start, end]]
    if (level >= finders.length) {
      const out = []
      for (let at = start; at < end; at += ceiling) out.push([at, Math.min(end, at + ceiling)])
      return out
    }
    const offsets = finders[level](start, end)
    if (offsets.length === 0) return fit(start, end, level + 1)
    return pack(start, end, offsets).flatMap(([a, b]) => fit(a, b, level + 1))
  }

  const spans = []
  let carry
  for (const [index, [start, end]] of units.entries()) {
    const from = carry ?? start
    carry = undefined
    if (end - from < floor && index < units.length - 1) { carry = from; continue }
    if (end - from < floor && spans.length > 0) { spans.at(-1)[1] = end; continue }
    spans.push(...tidy(fit(from, end)))
  }
  /** The headings enclosing an offset, outermost first: "Database › Migrations". */
  const breadcrumb = (offset) => {
    const chain = []
    for (const heading of headings) {
      if (heading.offset > offset) break
      while (chain.length && chain.at(-1).level >= heading.level) chain.pop()
      chain.push(heading)
    }
    return chain.map((heading) => heading.title).join(' › ')
  }
  const parts = spans.map(([start, end], index) => ({
    index, start, end, content: content.slice(start, end),
    startLine: lineAt(start), endLine: lineAt(end - 1), section: breadcrumb(start),
  }))
  return { content, lines, starts, kinds, lineCount: lines.length, headings, references, parts, lineAt, breadcrumb }
}

const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|incl|fig|no|vol|ch|sec|eq|ref|esp|resp)\.$/i
const CLOSERS = new Set(['"', "'", '”', '’', '」', '』', '）', ')', ']', '*', '_'])

/** Sentence ranges inside one span of text, relative to it. Inline code is never cut. */
function sentences(text) {
  const out = []
  let from = 0
  let code = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '`') { code = !code; continue }
    if (code) continue
    let end = -1
    if (ch === '。' || ch === '！' || ch === '？') end = index + 1
    else if ((ch === '.' || ch === '!' || ch === '?') && /\s/.test(text[index + 1] ?? '')) {
      const next = /^\s+(\S)/.exec(text.slice(index + 1))
      if (next && !/[a-z,;:)]/.test(next[1]) && !(ch === '.' && ABBREVIATION.test(text.slice(from, index + 1)))) end = index + 1
    }
    if (end < 0) continue
    while (end < text.length && CLOSERS.has(text[end])) end += 1
    out.push([from, end])
    from = end
    index = end - 1
  }
  out.push([from, text.length])
  return out.map(([start, end]) => {
    while (start < end && /\s/.test(text[start])) start += 1
    while (end > start && /\s/.test(text[end - 1])) end -= 1
    return [start, end]
  }).filter(([start, end]) => end > start)
}

/**
 * Number the statements of one part: headings, list items, table rows, fenced
 * code blocks and the sentences of paragraphs, each with its exact offsets in
 * the body. A long list item is numbered sentence by sentence as well.
 */
export function statementsOf(document, part) {
  const { content, lines, starts, kinds } = document
  const out = []
  const first = document.lineAt(part.start) - 1
  const last = document.lineAt(part.end - 1) - 1
  const lineStart = (index) => Math.max(part.start, starts[index])
  const lineEnd = (index) => Math.min(part.end, starts[index] + lines[index].length)
  const push = (start, end, kind, split = false) => {
    if (end <= start || !content.slice(start, end).trim()) return
    if (!split) { out.push({ start, end, kind }); return }
    for (const [a, b] of sentences(content.slice(start, end))) out.push({ start: start + a, end: start + b, kind })
  }
  let block
  const flush = () => {
    if (block) push(block.start, block.end, block.kind, block.kind === 'text' || block.end - block.start > LONG_ITEM)
    block = undefined
  }
  for (let index = first; index <= last; index += 1) {
    const kind = kinds[index]
    const line = lines[index]
    if (kind === 'open' || kind === 'code' || kind === 'close') {
      flush()
      let end = index
      if (kind !== 'close') {
        while (end + 1 <= last && kinds[end + 1] === 'code') end += 1
        if (end + 1 <= last && kinds[end + 1] === 'close') end += 1
      }
      push(lineStart(index), lineEnd(end), 'code')
      index = end
    } else if (kind === 'blank' || kind === 'rule') flush()
    else if (kind === 'heading') {
      flush()
      const end = index + 1 <= last && kinds[index + 1] === 'rule' ? index + 1 : index
      push(lineStart(index), lineEnd(end), 'heading')
      index = end
    } else if (TABLE.test(line)) {
      flush()
      if (!TABLE_RULE.test(line)) push(lineStart(index), lineEnd(index), 'row')
    } else if (ITEM.test(line)) {
      flush()
      block = { kind: 'item', start: lineStart(index), end: lineEnd(index) }
    } else if (block) block.end = lineEnd(index)
    else block = { kind: 'text', start: lineStart(index), end: lineEnd(index) }
  }
  flush()
  return out.map((statement, index) => ({ n: index + 1, ...statement }))
}

/** The numbered statements as the model reads them. */
export function renderStatements(document, statements) {
  return statements.map((statement) => `[${statement.n}] ${document.content.slice(statement.start, statement.end)}`).join('\n')
}

/**
 * The exact source text of statements `first`..`last` of a part: list, quote
 * and heading markers are dropped from its start, and headings that only
 * introduce the cited text are left out. Undefined for a range outside the part.
 */
export function quoteOf(document, statements, first, last) {
  const at = (n) => (statements[n - 1]?.n === n ? statements[n - 1] : statements.find((statement) => statement.n === n))
  let from = at(first)
  const to = at(last)
  if (!from || !to || to.n < from.n) return undefined
  while (from.kind === 'heading' && from.n < to.n) from = at(from.n + 1)
  let start = from.start
  let end = to.end
  const lead = LEAD.exec(document.content.slice(start, end))
  if (lead) start += lead[0].length
  while (start < end && /\s/.test(document.content[start])) start += 1
  while (end > start && /\s/.test(document.content[end - 1])) end -= 1
  if (end <= start) return undefined
  return { quote: document.content.slice(start, end), start, end, startLine: document.lineAt(start), endLine: document.lineAt(end - 1), first: from.n, last: to.n }
}

// What a model drops or swaps when it copies Markdown: emphasis and code marks,
// typographic quotes, non-breaking spaces. Matching ignores them on both sides.
const IGNORED = new Set(['*', '`', '_'])
const FOLD = new Map([['\u2018', "'"], ['\u2019', "'"], ['\u201C', '"'], ['\u201D', '"']])
export const MIN_QUOTE_CHARS = 8

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
 * Find a quote in `content`, tolerant of whitespace, ASCII case, Markdown
 * emphasis/code marks and typographic quotes, but not of paraphrase. Returns
 * the original character range of the first match. Only needed when a model
 * answers with text instead of statement numbers.
 */
export function locateQuote(content, quote) {
  if (typeof quote !== 'string' || typeof content !== 'string') return undefined
  const needle = foldText(quote).text
  if (needle.length < MIN_QUOTE_CHARS) return undefined
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
