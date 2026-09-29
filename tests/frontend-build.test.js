import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ensureFrontendBuild, frontendBuildInfo, updateFrontendBuild } from "../src/frontend-build.js"

const releaseApi = "https://api.github.com/repos/OrbiterStellarTrek/Elia-Admin-Panel/releases/latest"
const assetUrl = "https://github.com/OrbiterStellarTrek/Elia-Admin-Panel/releases/download/sha-0123456789abcdef0123456789abcdef01234567/frontend-0123456789abcdef0123456789abcdef01234567.tar.gz"
const archive = Buffer.from("verified frontend archive")

function response({ body, json, url = "", headers = {} }) {
  return {
    status: 200,
    ok: true,
    url,
    headers: { get: name => headers[name.toLowerCase()] || null },
    json: async () => json,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }
}

function latestRelease() {
  return {
    tag_name: "sha-0123456789abcdef0123456789abcdef01234567",
    assets: [{
      name: "frontend-0123456789abcdef0123456789abcdef01234567.tar.gz",
      size: archive.length,
      digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      browser_download_url: assetUrl,
    }],
  }
}

async function makePluginDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "elia-admin-panel-test-"))
}

test("已有完整构建时不访问 GitHub", async () => {
  const pluginDir = await makePluginDir()
  try {
    await fs.mkdir(path.join(pluginDir, "out", "_next", "static", "chunks"), { recursive: true })
    await fs.writeFile(path.join(pluginDir, "out", "index.html"), "built")
    await fs.writeFile(path.join(pluginDir, "out", "_next", "static", "chunks", "app.js"), "built")

    const result = await ensureFrontendBuild(pluginDir, {
      fetchImpl: async () => assert.fail("不应请求 GitHub"),
      execute: async () => assert.fail("不应解压归档"),
    })

    assert.equal(result, null)
  } finally {
    await fs.rm(pluginDir, { recursive: true, force: true })
  }
})

test("缺少构建时下载并校验 Latest Release，再安装到 out", async () => {
  const pluginDir = await makePluginDir()
  const requests = []
  let extractionCount = 0
  try {
    await fs.mkdir(path.join(pluginDir, "out"), { recursive: true })
    await fs.writeFile(path.join(pluginDir, "out", "stale.txt"), "replace incomplete output")
    const fetchImpl = async (url, options) => {
      requests.push({ url, options })
      if (url === releaseApi) return response({ json: latestRelease() })
      return response({ body: archive, url, headers: { "content-length": String(archive.length) } })
    }
    const execute = async (_command, args) => {
      if (args[0] === "-tzf") return { stdout: "./\n./index.html\n./_next/static/\n./_next/static/chunks/app.js\n" }
      if (args[0] === "-tvzf") return { stdout: "-rw-r--r-- 0 user group 14 Jan 1 00:00 index.html\n" }
      extractionCount++
      const destination = args.at(-1)
      await fs.mkdir(path.join(destination, "_next", "static", "chunks"), { recursive: true })
      await fs.writeFile(path.join(destination, "index.html"), "latest release")
      await fs.writeFile(path.join(destination, "_next", "static", "chunks", "app.js"), "latest release")
      return { stdout: "" }
    }

    const result = await ensureFrontendBuild(pluginDir, { fetchImpl, execute })

    assert.equal(result, latestRelease().tag_name)
    assert.deepEqual(requests.map(request => request.url), [releaseApi, assetUrl])
    assert.equal(requests[1].options.redirect, "manual")
    assert.equal(extractionCount, 1)
    assert.equal(await fs.readFile(path.join(pluginDir, "out", "index.html"), "utf8"), "latest release")
    assert.equal(await fs.readFile(path.join(pluginDir, "out", "stale.txt"), "utf8").catch(() => null), null)
  } finally {
    await fs.rm(pluginDir, { recursive: true, force: true })
  }
})

test("拒绝校验通过但包含路径穿越的归档", async () => {
  const pluginDir = await makePluginDir()
  let extracted = false
  try {
    const fetchImpl = async url => url === releaseApi
      ? response({ json: latestRelease() })
      : response({ body: archive, url })
    const execute = async (_command, args) => {
      if (args[0] === "-tzf") return { stdout: "./index.html\n../outside.txt\n./_next/static/chunks/app.js\n" }
      extracted = true
      return { stdout: "" }
    }

    await assert.rejects(ensureFrontendBuild(pluginDir, { fetchImpl, execute }), /不安全的路径/)
    assert.equal(extracted, false)
    await assert.rejects(fs.access(path.join(pluginDir, "out")))
  } finally {
    await fs.rm(pluginDir, { recursive: true, force: true })
  }
})

function updateFixture({ content = "new frontend", bytes = archive, release = latestRelease(), types = "-rw-r--r-- 0 user group 12 Jan 1 00:00 index.html\n" } = {}) {
  const requests = []
  const fetchImpl = async url => {
    requests.push(url)
    return url === releaseApi ? response({ json: release }) : response({ body: bytes, url })
  }
  const execute = async (_command, args) => {
    if (args[0] === "-tzf") return { stdout: "./index.html\n./_next/static/chunks/app.js\n" }
    if (args[0] === "-tvzf") return { stdout: types }
    const destination = args.at(-1)
    await fs.mkdir(path.join(destination, "_next/static/chunks"), { recursive: true })
    await fs.writeFile(path.join(destination, "index.html"), content)
    await fs.writeFile(path.join(destination, "_next/static/chunks/app.js"), content)
    return { stdout: "" }
  }
  return { fetchImpl, execute, requests }
}

