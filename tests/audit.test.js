import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("审计仅落盘结构化元数据并在超过上限时轮转", async () => {
  const originalCwd = process.cwd()
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "elia-audit-test-"))
  try {
    process.chdir(workspace)
    const { auditEvent, flushAudit } = await import(`../src/audit.js?test=${Date.now()}`)
    const directory = path.join(workspace, "data/elia-admin-panel/audit")
    const file = path.join(directory, "events.jsonl")
    const previous = `${file}.previous`

    await auditEvent({
      method: "POST",
      path: "/api/" + "x".repeat(300),
      status: 200,
      session: "abcdefghijklmnop",
      body: { password: "must-not-be-written" },
      headers: { cookie: "must-not-be-written" },
    })
    await flushAudit()

    const [record] = (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
    assert.deepEqual(Object.keys(record), ["time", "method", "path", "status", "session"])
    assert.equal(record.path.length, 256)
    assert.equal(record.session, "abcdefghijkl")
    assert.equal(Number.isNaN(Date.parse(record.time)), false)
    assert.doesNotMatch(await fs.readFile(file, "utf8"), /must-not-be-written/)

    const oversizedLog = "x".repeat(4 * 1024 * 1024 + 1)
    await fs.writeFile(file, oversizedLog)
    await fs.writeFile(previous, "stale previous log")
    await auditEvent({ method: "GET", path: "/api/status", status: 200 })
    await flushAudit()

    assert.equal(await fs.readFile(previous, "utf8"), oversizedLog)
    const currentRecords = (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse)
    assert.equal(currentRecords.length, 1)
    assert.equal(currentRecords[0].path, "/api/status")
  } finally {
    process.chdir(originalCwd)
    assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()))
    assert.ok(path.basename(workspace).startsWith("elia-audit-test-"))
    await fs.rm(workspace, { recursive: true, force: true })
  }
})