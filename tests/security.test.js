import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import vm from "node:vm"
import { fakeDownload } from "./download-fixture.js"
import { approvedFrontendProxy, isPublicAddress, normalizeNetworkUrl, resolvePublicUrl, safeDownload, secureGitTransport } from "../src/network-policy.js"
import { contentVersion, credentialVersion, requireVersion, trustedProxy, redact, withLock, withBudget, devRequestNeedsAuth, originAllowed, requestIsSecure } from "../src/security.js"

test("内容版本、凭据版本和乐观并发版本校验", () => {
  assert.equal(contentVersion("same"), contentVersion("same"))
  assert.notEqual(contentVersion("same"), contentVersion("changed"))
  const config = { host: "127.0.0.1", passwordSalt: "salt", passwordHash: "hash", passwordIterations: 1000, secret: "secret" }
  assert.equal(credentialVersion(config), credentialVersion({ ...config, host: "panel.example" }))
  assert.notEqual(credentialVersion(config), credentialVersion({ ...config, secret: "rotated" }))
  requireVersion("version-1", "version-1")
  assert.throws(() => requireVersion(undefined, "version-1"), { status: 428 })
  assert.throws(() => requireVersion("version-0", "version-1"), { status: 409 })
})

test("可信代理匹配 IPv4/IPv6 CIDR，拒绝无效配置并脱敏日志", () => {
  assert.equal(trustedProxy("192.168.1.4", ["192.168.1.0/24"]), true)
  assert.equal(trustedProxy("2001:db8::1", ["2001:db8::/32"]), true)
  assert.equal(trustedProxy("::ffff:10.1.2.3", ["10.0.0.0/8"]), true)
  assert.equal(trustedProxy("192.168.2.1", ["192.168.1.0/24"]), false)
  assert.equal(trustedProxy("127.0.0.1", ["not-an-ip"]), false)
  assert.equal(trustedProxy("127.0.0.1", ["127.0.0.1/33"]), false)

  const value = redact('external https://example.com/private local http://127.0.0.1:50882/ password=abc token:xyz')
  assert.match(value, /\[外部地址已隐藏\]/)
  assert.match(value, /http:\/\/127\.0\.0\.1:50882\//)
  assert.match(value, /password=\[已隐藏\]/)
  assert.match(value, /token=\[已隐藏\]/)
})

test("网络 URL 只允许规范 HTTPS 目标，代理协议单独校验", () => {
  assert.equal(normalizeNetworkUrl("https://example.com/a").href, "https://example.com/a")
  for (const url of ["http://example.com/a", "https://example.com:444/a", "https://user:pass@example.com/a", "https://example.com/a#fragment", "https://localhost/a", "https://example.internal/a"]) {
    assert.throws(() => normalizeNetworkUrl(url), undefined, url)
  }
  assert.equal(normalizeNetworkUrl("socks5h://proxy.internal:1080", { proxy: true }).hostname, "proxy.internal")
  assert.throws(() => normalizeNetworkUrl("ftp://proxy.example", { proxy: true }))
})

test("前端更新只使用获批的固定 IP HTTP(S) 代理", () => {
  assert.equal(approvedFrontendProxy({ approvedProxyUrls: [
    "socks5h://127.0.0.1:1080",
    "http://proxy.example:7890",
    "http://user:secret@127.0.0.1:7890",
    "http://127.0.0.1:7890/path",
    "https://127.0.0.1:8443",
  ] }), "https://127.0.0.1:8443/")
  assert.equal(approvedFrontendProxy({ approvedProxyUrls: ["socks5h://127.0.0.1:1080"] }), null)
  assert.equal(approvedFrontendProxy({ approvedProxyUrls: "http://127.0.0.1:7890" }), null)
})

test("拒绝替代 IP、内网、保留地址和混合公网/内网 DNS", async () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.1.1.1", "100.64.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2002:7f00:1::", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress("8.8.8.8"), true)
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true)
  for (const host of ["2130706433", "0x7f000001", "[::1]", "localhost.", "metadata.google.internal"]) await assert.rejects(resolvePublicUrl(`https://${host}/a`))
  await assert.rejects(resolvePublicUrl("https://public.example/a", { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }] }))
})

test("下载固定已验证地址，重定向逐跳检查且不连接私网", async () => {
  let calls = 0
  const options = fakeDownload({ inspect(url, options) {
    calls++
    assert.equal(url.hostname, "public.example")
    options.lookup("public.example", {}, (error, address) => { assert.equal(error, null); assert.equal(address, "8.8.8.8") })
    options.lookup("public.example", { all: true }, (error, addresses) => assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]))
  } })
  assert.equal((await safeDownload("https://public.example/a", 100, options)).toString(), "export default 1")
  assert.equal(calls, 1)
  const redirect = fakeDownload({ status: 302, headers: { location: "https://127.0.0.1/a" }, inspect() { calls++ } })
  await assert.rejects(safeDownload("https://public.example/a", 100, redirect), /拒绝连接/)
  assert.equal(calls, 2)
  await assert.rejects(safeDownload("https://public.example:4443/a", 100, options))
  await assert.rejects(safeDownload("https://u:p@public.example/a", 100, options))
})

