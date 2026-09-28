// 从 Yunzai 根目录运行：node --experimental-vm-modules plugins/EliaAdminPanel/tests/security-audit.mjs
// 诊断脚本：全部写入临时工作区；真实 Bot/Redis/配置均不加载；Git 使用模拟进程。
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import net from "node:net"
import vm from "node:vm"
import { spawn as realSpawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"
import WebSocket, { Receiver } from "ws"
import YAML from "yaml"
import { gitTransport } from "../src/plugin-management.js"

const panel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const originalCwd = process.cwd()
const originalBot = global.Bot
const originalLogger = global.logger
const originalFetch = global.fetch
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "elia-security-audit-"))
const observations = []
const sockets = new Set()
let module, tcpServer
let cloneWaiters = []
let concurrentInstalls = false
let capturedCode = ""
const devMode = process.env.PANEL_AUDIT_DEV === "1"
let devChild
const observe = (name, result) => { observations.push({ name, ...result }); console.log(JSON.stringify({ name, ...result })) }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const mockSpawn = (command, args) => {
  if (devMode && command === process.execPath && args.includes("dev")) {
    devChild = realSpawn(command, args, { cwd: path.join(fixture, "frontend"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } })
    return devChild
  }
  assert.equal(command, "git", "审计不运行 pnpm、Shell 或其他业务进程")
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => child.emit("close", 1)
  const finish = async code => {
    if (code === 0 && args.includes("clone")) {
      const target = args.at(-1)
      assert.equal(path.dirname(target), path.join(fixture, "plugins"))
      await fs.mkdir(target, { recursive: true })
      await fs.writeFile(path.join(target, "index.js"), "export default {}\n")
    }
    if (code !== 0) child.stderr.write("模拟 clone 失败")
    child.emit("close", code)
  }
  if (args.includes("clone") && concurrentInstalls) cloneWaiters.push(finish)
  else setImmediate(() => void finish(0))
  return child
}

async function wsConnect(url, options = {}) {
  return new Promise(resolve => {
    const ws = new WebSocket(url, options)
    sockets.add(ws)
    const timer = setTimeout(() => { ws.terminate(); resolve({ ws, status: 0 }) }, 5000)
    const finish = status => { clearTimeout(timer); resolve({ ws, status }) }
    ws.on("error", () => finish(0))
    ws.once("open", () => finish(101))
    ws.once("unexpected-response", (_req, response) => { response.resume(); finish(response.statusCode); ws.terminate() })
  })
}

