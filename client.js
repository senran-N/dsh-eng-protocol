/**
 * The host's conversation.view is session-scoped. Verified against the shipped
 * client contract and ChatView: sessionId + useSessions(s => s.byId[id]?.cwd)
 * are standard props; cwd is NOT an owner prop. Theme reads/subscriptions use
 * the documented theme service, not a one-time DOM attribute check.
 */
window.__ModuleLoader__.load({
  id: 'dsh-eng-protocol',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const BOOTSTRAP = '/eng-protocol-bootstrap'

    function dashboardConfig(value) {
      const path = value?.path
      if (typeof path !== 'string' || !/^\/(?!\/)[^?#\\]*$/.test(path)) return null
      return { path: path.replace(/\/+$/, ''), enabled: value.enabled !== false }
    }

    function apply(ctx) {
      const subscribeTheme = (listener) => ctx.on('theme/change', listener)
      const getTheme = () => ctx.theme.getTheme().active.colorScheme
      function EngProtocolView({ sessionId, useSessions, openView }) {
        const cwd = useSessions((snapshot) => snapshot.byId[sessionId]?.cwd) || ''
        const frame = React.useRef(null)
        // The panel asks to show a step in the Trajectory; only our own iframe
        // on our own origin may ask, and the focus is a tool call id.
        React.useEffect(() => {
          if (typeof openView !== 'function') return undefined
          const onMessage = (event) => {
            if (event.origin !== window.location.origin || !frame.current || event.source !== frame.current.contentWindow) return
            const data = event.data
            if (data?.type !== 'eng-protocol/open-trajectory') return
            openView('trajectory', typeof data.callId === 'string' ? data.callId : '')
          }
          window.addEventListener('message', onMessage)
          return () => window.removeEventListener('message', onMessage)
        }, [openView])
        const theme = React.useSyncExternalStore(subscribeTheme, getTheme, getTheme)
        const [config, setConfig] = React.useState(() => dashboardConfig(window.__ENG_PROTOCOL_DASHBOARD__))
        const [error, setError] = React.useState('')
        React.useEffect(() => {
          let disposed = false
          const controller = new AbortController()
          const update = async () => {
            try {
              const response = await fetch(BOOTSTRAP, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              const next = dashboardConfig(await response.json())
              if (!next) throw new Error('无效的 dashboard.path')
              if (!disposed) {
                setConfig((previous) => previous?.path === next.path && previous.enabled === next.enabled ? previous : next)
                setError('')
              }
            } catch (cause) {
              if (!disposed) setError(`无法读取面板配置：${cause.message}`)
            }
          }
          void update()
          const timer = setInterval(update, 8000)
          return () => { disposed = true; clearInterval(timer); controller.abort() }
        }, [])
        if (!config) return React.createElement('div', { role: error ? 'alert' : 'status' }, error || '读取 Eng Protocol 面板配置…')
        if (!config.enabled) return React.createElement('div', { role: 'status' }, 'Eng Protocol 面板已在配置中关闭。')
        const query = new URLSearchParams({ embed: '1', theme, scope: 'session', sessionId: sessionId || '', cwd, ...(typeof openView === 'function' ? { trajectory: '1' } : {}) })
        return React.createElement('iframe', {
          ref: frame,
          title: 'Eng Protocol · 当前会话',
          src: `${config.path}?${query}`,
          style: { border: 0, width: '100%', height: '100%', minHeight: '480px', display: 'block', background: 'transparent' },
        })
      }
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'eng-protocol', order: 20, label: () => 'Eng Protocol',
      }, EngProtocolView))
    }
    exports.apply = apply
    exports.inject = ['slots', 'theme']
    return module.exports
  },
})
