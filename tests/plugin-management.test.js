import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { gitTransport, validateGitRef, repositoryInfo, fetchRepository, updateRepository, validateDependencies, downloadScript } from "../src/plugin-management.js"
import { isOfficialBot, pickNumericGroup, ffmpegPath } from "../src/bot-capabilities.js"
import { fakeDownload } from "./download-fixture.js"

const exec = promisify(execFile)
const run = async (command, args, timeout = 30_000, cwd) => (await exec(command, args, { cwd, timeout, windowsHide: true })).stdout.trim()

test("代理区分常规代理与 HTTPS 前缀，并拒绝凭据和无效协议", () => {
  assert.deepEqual(gitTransport("https://github.com/a/b.git", { proxyMode: "prefix", proxy: "https://gh-proxy.com/" }), { args: [], url: "https://gh-proxy.com/https://github.com/a/b.git" })
  assert.equal(gitTransport("remote", { proxyMode: "standard", proxy: "http://127.0.0.1:7890" }).args[1], "http.proxy=http://127.0.0.1:7890/")
  assert.throws(() => gitTransport("remote", { proxyMode: "prefix", proxy: "http://proxy.test" }))
  assert.throws(() => gitTransport("remote", { proxyMode: "standard", proxy: "http://user:password@proxy.test" }))
})

test("分支与提交输入不会接受 Git 选项、路径遍历或表达式", () => {
  assert.equal(validateGitRef("feature/panel", "branch"), "feature/panel")
  assert.equal(validateGitRef("abcdef0", "commit"), "abcdef0")
  for (const ref of ["--upload-pack=bad", "../main", "main~1", "a.lock", "a/.hidden", "a b", "a@{1}"]) assert.throws(() => validateGitRef(ref, "branch"))
  assert.throws(() => validateGitRef("HEAD", "commit"))
})

test("依赖编辑仅接受依赖对象及字符串版本", () => {
  assert.equal(validateDependencies({ dependencies: { "@scope/pkg": "^1.0.0" } }).dependencies["@scope/pkg"], "^1.0.0")
  assert.throws(() => validateDependencies({ dependencies: [] }))
  assert.throws(() => validateDependencies({ dependencies: { pkg: 123 } }))
})

test("官方账号和混合账号不会向 QQBot 查询数字群，普通账号仍可正常查询", () => {
  let calls = 0
  const official = { adapter: { id: "QQBot" }, pickGroup: () => { calls++; throw new Error("不能查数字群") } }
  assert.equal(isOfficialBot(official), true)
  assert.equal(pickNumericGroup(official, "123"), undefined)
  const ordinary = { gl: new Map([[123, {}]]), pickGroup: id => ({ id, name: "普通群" }) }
  const mixed = { uin: [1, 2], 1: official, 2: ordinary, pickGroup: official.pickGroup }
  assert.equal(pickNumericGroup(mixed, "123").name, "普通群")
  assert.equal(pickNumericGroup(mixed, "456"), undefined)
  assert.equal(pickNumericGroup({ uin: [1], 1: official, pickGroup: official.pickGroup }, "123"), undefined)
  assert.equal(calls, 0)
})

test("FFmpeg 每次读取 Yunzai 当前配置", () => {
  const config = { bot: { ffmpeg_path: "D:/tools/ffmpeg.exe" } }
  assert.equal(ffmpegPath(config), "D:/tools/ffmpeg.exe")
  config.bot.ffmpeg_path = "another-ffmpeg"
  assert.equal(ffmpegPath(config), "another-ffmpeg")
  assert.equal(ffmpegPath({ bot: {} }), "ffmpeg")
})

test("直链安装拒绝网页、重定向和超限响应", async () => {
  await assert.rejects(downloadScript("https://example.com/plugin.js", 1024, fakeDownload({ body: "<html>bad</html>", headers: { "content-type": "text/html" } })), /直链/)
  assert.equal((await downloadScript("https://example.com/plugin.js", 1024, fakeDownload())).toString(), "export default 1")
  await assert.rejects(downloadScript("https://example.com/plugin.js", 2, fakeDownload()), /大小上限/)
  await assert.rejects(downloadScript("https://example.com/plugin.js", 1024, fakeDownload({ status: 302, headers: { location: "https://example.com/other" } })), /重定向/)
})