test("手动更新已有构建，摘要相同跳过下载，本地内容损坏时重新安装", async () => {
  const pluginDir = await makePluginDir()
  try {
    const initial = updateFixture({ content: "old frontend" })
    await updateFrontendBuild(pluginDir, initial)
    const release = latestRelease()
    const bytes = Buffer.from("changed archive")
    release.tag_name = "sha-new-version"
    release.assets[0].size = bytes.length
    release.assets[0].digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    const changed = updateFixture({ bytes, release })
    assert.equal((await updateFrontendBuild(pluginDir, changed)).updated, true)
    assert.equal(await fs.readFile(path.join(pluginDir, "out/index.html"), "utf8"), "new frontend")
    assert.equal(await fs.readFile(path.join(pluginDir, ".elia-admin-panel-previous-out/index.html"), "utf8"), "old frontend")
    assert.equal((await frontendBuildInfo(pluginDir)).digest, release.assets[0].digest)
    changed.requests.length = 0
    assert.equal((await updateFrontendBuild(pluginDir, changed)).updated, false)
    assert.deepEqual(changed.requests, [releaseApi])
    await fs.writeFile(path.join(pluginDir, "out/index.html"), "local corruption")
    assert.equal((await updateFrontendBuild(pluginDir, changed)).updated, true)
    assert.equal(await fs.readFile(path.join(pluginDir, "out/index.html"), "utf8"), "new frontend")
  } finally { await fs.rm(pluginDir, { recursive: true, force: true }) }
})

test("无版本标记但内容相同，只记录摘要而不替换构建", async () => {
  const pluginDir = await makePluginDir()
  try {
    const fixture = updateFixture()
    await updateFrontendBuild(pluginDir, fixture)
    await fs.unlink(path.join(pluginDir, "out/.frontend-release.json"))
    const before = (await fs.stat(path.join(pluginDir, "out/index.html"))).mtimeMs
    assert.equal((await updateFrontendBuild(pluginDir, fixture)).updated, false)
    assert.equal((await fs.stat(path.join(pluginDir, "out/index.html"))).mtimeMs, before)
    assert.ok(await frontendBuildInfo(pluginDir))
  } finally { await fs.rm(pluginDir, { recursive: true, force: true }) }
})

test("SHA-256 错误或归档含链接时保留原构建", async () => {
  const pluginDir = await makePluginDir()
  try {
    await updateFrontendBuild(pluginDir, updateFixture())
    const release = latestRelease()
    release.assets[0].digest = "sha256:" + "0".repeat(64)
    await assert.rejects(updateFrontendBuild(pluginDir, updateFixture({ release })), /SHA-256/)
    await fs.unlink(path.join(pluginDir, "out/.frontend-release.json"))
    await assert.rejects(updateFrontendBuild(pluginDir, updateFixture({ types: "lrwxrwxrwx 0 user group 0 Jan 1 00:00 evil -> ../outside\n" })), /链接/)
    assert.equal(await fs.readFile(path.join(pluginDir, "out/index.html"), "utf8"), "new frontend")
    assert.ok(!(await fs.readdir(pluginDir)).some(name => name.startsWith(".elia-admin-panel-build-")))
  } finally { await fs.rm(pluginDir, { recursive: true, force: true }) }
})

test("替换目录失败时恢复原前端，失败后可再次更新", async () => {
  const pluginDir = await makePluginDir()
  try {
    await updateFrontendBuild(pluginDir, updateFixture({ content: "old frontend" }))
    await fs.unlink(path.join(pluginDir, "out/.frontend-release.json"))
    await assert.rejects(updateFrontendBuild(pluginDir, {
      ...updateFixture(),
      rename: async (from, to) => {
        if (path.basename(from) === "extracted") throw new Error("模拟替换失败")
        return fs.rename(from, to)
      },
    }), /模拟替换失败/)
    assert.equal(await fs.readFile(path.join(pluginDir, "out/index.html"), "utf8"), "old frontend")
    assert.equal((await updateFrontendBuild(pluginDir, updateFixture())).updated, true)
  } finally { await fs.rm(pluginDir, { recursive: true, force: true }) }
})

test("并发检查仅允许一次安装，并在操作结束后释放锁", async () => {
  const pluginDir = await makePluginDir()
  let unblock
  try {
    const fixture = updateFixture()
    const gate = new Promise(resolve => { unblock = resolve })
    const pending = updateFrontendBuild(pluginDir, { ...fixture, fetchImpl: async url => { await gate; return fixture.fetchImpl(url) } })
    await assert.rejects(updateFrontendBuild(pluginDir, fixture), error => error.status === 409)
    unblock()
    assert.equal((await pending).updated, true)
    assert.equal((await updateFrontendBuild(pluginDir, fixture)).updated, false)
  } finally { unblock?.(); await fs.rm(pluginDir, { recursive: true, force: true }) }
})
