# EliaAdminPanel 独立 Web 控制面板

EliaAdminPanel 是一个独立的 Yunzai 插件，使用标准插件入口接入 Yunzai，不依赖 Elia-Yunzai 专属插件或服务。Express 负责面板 API 与静态页面，前端使用 Next.js 和 shadcn/ui，优先适配桌面浏览器。

## 能力

- 运行概览：Bot 版本、进程、运行时间、内存、账号和群组缓存状态。
- 配置中心：以表单编辑 `config/config/*.yaml`，也能切换到 YAML 源码；保存后更新 Yunzai 配置缓存。
- 插件控制：优先读取 `elia.support.js` 并调用 `supportPanel()`；没有该文件时兼容 `guoba.support.js` 的 `supportGuoba()`。本面板专属入口使用 `elia.support.js`，避免和 Guoba 入口冲突。
- 文件管理：在工作区中浏览并编辑 YAML、JSON、JS/TS、Markdown、CSS、HTML 等文本文件。单个文件限制 1.5 MB，保存前自动备份到 `data/elia-admin-panel/backups/`。
- 运行日志：查看 command 和 error 日志末尾内容。
- 进程操作：仅在检测到 ksr 重启令牌或 PM2 托管时提供重启按钮。

文件管理器将 `.git`、`node_modules`、Next 构建目录及面板内部凭据数据目录排除在浏览和编辑之外；拒绝符号链接和工作区外路径。

## 安装与构建

在 Yunzai 根目录克隆插件并构建前端。Yunzai 会按插件目录的 `index.js` 自动加载：

```powershell
git clone https://github.com/OrbiterStellarTrek/Elia-Admin-Panel.git plugins/EliaAdminPanel
pnpm install --filter elia-admin-panel --ignore-scripts
pnpm --filter elia-admin-panel build
```

构建后重启 Bot，面板默认地址为 `http://127.0.0.1:50882`。未设置 `YUNZAI_PANEL_PASSWORD` 时，首次启动会在 `data/elia-admin-panel/access-password.txt` 生成随机登录密码；之后重启会继续使用该密码，不会每次启动都重置。

## 登录方式

- **验证码登录**：打开登录页点击“获取验证码”，再从运行 Bot 的控制台日志中复制验证码。验证码 5 分钟有效、只能使用一次；每个来源 IP 每 15 分钟最多请求 3 次，连续输错 10 次会作废。
- **主人快捷地址**：主人私聊 Bot 发送 `#面板登录`（群内发送也会私聊主人返回地址）。地址 3 分钟有效且只能使用一次，Bot 重启后未使用的地址失效。
- **面板密码**：未设置环境变量时，随机密码保存在 `data/elia-admin-panel/access-password.txt`；设置 `YUNZAI_PANEL_PASSWORD` 后则以环境变量为准。忘记密码时，先检查当前是否设置了该环境变量；可设置一个新值并重启来重置，也可在没有环境变量覆盖时读取密码文件。验证码和主人快捷地址仍可用于登录。
- **浏览器会话**：登录后只在 HttpOnly Cookie 中保留临时令牌，不保存面板密码；令牌固定有效 12 小时。签名 Secret 和会话摘要保存在 `data/elia-admin-panel/`，所以 Bot 重启后尚未过期的令牌仍然有效；退出登录会撤销令牌。修改插件配置中的“登录 Secret”并重启 Bot 后，旧令牌签名失效，需要重新登录。Secret 配置只写不回显，留空不修改。

验证码由服务端写入 Bot 日志，不会通过网页响应返回。请勿公开 Bot 控制台日志或转发主人快捷地址。

## 面板设置

可在 `plugins/EliaAdminPanel/config.yaml` 修改监听地址和端口，或者通过兼容插件控制页修改；设置变更需重启 Bot 生效。