test("在独立仓库中选择分支、旧 commit 和裁剪历史，并保留旧 .git", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elia-panel-git-test-"))
  const source = path.join(root, "source")
  const target = path.join(root, "target")
  const backup = path.join(root, "backups")
  try {
    await fs.mkdir(source)
    await run("git", ["init", "-b", "main"], 30_000, source)
    await run("git", ["config", "user.email", "test@example.com"], 30_000, source)
    await run("git", ["config", "user.name", "Panel Test"], 30_000, source)
    await fs.writeFile(path.join(source, "index.js"), "export const version = 1\n")
    await run("git", ["add", "."], 30_000, source)
    await run("git", ["commit", "-m", "first"], 30_000, source)
    const first = await run("git", ["rev-parse", "HEAD"], 30_000, source)
    await run("git", ["clone", source, target], 30_000, root)
    await fs.writeFile(path.join(source, "index.js"), "export const version = 2\n")
    await run("git", ["commit", "-am", "second"], 30_000, source)
    const second = await run("git", ["rev-parse", "HEAD"], 30_000, source)
    await run("git", ["branch", "feature/panel", first], 30_000, source)
    const remote = input => ({ url: input }) // Local remote for isolated tests only.
    const info = await fetchRepository(target, {}, run, remote)
    assert.ok(info.commits.some(commit => commit.hash === second))
    assert.equal(info.head, first)
    assert.equal(info.dirty, false)
    assert.deepEqual(info.branchTips, [{ name: "feature/panel", hash: first, message: "first" }, { name: "main", hash: second, message: "second" }])
    await updateRepository(target, { kind: "branch", ref: "main" }, run, remote, backup)
    assert.equal((await repositoryInfo(target, run)).branch, "main")
    assert.match(await fs.readFile(path.join(target, "index.js"), "utf8"), /version = 2/)
    await fs.writeFile(path.join(target, "untracked.js"), "local work")
    assert.equal((await repositoryInfo(target, run)).dirty, true)
    await assert.rejects(updateRepository(target, { kind: "commit", ref: first }, run, remote, backup), /本地修改/)
    await fs.rm(path.join(target, "untracked.js"))
    await updateRepository(target, { kind: "commit", ref: first.slice(0, 9) }, run, remote, backup)
    assert.equal((await repositoryInfo(target, run)).head, first)
    const failSwitch = (command, args, timeout, cwd) => args[0] === "switch" ? Promise.reject(new Error("模拟切换失败")) : run(command, args, timeout, cwd)
    await assert.rejects(updateRepository(target, { kind: "branch", ref: "main", pruneHistory: true }, failSwitch, remote, backup), /模拟切换失败/)
    assert.equal((await repositoryInfo(target, run)).head, first)
    assert.equal(await run("git", ["rev-list", "--all", "--count"], 30_000, target), "2")
    await fs.mkdir(path.join(target, ".git", "worktrees", "linked"), { recursive: true })
    await assert.rejects(updateRepository(target, { kind: "branch", ref: "main", pruneHistory: true }, run, remote, backup), /关联 worktree/)
    await fs.rm(path.join(target, ".git", "worktrees"), { recursive: true })
    const result = await updateRepository(target, { kind: "branch", ref: "main", pruneHistory: true }, run, remote, backup)
    assert.ok(result.backup)
    assert.equal(await run("git", ["rev-list", "--all", "--count"], 30_000, target), "1")
    assert.equal(await run("git", ["rev-parse", "--is-shallow-repository"], 30_000, target), "true")
    assert.ok((await fs.stat(path.join(backup, result.backup))).isDirectory())
    assert.equal((await repositoryInfo(target, run)).remote, source)
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith("elia-panel-git-test-"))
    await fs.rm(root, { recursive: true, force: true })
  }
})
