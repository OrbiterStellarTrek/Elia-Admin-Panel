import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"
import { withDownloadProxy } from "./download-proxy.js"
import { withLock } from "./security.js"

const execFile = promisify(execFileCallback)
const RELEASE_API = "https://api.github.com/repos/OrbiterStellarTrek/Elia-Admin-Panel/releases/latest"
const MAX_ASSET_BYTES = 100 * 1024 * 1024
const MAX_TAR_LIST_BYTES = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000

function validateAssetUrl(value) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Release 附件地址无效")
  if (url.hostname !== "github.com" && !url.hostname.endsWith(".githubusercontent.com")) throw new Error("Release 附件跳转到了非 GitHub 域名")
  return url
}

async function getLatestAsset(fetchImpl) {
  const response = await fetchImpl(RELEASE_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "EliaAdminPanel" },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`读取 GitHub Latest Release 失败（HTTP ${response.status}）`)

  const release = await response.json()
  if (release?.draft || release?.prerelease) throw new Error("GitHub Latest Release 不是正式版本")
  const asset = release?.assets?.find(item => /^frontend-[0-9a-f]{40}\.tar\.gz$/.test(item.name || ""))
  if (!asset) throw new Error("Latest Release 中没有前端构建附件")
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES) throw new Error("前端构建附件大小无效")
  if (!/^sha256:[0-9a-f]{64}$/i.test(asset.digest || "")) throw new Error("Latest Release 没有提供有效的 SHA-256 摘要")

  const assetUrl = validateAssetUrl(asset.browser_download_url)
  if (assetUrl.hostname !== "github.com" || !assetUrl.pathname.startsWith("/OrbiterStellarTrek/Elia-Admin-Panel/releases/download/") || !assetUrl.pathname.endsWith(`/${asset.name}`)) {
    throw new Error("前端构建附件不属于预期的 GitHub 仓库")
  }
  return { release, asset, assetUrl }
}

async function downloadAsset(fetchImpl, assetUrl, asset) {
  let url = assetUrl
  let response
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetchImpl(url.href, {
      headers: { accept: "application/octet-stream", "user-agent": "EliaAdminPanel" },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get("location")
    if (!location || redirects === 5) throw new Error("下载前端构建附件时重定向无效或次数超限")
    url = validateAssetUrl(new URL(location, url).href)
  }
  if (!response.ok) throw new Error(`下载前端构建附件失败（HTTP ${response.status}）`)
  validateAssetUrl(response.url || url.href)

  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_ASSET_BYTES) throw new Error("前端构建附件超过大小上限")
  let archive
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_ASSET_BYTES) {
          await reader.cancel()
          throw new Error("前端构建附件超过大小上限")
        }
        chunks.push(Buffer.from(value))
      }
    } finally {
      reader.releaseLock?.()
    }
    archive = Buffer.concat(chunks, total)
  } else {
    archive = Buffer.from(await response.arrayBuffer())
    if (archive.length > MAX_ASSET_BYTES) throw new Error("前端构建附件超过大小上限")
  }
  if (archive.length !== asset.size) throw new Error("前端构建附件大小与 Release 元数据不一致")

  const digest = createHash("sha256").update(archive).digest("hex")
  if (digest !== asset.digest.slice("sha256:".length).toLowerCase()) throw new Error("前端构建附件 SHA-256 校验失败")
  return archive
}

async function hasCompleteBuild(outputDir) {
  try {
    const index = await fs.stat(path.join(outputDir, "index.html"))
    const staticDir = await fs.stat(path.join(outputDir, "_next", "static"))
    return index.isFile() && staticDir.isDirectory() && (await fs.readdir(path.join(outputDir, "_next", "static"))).length > 0
  } catch {
    return false
  }
}

