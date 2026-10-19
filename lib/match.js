/**
 * Deterministic scope predicates for compiled skill obligations. A card may say
 * which files (`paths`, forward-slash globs) or commands (`commands`, keywords)
 * it is about; such a card only reaches the judge when the action at hand, or
 * the files and commands of the session so far, actually match. Cards without
 * predicates fall back to their trigger events alone.
 */

const MAX_PATTERNS = 12
const MAX_GLOB_CHARS = 200
const MAX_COMMAND_CHARS = 80

/** Compile one glob (`**`, `*`, `?`, `{a,b}`) into an anchored, case-insensitive RegExp; undefined when malformed. */
export function globToRegExp(glob) {
  let source = ''
  let depth = 0
  for (let index = 0; index < glob.length; index += 1) {
    const ch = glob[index]
    if (ch === '*') {
      if (glob[index + 1] === '*') {
        // `**/` spans zero or more directories; any other `**` spans the rest.
        const slash = glob[index + 2] === '/'
        source += slash ? '(?:[^/]*/)*' : '.*'
        index += slash ? 2 : 1
      } else source += '[^/]*'
    } else if (ch === '?') source += '[^/]'
    else if (ch === '{') { source += '(?:'; depth += 1 }
    else if (ch === '}' && depth > 0) { source += ')'; depth -= 1 }
    else if (ch === ',' && depth > 0) source += '|'
    else source += ch.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
  }
  if (depth !== 0) return undefined
  try {
    return new RegExp(`^${source}$`, 'i')
  } catch {
    return undefined
  }
}

/** Validated path globs from model output; problems are reported, never fatal. */
export function pathPatterns(value, warn = () => {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) { warn('paths 不是数组，已忽略'); return [] }
  const out = []
  for (const item of value) {
    const glob = typeof item === 'string' ? item.trim().replace(/\\/g, '/').replace(/^\.\//, '') : ''
    if (!glob || glob.length > MAX_GLOB_CHARS || glob.includes('\0') || !globToRegExp(glob)) { warn(`路径模式无效：${String(item).slice(0, 60)}`); continue }
    if (!out.includes(glob)) out.push(glob)
  }
  if (out.length > MAX_PATTERNS) warn(`路径模式超过 ${MAX_PATTERNS} 条，只保留前 ${MAX_PATTERNS} 条`)
  return out.slice(0, MAX_PATTERNS)
}

/** Validated command keywords from model output. */
export function commandPatterns(value, warn = () => {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) { warn('commands 不是数组，已忽略'); return [] }
  const out = []
  for (const item of value) {
    const keyword = typeof item === 'string' ? item.trim().replace(/\s+/g, ' ') : ''
    if (keyword.length < 2 || keyword.length > MAX_COMMAND_CHARS) { warn(`命令关键词无效：${String(item).slice(0, 60)}`); continue }
    if (!out.includes(keyword)) out.push(keyword)
  }
  if (out.length > MAX_PATTERNS) warn(`命令关键词超过 ${MAX_PATTERNS} 条，只保留前 ${MAX_PATTERNS} 条`)
  return out.slice(0, MAX_PATTERNS)
}

/**
 * A predicate over file paths. A glob without `/` matches the file name (as in
 * .gitignore); one with `/` matches any trailing run of path segments, so
 * `migrations/**` also matches `D:/repo/migrations/001.sql`.
 */
export function pathMatcher(globs) {
  const compiled = globs.map((glob) => ({ regex: globToRegExp(glob), bare: !glob.includes('/') })).filter((item) => item.regex)
  return (path) => {
    if (typeof path !== 'string' || !path) return false
    const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
    if (segments.length === 0) return false
    return compiled.some(({ regex, bare }) => bare
      ? regex.test(segments.at(-1))
      : segments.some((_, index) => regex.test(segments.slice(index).join('/'))))
  }
}

/** A predicate over command lines: each keyword must appear as whole words, case-insensitively. */
export function commandMatcher(keywords) {
  const compiled = keywords.map((keyword) => new RegExp(
    `(?:^|[^\\w-])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}(?:$|[^\\w-])`, 'i'))
  return (command) => typeof command === 'string' && compiled.some((regex) => regex.test(command))
}
