import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { syncGitCodeRelease } from "../scripts/sync-gitcode-release.mjs"
import { parse } from "yaml"

const sha = "0123456789abcdef0123456789abcdef01234567"
const tag = `sha-${sha}`
const filename = `frontend-${sha}.tar.gz`
const token = "test-token"
const release = { tagName: tag, name: "前端构建", body: "发布说明\n第二行", isPrerelease: false, isDraft: false }
const upload = { url: "https://storage.example/upload?signature=private", headers: {
  "Content-Type": "application/gzip", "x-obs-callback": "callback", "x-obs-acl": "private", "x-obs-meta-project-id": "123",
} }

async function fixture(t, responses, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gitcode-release-"))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const assetPath = path.join(directory, filename)
  await fs.writeFile(assetPath, "frontend archive")
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), ...options })
    assert.ok(responses.length, "出现了预期以外的请求")
    const next = responses.shift()
    if (next instanceof Error) throw next
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status || 200 })
  }
  return { calls, run: () => syncGitCodeRelease({
    repository: "Mirror-Yunzai/Elia-Admin-Panel", token, sha, release, assetPath, fetchImpl, ...overrides,
  }) }
}

test("新建 Release 并上传同一份附件，最后发布为正式版本", async t => {
  const f = await fixture(t, [{ status: 404 }, { body: {} }, { body: upload }, {}, { body: {} }])
  assert.deepEqual(await f.run(), { tag, filename })
  assert.deepEqual(f.calls.map(c => c.method), ["GET", "POST", "GET", "PUT", "PATCH"])
  assert.ok(f.calls[0].url.endsWith(`/releases/tags/${tag}`))
  assert.deepEqual(JSON.parse(f.calls[1].body), {
    tag_name: tag, target_commitish: sha, name: release.name, body: release.body, release_status: "pre",
  })
  assert.ok(f.calls[2].url.endsWith(`/${tag}/upload_url?file_name=${filename}`))
  assert.equal(await f.calls[3].body.text(), "frontend archive")
  assert.deepEqual(f.calls[3].headers, upload.headers)
  assert.equal(f.calls[3].headers.Authorization, undefined)
  assert.deepEqual(JSON.parse(f.calls[4].body), { name: release.name, body: release.body, release_status: "latest" })
  for (const c of f.calls.filter(c => c.method !== "PUT")) {
    assert.equal(c.headers.Authorization, `Bearer ${token}`)
    assert.ok(!c.url.includes(token))
  }
})

test("重跑仅替换同名附件并保留预发布状态", async t => {
  const f = await fixture(t, [
    { body: { assets: [{ id: 7, name: filename }, { id: 8, name: "other.zip" }] } },
    { body: upload }, { status: 204 }, {}, { body: {} },
  ], { release: { ...release, isPrerelease: true } })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ["GET", "GET", "DELETE", "PUT", "PATCH"])
  assert.ok(f.calls[2].url.endsWith(`/${tag}/attach_files/7`))
  assert.equal(JSON.parse(f.calls[4].body).release_status, "pre")
})

test("鉴权失败时停止，不误判为缺少 Release", async t => {
  const f = await fixture(t, [{ status: 403, body: { message: token } }])
  await assert.rejects(f.run(), /HTTP 403/)
  assert.equal(f.calls.length, 1)
})

test("上传失败不发布新正式版本，错误不泄露凭据或签名地址", async t => {
  const f = await fixture(t, [
    { status: 404 }, { body: {} }, { body: upload }, new Error(`${upload.url} ${token}`),
  ])
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /附件上传失败/)
    assert.ok(!error.message.includes(token) && !error.message.includes("signature"))
    return true
  })
  assert.equal(f.calls.length, 4)
})

test("缺少令牌或标签不匹配时不发送请求", async t => {
  const missing = await fixture(t, [], { token: "" })
  await assert.rejects(missing.run(), /缺少 GITCODE_RELEASE_TOKEN/)
  const mismatch = await fixture(t, [], { release: { ...release, tagName: "other" } })
  await assert.rejects(mismatch.run(), /标签不匹配/)
  assert.equal(missing.calls.length + mismatch.calls.length, 0)
})

test("workflow 在 GitHub 发布后同步，GitCode 失败仅报告警告", async () => {
  const workflow = parse(await fs.readFile(new URL("../.github/workflows/security.yml", import.meta.url), "utf8"))
  const steps = workflow.jobs["frontend-release"].steps
  const publishIndex = steps.findIndex(s => s.name === "Package and publish frontend")
  const syncIndex = steps.findIndex(s => s.id === "gitcode_release")
  assert.equal(syncIndex, publishIndex + 1)
  assert.equal(steps[syncIndex]["continue-on-error"], true)
  assert.equal(steps[syncIndex].env.GITCODE_RELEASE_REPOSITORY, "Mirror-Yunzai/Elia-Admin-Panel")
  assert.equal(steps[syncIndex].env.GITCODE_RELEASE_TOKEN, "${{ secrets.GITCODE_RELEASE_TOKEN }}")
  assert.equal(steps[syncIndex + 1].if, "steps.gitcode_release.outcome == 'failure'")
  assert.match(steps[syncIndex + 1].run, /::warning::/)
  assert.ok(!workflow.jobs.security.steps.some(s => s.id === "gitcode_release"))
})
