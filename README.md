# EliaAdminPanel 独立 Web 控制面板

EliaAdminPanel 是一个独立的 Yunzai 插件，使用标准插件入口接入 Yunzai，不依赖 Elia-Yunzai 专属插件或服务。Express 负责面板 API 与静态页面，前端使用 Next.js 和 shadcn/ui，优先适配桌面浏览器。

## 能力

- 运行概览：Bot 版本、进程、运行时间、内存、账号和群组缓存状态。
- 配置中心：以表单编辑 `config/config/*.yaml`，也能切换到 YAML 源码；保存后更新 Yunzai 配置缓存。
- 插件控制：优先读取 `elia.support.js` 并调用 `supportPanel()`；没有该文件时兼容 `guoba.support.js` 的 `supportGuoba()`。本面板专属入口使用 `elia.support.js`，避免和 Guoba 入口冲突。
- 文件管理：在工作区中浏览并编辑 YAML、JSON、JS/TS、Markdown、CSS、HTML 等文本文件。单个文件限制 1.5 MB，保存前自动备份到 `data/elia-admin-panel/backups/`。
- 运行日志：查看 command 和 error 日志末尾内容。
- 进程操作：仅在检测到 ksr 重启令牌或 PM2 托管时提供重启按钮。

文件管理器将 `.git`、`node_modules`、Next 构建目录排除在浏览和编辑之外；拒绝符号链接和工作区外路径。

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

验证码由服务端写入 Bot 日志，不会通过网页响应返回。请勿公开 Bot 控制台日志或转发主人快捷地址。

## 面板设置

可在 `plugins/EliaAdminPanel/config.yaml` 修改监听地址和端口，或者通过兼容插件控制页修改；设置变更需重启 Bot 生效。

默认只监听本机回环地址。若需要从其他设备访问，可将 `host` 改为 `0.0.0.0`，并配置环境变量 `YUNZAI_PANEL_PASSWORD` 为高强度密码，再通过防火墙限制访问来源。不要将默认随机密码或管理端口直接暴露到公网。

如果面板通过反向代理、端口映射或域名访问，请设置 `YUNZAI_PANEL_PUBLIC_URL`，可填写一个或多个逗号分隔的外部站点根地址（不含子路径），例如 `https://bot.example.com,http://192.168.1.20:50882`。主人快捷登录会使用该地址列表生成链接。未设置时，面板根据监听地址生成本机或局域网地址；监听在 `127.0.0.1` 时只生成本机地址。

## Guoba 兼容

EliaAdminPanel 自身的原生配置入口为 `elia.support.js`，导出 `supportPanel()`；`guoba.support.js` 保持独立，并复用同一份配置实现。扫描第三方插件时，优先读取 `elia.support.js`；没有时再读取 `guoba.support.js`。普通 Guoba 插件无需迁移现有配置。

入口模块需要导出异步工厂，返回 `pluginInfo` 和 `configInfo`。最小结构如下：

```js
export async function supportPanel() {
  return {
    pluginInfo: {
      name: "ExamplePlugin",
      title: "示例插件",
      description: "插件用途说明",
      author: "作者名",
      link: "https://example.com/repository",
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

`schemas[].field` 支持点分路径；支持 `Switch`、`InputNumber`、`Input`、`InputTextArea`、`Select` 和 `RadioGroup` 等控件。`configInfo.actions` 会显示为需确认后执行的操作。保存与操作都可以通过 `Result.ok(result, message)` / `Result.error(message)` 返回结果。面板自身的 `elia.support.js` 和 `guoba.support.js` 共用配置定义，监听地址或端口修改后需重启 Bot 生效。

## 开源许可

本项目使用 GNU GPL v3，许可全文见 [LICENSE](LICENSE)，与 Elia-Yunzai 使用相同的开源许可。
