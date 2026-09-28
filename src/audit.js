import fs from "node:fs/promises"
import path from "node:path"

const directory = path.resolve(process.cwd(), "data/elia-admin-panel/audit")
const file = path.join(directory, "events.jsonl")
let writes = Promise.resolve()
export const flushAudit = () => writes
// Record only structured metadata. Request bodies, headers and process output are excluded.
export function auditEvent(event) {
  const record = JSON.stringify({ time: new Date().toISOString(), method: event.method,
    path: String(event.path).slice(0, 256), status: event.status, session: String(event.session || "").slice(0, 12) }) + "\n"
  writes = writes.catch(() => {}).then(async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await fs.stat(file).catch(error => { if (error.code === "ENOENT") return null; throw error })
    if (stat?.size > 4 * 1024 * 1024) {
      await fs.rm(`${file}.previous`, { force: true })
      await fs.rename(file, `${file}.previous`)
    }
    await fs.appendFile(file, record, { mode: 0o600 })
  })
  return writes
}
