import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { pathToFileURL } from "node:url"
import { safeDownload } from "./network-policy.js"

const bad = message => Object.assign(new Error(message), { status: 400 })
export function gitTransport(url, { proxyMode = "none", proxy = "" } = {}) {
  if (proxyMode === "none") return { args: [], url }
  let parsed
  try { parsed = new URL(proxy) } catch { throw bad("代理地址无效") }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw bad("代理地址不能包含凭据、查询或片段")
  if (proxyMode === "prefix") {
    if (parsed.protocol !== "https:") throw bad("链接代理必须使用 HTTPS")
    return { args: [], url: `${parsed.href.replace(/\/$/, "")}/${url}` }
  }
  if (proxyMode !== "standard" || !["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol)) throw bad("请选择有效的常规代理或链接代理")
  return { args: ["-c", `http.proxy=${parsed.href}`], url }
}

export function validateGitRef(input, kind) {
  const ref = String(input || "").trim()
  if (kind === "commit") {
    if (!/^[a-f0-9]{7,40}$/i.test(ref)) throw bad("commit 必须是 7 至 40 位提交哈希")
  } else if (kind !== "branch" || !ref || ref.startsWith("-") || /[\s~^:?*\[\\\x00-\x1f]/.test(ref) || ref.includes("..") || ref.includes("@{") || ref.endsWith("/") || ref.endsWith(".") || ref.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    throw bad("分支名称无效")
  }
  return ref
}

export async function repositoryInfo(directory, run) {
  try { await fs.lstat(path.join(directory, ".git")) } catch { return { available: false } }
  const remote = await run("git", ["remote", "get-url", "origin"], 30_000, directory).catch(() => "")
  const head = await run("git", ["rev-parse", "HEAD"], 30_000, directory)
  const branch = await run("git", ["branch", "--show-current"], 30_000, directory)
  const refs = await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"], 30_000, directory)
  const history = await run("git", ["log", "-80", "--all", "--format=%H%x09%s"], 30_000, directory)
  return { available: true, remote, head, branch, branches: [...new Set(refs.split("\n").map(ref => ref.trim().replace(/^origin\//, "")).filter(ref => ref && ref !== "HEAD"))], commits: history.split("\n").filter(Boolean).map(line => { const [hash, ...message] = line.split("\t"); return { hash, message: message.join("\t") } }) }
}

export async function fetchRepository(directory, options, run, validateRemote, transportFor = gitTransport) {
  const remote = await run("git", ["remote", "get-url", "origin"], 30_000, directory)
  const { url } = validateRemote(remote)
  const transport = await transportFor(url, options)
  await run("git", [...transport.args, "fetch", "--no-tags", "--deepen=80", transport.url, "+refs/heads/*:refs/remotes/origin/*"], 120_000, directory)
  return repositoryInfo(directory, run)
}

export async function updateRepository(directory, options, run, validateRemote, backupRoot, transportFor = gitTransport) {
  const gitStat = await fs.lstat(path.join(directory, ".git"))
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw bad("仅支持拥有独立 .git 目录的插件仓库")
  if (options.pruneHistory === true) {
    for (const folder of ["worktrees", "modules"]) {
      const entries = await fs.readdir(path.join(directory, ".git", folder)).catch(error => { if (error.code === "ENOENT") return []; throw error })
      if (entries.length) throw bad("仓库包含关联 worktree 或已初始化子模块，不能裁剪 .git")
    }
  }
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], 30_000, directory)
  if (status) throw Object.assign(new Error("插件存在本地修改或未跟踪文件，请先保存或处理后再更新"), { status: 409 })
  const ref = validateGitRef(options.ref, options.kind)
  const oldHead = await run("git", ["rev-parse", "HEAD"], 30_000, directory)
  const branch = await run("git", ["branch", "--show-current"], 30_000, directory)
  const remote = await run("git", ["remote", "get-url", "origin"], 30_000, directory)
  const transport = await transportFor(validateRemote(remote).url, options)
  const resolvedRef = options.kind === "commit" ? await run("git", ["rev-parse", "--verify", `${ref}^{commit}`], 30_000, directory).catch(() => ref) : `refs/heads/${ref}`
  await run("git", [...transport.args, "fetch", "--no-tags", transport.url, resolvedRef], 120_000, directory)
  const nextHead = await run("git", ["rev-parse", "FETCH_HEAD^{commit}"], 30_000, directory)
  if (await run("git", ["status", "--porcelain", "--untracked-files=all"], 30_000, directory)) throw Object.assign(new Error("获取远端期间出现本地修改，已停止更新"), { status: 409 })
  await fs.mkdir(backupRoot, { recursive: true })
  const recovery = path.join(backupRoot, `${path.basename(directory)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`)
  let gitBackup
  let previousBranchHead
  try {
    // Detach first so selecting a commit never rewrites the user's existing branch.
    await run("git", ["checkout", "--no-overwrite-ignore", "--detach", nextHead], 30_000, directory)
    if (options.pruneHistory === true) {
      const shallow = `${recovery}-shallow`
      await run("git", ["clone", "--no-local", "--depth", "1", pathToFileURL(directory).href, shallow], 120_000, directory)
      await run("git", ["remote", "set-url", "origin", remote], 30_000, shallow)
      // Keep the original Git database recoverable, rather than deleting history.
      const backupPath = `${recovery}-git`
      await fs.rename(path.join(directory, ".git"), backupPath)
      gitBackup = backupPath
      await fs.rename(path.join(shallow, ".git"), path.join(directory, ".git"))
      if (path.dirname(shallow) !== path.resolve(backupRoot)) throw bad("临时仓库路径超出备份目录")
      await fs.rm(shallow, { recursive: true, force: true })
    }
    if (options.kind === "branch") {
      const existing = await run("git", ["rev-parse", "--verify", `refs/heads/${ref}`], 30_000, directory).catch(() => "")
      if (existing && existing !== nextHead) {
        previousBranchHead = existing
        await run("git", ["update-ref", `refs/elia-panel-backups/${Date.now()}`, existing], 30_000, directory)
      }
      if (existing !== nextHead) await run("git", ["branch", "-f", ref, nextHead], 30_000, directory)
      await run("git", ["switch", ref], 30_000, directory)
      await run("git", ["config", `branch.${ref}.remote`, "origin"], 30_000, directory)
      await run("git", ["config", `branch.${ref}.merge`, `refs/heads/${ref}`], 30_000, directory)
    }
    return { head: nextHead, previousHead: oldHead, backup: gitBackup ? path.basename(gitBackup) : null, message: `已更新到 ${ref}（${nextHead.slice(0, 10)}）${gitBackup ? "；历史已裁剪为一个提交，原 .git 已备份" : ""}；重启 Bot 后生效` }
  } catch (error) {
    if (gitBackup) {
      await fs.rename(path.join(directory, ".git"), `${recovery}-failed-git`).catch(() => {})
      await fs.rename(gitBackup, path.join(directory, ".git"))
    }
    await run("git", ["checkout", "--detach", oldHead], 30_000, directory).catch(() => {})
    if (previousBranchHead) await run("git", ["branch", "-f", ref, previousBranchHead], 30_000, directory).catch(() => {})
    if (branch) await run("git", ["switch", branch], 30_000, directory).catch(() => {})
    throw error
  }
}

export function validateDependencies(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("依赖配置必须是对象")
  const result = {}
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const entries = value[key] ?? {}
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw bad(`${key} 必须是对象`)
    for (const [name, version] of Object.entries(entries)) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || typeof version !== "string" || !version.trim() || version.length > 1000 || /[\x00-\x1f]/.test(version)) throw bad(`依赖 ${name} 的名称或版本无效`)
    }
    result[key] = entries
  }
  return result
}

export async function downloadScript(input, maxBytes, options) {
  return safeDownload(input, maxBytes, { ...options, redirects: 0 })
}
