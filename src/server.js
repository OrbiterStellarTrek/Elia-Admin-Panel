import crypto from "node:crypto"
import { existsSync, watch as watchDirectory } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import { pathToFileURL, fileURLToPath } from "node:url"
import express from "express"
import { WebSocketServer } from "ws"
import YAML from "yaml"
import { updateYamlPreservingComments } from "./config-yaml.js"
import { pickNumericGroup, ffmpegPath } from "./bot-capabilities.js"
import { repositoryInfo, fetchRepository, updateRepository, validateDependencies, downloadScript } from "./plugin-management.js"
import { readConfig as readPanelConfig, writeConfig as writePanelConfig, configEvents, configGeneration, deliverCredential } from "./panel-config.js"
import { contentVersion, credentialVersion, withLock, withBudget, requireVersion, originAllowed, requestIsSecure, devRequestNeedsAuth, redact } from "./security.js"
import { safeDownload, secureGitTransport } from "./network-policy.js"
import { auditEvent } from "./audit.js"
import { ensureFrontendBuild } from "./frontend-build.js"
import cfg from "../../../lib/config/config.js"
import pluginsLoader from "../../../lib/plugins/loader.js"

const ROOT = process.cwd()
const requireFromRoot = createRequire(path.join(ROOT, "package.json"))
const PLUGINS = path.join(ROOT, "plugins")
const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const requireFromPanel = createRequire(path.join(PANEL_DIR, "package.json"))
const DATA_DIR = path.join(ROOT, "data", "elia-admin-panel")
const PANEL_CONFIG = path.join(DATA_DIR, "config.yaml")
const LOGS_DIR = path.join(ROOT, "logs")
const SESSION_STORE_FILE = path.join(DATA_DIR, "sessions.json")
const STATIC_DIR = path.join(PANEL_DIR, "out")
const MAX_TEXT_BYTES = 1_500_000
const MAX_PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_PREVIEW_AUDIO_BYTES = 20 * 1024 * 1024
const MAX_DEBUG_INLINE_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_DEBUG_INLINE_AUDIO_BYTES = 2 * 1024 * 1024
const MAX_DEBUG_AUDIO_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_DEBUG_AUDIO_TRANSCODES_PER_EVENT = 3
const MAX_DEBUG_FORWARD_FETCHES_PER_EVENT = 3
const MAX_DEBUG_FORWARD_NODES = 20
const DEBUG_AUDIO_CACHE_TTL_MS = 10 * 60 * 1000
const DEBUG_AUDIO_CACHE_MAX_BYTES = 32 * 1024 * 1024
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_LOG_TAIL_BYTES = 512 * 1024
const MAX_LOG_DELTA_BYTES = 2 * 1024 * 1024
const LOG_FILE_PATTERN = /^(?:error|command)(?:\.\d{4}-\d{2}-\d{2})?\.log$/
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const PASSWORD_HASH_ITERATIONS = 310_000
const DEFAULT_LOGIN_IMAGE_API = "https://t.alcy.cc/moe"
const ALLOWED_TEXT_EXTENSIONS = new Set([
  ".yaml", ".yml", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".css", ".scss", ".md", ".txt", ".html", ".xml", ".conf", ".ini", ".toml",
  ".sh", ".bat", ".ps1", ".properties", ".env", ".gitignore", ".editorconfig",
])
const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".bmp", "image/bmp"],
  [".avif", "image/avif"], [".ico", "image/x-icon"],
])
const AUDIO_MIME_TYPES = new Map([
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"], [".opus", "audio/ogg"], [".m4a", "audio/mp4"],
  [".aac", "audio/aac"], [".flac", "audio/flac"], [".amr", "audio/amr"],
  [".webm", "audio/webm"],
])
const DEBUG_AUDIO_INPUT_FORMATS = new Map([
  ["audio/mpeg", "mp3"], ["audio/wav", "wav"], ["audio/ogg", "ogg"],
  ["audio/flac", "flac"], ["audio/amr", "amr"], ["audio/mp4", "mp4"],
  ["audio/aac", "aac"], ["audio/webm", "webm"],
])
const PLUGIN_CONFIG_EXTENSIONS = new Set([".yaml", ".yml", ".json", ".toml", ".ini", ".conf", ".properties"])
const PLUGIN_SCAN_IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".next", "out", "dist", "build", "coverage", "data", "logs"])
const PLUGIN_SCAN_IGNORED_ROOTS = new Set(["system", "other"])
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", ".next", "out"])

const sessions = new Map()
const debugAudioCache = new Map()
let debugAudioCacheBytes = 0
const pluginRuleSnapshotCache = new WeakMap()
let sessionSecret = ""
let activeCredentialVersion = ""
let securityPolicy = {}
const devConnections = new Map()
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
let nextDevProcess
let nextDevPort
let logWebSocketServer
let logDirectoryWatcher
let logHeartbeatTimer
let loginCode
let warnedInvalidPublicUrl = false
const logWatchTimers = new Map()

const safeLogger = (level, message) => {
  try {
    if (global.logger?.[level]) global.logger[level](redact(message))
    else console.log(redact(message))
  } catch {
    console.log(redact(message))
  }
}

function loginImageApi(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) return DEFAULT_LOGIN_IMAGE_API
  try {
    const url = new URL(value.trim())
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return DEFAULT_LOGIN_IMAGE_API
    return url.toString()
  } catch {
    return DEFAULT_LOGIN_IMAGE_API
  }
}

function readPluginRuleSnapshot(entry) {
  const PluginClass = entry?.class
  if (typeof PluginClass !== "function") return { rules: [], error: "插件类不可读取" }
  const cached = pluginRuleSnapshotCache.get(PluginClass)
  if (cached) return cached
  try {
    const instance = new PluginClass()
    const rules = (Array.isArray(instance.rule) ? instance.rule : []).flatMap((rule, index) => {
      if (!rule || rule.reg === undefined || rule.reg === null) return []
      try {
        const expression = rule.reg instanceof RegExp ? rule.reg : new RegExp(rule.reg)
        return [{
          index,
          pattern: expression.source,
          flags: expression.flags,
          fnc: String(rule.fnc || "未指定"),
          event: String(rule.event || ""),
          permission: String(rule.permission || "all"),
        }]
      } catch (error) {
        return [{
          index,
          pattern: String(rule.reg),
          flags: "",
          fnc: String(rule.fnc || "未指定"),
          event: String(rule.event || ""),
          permission: String(rule.permission || "all"),
          regexError: error.message || "正则表达式无效",
        }]
      }
    })
    const snapshot = { rules }
    pluginRuleSnapshotCache.set(PluginClass, snapshot)
    return snapshot
  } catch (error) {
    const snapshot = { rules: [], error: error.message || "实例化插件类失败" }
    pluginRuleSnapshotCache.set(PluginClass, snapshot)
    return snapshot
  }
}

function isInside(parent, target) {
  const relative = path.relative(parent, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function formatDebugOutput(value) {
  const parts = Array.isArray(value) ? value : [value]
  return parts.map(part => {
    if (typeof part === "string") return part
    if (part?.type === "text") return String(part.text || "")
    try {
      return JSON.stringify(part, (_key, item) => Buffer.isBuffer(item) ? `[Buffer ${item.length} bytes]` : item)
    } catch {
      return String(part)
    }
  }).join("")
}

function debugImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg"
  if (buffer.subarray(0, 3).toString() === "GIF") return "image/gif"
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp"
  if (buffer.subarray(0, 2).toString() === "BM") return "image/bmp"
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString() === "ftyp" && /^(avif|avis)$/.test(buffer.subarray(8, 12).toString())) return "image/avif"
  return ""
}

function debugImageSource(source) {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    const buffer = Buffer.from(source)
    const mime = debugImageMime(buffer)
    return mime && buffer.length <= MAX_DEBUG_INLINE_IMAGE_BYTES ? `data:${mime};base64,${buffer.toString("base64")}` : ""
  }
  if (typeof source !== "string" || !source.trim()) return ""
  const value = source.trim()
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return ["http:", "https:"].includes(url.protocol) ? url.href : ""
    } catch { return "" }
  }
  const base64 = value.match(/^(?:base64:\/\/|data:image\/[^;,]+;base64,)([\s\S]+)$/i)
  if (base64) {
    const buffer = Buffer.from(base64[1], "base64")
    const mime = debugImageMime(buffer)
    return mime && buffer.length <= MAX_DEBUG_INLINE_IMAGE_BYTES ? `data:${mime};base64,${buffer.toString("base64")}` : ""
  }
  try {
    const absolute = value.startsWith("file:") ? fileURLToPath(value) : path.resolve(ROOT, value)
    if (!isInside(ROOT, absolute)) return ""
    const relative = path.relative(ROOT, absolute).split(path.sep).join("/")
    if (!IMAGE_MIME_TYPES.has(path.extname(absolute).toLowerCase())) return ""
    resolveWorkspacePath(relative)
    return `/api/files/image?path=${encodeURIComponent(relative)}`
  } catch { return "" }
}

function debugAudioMime(buffer) {
  if (buffer.subarray(0, 3).toString() === "ID3" || (buffer[0] === 255 && [241, 242, 243, 249, 250, 251].includes(buffer[1]))) return "audio/mpeg"
  if (buffer.subarray(0, 12).toString().startsWith("RIFF") && buffer.subarray(8, 12).toString() === "WAVE") return "audio/wav"
  if (buffer.subarray(0, 4).toString() === "OggS") return "audio/ogg"
  if (buffer.subarray(0, 4).toString() === "fLaC") return "audio/flac"
  if (buffer.subarray(0, 6).toString() === "#!AMR\n") return "audio/amr"
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString() === "ftyp") return "audio/mp4"
  if (buffer.length >= 2 && buffer[0] === 255 && [240, 241, 248, 249].includes(buffer[1])) return "audio/aac"
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "audio/webm"
  return ""
}

function pruneDebugAudioCache(now = Date.now()) {
  for (const [token, entry] of debugAudioCache) {
    if (entry.expiresAt <= now) {
      debugAudioCacheBytes -= entry.buffer.length
      debugAudioCache.delete(token)
    }
  }
}

function cacheDebugAudio(buffer) {
  if (!buffer.length || buffer.length > MAX_DEBUG_AUDIO_OUTPUT_BYTES) return ""
  pruneDebugAudioCache()
  while (debugAudioCacheBytes + buffer.length > DEBUG_AUDIO_CACHE_MAX_BYTES && debugAudioCache.size) {
    const oldestToken = debugAudioCache.keys().next().value
    const oldest = debugAudioCache.get(oldestToken)
    debugAudioCacheBytes -= oldest.buffer.length
    debugAudioCache.delete(oldestToken)
  }
  const token = crypto.randomBytes(24).toString("hex")
  debugAudioCache.set(token, { buffer, expiresAt: Date.now() + DEBUG_AUDIO_CACHE_TTL_MS })
  debugAudioCacheBytes += buffer.length
  return `/api/debug/audio/${token}`
}

