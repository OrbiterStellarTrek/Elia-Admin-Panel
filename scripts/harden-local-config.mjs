import fs from "node:fs/promises"
import crypto from "node:crypto"
import path from "node:path"
import { promisify } from "node:util"
import { readConfig, writeConfig, deliverCredential, withConfigLock } from "../src/panel-config.js"
import { credentialVersion } from "../src/security.js"

await fs.access(path.resolve("lib/plugins/plugin.js"))
const derive = promisify(crypto.pbkdf2)
await withConfigLock(async () => {
  const config = await readConfig()
  let loggedPasswordStillValid = false
  for (const name of await fs.readdir("logs")) {
    if (!/^(?:command|error).*\.log$/.test(name)) continue
    const text = await fs.readFile(path.join("logs", name), "utf8")
    for (const match of text.matchAll(/首次登录密码[^：:\r\n]*[：:]\s*([A-Za-z0-9_-]{12,})/g)) {
      if (typeof config.passwordSalt !== "string" || typeof config.passwordHash !== "string") continue
      const hash = await derive(match[1], Buffer.from(config.passwordSalt, "hex"), config.passwordIterations, 32, "sha256")
      const expected = Buffer.from(config.passwordHash, "hex")
      if (hash.length === expected.length && crypto.timingSafeEqual(hash, expected)) loggedPasswordStillValid = true
    }
  }
  const closedDevMode = config.devMode === true
  config.devMode = false
  if (loggedPasswordStillValid) {
    const password = crypto.randomBytes(24).toString("base64url"), salt = crypto.randomBytes(16)
    config.passwordSalt = salt.toString("hex")
    config.passwordIterations = 310_000
    config.passwordHash = (await derive(password, salt, config.passwordIterations, 32, "sha256")).toString("hex")
    delete config.password
    await deliverCredential("bootstrap", `${password}\n`)
  }
  await writeConfig(config)
  if (loggedPasswordStillValid) {
    const store = { secretFingerprint: crypto.createHash("sha256").update(config.secret).digest("hex"), credentialVersion: credentialVersion(config), sessions: [] }
    await fs.writeFile("data/elia-admin-panel/sessions.json", JSON.stringify(store) + "\n", { mode: 0o600 })
  }
  console.log(JSON.stringify({ 已关闭开发模式: closedDevMode, 历史日志中的有效首次密码已轮换: loggedPasswordStillValid, 旧持久会话已清空: loggedPasswordStillValid, 新凭据交付: loggedPasswordStillValid ? "data/elia-admin-panel/credentials/bootstrap.txt" : "不需要" }))
})
