/** Read retained decision logs; no model calls, credentials or transcript content. */
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const stateDir = option('--state-dir') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages/eng-protocol')
const counts = values => Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map())]
  .sort((a, b) => b[1] - a[1]))
const quantiles = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return { count: sorted.length, mean: sorted.length ? Math.round(sorted.reduce((n, v) => n + v, 0) / sorted.length) : undefined,
    min: sorted[0], p50: sorted[Math.floor(sorted.length * 0.5)],
    p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted.at(-1) }
}
const files = [], decisions = []
for (const file of ['decisions.jsonl.1', 'decisions.jsonl']) {
  let text
  try { text = await readFile(join(stateDir, file), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  let invalid = 0, parsed = 0
  for (const line of text.split('\n').filter(line => line.trim())) {
    try { const row = JSON.parse(line); parsed++; if (row.kind === 'decision') decisions.push(row) }
    catch { invalid++ }
  }
  files.push({ file, parsed, invalid })
}
function summarize(rows) {
  // Cache hits repeat another decision's attempt log; don't count them as new calls.
  const attempts = rows.filter(row => !row.cacheHit).flatMap(row => row.attempts ?? [])
  const started = attempts.filter(attempt => attempt.runMs > 0)
  return {
    count: rows.length, firstAt: rows[0]?.ts, lastAt: rows.at(-1)?.ts,
    errorsOrIncomplete: rows.filter(row => row.error).length,
    deadlineExpired: rows.filter(row => row.deadlineExpired).length,
    cacheHits: rows.filter(row => row.cacheHit).length,
    decisionMs: quantiles(rows.map(row => row.latencyMs)),
    recoveredAssessments: rows.reduce((n, row) => n + (row.recoveredAssessments ?? 0), 0),
    outputExpansions: rows.reduce((n, row) => n + (row.outputExpansions ?? 0), 0),
    models: counts(rows.map(row => row.model ?? 'unknown')),
    candidateCount: quantiles(rows.map(row => row.candidates?.length)),
    answeredRatio: quantiles(rows.map(row => row.judgeCoverage ? row.judgeCoverage.answered / row.judgeCoverage.total : undefined)),
    totalAttempts: attempts.length, startedAttempts: started.length,
    attemptErrors: counts(attempts.filter(attempt => attempt.errorKind).map(attempt => attempt.errorKind)),
    timeoutStages: counts(attempts.filter(attempt => attempt.timeoutStage).map(attempt => attempt.timeoutStage)),
    batchSizes: counts(started.map(attempt => attempt.cards?.length ?? 0)),
    successfulCallMs: quantiles(attempts.filter(attempt => attempt.status === 'answered').map(attempt => attempt.runMs)),
    callMs: quantiles(started.map(attempt => attempt.runMs)),
    prepareMs: quantiles(started.map(attempt => attempt.prepareMs)),
    firstChunkMs: quantiles(started.map(attempt => attempt.firstChunkMs)),
    firstTextMs: quantiles(started.map(attempt => attempt.firstTextMs)),
    generationMs: quantiles(started.map(attempt => attempt.generationMs)),
    requestChars: quantiles(attempts.map(attempt => attempt.inputChars)),
    outputAllowances: counts(attempts.filter(attempt => attempt.maxTokens).map(attempt => attempt.maxTokens)),
  }
}
const revisions = [...new Set(decisions.map(row => row.judgeRevision ?? 'unversioned'))]
const summary = {
  capturedAt: new Date().toISOString(), files,
  note: 'Retained logs only; errors include partial judgments. Revision cohorts may contain different tasks and are not a controlled A/B comparison.',
  all: summarize(decisions), last200: summarize(decisions.slice(-200)),
  revisions: Object.fromEntries(revisions.map(revision => [revision, summarize(decisions.filter(row => (row.judgeRevision ?? 'unversioned') === revision))])),
  examples: decisions.slice(-3).map(row => ({ decisionId: row.decisionId, ts: row.ts, boundary: row.boundary,
    judgeRevision: row.judgeRevision, candidates: row.candidates?.length, coverage: row.judgeCoverage,
    deadlineMs: row.deadlineMs, latencyMs: row.latencyMs,
    firstAttempts: row.attempts?.slice(0, 3).map(attempt => ({ cards: attempt.cards?.length, inputChars: attempt.inputChars,
      maxTokens: attempt.maxTokens, runMs: attempt.runMs, queueMs: attempt.queueMs, timeoutMs: attempt.timeoutMs,
      status: attempt.status, errorKind: attempt.errorKind })) })),
}
const output = JSON.stringify(summary, null, 2) + '\n'
if (option('--out')) await writeFile(option('--out'), output, 'utf8')
process.stdout.write(output)
if (files.some(file => file.invalid)) process.exitCode = 1