function transcodeDebugAudio(options) {
  return withBudget("ffmpeg", 2, () => transcodeDebugAudioUnbounded(options))
}
function transcodeDebugAudioUnbounded({ inputPath, inputBuffer, inputFormat }) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin"]
    if (inputBuffer) args.push("-f", inputFormat, "-i", "pipe:0")
    else args.push("-i", inputPath)
    args.push("-map", "0:a:0", "-vn", "-ac", "1", "-ar", "24000", "-t", "180", "-c:a", "libmp3lame", "-b:a", "64k", "-f", "mp3", "pipe:1")

    const child = spawn(ffmpegPath(cfg), args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    const chunks = []
    let outputBytes = 0
    let stderr = ""
    let timedOut = false
    let outputTooLarge = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 20_000)
    child.stdout.on("data", chunk => {
      outputBytes += chunk.length
      if (outputBytes > MAX_DEBUG_AUDIO_OUTPUT_BYTES) {
        outputTooLarge = true
        child.kill()
      } else chunks.push(chunk)
    })
    child.stderr.on("data", chunk => {
      if (stderr.length < 8_000) stderr += chunk.toString().slice(0, 8_000 - stderr.length)
    })
    child.stdin.on("error", () => {})
    child.on("error", error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", code => {
      clearTimeout(timeout)
      if (timedOut) return reject(new Error("FFmpeg 转码超时"))
      if (outputTooLarge) return reject(new Error("转码后的音频超过大小限制"))
      if (code !== 0 || !outputBytes) return reject(new Error(stderr.trim() || "FFmpeg 无法解码此语音格式"))
      resolve(Buffer.concat(chunks, outputBytes))
    })
    if (inputBuffer) child.stdin.end(inputBuffer)
    else child.stdin.end()
  })
}

async function normalizeDebugAudio(source) {
  let inputBuffer = null
  let inputPath = ""
  let inputFormat = ""
  let name = ""

  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    inputBuffer = Buffer.from(source)
    if (inputBuffer.length > MAX_PREVIEW_AUDIO_BYTES) return { src: "", name, alt: "语音超过 20 MB 限制，无法转码" }
    inputFormat = DEBUG_AUDIO_INPUT_FORMATS.get(debugAudioMime(inputBuffer)) || ""
  } else if (typeof source === "string" && source.trim()) {
    const value = source.trim()
    const base64 = value.match(/^(?:base64:\/\/|data:audio\/[^;,]+;base64,)([\s\S]+)$/i)
    if (base64) {
      inputBuffer = Buffer.from(base64[1], "base64")
      if (inputBuffer.length > MAX_PREVIEW_AUDIO_BYTES) return { src: "", name, alt: "语音超过 20 MB 限制，无法转码" }
      inputFormat = DEBUG_AUDIO_INPUT_FORMATS.get(debugAudioMime(inputBuffer)) || ""
    } else if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value)
        const ext = path.extname(url.pathname).toLowerCase()
        const directTypes = new Set([".mp3", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".flac", ".webm"])
        if (["http:", "https:"].includes(url.protocol) && directTypes.has(ext)) return { src: url.href, name, alt: "语音消息" }
      } catch {}
      return { src: "", name, alt: "远程语音格式无法安全检测或转码" }
    } else {
      try {
        inputPath = value.startsWith("file:") ? fileURLToPath(value) : path.resolve(ROOT, value)
        if (!isInside(ROOT, inputPath)) return { src: "", name, alt: "语音文件位于工作区外，无法转码" }
        const relative = path.relative(ROOT, inputPath).split(path.sep).join("/")
        inputPath = resolveWorkspacePath(relative)
        await rejectSymlinkPath(inputPath)
        const stat = await fs.stat(inputPath)
        if (!stat.isFile()) return { src: "", name, alt: "语音文件不存在" }
        if (stat.size > MAX_PREVIEW_AUDIO_BYTES) return { src: "", name: path.basename(inputPath), alt: "语音超过 20 MB 限制，无法转码" }
        const extension = path.extname(inputPath).toLowerCase()
        if (!AUDIO_MIME_TYPES.has(extension) && ![".silk", ".slk", ".sil"].includes(extension)) {
          return { src: "", name: path.basename(inputPath), alt: "不支持的语音文件类型" }
        }
        name = path.basename(inputPath)
      } catch {
        return { src: "", name, alt: "语音文件无法安全读取" }
      }
    }
  } else {
    return { src: "", name, alt: "语音数据格式无法识别" }
  }

  if (inputBuffer && !inputFormat) return { src: "", name, alt: "FFmpeg 无法识别此语音编码" }
  try {
    const converted = await transcodeDebugAudio({ inputPath, inputBuffer, inputFormat })
    return { src: cacheDebugAudio(converted), name, alt: "语音消息（已转为 MP3）" }
  } catch (error) {
    const message = error?.message || String(error)
    const alt = /ENOENT/.test(message) ? "找不到 FFmpeg，无法播放此语音" : /timed out|超时/i.test(message) ? "语音转码超时，无法播放" : "当前 FFmpeg 不支持解码此语音格式"
    return { src: "", name, alt }
  }
}

async function normalizeDebugSegments(value, depth = 0, audioBudget = { count: 0 }, forwardContext = { count: 0, contact: null }) {
  if (depth > 6) return [{ type: "text", text: "[消息嵌套过深]" }]
  if (value == null) return []
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const src = debugImageSource(value)
    return src ? [{ type: "image", src, alt: "图片" }] : [{ type: "text", text: `[图片数据 ${value.byteLength} bytes，无法预览]` }]
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.length <= 200_000 && ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === "object") return normalizeDebugSegments(parsed, depth + 1, audioBudget, forwardContext)
      } catch {}
    }
    return [{ type: "text", text: value }]
  }
  if (Array.isArray(value)) {
    if (value.length && value.every(part => part?.type === "node")) return [{ type: "forward", title: "合并转发", nodes: await Promise.all(value.slice(0, MAX_DEBUG_FORWARD_NODES).map((node, index) => normalizeDebugNode(node, index, depth + 1, audioBudget, forwardContext))) }]
    return (await Promise.all(value.map(part => normalizeDebugSegments(part, depth + 1, audioBudget, forwardContext)))).flat()
  }
  if (typeof value !== "object") return [{ type: "text", text: String(value) }]

  const type = value.type
  if (!type && value.message !== undefined && (value.user_id !== undefined || value.userId !== undefined || value.nickname || value.sender)) {
    const sender = value.sender || {}
    return [{
      type: "chat-message",
      nickname: String(value.nickname || sender.nickname || sender.card || ""),
      userId: String(value.user_id || value.userId || sender.user_id || ""),
      segments: await normalizeDebugSegments(value.message, depth + 1, audioBudget, forwardContext),
    }]
  }
  if (type === "text") return [{ type: "text", text: String(value.text || "") }]
  if (type === "image" || type === "flash") {
    const src = debugImageSource(value.file ?? value.url ?? value.data?.file ?? value.data?.url)
    return [{ type: "image", src, alt: value.summary || (type === "flash" ? "闪照" : "图片"), width: value.width, height: value.height, size: value.size }]
  }
  if (type === "node") return [{ type: "forward", title: "合并转发", nodes: [await normalizeDebugNode(value, 0, depth + 1, audioBudget, forwardContext)] }]
  if (type === "forward") {
    const nodes = value.nodes || value.data?.nodes || value.content || value.data?.content || []
    return [{ type: "forward", title: value.title || "合并转发", summary: value.summary || "", nodes: Array.isArray(nodes) ? await Promise.all(nodes.slice(0, MAX_DEBUG_FORWARD_NODES).map((node, index) => normalizeDebugNode(node, index, depth + 1, audioBudget, forwardContext))) : [] }]
  }
  if (type === "json") {
    let data = value.data
    if (typeof data === "string") { try { data = JSON.parse(data) } catch {} }
    if (data?.app === "com.tencent.multimsg") {
      const detail = data.meta?.detail || {}
      const previews = Array.isArray(detail.news) ? detail.news : []
      let summary = detail.summary || "转发节点内容由 QQ 封装，当前仅显示预览摘要"
      let nodes = await Promise.all(previews.map(async (node, index) => ({ nickname: "", userId: "", segments: await normalizeDebugSegments(node.text || node, depth + 1, audioBudget, forwardContext), index })))
      const resid = detail.resid
      const fileName = detail.uniseq || "MultiMsg"
      if (resid && forwardContext.contact?.getForwardMsg && forwardContext.count < MAX_DEBUG_FORWARD_FETCHES_PER_EVENT) {
        forwardContext.count++
        let timeout
        try {
          const messages = await Promise.race([
            forwardContext.contact.getForwardMsg(String(resid), String(fileName)),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("转发内容获取超时")), 10_000) }),
          ])
          if (Array.isArray(messages) && messages.length) {
            const selected = messages.slice(0, MAX_DEBUG_FORWARD_NODES)
            nodes = await Promise.all(selected.map((node, index) => normalizeDebugNode(node, index, depth + 1, audioBudget, forwardContext)))
            summary = `已展开 ${selected.length} 条转发消息${messages.length > selected.length ? `（共 ${messages.length} 条）` : ""}`
          }
        } catch {
          summary = `${summary}（完整内容获取失败）`
        } finally {
          clearTimeout(timeout)
        }
      }
      return [{
        type: "forward",
        title: data.prompt || data.desc || "合并转发",
        summary,
        nodes,
      }]
    }
    return normalizeDebugSegments(data, depth + 1, audioBudget, forwardContext)
  }
  if (type === "at") return [{ type: "text", text: `@${value.text || value.qq || value.id || "全体成员"}` }]
  if (type === "face" || type === "bface" || type === "rps" || type === "dice") return [{ type: "text", text: value.text || `[${type === "face" || type === "bface" ? "表情" : type}]` }]
  if (type === "record" || type === "audio") {
    if (audioBudget.count >= MAX_DEBUG_AUDIO_TRANSCODES_PER_EVENT) return [{ type: "audio", src: "", name: "", alt: `每条调试事件最多转码 ${MAX_DEBUG_AUDIO_TRANSCODES_PER_EVENT} 段语音` }]
    audioBudget.count++
    const file = value.file ?? value.url ?? value.data?.file ?? value.data?.url
    return [{ type: "audio", ...await normalizeDebugAudio(file) }]
  }
  if (type === "video" || type === "file") {
    const label = type === "video" ? "视频" : "文件"
    return [{ type: "text", text: `[${label}${value.name ? `：${value.name}` : ""}]` }]
  }
  if (type === "xml") return [{ type: "text", text: typeof value.data === "string" ? value.data : JSON.stringify(value.data, null, 2) }]
  const entries = Object.entries(value).slice(0, 40).map(([label, item]) => ({
    label,
    value: typeof item === "string" ? item : JSON.stringify(item, null, 2),
  }))
  return [{ type: "object", entries }]
}

async function normalizeDebugNode(node, index, depth, audioBudget, forwardContext) {
  return {
    nickname: String(node?.nickname || node?.sender?.nickname || ""),
    userId: String(node?.user_id || node?.userId || ""),
    index: index + 1,
    segments: await normalizeDebugSegments(node?.message ?? node?.content ?? "", depth + 1, audioBudget, forwardContext),
  }
}