function validateTarListing(listing) {
  const entries = listing.split(/\r?\n/).filter(Boolean)
  let hasIndex = false
  let hasStaticAssets = false
  for (const entry of entries) {
    if (entry.includes("\\") || entry.startsWith("/") || /^[a-z]:/i.test(entry)) throw new Error("前端构建归档包含不安全的路径")
    const normalized = entry.replace(/^\.\//, "")
    const parts = normalized.split("/").filter(part => part && part !== ".")
    if (parts.includes("..")) throw new Error("前端构建归档包含不安全的路径")
    if (normalized === "index.html") hasIndex = true
    if (normalized.startsWith("_next/static/") && !normalized.endsWith("/")) hasStaticAssets = true
  }
  if (!hasIndex || !hasStaticAssets) throw new Error("前端构建归档缺少 index.html 或静态资源")
}

async function pathExists(target) {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

const RELEASE_MARKER = ".frontend-release.json"
const MAX_BUILD_BYTES = 500 * 1024 * 1024

// Hash file names and bytes, so local modifications cannot masquerade as an intact release.
async function buildFingerprint(directory) {
  const hash = createHash("sha256")
  let total = 0, count = 0
  async function visit(relative = "") {
    const entries = (await fs.readdir(path.join(directory, relative))).sort()
    for (const name of entries) {
      if (!relative && name === RELEASE_MARKER) continue
      const file = path.join(directory, relative, name)
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.nlink > 1 && stat.isFile()) throw new Error("前端构建包含不支持的链接或文件类型")
      const key = relative ? `${relative}/${name}` : name
      if (stat.isDirectory()) await visit(key)
      else {
        total += stat.size
        if (total > MAX_BUILD_BYTES || ++count > 50000) throw new Error("解压后的前端构建超过大小或文件数量上限")
        hash.update(JSON.stringify([key, stat.size]))
        hash.update(await fs.readFile(file))
      }
    }
  }
  await visit()
  return hash.digest("hex")
}

export async function frontendBuildInfo(pluginDir) {
  try {
    const info = JSON.parse(await fs.readFile(path.join(pluginDir, "out", RELEASE_MARKER), "utf8"))
    if (!/^sha256:[0-9a-f]{64}$/.test(info.digest) || !/^[0-9a-f]{64}$/.test(info.fingerprint) || typeof info.release !== "string") return null
    return info
  } catch { return null }
}

async function installLatestFrontend(pluginDir, options = {}) {
  const { fetchImpl = globalThis.fetch, proxy, proxyMode = proxy ? "standard" : "none", ...buildOptions } = options
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 不支持下载前端构建")
  return withDownloadProxy({ proxyMode, proxy }, requestFetch => installLatestFrontendWithFetch(pluginDir, { ...buildOptions, fetchImpl: requestFetch }), { fetchImpl })
}

async function installLatestFrontendWithFetch(pluginDir, { fetchImpl, execute = execFile, rename = fs.rename, backupDir = path.join(pluginDir, ".elia-admin-panel-previous-out") } = {}) {
  const outputDir = path.join(pluginDir, "out")
  const { release, asset, assetUrl } = await getLatestAsset(fetchImpl)
  const version = release.tag_name || asset.name
  const digest = asset.digest.toLowerCase()
  const installed = await frontendBuildInfo(pluginDir)
  const complete = await hasCompleteBuild(outputDir)
  if (complete && installed?.digest === digest && installed.fingerprint === await buildFingerprint(outputDir)) {
    if (installed.release !== version) await fs.writeFile(path.join(outputDir, RELEASE_MARKER), JSON.stringify({ ...installed, release: version }) + "\n")
    return { updated: false, release: version, digest }
  }

  const tempDir = await fs.mkdtemp(path.join(pluginDir, ".elia-admin-panel-build-"))
  const archivePath = path.join(tempDir, "frontend.tar.gz")
  const extractionDir = path.join(tempDir, "extracted")
  let movedPreviousOutput = false
  try {
    const archive = await downloadAsset(fetchImpl, assetUrl, asset)
    await fs.writeFile(archivePath, archive, { flag: "wx" })
    await fs.mkdir(extractionDir)
    const listing = await execute("tar", ["-tzf", archivePath], { windowsHide: true, maxBuffer: MAX_TAR_LIST_BYTES })
    validateTarListing(listing.stdout)
    // Links in a tar can affect paths outside the staging directory during extraction.
    const types = await execute("tar", ["-tvzf", archivePath], { windowsHide: true, maxBuffer: MAX_TAR_LIST_BYTES })
    if (types.stdout.split(/\r?\n/).some(line => line && !/^[d-]/.test(line))) throw new Error("前端构建归档包含链接或特殊文件")
    await execute("tar", ["-xzf", archivePath, "-C", extractionDir], { windowsHide: true, maxBuffer: MAX_TAR_LIST_BYTES })
    if (!(await hasCompleteBuild(extractionDir))) throw new Error("解压后的前端构建产物不完整")
    const fingerprint = await buildFingerprint(extractionDir)
    const info = { release: version, digest, fingerprint, installedAt: new Date().toISOString() }
    if (complete && await buildFingerprint(outputDir) === fingerprint) {
      await fs.writeFile(path.join(outputDir, RELEASE_MARKER), JSON.stringify(info) + "\n")
      return { updated: false, release: version, digest }
    }
    await fs.writeFile(path.join(extractionDir, RELEASE_MARKER), JSON.stringify(info) + "\n")
    // Retain one previous build, including its chunks for already-open pages.
    if (await pathExists(outputDir)) {
      await fs.mkdir(path.dirname(backupDir), { recursive: true })
      await fs.rm(backupDir, { recursive: true, force: true })
      await rename(outputDir, backupDir)
      movedPreviousOutput = true
    }
    try { await rename(extractionDir, outputDir) }
    catch (error) {
      if (movedPreviousOutput) await rename(backupDir, outputDir)
      throw error
    }
    return { updated: true, release: version, digest }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

export async function updateFrontendBuild(pluginDir, options = {}) {
  return withLock(`frontend-build:${path.resolve(pluginDir)}`, async () => {
    try { return await installLatestFrontend(pluginDir, options) }
    catch (error) { throw new Error(`检查或更新面板前端失败：${error.message || error}`, { cause: error }) }
  })
}

export async function ensureFrontendBuild(pluginDir, options = {}) {
  return withLock(`frontend-build:${path.resolve(pluginDir)}`, async () => {
    if (await hasCompleteBuild(path.join(pluginDir, "out"))) return null
    try { return (await installLatestFrontend(pluginDir, options)).release }
    catch (error) { throw new Error(`面板前端构建产物缺失，自动下载或安装失败：${error.message || error}`, { cause: error }) }
  })
}
