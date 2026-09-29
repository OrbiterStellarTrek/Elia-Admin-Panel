import dns from "node:dns/promises"
import https from "node:https"
import net from "node:net"
import { BlockList } from "node:net"
import { securityError } from "./security.js"

const denied = new BlockList()
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) denied.addSubnet(ip, bits, "ipv4")
const publicV6 = new BlockList()
publicV6.addSubnet("2000::", 3, "ipv6")
for (const [ip, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) denied.addSubnet(ip, bits, "ipv6")
export function isPublicAddress(ip) {
  const family = net.isIP(ip)
  if (family === 4) return !denied.check(ip, "ipv4")
  return family === 6 && publicV6.check(ip, "ipv6") && !denied.check(ip, "ipv6")
}
export function normalizeNetworkUrl(input, { proxy = false } = {}) {
  let url
  try { url = new URL(input) } catch { throw securityError("网络地址无效") }
  if ((!proxy && url.protocol !== "https:") || (proxy && !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol))
    || url.username || url.password || url.hash || (!proxy && url.port && url.port !== "443")) throw securityError("只接受无凭据、标准端口的 HTTPS 地址")
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!proxy && (host.endsWith(".") || host === "localhost" || /\.(?:local|localhost|internal|home|lan)$/.test(host))) throw securityError("目标主机不属于公网")
  return url
}
export function approvedFrontendProxy(policy = {}) {
  const configured = Array.isArray(policy?.approvedProxyUrls) ? policy.approvedProxyUrls : []
  for (const value of configured) {
    let proxy
    try { proxy = normalizeNetworkUrl(value, { proxy: true }) } catch { continue }
    const hostname = proxy.hostname.replace(/^\[|\]$/g, "")
    if (!["http:", "https:"].includes(proxy.protocol) || !net.isIP(hostname) || proxy.pathname !== "/" || proxy.search) continue
    return proxy.href
  }
  return null
}
export async function resolvePublicUrl(input, { lookup = dns.lookup } = {}) {
  const url = normalizeNetworkUrl(input)
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  let timer
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(securityError("目标 DNS 解析超时")), 5000); timer.unref?.() }),
  ]).finally(() => clearTimeout(timer))
  if (!addresses.length || addresses.some(record => !isPublicAddress(record.address))) throw securityError("目标解析包含回环、内网或保留地址，已拒绝连接")
  return { url, addresses }
}

export async function safeDownload(input, maxBytes, { lookup = dns.lookup, request = https.request, redirects = 3 } = {}) {
  const deadline = Date.now() + 30_000
  for (let hop = 0; ; hop++) {
    const { url, addresses } = await resolvePublicUrl(input, { lookup })
    if (Date.now() >= deadline) throw securityError("下载超时")
    const record = addresses[0]
    const response = await new Promise((resolve, reject) => {
      const req = request(url, { agent: false, headers: { "accept-encoding": "identity" },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        lookup: (_host, options, callback) => callback(null, options.all ? [record] : record.address, record.family),
      }, resolve)
      req.once("error", reject)
      req.end()
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location
      response.destroy()
      if (!location || hop >= redirects) throw securityError("下载重定向次数超限或不受支持")
      input = new URL(location, url).href
      continue
    }
    if (response.statusCode < 200 || response.statusCode >= 300 || /text\/html/i.test(response.headers["content-type"] || "")) {
      response.destroy()
      throw securityError("直链未返回有效文件")
    }
    const chunks = []
    let size = 0
    try {
      for await (const chunk of response) {
        size += chunk.length
        if (size > maxBytes) throw securityError("下载内容超过允许的大小上限")
        chunks.push(Buffer.from(chunk))
      }
    } finally { response.destroy() }
    return Buffer.concat(chunks)
  }
}

export async function secureGitTransport(url, options = {}, policy = {}, resolve = resolvePublicUrl) {
  const target = await resolve(url)
  let endpoint = target
  const args = ["-c", "http.followRedirects=false", "-c", "http.sslVerify=true", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.curloptResolve="]
  const mode = options.proxyMode || "none"
  if (mode === "prefix") {
    const prefix = normalizeNetworkUrl(options.proxy)
    if (prefix.search) throw securityError("链接代理不能包含查询参数")
    endpoint = await resolve(`${prefix.href.replace(/\/$/, "")}/${target.url.href}`)
  } else if (mode === "standard") {
    const proxy = normalizeNetworkUrl(options.proxy, { proxy: true })
    if (!net.isIP(proxy.hostname.replace(/^\[|\]$/g, ""))) throw securityError("获批常规代理必须使用固定 IP 地址")
    if (proxy.pathname !== "/" || proxy.search) throw securityError("常规代理必须是站点根地址")
    const approved = (policy.approvedProxyUrls || []).map(value => normalizeNetworkUrl(value, { proxy: true }).href)
    if (!approved.includes(proxy.href)) throw securityError("此常规代理未获运维批准，请在受保护的面板配置中添加 approvedProxyUrls")
    // The exact approved proxy is an explicit trusted egress boundary.
    args.push("-c", `http.proxy=${proxy.href}`, "-c", `http.${endpoint.url.href}.proxy=${proxy.href}`)
  } else if (mode !== "none") throw securityError("代理模式无效")
  if (mode !== "standard") args.push("-c", "http.proxy=", "-c", `http.${endpoint.url.href}.proxy=`)
  const host = endpoint.url.hostname.replace(/^\[|\]$/g, "")
  const address = endpoint.addresses[0]
  args.push("-c", `http.${endpoint.url.href}.followRedirects=false`, "-c", `http.${endpoint.url.href}.sslVerify=true`)
  args.push("-c", `http.curloptResolve=${host}:443:${address.family === 6 ? `[${address.address}]` : address.address}`)
  return { url: endpoint.url.href, args }
}
