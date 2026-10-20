import { classifyTool, contentText } from './events.js'
import { oneLine } from './text.js'
import { isProtocolBlock } from './intervention.js'

const ACTIONS = 6
const handoff = (text) => /(?:started|moved to)\s+background job[:\s]+([\w-]+)|background job started[:\s]+([\w-]+)/i.exec(text)
const terminal = (text) => /\[status:\s*(completed|failed|killed)(?:,\s*([^\]]*))?\]/i.exec(text)
const snapshot = (watcher, ended) => ({ ...watcher, actions: watcher.actions.map((action) => ({ ...action })), ended })

/** Observable post-delivery behavior, not proof that the reminder caused it. */
export class Aftermath {
  constructor() { this.watchers = [] }

  watch(record) {
    this.watchers.push({
      kind: 'aftermath', decisionId: record.decisionId, sessionId: record.sessionId,
      cwd: record.cwd, boundary: record.boundary, shadow: record.shadow === true,
      blocked: record.blocked === true,
      cards: record.deliveredCards?.length ? record.deliveredCards : record.selected ?? [],
      blockedCallId: record.blocked ? record.callId : undefined,
      fromSeq: record.deliverySeq ?? record.seq, actions: [], reply: undefined,
    })
  }

  /** Emit immutable progress snapshots immediately, including background completion. */
  push(event) {
    if (!event || event.surfaceOp?.op === 'replace' || this.watchers.length === 0) return []
    const data = event.data ?? {}
    const changed = []
    for (const watcher of this.watchers) {
      if (Number.isInteger(event.seq) && Number.isInteger(watcher.fromSeq) && event.seq <= watcher.fromSeq) continue
      let dirty = false
      if (event.type === 'tool/call') {
        const callId = String(data.callId ?? '')
        if (!callId || watcher.actions.some((item) => item.callId === callId)) continue
        const action = classifyTool(data.name, data.arguments)
        const blocked = watcher.blockedCallId === callId
        if (blocked || watcher.actions.filter((item) => item.status !== 'blocked').length < ACTIONS) {
          watcher.actions.push({ callId, tool: data.name, kind: action.kind,
            target: action.path ?? (action.command ? oneLine(action.command, 160) : action.skill),
            requestedJobId: action.args?.job_id, seq: event.seq, at: event.time,
            status: blocked ? 'blocked' : 'running' })
          dirty = true
        }
      } else if (event.type === 'tool/result') {
        const message = data.message
        const callId = String(message?.source?.callId ?? message?.toolCallId ?? data.callId ?? '')
        const text = contentText(message?.content)
        const action = watcher.actions.find((item) => item.callId === callId)
        if (action && action.status !== 'blocked') {
          const failed = message?.isError === true || Boolean(data.error)
            || (action.kind === 'command' && /\[exit code:\s*[+-]?[1-9]\d*\]|(?:^|\n)\s*exit code:\s*[+-]?[1-9]\d*/i.test(text))
          const job = handoff(text)
          action.status = isProtocolBlock(data) ? 'blocked' : failed ? 'error' : job ? 'running' : 'ok'
          if (job) action.jobId = job[1] ?? job[2]
          action.resultSeq = event.seq
          if (action.requestedJobId) this.settle(watcher, action.requestedJobId, text, event.seq)
          dirty = true
        }
      } else if (event.type === 'user/message' && data.source?.kind === 'tool-jobs') {
        const text = contentText(data.content)
        const notice = /background job\s+(\S+)[^\n]*?finished\s+(\[status:[^\]]*\])/i.exec(text)
        if (notice) dirty = this.settle(watcher, notice[1], notice[2], event.seq)
      } else if (event.type === 'assistant/message') {
        const text = oneLine(contentText(data.message?.content), 240)
        if (text) { watcher.reply = text; watcher.replySeq = event.seq; dirty = true }
      }
      if (dirty) {
        const complete = watcher.actions.filter((item) => item.status !== 'blocked').length >= ACTIONS
          && watcher.actions.every((action) => action.status !== 'running')
        changed.push(snapshot(watcher, complete ? 'complete' : 'observing'))
        if (complete) this.watchers = this.watchers.filter((item) => item !== watcher)
      }
    }
    return changed
  }

  settle(watcher, jobId, text, seq) {
    const done = terminal(text)
    if (!done) return false
    let changed = false
    const exit = /exit code:\s*(-?\d+)/i.exec(done[2] ?? '')
    for (const action of watcher.actions) if (action.jobId === String(jobId) && action.status === 'running') {
      action.status = done[1].toLowerCase() !== 'completed' || (exit && Number(exit[1]) !== 0) ? 'error' : 'ok'
      action.resultSeq = seq
      changed = true
    }
    return changed
  }

  flush(reason) { return this.watchers.splice(0).map((watcher) => snapshot(watcher, reason)) }
}
