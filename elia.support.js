import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "config.yaml")

async function readConfig() {
  try {
    return YAML.parse(await fs.readFile(configPath, "utf8")) || {}
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    return { host: "127.0.0.1", port: 50882 }
  }
}

/** EliaAdminPanel 的原生插件配置入口；Guoba 适配器也复用此处定义。 */
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
      iconPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "public", "elia.png"),
    },
    configInfo: {
      schemas: [
        { label: "Web 服务", component: "SOFT_GROUP_BEGIN" },
        {
          field: "host",
          label: "监听地址",
          bottomHelpMessage: "默认仅允许本机访问。远程访问前请设置强面板密码环境变量 YUNZAI_PANEL_PASSWORD。",
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
        { label: "浏览器会话", component: "SOFT_GROUP_BEGIN" },
        {
          field: "secret",
          label: "登录 Secret",
          bottomHelpMessage: "用于签名浏览器临时令牌。留空表示不修改；填写至少 32 字节的新 Secret 并保存，重启 Bot 后生效，旧令牌将失效。Secret 不会回显。设置了 YUNZAI_PANEL_SECRET 环境变量时，以环境变量为准。",
          component: "Input",
          componentProps: { type: "password", autocomplete: "new-password", placeholder: "留空表示保持不变" },
        },
      ],
      async getConfigData() {
        const config = await readConfig()
        return { host: config.host || "127.0.0.1", port: config.port || 50882, secret: "" }
      },
      async setConfigData(data, { Result }) {
        const current = await readConfig()
        const host = String(data.host ?? current.host ?? "127.0.0.1").trim()
        const port = Number(data.port ?? current.port ?? 50882)
        const secret = String(data.secret ?? "").trim()
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
          return Result.error("监听地址或端口无效")
        }
        if (secret && Buffer.byteLength(secret, "utf8") < 32) {
          return Result.error("登录 Secret 至少需要 32 个 UTF-8 字节")
        }
        if (secret && process.env.YUNZAI_PANEL_SECRET) {
          return Result.error("当前设置了 YUNZAI_PANEL_SECRET 环境变量；请修改该环境变量来轮换 Secret")
        }
        await fs.writeFile(configPath, YAML.stringify({ ...current, host, port }), "utf8")
        if (secret) {
          const root = process.cwd()
          const dataDir = path.join(root, "data", "elia-admin-panel")
          const secretPath = path.join(dataDir, "session-secret.txt")
          const temporaryPath = `${secretPath}.${process.pid}.${Date.now()}.tmp`
          await fs.mkdir(dataDir, { recursive: true })
          await fs.writeFile(temporaryPath, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
          try {
            await fs.rename(temporaryPath, secretPath)
          } catch (error) {
            await fs.rm(temporaryPath, { force: true }).catch(() => {})
            throw error
          }
          return Result.ok({}, "新 Secret 已保存；重启 Bot 后生效，旧浏览器令牌将失效")
        }
        return Result.ok({}, "配置已保存；重启 Bot 后生效")
      },
    },
  }
}
