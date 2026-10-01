import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { Agent, ProxyAgent } from "undici"
import { downloadProxySettings, downloadProxyPolicy, validateDownloadProxy, withDownloadProxy } from "../src/download-proxy.js"

test("统一代理只读取持久选择，拒绝常规代理域名、凭据及非根路径", () => {
  assert.deepEqual(downloadProxySettings({ approvedProxyUrls: ["http://127.0.0.1:7890"] }), { proxyMode: "none", proxy: "" })
  for (const url of ["http://proxy.example:7890", "http://user:secret@127.0.0.1:7890", "http://127.0.0.1:7890/path", "http://127.0.0.1:7890?x=1"]) assert.throws(() => validateDownloadProxy("standard", url))
  assert.throws(() => validateDownloadProxy("prefix", "http://gh-proxy.com"))
  assert.throws(() => validateDownloadProxy("unknown", ""))
  const config = { downloadProxyMode: "standard", downloadProxyUrl: "socks5h://127.0.0.1:1080", approvedProxyUrls: ["http://127.0.0.1:7890"] }
  assert.deepEqual(downloadProxyPolicy(config).approvedProxyUrls, ["socks5h://127.0.0.1:1080/"])
})

test("HTTP 代理共用 dispatcher，HTTPS 前缀固定解析地址并关闭自动重定向", async () => {
  const requests = [], resolutions = []
  const resolve = async input => { resolutions.push(input); return { url: new URL(input), addresses: [{ address: "8.8.8.8", family: 4 }] } }
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return new Response("fixture") }
  const target = "https://github.com/a/b.git"
  await withDownloadProxy({ proxyMode: "none" }, fetch => fetch(target), { fetchImpl, resolve })
  assert.ok(requests[0].init.dispatcher instanceof Agent)
  assert.equal(requests[0].url, target)
  requests.length = 0
  await withDownloadProxy({ proxyMode: "standard", proxy: "http://127.0.0.1:7890" }, async fetch => {
    await fetch(target); await fetch(target)
  }, { fetchImpl, resolve })
  assert.ok(requests[0].init.dispatcher instanceof ProxyAgent)
  assert.equal(requests[0].init.dispatcher, requests[1].init.dispatcher)
  requests.length = 0; resolutions.length = 0
  await withDownloadProxy({ proxyMode: "prefix", proxy: "https://proxy.example" }, async fetch => {
    assert.equal((await fetch(target, { redirect: "follow" })).url, target)
  }, { fetchImpl, resolve })
  assert.deepEqual(resolutions, [target, "https://proxy.example/https://github.com/a/b.git"])
  assert.equal(requests[0].init.redirect, "manual")
  assert.ok(requests[0].init.dispatcher instanceof Agent)
  let contacted = false
  await assert.rejects(withDownloadProxy({ proxyMode: "prefix", proxy: "https://127.0.0.1" }, fetch => fetch(target), {
    fetchImpl: async () => { contacted = true },
    resolve: async input => { if (input.includes("127.0.0.1")) throw Error("拒绝私网"); return resolve(input) },
  }), /拒绝私网/)
  assert.equal(contacted, false)
})

test("SOCKS5 使用已验证 IP，SOCKS5H 保留域名，并在隧道中进行 TLS 握手", { timeout: 10_000 }, async () => {
  for (const protocol of ["socks5", "socks5h"]) {
    const sockets = new Set()
    let destination, sawTls = false
    const server = net.createServer(socket => {
      sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket))
      let stage = 0
      socket.on("data", bytes => {
        if (stage === 0) { stage++; socket.write(Buffer.from([5, 0])); return }
        if (stage === 1) {
          stage++
          destination = bytes[3] === 1 ? [...bytes.subarray(4, 8)].join(".") : bytes.subarray(5, 5 + bytes[4]).toString()
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 187])); return
        }
        sawTls = bytes[0] === 22
        socket.destroy()
      })
    })
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    try {
      await assert.rejects(withDownloadProxy({ proxyMode: "standard", proxy: `${protocol}://127.0.0.1:${server.address().port}` }, fetch => fetch("https://download.example.test/file", { signal: AbortSignal.timeout(3000) }), {
        resolve: async input => ({ url: new URL(input), addresses: [{ address: "8.8.8.8", family: 4 }] }),
      }))
      assert.equal(destination, protocol === "socks5" ? "8.8.8.8" : "download.example.test")
      assert.equal(sawTls, true)
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    }
  }
})
