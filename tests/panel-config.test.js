import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("面板配置默认值、并发写入、凭据轮换和事件通知", async t => {
  const originalCwd = process.cwd()
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "elia-panel-config-test-"))
  try {
    process.chdir(workspace)
    const configModule = await import(`../src/panel-config.js?test=${Date.now()}`)
    const dataDir = path.join(workspace, "data/elia-admin-panel")
    const configPath = path.join(dataDir, "config.yaml")
    const sessionsPath = path.join(dataDir, "sessions.json")

    await t.test("缺失配置返回默认值", async () => {
      assert.deepEqual(await configModule.readConfig(), {
        host: "127.0.0.1",
        port: 50882,
        publicUrl: "",
        devMode: false,
      })
      assert.equal(configModule.configGeneration(), 0)
    })

    await t.test("写入中的配置拒绝并发写入，读取等待变更监听器完成", async () => {
      let notifyStarted
      let releaseNotify
      const started = new Promise(resolve => { notifyStarted = resolve })
      const notification = new Promise(resolve => { releaseNotify = resolve })
      const listener = async () => { notifyStarted(); await notification }
      configModule.configEvents.on("changed", listener)

      const config = { host: "127.0.0.1", port: 50882, publicUrl: "", devMode: false }
      const write = configModule.writeConfig(config)
      await started
      await assert.rejects(configModule.writeConfig(config), { status: 409 })

      let readFinished = false
      const read = configModule.readConfig().then(value => { readFinished = true; return value })
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(readFinished, false)

      releaseNotify()
      await write
      assert.deepEqual(await read, config)
      assert.equal(configModule.configGeneration(), 1)
      configModule.configEvents.off("changed", listener)
    })

    await t.test("仅凭据变化清空持久会话并通知监听器", async () => {
      const changes = []
      const listener = config => { changes.push(config) }
      configModule.configEvents.on("changed", listener)

      const initial = {
        host: "127.0.0.1",
        port: 50882,
        publicUrl: "",
        devMode: false,
        passwordSalt: "salt-1",
        passwordHash: "hash-1",
        passwordIterations: 1000,
        secret: "secret-1",
      }
      await configModule.writeConfig(initial)
      assert.deepEqual(JSON.parse(await fs.readFile(sessionsPath, "utf8")), { sessions: [] })

      await fs.writeFile(sessionsPath, JSON.stringify({ sessions: [{ id: "still-valid" }] }))
      const nonCredentialChange = { ...initial, port: 50883 }
      await configModule.writeConfig(nonCredentialChange)
      assert.deepEqual(JSON.parse(await fs.readFile(sessionsPath, "utf8")), { sessions: [{ id: "still-valid" }] })

      const rotated = { ...nonCredentialChange, passwordHash: "hash-2" }
      await configModule.writeConfig(rotated)
      assert.deepEqual(JSON.parse(await fs.readFile(sessionsPath, "utf8")), { sessions: [] })
      assert.deepEqual(await configModule.readConfig(), rotated)
      assert.equal(configModule.configGeneration(), 4)
      assert.deepEqual(changes, [initial, nonCredentialChange, rotated])
      assert.equal(configModule.configVersion(rotated) === configModule.configVersion(nonCredentialChange), false)

      configModule.configEvents.off("changed", listener)
      assert.deepEqual((await fs.readdir(dataDir)).sort(), ["config.yaml", "sessions.json"])
      assert.equal(await fs.access(`${configPath}.${process.pid}.tmp`).then(() => true, () => false), false)
    })

    await t.test("配置锁、凭据文件投递和无效配置拒绝", async () => {
      let release
      const locked = configModule.withConfigLock(() => new Promise(resolve => { release = resolve }))
      await assert.rejects(configModule.withConfigLock(() => {}), { status: 409 })
      release("complete")
      assert.equal(await locked, "complete")

      await configModule.deliverCredential("login-code", "one-time-code")
      assert.equal(await fs.readFile(path.join(dataDir, "credentials/login-code.txt"), "utf8"), "one-time-code")

      await fs.writeFile(configPath, "[]\n")
      await assert.rejects(configModule.readConfig(), /面板配置必须是 YAML 对象/)
      await fs.writeFile(configPath, "host: [\n")
      await assert.rejects(configModule.readConfig())
    })
  } finally {
    process.chdir(originalCwd)
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()))
    assert.ok(path.basename(workspace).startsWith("elia-panel-config-test-"))
    await fs.rm(workspace, { recursive: true, force: true })
  }
})