import crypto from "node:crypto"
import { watch as watchDirectory } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import net from "node:net"
import os from "node:os"
import { pathToFileURL, fileURLToPath } from "node:url"
import express from "express"
import { WebSocketServer } from "ws"
import YAML from "yaml"
import cfg from "../../../lib/config/config.js"

const ROOT = process.cwd()
const requireFromRoot = createRequire(path.join(ROOT, "package.json"))
const PLUGINS = path.join(ROOT, "plugins")
const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const DATA_DIR = path.join(ROOT, "data", "elia-admin-panel")
const PANEL_CONFIG = path.join(DATA_DIR, "config.yaml")
const LOGS_DIR = path.join(ROOT, "logs")
const SESSION_STORE_FILE = path.join(DATA_DIR, "sessions.json")
const STATIC_DIR = path.join(PANEL_DIR, "out")
const MAX_TEXT_BYTES = 1_500_000
const MAX_LOG_TAIL_BYTES = 512 * 1024
const MAX_LOG_DELTA_BYTES = 2 * 1024 * 1024
const LOG_FILE_PATTERN = /^(?:error|command)(?:\.\d{4}-\d{2}-\d{2})?\.log$/
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const PASSWORD_HASH_ITERATIONS = 310_000
const ALLOWED_TEXT_EXTENSIONS = new Set([
  ".yaml", ".yml", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".css", ".scss", ".md", ".txt", ".html", ".xml", ".conf", ".ini", ".toml",
  ".sh", ".bat", ".ps1", ".properties", ".env", ".gitignore", ".editorconfig",
])
const PLUGIN_CONFIG_EXTENSIONS = new Set([".yaml", ".yml", ".json", ".toml", ".ini", ".conf", ".properties"])
const PLUGIN_SCAN_IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".next", "out", "dist", "build", "coverage", "data", "logs"])
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", ".next", "out"])

const sessions = new Map()
let sessionSecret = ""
let sessionStoreWrite = Promise.resolve()
const loginAttempts = new Map()
const codeRequestAttempts = new Map()
const codeCheckAttempts = new Map()
const quickLoginAttempts = new Map()
const quickLogins = new Map()
const supportCache = new Map()
const PLUGIN_SUPPORT_ENTRIES = [
  { fileName: "elia.support.js", factoryName: "supportPanel" },
  { fileName: "guoba.support.js", factoryName: "supportGuoba" },
]
let expressServer
let logWebSocketServer
let logDirectoryWatcher
let logHeartbeatTimer
let loginCode
let warnedInvalidPublicUrl = false
const logWatchTimers = new Map()

const safeLogger = (level, message) => {
  try {
    if (global.logger?.[level]) global.logger[level](message)
    else console.log(message)
  } catch {
    console.log(message)
  }
}

function isInside(parent, target) {
  const relative = path.relative(parent, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function resolveWorkspacePath(relativePath = ".") {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) {
    throw Object.assign(new Error("文件路径无效"), { status: 400 })
  }
  const absolute = path.resolve(ROOT, relativePath || ".")
  if (!isInside(ROOT, absolute)) throw Object.assign(new Error("不能访问工作区以外的路径"), { status: 403 })
  if (isInside(DATA_DIR, absolute)) throw Object.assign(new Error("面板凭据与会话数据由面板保护，不能通过文件管理器访问"), { status: 403 })
  const segments = path.relative(ROOT, absolute).split(path.sep).filter(Boolean)
  if (segments.some(segment => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throw Object.assign(new Error("该目录由面板保护，不能通过文件管理器访问"), { status: 403 })
  }
  return absolute
}

async function rejectSymlinkPath(absolute) {
  const relative = path.relative(ROOT, absolute)
  let current = ROOT
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw Object.assign(new Error("面板不跟随符号链接"), { status: 403 })
    } catch (error) {
      if (error.code === "ENOENT") break
      throw error
    }
  }
}

