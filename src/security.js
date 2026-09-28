import crypto from "node:crypto"
import net from "node:net"
import path from "node:path"
import os from "node:os"
import { BlockList } from "node:net"

export const securityError = (message, status = 400) => Object.assign(new Error(message), { status })
export const contentVersion = value => crypto.createHash("sha256").update(value).digest("hex")
export function credentialVersion(config) {
  return contentVersion(JSON.stringify([config.passwordSalt, config.passwordHash, config.passwordIterations, config.secret]))
}

const locks = new Set()
export async function withLock(key, action) {
  const normalized = String(key).toLowerCase()
  if (locks.has(normalized)) throw securityError("该资源已有操作正在进行，请稍后重试", 409)
  locks.add(normalized)
  try { return await action() } finally { locks.delete(normalized) }
}

const budgets = new Map()
export async function withBudget(key, limit, action) {
  const active = budgets.get(key) || 0
  if (active >= limit) throw securityError("操作并发已达上限，请稍后重试", 429)
  budgets.set(key, active + 1)
  try { return await action() } finally { budgets.set(key, budgets.get(key) - 1) }
}

export function requireVersion(expected, actual) {
  if (typeof expected !== "string" || !expected) throw securityError("请重新读取最新内容后保存", 428)
  if (expected !== actual) throw securityError("内容已被其他操作修改，请重新读取后合并修改", 409)
}

export function trustedProxy(address, entries = []) {
  if (!Array.isArray(entries)) return false
  const block = new BlockList()
  try {
    for (const entry of entries) {
      if (String(entry).split("/").length > 2 || (String(entry).includes("/") && !/^\d+$/.test(String(entry).split("/")[1]))) throw securityError("可信代理 CIDR 无效")
      const [ip, prefix] = String(entry).split("/")
      const family = net.isIP(ip)
      if (!family) throw securityError("可信代理必须填写 IP 或 CIDR")
      if (prefix === undefined) block.addAddress(ip, family === 6 ? "ipv6" : "ipv4")
      else block.addSubnet(ip, Number(prefix), family === 6 ? "ipv6" : "ipv4")
    }
    if (address?.startsWith("::ffff:") && net.isIP(address.slice(7)) === 4) address = address.slice(7)
    return !!net.isIP(address) && block.check(address, net.isIP(address) === 6 ? "ipv6" : "ipv4")
  } catch { return false }
}

export function requestIsSecure(req, policy) {
  return !!req.socket?.encrypted || (trustedProxy(req.socket?.remoteAddress, policy.trustedProxies)
    && req.headers["x-forwarded-proto"] === "https")
}

export function originAllowed(req, policy) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) return false
    const scheme = requestIsSecure(req, policy) ? "https" : "http"
    const configured = String(policy.publicUrl || "").split(/[,\r\n]+/).filter(value => value.trim()).map(value => new URL(value.trim()).origin)
    const host = String(policy.host || "127.0.0.1")
    const port = Number(policy.port || 50882)
    const hosts = [host]
    if (["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(host)) hosts.push("127.0.0.1", "localhost", "::1")
    if (["0.0.0.0", "::"].includes(host)) for (const entries of Object.values(os.networkInterfaces())) for (const entry of entries || []) hosts.push(entry.address)
    const local = hosts.map(value => new URL(`${scheme}://${net.isIP(value) === 6 ? `[${value}]` : value}:${port}`).origin)
    return configured.includes(origin) || local.includes(origin)
  } catch { return false }
}

export function devRequestNeedsAuth(req) {
  let pathname
  try { pathname = path.posix.normalize(decodeURIComponent(new URL(req.originalUrl || req.url, "http://localhost").pathname).replace(/\\/g, "/")) } catch { return true }
  // Only documents and build assets needed to render the login page are public.
  if (!["GET", "HEAD"].includes(req.method) || req.headers.rsc || req.headers["next-router-state-tree"]) return true
  return !( /^\/(?:accounts|config|plugins|files|logs|debug)?\/?$/.test(pathname)
    || (/^\/_next\/static\//.test(pathname) && !pathname.endsWith(".map")) || /^\/(?:favicon\.ico|elia\.png)$/.test(pathname))
}

export function redact(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/gi, url => /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d+\/?$/i.test(url) ? url : "[外部地址已隐藏]")
    .replace(/(password|secret|token|cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
}