try {
  for (const folder of ["plugins/EliaAdminPanel", "plugins/example", "config/config", "config/default_config", "data/elia-admin-panel", "logs", "node_modules", ".git"]) await fs.mkdir(path.join(fixture, folder), { recursive: true })
  await fs.writeFile(path.join(fixture, "package.json"), '{"type":"module"}')
  if (devMode) {
    await fs.mkdir(path.join(fixture, "frontend/pages"), { recursive: true })
    await fs.writeFile(path.join(fixture, "frontend/package.json"), '{"name":"isolated-next-audit","private":true}')
    await fs.writeFile(path.join(fixture, "frontend/pages/index.js"), "export default function Page() { return null }\n")
    await fs.symlink(path.join(panel, "node_modules"), path.join(fixture, "frontend/node_modules"), "junction")
  }
  await fs.writeFile(path.join(fixture, "config/config/other.yaml"), "masterQQ: [10001]\n")
  await fs.writeFile(path.join(fixture, "node_modules/marker.txt"), "隔离标记")
  await fs.writeFile(path.join(fixture, "logs/command.log"), "<img src=x onerror=alert(1)>\n审计标记\n")
  // 配置模块仍为真实插件代码，但 process.cwd() 指向隔离目录。
  await fs.writeFile(path.join(fixture, "plugins/EliaAdminPanel/elia.support.js"), `export { supportPanel } from ${JSON.stringify(pathToFileURL(path.join(panel, "elia.support.js")).href)}\n`)
  const port = await new Promise(resolve => { const server = net.createServer().listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)) }) })
  const password = crypto.randomBytes(24).toString("hex")
  const salt = crypto.randomBytes(16)
  const configFile = path.join(fixture, "data/elia-admin-panel/config.yaml")
  await fs.writeFile(configFile, YAML.stringify({ host: "127.0.0.1", port, devMode, passwordSalt: salt.toString("hex"), passwordHash: crypto.pbkdf2Sync(password, salt, 310_000, 32, "sha256").toString("hex"), passwordIterations: 310_000 }))
  const cfg = { config: {}, bot: {}, getConfig() { return {} }, getGroup() { return {} } }
  const loader = { priority: [], checkDisable() { return true }, async deal() {} }
  global.Bot = { uin: [], fl: new Map(), gl: new Map() }
  global.logger = Object.fromEntries(["mark", "warn", "error", "info"].map(level => [level, message => { const match = String(message).match(/验证码 ([A-Za-z0-9_-]+)，/); if (match) capturedCode = match[1] }]))
  process.chdir(fixture)
  const serverFile = path.join(panel, "src/server.js")
  const code = await fs.readFile(serverFile, "utf8")
  const extra = `
export function auditState() { return { loginAttempts: [...loginAttempts.values()], sessions: sessions.size }; }
export function resetLoginAttempts() { loginAttempts.clear(); }
export { resolveWorkspacePath, validateRemoteRepository };
export async function stopFixture() { logDirectoryWatcher?.close(); for(const timer of logWatchTimers.values()) clearTimeout(timer); clearInterval(logHeartbeatTimer); for(const socket of logWebSocketServer?.clients || []) socket.terminate(); logWebSocketServer?.close(); await new Promise(resolve => expressServer.close(resolve)); }
`
  module = new vm.SourceTextModule(code + extra, { identifier: pathToFileURL(serverFile).href, initializeImportMeta(meta) { meta.url = pathToFileURL(serverFile).href }, importModuleDynamically: specifier => import(specifier) })
  await module.link(async specifier => {
    const imported = specifier.endsWith("lib/config/config.js") ? { default: cfg } : specifier.endsWith("lib/plugins/loader.js") ? { default: loader } : specifier === "node:child_process" ? { spawn: mockSpawn } : await import(specifier.startsWith(".") ? new URL(specifier, pathToFileURL(serverFile)).href : specifier)
    const names = Object.keys(imported)
    return new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, imported[name]) })
  })
  await module.evaluate()
  await module.namespace.startAdminPanel()
  const base = `http://127.0.0.1:${port}`
  const call = async (url, body, cookie = "", method = body === undefined ? "GET" : "POST", headers = {}) => {
    const response = await originalFetch(base + url, { method, signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const data = await response.json().catch(() => ({}))
    return { status: response.status, data, cookie: response.headers.get("set-cookie"), headers: response.headers }
  }
  if (devMode) {
    // 读取状态并写入临时 Next 项目的 UI 偏好；不调用重启、编辑器或 inspector。
    const status = await call("/__nextjs_server_status")
    observe("开发服务状态接口", { status: status.status, executionIdReturned: Number.isSafeInteger(status.data.executionId) })
    const settingsResponse = await originalFetch(base + "/__nextjs_devtools_config", { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/octet-stream", origin: "https://attacker.invalid" }, body: '{"theme":"dark"}' })
    await settingsResponse.arrayBuffer()
    const savedDevConfig = JSON.parse(await Promise.any([".next/cache", ".next/dev/cache"].map(folder => fs.readFile(path.join(fixture, "frontend", folder, "next-devtools-config.json"), "utf8"))))
    observe("开发服务 HTTP 鉴权边界", { statusWithoutCookie: status.status, crossOriginPreferenceWriteStatus: settingsResponse.status, preferenceActuallySaved: savedDevConfig.theme === "dark", realNextServer: true })
    const hmr = await wsConnect(base.replace("http:", "ws:") + "/_next/webpack-hmr", { headers: { origin: "https://attacker.invalid" } })
    observe("开发服务鉴权边界", { statusWithoutCookie: status.status, crossOriginPreferenceWriteStatus: settingsResponse.status, preferenceActuallySaved: savedDevConfig.theme === "dark", unauthenticatedCrossOriginHmr: hmr.status, realNextServer: true, dangerousDevEndpointsNotInvoked: true })
    hmr.ws.terminate()
  }
  const login = await call("/api/auth/login", { password })
  assert.equal(login.status, 200)
  const cookie = login.cookie.split(";")[0]
  observe("Cookie 传输属性", { httpOnly: login.cookie.includes("HttpOnly"), sameSiteStrict: login.cookie.includes("SameSite=Strict"), secureOnHttp: login.cookie.includes("; Secure") })
  const proxyLogin = await call("/api/auth/login", { password }, "", "POST", { "x-forwarded-proto": "https" })
  observe("HTTPS 反向代理 Cookie", { status: proxyLogin.status, secure: proxyLogin.cookie.includes("; Secure") })

  // 从源代码提取每个实际业务路由，使用无身份请求检查统一中间件覆盖。
  const businessSource = code.slice(code.indexOf('app.use("/api", requireAuth)'))
  const routeRows = []
  for (const match of businessSource.matchAll(/app\.(get|post|put|patch)\(("[^"]+"|\[[^\]]+\])/g)) {
    const method = match[1].toUpperCase()
    for (const route of match[2].matchAll(/"([^"]+)"/g)) {
      const endpoint = route[1].replace(/:name/g, "other.yaml").replace(/:archiveId/g, "fixture--1").replace(/:groupId/g, "default").replace(/:token/g, "fixture").replace(/:id/g, "fixture")
      const result = await call(endpoint, method === "GET" ? undefined : {}, "", method)
      routeRows.push({ method, route: route[1], status: result.status })
    }
  }
  assert.ok(routeRows.every(row => row.status === 401))
  observe("业务路由无身份访问", { routes: routeRows.length, allRejected: true, details: routeRows })
  const variants = []
  for (const endpoint of ["/API/files/read?path=package.json", "/api//files/read?path=package.json", "/api%2ffiles/read?path=package.json", "/%61pi/files/read?path=package.json", "/api/files/read/?path=package.json"]) {
    const result = await call(endpoint)
    variants.push({ endpoint, status: result.status, leakedContent: Object.hasOwn(result.data, "content") })
  }
  observe("API 路径变体", { variants })
  observe("跨站来源拒绝", { status: (await call("/api/files/read?path=package.json", undefined, cookie, "GET", { origin: "https://attacker.invalid" })).status })
  const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A")
  observe("篡改 Cookie", { status: (await call("/api/files/read?path=package.json", undefined, tampered)).status })

  const paths = []
  for (const candidate of ["../outside.txt", "data/elia-admin-panel/config.yaml", "DATA/ELIA-ADMIN-PANEL/config.yaml", "data/elia-admin-panel./config.yaml", "data/elia-admin-panel /config.yaml", "data/ELIA-A~1/config.yaml", "node_modules/marker.txt", "node_modules./marker.txt", "NODE_M~1/marker.txt"]) {
    const result = await call(`/api/files/read?path=${encodeURIComponent(candidate)}`, undefined, cookie)
    paths.push({ path: candidate, status: result.status, contentReturned: Object.hasOwn(result.data, "content") })
  }
  observe("工作区与 Windows 别名边界", { platform: process.platform, paths })
  const link = path.join(fixture, "linked-config")
  await fs.symlink(path.join(fixture, "data/elia-admin-panel"), link, "junction")
  observe("目录链接拒绝", { status: (await call("/api/files/read?path=linked-config/config.yaml", undefined, cookie)).status })

  // 上限仅 24 次，不进行负载压力测试或耗尽生产进程。
  module.namespace.resetLoginAttempts()
  const started = Date.now()
  const concurrent = await Promise.all(Array.from({ length: 24 }, () => call("/api/auth/login", { password: "审计错误密码" })))
  const counts = concurrent.reduce((result, row) => { result[row.status] = (result[row.status] || 0) + 1; return result }, {})
  observe("并发密码限流", { requests: 24, statuses: counts, storedAttempts: module.namespace.auditState().loginAttempts, elapsedMs: Date.now() - started })
  module.namespace.resetLoginAttempts()
  const sequential = []
  for (let i = 0; i < 11; i++) sequential.push((await call("/api/auth/login", { password: "审计错误密码" })).status)
  observe("顺序密码限流", { statuses: sequential })
  module.namespace.resetLoginAttempts()

  // 真实业务入口到本机 TCP 监听；TLS 握手后断开，不读取任何真实内网服务。
  let localConnections = 0
  tcpServer = net.createServer(socket => { localConnections++; socket.on("error", () => {}); socket.once("data", () => socket.destroy()) })
  await new Promise(resolve => tcpServer.listen(0, "127.0.0.1", resolve))
  const localPort = tcpServer.address().port
  const ssrf = []
  for (const host of ["127.0.0.1", "localhost", "2130706433", "0x7f000001"]) {
    const before = localConnections
    const result = await call("/api/plugins/install-script", { name: "audit.js", url: `https://${host}:${localPort}/audit.js` }, cookie)
    ssrf.push({ inputHost: host, normalizedHost: new URL(`https://${host}/`).hostname, status: result.status, tcpReached: localConnections > before })
  }
  observe("单 JS 下载 SSRF", { probes: ssrf, note: "500 为主动中断 TLS 的预期结果；tcpReached 证明已进入服务端网络请求" })
  const rootRequire = createRequire(path.join(originalCwd, "package.json"))
  const { Client } = rootRequire("icqq")
  let adapterCalls = 0
  global.Bot.uin = [10001]
  global.Bot[10001] = { uin: 10001, adapter: { id: "icqq" }, nickname: "隔离账号", setAvatar: Client.prototype.setAvatar, sendUni() { adapterCalls++; throw new Error("禁止真实账号 API 调用") } }
  const beforeAvatar = localConnections
  const avatar = await call("/api/accounts/10001/profile", { field: "avatar", value: `https://127.0.0.1:${localPort}/avatar.png` }, cookie, "PATCH")
  observe("头像下载 SSRF", { status: avatar.status, tcpReached: localConnections > beforeAvatar, realIcqqSetAvatar: true, realAccountApiCalls: adapterCalls })
  global.Bot.uin = []
  delete global.Bot[10001]
  const urlChecks = []
  global.fetch = async url => { urlChecks.push(new URL(url).hostname); return new Response("export default {}", { headers: { "content-type": "application/javascript" } }) }
  const { downloadScript } = await import("../src/plugin-management.js")
  for (const host of ["[::1]", "0.0.0.0", "10.0.0.1", "169.254.169.254"]) await downloadScript(`https://${host}/audit.js`, 1024)
  global.fetch = originalFetch
  observe("其他 URL 地址过滤", { acceptedWithoutNetwork: urlChecks, proxyTarget: gitTransport("https://example.com/a.git", { proxyMode: "prefix", proxy: "https://127.0.0.1:4443" }).url, gitDnsNamesAccepted: ["internal.example", "localhost.", "metadata.google.internal"].map(host => { try { module.namespace.validateRemoteRepository(`https://${host}/audit.git`); return host } catch { return null } }).filter(Boolean) })

  const deniedWs = await wsConnect(base.replace("http:", "ws:") + "/api/logs/ws")
  const crossWs = await wsConnect(base.replace("http:", "ws:") + "/api/logs/ws", { headers: { cookie, origin: "https://attacker.invalid" } })
  const validWs = await wsConnect(base.replace("http:", "ws:") + "/api/logs/ws", { headers: { cookie } })
  const packetPromise = new Promise(resolve => validWs.ws.once("message", raw => resolve(JSON.parse(raw.toString()))))
  validWs.ws.send(JSON.stringify({ type: "subscribe", file: "command.log" }))
  const packet = await packetPromise
  observe("日志 WebSocket", { unauthenticated: deniedWs.status, crossOrigin: crossWs.status, authenticated: validWs.status, escapedByFrontend: true, rawMarkupReturnedAsText: packet.entries.some(row => row.text.startsWith("<img")) })

  const oversizedWs = await wsConnect(base.replace("http:", "ws:") + "/api/logs/ws", { headers: { cookie } })
  const oversizedClosed = new Promise(resolve => oversizedWs.ws.once("close", code => resolve(code)))
  oversizedWs.ws.send("x".repeat(8193))
  observe("WebSocket 载荷限制", { bytes: 8193, closeCode: await oversizedClosed })

  // 修改密码只影响隔离配置；旧会话及旧连接是否撤销。
  const newPassword = crypto.randomBytes(24).toString("hex")
  const changed = await call("/api/plugins/EliaAdminPanel/config", { password: newPassword }, cookie, "PUT")
  const afterRotation = await call("/api/files/read?path=package.json", undefined, cookie)
  const wsAfterRotation = new Promise(resolve => validWs.ws.once("message", () => resolve(true)))
  validWs.ws.send(JSON.stringify({ type: "catchup" }))
  observe("密码轮换后旧会话", { changeStatus: changed.status, changeAccepted: changed.data.code === 0, oldCookieStatus: afterRotation.status, oldWsStillReceives: await wsAfterRotation })
  const logoutWs = new Promise(resolve => validWs.ws.once("close", code => resolve(code)))
  await call("/api/auth/logout", {}, cookie)
  validWs.ws.send(JSON.stringify({ type: "catchup" }))
  observe("注销撤销", { oldCookieStatus: (await call("/api/files/read?path=package.json", undefined, cookie)).status, wsCloseCode: await logoutWs })
  const newLogin = await call("/api/auth/login", { password: newPassword })
  const newCookie = newLogin.cookie.split(";")[0]
  const codeRequest = await call("/api/auth/code/request", {})
  assert.ok(capturedCode)
  const codeLogin = await call("/api/auth/code/check", { code: capturedCode })
  const codeAgain = await call("/api/auth/code/check", { code: capturedCode })
  observe("一次性验证码", { requestStatus: codeRequest.status, firstUse: codeLogin.status, secondUse: codeAgain.status, leakedInResponse: JSON.stringify(codeRequest.data).includes(capturedCode) })
  const quick = await module.namespace.createQuickLoginLinks()
  const quickCode = quick.links[0].split("/").at(-1)
  observe("一次性快捷登录", { firstUse: (await call("/api/auth/quick", { code: quickCode })).status, secondUse: (await call("/api/auth/quick", { code: quickCode })).status })

  // 两个 clone 都在 fs.access 之后暂停，精确再现删除其他请求安装结果的竞态。
  concurrentInstalls = true
  const installBody = { url: "https://example.com/audit.git", name: "race-fixture" }
  const first = call("/api/plugins/install", installBody, newCookie)
  const second = call("/api/plugins/install", installBody, newCookie)
  const deadline = Date.now() + 3000
  while (cloneWaiters.length < 2 && Date.now() < deadline) await delay(10)
  assert.equal(cloneWaiters.length, 2)
  await cloneWaiters[0](0)
  const success = await first
  await cloneWaiters[1](1)
  const failure = await second
  const existsAfter = await fs.access(path.join(fixture, "plugins/race-fixture")).then(() => true, () => false)
  observe("插件安装竞争清理", { firstStatus: success.status, secondStatus: failure.status, successfulPluginStillExists: existsAfter, gitAndNetworkMocked: true })

  // 验证有限碎片结构，不执行 OOM。
  const receiver = new Receiver({ isServer: false, maxPayload: 8192 })
  for (let i = 0; i < 256; i++) await new Promise((resolve, reject) => receiver.write(Buffer.from([i === 0 ? 0x02 : 0x00, 0x01, 0x61]), error => error ? reject(error) : resolve()))
  observe("ws 有限碎片验证", { payloadBytes: receiver._totalPayloadLength, retainedFragmentBuffers: receiver._fragments.length, configuredMaxPayload: 8192, noOomTest: true })
  receiver.destroy()

  // 原型污染与 React 转义：使用项目真实函数源码，数据均为隔离标记。
  const dashboard = await fs.readFile(path.join(panel, "components/dashboard.tsx"), "utf8")
  const nestedSource = dashboard.slice(dashboard.indexOf("function setNested("), dashboard.indexOf("function getNested("))
    .replace("value: any, path: string[], next: any): any", "value, path, next)")
  const setNested = vm.runInNewContext(`(${nestedSource})`)
  const nested = setNested({}, ["__proto__", "auditMarker"], true)
  observe("前端递归赋值原型边界", { objectPrototypePolluted: ({}).auditMarker === true, ownObjectInheritsMarker: nested.auditMarker === true, note: "仅新对象原型受影响，未证实全局 Object.prototype 污染或可利用链" })
  const panelRequire = createRequire(path.join(panel, "package.json"))
  const React = panelRequire("react")
  const { renderToStaticMarkup } = panelRequire("react-dom/server")
  observe("React 日志转义", { markupEscaped: renderToStaticMarkup(React.createElement("span", null, "<img src=x onerror=alert(1)>")).includes("&lt;img") })

  // 宿主日志代码在同一临时 cwd 下运行，只记录无敏感含义的验证标记。
  const logFile = path.join(originalCwd, "lib/config/log.js")
  const logModule = new vm.SourceTextModule(await fs.readFile(logFile, "utf8"), { identifier: pathToFileURL(logFile).href })
  let log4js
  await logModule.link(async specifier => {
    const imported = specifier === "./config.js" ? { default: { bot: { log_level: "info" } } } : await import(specifier)
    if (specifier === "log4js") log4js = imported.default
    const names = Object.keys(imported)
    return new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, imported[name]) })
  })
  await logModule.evaluate()
  logModule.namespace.default()
  global.logger.mark("AUDIT_BOOTSTRAP_CREDENTIAL_MARKER")
  global.logger.warn("AUDIT_LOGIN_CODE_MARKER")
  await new Promise(resolve => log4js.shutdown(resolve))
  const persistedLogs = (await fs.readdir(path.join(fixture, "logs"))).filter(name => name.startsWith("command."))
  const persistedText = (await Promise.all(persistedLogs.map(name => fs.readFile(path.join(fixture, "logs", name), "utf8")))).join("\n")
  observe("控制台凭据日志实际落盘", { bootstrapMarkerPersisted: persistedText.includes("AUDIT_BOOTSTRAP_CREDENTIAL_MARKER"), loginCodeMarkerPersisted: persistedText.includes("AUDIT_LOGIN_CODE_MARKER"), realHostLoggerConfiguration: true })
  console.log(JSON.stringify({ 完成: true, 观测数量: observations.length, 安全边界: "所有业务写入在临时目录；仅本机自建 TCP 监听；没有真实插件安装或 Bot 操作" }))
} finally {
  global.fetch = originalFetch
  for (const socket of sockets) socket.terminate()
  if (devChild?.pid && devChild.exitCode === null && process.platform === "win32") await promisify(execFile)("taskkill", ["/PID", String(devChild.pid), "/T", "/F"], { windowsHide: true }).catch(() => {})
  await module?.namespace.stopFixture?.()
  await new Promise(resolve => tcpServer ? tcpServer.close(resolve) : resolve())
  global.Bot = originalBot
  global.logger = originalLogger
  process.chdir(originalCwd)
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()))
  assert.ok(path.basename(fixture).startsWith("elia-security-audit-"))
  await fs.rm(fixture, { recursive: true, force: true })
}
