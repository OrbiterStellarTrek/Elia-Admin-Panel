import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, windowsHide: true }).toString().split("\0").filter(Boolean)
const patterns = [ /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bAKIA[A-Z0-9]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bsk-proj-[A-Za-z0-9_-]{30,}\b/, /(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_+/-]{24,}["']/i ]
const findings = []
for (const file of new Set(files)) {
  if (!/\.(?:[cm]?js|tsx?|jsx|json|ya?ml|md|env|txt)$/i.test(file) || file === "scripts/check-secrets.mjs") continue
  const absolute = path.resolve(root, file)
  if (!absolute.startsWith(root + path.sep)) continue
  const content = await fs.readFile(absolute, "utf8").catch(() => "")
  for (const [index, line] of content.split(/\r?\n/).entries()) if (patterns.some(pattern => pattern.test(line))) findings.push(`${file}:${index + 1}`)
}
if (findings.length) { console.error("发现疑似凭据，请人工检查（仅输出位置）：\n" + findings.join("\n")); process.exitCode = 1 }
else console.log(`Secret 检查通过：${new Set(files).size} 个候选文件`)
