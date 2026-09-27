import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(process.cwd(), "data", "elia-admin-panel")
const configPath = path.join(dataDir, "config.yaml")
const passwordIterations = 310_000

async function readConfig() {
  try {
    const config = YAML.parse(await fs.readFile(configPath, "utf8")) || {}
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("面板配置必须是 YAML 对象")
    return config
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return { host: "127.0.0.1", port: 50882, publicUrl: "", devMode: false }
  }
}

function createPasswordCredential(password) {
  const salt = crypto.randomBytes(16)
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, passwordIterations, 32, "sha256", (error, hash) => {
      if (error) return reject(error)
      resolve({
        passwordSalt: salt.toString("hex"),
        passwordHash: hash.toString("hex"),
        passwordIterations,
      })
    })
  })
}

async function writeConfig(config) {
  await fs.mkdir(dataDir, { recursive: true })
  const temporaryPath = `${configPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  await fs.writeFile(temporaryPath, YAML.stringify(config), { encoding: "utf8", mode: 0o600, flag: "wx" })
  try {
    await fs.rename(temporaryPath, configPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

function validatePublicUrls(value) {
  const entries = value.split(/[,\r\n]+/).map(item => item.trim()).filter(Boolean)
  if (value.trim() && !entries.length) return false
  for (const entry of entries) {
    let url
    try { url = new URL(entry) } catch { return false }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false
  }
  return true
}

/** EliaAdminPanel 的原生配置入口；Guoba 适配器也复用此处定义。 */
export function supportPanel() {
  return {
    pluginInfo: {
      name: "EliaAdminPanel",
      title: "EliaAdminPanel Web 控制面板",
      description: "独立的 Yunzai Web 管理控制台",
      author: "EliaAdminPanel",
      link: "",
      icon: "mdi:view-dashboard-outline",
      iconColor: "#6f78d8",
      iconPath: path.join(pluginDir, "public", "elia.png"),
    },
    configInfo: {
      schemas: [
        { label: "Web 服务", component: "SOFT_GROUP_BEGIN" },
        {
          field: "host",
          label: "监听地址",
          bottomHelpMessage: "默认仅允许本机访问。改为 0.0.0.0 可从其他设备访问；监听地址和端口保存后需重启 Bot。",
          component: "Input",
          required: true,
          componentProps: { placeholder: "127.0.0.1" },
        },
        {
          field: "port",
          label: "监听端口",
          helpMessage: "修改后重启 Bot 生效。",
          component: "InputNumber",
          required: true,
          componentProps: { min: 1, max: 65535, placeholder: "50882" },
        },
        {
          field: "devMode",
          label: "开发模式",
          bottomHelpMessage: "开启后需重启 Bot，使用 next dev 实时热更新。开发模式占用资源较多，不建议对公网开放。",
          component: "Switch",
        },
        {
          field: "publicUrl",
          label: "公网访问地址",
          bottomHelpMessage: "主人快捷登录链接使用的站点根地址；可填写多个，每行一个或用逗号分隔，不要包含子路径。留空则根据监听地址生成。",
          component: "InputTextArea",
          componentProps: { rows: 3, placeholder: "https://bot.example.com" },
        },
        { label: "登录安全", component: "SOFT_GROUP_BEGIN" },
        {
          field: "password",
          label: "面板密码",
          bottomHelpMessage: "当前密码不会回显。留空表示不修改；填写至少 12 个字符的新密码后保存，服务端会使用独立随机盐和 PBKDF2 哈希保存，不会写入明文。",
          component: "Input",
          componentProps: { type: "password", autocomplete: "new-password", placeholder: "留空表示保持不变" },
        },
        {
          field: "secret",
          label: "浏览器会话 Secret",
          bottomHelpMessage: "用于签名浏览器临时令牌。留空表示不修改；填写至少 32 个 UTF-8 字节的新值并保存，重启 Bot 后生效，旧令牌会失效。Secret 不会回显。",
          component: "Input",
          componentProps: { type: "password", autocomplete: "new-password", placeholder: "留空表示保持不变" },
        },
      ],
      async getConfigData() {
        const config = await readConfig()
        return {
          host: config.host || "127.0.0.1",
          port: config.port || 50882,
          devMode: config.devMode === true,
          publicUrl: config.publicUrl || "",
          password: "",
          secret: "",
        }
      },
      async setConfigData(data, { Result }) {
        const current = await readConfig()
        const host = String(data.host ?? current.host ?? "127.0.0.1").trim()
        const port = Number(data.port ?? current.port ?? 50882)
        const devMode = data.devMode === true
        const publicUrl = String(data.publicUrl ?? current.publicUrl ?? "").trim()
        const password = String(data.password ?? "")
        const secret = String(data.secret ?? "")

        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return Result.error("监听地址或端口无效")
        if (publicUrl && !validatePublicUrls(publicUrl)) return Result.error("公网访问地址必须是 http(s) 站点根地址，不能包含子路径、查询参数或凭据")
        if (password && password.length < 12) return Result.error("面板密码至少需要 12 个字符")
        if (password.length > 1024) return Result.error("面板密码不能超过 1024 个字符")
        if (secret && Buffer.byteLength(secret, "utf8") < 32) return Result.error("浏览器会话 Secret 至少需要 32 个 UTF-8 字节")

        const next = { ...current, host, port, devMode, publicUrl }
        delete next.password
        if (password) Object.assign(next, await createPasswordCredential(password))
        if (secret) next.secret = secret
        await writeConfig(next)

        const notes = []
        if (password) notes.push("新密码立即生效，并以加盐哈希存储")
        if (secret) notes.push("新 Secret 需重启 Bot 后生效，旧浏览器令牌会失效")
        if (host !== String(current.host || "127.0.0.1").trim() || port !== Number(current.port || 50882)) notes.push("监听地址和端口需重启 Bot 后生效")
        if (devMode !== (current.devMode === true)) notes.push("开发模式需重启 Bot 后生效")
        if (publicUrl !== String(current.publicUrl || "").trim()) notes.push("公网访问地址立即用于主人快捷登录链接")
        return Result.ok({}, `配置已保存；${notes.join("；") || "没有需要立即生效的变更"}`)
      },
    },
  }
}
