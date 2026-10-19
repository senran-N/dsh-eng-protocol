// Optional real-browser check, without browser automation dependencies.
// ENG_PROTOCOL_BROWSER may point at any Chromium/Chrome/Edge executable.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { normalizeConfig } from '../lib/config.js'
import { buildGraph, normalizeCompiled } from '../lib/compiler.js'
import { registerDashboard } from '../lib/dashboard.js'

const root = await mkdtemp(join(tmpdir(), 'eng-browser-'))
// Settings persist under $DSH_HOME; keep the developer's real one untouched.
process.env.DSH_HOME = root
const config = normalizeConfig({ stateDir: join(root, 'state') })
// The session's own catalog view, as the runtime builds it: 60 skills, each already compiled.
const entries = new Map(Array.from({ length: 60 }, (_, index) => {
  const name = `skill-${index}`
  const summary = { name, description: `Guidance for ${name}`, path: `C:/skills/${name}/SKILL.md` }
  const compiled = normalizeCompiled({
    cards: ['read', 'verify'].map((id) => ({ id, title: `${name} ${id}`, when: 'edit code', rules: ['Check behavior'], triggers: ['edit'], satisfiedWhen: 'tests pass', sourceLines: [1, 2] })),
    relations: [{ type: 'requires', source: 'read', target: 'verify' }, { type: 'covers', source: 'verify', target: 'verify' }],
  }, { ...summary, content: '# Skill\nCheck behavior', hash: name })
  return [name, { summary, compiled }]
}))
// One more skill nobody has loaded yet: listed, routable, not compiled.
entries.set('zz-standby', { summary: { name: 'zz-standby', description: 'Not loaded yet', path: 'C:/skills/zz-standby/SKILL.md' } })
const agent = { session: { id: 's1', header: { cwd: root } }, options: {} }
const graph = buildGraph(root, entries)
const state = {
  config, graphs: new Map([[root, graph]]), lastCwd: root, lastAgentByCwd: new Map(), lastCwdBySession: new Map(),
  agentBySession: new Map([['s1', agent]]), liveAgents: new Set([agent]),
  skillViews: new WeakMap([[agent, { agent, cwd: root, entries, wanted: new Set(), graph, listed: true, log: [] }]]),
}
const routes = []
registerDashboard({ inject(_deps, callback) { callback({ webServer: { register(route) { routes.push(route) } }, effect: (fn) => fn(), on() {} }) } }, state)
const server = createServer((req, res) => {
  const route = routes.find((entry) => entry.path === new URL(req.url, 'http://localhost').pathname)
  if (route) void route.handler(req, res)
  else { res.statusCode = 404; res.end() }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const browser = spawn(process.env.ENG_PROTOCOL_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(root, 'profile')}`, 'about:blank',
], { windowsHide: true, stdio: 'ignore' })
let socket, commandId = 0
const pending = new Map(), errors = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, message) {
  for (let index = 0; index < 150; index += 1) { if (await fn()) return; await sleep(100) }
  throw new Error(message)
}
function send(method, params = {}) {
  const id = ++commandId
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
  return result.result.value
}
try {
  let port
  await until(async () => { port = (await readFile(join(root, 'profile', 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]; return Boolean(port) }, 'browser did not start')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl)
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data)
    if (event.id) {
      const promise = pending.get(event.id); pending.delete(event.id)
      if (event.error) promise?.reject(new Error(event.error.message)); else promise?.resolve(event.result)
    } else if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text)
  })
  await once(socket, 'open')
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/eng-protocol?sessionId=s1` })
  await until(async () => await evaluate("document.getElementById('k-total')?.textContent === '197'"), 'dashboard data not rendered')
  // A skill nobody loaded yet reads as waiting for use, not as work in progress.
  await evaluate("document.querySelector('[data-view=skills]').click()")
  const standby = await evaluate("(() => { const card = [...document.querySelectorAll('#skills .sk')].find((el) => el.textContent.includes('zz-standby')); return card && { state: card.dataset.state, text: card.textContent, button: card.querySelector('[data-recompile]').textContent } })()")
  assert.equal(standby.state, 'standby')
  assert.match(standby.text, /用到时再准备/)
  assert.equal(standby.button, '现在准备')
  assert.equal(await evaluate("document.querySelector('#compile-meter .m-work').style.width"), '0%', 'standby is not counted as in progress')
  assert.match(await evaluate("document.getElementById('compile-title').textContent"), /60 个 skill 已就绪，其余 1 个用到时再准备/)
  await evaluate("document.querySelector('[data-view=topology]').click()")
  assert.equal(await evaluate("document.querySelectorAll('#graph .node').length"), 197)
  assert.equal(await evaluate("document.querySelectorAll('#graph .edge.contains').length"), 120)
  assert.ok(await evaluate("document.querySelectorAll('#graph line[marker-end]').length > 0"))
  await evaluate("document.getElementById('graph-skill').value='skill-0'; document.getElementById('graph-skill').dispatchEvent(new Event('change'))")
  assert.equal(await evaluate("document.querySelectorAll('#graph .node').length"), 19)
  await evaluate("document.querySelectorAll('#graph .node')[17].dispatchEvent(new MouseEvent('click', {bubbles:true}))")
  assert.match(await evaluate("document.getElementById('detail-body').textContent"), /出处skill-0\/SKILL\.md 第 1–2 行附近/)
  await evaluate("document.getElementById('detail').close()")
  // The settings tab renders the live model route and a save button; saving a
  // decision-model change goes through the real POST route.
  await evaluate("document.querySelector('[data-view=settings]').click()")
  await until(async () => await evaluate("!!document.getElementById('settings-save')"), 'settings form not rendered')
  assert.match(await evaluate("document.getElementById('settings-body').textContent"), /检查用的模型/)
  assert.ok(await evaluate("document.getElementById('set-decision-model') !== null"), 'the judge model is editable')
  assert.equal(await evaluate("document.getElementById('set-enforcement-enabled')"), null, 'enforcement switches stay out of the browser')
  await evaluate(`(async () => {
    document.getElementById('set-decision-provider').value = 'mock-provider';
    document.getElementById('set-decision-model').value = 'mock-model';
    document.getElementById('settings-save').click();
  })()`)
  await until(async () => await evaluate("(document.getElementById('settings-body') || {}).textContent?.includes('mock-provider/mock-model') || (document.getElementById('banner') || {}).textContent?.includes('已保存')"), 'settings were not saved')
  const saved = JSON.parse(await readFile(join(root, 'eng-protocol.json'), 'utf8').catch(() => '{}'))
  assert.deepEqual([saved.decision?.provider, saved.decision?.model], ['mock-provider', 'mock-model'])
  // The saved file is a real config layer: re-resolving picks the new route up.
  assert.equal(normalizeConfig({}, root).decision.provider, 'deepseek-account', 'defaults still apply when the layer is cleared')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'mobile page should not overflow')
  assert.deepEqual(errors, [])
  if (process.env.ENG_PROTOCOL_SCREENSHOT) {
    await evaluate("document.getElementById('view-topology').scrollIntoView()")
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.ENG_PROTOCOL_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
  }
  console.log('ok - real Chromium: 60 skills, directed topology, filter, source details, settings save, mobile layout, no JS errors')
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close() }
  if (browser.exitCode === null) browser.kill()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
