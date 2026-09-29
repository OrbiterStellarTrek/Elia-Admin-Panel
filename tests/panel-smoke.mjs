// Run from the Yunzai root: node --experimental-vm-modules plugins/EliaAdminPanel/tests/panel-smoke.mjs
// All writes target an isolated temporary Yunzai workspace; no real Bot config is loaded.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import net from "node:net"
import vm from "node:vm"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"
import puppeteer from "puppeteer"
import YAML from "yaml"
import { getCapApiEndpoint, getCapSiteverifyEndpoint } from "../lib/cap-config.js"

const panel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const capServerUrl = "https://cap-smoke.example.test"
const capSiteKey = "smoke-site-key"
const capApiEndpoint = getCapApiEndpoint({ capServerUrl, capSiteKey }, {})
const capSiteverifyEndpoint = getCapSiteverifyEndpoint(capApiEndpoint)
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "elia-panel-smoke-"))
const originalCwd = process.cwd()
const originalCapSecret = process.env.CAP_SECRET_KEY, originalFetch = globalThis.fetch
let browser
let module
let failures = []
try {
  process.env.CAP_SECRET_KEY = "sk-smoke-test"
  globalThis.fetch = async (input, options) => {
    if (String(input) === capSiteverifyEndpoint) {
      const token = JSON.parse(options.body).response
      const result = token === "smoke-valid-token"
        ? { success: true }
        : { success: false, error: token === "smoke-expired-token" ? "token expired" : "invalid token" }
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } })
    }
    return originalFetch(input, options)
  }
  for (const folder of ["plugins/fixture-support", "plugins/fixture-config/config", "plugins/fixture-empty", "plugins/system", "plugins/other", "plugins/example", "config/config", "data/elia-admin-panel", "logs"] ) await fs.mkdir(path.join(temp, folder), { recursive: true })
  await fs.writeFile(path.join(temp, "package.json"), '{"type":"module"}')
  for (const folder of ["fixture-support", "fixture-config", "fixture-empty"]) await fs.writeFile(path.join(temp, "plugins", folder, "index.js"), "export default {}")
  await fs.writeFile(path.join(temp, "plugins/system/index.js"), "export default {}")
  await fs.writeFile(path.join(temp, "plugins/system/update.js"), "export default {}")
  await fs.writeFile(path.join(temp, "plugins/other/helper.js"), "export default {}")
  await fs.writeFile(path.join(temp, "plugins/fixture-config/config/settings.yaml"), "enabled: true\n")
  await fs.writeFile(path.join(temp, "plugins/fixture-support/package.json"), '{"type":"module","name":"fixture-plugin","dependencies":{"yaml":"^2.8.0"}}')
  await fs.writeFile(path.join(temp, "plugins/fixture-support/elia.support.js"), `
let data = { state: { systemResources: ["CPU", "RAM"] }, tools: { globalBlackList: ["B站"] } }
export function supportPanel() { return { pluginInfo: { title: "设置测试插件" }, configInfo: {
  schemas: [
    { field: "state.systemResources", label: "显示的系统资源", component: "Select", componentProps: { mode: "tags", allowClear: true, options: [ {value:"CPU"}, {value:"RAM"}, {value:"GPU"}, {value:"SWAP"}, {value:"Node"} ] } },
    { field: "tools.globalBlackList", label: "全局解析黑名单", component: "Select", componentProps: { mode: "multiple", options: [ {value:"B站"}, {value:"抖音"} ] } },
  ], getConfigData: () => data, setConfigData: value => { data = { state: { systemResources: value["state.systemResources"] }, tools: { globalBlackList: value["tools.globalBlackList"] } }; return {code:0,message:"已保存"} }
} } }
`)
  const run = promisify(execFile)
  const gitDirectory = path.join(temp, "plugins/fixture-support")
  await run("git", ["init", "-b", "main"], { cwd: gitDirectory, windowsHide: true })
  await run("git", ["add", "."], { cwd: gitDirectory, windowsHide: true })
  await run("git", ["-c", "user.name=Panel Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: gitDirectory, windowsHide: true })
  const cfg = { config: {}, getConfig(name) { return this.config[`config.${name}`] || {} }, getGroup() { return {} }, bot: { ffmpeg_path: "configured-ffmpeg" } }
  cfg.config["config.other"] = { masterQQ: [10001], disableAdopt: [], disablePrivate: true }
  cfg.config["config.group"] = { default: {}, 123: {} }
  for (const name of ["other", "group"]) await fs.writeFile(path.join(temp, `config/config/${name}.yaml`), YAML.stringify(cfg.getConfig(name)))
  const port = await new Promise(resolve => { const server = net.createServer().listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)) }) })
  const password = crypto.randomBytes(20).toString("hex")
  const salt = crypto.randomBytes(16)
  await fs.writeFile(path.join(temp, "data/elia-admin-panel/config.yaml"), YAML.stringify({ host: "127.0.0.1", port, approvedProxyUrls: ["http://127.0.0.1:7890"], capServerUrl, capSiteKey, passwordSalt: salt.toString("hex"), passwordHash: crypto.pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex"), passwordIterations: 100_000 }))
  let numericCalls = 0
  global.Bot = { uin: [1], 1: { adapter: { id: "QQBot" } }, pickGroup() { numericCalls++; throw new Error("官方 Bot 不支持数字群") }, gl: new Map(), fl: new Map([[20002, { nickname: "测试好友", user_id: 20002 }]]) }
  global.logger = Object.fromEntries(["mark", "warn", "error", "info", "debug"].map(level => [level, message => { if (level === "error") failures.push(message) }]))
  const loader = { priority: [{ name: "规则测试", key: "fixture/test.js", event: "message", class: class { rule = [{ reg: "^测试$", fnc: "test" }] } }], checkDisable: () => true }
  process.chdir(temp)
  const serverFile = path.join(panel, "src/server.js")
  const code = await fs.readFile(serverFile, "utf8")
  module = new vm.SourceTextModule(code + `\nexport async function stopFixture() { logDirectoryWatcher?.close(); clearInterval(logHeartbeatTimer); logWebSocketServer?.close(); await new Promise(resolve => expressServer.close(resolve)); }`, { identifier: pathToFileURL(serverFile).href, initializeImportMeta(meta) { meta.url = pathToFileURL(serverFile).href }, importModuleDynamically: specifier => import(specifier) })
  await module.link(async specifier => {
    const imported = specifier.endsWith("lib/config/config.js") ? { default: cfg } : specifier.endsWith("lib/plugins/loader.js") ? { default: loader } : await import(specifier.startsWith(".") ? new URL(specifier, pathToFileURL(serverFile)).href : specifier)
    const names = Object.keys(imported)
    return new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, imported[name]) })
  })
  await module.evaluate()
  await module.namespace.startAdminPanel()
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, "cap-token": "smoke-valid-token" }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get("set-cookie").split(";")[0]
  async function api(url, init = {}) {
    const response = await fetch(base + url, { ...init, headers: { cookie, "content-type": "application/json", ...init.headers } })
    return { status: response.status, data: await response.json() }
  }
  const frontendStatus = await api("/api/frontend/status")
  assert.equal(frontendStatus.status, 200)
  assert.equal(frontendStatus.data.proxyAvailable, true)
  const plugins = (await api("/api/plugins")).data.plugins
  assert.deepEqual(plugins.map(plugin => plugin.id), ["fixture-support", "fixture-config", "fixture-empty"])
  assert.equal((await api("/api/config/group-plugin-names/123")).status, 200)
  assert.equal((await api("/api/config/groups")).status, 200)
  assert.equal((await api("/api/diagnostics/plugin-rules")).status, 200)
  assert.equal(numericCalls, 0)
  const raw = { "content-type": "application/octet-stream" }
  const bytes = Buffer.from([0, 1, 2, 255])
  assert.equal((await api("/api/files/upload?path=plugins/example&name=sample.bin", { method: "POST", headers: raw, body: bytes })).status, 200)
  assert.deepEqual(await fs.readFile(path.join(temp, "plugins/example/sample.bin")), bytes)
  assert.equal((await api("/api/files/upload?path=plugins/example&name=sample.bin", { method: "POST", headers: raw, body: bytes })).status, 409)
  assert.equal((await api("/api/files/upload?path=data/elia-admin-panel&name=bad.txt", { method: "POST", headers: raw, body: bytes })).status, 403)
  assert.equal((await api("/api/files/upload?path=plugins/example&name=..%2Fbad.js", { method: "POST", headers: raw, body: bytes })).status, 400)
  assert.equal((await api("/api/plugins/install-script?name=valid.js", { method: "POST", headers: raw, body: "export default class Example {}" })).status, 200)
  assert.equal((await api("/api/plugins/install-script?name=invalid.js", { method: "POST", headers: raw, body: "export class {" })).status, 400)
  const dependency = { dependencies: { yaml: "^2.8.1" } }
  const missingDependencyVersion = await api("/api/plugins/fixture-support/dependencies", { method: "PUT", body: JSON.stringify({ data: dependency }) })
  assert.equal(missingDependencyVersion.status, 428)
  assert.equal(missingDependencyVersion.data.error, "请重新读取最新内容后保存")
  const dependencyVersion = (await api("/api/plugins/fixture-support/dependencies")).data.version
  assert.equal((await api("/api/plugins/fixture-support/dependencies", { method: "PUT", body: JSON.stringify({ data: dependency, version: dependencyVersion }) })).status, 200)
  assert.equal((await api("/api/plugins/fixture-support/dependencies")).data.data.dependencies.yaml, "^2.8.1")
  assert.equal((await api("/api/plugins/fixture-empty/disable", { method: "POST", body: "{}" })).status, 200)
  const disabled = (await api("/api/plugins/archives")).data.archives[0]
  assert.equal((await api(`/api/plugins/archives/${disabled.id}/restore`, { method: "POST", body: "{}" })).status, 200)
  console.log("接口验证通过：排序、官 Bot 静默、二进制上传、路径保护、JS 语法检查、依赖、禁用及启用")

  browser = await puppeteer.launch({ headless: true })
  const captchaPage = await browser.newPage()
  const captchaErrors = []
  captchaPage.on("pageerror", error => captchaErrors.push(error.message))
  await captchaPage.setViewport({ width: 1440, height: 1000 })
  await captchaPage.goto(base)
  await captchaPage.waitForSelector("cap-widget")
  assert.equal(await captchaPage.$eval("cap-widget", widget => widget.getAttribute("data-cap-api-endpoint")), capApiEndpoint)
  await captchaPage.waitForSelector('[role="tab"]')
  await captchaPage.click('[role="tab"]:nth-child(2)')
  await captchaPage.waitForSelector("#panel-password")
  await captchaPage.type("#panel-password", password)
  const submitSelector = "form button:last-of-type"
  assert.equal(await captchaPage.$eval(submitSelector, button => button.disabled), true)
  async function solveForSmoke(token) {
    await captchaPage.$eval("cap-widget", (widget, value) => widget.dispatchEvent("solve", { token: value }), token)
    await captchaPage.waitForFunction(selector => !document.querySelector(selector)?.disabled, {}, submitSelector)
    await captchaPage.click(submitSelector)
  }
  await solveForSmoke("smoke-invalid-token")
  await captchaPage.waitForFunction(() => document.body.innerText.includes("安全验证未通过"))
  assert.equal(await captchaPage.$eval(submitSelector, button => button.disabled), true)
  await solveForSmoke("smoke-expired-token")
  await captchaPage.waitForFunction(() => document.body.innerText.includes("安全验证已过期"))
  await solveForSmoke("smoke-valid-token")
  await captchaPage.waitForFunction(() => document.body.innerText.includes("运行概览"))
  assert.deepEqual(captchaErrors, [])
  await captchaPage.close()
  console.log("Cap 浏览器登录验证通过：组件加载、缺失/无效/过期拒绝、有效 token 登录")
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await page.setViewport({ width: 1440, height: 1000 })
  await page.setCookie({ name: "elia_panel_session", value: cookie.slice(cookie.indexOf("=") + 1), url: base, httpOnly: true })
  async function clickText(text, selector = "button") {
    try { await page.waitForFunction((text, selector) => [...document.querySelectorAll(selector)].some(node => node.textContent.trim() === text), {timeout: 10000}, text, selector) } catch (error) { console.log("未找到按钮", text, await page.evaluate(() => document.body.innerText.slice(-4500))); console.log("页面错误", errors); throw error }
    const handle = await page.evaluateHandle((text, selector) => [...document.querySelectorAll(selector)].find(node => node.textContent.trim() === text), text, selector)
    await handle.click()
  }
  await page.goto(`${base}/config/?file=other.yaml`)
  await page.waitForSelector('[aria-label="从好友中选择主人 QQ 号"]')
  await page.click('[aria-label="从好友中选择主人 QQ 号"]')
  await page.waitForFunction(() => document.body.innerText.includes("测试好友"))
  await page.click('[role="option"]')
  await clickText("添加所选")
  await page.waitForSelector(".admin-dialog-overlay", {hidden: true})
  await page.waitForFunction(() => document.body.innerText.includes("20002"))
  await page.click('[aria-label="选择私聊放行正则"]')
  await page.waitForSelector('[role="dialog"]')
  await clickText("加入私聊放行")
  await page.click('[aria-label="关闭插件正则排查"]')
  await page.waitForSelector(".admin-dialog-overlay", {hidden: true})
  await page.click('[aria-label="保存更改"]')
  await page.waitForFunction(() => document.body.innerText.includes("已保存并刷新运行时配置"))
  const other = (await api("/api/config/other.yaml")).data.data
  assert.deepEqual(other.masterQQ, [10001, 20002])
  assert.deepEqual(other.disableAdopt, ["^测试$"])
  await page.goto(`${base}/plugins/?plugin=fixture-support`)
  await page.waitForSelector('[role="group"][aria-label="显示的系统资源"]')
  await page.click('[aria-label="显示的系统资源"] button:nth-child(3)')
  await page.click('[aria-label="全局解析黑名单"] button:nth-child(2)')
  await clickText("保存配置")
  await page.waitForFunction(() => document.body.innerText.includes("已保存"))
  const saved = (await api("/api/plugins/fixture-support/config")).data.data
  assert.deepEqual(saved.state.systemResources, ["CPU", "RAM", "GPU"])
  assert.deepEqual(saved.tools.globalBlackList, ["B站", "抖音"])
  const emptyButtons = await page.$$eval('[aria-label="显示的系统资源"] button, [aria-label="全局解析黑名单"] button', nodes => nodes.filter(node => !node.textContent.trim()).length)
  assert.equal(emptyButtons, 0)
  if (process.env.PANEL_SMOKE_SCREENSHOTS) {
    await fs.mkdir(process.env.PANEL_SMOKE_SCREENSHOTS, { recursive: true })
    await page.screenshot({ path: path.join(process.env.PANEL_SMOKE_SCREENSHOTS, "plugin-settings-desktop.png"), fullPage: true })
  }
  await page.setViewport({ width: 390, height: 844 })
  await page.waitForFunction(() => document.querySelector("aside").getBoundingClientRect().right <= 1)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false)
  if (process.env.PANEL_SMOKE_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.PANEL_SMOKE_SCREENSHOTS, "plugin-settings-mobile.png"), fullPage: true })
  await page.setViewport({ width: 1440, height: 1000 })
  await clickText("编辑依赖")
  await page.waitForSelector('[aria-label="依赖 JSON"]')
  await page.click('[role="dialog"] [aria-label="关闭"]')
  await clickText("手动更新")
  await page.waitForSelector('[aria-label="代理类型"]')
  await page.select('[aria-label="代理类型"]', "prefix")
  await page.waitForSelector('[aria-label="代理地址"]')
  await page.type('[aria-label="代理地址"]', "https://gh-proxy.com")
  await clickText("commit")
  assert.match(await page.$eval('[role="dialog"] input[list]', input => input.value), /^[a-f0-9]{40}$/)
  await page.click('[role="dialog"] [aria-label="关闭"]')
  await clickText("安装单 JS 插件")
  await page.waitForSelector('[aria-label="选择 JS 文件"]')
  const scriptFile = path.join(temp, "browser-plugin.js")
  await fs.writeFile(scriptFile, "export default class BrowserPlugin {}")
  await (await page.$('[aria-label="选择 JS 文件"]')).uploadFile(scriptFile)
  const installedResponse = page.waitForResponse(response => response.url().includes("/api/plugins/install-script") && response.request().method() === "POST")
  await clickText("安装")
  assert.equal((await installedResponse).status(), 200)
  assert.ok((await fs.stat(path.join(temp, "plugins/example/browser-plugin.js"))).isFile())
  await page.goto(`${base}/files/?path=plugins/example`)
  await page.waitForSelector('[aria-label="上传文件"]')
  const uploadFile = path.join(temp, "browser-upload.bin")
  await fs.writeFile(uploadFile, bytes)
  const uploadedResponse = page.waitForResponse(response => response.url().includes("/api/files/upload") && response.request().method() === "POST")
  await (await page.$('[aria-label="选择上传文件"]')).uploadFile(uploadFile)
  assert.equal((await uploadedResponse).status(), 200)
  await page.waitForFunction(() => document.body.innerText.includes("browser-upload.bin"))
  await page.setViewport({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
  assert.equal(overflow, false)
  assert.deepEqual(errors, [])
  console.log("浏览器验证通过：主人好友选择、正则加入并保存、多选标签及数组保存、依赖和安装弹窗、移动端上传入口")
  assert.deepEqual(failures, [])
} finally {
  await browser?.close()
  await module?.namespace.stopFixture?.().catch(() => {})
  process.chdir(originalCwd)
  if (originalCapSecret === undefined) delete process.env.CAP_SECRET_KEY
  else process.env.CAP_SECRET_KEY = originalCapSecret
  globalThis.fetch = originalFetch
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temp).startsWith("elia-panel-smoke-"))
  await fs.rm(temp, { recursive: true, force: true })
}