async function readPanelConfig() {
  try {
    const parsed = YAML.parse(await fs.readFile(PANEL_CONFIG, "utf8")) || {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("配置内容必须是 YAML 对象")
    return parsed
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return { host: "127.0.0.1", port: 50882, publicUrl: "" }
  }
}

async function writePanelConfig(config) {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const temporaryFile = `${PANEL_CONFIG}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  await fs.writeFile(temporaryFile, YAML.stringify(config), { encoding: "utf8", mode: 0o600, flag: "wx" })
  try {
    await fs.rename(temporaryFile, PANEL_CONFIG)
  } catch (error) {
    await fs.rm(temporaryFile, { force: true }).catch(() => {})
    throw error
  }
}

async function readPanelSettings() {
  try {
    const parsed = await readPanelConfig()
    const port = Number(parsed.port || 50882)
    return {
      host: String(parsed.host || "127.0.0.1").trim(),
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 50882,
      publicUrl: String(parsed.publicUrl || "").trim(),
    }
  } catch (error) {
    safeLogger("error", `[AdminPanel] 读取面板配置失败：${error.message}`)
    return { host: "127.0.0.1", port: 50882, publicUrl: "" }
  }
}

function derivePassword(password, salt, iterations = PASSWORD_HASH_ITERATIONS) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, 32, "sha256", (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

async function createPasswordCredential(password) {
  const salt = crypto.randomBytes(16)
  const hash = await derivePassword(password, salt)
  return {
    passwordSalt: salt.toString("hex"),
    passwordHash: hash.toString("hex"),
    passwordIterations: PASSWORD_HASH_ITERATIONS,
  }
}

function hasPasswordCredential(config) {
  return typeof config.passwordSalt === "string" && /^[a-f0-9]{32}$/i.test(config.passwordSalt)
    && typeof config.passwordHash === "string" && /^[a-f0-9]{64}$/i.test(config.passwordHash)
    && Number.isInteger(config.passwordIterations) && config.passwordIterations >= 100_000 && config.passwordIterations <= 1_000_000
}

async function initializePassword() {
  const config = await readPanelConfig()
  if (hasPasswordCredential(config)) return
  if (config.passwordHash || config.passwordSalt || config.passwordIterations) {
    throw new Error("面板配置中的密码哈希无效；请在插件配置页重新设置面板密码")
  }
  const generatedPassword = crypto.randomBytes(24).toString("base64url")
  const credential = await createPasswordCredential(generatedPassword)
  const { password: _plaintext, ...safeConfig } = config
  await writePanelConfig({ ...safeConfig, ...credential })
  safeLogger("mark", `[EliaAdminPanel] 首次登录密码（仅显示本次）：${generatedPassword}`)
}

async function verifyPanelPassword(submitted) {
  if (typeof submitted !== "string" || submitted.length > 1024) return false
  const config = await readPanelConfig()
  if (hasPasswordCredential(config)) {
    const salt = Buffer.from(config.passwordSalt, "hex")
    const expected = Buffer.from(config.passwordHash, "hex")
    const actual = await derivePassword(submitted, salt, config.passwordIterations)
    return crypto.timingSafeEqual(actual, expected)
  }
  return false
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest()
}

async function loadSessionSecret() {
  const config = await readPanelConfig()
  if (typeof config.secret === "string" && config.secret) {
    if (Buffer.byteLength(config.secret, "utf8") < 32) throw new Error("面板配置中的 Secret 至少需要 32 个 UTF-8 字节")
    return config.secret
  }
  const generatedSecret = crypto.randomBytes(32).toString("base64url")
  await writePanelConfig({ ...config, secret: generatedSecret })
  safeLogger("mark", `[AdminPanel] 已生成并保存浏览器会话 Secret：${path.relative(ROOT, PANEL_CONFIG)}`)
  return generatedSecret
}

async function loadPersistedSessions() {
  const now = Date.now()
  try {
    const saved = JSON.parse(await fs.readFile(SESSION_STORE_FILE, "utf8"))
    if (!saved || typeof saved !== "object" || !Array.isArray(saved.sessions)) throw new Error("会话文件格式无效")
    const secretFingerprint = hashSecret(sessionSecret).toString("hex")
    if (saved.secretFingerprint !== secretFingerprint) {
      safeLogger("mark", "[AdminPanel] 登录 Secret 已更改，已撤销全部旧浏览器会话")
      await persistSessions()
      return
    }
    for (const record of saved.sessions) {
      if (!Array.isArray(record) || record.length !== 2) continue
      const [sessionIdHash, expiresAt] = record
      if (typeof sessionIdHash !== "string" || !/^[a-f0-9]{64}$/.test(sessionIdHash)) continue
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + SESSION_TTL_MS + 60_000) continue
      sessions.set(sessionIdHash, expiresAt)
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      safeLogger("warn", `[AdminPanel] 无法读取已保存的浏览器会话，将要求重新登录：${error.message}`)
    }
  }
}

function persistSessions() {
  const write = sessionStoreWrite.catch(() => {}).then(async () => {
    const now = Date.now()
    for (const [sessionIdHash, expiresAt] of sessions) {
      if (expiresAt <= now) sessions.delete(sessionIdHash)
    }
    const snapshot = JSON.stringify({
      secretFingerprint: hashSecret(sessionSecret).toString("hex"),
      sessions: [...sessions.entries()],
    })
    const temporaryFile = `${SESSION_STORE_FILE}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
    await fs.writeFile(temporaryFile, `${snapshot}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    try {
      await fs.rename(temporaryFile, SESSION_STORE_FILE)
    } catch (error) {
      await fs.rm(temporaryFile, { force: true }).catch(() => {})
      throw error
    }
  })
  sessionStoreWrite = write
  return write
}

function signSessionToken(sessionId, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ sid: sessionId, exp: Math.floor(expiresAt / 1000) })).toString("base64url")
  const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

function verifySessionToken(token) {
  if (typeof token !== "string" || token.length > 2048) return null
  const [payload, signature, extra] = token.split(".")
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null
  const expectedSignature = crypto.createHmac("sha256", sessionSecret).update(payload).digest()
  const actualSignature = Buffer.from(signature, "base64url")
  if (actualSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(actualSignature, expectedSignature)) return null

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (typeof decoded.sid !== "string" || !decoded.sid || !Number.isSafeInteger(decoded.exp)) return null
    const expiresAt = decoded.exp * 1000
    if (expiresAt <= Date.now()) return null
    const sessionIdHash = hashSecret(decoded.sid).toString("hex")
    if (sessions.get(sessionIdHash) !== expiresAt) return null
    return { sessionIdHash, expiresAt }
  } catch {
    return null
  }
}

function parseCookies(header = "") {
  const cookies = new Map()
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index > 0) {
      const rawValue = part.slice(index + 1).trim()
      let value = rawValue
      try { value = decodeURIComponent(rawValue) } catch {}
      cookies.set(part.slice(0, index).trim(), value)
    }
  }
  return cookies
}

function setSessionCookie(req, res, token) {
  const secure = req.secure ? "; Secure" : ""
  res.setHeader("Set-Cookie", `elia_panel_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`)
}

function clearSessionCookie(req, res) {
  const secure = req.secure ? "; Secure" : ""
  res.setHeader("Set-Cookie", `elia_panel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`)
}

function checkOrigin(req, res, next) {
  const origin = req.get("origin")
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "跨站请求已拒绝" })
    } catch {
      return res.status(403).json({ error: "来源地址无效" })
    }
  }
  next()
}

function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie).get("elia_panel_session")
  const session = token && verifySessionToken(token)
  if (!session) {
    clearSessionCookie(req, res)
    return res.status(401).json({ error: "登录已失效，请重新登录" })
  }
  req.panelSession = session
  next()
}

async function issueSession(req, res) {
  const sessionId = crypto.randomBytes(32).toString("base64url")
  const expiresAt = Math.floor((Date.now() + SESSION_TTL_MS) / 1000) * 1000
  const sessionIdHash = hashSecret(sessionId).toString("hex")
  sessions.set(sessionIdHash, expiresAt)
  try {
    await persistSessions()
  } catch (error) {
    sessions.delete(sessionIdHash)
    throw error
  }
  setSessionCookie(req, res, signSessionToken(sessionId, expiresAt))
  return expiresAt
}

function allowAttempt(bucket, key, limit, windowMs) {
  const now = Date.now()
  const attempt = bucket.get(key)
  if (attempt && attempt.resetAt > now && attempt.count >= limit) return false
  const next = !attempt || attempt.resetAt <= now ? { count: 1, resetAt: now + windowMs } : { ...attempt, count: attempt.count + 1 }
  bucket.set(key, next)
  return true
}

async function panelAddresses() {
  const settings = await readPanelSettings()
  const publicUrl = settings.publicUrl
  const configuredAddresses = publicUrl.split(/[,\r\n]+/).map(value => {
    try {
      const url = new URL(value.trim())
      if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) return ""
      return url.origin
    } catch {
      return ""
    }
  }).filter(Boolean)
  if (configuredAddresses.length) return [...new Set(configuredAddresses)]
  if (publicUrl && !warnedInvalidPublicUrl) {
    warnedInvalidPublicUrl = true
    safeLogger("warn", "[AdminPanel] 公网访问地址只接受 http(s) 站点根地址；将使用监听地址生成快捷登录链接")
  }
  const { host, port } = settings
  const hosts = []
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    hosts.push(host === "::1" ? "[::1]" : "127.0.0.1")
  } else if (host === "0.0.0.0" || host === "::") {
    for (const interfaces of Object.values(os.networkInterfaces())) {
      for (const item of interfaces || []) {
        if (item.internal) continue
        const address = item.address
        if (item.family === "IPv4" && !address.startsWith("169.254.")) hosts.push(address)
      }
    }
    hosts.push("127.0.0.1")
  } else {
    hosts.push(host)
  }
  return [...new Set(hosts)].map(value => `http://${net.isIP(value) === 6 && !value.startsWith("[") ? `[${value}]` : value}:${port}`)
}

async function readPluginIcon(iconPath, directory) {
  if (typeof iconPath !== "string" || !iconPath.trim()) return ""
  const pluginRoot = path.resolve(PLUGINS, directory)
  const mimeTypes = new Map([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
    [".gif", "image/gif"],
    [".ico", "image/x-icon"],
  ])
  try {
    const iconFile = await fs.realpath(iconPath)
    if (!isInside(pluginRoot, iconFile)) return ""
    const mime = mimeTypes.get(path.extname(iconFile).toLowerCase())
    if (!mime) return ""
    const stat = await fs.stat(iconFile)
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return ""
    return `data:${mime};base64,${(await fs.readFile(iconFile)).toString("base64")}`
  } catch {
    return ""
  }
}

async function formatPluginEntry(name, title, directory, support = null, metadata = {}) {
  const info = support?.pluginInfo || {}
  const configInfo = support?.configInfo || {}
  return {
    id: name,
    name: info.name || name,
    title: info.title || title,
    description: info.description || "",
    author: info.author || "",
    link: info.link || "",
    icon: info.icon || "",
    iconColor: info.iconColor || "",
    iconData: await readPluginIcon(info.iconPath, directory),
    kind: metadata.kind || "large",
    directory,
    sourcePath: metadata.sourcePath || "",
    hasSupport: Boolean(support),
    configFiles: metadata.configFiles || [],
    hasConfig: typeof configInfo.getConfigData === "function" && Array.isArray(configInfo.schemas),
    schemas: Array.isArray(configInfo.schemas) ? JSON.parse(JSON.stringify(configInfo.schemas)) : [],
    actions: Object.entries(configInfo.actions || {}).map(([key, action]) => ({ key, available: typeof action === "function" })),
    loadedBy: directory,
  }
}

async function listPluginConfigFiles(pluginDirectory) {
  const files = new Map()
  const addFile = async filePath => {
    try {
      const stat = await fs.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TEXT_BYTES) return
      const relativeToPlugin = path.relative(pluginDirectory, filePath)
      const relativeToWorkspace = path.relative(ROOT, filePath).split(path.sep).join("/")
      files.set(relativeToPlugin, { name: relativeToPlugin.split(path.sep).join("/"), path: relativeToWorkspace, size: stat.size })
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }

  let rootEntries = []
  try { rootEntries = await fs.readdir(pluginDirectory, { withFileTypes: true }) } catch { return [] }
  const rootConfigName = new RegExp(`^config(?:[._-].*)?\\.(?:${[...PLUGIN_CONFIG_EXTENSIONS].map(extension => extension.slice(1)).join("|")})$`, "i")
  for (const entry of rootEntries) {
    if (entry.isFile() && rootConfigName.test(entry.name)) await addFile(path.join(pluginDirectory, entry.name))
  }

  async function walkConfigDirectory(directory, depth = 0) {
    if (depth > 5) return
    let entries
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!PLUGIN_SCAN_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) await walkConfigDirectory(child, depth + 1)
      } else if (entry.isFile() && PLUGIN_CONFIG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        await addFile(child)
      }
    }
  }

  for (const entry of rootEntries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && ["config", "configs"].includes(entry.name.toLowerCase())) {
      await walkConfigDirectory(path.join(pluginDirectory, entry.name))
    }
  }
  return [...files.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
}