默认只监听本机回环地址。若需要从其他设备访问，可将 `host` 改为 `0.0.0.0`，并配置环境变量 `YUNZAI_PANEL_PASSWORD` 为高强度密码，再通过防火墙限制访问来源。不要将默认随机密码或管理端口直接暴露到公网。

浏览器会话 Secret 首次启动时会自动生成到 `data/elia-admin-panel/session-secret.txt`；会话存储在同目录的 `sessions.json`，仅保存随机会话 ID 的 SHA-256 摘要和到期时间。可在插件配置页填写新的“登录 Secret”来轮换；要求至少 32 个 UTF-8 字节，保存后重启 Bot，所有旧浏览器令牌都会失效。也可通过 `YUNZAI_PANEL_SECRET` 环境变量指定 Secret；该环境变量优先于文件，启用后请通过修改环境变量轮换，插件配置页不会覆盖它。请勿删除或更换 Secret 文件，否则现有令牌将无法通过签名校验。

如果面板通过反向代理、端口映射或域名访问，请设置 `YUNZAI_PANEL_PUBLIC_URL`，可填写一个或多个逗号分隔的外部站点根地址（不含子路径），例如 `https://bot.example.com,http://192.168.1.20:50882`。主人快捷登录会使用该地址列表生成链接。未设置时，面板根据监听地址生成本机或局域网地址；监听在 `127.0.0.1` 时只生成本机地址。

## Guoba 兼容

EliaAdminPanel 自身的原生配置入口为 `elia.support.js`，导出 `supportPanel()`；`guoba.support.js` 保持独立，并复用同一份配置实现。扫描第三方插件时，优先读取 `elia.support.js`；没有时再读取 `guoba.support.js`。普通 Guoba 插件无需迁移现有配置。

原生 `supportPanel()` 可同步或异步返回 `pluginInfo` 和 `configInfo`。标准 Guoba 的 `supportGuoba()` 需要同步返回对象，以匹配 Guoba 加载器的调用方式；其中配置读写方法仍可异步。插件列表中的 Logo 读取 `pluginInfo.iconPath`，支持插件目录内的 PNG、JPG、WebP、GIF 或 ICO 图片。示例：

```js
import path from "node:path"
import { fileURLToPath } from "node:url"

export function supportPanel() {
  return {
    pluginInfo: {
      name: "ExamplePlugin",
      title: "示例插件",
      description: "插件用途说明",
      author: "作者名",
      link: "https://example.com/repository",
      icon: "mdi:puzzle-outline",
      iconColor: "#6f78d8",
      iconPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "resources", "logo.png"),
    },
    configInfo: {
      schemas: [
        { field: "enabled", label: "启用插件", component: "Switch" },
        { field: "interval", label: "间隔秒数", component: "InputNumber", componentProps: { min: 1 } },
      ],
      async getConfigData() {
        return { enabled: true, interval: 30 }
      },
      async setConfigData(data, { Result }) {
        // 在这里校验 data 并写入插件配置。
        return Result.ok({}, "配置已保存")
      },
      actions: {
        async reload(args, { Result }) {
          // args 是面板提交的 JSON 参数，可为空。
          return Result.ok({}, "插件已重载")
        },
      },
    },
  }
}
```

`schemas[].field` 支持点分路径；可视化控件包括 `Switch`、`InputNumber`、`Input`、`InputTextArea`、`Select`、`RadioGroup`，以及以多行文本编辑的 `GTags`、`CheckboxGroup`、`GSelectFriend` 等列表字段。`configInfo.actions` 会显示为需确认后执行的操作。保存与操作都可以通过 `Result.ok(result, message)` / `Result.error(message)` 返回结果。面板自身的 `elia.support.js` 和 `guoba.support.js` 共用配置定义，监听地址或端口修改后需重启 Bot 生效。

## 开源许可

本项目使用 GNU GPL v3，许可全文见 [LICENSE](LICENSE)，与 Elia-Yunzai 使用相同的开源许可。
