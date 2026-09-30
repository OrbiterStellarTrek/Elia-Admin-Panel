import { execFileSync } from "node:child_process"
import { openAsBlob } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

// API 文档：https://docs.gitcode.com/docs/apis/get-api-v-5-repos-owner-repo-releases-tag-upload-url/
export async function syncGitCodeRelease({ repository, token, sha, release, assetPath, fetchImpl = fetch }) {
  if (!token) throw new Error("缺少 GITCODE_RELEASE_TOKEN")
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw new Error("GitCode 目标仓库格式应为 owner/repo")
  if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("GITHUB_SHA 无效")
  const tag = `sha-${sha}`
  const filename = `frontend-${sha}.tar.gz`
  if (release.tagName !== tag || release.isDraft) throw new Error("GitHub Release 标签不匹配或尚未发布")
  if (path.basename(assetPath) !== filename) throw new Error("前端附件名称不匹配")
  const archive = await openAsBlob(assetPath)
  if (!archive.size) throw new Error("前端附件为空")

  const base = `https://api.gitcode.com/api/v5/repos/${repository}/releases`
  const tagPath = `${base}/${encodeURIComponent(tag)}`
  async function request(url, { method = "GET", body, allowMissing = false } = {}) {
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      })
    } catch {
      // 不打印异常原文、响应正文或签名地址，避免在 Actions 日志中泄露凭据。
      throw new Error(`GitCode ${method} 请求失败（网络或超时）`)
    }
    if (allowMissing && response.status === 404) return null
    if (!response.ok) throw new Error(`GitCode ${method} 请求失败（HTTP ${response.status}）；请检查令牌权限及镜像仓库是否已同步提交 ${sha}`)
    if (response.status === 204) return null
    try { return await response.json() } catch { throw new Error("GitCode 返回了无效 JSON") }
  }

  const existing = await request(`${base}/tags/${encodeURIComponent(tag)}`, { allowMissing: true })
  const metadata = {
    name: release.name || tag,
    body: release.body || "",
    release_status: release.isPrerelease ? "pre" : "latest",
  }
  if (!existing) {
    // 新发布先保持预发布状态，附件上传成功后再设置 GitHub 对应的状态。
    await request(base, { method: "POST", body: {
      ...metadata, tag_name: tag, target_commitish: sha, release_status: "pre",
    } })
  }
  const upload = await request(`${tagPath}/upload_url?file_name=${encodeURIComponent(filename)}`)
  let uploadUrl
  try { uploadUrl = new URL(upload.url) } catch { throw new Error("GitCode 返回了无效上传地址") }
  if (uploadUrl.protocol !== "https:" || !upload.headers || typeof upload.headers !== "object") {
    throw new Error("GitCode 返回了无效上传参数")
  }
  // 重跑时替换同名附件，保留其他附件。
  for (const asset of existing?.assets || []) {
    if (asset.name !== filename) continue
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error("已有同名 GitCode 附件缺少有效 ID，无法替换")
    await request(`${tagPath}/attach_files/${asset.id}`, { method: "DELETE" })
  }
  let uploaded
  try {
    uploaded = await fetchImpl(uploadUrl.href, {
      method: "PUT", headers: upload.headers, body: archive,
      redirect: "error", signal: AbortSignal.timeout(600_000),
    })
  } catch { throw new Error("GitCode 附件上传失败（网络或超时）") }
  if (!uploaded.ok) throw new Error(`GitCode 附件上传失败（HTTP ${uploaded.status}）`)
  await request(tagPath, { method: "PATCH", body: metadata })
  return { tag, filename }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const sha = process.env.GITHUB_SHA
    if (!process.env.GITCODE_RELEASE_TOKEN) throw new Error("缺少 GITCODE_RELEASE_TOKEN")
    const release = JSON.parse(execFileSync("gh", [
      "release", "view", `sha-${sha}`, "--json", "tagName,name,body,isPrerelease,isDraft",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }))
    const result = await syncGitCodeRelease({
      repository: process.env.GITCODE_RELEASE_REPOSITORY,
      token: process.env.GITCODE_RELEASE_TOKEN, sha, release,
      assetPath: path.resolve(`frontend-${sha}.tar.gz`),
    })
    console.log(`GitCode 前端发布同步完成：${result.tag} / ${result.filename}`)
  } catch (error) {
    const message = String(error.message).replaceAll(process.env.GITCODE_RELEASE_TOKEN || "\0", "[已隐藏]")
    console.error(`GitCode 前端发布同步失败：${message}`)
    process.exitCode = 1
  }
}
