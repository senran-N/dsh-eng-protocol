import { classifyTool, contentText } from './events.js'
import { oneLine } from './text.js'

// How many of the agent's next actions are kept after a reminder.
const ACTIONS = 6

/**
 * What the agent actually did after a reminder, read straight from the
 * session's event stream (the same events the Trajectory view renders). It is
 * evidence a person can check, next to the judge's own follow-up verdict, and
 * every action keeps its `callId` and `seq` so the panel can open it in the
 * Trajectory.
 */
export class Aftermath {
  constructor() {
    this.watchers = []
  }

  /** Start following one delivered (or, in shadow mode, withheld) reminder. */
  watch(record) {
    this.watchers.push({
      kind: 'aftermath',
      decisionId: record.decisionId,
      sessionId: record.sessionId,
      cwd: record.cwd,
      boundary: record.boundary,
      shadow: record.shadow === true,
      blocked: record.blocked === true,
      cards: record.deliveredCards?.length ? record.deliveredCards : record.selected ?? [],
      // The call a soft block stopped; when it shows up it is the stopped step, not a new action.
      blockedCallId: record.blocked ? record.callId : undefined,
      fromSeq: record.seq,
      actions: [],
      reply: undefined,
    })
  }

  /** Feed one session event; returns the watchers that are complete. */
  push(event) {
    if (this.watchers.length === 0 || !event) return []
    const data = event.data ?? {}
    if (event.type === 'tool/call') {
      const callId = String(data.callId ?? '')
      if (!callId) return []
      const action = classifyTool(data.name, data.arguments)
      const entry = {
        callId,
        tool: data.name,
        kind: action.kind,
        target: action.path ?? (action.command ? oneLine(action.command, 160) : action.skill),
        seq: Number.isInteger(event.seq) ? event.seq : undefined,
        at: event.time,
        status: 'running',
      }
      for (const watcher of this.watchers) {
        if (watcher.actions.some((item) => item.callId === callId)) continue
        if (watcher.blockedCallId === callId) watcher.actions.push({ ...entry, status: 'blocked' })
        else if (watcher.actions.filter((item) => item.status !== 'blocked').length < ACTIONS) watcher.actions.push({ ...entry })
      }
    } else if (event.type === 'tool/result') {
      const message = data.message
      const callId = String(message?.source?.callId ?? message?.toolCallId ?? data.callId ?? '')
      const text = contentText(message?.content)
      const failed = message?.isError === true || Boolean(data.error) || /\[exit code:\s*[1-9]\d*\]/.test(text)
      for (const watcher of this.watchers) {
        for (const action of watcher.actions) if (action.callId === callId && action.status !== 'blocked') action.status = failed ? 'error' : 'ok'
      }
    } else if (event.type === 'assistant/message') {
      const text = oneLine(contentText(data.message?.content), 240)
      for (const watcher of this.watchers) if (!watcher.reply && text) watcher.reply = text
    }
    const done = this.watchers.filter((watcher) => watcher.actions.filter((item) => item.status !== 'blocked').length >= ACTIONS
      && watcher.actions.every((action) => action.status !== 'running'))
    if (done.length > 0) this.watchers = this.watchers.filter((watcher) => !done.includes(watcher))
    return done.map((watcher) => ({ ...watcher, ended: 'complete' }))
  }

  /** End every open watcher, e.g. when a new human turn starts. */
  flush(reason) {
    const open = this.watchers.splice(0)
    return open.map((watcher) => ({ ...watcher, ended: reason }))
  }
}