async function loadPluginSupport(pluginDirectory) {
  // Elia 专属入口优先，其次是 Guoba 入口，最后兼容其他 *.support.js。
  const supportEntries = await fs.readdir(pluginDirectory, { withFileTypes: true })
  const supportFiles = supportEntries.filter(entry => entry.isFile() && entry.name.endsWith(".support.js")).map(entry => entry.name)
  const orderedNames = [
    ...PLUGIN_SUPPORT_ENTRIES.map(entry => entry.fileName),
    ...supportFiles.filter(name => !PLUGIN_SUPPORT_ENTRIES.some(entry => entry.fileName === name)).sort((a, b) => a.localeCompare(b)),
  ]
  let selected
  for (const fileName of orderedNames) {
    if (!supportFiles.includes(fileName)) continue
    const supportPath = path.join(pluginDirectory, fileName)
    const stat = await fs.stat(supportPath)
    if (stat.isFile()) {
      selected = { fileName, path: supportPath, stat }
      break
    }
  }
  if (!selected) return null

  const { path: supportPath, fileName, stat } = selected
  const key = supportPath
  const cached = supportCache.get(key)
  if (cached?.mtimeMs === stat.mtimeMs) return cached.support
  const url = `${pathToFileURL(supportPath).href}?panel=${stat.mtimeMs}`
  const module = await import(url)
  const genericName = path.basename(fileName, ".support.js")
  const upperName = genericName.charAt(0).toUpperCase() + genericName.slice(1)
  const factoryName = fileName === "elia.support.js"
    ? "supportPanel"
    : fileName === "guoba.support.js"
      ? "supportGuoba"
      : [`support${upperName}`, "supportPanel", "supportGuoba"].find(name => typeof module[name] === "function")
  if (typeof module[factoryName] !== "function") {
    throw new Error(`${path.basename(supportPath)} 必须导出 supportPanel()、supportGuoba() 或与文件名对应的工厂`)
  }
  const support = await module[factoryName]()
  supportCache.set(key, { mtimeMs: stat.mtimeMs, support })
  return support
}

