import assert from 'node:assert/strict'

let registration
globalThis.document = { body: { hasAttribute: () => false } }
globalThis.window = {
  __ModuleLoader__: {
    load(value) { registration = value },
  },
  // The view reads this synchronously for its first render; the bootstrap
  // fetch only refreshes it later in a real browser.
  __ENG_PROTOCOL_DASHBOARD__: { path: '/eng-protocol', enabled: true },
}

await import('../client.js?client-test')

assert.ok(registration, 'client bundle must register a factory')
assert.equal(registration.id, 'dsh-eng-protocol')

const React = {
  createElement: (type, props) => ({ type, props }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}
const exports = registration.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected module ${name}`)
})
assert.deepEqual(exports.inject, ['slots', 'theme'])
assert.equal(typeof exports.apply, 'function')

let slotName
let registered
const ctx = {
  slots: {
    inject(name, callback) {
      slotName = name
      callback()
    },
    register(options, Component) {
      registered = { options, Component }
      return () => {}
    },
  },
}
exports.apply({
  slots: ctx.slots,
  theme: {
    getTheme: () => ({ active: { colorScheme: 'light' } }),
    on() { return () => {} },
  },
})
assert.equal(slotName, 'conversation.view')
assert.equal(registered.options.id, 'eng-protocol')
assert.equal(registered.options.order, 20)
assert.equal(registered.options.label(), 'Eng Protocol')
const view = registered.Component({ sessionId: 's1', useSessions: () => 'C:/project', openView() {} })
assert.equal(view.type, 'iframe')
assert.match(view.props.src, /^\/eng-protocol\?embed=1&theme=light&scope=session&sessionId=s1&cwd=C%3A%2Fproject/)

console.log('ok - client bundle registers the Eng Protocol conversation tab')
