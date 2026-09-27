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
export async function supportPanel() {
  return {
    pluginInfo: {
      name: "EliaAdminPanel",
      title: "EliaAdminPanel Web 控制面板",
      description: "独立的 Yunzai Web 管理控制台",
      author: "EliaAdminPanel",
      link: "",
      icon: "mdi:view-dashboard-outline",
      iconColor: "#6f78d8",
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
      ],
      async getConfigData() {
        const config = await readConfig()
        return { host: config.host || "127.0.0.1", port: config.port || 50882 }
      },
      async setConfigData(data, { Result }) {
        const current = await readConfig()
        const host = String(data.host ?? current.host ?? "127.0.0.1").trim()
        const port = Number(data.port ?? current.port ?? 50882)
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
          return Result.error("监听地址或端口无效")
        }
        await fs.writeFile(configPath, YAML.stringify({ ...current, host, port }), "utf8")
        return Result.ok({}, "已保存；重启 Bot 后生效")
      },
    },
  }
}