test("下载校验 HTTP 状态、精确字节上限和重定向预算", async () => {
  const body = "export default 1"
  const limit = Buffer.byteLength(body)
  assert.equal((await safeDownload("https://public.example/a", limit, fakeDownload({ body }))).toString(), body)
  await assert.rejects(safeDownload("https://public.example/a", limit - 1, fakeDownload({ body })), /大小上限/)
  await assert.rejects(safeDownload("https://public.example/a", 100, fakeDownload({ status: 404 })), /直链未返回有效文件/)

  let redirects = 0
  const redirect = fakeDownload({ status: 302, headers: { location: "/next" }, inspect() { redirects++ } })
  await assert.rejects(safeDownload("https://public.example/a", 100, { ...redirect, redirects: 1 }), /重定向次数超限/)
  assert.equal(redirects, 2)
})

test("Git 固定 DNS、禁用重定向，常规代理只接受运维批准的固定 IP", async () => {
  const resolve = url => resolvePublicUrl(url, { lookup: async () => [{ address: "8.8.8.8", family: 4 }] })
  const direct = await secureGitTransport("https://public.example/a.git", {}, {}, resolve)
  assert.ok(direct.args.includes("http.curloptResolve=public.example:443:8.8.8.8"))
  assert.ok(direct.args.includes("http.followRedirects=false"))
  await assert.rejects(secureGitTransport(direct.url, { proxyMode: "prefix", proxy: "https://127.0.0.1" }, {}, resolve))
  await assert.rejects(secureGitTransport(direct.url, { proxyMode: "standard", proxy: "http://127.0.0.1:7890" }, {}, resolve))
  const approved = await secureGitTransport(direct.url, { proxyMode: "standard", proxy: "http://127.0.0.1:7890" }, { approvedProxyUrls: ["http://127.0.0.1:7890"] }, resolve)
  assert.ok(approved.args.includes("http.proxy=http://127.0.0.1:7890/"))
})

test("规范化锁覆盖大小写变体，并发预算在 await 前占用且遵守上限", async () => {
  let release
  const first = withLock("Plugins/Test", () => new Promise(resolve => { release = resolve }))
  await assert.rejects(withLock("plugins/test", () => {}), { status: 409 })
  release(); await first
  const one = withBudget("unit", 1, () => new Promise(resolve => { release = resolve }))
  await assert.rejects(withBudget("unit", 1, () => {}), { status: 429 })
  release(); await one
  await withBudget("unit", 1, () => {})

  let active = 0, peak = 0
  const releases = []
  const requests = Array.from({ length: 24 }, () => withBudget("unit-four", 4, async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise(resolve => releases.push(resolve))
    active--
  }))
  assert.equal(active, 4)
  assert.equal(peak, 4)
  for (const resolve of releases) resolve()
  const results = await Promise.allSettled(requests)
  assert.equal(results.filter(result => result.status === "fulfilled").length, 4)
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.status === 429).length, 20)
  assert.equal(active, 0)
})

test("完整 Origin 和可信代理 HTTPS Cookie 策略", () => {
  const req = { headers: { host: "panel.example", origin: "https://panel.example", "x-forwarded-proto": "https" }, socket: { remoteAddress: "127.0.0.1" } }
  assert.equal(requestIsSecure(req, {}), false)
  assert.equal(originAllowed(req, {}), false)
  const policy = { host: "panel.example", port: 443, trustedProxies: ["127.0.0.1/32"] }
  assert.equal(requestIsSecure(req, policy), true)
  assert.equal(originAllowed(req, policy), true)
  req.headers.origin = "https://panel.example:8443"
  assert.equal(originAllowed(req, policy), false)
  req.headers.origin = "https://other.example"
  assert.equal(originAllowed(req, { ...policy, publicUrl: "https://other.example" }), true)
})

test("开发内部接口、RSC、源码映射和编码路径变体均需登录", () => {
  for (const url of ["/__nextjs_devtools_config", "/_next/webpack-hmr", "/_next/static/%2f..%2f..%2f__nextjs_server_status", "/_next/static/a.js.map", "/%5f%5fnextjs_server_status"]) assert.equal(devRequestNeedsAuth({ url, method: "GET", headers: {} }), true, url)
  assert.equal(devRequestNeedsAuth({ url: "/", method: "GET", headers: { rsc: "1" } }), true)
  assert.equal(devRequestNeedsAuth({ url: "/", method: "GET", headers: {} }), false)
  assert.equal(devRequestNeedsAuth({ url: "/_next/static/chunks/a.js", method: "GET", headers: {} }), false)
})

test("前端嵌套赋值拒绝危险键，读取不走原型链，插件链接只接受 HTTP(S)", async () => {
  const dashboard = await fs.readFile(new URL("../components/dashboard.tsx", import.meta.url), "utf8")
  const source = dashboard.slice(dashboard.indexOf("function setNested("), dashboard.indexOf("function isObject("))
    .replace("value: any, path: string[], next: any): any", "value, path, next)")
    .replace("value: any, path: string", "value, path").replace("value: any", "value")
  const functions = vm.runInNewContext(`${source}; ({setNested, getNested, safePluginLink})`, { URL })
  for (const key of ["__proto__", "constructor", "prototype"]) assert.deepEqual(functions.setNested({}, [key, "marker"], true), {})
  assert.equal(functions.getNested({ own: 1 }, "toString"), undefined)
  assert.equal(functions.getNested({ own: { field: 2 } }, "own.field"), 2)
  assert.equal(functions.safePluginLink("javascript:alert(1)"), "")
  assert.equal(functions.safePluginLink("https://example.com/a"), "https://example.com/a")
})
