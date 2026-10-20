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
import { refreshSkills, settleCompiles, stopCompiles, wantSkill } from '../lib/compiler.js'
import { registerDashboard } from '../lib/dashboard.js'
import { appendDecision } from '../lib/store.js'

const root = await mkdtemp(join(tmpdir(), 'eng-browser-'))
// Settings persist under $DSH_HOME; keep the developer's real one untouched.
process.env.DSH_HOME = root
const config = normalizeConfig({ stateDir: join(root, 'state') })
// The session's own catalog, built by the real runtime: 60 skills in use and
// compiled through a fake model, plus three more nobody has loaded yet.
const names = Array.from({ length: 60 }, (_, index) => `skill-${index}`)
let held, modelCalls = 0
const llm = {
  async prepareCall(callConfig) {
    return {
      config: callConfig,
      async *stream({ messages }) {
        modelCalls += 1
        if (held && /^SKILL: zz-/m.test(messages[0].content[0].text)) await held.promise
        yield {
          type: 'text-delta',
          text: [
            '{"id":"read","s":[2,2],"title":"read first","on":["edit"],"done":"the files were read"}',
            '{"id":"verify","s":[3,3],"title":"verify","on":["edit"],"done":"tests pass"}',
            '{"rel":"requires","from":"read","to":"verify"}',
            '{"rel":"covers","from":"verify","to":"builtin:verify"}',
            '{"end":true}',
          ].join('\n'),
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  },
}
const skills = {
  async list() { return [...names, 'zz-standby', 'zz-waiting-a', 'zz-waiting-b'].map((name) => ({ name, description: name.startsWith('zz-') ? 'Not loaded yet' : `Guidance for ${name}`, path: `C:/skills/${name}/SKILL.md` })) },
  async get(name) { return { name, description: `Guidance for ${name}`, path: `C:/skills/${name}/SKILL.md`, content: `# ${name}\nRead the code first. Check behavior before you edit.` } },
}
const get = (name) => (name === 'llm' ? llm : name === 'skills' ? skills : undefined)
const agent = { session: { id: 's1', header: { cwd: root } }, options: {} }
const state = {
  config, graphs: new Map(), compileAbort: new AbortController(), lastCwd: root, lastAgentByCwd: new Map(), lastCwdBySession: new Map(),
  agentBySession: new Map([['s1', agent]]), liveAgents: new Set([agent]),
}
await refreshSkills({ get }, state, agent)
for (const name of names) await wantSkill({ get }, state, agent, name)
await settleCompiles(state, agent)
await appendDecision(config, {
  kind: 'decision', decisionId: 'browser-evidence', sessionId: 's1', cwd: root, boundary: 'tool', triggers: ['edit'],
  selected: ['verify'], candidates: ['verify'], injected: true, deadlineMs: 500, inputChars: 12000,
  evidenceCoverage: { omittedTools: 2, omittedTimeline: 4 },
  judgeCoverage: { total: 1, answered: 1, unresolved: 0, scopeSkipped: 0 },
  evidence: [{ ref: 'event:2', callId: 'browser-call', preview: 'All checks passed' }],
  assessments: { verify: { state: 'satisfied', confidence: 0.9, reason: 'Checked the latest edit', evidence: [{ ref: 'event:2', quote: 'All checks passed' }] } },
  attempts: [{ phase: 'initial', cards: ['verify'], status: 'answered', queueMs: 20, runMs: 110,
    understanding: { goal: '修复解析器并保留断言', constraints: ['不得削弱测试'], phase: '验证', remaining: ['交付报告'], sourceRefs: ['request:1'] } },
    { phase: 'review', cards: ['verify'], status: 'failed', queueMs: 0, runMs: 370, timeoutStage: 'model' }],
}, { evidence: { input: { user: '完整任务条件在末尾：保留所有断言。', timeline: [{ ref: 'event:2', text: 'All checks passed' }] }, cards: [], references: [] } })
const routes = []
registerDashboard({ inject(_deps, callback) { callback({ webServer: { register(route) { routes.push(route) } }, effect: (fn) => fn(), on() {} }) }, get }, state)
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
  await until(async () => await evaluate("document.getElementById('k-total')?.textContent === '199'"), 'dashboard data not rendered')
  await evaluate("document.querySelector('[data-view=trail]').click()")
  await until(async () => await evaluate("document.querySelectorAll('#trail .ev-row').length === 1"), 'decision trail not rendered')
  await evaluate("document.querySelector('#trail .ev-row').click()")
  assert.match(await evaluate("document.getElementById('trail').textContent"), /判官如何理解任务/)
  assert.match(await evaluate("document.getElementById('trail').textContent"), /修复解析器并保留断言/)
  assert.match(await evaluate("document.getElementById('trail').textContent"), /模型执行/)
  assert.match(await evaluate("document.getElementById('trail').textContent"), /规则共 1 条 · 已回答 1 · 未完成或无效 0/)
  assert.match(await evaluate("document.getElementById('trail').textContent"), /event:2/)
  await evaluate("document.querySelector('#trail [data-evidence]').click()")
  await until(async () => await evaluate("document.querySelector('#trail [data-evidence-body]')?.dataset.loaded === '1'"), 'full evidence was not loaded')
  assert.match(await evaluate("document.querySelector('#trail [data-evidence-body]').textContent"), /保留所有断言/)
  // The bulk button is visible without expanding the three idle skills below.
  await evaluate("document.querySelector('[data-view=skills]').click()")
  assert.equal(await evaluate("document.querySelectorAll('#skills .sk[data-state=ready]').length"), 60)
  assert.equal(await evaluate("[...document.querySelectorAll('#skills .sk')].some((el) => el.textContent.includes('zz-standby'))"), false)
  assert.match(await evaluate("document.getElementById('compile-title').textContent"), /^用到的 60 个 skill 都已就绪$/)
  assert.match(await evaluate("document.getElementById('idle-title').textContent"), /^其余 3 个 skill 还没用到，用到时自动准备$/)
  assert.equal(await evaluate("document.getElementById('prepare-all').hidden"), false)
  assert.equal(await evaluate("document.getElementById('prepare-all').textContent"), '一键全部准备（3）')
  assert.equal(await evaluate("document.querySelector('#compile-meter .m-work').style.width"), '0%')
  assert.match(await evaluate("document.querySelector('#skills .sk').textContent"), /2 条规则/)
  await evaluate("document.querySelector('[data-view=topology]').click()")
  assert.equal(await evaluate("document.querySelectorAll('#graph .node').length"), 199)
  assert.equal(await evaluate("document.querySelectorAll('#graph .edge.contains').length"), 120)
  assert.ok(await evaluate("document.querySelectorAll('#graph line[marker-end]').length > 0"))
  await evaluate("document.getElementById('graph-skill').value='skill-0'; document.getElementById('graph-skill').dispatchEvent(new Event('change'))")
  assert.equal(await evaluate("document.querySelectorAll('#graph .node').length"), 19)
  await evaluate("document.querySelectorAll('#graph .node')[17].dispatchEvent(new MouseEvent('click', {bubbles:true}))")
  assert.match(await evaluate("document.getElementById('detail-body').textContent"), /出处skill-0\/SKILL\.md 第 [23] 行/)
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
  // Preparing the waiting skill from the panel shows its progress in plain words.
  held = {}
  held.promise = new Promise((resolve) => { held.release = resolve })
  await evaluate("document.querySelector('[data-view=skills]').click()")
  await evaluate("document.querySelector('#idle-list .idle-item button').click()")
  await until(async () => await evaluate("document.querySelector('#skills .sk[data-state=compiling]')?.textContent.includes('zz-standby') === true"), 'the prepared skill did not show as in progress')
  const working = await evaluate("document.querySelector('#skills .sk[data-state=compiling]').textContent")
  assert.match(working, /准备中/)
  assert.match(working, /0%/)
  assert.match(await evaluate("document.getElementById('compile-title').textContent"), /^正在准备 1 个 skill，60 个已就绪$/)
  for (const text of [working, await evaluate("document.getElementById('compile-sub').textContent")]) {
    assert.doesNotMatch(text, /并行|并发|段|排队|探测/, 'no internal numbers on the panel')
  }
  held.release()
  await until(async () => await evaluate("document.querySelectorAll('#skills .sk[data-state=ready]').length === 61"), 'the prepared skill did not finish')
  // One click prepares both remaining skills through the real HTTP route.
  held = {}
  held.promise = new Promise((resolve) => { held.release = resolve })
  assert.equal(await evaluate("document.getElementById('prepare-all').textContent"), '一键全部准备（2）')
  await evaluate("document.getElementById('prepare-all').click()")
  await until(async () => await evaluate("document.querySelectorAll('#skills .sk').length === 63 && document.getElementById('prepare-all').hidden"), 'bulk preparation did not include every remaining skill')
  assert.equal(await evaluate("document.getElementById('idle-skills').hidden"), true)
  assert.equal(await evaluate("document.querySelectorAll('#skills .sk[data-state=ready]').length"), 61, 'existing results remain ready')
  assert.match(await evaluate("document.getElementById('compile-title').textContent"), /^正在准备 2 个 skill，61 个已就绪$/)
  held.release()
  await until(async () => await evaluate("document.querySelectorAll('#skills .sk[data-state=ready]').length === 63"), 'bulk preparation did not finish')
  // Recreate all compiler state, as a process restart would, and reload the panel.
  await settleCompiles(state, agent)
  await stopCompiles(state)
  const callsBeforeRestart = modelCalls
  state.compileJobs = undefined
  state.skillViews = new WeakMap()
  state.graphs.clear()
  const resumed = { session: { id: 's1', header: { cwd: root } }, options: {} }
  state.agentBySession = new Map([['s1', resumed]])
  state.liveAgents = new Set([resumed])
  await refreshSkills({ get }, state, resumed, { wait: true })
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/eng-protocol?sessionId=s1&view=skills` })
  await until(async () => await evaluate("document.querySelectorAll('#skills .sk[data-state=ready]').length === 63"), 'prepared skills disappeared after restart')
  assert.equal(await evaluate("document.getElementById('prepare-all').hidden"), true)
  assert.equal(await evaluate("document.getElementById('idle-skills').hidden"), true)
  assert.equal(modelCalls, callsBeforeRestart, 'restart reuses cached compiles without any model call')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await sleep(250)
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'mobile page should not overflow')
  assert.deepEqual(errors, [])
  if (process.env.ENG_PROTOCOL_SCREENSHOT) {
    await evaluate("document.getElementById('view-skills').scrollIntoView()")
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.ENG_PROTOCOL_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
  }
  console.log('ok - real Chromium: 60 skills, directed topology, filter, source details, settings save, single and bulk preparation, restart recovery without model calls, mobile layout, no JS errors')
} finally {
  held?.release?.()
  if (socket?.readyState === WebSocket.OPEN) { await send('Browser.close').catch(() => {}); socket.close() }
  if (browser.exitCode === null) browser.kill()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await stopCompiles(state)
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
