import plugin from "../../lib/plugins/plugin.js"
import { createQuickLoginLinks, startAdminPanel } from "./src/server.js"

export class EliaAdminPanel extends plugin {
  constructor() {
    super({
      name: "EliaAdminPanel",
      dsc: "桌面优先的 WebUI 管理控制台",
      event: "message",
      priority: 9999,
      rule: [{ reg: /^#?Elia(登录|登陆)$/i, fnc: "quickLogin", permission: "master" }],
    })
  }

  async init() {
    await startAdminPanel()
  }

  async quickLogin() {
    if (!this.e?.isMaster) return false
    try {
      const { links, expiresIn } = await createQuickLoginLinks()
      const message = [
        "EliaAdminPanel 主人快捷登录：",
        ...links,
        `地址 ${Math.floor(expiresIn / 60)} 分钟内有效，打开后立即失效。请勿转发给他人。`,
      ].join("\n")
      if (this.e.isGroup) {
        await Bot.pickUser(this.e.user_id).sendMsg(message)
        await this.e.reply("快捷登录地址已发送到主人的私聊。")
      } else {
        await this.e.reply(message)
      }
      return true
    } catch (error) {
      logger.error(`[AdminPanel] 主人快捷登录地址生成失败：${error.message || error}`)
      await this.e.reply("快捷登录地址生成失败，请检查面板服务状态后重试。")
      return false
    }
  }
}
