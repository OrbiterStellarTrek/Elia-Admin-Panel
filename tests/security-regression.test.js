import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import net from "node:net"
import vm from "node:vm"
import { spawn as realSpawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { pathToFileURL, fileURLToPath } from "node:url"
import WebSocket from "ws"
import YAML from "yaml"
import * as network from "../src/network-policy.js"

const panel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const timeout = promise => Promise.race([promise, delay(6000).then(() => { throw Error("测试等待超时") })])

test("隔离真实 HTTP/WS 回归：鉴权、轮换、SSRF、并发安装和保存冲突", { timeout: 120_000 }, async t => {
  const previousCwd = process.cwd(), previousBot = global.Bot, previousLogger = global.logger
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "elia-security-regression-"))
  const sockets = new Set(), logs = [], cloneWaiters = []
  const devMode = process.env.PANEL_SECURITY_DEV === "1"
  let module, tcpServer, devChild, pauseClones = false, failClone = false, localConnections = 0
  const mockSpawn = (command, args) => {
    if (devMode && command === process.execPath && args.includes("dev")) {
      devChild = realSpawn(command, args, { cwd: path.join(fixture, "frontend"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } })
      return devChild
    }
    assert.equal(command, "git", "隔离测试不会运行 pnpm 或真实 Bot 操作")
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit("close", 1)
    const finish = async () => {
      if (args.includes("clone")) {
        const target = args.at(-1)
        assert.ok(target.startsWith(path.join(fixture, "data/elia-admin-panel/install-staging") + path.sep))
        await fs.mkdir(target, { recursive: true })
        await fs.writeFile(path.join(target, "index.js"), "export default {}\n")
        if (failClone) { child.stderr.write("模拟 clone 失败"); child.emit("close", 1); return }
      }
      child.emit("close", 0)
    }
    if (args.includes("clone") && pauseClones) cloneWaiters.push(finish)
    else setImmediate(() => void finish())
    return child
  }
  const wsConnect = (url, options = {}) => new Promise(resolve => {
    const ws = new WebSocket(url, options); sockets.add(ws)
    const timer = setTimeout(() => { ws.terminate(); resolve({ ws, status: 0 }) }, 5000)
    const finish = status => { clearTimeout(timer); resolve({ ws, status }) }
    ws.on("error", () => finish(0)); ws.once("open", () => finish(101))
    ws.once("unexpected-response", (_req, response) => { response.resume(); finish(response.statusCode); ws.terminate() })
  })
  try {
    for (const folder of ["plugins/EliaAdminPanel", "plugins/example", "config/config", "config/default_config", "data/elia-admin-panel", "logs"]) await fs.mkdir(path.join(fixture, folder), { recursive: true })
    await fs.writeFile(path.join(fixture, "package.json"), '{"type":"module"}')
    await fs.writeFile(path.join(fixture, "config/config/other.yaml"), "# 保留注释\nmasterQQ: [10001]\n")
    await fs.writeFile(path.join(fixture, "logs/command.log"), "隔离日志\n")
    await fs.writeFile(path.join(fixture, "plugins/EliaAdminPanel/elia.support.js"), `export { supportPanel } from ${JSON.stringify(pathToFileURL(path.join(panel, "elia.support.js")).href)}\n`)
    if (devMode) {
      await fs.mkdir(path.join(fixture, "frontend/pages"), { recursive: true })
      await fs.writeFile(path.join(fixture, "frontend/package.json"), '{"name":"isolated-next-security","private":true}')
      await fs.writeFile(path.join(fixture, "frontend/pages/index.js"), "export default function Page() { return null }\n")
      await fs.symlink(path.join(panel, "node_modules"), path.join(fixture, "frontend/node_modules"), "junction")
    }
    const port = await new Promise(resolve => { const server = net.createServer().listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)) }) })
    const password = crypto.randomBytes(24).toString("hex"), salt = crypto.randomBytes(16)
    const configFile = path.join(fixture, "data/elia-admin-panel/config.yaml")
    await fs.writeFile(configFile, YAML.stringify({ host: "127.0.0.1", port, devMode, trustedProxies: ["127.0.0.1/32"], loginImageApi: "https://images.example.test/random", passwordSalt: salt.toString("hex"), passwordHash: crypto.pbkdf2Sync(password, salt, 310_000, 32, "sha256").toString("hex"), passwordIterations: 310_000 }))
    const cfg = { config: {}, bot: {}, getConfig() { return {} }, getGroup() { return {} } }
    global.Bot = { uin: [], fl: new Map(), gl: new Map() }
    global.logger = Object.fromEntries(["mark", "warn", "error", "info"].map(level => [level, message => logs.push(String(message))]))
    process.chdir(fixture)
    const serverFile = path.join(panel, "src/server.js"), code = await fs.readFile(serverFile, "utf8")
    const extra = `
export function resetAttempts() { loginAttempts.clear(); }
export function attemptCounts() { return [...loginAttempts.values()].map(v => v.count); }
export function stopSessions() { sessions.clear(); }
export async function reloadSessions() { sessions.clear(); await loadPersistedSessions(); }
export { issueSession, verifyPanelPassword, sendLogPacket };
export async function stopFixture() { configEvents.removeListener("changed", applySecurityConfig); logDirectoryWatcher?.close(); for(const timer of logWatchTimers.values()) clearTimeout(timer); clearInterval(logHeartbeatTimer); for(const socket of logWebSocketServer?.clients || []) socket.terminate(); for(const socket of devConnections.keys()) socket.destroy(); logWebSocketServer?.close(); stopNextDevServer(); if(expressServer) await new Promise(resolve => expressServer.close(resolve)); }
`
    module = new vm.SourceTextModule(code + extra, { identifier: pathToFileURL(serverFile).href, initializeImportMeta(meta) { meta.url = pathToFileURL(serverFile).href }, importModuleDynamically: specifier => import(specifier) })
    await module.link(async specifier => {
      let imported
      if (specifier.endsWith("lib/config/config.js")) imported = { default: cfg }
      else if (specifier.endsWith("lib/plugins/loader.js")) imported = { default: { priority: [], checkDisable() { return true }, async deal() {} } }
      else if (specifier === "node:child_process") imported = { spawn: mockSpawn }
      else if (specifier === "./network-policy.js") imported = { ...network, secureGitTransport: (url, options, policy) => network.secureGitTransport(url, options, policy, input => network.resolvePublicUrl(input, { lookup: async () => [{ address: "8.8.8.8", family: 4 }] })) }
      else imported = await import(specifier.startsWith(".") ? new URL(specifier, pathToFileURL(serverFile)).href : specifier)
      const names = Object.keys(imported)
      return new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, imported[name]) })
    })
    await module.evaluate(); await module.namespace.startAdminPanel()
    const base = `http://127.0.0.1:${port}`, wsBase = base.replace("http:", "ws:")
    const call = async (url, body, cookie = "", method = body === undefined ? "GET" : "POST", headers = {}) => {
      const response = await fetch(base + url, { method, signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const data = await response.json().catch(() => ({}))
      return { status: response.status, data, cookie: response.headers.get("set-cookie") }
    }
    const login = await call("/api/auth/login", { password }); assert.equal(login.status, 200)
    let cookie = login.cookie.split(";")[0]
    const loginStatus = await call("/api/auth/status")
    assert.equal(loginStatus.status, 200)
    assert.equal(loginStatus.data.loginImageApi, "https://images.example.test/random")
    await t.test("全部业务路由与日志 WS 拒绝未登录，完整跨站来源被拒绝", async () => {
      let routes = 0
      for (const match of code.slice(code.indexOf('app.use("/api", requireAuth)')).matchAll(/app\.(get|post|put|patch)\(("[^"]+"|\[[^\]]+\])/g)) for (const route of match[2].matchAll(/"([^"]+)"/g)) {
        const method = match[1].toUpperCase(), endpoint = route[1].replace(/:[A-Za-z]+/g, "fixture")
        assert.equal((await call(endpoint, method === "GET" ? undefined : {}, "", method)).status, 401, endpoint); routes++
      }
      assert.equal(routes, 36)
      assert.equal((await call("/api/files/read?path=package.json", undefined, cookie, "GET", { origin: "https://attacker.invalid" })).status, 403)
      assert.equal((await wsConnect(wsBase + "/api/logs/ws")).status, 401)
      assert.equal((await wsConnect(wsBase + "/api/logs/ws", { headers: { cookie, origin: "https://attacker.invalid" } })).status, 403)
    })
    await t.test("可信 HTTPS 转发带 Secure，不可信转发头不能伪造", async () => {
      assert.ok(!login.cookie.includes("; Secure"))
      assert.ok((await call("/api/auth/login", { password }, "", "POST", { "x-forwarded-proto": "https" })).cookie.includes("; Secure"))
    })
    await t.test("24 次同源并发最多 10 次预占、最多 4 个 KDF，计数没有丢失", async () => {
      module.namespace.resetAttempts()
      const responses = await Promise.all(Array.from({ length: 24 }, () => call("/api/auth/login", { password: "错误密码" })))
      assert.ok(responses.filter(value => value.status === 401).length <= 4)
      assert.ok(responses.filter(value => value.status === 429).length >= 20)
      assert.deepEqual(Array.from(module.namespace.attemptCounts()), [10])
      module.namespace.resetAttempts()
    })
    await t.test("JS 和头像回环下载拒绝在 TCP 连接之前", async () => {
      tcpServer = net.createServer(socket => { localConnections++; socket.destroy() })
      await new Promise(resolve => tcpServer.listen(0, "127.0.0.1", resolve))
      const localPort = tcpServer.address().port
      for (const host of ["127.0.0.1", "localhost", "2130706433", "0x7f000001"]) assert.equal((await call("/api/plugins/install-script", { name: "audit.js", url: `https://${host}:${localPort}/a.js` }, cookie)).status, 400)
      let avatarCalls = 0, receivedAvatarBytes = 0
      global.Bot.uin = [10001]; global.Bot[10001] = { uin: 10001, setAvatar(value) { avatarCalls++; receivedAvatarBytes = Buffer.from(value.slice("base64://".length), "base64").byteLength; return true } }
      assert.equal((await call("/api/accounts/10001/profile", { field: "avatar", value: `https://127.0.0.1:${localPort}/a.png` }, cookie, "PATCH")).status, 400)
      assert.equal(avatarCalls, 0); assert.equal(localConnections, 0)
      const maxAvatarBytes = 1_500_000
      const atLimit = `base64://${Buffer.alloc(maxAvatarBytes).toString("base64")}`
      assert.equal((await call("/api/accounts/10001/profile", { field: "avatar", value: atLimit }, cookie, "PATCH")).status, 200)
      assert.equal(receivedAvatarBytes, maxAvatarBytes)
      const overLimit = `base64://${Buffer.alloc(maxAvatarBytes + 1).toString("base64")}`
      assert.equal((await call("/api/accounts/10001/profile", { field: "avatar", value: overLimit }, cookie, "PATCH")).status, 400)
      assert.equal(avatarCalls, 1)
      global.Bot.uin = []; delete global.Bot[10001]
    })
    await t.test("配置和文件版本冲突返回 409，缺版本返回 428，注释被保留", async () => {
      const config = await call("/api/config/other.yaml", undefined, cookie)
      assert.equal(config.status, 200)
      const body = { data: { masterQQ: [20002] }, version: config.data.version }
      assert.equal((await call("/api/config/other.yaml", body, cookie, "PUT")).status, 200)
      assert.equal((await call("/api/config/other.yaml", body, cookie, "PUT")).status, 409)
      assert.ok((await fs.readFile(path.join(fixture, "config/config/other.yaml"), "utf8")).includes("# 保留注释"))
      const file = await call("/api/files/read?path=package.json", undefined, cookie)
      const fileBody = { path: "package.json", content: '{"type":"module","changed":true}', version: file.data.version }
      assert.equal((await call("/api/files/write", fileBody, cookie, "PUT")).status, 200)
      assert.equal((await call("/api/files/write", fileBody, cookie, "PUT")).status, 409)
      assert.equal((await call("/api/files/write", { path: "package.json", content: "{}" }, cookie, "PUT")).status, 428)
    })
    await t.test("配置符号链接、硬链接及 support 父链 junction 被拒绝", async () => {
      await fs.link(path.join(fixture, "config/config/other.yaml"), path.join(fixture, "config/config/hard.yaml"))
      assert.equal((await call("/api/config/hard.yaml", undefined, cookie)).status, 403)
      await fs.unlink(path.join(fixture, "config/config/hard.yaml"))
      await fs.symlink(path.join(fixture, "config/config"), path.join(fixture, "plugins/linked"), "junction")
      assert.equal((await call("/api/plugins/linked/config", undefined, cookie)).status, 403)
      assert.equal((await call("/api/plugins/EliaAdminPanel/action", { action: "constructor" }, cookie)).status, 404)
    })
    await t.test("日志连接预算、8 KiB 载荷和推送背压", async () => {
      const connections = await Promise.all(Array.from({ length: 4 }, () => wsConnect(wsBase + "/api/logs/ws", { headers: { cookie } })))
      assert.ok(connections.every(value => value.status === 101))
      assert.equal((await wsConnect(wsBase + "/api/logs/ws", { headers: { cookie } })).status, 429)
      const oversizedClosed = new Promise(resolve => connections[0].ws.once("close", resolve))
      connections[0].ws.send("x".repeat(8193))
      assert.equal(await timeout(oversizedClosed), 1009)
      let closeCode
      module.namespace.sendLogPacket({ logSessionToken: cookie.split("=")[1], bufferedAmount: 1024 * 1024 + 1, close(code) { closeCode = code }, send() { assert.fail("背压时不能继续发送") } }, {})
      assert.equal(closeCode, 4408)
      for (const connection of connections) connection.ws.terminate()
      await delay(30)
    })
    await t.test("密码轮换撤销旧 HTTP/WS/持久会话并阻断在途旧凭据", async () => {
      const connected = await wsConnect(wsBase + "/api/logs/ws", { headers: { cookie } }); assert.equal(connected.status, 101)
      const closed = new Promise(resolve => connected.ws.once("close", resolve))
      const oldVersion = await module.namespace.verifyPanelPassword(password)
      const settings = await call("/api/plugins/EliaAdminPanel/config", undefined, cookie)
      const newPassword = crypto.randomBytes(24).toString("hex")
      const result = await call("/api/plugins/EliaAdminPanel/config", { password: newPassword, _version: settings.data.data._version, _panelVersion: settings.data.version }, cookie, "PUT")
      assert.equal(result.status, 200); assert.equal(result.data.code, 0)
      assert.equal(await timeout(closed), 4401)
      assert.equal((await call("/api/files/read?path=package.json", undefined, cookie)).status, 401)
      await module.namespace.reloadSessions()
      assert.equal((await call("/api/files/read?path=package.json", undefined, cookie)).status, 401)
      await assert.rejects(module.namespace.issueSession({ socket: {}, headers: {} }, { setHeader() {} }, oldVersion), { status: 401 })
      const next = await call("/api/auth/login", { password: newPassword }); assert.equal(next.status, 200)
      cookie = next.cookie.split(";")[0]
      // Guoba uses the same credential save implementation and immediate event.
      const { supportGuoba } = await import("../guoba.support.js")
      const support = supportGuoba(), data = await support.configInfo.getConfigData()
      const changed = await support.configInfo.setConfigData({ ...data, password: newPassword + "2" }, { Result: { ok: (_data, message) => ({ code: 0, message }), error: message => ({ code: -1, message }) } })
      assert.equal(changed.code, 0)
      assert.equal((await call("/api/files/read?path=package.json", undefined, cookie)).status, 401)
      const final = await call("/api/auth/login", { password: newPassword + "2" }); assert.equal(final.status, 200)
      cookie = final.cookie.split(";")[0]
      const oldSecretSocket = await wsConnect(wsBase + "/api/logs/ws", { headers: { cookie } })
      const secretClosed = new Promise(resolve => oldSecretSocket.ws.once("close", resolve))
      const currentData = await support.configInfo.getConfigData()
      assert.equal((await support.configInfo.setConfigData({ ...currentData, secret: crypto.randomBytes(48).toString("hex") }, { Result: { ok: () => ({ code: 0 }), error: message => ({ code: -1, message }) } })).code, 0)
      assert.equal(await timeout(secretClosed), 4401)
      assert.equal((await call("/api/files/read?path=package.json", undefined, cookie)).status, 401)
      const rotatedLogin = await call("/api/auth/login", { password: newPassword + "2" })
      cookie = rotatedLogin.cookie.split(";")[0]
    })
    await t.test("验证码只写私有文件、仅一次有效且没有进入常规日志", async () => {
      assert.equal((await call("/api/auth/code/request", {})).status, 200)
      const text = await fs.readFile(path.join(fixture, "data/elia-admin-panel/credentials/login-code.txt"), "utf8")
      const code = text.match(/验证码 ([A-Za-z0-9_-]+)/)[1]
      assert.ok(logs.every(line => !line.includes(code)))
      assert.equal((await call("/api/auth/code/check", { code })).status, 200)
      assert.equal((await call("/api/auth/code/check", { code })).status, 401)
      assert.equal(await fs.access(path.join(fixture, "data/elia-admin-panel/credentials/login-code.txt")).then(() => true, () => false), false)
    })
    await t.test("同名大小写并发锁和失败 staging 清理不会删除成功插件", async () => {
      pauseClones = true
      const first = call("/api/plugins/install", { url: "https://example.com/a.git", name: "race-fixture" }, cookie)
      while (!cloneWaiters.length) await delay(10)
      const second = await call("/api/plugins/install", { url: "https://example.com/a.git", name: "RACE-FIXTURE" }, cookie)
      assert.equal(second.status, 409); assert.equal(cloneWaiters.length, 1)
      await cloneWaiters.shift()(); assert.equal((await first).status, 200)
      pauseClones = false; failClone = true
      assert.equal((await call("/api/plugins/install", { url: "https://example.com/b.git", name: "failed-fixture" }, cookie)).status, 500)
      assert.ok(await fs.stat(path.join(fixture, "plugins/race-fixture/index.js")))
      assert.deepEqual(await fs.readdir(path.join(fixture, "data/elia-admin-panel/install-staging")), [])
      assert.equal((await call("/api/plugins/install", { url: "https://example.com/a.git", name: "race-fixture." }, cookie)).status, 400)
    })
    await t.test("审计日志仅保存脱敏结构信息", async () => {
      const { flushAudit } = await import("../src/audit.js")
      await flushAudit()
      const text = await fs.readFile(path.join(fixture, "data/elia-admin-panel/audit/events.jsonl"), "utf8")
      assert.ok(!text.includes(password)); assert.ok(!text.includes(cookie)); assert.ok(!text.includes("passwordHash"))
      const events = text.trim().split("\n").map(line => JSON.parse(line))
      assert.ok(events.some(event => event.path === "/api/plugins/install" && event.status === 200))
      assert.ok(events.every(event => event.session.length <= 12 && !Object.hasOwn(event, "body")))
    })
    if (devMode) await t.test("真实 Next 开发接口与 HMR 鉴权、原始 Origin、正常热更新连接", async () => {
      assert.equal((await call("/__nextjs_server_status")).status, 401)
      assert.equal((await call("/__nextjs_devtools_config", { theme: "dark" }, "", "POST", { origin: "https://attacker.invalid" })).status, 403)
      assert.equal((await call("/__nextjs_server_status", undefined, cookie)).status, 200)
      assert.equal((await call("/__nextjs_devtools_config", { theme: "dark" }, cookie)).status, 204)
      assert.equal((await wsConnect(wsBase + "/_next/hmr")).status, 403)
      const anonymousHmr = await wsConnect(wsBase + "/_next/hmr", { headers: { origin: base } })
      assert.equal(anonymousHmr.status, 101)
      anonymousHmr.ws.terminate()
      assert.equal((await wsConnect(wsBase + "/_next/hmr", { headers: { cookie, origin: "https://attacker.invalid" } })).status, 403)
      const hmr = await wsConnect(wsBase + "/_next/hmr", { headers: { cookie, origin: base } })
      assert.equal(hmr.status, 101)
      const close = new Promise(resolve => hmr.ws.once("close", resolve))
      assert.equal((await call("/api/auth/logout", {}, cookie)).status, 200)
      await timeout(close)
    })
  } finally {
    for (const socket of sockets) socket.terminate()
    await module?.namespace.stopFixture?.()
    const { flushAudit } = await import("../src/audit.js")
    await flushAudit()
    if (devChild?.exitCode === null) devChild.kill()
    await new Promise(resolve => tcpServer ? tcpServer.close(resolve) : resolve())
    process.chdir(previousCwd); global.Bot = previousBot; global.logger = previousLogger
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()))
    assert.ok(path.basename(fixture).startsWith("elia-security-regression-"))
    await fs.rm(fixture, { recursive: true, force: true })
  }
})