async function listPlugins() {
  const result = []
  const entries = await fs.readdir(PLUGINS, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const directory = path.join(PLUGINS, entry.name)
    let children
    try {
      children = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    const isFolderPlugin = entry.name.toLowerCase() !== "example" && (children.some(child => child.isFile() && child.name === "index.js")
      || children.some(child => child.isFile() && PLUGIN_SUPPORT_ENTRIES.some(supportEntry => supportEntry.fileName === child.name))
      || children.some(child => child.isFile() && child.name.endsWith(".support.js"))
      || children.some(child => child.name === ".git" && (child.isDirectory() || child.isFile())))
    if (isFolderPlugin) {
      let support = null
      try {
        support = await loadPluginSupport(directory)
      } catch (error) {
        safeLogger("warn", `[AdminPanel] ${entry.name} support 加载失败：${error.message}`)
      }
      const title = entry.name.replace(/[-_]/g, " ")
      const configFiles = support ? [] : await listPluginConfigFiles(directory)
      result.push(await formatPluginEntry(entry.name, title, entry.name, support, {
        kind: "large",
        sourcePath: `plugins/${entry.name}`,
        configFiles,
      }))
      continue
    }
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(".js")) {
        const id = `${entry.name}/${child.name}`
        result.push(await formatPluginEntry(id, path.basename(child.name, ".js"), id, null, {
          kind: "small",
          sourcePath: `plugins/${id}`,
        }))
      }
    }
  }
  return result.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "large" ? -1 : 1) || a.title.localeCompare(b.title, "zh-CN"))
}

async function findPluginSupport(id) {
  if (typeof id !== "string" || id.includes("..") || id.includes("\\") || id.includes("/")) {
    throw Object.assign(new Error("插件标识无效"), { status: 400 })
  }
  const directory = path.join(PLUGINS, id)
  if (!isInside(PLUGINS, directory)) throw Object.assign(new Error("插件路径无效"), { status: 400 })
  const support = await loadPluginSupport(directory)
  if (!support) {
    const entryNames = PLUGIN_SUPPORT_ENTRIES.map(entry => entry.fileName).join("、")
    throw Object.assign(new Error(`该插件没有受支持的配置入口（${entryNames}）`), { status: 404 })
  }
  return support
}

async function writeBackupAndFile(absolute, contents) {
  const relative = path.relative(ROOT, absolute)
  try {
    const stat = await fs.stat(absolute)
    if (stat.size <= MAX_TEXT_BYTES) {
      const backupPath = path.join(DATA_DIR, "backups", `${Date.now()}-${relative.replace(/[\\/:]/g, "__")}.bak`)
      await fs.mkdir(path.dirname(backupPath), { recursive: true })
      await fs.copyFile(absolute, backupPath)
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${crypto.randomBytes(6).toString("hex")}.tmp`
  await fs.writeFile(temporary, contents, "utf8")
  try {
    await fs.rename(temporary, absolute)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function getAccountSummary() {
  const bot = global.Bot
  if (!bot) return []
  const ids = Object.keys(bot).filter(key => /^\d+$/.test(key))
  return ids.map(id => {
    const account = bot[id]
    return {
      id,
      online: account?.isOnline !== false && account?.status !== "offline",
      status: account?.isOnline === false || account?.status === "offline" ? "离线" : "在线",
      nickname: account?.nickname || "",
    }
  })
}

function parseLogBuffer(buffer, startOffset) {
  const entries = []
  let lineStart = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue
    const lineEnd = index > lineStart && buffer[index - 1] === 0x0d ? index - 1 : index
    entries.push({ id: startOffset + lineStart, text: buffer.subarray(lineStart, lineEnd).toString("utf8") })
    lineStart = index + 1
  }
  if (lineStart < buffer.length) {
    entries.push({ id: startOffset + lineStart, text: buffer.subarray(lineStart).toString("utf8") })
  }
  return {
    entries,
    cursor: lineStart < buffer.length ? startOffset + lineStart : startOffset + buffer.length,
  }
}

function logFileIdentity(stat) {
  return `${stat.dev}:${stat.ino}`
}

async function readLogTail(filePath, maxLines = 600) {
  try {
    const stat = await fs.stat(filePath)
    const length = Math.min(stat.size, MAX_LOG_TAIL_BYTES)
    const fileStart = stat.size - length
    const file = await fs.open(filePath, "r")
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, fileStart)
      const data = buffer.subarray(0, bytesRead)
      let firstLineOffset = 0
      if (fileStart > 0) {
        const firstNewline = data.indexOf(0x0a)
        if (firstNewline >= 0) firstLineOffset = firstNewline + 1
      }
      const parsed = parseLogBuffer(data.subarray(firstLineOffset), fileStart + firstLineOffset)
      return { entries: parsed.entries.slice(-maxLines), cursor: parsed.cursor, size: stat.size, identity: logFileIdentity(stat) }
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error.code === "ENOENT") return { entries: [], cursor: 0, size: 0, identity: "" }
    throw error
  }
}

async function readLogSince(filePath, cursor, maxLines = 50, expectedIdentity = "") {
  try {
    const stat = await fs.stat(filePath)
    const identity = logFileIdentity(stat)
    if (expectedIdentity && expectedIdentity !== identity) {
      return { ...(await readLogTail(filePath, maxLines)), replace: true }
    }
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > stat.size || stat.size - cursor > MAX_LOG_DELTA_BYTES) {
      return { ...(await readLogTail(filePath, maxLines)), replace: true }
    }
    const length = stat.size - cursor
    if (!length) return { entries: [], cursor, size: stat.size, identity, replace: false }
    const file = await fs.open(filePath, "r")
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, cursor)
      const parsed = parseLogBuffer(buffer.subarray(0, bytesRead), cursor)
      return { entries: parsed.entries.slice(-maxLines), cursor: parsed.cursor, size: stat.size, identity, replace: false }
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error.code === "ENOENT") return { entries: [], cursor: 0, size: 0, identity: "", replace: true }
    throw error
  }
}

function sendLogPacket(socket, packet) {
  if (socket.readyState === 1) socket.send(JSON.stringify(packet))
}

async function sendLogCatchup(socket, recent = false) {
  const subscription = socket.logSubscription
  if (!subscription || subscription.busy || socket.readyState !== 1) return
  subscription.busy = true
  try {
    const filePath = path.join(LOGS_DIR, subscription.file)
    const previousCursor = subscription.cursor
    const previousIdentity = subscription.identity
    const result = recent
      ? await readLogTail(filePath, 50)
      : await readLogSince(filePath, subscription.cursor, 600, subscription.identity)
    subscription.cursor = result.cursor
    subscription.identity = result.identity
    sendLogPacket(socket, {
      type: "logs",
      file: subscription.file,
      entries: result.entries,
      cursor: result.cursor,
      identity: result.identity,
      replace: Boolean(result.replace) || (recent && (result.size < previousCursor || (previousIdentity && result.identity !== previousIdentity))),
    })
  } catch (error) {
    safeLogger("warn", `[AdminPanel] 读取日志增量失败：${error.message}`)
  } finally {
    subscription.busy = false
  }
}

function scheduleLogBroadcast(file) {
  const previous = logWatchTimers.get(file)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    logWatchTimers.delete(file)
    if (!logWebSocketServer) return
    for (const socket of logWebSocketServer.clients) {
      if (socket.logSubscription?.file === file) void sendLogCatchup(socket)
    }
  }, 60)
  timer.unref?.()
  logWatchTimers.set(file, timer)
}

function startLogDirectoryWatcher() {
  if (logDirectoryWatcher) return
  try {
    logDirectoryWatcher = watchDirectory(LOGS_DIR, (_event, filename) => {
      if (filename == null) {
        for (const socket of logWebSocketServer?.clients || []) {
          const file = socket.logSubscription?.file
          if (file) scheduleLogBroadcast(file)
        }
        return
      }
      const file = String(filename)
      if (LOG_FILE_PATTERN.test(file)) scheduleLogBroadcast(file)
    })
    logDirectoryWatcher.on("error", error => {
      safeLogger("warn", `[AdminPanel] 日志目录监听异常：${error.message}`)
      logDirectoryWatcher?.close()
      logDirectoryWatcher = null
    })
  } catch (error) {
    safeLogger("warn", `[AdminPanel] 无法监听日志目录，将依靠 WebSocket 定时补取：${error.message}`)
  }
}

function attachLogWebSocket(server) {
  logWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 })
  logHeartbeatTimer = setInterval(() => {
    for (const socket of logWebSocketServer.clients) {
      if (socket.readyState !== 1) continue
      if (socket.isAlive === false) {
        socket.terminate()
        continue
      }
      socket.isAlive = false
      socket.ping()
    }
  }, 30_000)
  logHeartbeatTimer.unref?.()
  server.once("close", () => clearInterval(logHeartbeatTimer))
  logWebSocketServer.on("connection", socket => {
    const token = socket.logSessionToken
    socket.isAlive = true
    socket.on("pong", () => { socket.isAlive = true })
    socket.on("error", () => socket.terminate())
    const sessionTimer = setInterval(() => {
      if (!verifySessionToken(token)) socket.close(4401, "登录已失效")
    }, 15_000)
    sessionTimer.unref?.()
    socket.on("close", () => clearInterval(sessionTimer))
    socket.on("message", raw => {
      if (!verifySessionToken(token)) {
        socket.close(4401, "登录已失效")
        return
      }
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (message?.type === "subscribe") {
        const file = String(message.file || "")
        if (!LOG_FILE_PATTERN.test(file)) {
          sendLogPacket(socket, { type: "error", message: "日志文件无效" })
          return
        }
        const cursor = Number(message.cursor)
        socket.logSubscription = {
          file,
          cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
          identity: typeof message.identity === "string" ? message.identity : "",
          busy: false,
        }
        void sendLogCatchup(socket, true)
      } else if (message?.type === "catchup" && socket.logSubscription) {
        void sendLogCatchup(socket, true)
      }
    })
  })
  server.on("upgrade", (request, socket, head) => {
    let pathname
    try { pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname } catch {
      socket.destroy()
      return
    }
    if (pathname !== "/api/logs/ws") {
      socket.destroy()
      return
    }
    const origin = request.headers.origin
    if (origin) {
      try {
        if (new URL(origin).host !== request.headers.host) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
          socket.destroy()
          return
        }
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
        socket.destroy()
        return
      }
    }
    let token
    try { token = parseCookies(request.headers.cookie).get("elia_panel_session") } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    if (!token || !verifySessionToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    logWebSocketServer.handleUpgrade(request, socket, head, webSocket => {
      webSocket.logSessionToken = token
      logWebSocketServer.emit("connection", webSocket, request)
    })
  })
}

async function restartBot() {
  const token = process.env.KSR_RESTART_TOKEN
  const port = Number(cfg.bot?.restart_port || 27881)
  if (token) {
    const challengeResponse = await fetch(`http://127.0.0.1:${port}/challenge`, { signal: AbortSignal.timeout(2500) })
    if (!challengeResponse.ok) throw new Error(`重启服务返回 HTTP ${challengeResponse.status}`)
    const nonce = (await challengeResponse.text()).trim()
    const sign = crypto.createHmac("sha256", token).update(nonce).digest("hex")
    const response = await fetch(`http://127.0.0.1:${port}/restart?nonce=${encodeURIComponent(nonce)}&sign=${sign}`, { signal: AbortSignal.timeout(2500) })
    if (!response.ok) throw new Error(`重启请求返回 HTTP ${response.status}`)
    return "已向 ksr 重启服务发送请求"
  }
  if (process.env.pm_id !== undefined) {
    const pm2Script = path.join(ROOT, "node_modules", "pm2", "bin", "pm2")
    await fs.access(pm2Script)
    const child = spawn(process.execPath, [pm2Script, "restart", "./config/pm2/pm2.json"], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true })
    child.unref()
    return "已向 PM2 发送重启请求"
  }
  throw Object.assign(new Error("当前没有可识别的守护进程，面板未强制结束 Bot。请通过外部进程管理器重启。"), { status: 409 })
}