function createPanelDebugEvent({ message, userId, messageType, groupId, replies }) {
  const bot = global.Bot
  if (!bot) throw Object.assign(new Error("Yunzai Bot 尚未初始化"), { status: 503 })
  let event
  const audioBudget = { count: 0 }
  const client = bot[bot.uin] || bot
  let forwardContact = null
  try {
    if (messageType === "group" && /^\d+$/.test(groupId)) forwardContact = pickNumericGroup(client, groupId)
    else if (messageType === "private" && /^\d+$/.test(userId)) forwardContact = client.pickFriend(Number(userId))
  } catch {}
  const forwardContext = { count: 0, contact: forwardContact }
  const sendDebugReply = async reply => {
    if (replies.length < 20) {
      const [, pluginName, handler] = event?.logFnc?.match(/^\[(.*?)\]\[(.*?)\]$/) || []
      const pluginEntry = pluginName && pluginsLoader.priority.find(entry => entry.name === pluginName && entry.class?.prototype?.[handler])
      replies.push({
        plugin: pluginName ? {
          name: pluginName,
          path: pluginEntry?.key || null,
          handler: handler || null,
        } : null,
        segments: await normalizeDebugSegments(reply, 0, audioBudget, forwardContext),
      })
    }
    return { message_id: `panel-debug-${Date.now()}` }
  }
  const logStdinReply = async reply => {
    safeLogger("info", `[标准输入] 发送消息：${formatDebugOutput(reply).slice(0, 1000)}`)
    return { message_id: `stdin-debug-${Date.now()}` }
  }

  if (!bot.stdin) {
    bot.stdin = {
      uin: "stdin",
      nickname: "EliaAdminPanel 调试输入",
      getAvatarUrl: () => "",
      avatar: "",
      stat: { start_time: Date.now() / 1000, recv_msg_cnt: 0 },
      version: { name: "EliaAdminPanel Debug Stdin" },
      fl: new Map(),
      gl: new Map(),
      gml: new Map(),
      pickUser: () => ({ sendMsg: logStdinReply }),
      pickGroup: () => ({ sendMsg: logStdinReply }),
    }
    if (!Array.isArray(bot.adapter)) bot.adapter = []
    if (!bot.adapter.includes("stdin")) bot.adapter.push("stdin")
  }

  const now = Date.now()
  event = {
    adapter: "stdin",
    message_id: `panel-debug-${now}`,
    message_type: messageType,
    post_type: "message",
    sub_type: messageType === "group" ? "normal" : "friend",
    self_id: "stdin",
    seq: now,
    time: now / 1000,
    uin: "stdin",
    user_id: userId,
    message: [{ type: "text", text: message }],
    raw_message: message,
    sender: {
      user_id: userId,
      card: "面板调试",
      nickname: "面板调试",
      role: messageType === "group" ? "owner" : "",
    },
    isMaster: true,
    toString: () => message,
    reply: sendDebugReply,
    recall: async () => ({ ok: true }),
  }

  if (messageType === "group") {
    const info = { user_id: userId, nickname: "面板调试", card: "面板调试", last_sent_time: now / 1000 }
    const member = {
      _info: info,
      info,
      user_id: userId,
      nickname: info.nickname,
      card: info.card,
      is_owner: true,
      is_admin: true,
      getAvatarUrl: () => "",
    }
    event.group_id = groupId
    event.group_name = `调试群 ${groupId}`
    event.member = member
    event.group = {
      group_id: groupId,
      name: event.group_name,
      mute_left: 0,
      is_owner: true,
      pickMember: () => member,
      sendMsg: sendDebugReply,
      recallMsg: async () => ({ ok: true }),
    }
  } else {
    event.friend = {
      user_id: userId,
      nickname: "面板调试",
      sendMsg: sendDebugReply,
      recallMsg: async () => ({ ok: true }),
      makeForwardMsg: async forward => forward,
    }
  }
  return event
}

function resolveWorkspacePath(relativePath = ".") {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) {
    throw Object.assign(new Error("文件路径无效"), { status: 400 })
  }
  const absolute = path.resolve(ROOT, relativePath || ".")
  if (!isInside(ROOT, absolute)) throw Object.assign(new Error("禁止通过文件管理器访问该文件夹"), { status: 403 })
  if (isInside(DATA_DIR, absolute)) throw Object.assign(new Error("禁止通过文件管理器访问该文件夹"), { status: 403 })
  const segments = path.relative(ROOT, absolute).split(path.sep).filter(Boolean)
  if (segments.some(segment => /[. ]$/.test(segment) || /~\d/.test(segment) || segment.includes(":"))) throw Object.assign(new Error("禁止使用 Windows 路径别名"), { status: 403 })
  if (segments.some(segment => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throw Object.assign(new Error("禁止通过文件管理器访问该文件夹"), { status: 403 })
  }
  return absolute
}

async function rejectSymlinkPath(absolute) {
  if (!isInside(ROOT, absolute)) throw Object.assign(new Error("路径超出工作区"), { status: 403 })
  const relative = path.relative(ROOT, absolute)
  let current = ROOT
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const stat = await fs.lstat(current)
      if (stat.isSymbolicLink()) throw Object.assign(new Error("面板不跟随符号链接"), { status: 403 })
      if (stat.isFile() && stat.nlink > 1) throw Object.assign(new Error("面板不操作硬链接文件"), { status: 403 })
      const real = await fs.realpath(current)
      if (!isInside(ROOT, real)) throw Object.assign(new Error("真实路径超出工作区"), { status: 403 })
      if (!isInside(DATA_DIR, absolute)) resolveWorkspacePath(path.relative(ROOT, real))
    } catch (error) {
      if (error.code === "ENOENT") break
      throw error
    }
  }
}

