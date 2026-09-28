import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { EventEmitter } from "node:events"
import YAML from "yaml"
import { withLock, credentialVersion } from "./security.js"

const dataDir = path.resolve(process.cwd(), "data", "elia-admin-panel")
const configPath = path.join(dataDir, "config.yaml")
export const configEvents = new EventEmitter()
let generation = 0
let pendingWrite
export const configGeneration = () => generation
export async function readConfig() {
  if (pendingWrite) await pendingWrite
  return readConfigRaw()
}
async function readConfigRaw() {
  try {
    const config = YAML.parse(await fs.readFile(configPath, "utf8")) || {}
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("面板配置必须是 YAML 对象")
    return config
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return { host: "127.0.0.1", port: 50882, publicUrl: "", devMode: false }
  }
}
export async function writeConfig(config) {
  if (pendingWrite) throw Object.assign(new Error("面板配置已有写入正在进行"), { status: 409 })
  let release
  pendingWrite = new Promise(resolve => { release = resolve })
  try { await writeConfigRaw(config) }
  finally { pendingWrite = undefined; release() }
}
async function writeConfigRaw(config) {
  await fs.mkdir(dataDir, { recursive: true })
  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  const credentialsChanged = credentialVersion(config) !== credentialVersion(await readConfigRaw())
  if (credentialsChanged) {
    // Revoke the disk allowlist before committing credentials. A failed write stays fail-closed.
    const storePath = path.join(dataDir, "sessions.json")
    const storeTemporary = `${storePath}.${crypto.randomBytes(6).toString("hex")}.tmp`
    await fs.writeFile(storeTemporary, JSON.stringify({ sessions: [] }) + "\n", { mode: 0o600, flag: "wx" })
    try { await fs.rename(storeTemporary, storePath) }
    finally { await fs.rm(storeTemporary, { force: true }).catch(() => {}) }
  }
  await fs.writeFile(temporaryPath, YAML.stringify(config), { encoding: "utf8", mode: 0o600, flag: "wx" })
  try { await fs.rename(temporaryPath, configPath); generation++ }
  finally { await fs.rm(temporaryPath, { force: true }).catch(() => {}) }
  // Both Elia and Guoba use this event, including when their support modules reload.
  for (const listener of configEvents.listeners("changed")) await listener(config)
}
export const withConfigLock = action => withLock(configPath, action)
export const configVersion = credentialVersion

export async function deliverCredential(name, text) {
  const directory = path.join(dataDir, "credentials")
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(directory, `${name}.txt`), text, { encoding: "utf8", mode: 0o600 })
}