function runProcess(command, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let timedOut = false
    const collect = chunk => { if (output.length < 160_000) output += chunk.toString() }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once("error", error => { clearTimeout(timeout); reject(error) })
    child.once("close", code => {
      clearTimeout(timeout)
      if (timedOut) return reject(new Error("Git 操作超过 2 分钟，已停止"))
      if (code !== 0) return reject(new Error(output.trim() || `命令退出码 ${code}`))
      resolve(output.trim())
    })
  })
}

function validateRemoteRepository(input) {
  let url
  try { url = new URL(input) } catch { throw Object.assign(new Error("请输入有效的 HTTPS 仓库地址"), { status: 400 }) }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname || net.isIP(url.hostname) || url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw Object.assign(new Error("插件仓库只接受不含凭据的公开 HTTPS 域名地址"), { status: 400 })
  }
  const name = path.posix.basename(url.pathname.replace(/\/$/, "")).replace(/\.git$/i, "")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || name === "." || name === "..") {
    throw Object.assign(new Error("无法从仓库地址生成安全的插件目录名"), { status: 400 })
  }
  url.search = ""
  url.hash = ""
  return { url: url.toString().replace(/\/$/, ""), name }
}

function makeResult() {
  return class Result {
    static ok(result = {}, message = "ok") { return { code: 0, result, message, isOk: true } }
    static error(...args) {
      const message = typeof args[0] === "string" ? args[0] : String(args[1] || "error")
      return { code: -1, result: {}, message, isOk: false }
    }
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

async function validateCronWithRuntime(expression) {
  const schedulerEntry = requireFromRoot.resolve("node-schedule")
  const requireFromScheduler = createRequire(schedulerEntry)
  let cronParser
  try {
    cronParser = requireFromScheduler("cron-parser")
  } catch (error) {
    if (error.code !== "ERR_REQUIRE_ESM") throw error
    cronParser = await import(pathToFileURL(requireFromScheduler.resolve("cron-parser")).href)
  }
  let parse
  let parserApi
  if (typeof cronParser.parseExpression === "function") {
    parse = cronParser.parseExpression.bind(cronParser)
    parserApi = "parseExpression"
  } else if (typeof cronParser.CronExpressionParser?.parse === "function") {
    parse = cronParser.CronExpressionParser.parse.bind(cronParser.CronExpressionParser)
    parserApi = "CronExpressionParser.parse"
  } else if (typeof cronParser.default?.parseExpression === "function") {
    parse = cronParser.default.parseExpression.bind(cronParser.default)
    parserApi = "default.parseExpression"
  } else if (typeof cronParser.default?.CronExpressionParser?.parse === "function") {
    parse = cronParser.default.CronExpressionParser.parse.bind(cronParser.default.CronExpressionParser)
    parserApi = "default.CronExpressionParser.parse"
  }
  if (!parse) throw new Error("当前 node-schedule 所依赖的 cron-parser 暂不支持已识别的解析 API")
  const schedule = parse(expression, { currentDate: new Date() })
  const nextRun = schedule.next()
  return { parserApi, nextRun: nextRun?.toString?.() || String(nextRun || "") }
}

export async function startAdminPanel() {
  if (expressServer) return
  const settings = await readPanelSettings()
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(LOGS_DIR, { recursive: true })
  sessionSecret = await loadSessionSecret()
  await loadPersistedSessions()
  await initializePassword()
  const app = express()
  app.disable("x-powered-by")
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Referrer-Policy", "same-origin")
    res.setHeader("X-Frame-Options", "DENY")
    res.setHeader("Cache-Control", "no-store")
    next()
  })
  app.use(express.json({ limit: "3mb" }))

  app.get("/api/auth/status", (req, res) => {
    const token = parseCookies(req.headers.cookie).get("elia_panel_session")
    const session = token && verifySessionToken(token)
    const authenticated = Boolean(session)
    if (!authenticated && token) {
      clearSessionCookie(req, res)
    }
    res.json({ authenticated, expiresAt: authenticated ? session.expiresAt : null })
  })
  app.post("/api/auth/login", checkOrigin, asyncRoute(async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown"
    const attempt = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 }
    if (attempt.resetAt < Date.now()) {
      attempt.count = 0
      attempt.resetAt = Date.now() + 15 * 60 * 1000
    }
    if (attempt.count >= 10) return res.status(429).json({ error: "登录尝试次数过多，请 15 分钟后重试" })
    const submitted = String(req.body?.password || "")
    if (await verifyPanelPassword(submitted)) {
      loginAttempts.delete(ip)
      const expiresAt = await issueSession(req, res)
      return res.json({ authenticated: true, expiresAt })
    }
    attempt.count += 1
    loginAttempts.set(ip, attempt)
    res.status(401).json({ error: "密码不正确" })
  }))
  app.post("/api/auth/code/request", checkOrigin, (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown"
    if (loginCode?.expiresAt > Date.now()) return res.status(429).json({ error: "当前验证码仍有效，请查看 Bot 控制台日志" })
    if (!allowAttempt(codeRequestAttempts, ip, 3, 15 * 60 * 1000)) return res.status(429).json({ error: "验证码请求过于频繁，请 15 分钟后再试" })
    const code = crypto.randomBytes(12).toString("base64url")
    loginCode = { value: code, expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0 }
    safeLogger("warn", `[AdminPanel] 验证码登录请求：验证码 ${code}，5 分钟内有效且只能使用一次。若非本人操作请忽略。`)
    res.json({ ok: true, expiresIn: 300, message: "验证码已输出到 Bot 控制台日志，有效期 5 分钟" })
  })
  app.post("/api/auth/code/check", checkOrigin, asyncRoute(async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown"
    if (!allowAttempt(codeCheckAttempts, ip, 12, 15 * 60 * 1000)) return res.status(429).json({ error: "验证码尝试次数过多，请稍后再试" })
    const submitted = String(req.body?.code || "").trim()
    if (loginCode && loginCode.expiresAt > Date.now() && crypto.timingSafeEqual(hashSecret(submitted), hashSecret(loginCode.value))) {
      loginCode = null
      const expiresAt = await issueSession(req, res)
      safeLogger("mark", "[AdminPanel] 验证码登录成功")
      return res.json({ authenticated: true, expiresAt })
    }
    if (loginCode && ++loginCode.attempts >= 10) loginCode = null
    res.status(401).json({ error: "验证码错误或已过期" })
  }))
  app.post("/api/auth/quick", checkOrigin, asyncRoute(async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown"
    if (!allowAttempt(quickLoginAttempts, ip, 20, 15 * 60 * 1000)) return res.status(429).json({ error: "快捷登录尝试过于频繁，请稍后再试" })
    const code = String(req.body?.code || "")
    const quickLoginExpiresAt = quickLogins.get(code)
    if (!quickLoginExpiresAt || quickLoginExpiresAt <= Date.now()) {
      if (code) quickLogins.delete(code)
      return res.status(401).json({ error: "主人快捷地址已使用或超过 3 分钟，请重新向 Bot 获取" })
    }
    quickLogins.delete(code)
    const expiresAt = await issueSession(req, res)
    safeLogger("mark", "[AdminPanel] 主人快捷地址登录成功")
    res.json({ authenticated: true, expiresAt })
  }))
  app.post("/api/auth/logout", checkOrigin, requireAuth, asyncRoute(async (req, res) => {
    sessions.delete(req.panelSession.sessionIdHash)
    await persistSessions()
    clearSessionCookie(req, res)
    res.json({ ok: true })
  }))

  app.use("/api", requireAuth)
  app.use("/api", checkOrigin)

  app.post("/api/cron/validate", asyncRoute(async (req, res) => {
    const expression = String(req.body?.expression || "").trim()
    const fields = expression ? expression.split(/\s+/) : []
    if (!expression || expression.length > 120 || ![5, 6].includes(fields.length)) {
      return res.json({ valid: false, fieldCount: fields.length, message: "请输入 5 段或 6 段 Cron 表达式（6 段格式含秒）" })
    }
    try {
      const result = await validateCronWithRuntime(expression)
      res.json({ valid: true, fieldCount: fields.length, ...result, message: "符合当前 Yunzai 定时任务解析器" })
    } catch (error) {
      res.json({ valid: false, fieldCount: fields.length, message: error.message || "当前 Yunzai 无法解析该 Cron 表达式" })
    }
  }))

  app.get("/api/status", (req, res) => {
    const accounts = getAccountSummary()
    let groupCount = 0
    try { groupCount = global.Bot?.gl?.size || 0 } catch {}
    const memory = process.memoryUsage()
    res.json({
      name: "Yunzai",
      version: cfg.package?.version || "未知",
      pid: process.pid,
      uptime: process.uptime(),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      host: process.env.HOSTNAME || process.env.COMPUTERNAME || "本机",
      platform: `${process.platform} ${process.arch}`,
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
      accounts,
      groupCount,
      restartAvailable: Boolean(process.env.KSR_RESTART_TOKEN || process.env.pm_id !== undefined),
      panel: settings,
    })
  })

  app.get("/api/config", asyncRoute(async (req, res) => {
    const directory = path.join(ROOT, "config", "config")
    const files = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(file => file.isFile() && file.name.endsWith(".yaml"))
      .map(file => file.name)
      .sort()
    res.json({ files })
  }))
  app.get("/api/config/:name", asyncRoute(async (req, res) => {
    if (!/^[a-z0-9_-]+\.yaml$/i.test(req.params.name)) return res.status(400).json({ error: "配置文件名无效" })
    const filePath = path.join(ROOT, "config", "config", req.params.name)
    const content = await fs.readFile(filePath, "utf8")
    const name = req.params.name.replace(/\.yaml$/i, "")
    let defaults = null
    try { defaults = YAML.parse(await fs.readFile(path.join(ROOT, "config", "default_config", req.params.name), "utf8")) } catch {}
    res.json({ name: req.params.name, content, data: YAML.parse(content), defaults })
  }))
  app.put("/api/config/:name", asyncRoute(async (req, res) => {
    if (!/^[a-z0-9_-]+\.yaml$/i.test(req.params.name)) return res.status(400).json({ error: "配置文件名无效" })
    const filePath = path.join(ROOT, "config", "config", req.params.name)
    const content = typeof req.body?.content === "string" ? req.body.content : YAML.stringify(req.body?.data)
    const parsed = YAML.parse(content)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return res.status(400).json({ error: "配置必须是 YAML 对象" })
    await writeBackupAndFile(filePath, content.endsWith("\n") ? content : `${content}\n`)
    const name = req.params.name.replace(/\.yaml$/i, "")
    if (cfg.config) cfg.config[`config.${name}`] = parsed
    res.json({ ok: true, message: "已保存配置并刷新运行时缓存" })
  }))

  app.get("/api/plugins", asyncRoute(async (req, res) => res.json({ plugins: await listPlugins() })))
  app.get("/api/plugins/:id/config", asyncRoute(async (req, res) => {
    const support = await findPluginSupport(req.params.id)
    if (typeof support.configInfo?.getConfigData !== "function") return res.status(404).json({ error: "插件未提供 getConfigData()" })
    res.json({ data: await support.configInfo.getConfigData() })
  }))
  app.put("/api/plugins/:id/config", asyncRoute(async (req, res) => {
    const support = await findPluginSupport(req.params.id)
    if (typeof support.configInfo?.setConfigData !== "function") return res.status(404).json({ error: "插件未提供 setConfigData()" })
    const result = await support.configInfo.setConfigData(req.body || {}, { Result: makeResult() })
    res.json(result && typeof result === "object" ? result : { ok: true, result, message: "保存成功" })
  }))
  app.post("/api/plugins/:id/action", asyncRoute(async (req, res) => {
    const support = await findPluginSupport(req.params.id)
    const action = support.configInfo?.actions?.[req.body?.action]
    if (typeof action !== "function") return res.status(404).json({ error: "没有找到该插件操作" })
    const result = await action(req.body?.args, { Result: makeResult() })
    res.json(result && typeof result === "object" ? result : { ok: true, result, message: "操作完成" })
  }))
  app.post("/api/plugins/install", asyncRoute(async (req, res) => {
    const { url, name: inferredName } = validateRemoteRepository(String(req.body?.url || ""))
    const name = String(req.body?.name || inferredName)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || name === "..") return res.status(400).json({ error: "插件目录名无效" })
    const target = path.join(PLUGINS, name)
    try { await fs.access(target); return res.status(409).json({ error: `plugins/${name} 已存在` }) } catch (error) { if (error.code !== "ENOENT") throw error }
    try {
      await runProcess("git", ["clone", "--depth", "1", "--single-branch", url, target])
      const entries = await fs.readdir(target)
      if (!entries.includes("index.js") && !entries.some(entry => entry.endsWith(".js"))) throw new Error("仓库克隆成功，但未找到 Yunzai 插件入口文件")
      let hasPackage = false
      try { await fs.access(path.join(target, "package.json")); hasPackage = true } catch {}
      res.json({ ok: true, name, hasPackage, message: `已下载到 plugins/${name}${hasPackage ? "。请在项目终端安装插件依赖" : ""}，重启 Bot 后加载。` })
    } catch (error) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }))
  app.get("/api/plugins/archives", asyncRoute(async (req, res) => {
    const archiveRoot = path.join(DATA_DIR, "archived-plugins")
    await fs.mkdir(archiveRoot, { recursive: true })
    const archives = (await fs.readdir(archiveRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]*--\d+$/.test(entry.name))
      .map(entry => ({ id: entry.name, name: entry.name.replace(/--\d+$/, "") }))
      .sort((a, b) => b.id.localeCompare(a.id))
    res.json({ archives })
  }))
  app.post("/api/plugins/:id/archive", asyncRoute(async (req, res) => {
    const id = req.params.id
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || id.toLowerCase() === "eliaadminpanel") return res.status(400).json({ error: "此插件不能归档" })
    const source = path.join(PLUGINS, id)
    const stat = await fs.lstat(source)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return res.status(400).json({ error: "目标不是普通插件目录" })
    const archiveRoot = path.join(DATA_DIR, "archived-plugins")
    await fs.mkdir(archiveRoot, { recursive: true })
    const archiveId = `${id}--${Date.now()}`
    await fs.rename(source, path.join(archiveRoot, archiveId))
    res.json({ ok: true, archiveId, message: `插件 ${id} 已移入可恢复归档；重启 Bot 后卸载生效` })
  }))
  app.post("/api/plugins/archives/:archiveId/restore", asyncRoute(async (req, res) => {
    const archiveId = req.params.archiveId
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*--\d+$/.test(archiveId)) return res.status(400).json({ error: "归档编号无效" })
    const name = archiveId.replace(/--\d+$/, "")
    if (name.toLowerCase() === "eliaadminpanel") return res.status(400).json({ error: "不能恢复到面板自身目录" })
    const archivePath = path.join(DATA_DIR, "archived-plugins", archiveId)
    const target = path.join(PLUGINS, name)
    try { await fs.access(target); return res.status(409).json({ error: `plugins/${name} 已存在，无法覆盖` }) } catch (error) { if (error.code !== "ENOENT") throw error }
    await fs.rename(archivePath, target)
    res.json({ ok: true, message: `已恢复到 plugins/${name}；重启 Bot 后加载` })
  }))

  app.get("/api/files", asyncRoute(async (req, res) => {
    const requested = String(req.query.path || ".")
    const absolute = resolveWorkspacePath(requested)
    await rejectSymlinkPath(absolute)
    const stat = await fs.stat(absolute)
    if (!stat.isDirectory()) return res.status(400).json({ error: "目标不是目录" })
    const entries = await fs.readdir(absolute, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (BLOCKED_SEGMENTS.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue
      const childPath = path.join(absolute, entry.name)
      if (entry.isDirectory()) {
        files.push({ name: entry.name, path: path.relative(ROOT, childPath).split(path.sep).join("/"), type: "directory" })
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase() || (entry.name.startsWith(".") ? entry.name.toLowerCase() : "")
        const childStat = await fs.stat(childPath)
        if (childStat.size > MAX_TEXT_BYTES || !ALLOWED_TEXT_EXTENSIONS.has(extension)) continue
        files.push({ name: entry.name, path: path.relative(ROOT, childPath).split(path.sep).join("/"), type: "file", size: childStat.size })
      }
    }
    files.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1)
    res.json({ path: path.relative(ROOT, absolute).split(path.sep).join("/") || ".", parent: path.relative(ROOT, path.dirname(absolute)).split(path.sep).join("/") || ".", entries: files })
  }))
  app.get("/api/files/read", asyncRoute(async (req, res) => {
    const relative = String(req.query.path || "")
    const absolute = resolveWorkspacePath(relative)
    await rejectSymlinkPath(absolute)
    const stat = await fs.stat(absolute)
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return res.status(400).json({ error: "文件不存在或超过 1.5 MB 编辑上限" })
    const extension = path.extname(absolute).toLowerCase() || path.basename(absolute).toLowerCase()
    if (!ALLOWED_TEXT_EXTENSIONS.has(extension)) return res.status(415).json({ error: "该文件类型不能在面板中编辑" })
    const content = await fs.readFile(absolute, "utf8")
    if (content.includes("\0")) return res.status(415).json({ error: "二进制文件不能在面板中编辑" })
    res.json({ path: path.relative(ROOT, absolute).split(path.sep).join("/"), content, size: stat.size, modifiedAt: stat.mtime.toISOString() })
  }))
  app.put("/api/files/write", asyncRoute(async (req, res) => {
    const relative = String(req.body?.path || "")
    const content = req.body?.content
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) return res.status(400).json({ error: "文件内容无效或超过 1.5 MB" })
    const absolute = resolveWorkspacePath(relative)
    await rejectSymlinkPath(absolute)
    const extension = path.extname(absolute).toLowerCase() || path.basename(absolute).toLowerCase()
    if (!ALLOWED_TEXT_EXTENSIONS.has(extension)) return res.status(415).json({ error: "该文件类型不能在面板中编辑" })
    await writeBackupAndFile(absolute, content)
    res.json({ ok: true, message: "文件已保存；自动备份保存在 data/elia-admin-panel/backups" })
  }))

  app.get("/api/logs", asyncRoute(async (req, res) => {
    const files = []
    try {
      for (const entry of await fs.readdir(LOGS_DIR, { withFileTypes: true })) {
        if (entry.isFile() && LOG_FILE_PATTERN.test(entry.name)) files.push(entry.name)
      }
    } catch {}
    files.sort((left, right) => {
      const leftDate = left.match(/\.(\d{4}-\d{2}-\d{2})\.log$/)?.[1] || ""
      const rightDate = right.match(/\.(\d{4}-\d{2}-\d{2})\.log$/)?.[1] || ""
      return rightDate.localeCompare(leftDate) || left.localeCompare(right)
    })
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
    const todayCommandLog = `command.${today}.log`
    const latestCommandLog = files.find(file => /^command\.\d{4}-\d{2}-\d{2}\.log$/.test(file))
    const defaultFile = files.includes(todayCommandLog) ? todayCommandLog : latestCommandLog || files[0] || ""
    const selected = String(req.query.file || defaultFile)
    if (!files.includes(selected)) return res.status(400).json({ error: "日志文件无效", files })
    const log = await readLogTail(path.join(LOGS_DIR, selected))
    res.json({ files, selected, content: log.entries.map(entry => entry.text).join("\n"), entries: log.entries, cursor: log.cursor, identity: log.identity })
  }))
  app.post("/api/runtime/restart", asyncRoute(async (req, res) => {
    const message = await restartBot()
    res.json({ ok: true, message })
  }))

  app.use("/api", (req, res) => res.status(404).json({ error: "API 不存在" }))
  app.use(express.static(STATIC_DIR, { index: false, maxAge: "1h", fallthrough: true }))
  app.use((req, res, next) => {
    fs.access(path.join(STATIC_DIR, "index.html"))
      .then(() => res.sendFile(path.join(STATIC_DIR, "index.html")))
      .catch(() => res.status(503).send("Web UI 尚未构建。请在 plugins/EliaAdminPanel 中运行 pnpm install 和 pnpm run build。"))
  })
  app.use((error, req, res, next) => {
    const status = Number(error.status) || 500
    if (status >= 500) safeLogger("error", `[AdminPanel] ${req.method} ${req.path}: ${error.stack || error.message}`)
    res.status(status).json({ error: status >= 500 ? "面板处理请求失败，请查看 Bot 日志" : error.message })
  })

  expressServer = await new Promise((resolve, reject) => {
    const server = app.listen(settings.port, settings.host)
    server.once("listening", () => resolve(server))
    server.once("error", reject)
  })
  attachLogWebSocket(expressServer)
  startLogDirectoryWatcher()
  const address = expressServer.address()
  const shownHost = settings.host === "0.0.0.0" || settings.host === "::" ? "127.0.0.1" : settings.host
  safeLogger("mark", `[EliaAdminPanel] Web 管理面板已启动：http://${shownHost}:${address.port}`)
}

export async function createQuickLoginLinks() {
  if (!expressServer) throw new Error("面板服务尚未启动")
  const now = Date.now()
  for (const [code, expiresAt] of quickLogins) if (expiresAt <= now) quickLogins.delete(code)
  const code = crypto.randomBytes(12).toString("base64url")
  quickLogins.set(code, now + 3 * 60 * 1000)
  const links = (await panelAddresses()).map(address => `${address.replace(/\/$/, "")}/#/ml/${code}`)
  return { links, expiresIn: 180 }
}