async function readPanelSettings() {
  try {
    const parsed = await readPanelConfig()
    const port = Number(parsed.port || 50882)
    return {
      host: String(parsed.host || "127.0.0.1").trim(),
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 50882,
      devMode: parsed.devMode === true,
      publicUrl: String(parsed.publicUrl || "").trim(),
    }
  } catch (error) {
    safeLogger("error", `[AdminPanel] 读取面板配置失败：${error.message}`)
    return { host: "127.0.0.1", port: 50882, devMode: false, publicUrl: "" }
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
  await deliverCredential("bootstrap", `${generatedPassword}\n`)
  safeLogger("mark", "[EliaAdminPanel] 首次密码已写入受保护的 data/elia-admin-panel/credentials/bootstrap.txt，请前往查看")
}

async function verifyPanelPassword(submitted) {
  if (typeof submitted !== "string" || submitted.length > 1024) return false
  const config = await readPanelConfig()
  if (hasPasswordCredential(config)) {
    const salt = Buffer.from(config.passwordSalt, "hex")
    const expected = Buffer.from(config.passwordHash, "hex")
    const actual = await derivePassword(submitted, salt, config.passwordIterations)
    return crypto.timingSafeEqual(actual, expected) ? credentialVersion(config) : false
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
    if (saved.secretFingerprint !== secretFingerprint || saved.credentialVersion !== activeCredentialVersion) {
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
      credentialVersion: activeCredentialVersion,
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
  const secure = securityPolicy.cookieSecure === true || requestIsSecure(req, securityPolicy) ? "; Secure" : ""
  res.setHeader("Set-Cookie", `elia_panel_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`)
}

function clearSessionCookie(req, res) {
  const secure = securityPolicy.cookieSecure === true || requestIsSecure(req, securityPolicy) ? "; Secure" : ""
  res.setHeader("Set-Cookie", `elia_panel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`)
}

function checkOrigin(req, res, next) {
  if (!originAllowed(req, securityPolicy)) return res.status(403).json({ error: "跨站请求已拒绝" })
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

async function issueSession(req, res, expectedVersion = activeCredentialVersion) {
  await refreshSecurity()
  if (expectedVersion !== activeCredentialVersion) throw Object.assign(new Error("凭据已变更，请重新登录"), { status: 401 })
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
  await refreshSecurity()
  if (expectedVersion !== activeCredentialVersion || !sessions.has(sessionIdHash)) {
    sessions.delete(sessionIdHash)
    throw Object.assign(new Error("凭据已变更，请重新登录"), { status: 401 })
  }
  setSessionCookie(req, res, signSessionToken(sessionId, expiresAt))
  return expiresAt
}

function allowAttempt(bucket, key, limit, windowMs) {
  const now = Date.now()
  if (bucket.size >= 4096) for (const [id, value] of bucket) if (value.resetAt <= now) bucket.delete(id)
  if (!bucket.has(key) && bucket.size >= 4096) return false
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
    hasSupportFile: Boolean(metadata.hasSupportFile),
    hasGit: Boolean(metadata.hasGit),
    hasPackage: Boolean(metadata.hasPackage),
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
  await rejectSymlinkPath(pluginDirectory)
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
    await rejectSymlinkPath(supportPath)
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
    if (!entry.isDirectory() || entry.name.startsWith(".") || PLUGIN_SCAN_IGNORED_ROOTS.has(entry.name.toLowerCase())) continue
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
        hasSupportFile: children.some(child => child.isFile() && child.name.endsWith(".support.js")),
        hasGit: children.some(child => child.name === ".git"),
        hasPackage: children.some(child => child.isFile() && child.name === "package.json"),
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
  const rank = entry => entry.hasSupportFile ? 0 : entry.configFiles.length ? 1 : 2
  return result.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "large" ? -1 : 1) || rank(a) - rank(b) || a.title.localeCompare(b.title, "zh-CN"))
}

async function findPluginSupport(id) {
  if (typeof id !== "string" || id.includes("..") || id.includes("\\") || id.includes("/")) {
    throw Object.assign(new Error("插件标识无效"), { status: 400 })
  }
  const directory = path.join(PLUGINS, id)
  await rejectSymlinkPath(directory)
  for (const entry of PLUGIN_SUPPORT_ENTRIES) await rejectSymlinkPath(path.join(directory, entry.fileName))
  if (!isInside(PLUGINS, directory)) throw Object.assign(new Error("插件路径无效"), { status: 400 })
  const support = await loadPluginSupport(directory)
  if (!support) {
    const entryNames = PLUGIN_SUPPORT_ENTRIES.map(entry => entry.fileName).join("、")
    throw Object.assign(new Error(`该插件没有受支持的配置入口（${entryNames}）`), { status: 404 })
  }
  return support
}

async function writeBackupAndFile(absolute, contents, expectedVersion) {
  return withLock(absolute, async () => {
  await rejectSymlinkPath(absolute)
  const previous = await fs.readFile(absolute, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error })
  requireVersion(expectedVersion, contentVersion(previous))
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
  await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" })
  try {
    await rejectSymlinkPath(absolute)
    const latest = await fs.readFile(absolute, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error })
    requireVersion(expectedVersion, contentVersion(latest))
    await fs.rename(temporary, absolute)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return contentVersion(contents)
  })
}

function getAccountSummary() {
  const bot = global.Bot
  if (!bot) return []
  const adapterIds = Array.isArray(bot.adapter)
    ? bot.adapter.map(id => String(id)).filter(id => /^\d+$/.test(id))
    : []
  const primaryIds = Array.isArray(bot.uin) ? bot.uin : [bot.uin]
  const ids = [...new Set([
    ...adapterIds,
    ...Object.keys(bot).filter(key => /^\d+$/.test(key)),
    ...primaryIds.map(id => String(id ?? "")).filter(id => /^\d+$/.test(id)),
  ])]

  return ids.map(id => {
    const account = bot[id] || (String(bot.uin) === id ? bot : null)
    let online = adapterIds.includes(id)
    if (!online && account) {
      try {
        online = typeof account.isOnline === "function" ? account.isOnline() : account.isOnline === true
      } catch {}
    }
    return {
      id,
      online,
      status: online ? "在线" : account ? "离线" : "未连接",
      nickname: account?.nickname || "未知",
      avatar: account?.avatar || `https://q1.qlogo.cn/g?b=qq&s=100&nk=${encodeURIComponent(id)}`,
    }
  })
}

function getBotAccount(id) {
  const bot = global.Bot
  return bot?.[id] || (String(bot?.uin) === id ? bot : null)
}

async function getAccountProfile(summary) {
  const account = getBotAccount(summary.id)
  let info = {}
  let signatureReadStatus = account?.version?.name === "NapCat.Adapter" && typeof account?.napcat?.get_stranger_info === "function"
    ? "unavailable"
    : "unsupported"
  if (summary.online && account?.version?.name === "NapCat.Adapter" && typeof account.napcat?.get_stranger_info === "function") {
    try {
      info = await account.napcat.get_stranger_info({ user_id: Number(summary.id) }) || {}
      signatureReadStatus = "available"
    } catch {}
  }
  if (summary.online && !Object.keys(info).length && typeof account?.getStrangerInfo === "function") {
    try {
      const adapterInfo = await account.getStrangerInfo(Number(summary.id)) || {}
      info = { ...adapterInfo, ...info }
      if (["long_nick", "longNick", "personal_note", "signature", "sign"].some(key => Object.hasOwn(adapterInfo, key))) {
        signatureReadStatus = "available"
      }
    } catch {}
  }
  const age = Number(info.age ?? account?.age)
  const signature = info.long_nick ?? info.longNick ?? info.personal_note ?? info.signature ?? info.sign ?? account?.signature
  return {
    ...summary,
    profile: {
      nickname: String(account?.nickname || info.nickname || summary.nickname),
      avatar: String(account?.avatar || summary.avatar),
      signature: typeof signature === "string" ? signature : "",
      signatureReadStatus,
      sex: String(info.sex || account?.sex || "unknown"),
      age: Number.isSafeInteger(age) && age > 0 ? age : null,
      area: String(info.area || account?.area || ""),
    },
    capabilities: {
      nickname: typeof account?.setNickname === "function",
      avatar: typeof account?.setAvatar === "function",
      signature: typeof account?.setSignature === "function",
      sex: typeof account?.setSex === "function",
      age: typeof account?.setAge === "function",
    },
  }
}

async function getMessageMetrics() {
  const receivedCounts = getAccountSummary().map(({ id }) => {
    const account = global.Bot?.[id] || (String(global.Bot?.uin) === id ? global.Bot : null)
    const count = Number(account?.stat?.recv_msg_cnt)
    return Number.isSafeInteger(count) && count >= 0 ? count : null
  }).filter(count => count !== null)
  const receivedSinceStart = receivedCounts.length ? receivedCounts.reduce((total, count) => total + count, 0) : null
  const unavailable = {
    redisAvailable: false,
    sentToday: null,
    sentThisWeek: null,
    sentThisMonth: null,
    sentTotal: null,
    screenshotsToday: null,
    screenshotsThisWeek: null,
    screenshotsThisMonth: null,
    screenshotsTotal: null,
    receivedSinceStart,
  }
  const redis = global.redis
  if (!redis?.isReady || typeof redis.mGet !== "function") return unavailable

  const now = new Date()
  const dateKey = date => `${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
  const day = dateKey(now)
  const month = now.getMonth() + 1
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() - now.getDay())
  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart)
    date.setDate(weekStart.getDate() + index)
    return dateKey(date)
  })
  try {
    const values = await redis.mGet([
      `Yz:count:sendMsg:day:${day}`,
      `Yz:count:sendMsg:month:${month}`,
      `Yz:count:screenshot:day:${day}`,
      `Yz:count:sendMsg:total`,
      ...weekDays.map(date => `Yz:count:sendMsg:day:${date}`),
      ...weekDays.map(date => `Yz:count:screenshot:day:${date}`),
      `Yz:count:screenshot:month:${month}`,
      `Yz:count:screenshot:total`,
    ])
    const toCount = value => {
      const count = Number(value)
      return Number.isSafeInteger(count) && count >= 0 ? count : 0
    }
    const sumWeek = start => (values?.slice(start, start + weekDays.length) || []).reduce((total, value) => total + toCount(value), 0)
    const screenshotWeekStart = 4 + weekDays.length
    const screenshotMonthIndex = screenshotWeekStart + weekDays.length
    return {
      redisAvailable: true,
      sentToday: toCount(values?.[0]),
      sentThisWeek: sumWeek(4),
      sentThisMonth: toCount(values?.[1]),
      sentTotal: toCount(values?.[3]),
      screenshotsToday: toCount(values?.[2]),
      screenshotsThisWeek: sumWeek(screenshotWeekStart),
      screenshotsThisMonth: toCount(values?.[screenshotMonthIndex]),
      screenshotsTotal: toCount(values?.[screenshotMonthIndex + 1]),
      receivedSinceStart,
    }
  } catch {
    return unavailable
  }
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
  if (!verifySessionToken(socket.logSessionToken)) return socket.close(4401, "登录已失效")
  if (socket.bufferedAmount > 1024 * 1024) return socket.close(4408, "日志接收过慢")
  if (socket.readyState === 1) socket.send(JSON.stringify(packet))
}

async function sendLogCatchup(socket, recent = false) {
  const subscription = socket.logSubscription
  if (!subscription || socket.logBusy || socket.readyState !== 1) return
  socket.logBusy = true
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
    socket.logBusy = false
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

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address ? address.port : 0
      probe.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function stopNextDevServer() {
  const child = nextDevProcess
  nextDevProcess = null
  nextDevPort = null
  if (child && child.exitCode === null && child.signalCode === null) child.kill()
}

function canConnectNextDev(port) {
  return new Promise(resolve => {
    const socket = net.createConnection(port, "127.0.0.1")
    let settled = false
    const finish = ready => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      resolve(ready)
    }
    const timeout = setTimeout(() => finish(false), 1000)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

async function startNextDevServer() {
  const port = await reserveLocalPort()
  const nextCli = requireFromPanel.resolve("next/dist/bin/next")
  const child = spawn(process.execPath, [nextCli, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: PANEL_DIR,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let startupError
  nextDevProcess = child
  nextDevPort = port
  process.once("exit", stopNextDevServer)
  child.once("error", error => { startupError = error })
  child.once("exit", (code, signal) => {
    if (nextDevProcess !== child) return
    nextDevProcess = null
    nextDevPort = null
    safeLogger("error", `[AdminPanel] Next.js 开发服务已退出：${signal || `退出码 ${code}`}`)
  })
  for (const [stream, level] of [[child.stdout, "mark"], [child.stderr, "warn"]]) {
    stream?.on("data", chunk => {
      const output = chunk.toString().trim()
      if (output) safeLogger(level, `[AdminPanel][next dev] ${output}`)
    })
  }

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (startupError || child.exitCode !== null || child.signalCode !== null) break
    if (await canConnectNextDev(port)) {
      safeLogger("mark", `[AdminPanel] Next.js 开发服务已启动，实时热更新端口：${port}`)
      return
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  stopNextDevServer()
  const detail = startupError?.message || (child.exitCode !== null ? `进程退出码 ${child.exitCode}` : "启动超时")
  throw new Error(`Next.js 开发服务启动失败：${detail}`)
}

function proxyNextRequest(req, res) {
  if (!nextDevPort) return res.status(503).send("Next.js 开发服务不可用")
  const headers = { ...req.headers, host: `127.0.0.1:${nextDevPort}` }
  if (headers.origin) headers.origin = `http://127.0.0.1:${nextDevPort}`
  const proxy = http.request({
    hostname: "127.0.0.1",
    port: nextDevPort,
    method: req.method,
    path: req.originalUrl || req.url,
    headers,
  }, upstream => {
    res.writeHead(upstream.statusCode || 502, upstream.headers)
    upstream.pipe(res)
  })
  proxy.on("error", error => {
    if (res.headersSent) return res.destroy(error)
    res.status(502).send("Next.js 开发服务连接失败")
  })
  req.on("aborted", () => proxy.destroy())
  req.pipe(proxy)
}

function proxyNextUpgrade(request, socket, head, sessionToken) {
  if (!nextDevPort) return socket.destroy()
  devConnections.set(socket, sessionToken)
  socket.once("close", () => devConnections.delete(socket))
  const headers = { ...request.headers, host: `127.0.0.1:${nextDevPort}` }
  if (headers.origin) headers.origin = `http://127.0.0.1:${nextDevPort}`
  const proxy = http.request({
    hostname: "127.0.0.1",
    port: nextDevPort,
    method: request.method,
    path: request.url,
    headers,
  })
  proxy.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    if (sessionToken && !verifySessionToken(sessionToken)) { upstreamSocket.destroy(); return socket.destroy() }
    devConnections.set(socket, sessionToken)
    const timer = sessionToken ? setInterval(() => { if (!verifySessionToken(sessionToken)) socket.destroy() }, 15_000) : null
    timer?.unref?.()
    socket.on("close", () => { if (timer) clearInterval(timer); devConnections.delete(socket); upstreamSocket.destroy() })
    const responseHeaders = Object.entries(response.headers).flatMap(([name, value]) =>
      Array.isArray(value) ? value.map(item => `${name}: ${item}`) : value ? [`${name}: ${value}`] : [],
    )
    socket.write([`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`, ...responseHeaders, "", ""].join("\r\n"))
    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    socket.on("error", () => upstreamSocket.destroy())
    upstreamSocket.on("error", () => socket.destroy())
  })
  proxy.on("response", response => {
    socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`)
    response.resume()
  })
  proxy.on("error", () => socket.destroy())
  socket.on("close", () => proxy.destroy())
  proxy.end()
}

function attachLogWebSocket(server) {
  logWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 })
  logHeartbeatTimer = setInterval(() => {
    void refreshSecurity().catch(() => {
      sessions.clear()
      closeInvalidConnections()
      safeLogger("warn", "[AdminPanel] 安全配置无法读取，已撤销当前会话")
    })
    const now = Date.now()
    for (const bucket of [loginAttempts, codeRequestAttempts, codeCheckAttempts, quickLoginAttempts]) for (const [id, value] of bucket) if (value.resetAt <= now) bucket.delete(id)
    for (const [code, expiresAt] of quickLogins) if (expiresAt <= now) quickLogins.delete(code)
    if (loginCode && loginCode.expiresAt <= now) {
      loginCode = null
      void fs.rm(path.join(DATA_DIR, "credentials", "login-code.txt"), { force: true }).catch(() => {})
    }
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
      const now = Date.now()
      if (!socket.messageWindow || now >= socket.messageWindow.resetAt) socket.messageWindow = { count: 0, resetAt: now + 10_000 }
      if (++socket.messageWindow.count > 30) return socket.close(4429, "消息过于频繁")
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
  server.on("upgrade", async (request, socket, head) => {
    try { await refreshSecurity() } catch { socket.destroy(); return }
    let pathname
    try { pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname } catch {
      socket.destroy()
      return
    }
    const isDevHmr = nextDevPort && ["/_next/hmr", "/_next/webpack-hmr"].includes(pathname)
    if (!originAllowed(request, securityPolicy) || (isDevHmr && !request.headers.origin)) return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
    let token
    try { token = parseCookies(request.headers.cookie).get("elia_panel_session") } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    const sessionToken = token && verifySessionToken(token) ? token : null
    if (!sessionToken && !isDevHmr) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    const sameSession = sessionToken
      ? [...logWebSocketServer.clients].filter(client => client.logSessionToken === sessionToken).length + [...devConnections.values()].filter(value => value === sessionToken).length
      : 0
    if (logWebSocketServer.clients.size + devConnections.size >= 32 || sameSession >= 4) return socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n")
    if (isDevHmr) {
      proxyNextUpgrade(request, socket, head, sessionToken)
      return
    }
    if (pathname !== "/api/logs/ws") {
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
    return "已向 ksr 发送重启请求"
  }
  if (process.env.pm_id !== undefined) {
    const pm2Script = path.join(ROOT, "node_modules", "pm2", "bin", "pm2")
    await fs.access(pm2Script)
    const child = spawn(process.execPath, [pm2Script, "restart", "./config/pm2/pm2.json"], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true })
    child.unref()
    return "已向 PM2 发送重启请求"
  }
  throw Object.assign(new Error("当前没有可识别的守护进程，面板未强制结束 Bot。请通过外部进程管理器重启"), { status: 409 })
}

function runProcess(command, args, timeoutMs = 120_000, cwd = ROOT, shell = false, stdoutOnly = false) {
  return withBudget("process", 4, () => runProcessUnbounded(command, args, timeoutMs, cwd, shell, stdoutOnly))
}

function closeInvalidConnections() {
  for (const socket of logWebSocketServer?.clients || []) if (!verifySessionToken(socket.logSessionToken)) socket.close(4401, "登录已失效")
  for (const [socket, sessionToken] of devConnections) if (sessionToken && !verifySessionToken(sessionToken)) socket.destroy()
}

async function applySecurityConfig(config) {
  if (activeCredentialVersion && (!hasPasswordCredential(config) || typeof config.secret !== "string" || Buffer.byteLength(config.secret, "utf8") < 32)) {
    sessions.clear()
    closeInvalidConnections()
    throw new Error("面板安全配置无效，请在本机修复后重新登录")
  }
  securityPolicy = config
  const version = credentialVersion(config)
  if (!activeCredentialVersion || version === activeCredentialVersion) return
  activeCredentialVersion = version
  sessionSecret = config.secret
  sessions.clear()
  quickLogins.clear()
  loginCode = null
  closeInvalidConnections()
  await persistSessions()
  await fs.rm(path.join(DATA_DIR, "credentials", "login-code.txt"), { force: true })
}

async function refreshSecurity() {
  for (;;) {
    const generation = configGeneration()
    const config = await readPanelConfig()
    if (generation !== configGeneration()) continue
    await applySecurityConfig(config)
    return
  }
}
const panelGitTransport = (url, options) => secureGitTransport(url, options, securityPolicy)
const installPluginDependencies = id => withLock("workspace-pnpm-install", () => runProcess("pnpm", ["install", "--filter", `./plugins/${id}`, "--ignore-scripts"], 300_000, ROOT, process.platform === "win32"))
function runProcessUnbounded(command, args, timeoutMs = 120_000, cwd = ROOT, shell = false, stdoutOnly = false) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (command === "git") {
      for (const key of Object.keys(env)) if (/^(?:https?_proxy|all_proxy|no_proxy|GIT_CONFIG.*|GIT_SSL_NO_VERIFY|GIT_ASKPASS)$/i.test(key)) delete env[key]
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" })
    }
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let stdout = ""
    let timedOut = false
    const collect = chunk => { if (output.length < 160_000) output += chunk.toString() }
    child.stdout.on("data", chunk => { if (stdout.length < 160_000) stdout += chunk.toString(); collect(chunk) })
    child.stderr.on("data", collect)
    const timeout = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once("error", error => { clearTimeout(timeout); reject(error) })
    child.once("close", code => {
      clearTimeout(timeout)
      if (timedOut) return reject(new Error(`命令执行超过 ${Math.ceil(timeoutMs / 60_000)} 分钟，已停止`))
      if (code !== 0) return reject(new Error(output.trim() || `命令退出码 ${code}`))
      resolve((stdoutOnly ? stdout : output).trim())
    })
  })
}

const runGitProcess = (command, args, timeoutMs, cwd) => runProcess(command, args, timeoutMs, cwd, false, true)

function validateRemoteRepository(input) {
  let url
  try { url = new URL(input) } catch { throw Object.assign(new Error("请输入有效的 HTTPS 仓库地址"), { status: 400 }) }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname || net.isIP(url.hostname) || url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw Object.assign(new Error("不能输入带凭据的 HTTPS 仓库地址"), { status: 400 })
  }
  const name = path.posix.basename(url.pathname.replace(/\/$/, "")).replace(/\.git$/i, "")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || name === "." || name === "..") {
    throw Object.assign(new Error("无法从仓库地址生成安全的插件目录名"), { status: 400 })
  }
  url.search = ""
  url.hash = ""
  return { url: url.toString().replace(/\/$/, ""), name }
}

async function managedPluginDirectory(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) throw Object.assign(new Error("插件标识无效"), { status: 400 })
  const directory = path.join(PLUGINS, id)
  await rejectSymlinkPath(directory)
  if (!(await fs.lstat(directory)).isDirectory()) throw Object.assign(new Error("目标不是插件目录"), { status: 400 })
  return directory
}

async function withPluginOperation(id, action) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) throw Object.assign(new Error("插件标识无效"), { status: 400 })
  uploadName(id)
  return withLock(path.join(PLUGINS, id), action)
}

function uploadName(value) {
  const name = String(value || "")
  if (!name || name.length > 160 || /[\\/:<>"|?*\x00-\x1f]/.test(name) || name === "." || name === ".." || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw Object.assign(new Error("上传文件名无效"), { status: 400 })
  return name
}

async function createUploadedFile(directory, name, buffer) {
  const absolute = resolveWorkspacePath(path.relative(ROOT, path.join(directory, uploadName(name))))
  await rejectSymlinkPath(absolute)
  if (!(await fs.stat(directory)).isDirectory()) throw Object.assign(new Error("上传目标不是目录"), { status: 400 })
  try { await fs.writeFile(absolute, buffer, { flag: "wx" }) }
  catch (error) { if (error.code === "EEXIST") throw Object.assign(new Error("同名文件已存在，请修改文件名后上传"), { status: 409 }); throw error }
  return path.relative(ROOT, absolute).split(path.sep).join("/")
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
  if (settings.devMode && !["127.0.0.1", "::1", "localhost"].includes(settings.host)) throw new Error("开发模式仅允许本地访问，请关闭 devMode 后再继续后续操作")
  if (!settings.devMode) {
    const releaseTag = await ensureFrontendBuild(PANEL_DIR)
    if (releaseTag) safeLogger("info", `[AdminPanel] 未检测到前端构建产物，已从 GitHub Release ${releaseTag} 初始化`)
  }
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.mkdir(LOGS_DIR, { recursive: true })
  sessionSecret = await loadSessionSecret()
  await initializePassword()
  securityPolicy = await readPanelConfig()
  activeCredentialVersion = credentialVersion(securityPolicy)
  await loadPersistedSessions()
  configEvents.on("changed", applySecurityConfig)
  const app = express()
  app.disable("x-powered-by")
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Referrer-Policy", "same-origin")
    res.setHeader("X-Frame-Options", "DENY")
    res.setHeader("Cache-Control", "no-store")
    res.setHeader("Content-Security-Policy-Report-Only", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
    next()
  })
  app.use(asyncRoute(async (req, res, next) => { await refreshSecurity(); next() }))
  let activeUploads = 0
  app.use((req, res, next) => {
    if (!/^\/api\/(?:files\/upload|plugins\/install-script)\/?$/i.test(req.path)) return next()
    requireAuth(req, res, () => checkOrigin(req, res, () => {
    if (activeUploads >= 2) return res.status(429).json({ error: "上传并发已达上限" })
    activeUploads++
    let released = false
    const release = () => { if (!released) { released = true; activeUploads-- } }
    res.once("close", release); res.once("finish", release)
    next()
    }))
  })
  app.use("/api", express.json({ limit: "3mb" }))

  app.get("/api/auth/status", (req, res) => {
    const token = parseCookies(req.headers.cookie).get("elia_panel_session")
    const session = token && verifySessionToken(token)
    const authenticated = Boolean(session)
    if (!authenticated && token) {
      clearSessionCookie(req, res)
    }
    res.json({ authenticated, expiresAt: authenticated ? session.expiresAt : null, loginImageApi: loginImageApi(securityPolicy.loginImageApi) })
  })
  app.post("/api/auth/login", checkOrigin, asyncRoute(async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown"
    if (!allowAttempt(loginAttempts, ip, 10, 15 * 60 * 1000)) return res.status(429).json({ error: "登录尝试次数过多，请 15 分钟后重试" })
    const attemptWindow = loginAttempts.get(ip).resetAt
    const submitted = String(req.body?.password || "")
    const version = await withBudget("password-kdf", 4, () => verifyPanelPassword(submitted))
    if (version) {
      const expiresAt = await issueSession(req, res, version)
      const attempts = loginAttempts.get(ip)
      if (attempts?.resetAt === attemptWindow) {
        attempts.count = Math.max(0, attempts.count - 1)
        if (!attempts.count) loginAttempts.delete(ip)
      }
      await fs.rm(path.join(DATA_DIR, "credentials", "bootstrap.txt"), { force: true })
      return res.json({ authenticated: true, expiresAt })
    }
    res.status(401).json({ error: "密码不正确" })
  }))
  app.post("/api/auth/code/request", checkOrigin, asyncRoute(async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown"
    if (loginCode?.expiresAt > Date.now()) return res.status(429).json({ error: "当前验证码仍有效，请查看本机凭据文件" })
    if (!allowAttempt(codeRequestAttempts, ip, 3, 15 * 60 * 1000)) return res.status(429).json({ error: "验证码请求过于频繁，请 15 分钟后再试" })
    const code = crypto.randomBytes(12).toString("base64url")
    loginCode = { value: code, expiresAt: Date.now() + 5 * 60 * 1000, attempts: 0 }
    await deliverCredential("login-code", `验证码 ${code}`)
    safeLogger("warn", "[AdminPanel] 验证码已写入本机 data/elia-admin-panel/credentials/login-code.txt，5 分钟有效")
    res.json({ ok: true, expiresIn: 300, message: "请前往 data/elia-admin-panel/credentials/login-code.txt 查看验证码，有效期 5 分钟" })
  }))
  app.post("/api/auth/code/check", checkOrigin, asyncRoute(async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown"
    if (!allowAttempt(codeCheckAttempts, ip, 12, 15 * 60 * 1000)) return res.status(429).json({ error: "验证码尝试次数过多，请稍后再试" })
    const submitted = String(req.body?.code || "").trim()
    if (loginCode && loginCode.expiresAt > Date.now() && crypto.timingSafeEqual(hashSecret(submitted), hashSecret(loginCode.value))) {
      const version = activeCredentialVersion
      loginCode = null
      await fs.rm(path.join(DATA_DIR, "credentials", "login-code.txt"), { force: true })
      const expiresAt = await issueSession(req, res, version)
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
    closeInvalidConnections()
    await persistSessions()
    clearSessionCookie(req, res)
    res.json({ ok: true })
  }))

  app.use("/api", requireAuth)
  app.use("/api", checkOrigin)
  app.use("/api", (req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      const session = req.panelSession.sessionIdHash
      res.once("finish", () => { void auditEvent({ method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode, session }).catch(() => safeLogger("warn", "[AdminPanel] 安全审计记录写入失败")) })
    }
    next()
  })

  app.post("/api/debug/message", asyncRoute(async (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message : ""
    const messageType = req.body?.messageType === "group" ? "group" : "private"
    const userId = String(req.body?.userId || "").trim()
    const groupId = String(req.body?.groupId || "").trim()
    const validId = id => id.length > 0 && id.length <= 80 && !/[\s\x00-\x1f]/.test(id)
    if (!message.trim() || message.length > 5000) return res.status(400).json({ error: "消息不能为空，且最多 5000 个字符" })
    if (!validId(userId)) return res.status(400).json({ error: "发送方 ID 必填，且不能包含空白字符" })
    if (messageType === "group" && !validId(groupId)) return res.status(400).json({ error: "群聊调试需要填写有效的群号" })

    const replies = []
    const event = createPanelDebugEvent({ message, userId, messageType, groupId, replies })
    safeLogger("mark", `[面板调试输入][${messageType === "group" ? `群聊 ${groupId}` : "私聊"}][${userId}] ${message.slice(0, 200)}`)
    await pluginsLoader.deal(event)
    res.json({ ok: true, replies, message: replies.length ? "消息处理完成，已捕获插件回复" : "消息发送了，但是没有插件处理" })
  }))

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

  app.get("/api/status", asyncRoute(async (req, res) => {
    const accounts = getAccountSummary()
    let groupCount = 0
    try { groupCount = global.Bot?.gl?.size || 0 } catch {}
    const memory = process.memoryUsage()
    const messages = await getMessageMetrics()
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
      messages,
      restartAvailable: Boolean(process.env.KSR_RESTART_TOKEN || process.env.pm_id !== undefined),
      panel: settings,
    })
  }))

  app.get("/api/accounts", asyncRoute(async (req, res) => {
    const accounts = await Promise.all(getAccountSummary().map(getAccountProfile))
    res.json({ accounts })
  }))

  app.patch("/api/accounts/:id/profile", asyncRoute(async (req, res) => {
    const id = String(req.params.id || "")
    const accountSummary = getAccountSummary().find(item => item.id === id)
    if (!accountSummary) return res.status(404).json({ error: "账号不存在" })

    const account = getBotAccount(id)
    const setters = { nickname: "setNickname", avatar: "setAvatar", signature: "setSignature", sex: "setSex", age: "setAge" }
    const field = String(req.body?.field || "")
    if (!Object.hasOwn(setters, field)) return res.status(400).json({ error: "不支持的资料字段" })
    const setterName = setters[field]
    if (typeof account?.[setterName] !== "function") return res.status(409).json({ error: "当前适配器不支持修改此资料" })

    let value = req.body?.value
    if (field === "nickname" || field === "signature") {
      value = typeof value === "string" ? value.trim() : ""
      const maxLength = field === "nickname" ? 60 : 255
      if ((!value && field === "nickname") || value.length > maxLength) return res.status(400).json({ error: `${field === "nickname" ? "昵称" : "个性签名"}长度不符合要求` })
    } else if (field === "avatar") {
      value = typeof value === "string" ? value.trim() : ""
      const maxAvatarBytes = 1_500_000
      const avatarError = "头像需为 HTTPS 图片地址或有效的 base64 图片，且不能超过 1.5 MB"
      const base64Payload = value.startsWith("base64://") ? value.slice("base64://".length) : ""
      const isBase64 = /^base64:\/\/[A-Za-z0-9+\/_-]+={0,2}$/.test(value)
      let isHttpsUrl = false
      try { isHttpsUrl = new URL(value).protocol === "https:" } catch {}
      if (!isBase64 && !isHttpsUrl) return res.status(400).json({ error: avatarError })
      if (isBase64) {
        const normalizedPayload = base64Payload.replace(/-/g, "+").replace(/_/g, "/")
        const decodedAvatar = Buffer.from(normalizedPayload, "base64")
        const canonicalPayload = decodedAvatar.toString("base64")
        const validBase64 = normalizedPayload === canonicalPayload || normalizedPayload === canonicalPayload.replace(/=+$/, "")
        if (!validBase64 || decodedAvatar.byteLength > maxAvatarBytes) return res.status(400).json({ error: avatarError })
      }
      if (isHttpsUrl) value = `base64://${(await withBudget("download", 4, () => safeDownload(value, maxAvatarBytes))).toString("base64")}`
    } else if (field === "age") {
      value = Number(value)
      if (!Number.isInteger(value) || value < 1 || value > 120) return res.status(400).json({ error: "年龄需为 1 到 120 的整数" })
    } else if (field === "sex" && !["male", "female", "unknown"].includes(value)) {
      return res.status(400).json({ error: "性别值无效" })
    }

    const result = await account[setterName](value)
    if (result === false) return res.status(502).json({ error: "适配器未能更新资料" })
    if (field === "nickname") account.nickname = value
    if (field === "avatar") account.avatar = `https://q1.qlogo.cn/g?b=qq&s=100&nk=${encodeURIComponent(id)}&t=${Date.now()}`
    if (field === "signature" || field === "sex" || field === "age") account[field] = value
    res.json({ ok: true })
  }))

  app.get("/api/config", asyncRoute(async (req, res) => {
    const directory = path.join(ROOT, "config", "config")
    const files = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(file => file.isFile() && file.name.endsWith(".yaml"))
      .map(file => file.name)
      .sort()
    res.json({ files })
  }))
  app.get("/api/diagnostics/plugin-rules", asyncRoute(async (req, res) => {
    const groupId = String(req.query.groupId || "default")
    if (groupId !== "default" && (!/^\d+$/.test(groupId) || !Number.isSafeInteger(Number(groupId)))) {
      return res.status(400).json({ error: "群号无效" })
    }
    const groupConfig = cfg.getConfig("group") || {}
    const defaultGroupConfig = groupConfig.default || {}
    const groupIds = new Set(Object.keys(groupConfig).filter(id => /^\d+$/.test(id)))
    try {
      for (const id of global.Bot?.gl?.keys?.() || []) if (/^\d+$/.test(String(id))) groupIds.add(String(id))
    } catch {}
    const getGroupName = id => {
      try {
        const group = pickNumericGroup(global.Bot, id)
        return String(group?.name || group?.group_name || global.Bot?.gl?.get?.(Number(id))?.group_name || id)
      } catch { return String(global.Bot?.gl?.get?.(Number(id))?.group_name || id) }
    }
    const groups = [
      { id: "default", name: "全局" },
      ...[...groupIds].sort((left, right) => left.localeCompare(right, "zh-CN")).map(id => ({ id, name: getGroupName(id) })),
    ]
    const targetGroupConfig = groupId === "default" ? defaultGroupConfig : cfg.getGroup(Number(groupId)) || {}
    const entries = Array.isArray(pluginsLoader.priority) ? pluginsLoader.priority : []
    const sourceNames = new Map()
    const nameSources = new Map()
    for (const entry of entries) {
      const sourcePlugin = String(entry.key || entry.name || "未知插件").replace(/\\/g, "/").split("/")[0]
      if (!sourceNames.has(sourcePlugin)) sourceNames.set(sourcePlugin, new Set())
      if (typeof entry.name === "string" && entry.name) {
        sourceNames.get(sourcePlugin).add(entry.name)
        if (!nameSources.has(entry.name)) nameSources.set(entry.name, new Set())
        nameSources.get(entry.name).add(sourcePlugin)
      }
    }
    const blockedPluginNames = [...new Set(entries.filter(entry => !pluginsLoader.checkDisable(entry.name, targetGroupConfig, defaultGroupConfig)).map(entry => entry.name))]
    const scanErrors = []
    const rules = entries.flatMap((entry, entryIndex) => {
      const sourceKey = String(entry.key || "")
      const sourcePlugin = sourceKey.replace(/\\/g, "/").split("/")[0] || String(entry.name || "未知插件")
      const snapshot = readPluginRuleSnapshot(entry)
      if (snapshot.error) scanErrors.push({ pluginName: entry.name, sourceKey, message: snapshot.error })
      return snapshot.rules.map(rule => ({
        id: `${entryIndex}:${sourceKey}:${entry.name}:${rule.index}`,
        pluginName: String(entry.name || "未知插件"),
        sourcePlugin,
        sourceKey,
        sourcePluginNames: [...(sourceNames.get(sourcePlugin) || [])],
        nameSources: [...(nameSources.get(String(entry.name || "")) || [])],
        pluginEvent: String(entry.event || ""),
        priority: Number(entry.priority || 0),
        enabled: pluginsLoader.checkDisable(entry.name, targetGroupConfig, defaultGroupConfig),
        ...rule,
      }))
    })
    res.json({ groupId, groupName: groupId === "default" ? "全局" : getGroupName(groupId), groups, blockedPluginNames, rules, scanErrors })
  }))
  app.get("/api/config/group-plugin-names/:groupId", asyncRoute(async (req, res) => {
    const groupId = String(req.params.groupId || "")
    if (groupId !== "default" && (!/^\d+$/.test(groupId) || !Number.isSafeInteger(Number(groupId)))) {
      return res.status(400).json({ error: "群号无效" })
    }
    let groupName = "全局"
    if (groupId !== "default") {
      let group
      try { group = pickNumericGroup(global.Bot, groupId) } catch {}
      groupName = String(group?.name || group?.group_name || groupId)
    }
    const pluginNames = [...new Set((pluginsLoader.priority || [])
      .map(plugin => plugin?.name)
      .filter(name => typeof name === "string" && name.trim()))]
      .sort((left, right) => left.localeCompare(right, "zh-CN"))
    res.json({ groupId, groupName, pluginNames })
  }))
  app.get("/api/config/friends", asyncRoute(async (req, res) => {
    const friendCache = global.Bot?.fl
    const entries = friendCache instanceof Map ? [...friendCache.entries()] : Object.entries(friendCache || {})
    const friends = entries.map(([key, friend]) => {
      const id = String(friend?.user_id ?? friend?.uin ?? key)
      if (!/^\d+$/.test(id)) return null
      let avatar = ""
      try {
        avatar = typeof friend?.getAvatarUrl === "function" ? String(friend.getAvatarUrl() || "") : String(friend?.avatar || "")
      } catch {}
      return {
        id,
        name: String(friend?.remark || friend?.nickname || id),
        avatar: avatar || `https://q1.qlogo.cn/g?b=qq&s=100&nk=${encodeURIComponent(id)}`,
      }
    }).filter(Boolean).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    res.json({ friends })
  }))
  app.get("/api/config/groups", asyncRoute(async (req, res) => {
    const groupCache = global.Bot?.gl
    const groupIds = new Set(Object.keys(cfg.getConfig("group") || {}).filter(id => /^\d+$/.test(id)))
    try {
      for (const id of groupCache?.keys?.() || []) if (/^\d+$/.test(String(id))) groupIds.add(String(id))
    } catch {}
    const groups = [...groupIds].map(id => {
      let group
      try { group = pickNumericGroup(global.Bot, id) } catch {}
      if (!group) {
        try { group = groupCache?.get?.(Number(id)) || groupCache?.get?.(id) } catch {}
      }
      let avatar = ""
      try { avatar = typeof group?.getAvatarUrl === "function" ? String(group.getAvatarUrl() || "") : String(group?.avatar || "") } catch {}
      return {
        id,
        name: String(group?.name || group?.group_name || id),
        avatar: avatar || `https://p.qlogo.cn/gh/${encodeURIComponent(id)}/${encodeURIComponent(id)}/100/`,
      }
    }).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    res.json({ groups })
  }))
  app.get("/api/config/:name", asyncRoute(async (req, res) => {
    if (!/^[a-z0-9_-]+\.yaml$/i.test(req.params.name)) return res.status(400).json({ error: "配置文件名无效" })
    const filePath = path.join(ROOT, "config", "config", req.params.name)
    await rejectSymlinkPath(filePath)
    const content = await fs.readFile(filePath, "utf8")
    const name = req.params.name.replace(/\.yaml$/i, "")
    let defaults = null
    try { const defaultsPath = path.join(ROOT, "config", "default_config", req.params.name); await rejectSymlinkPath(defaultsPath); defaults = YAML.parse(await fs.readFile(defaultsPath, "utf8")) } catch {}
    res.json({ name: req.params.name, content, data: YAML.parse(content), defaults, version: contentVersion(content) })
  }))
  app.put("/api/config/:name", asyncRoute(async (req, res) => {
    if (!/^[a-z0-9_-]+\.yaml$/i.test(req.params.name)) return res.status(400).json({ error: "配置文件名无效" })
    const filePath = path.join(ROOT, "config", "config", req.params.name)
    await rejectSymlinkPath(filePath)
    const previousContent = await fs.readFile(filePath, "utf8")
    requireVersion(req.body?.version, contentVersion(previousContent))
    const rawContent = typeof req.body?.content === "string" ? req.body.content : null
    let content
    if (rawContent !== null) {
      content = rawContent
    } else {
      try {
        const baseContent = typeof req.body?.baseContent === "string" ? req.body.baseContent : await fs.readFile(filePath, "utf8")
        content = updateYamlPreservingComments(baseContent, req.body?.data)
      } catch (error) {
        return res.status(400).json({ error: `无法保留原配置注释：${error.message}` })
      }
    }
    const parsed = YAML.parse(content)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return res.status(400).json({ error: "配置必须是 YAML 对象" })
    if (req.params.name.toLowerCase() === "qq.yaml" && (!Number.isInteger(parsed.platform) || parsed.platform < 1 || parsed.platform > 6)) {
      return res.status(400).json({ error: "QQ 登录设备类型必须设置为 1–6；即使跳过 ICQQ 登录也需要有效值" })
    }
    const version = await writeBackupAndFile(filePath, content.endsWith("\n") ? content : `${content}\n`, req.body.version)
    const name = req.params.name.replace(/\.yaml$/i, "")
    if (cfg.config) cfg.config[`config.${name}`] = parsed
    res.json({ ok: true, version, message: "已保存配置并刷新运行时缓存" })
  }))

  app.get("/api/plugins", asyncRoute(async (req, res) => res.json({ plugins: await listPlugins() })))
  app.get("/api/plugins/:id/git", asyncRoute(async (req, res) => {
    res.json(await repositoryInfo(await managedPluginDirectory(req.params.id), runGitProcess))
  }))
  app.post("/api/plugins/:id/git/fetch", asyncRoute(async (req, res) => {
    res.json(await withPluginOperation(req.params.id, async () => fetchRepository(await managedPluginDirectory(req.params.id), req.body || {}, runGitProcess, validateRemoteRepository, panelGitTransport)))
  }))
  app.post("/api/plugins/:id/git/update", asyncRoute(async (req, res) => {
    const result = await withPluginOperation(req.params.id, async () => {
      const directory = await managedPluginDirectory(req.params.id)
      const result = await updateRepository(directory, req.body || {}, runGitProcess, validateRemoteRepository, path.join(DATA_DIR, "git-backups"), panelGitTransport)
      for (const key of supportCache.keys()) if (isInside(directory, key)) supportCache.delete(key)
      return result
    })
    res.json({ ok: true, ...result })
  }))
  app.get("/api/plugins/:id/dependencies", asyncRoute(async (req, res) => {
    const directory = await managedPluginDirectory(req.params.id)
    const file = path.join(directory, "package.json")
    await rejectSymlinkPath(file)
    const content = await fs.readFile(file, "utf8")
    const manifest = JSON.parse(content)
    res.json({ version: contentVersion(content), data: Object.fromEntries(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].map(key => [key, manifest[key] || {}])) })
  }))
  app.put("/api/plugins/:id/dependencies", asyncRoute(async (req, res) => {
    await withPluginOperation(req.params.id, async () => {
      const directory = await managedPluginDirectory(req.params.id)
      const file = path.join(directory, "package.json")
      await rejectSymlinkPath(file)
      const dependencies = validateDependencies(req.body?.data)
      const manifest = JSON.parse(await fs.readFile(file, "utf8"))
      await writeBackupAndFile(file, JSON.stringify({ ...manifest, ...dependencies }, null, 2) + "\n", req.body?.version)
      if (req.body?.install === true) await installPluginDependencies(req.params.id)
    })
    res.json({ ok: true, message: "依赖配置已保存并备份" })
  }))
  app.post("/api/plugins/install-script", express.raw({ type: "application/octet-stream", limit: MAX_TEXT_BYTES }), asyncRoute(async (req, res) => {
    await withPluginOperation("example", async () => {
    const name = uploadName(req.query.name || req.body?.name)
    if (!name.toLowerCase().endsWith(".js")) return res.status(400).json({ error: "小插件文件名必须以 .js 结尾" })
    const buffer = Buffer.isBuffer(req.body) ? req.body : await withBudget("download", 4, () => downloadScript(String(req.body?.url || ""), MAX_TEXT_BYTES))
    if (!buffer.length || buffer.length > MAX_TEXT_BYTES) return res.status(400).json({ error: "插件文件为空或超过 1.5 MB" })
    await fs.mkdir(DATA_DIR, { recursive: true })
    const checkFile = path.join(DATA_DIR, `script-check-${crypto.randomBytes(8).toString("hex")}.mjs`)
    try {
      await fs.writeFile(checkFile, buffer)
      try { await runProcess(process.execPath, ["--check", checkFile], 30_000) }
      catch { throw Object.assign(new Error("JavaScript 语法检查失败，请检查插件源码"), { status: 400 }) }
    } finally { await fs.rm(checkFile, { force: true }) }
    const directory = path.join(PLUGINS, "example")
    await rejectSymlinkPath(directory)
    await fs.mkdir(directory, { recursive: true })
    const installedPath = await createUploadedFile(directory, name, buffer)
    res.json({ ok: true, path: installedPath, message: `已安装 ${installedPath}；重启 Bot 后加载` })
    })
  }))
  app.get("/api/plugins/:id/config", asyncRoute(async (req, res) => {
    const support = await findPluginSupport(req.params.id)
    if (typeof support.configInfo?.getConfigData !== "function") return res.status(404).json({ error: "插件未提供 getConfigData()" })
    const data = await support.configInfo.getConfigData()
    res.json({ data, version: contentVersion(JSON.stringify(data)) })
  }))
  app.put("/api/plugins/:id/config", asyncRoute(async (req, res) => {
    await withPluginOperation(req.params.id, async () => {
    const support = await findPluginSupport(req.params.id)
    if (typeof support.configInfo?.setConfigData !== "function" || typeof support.configInfo?.getConfigData !== "function") return res.status(404).json({ error: "插件未提供完整配置读写入口" })
    const { _panelVersion, ...data } = req.body || {}
    requireVersion(_panelVersion, contentVersion(JSON.stringify(await support.configInfo.getConfigData())))
    const result = await support.configInfo.setConfigData(data, { Result: makeResult() })
    res.json(result && typeof result === "object" ? result : { ok: true, result, message: "保存成功" })
    })
  }))
  app.post("/api/plugins/:id/action", asyncRoute(async (req, res) => {
    const support = await findPluginSupport(req.params.id)
    const actions = support.configInfo?.actions || {}
    const action = Object.hasOwn(actions, req.body?.action) ? actions[req.body.action] : null
    if (typeof action !== "function") return res.status(404).json({ error: "没有找到该插件操作" })
    const result = await action(req.body?.args, { Result: makeResult() })
    res.json(result && typeof result === "object" ? result : { ok: true, result, message: "操作完成" })
  }))
  app.post("/api/plugins/install", asyncRoute(async (req, res) => {
    const { url, name: inferredName } = validateRemoteRepository(String(req.body?.url || ""))
    const name = String(req.body?.name || inferredName)
    const installDependencies = req.body?.installDependencies === true
    const restartAfterInstall = req.body?.restartBot === true
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || name === "..") return res.status(400).json({ error: "插件目录名无效" })
    await withPluginOperation(name, async () => {
    const target = path.join(PLUGINS, name)
    await rejectSymlinkPath(target)
    try { await fs.lstat(target); return res.status(409).json({ error: `plugins/${name} 已存在` }) } catch (error) { if (error.code !== "ENOENT") throw error }
    const stagingRoot = path.join(DATA_DIR, "install-staging")
    await fs.mkdir(stagingRoot, { recursive: true })
    const staging = await fs.mkdtemp(path.join(stagingRoot, "clone-"))
    const repository = path.join(staging, "repository")
    try {
      const transport = await panelGitTransport(url, req.body)
      await runProcess("git", [...transport.args, "clone", "--depth", "1", "--single-branch", "--", transport.url, repository])
      await runProcess("git", ["remote", "set-url", "origin", url], 30_000, repository)
      const entries = await fs.readdir(repository)
      if (!entries.includes("index.js") && !entries.some(entry => entry.endsWith(".js"))) throw new Error("仓库克隆成功，但未找到 Yunzai 插件入口文件")
      await rejectSymlinkPath(target)
      try { await fs.lstat(target); throw Object.assign(new Error("同名插件已存在"), { status: 409 }) } catch (error) { if (error.code !== "ENOENT") throw error }
      await fs.rename(repository, target)
      let hasPackage = false
      try { await fs.access(path.join(target, "package.json")); hasPackage = true } catch {}
      let dependenciesInstalled = false
      let dependencyInstallFailed = false
      if (installDependencies && hasPackage) {
        try {
          await installPluginDependencies(name)
          dependenciesInstalled = true
        } catch (error) {
          dependencyInstallFailed = true
          safeLogger("warn", `[AdminPanel] plugins/${name} 依赖安装失败：${error.message}`)
        }
      }
      const restartAvailable = Boolean(process.env.KSR_RESTART_TOKEN) || process.env.pm_id !== undefined
      const restartScheduled = restartAfterInstall && restartAvailable && !dependencyInstallFailed
      const messages = [`已下载到 plugins/${name}`]
      if (installDependencies) {
        if (!hasPackage) messages.push("仓库没有 package.json，已跳过依赖安装")
        else if (dependencyInstallFailed) messages.push("依赖安装失败，插件代码已保留，请检查后手动安装")
        else messages.push("插件依赖已安装（未执行安装脚本）")
      }
      else if (hasPackage) messages.push("请手动安装插件依赖")
      if (restartScheduled) messages.push("Bot 即将重启")
      else if (restartAfterInstall && dependencyInstallFailed) messages.push("依赖未就绪，未自动重启 Bot")
      else if (restartAfterInstall) messages.push("未检测到 ksr/PM2 自动重启服务，请手动重启 Bot")
      else messages.push("重启 Bot 后加载")
      res.json({ ok: true, name, hasPackage, dependenciesInstalled, restartScheduled, message: `${messages.join("；")}。` })
      if (restartScheduled) {
        res.once("finish", () => {
          const restartTimer = setTimeout(() => {
            restartBot()
              .then(message => safeLogger("mark", `[AdminPanel] ${message}`))
              .catch(error => safeLogger("error", `[AdminPanel] 安装后的 Bot 重启失败：${error.message}`))
          }, 1000)
          restartTimer.unref?.()
        })
      }
    } finally {
      if (path.dirname(staging) !== stagingRoot || !path.basename(staging).startsWith("clone-")) throw new Error("暂存目录边界错误")
      await fs.rm(staging, { recursive: true, force: true })
    }
    })
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
  app.post(["/api/plugins/:id/disable", "/api/plugins/:id/archive"], asyncRoute(async (req, res) => {
    const id = req.params.id
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) || id.toLowerCase() === "eliaadminpanel") return res.status(400).json({ error: "此插件不能禁用" })
    await withPluginOperation(id, async () => {
      const source = await managedPluginDirectory(id)
      const stat = await fs.lstat(source)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return res.status(400).json({ error: "目标不是普通插件目录" })
      const archiveRoot = path.join(DATA_DIR, "archived-plugins")
      await fs.mkdir(archiveRoot, { recursive: true })
      const archiveId = `${id}--${Date.now()}`
      await fs.rename(source, path.join(archiveRoot, archiveId))
      res.json({ ok: true, archiveId, message: `插件 ${id} 已禁用，文件已保留；重启 Bot 后生效，可随时重新启用` })
    })
  }))
  app.post("/api/plugins/archives/:archiveId/restore", asyncRoute(async (req, res) => {
    const archiveId = req.params.archiveId
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*--\d+$/.test(archiveId)) return res.status(400).json({ error: "归档编号无效" })
    const name = archiveId.replace(/--\d+$/, "")
    if (name.toLowerCase() === "eliaadminpanel") return res.status(400).json({ error: "不能恢复到面板自身目录" })
    await withPluginOperation(name, async () => {
    const archivePath = path.join(DATA_DIR, "archived-plugins", archiveId)
    await rejectSymlinkPath(archivePath)
    const target = path.join(PLUGINS, name)
    await rejectSymlinkPath(target)
    try { await fs.lstat(target); return res.status(409).json({ error: `plugins/${name} 已存在，无法覆盖` }) } catch (error) { if (error.code !== "ENOENT") throw error }
    await fs.rename(archivePath, target)
    res.json({ ok: true, message: `已恢复到 plugins/${name}；重启 Bot 后加载` })
    })
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
        const relativePath = path.relative(ROOT, childPath).split(path.sep).join("/")
        if (childStat.size <= MAX_TEXT_BYTES && ALLOWED_TEXT_EXTENSIONS.has(extension)) {
          files.push({ name: entry.name, path: relativePath, type: "file", size: childStat.size })
        } else if (childStat.size <= MAX_PREVIEW_IMAGE_BYTES && IMAGE_MIME_TYPES.has(extension)) {
          files.push({ name: entry.name, path: relativePath, type: "image", size: childStat.size })
        } else {
          files.push({ name: entry.name, path: relativePath, type: "binary", size: childStat.size })
        }
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
    if (!stat.isFile()) return res.status(400).json({ error: "文件不存在" })
    const extension = path.extname(absolute).toLowerCase() || path.basename(absolute).toLowerCase()
    const imageMime = IMAGE_MIME_TYPES.get(extension)
    if (imageMime) {
      if (stat.size > MAX_PREVIEW_IMAGE_BYTES) return res.status(413).json({ error: "图片超过 20 MB 预览上限" })
      return res.json({ path: path.relative(ROOT, absolute).split(path.sep).join("/"), type: "image", size: stat.size, modifiedAt: stat.mtime.toISOString(), mime: imageMime })
    }
    if (stat.size > MAX_TEXT_BYTES) return res.status(400).json({ error: "文件超过 1.5 MB 编辑上限" })
    if (!ALLOWED_TEXT_EXTENSIONS.has(extension)) return res.status(415).json({ error: "该文件类型不能在面板中编辑" })
    const content = await fs.readFile(absolute, "utf8")
    if (content.includes("\0")) return res.status(415).json({ error: "二进制文件不能在面板中编辑" })
    res.json({ path: path.relative(ROOT, absolute).split(path.sep).join("/"), content, version: contentVersion(content), size: stat.size, modifiedAt: stat.mtime.toISOString() })
  }))
  app.get("/api/files/image", asyncRoute(async (req, res) => {
    const relative = String(req.query.path || "")
    const absolute = resolveWorkspacePath(relative)
    await rejectSymlinkPath(absolute)
    const stat = await fs.stat(absolute)
    if (!stat.isFile()) return res.status(400).json({ error: "图片文件不存在" })
    const extension = path.extname(absolute).toLowerCase() || path.basename(absolute).toLowerCase()
    const mime = IMAGE_MIME_TYPES.get(extension)
    if (!mime) return res.status(415).json({ error: "该图片类型不受支持" })
    if (stat.size > MAX_PREVIEW_IMAGE_BYTES) return res.status(413).json({ error: "图片超过 20 MB 预览上限" })
    res.set({ "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" })
    res.send(await fs.readFile(absolute))
  }))
  app.get("/api/files/audio", asyncRoute(async (req, res) => {
    const relative = String(req.query.path || "")
    const absolute = resolveWorkspacePath(relative)
    await rejectSymlinkPath(absolute)
    const stat = await fs.stat(absolute)
    if (!stat.isFile()) return res.status(400).json({ error: "音频文件不存在" })
    const extension = path.extname(absolute).toLowerCase()
    const mime = AUDIO_MIME_TYPES.get(extension)
    if (!mime) return res.status(415).json({ error: "该音频格式不受支持" })
    if (stat.size > MAX_PREVIEW_AUDIO_BYTES) return res.status(413).json({ error: "音频超过 20 MB 预览上限" })
    res.set({ "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" })
    res.send(await fs.readFile(absolute))
  }))
  app.get("/api/debug/audio/:token", asyncRoute(async (req, res) => {
    pruneDebugAudioCache()
    const entry = debugAudioCache.get(req.params.token)
    if (!entry) return res.status(404).json({ error: "语音预览已过期，请重新发送调试消息" })
    const { buffer } = entry
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
    if (range) {
      const start = range[1] ? Number(range[1]) : 0
      const end = range[2] ? Math.min(Number(range[2]), buffer.length - 1) : buffer.length - 1
      if (start >= buffer.length || end < start) {
        res.set("Content-Range", `bytes */${buffer.length}`)
        return res.status(416).end()
      }
      res.status(206).set({
        "Content-Type": "audio/mpeg",
        "Content-Range": `bytes ${start}-${end}/${buffer.length}`,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      })
      return res.end(buffer.subarray(start, end + 1))
    }
    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Length": String(buffer.length),
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    })
    res.send(buffer)
  }))
  app.put("/api/files/write", asyncRoute(async (req, res) => {
    const relative = String(req.body?.path || "")
    const content = req.body?.content
    if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) return res.status(400).json({ error: "文件内容无效或超过 1.5 MB" })
    const absolute = resolveWorkspacePath(relative)
    await rejectSymlinkPath(absolute)
    const extension = path.extname(absolute).toLowerCase() || path.basename(absolute).toLowerCase()
    if (!ALLOWED_TEXT_EXTENSIONS.has(extension)) return res.status(415).json({ error: "该文件类型不能在面板中编辑" })
    const version = await writeBackupAndFile(absolute, content, req.body?.version)
    res.json({ ok: true, version, message: "文件已保存；自动备份保存在 data/elia-admin-panel/backups" })
  }))
  app.post("/api/files/upload", express.raw({ type: "application/octet-stream", limit: MAX_UPLOAD_BYTES }), asyncRoute(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "请上传二进制文件内容" })
    const directory = resolveWorkspacePath(String(req.query.path || "."))
    await rejectSymlinkPath(directory)
    const uploadedPath = await createUploadedFile(directory, req.query.name, req.body)
    res.json({ ok: true, path: uploadedPath, message: "文件已上传" })
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
  if (settings.devMode) {
    await startNextDevServer()
    app.use(checkOrigin, (req, res, next) => devRequestNeedsAuth(req) ? requireAuth(req, res, next) : next(), (req, res) => proxyNextRequest(req, res))
  } else {
    app.use(express.static(STATIC_DIR, { index: false, maxAge: "1h", fallthrough: true }))
    app.use((req, res, next) => {
      const section = req.path.match(/^\/(accounts|config|plugins|files|logs|debug)\/?$/)?.[1]
      const entry = section ? path.join(STATIC_DIR, section, "index.html") : path.join(STATIC_DIR, "index.html")
      fs.access(entry)
        .then(() => res.sendFile(entry))
        .catch(() => res.status(503).send("当前插件没有有效的构建产物，请重新参阅 README.md 进行构建"))
    })
  }
  app.use((error, req, res, next) => {
    const status = Number(error.status) || 500
    if (status >= 500) safeLogger("error", `[AdminPanel] ${req.method} ${req.path}: ${error.stack || error.message}`)
    res.status(status).json({ error: status >= 500 ? "面板处理请求失败，请查看 Bot 日志" : error.message })
  })

  try {
    expressServer = await new Promise((resolve, reject) => {
      const server = app.listen(settings.port, settings.host)
      server.once("listening", () => resolve(server))
      server.once("error", reject)
    })
  } catch (error) {
    stopNextDevServer()
    throw error
  }
  expressServer.once("close", () => { stopNextDevServer(); configEvents.removeListener("changed", applySecurityConfig) })
  attachLogWebSocket(expressServer)
  startLogDirectoryWatcher()
  const address = expressServer.address()
  const shownHost = settings.host === "0.0.0.0" || settings.host === "::" ? "127.0.0.1" : settings.host
  safeLogger("mark", `[EliaAdminPanel] 网页管理面板已启动：http://${shownHost}:${address.port}`)
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
