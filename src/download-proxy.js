import net from "node:net"
import tls from "node:tls"
import { Agent, ProxyAgent } from "undici"
import { SocksClient } from "socks"
import { normalizeNetworkUrl, resolvePublicUrl, safeDownload } from "./network-policy.js"
import { securityError } from "./security.js"

// All consumers use this persisted selection; request bodies cannot override it.
export function validateDownloadProxy(mode = "none", address = "") {
  if (mode === "none") return { proxyMode: "none", proxy: "" }
  if (!["standard", "prefix"].includes(mode)) throw securityError("下载代理类型无效")
  const url = normalizeNetworkUrl(address, { proxy: mode === "standard" })
  if (url.search || (mode === "standard" && (url.pathname !== "/" || !net.isIP(url.hostname.replace(/^\[|\]$/g, ""))))) {
    throw securityError(mode === "standard" ? "常规下载代理必须使用固定 IP 的站点根地址" : "链接前缀代理不能包含查询参数")
  }
  return { proxyMode: mode, proxy: url.href }
}

export function downloadProxySettings(config = {}) {
  return validateDownloadProxy(config.downloadProxyMode || "none", config.downloadProxyUrl || "")
}

export function downloadProxyPolicy(config = {}) {
  const selection = downloadProxySettings(config)
  return { ...config, approvedProxyUrls: selection.proxyMode === "standard" ? [selection.proxy] : [] }
}

export async function downloadFile(input, maxBytes, selection, { redirects = 0 } = {}) {
  if (selection.proxyMode === "none") return safeDownload(input, maxBytes, { redirects })
  return withDownloadProxy(selection, async fetchImpl => {
    const signal = AbortSignal.timeout(30_000)
    for (let hop = 0; ; hop++) {
      const response = await fetchImpl(input, { signal })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location")
        await response.body?.cancel()
        if (!location || hop >= redirects) throw securityError("下载重定向次数超限或不受支持")
        input = new URL(location, input).href
        continue
      }
      if (!response.ok || /text\/html/i.test(response.headers.get("content-type") || "")) {
        await response.body?.cancel()
        throw securityError("直链未返回有效文件")
      }
      const chunks = []
      let size = 0
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size > maxBytes) throw securityError("下载内容超过允许的大小上限")
          chunks.push(Buffer.from(value))
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      return Buffer.concat(chunks)
    }
  })
}

// A selected proxy is a trusted egress boundary. Targets and prefix endpoints
// still pass the public-address policy, including each redirect handled by callers.
export async function withDownloadProxy(selection, action, { fetchImpl = globalThis.fetch, resolve = resolvePublicUrl } = {}) {
  selection = validateDownloadProxy(selection?.proxyMode, selection?.proxy)
  if (selection.proxyMode === "none") {
    const dispatcher = new Agent()
    try { return await action((input, init) => fetchImpl(input, { ...init, dispatcher })) }
    finally { await dispatcher.destroy() }
  }
  const dispatchers = new Set()
  let sharedDispatcher
  const proxyUrl = new URL(selection.proxy)
  if (selection.proxyMode === "standard" && ["http:", "https:"].includes(proxyUrl.protocol)) {
    sharedDispatcher = new ProxyAgent(proxyUrl.href)
    dispatchers.add(sharedDispatcher)
  }
  const requestFetch = async (input, init = {}) => {
    const target = await resolve(String(input))
    let endpoint = target
    let dispatcher = sharedDispatcher
    if (selection.proxyMode === "prefix") {
      endpoint = await resolve(`${selection.proxy.replace(/\/$/, "")}/${target.url.href}`)
    }
    if (!dispatcher) {
      const address = endpoint.addresses[0]
      if (selection.proxyMode === "standard") {
        dispatcher = new Agent({ connect: (options, callback) => {
          const hostname = options.hostname.replace(/^\[|\]$/g, "")
          const destination = proxyUrl.protocol === "socks5h:" ? hostname : address.address
          SocksClient.createConnection({
            command: "connect", timeout: 30_000,
            proxy: { host: proxyUrl.hostname.replace(/^\[|\]$/g, ""), port: Number(proxyUrl.port || 1080), type: 5 },
            destination: { host: destination, port: Number(options.port || 443) },
          }).then(({ socket }) => {
            const secureSocket = tls.connect({ socket, servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: true })
            const timer = setTimeout(() => secureSocket.destroy(new Error("代理 TLS 握手超时")), 30_000)
            const fail = error => { clearTimeout(timer); callback(error, null) }
            secureSocket.once("error", fail)
            secureSocket.once("secureConnect", () => { clearTimeout(timer); secureSocket.removeListener("error", fail); callback(null, secureSocket) })
          }, error => callback(error, null))
        } })
      } else {
        dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => callback(null, options.all ? [address] : address.address, address.family) } })
      }
      dispatchers.add(dispatcher)
    }
    // Redirect validation belongs to the downloader, never to fetch's auto-follow.
    const response = await fetchImpl(endpoint.url.href, { ...init, redirect: "manual", dispatcher })
    if (selection.proxyMode === "prefix") Object.defineProperty(response, "url", { value: target.url.href })
    return response
  }
  try { return await action(requestFetch) }
  finally { await Promise.allSettled([...dispatchers].map(dispatcher => dispatcher.destroy())) }
}
