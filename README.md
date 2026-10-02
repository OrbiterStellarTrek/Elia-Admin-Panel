# EliaAdminPanel 独立 Web 控制面板

EliaAdminPanel 是一个独立的 Yunzai 插件，使用标准插件入口接入 Yunzai，不依赖 Elia-Yunzai 专属插件或服务。Express 负责面板 API 与静态页面，前端使用 Next.js 和 shadcn/ui，优先适配桌面浏览器。

## 能力

- 运行概览：Bot 版本、进程、运行时间、内存、账号头像与在线状态、群组缓存状态，以及 Redis 中的发送/截图统计和适配器接收量。
- 账号资料：按适配器能力查看和编辑头像、昵称、签名、性别及年龄；头像支持裁剪和缩放，并自动压缩至 1.5 MB 以内。
- 配置中心：以表单编辑 `config/config/*.yaml`，也能切换到 YAML 源码；表单保存会尽量保留 YAML 注释和格式，更新 Yunzai 配置缓存，并校验 `qq.yaml` 的登录设备类型为 1-6。
- 插件控制：列表分为大插件目录和小插件单文件；大插件优先读取 `*.support.js` 提供图形化配置，小插件可直接编辑源码。插件配置可使用 `EasyCron` 控件编辑并校验 5 段或 6 段 Cron 表达式，显示下次执行时间。大插件没有 support 入口时，会预览插件 `config/` 或 `configs/` 目录中的配置文件。可从 HTTPS 仓库安装插件，并选择安装依赖或在安装成功后重启 Bot；依赖安装不会执行第三方生命周期脚本。HTTPS 和跳过依赖生命周期脚本都不构成代码沙箱；安装的插件会由 Yunzai 加载，请先审查代码并只安装可信来源。
- 插件正则排查：按群组、消息类型、插件、处理方法或正则搜索规则，并用测试消息检查命中；可将对应插件加入群组禁用配置。排查会实例化插件类以读取规则，插件构造函数可能执行代码，请仅对可信插件使用。
- 消息调试：将模拟私聊或群聊事件送入插件处理链，并在面板捕获回复。模拟事件按主人身份运行，群聊还模拟群主和管理员；虽然捕获的回复不会直接发送到 QQ，插件若自行调用真实 Bot 或外部服务仍可能产生实际副作用。音频调试需要 FFmpeg；FFmpeg 直接读取 Yunzai 的 `config/config/bot.yaml` 中的 `ffmpeg_path`（通过 `cfg.bot` 获取）；留空时使用 `PATH` 中的 `ffmpeg`。修改配置后下一次转码即使用新值。
- 文件管理：在工作区中浏览并编辑 YAML、JSON、JS/TS、Markdown、CSS、HTML 等文本文件。文本编辑单个文件限制 1.5 MB；支持向当前目录上传文件，每个文件最多 20 MB，不覆盖同名文件。保存前自动备份到 `data/elia-admin-panel/backups/`。
- 运行日志：查看 command 和 error 日志末尾内容。
- 进程操作：仅在检测到 ksr 重启令牌或 PM2 托管时提供重启按钮。

文件管理器将 `.git`、`node_modules`、Next 构建目录及面板内部凭据数据目录排除在浏览和编辑之外；拒绝符号链接、硬链接、Windows 路径别名和工作区外路径。

## 安装与构建

在 Yunzai 根目录克隆插件并安装依赖。Yunzai 会按插件目录的 `index.js` 自动加载：

```bash
git clone --depth=1 https://github.com/OrbiterStellarTrek/Elia-Admin-Panel.git plugins/EliaAdminPanel
pnpm install --filter elia-admin-panel --ignore-scripts
```

首次以生产模式启动时，如果插件目录没有完整的 `out/index.html` 和 `out/_next/static/`，插件会从上述 GitHub 仓库的 Latest Release 下载最新前端构建归档，校验 SHA-256 后解压到 `plugins/EliaAdminPanel/out/`。此过程需要访问 GitHub，并需要系统提供 `tar` 命令；如果环境无法联网，也可以在插件目录安装依赖后运行 `pnpm build` 手动生成。开发模式使用 `next dev`，不会触发自动下载。面板默认地址为 `http://127.0.0.1:50882`。首次随机密码写入受保护的 `data/elia-admin-panel/credentials/bootstrap.txt`；在 Bot 本机读取后登录，首次密码登录成功会删除该交付文件。配置文件只保存随机盐和 PBKDF2 哈希；普通日志和 stdout 不包含首次密码，之后重启不会重新生成密码。

面板栏目可以通过固定地址直接打开：`/config/`（配置中心）、`/plugins/`（插件控制）、`/files/`（文件管理）、`/logs/`（运行日志）、`/debug/`（消息调试）；`/` 为运行概览。选中的配置文件、插件和文件路径分别保存在 `?file=`、`?plugin=`、`?path=` 中，刷新或复制网址后仍能回到对应位置。

## 设置和插件管理

“其他设置”中的主人 QQ 号支持从好友列表选择；私聊放行正则可以打开插件正则排查，搜索、测试并选择私聊规则，点击“保存更改”后生效。Yunzai 的放行配置只保存正则字符串，不支持 flags，带 flags 的规则需手动调整。QQBot-Plugin 官方账号按 `account.adapter.id === "QQBot"` 识别，面板不会尝试向它查询常规数字群；混合账号优先从普通账号的群缓存查找。

第三方 support 表单支持 `Select` 的 `multiple`、`tags` 模式和 `CheckboxGroup`，选项未提供 `label` 时显示 `value`；多选保存为数组，tags 可添加自定义值。大插件按 support 入口、扫描到配置文件、无配置的顺序排列；无配置插件默认折叠，可手动展开。

- **禁用/启用**：禁用后将整个目录保留到面板数据目录，重启 Bot 后停止加载；可从“已禁用插件”重新启用。面板自身不能禁用。
- **依赖编辑**：含 `package.json` 的插件可编辑 dependencies、devDependencies、peerDependencies 和 optionalDependencies，保存前备份；可选随后安装依赖，跳过生命周期脚本。
- **手动更新**：有公开 HTTPS origin 的 Git 插件可选择或输入分支、commit；获取远端后展示分支及最多 80 条提交。统一使用“面板设置”中的常规 HTTP/SOCKS 代理或 HTTPS 链接前缀代理，代理不写入 origin。发现本地修改或未跟踪文件时停止更新。
- **历史裁剪**：更新时可将独立 `.git` 裁剪成只含所选最新提交的浅仓库；原 Git 数据保存在 `data/elia-admin-panel/git-backups/`。普通分支更新会通过 Git 备份引用保留原分支提交；指定 commit 后处于游离 HEAD。不支持裁剪 Git worktree 的 `.git` 文件、存在关联 worktree 或已初始化子模块的仓库。
- **单 JS 安装**：从小插件区上传 `.js` 或指定 HTTPS 文件直链，安装到 `plugins/example/`，最多 1.5 MB；拒绝重定向、HTML 网页和语法错误，不覆盖同名文件。重启后加载。

上传继续遵守工作区、符号链接、面板凭据目录和 `.git` 等受保护目录的限制。二进制文件可以上传并在列表查看，无法在线编辑。

## 前端版本更新

GitHub Actions 在前端 GitHub Release 发布成功后，会将相同标签、标题、说明及 `frontend-<SHA>.tar.gz` 构建附件同步到 [GitCode 镜像仓库](https://gitcode.com/Mirror-Yunzai/Elia-Admin-Panel)。使用仓库 Secret `GITCODE_RELEASE_TOKEN`，令牌需有目标仓库的 Release 写入权限。镜像须已包含对应提交，创建标签时使用相同 SHA。GitCode 同步为非阻塞步骤，失败只产生 Actions 警告，不影响 GitHub Release 发布成功；重跑 workflow 时会更新已有 GitCode Release 并替换同名附件。

在“运行概览 → 面板前端”点击“检查并更新前端”。面板读取本仓库 GitHub 最新正式 Release，比较已安装发布包的 SHA-256 摘要和本地文件指纹。相同且完整时不下载；发现不同或本地文件被修改时，下载并校验包大小、SHA-256 和归档路径，再安装到 `out/`。本地构建没有发布标记时会下载一次进行比较，内容相同则仅记录发布信息。

更新期间保留原前端，替换失败会恢复；成功后在 `data/elia-admin-panel/frontend-previous-out/` 保留上一个版本及其静态资源，供尚未刷新的页面继续加载。点击“刷新使用新版本”即可使用更新结果，无需重启 Bot。网络或校验失败不会替换当前前端；并发更新会被拒绝。此功能仅更新发布版静态前端，不更新插件后端。开发模式使用源码热更新，需关闭开发模式并重启 Bot 后使用发布版更新。

插件选项说明显示在字段旁的问号 Tooltip 中，支持悬停、键盘聚焦和点击，按 Escape 关闭。

## 登录方式

- **验证码登录**：点击“获取验证码”，在 Bot 本机读取 `data/elia-admin-panel/credentials/login-code.txt`。验证码 5 分钟有效、只能使用一次；每个来源 IP 每 15 分钟最多请求 3 次，连续输错 10 次会作废。
- **主人快捷地址**：主人私聊 Bot 发送 `#elia登录`（群内发送也会私聊主人返回地址）。地址 3 分钟有效且只能使用一次，Bot 重启后未使用的地址失效。
- **面板密码**：在 EliaAdminPanel 插件配置中设置新密码（至少 12 个字符）；密码框默认留空，读取配置时不会回显密码。保存后立即生效，并以独立随机盐和 PBKDF2 哈希写入配置。密码登录按来源 IP 限流，每 15 分钟最多 10 次，并限制密码派生计算的并发数。忘记密码时可先用验证码或主人快捷地址登录，再在插件配置中重设。
- **浏览器会话**：使用 HttpOnly、SameSite=Strict Cookie，令牌有效 12 小时；未轮换凭据的有效会话可跨重启保留。退出登录立即撤销对应 HTTP/WS；通过 Elia 或 Guoba 修改密码/Secret，立即撤销全部 HTTP、日志 WS、HMR、快捷码和持久会话，阻断旧密码在途登录。首次升级到加固版会要求旧会话重新登录。

密码登录、验证码申请和验证码校验均要求完成 Cap 人机验证，服务端会在执行操作前向 Cap 验证 token。在“面板设置 → 登录安全”设置 Cap 服务器 HTTPS 根地址、Site Key 和 Secret Key；前两项用于生成公开 widget endpoint，私钥以明文保存在受保护的 `data/elia-admin-panel/config.yaml`，配置页不会回显。服务器地址与 Site Key 也可分别由 `CAP_SERVER_URL` 和 `CAP_SITE_KEY` 环境变量提供，YAML 中的值优先；Secret 可由 `CAP_SECRET_KEY` 环境变量提供回退值。未配置完整站点信息、Secret 或 Cap 服务不可用时，认证接口会拒绝请求，不能绕过验证继续登录。

验证码和首次密码仅通过本机受保护文件交付，不通过网页响应、普通日志或 stdout 返回。Windows 的 Node 文件 mode 不能替代 ACL，请从 Yunzai 根目录运行 `plugins/EliaAdminPanel/scripts/secure-local-storage.ps1`，并确认实际 Bot 运行账号拥有权限。请勿转发主人快捷地址。

## 面板设置

所有面板运行设置集中在侧边栏的“面板设置”（`/settings/`），包括 Web 服务、登录安全、代理配置及前端更新。也可编辑工作区中的 `data/elia-admin-panel/config.yaml`。该文件由插件创建，包含监听地址、端口、公网访问地址、登录随机图 API、开发模式、Secret，以及面板密码的盐和哈希；面板文件管理器会保护整个数据目录。不要将这个文件提交到 Git 或公开分享。第三方插件的 `elia.support.js` / `guoba.support.js` 配置继续保留在“插件控制”。

登录页左侧加载随机图片；服务端的 `loginImageApi` 缺失或无效时回退到 `https://t.alcy.cc/moe`。可在配置文件中设置 `loginImageApi: "https://example.com/random-image"`，该地址必须直接返回图片或重定向到图片；也可在面板设置中修改，保存后立即生效。

`devMode` 默认为 `false`。本机开发时可在面板设置中开启，或在 YAML 中设置 `devMode: true`；重启 Bot 后面板会使用 `next dev` 并通过原面板地址提供实时热更新。开发模式性能较低且包含开发工具，不要对公网开放；生产环境保持关闭。

默认只监听本机回环地址。若需要从其他设备访问，可将 `host` 改为 `0.0.0.0`，在“面板密码”中设置高强度密码，并通过防火墙限制访问来源。不要将默认随机密码或管理端口直接暴露到公网。

浏览器会话 Secret 首次启动时自动生成。会话存储仅包含随机 ID 的摘要、到期时间和凭据版本；新 Secret 至少需要 32 个 UTF-8 字节，保存后立即撤销旧会话。面板设置直接由配置文件管理，不依赖 `YUNZAI_PANEL_PUBLIC_URL`、`YUNZAI_PANEL_PASSWORD` 或 `YUNZAI_PANEL_SECRET` 环境变量。

如果面板通过反向代理、端口映射或域名访问，在“公网访问地址”中填写一个或多个外部站点根地址（不含子路径），每行一个或用逗号分隔，例如 `https://bot.example.com`。主人快捷登录会使用这些地址生成链接；留空时根据监听地址生成本机或局域网地址。监听在 `127.0.0.1` 时只生成本机地址。

## 安全部署与保存

HTTPS 反向代理需要设置 `trustedProxies`（精确 IP/CIDR）和 `publicUrl`；代理应覆盖 `X-Forwarded-Proto`，而不是透传客户端值。公网部署建议同时启用 `cookieSecure: true`。来源检查采用完整 origin；不可信转发头不会改变 Cookie 的传输属性。本机 HTTP 开发可保持 `cookieSecure: false`。

可在面板设置中设置并查看安全入口路径；也可通过进程环境变量 `SECURITY_ENTRANCE` 提供回退值。面板设置中的非空值优先，路径长度为 1 至 256，且仅允许字母、数字、`-` 和 `_`；留空时使用环境变量，二者都为空时关闭。访问 `/{入口路径}` 后会签发有效期 20 分钟的 HttpOnly 入口 Cookie。入口校验由 Node.js 后端执行，反向代理无需配置对应路由。已登录 Session 不受入口 Cookie 过期影响。

“面板设置 → 代理设置”保存唯一的下载代理类型和地址，对插件安装、Git 更新、小插件直链下载，以及前端发布版下载（包括首次初始化）立即生效。`downloadProxyMode` 可设为 `none`、`standard` 或 `prefix`，`downloadProxyUrl` 为对应地址。常规代理支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H，必须使用固定 IP 的根地址，例如 `http://127.0.0.1:7890`；不接受凭据、查询或片段。HTTPS 链接前缀代理还需支持 GitHub API 与目标下载地址。请求参数和环境变量不能覆盖已保存的选择；旧 `approvedProxyUrls` 仅保留原数据，不再决定下载代理。

已保存的常规代理属于可信出站边界，应在代理侧限制目的地址、DNS 和重定向。所有目标及 HTTPS 前缀代理仍须满足公网 DNS 校验；直连和前缀 Git 禁止重定向并固定解析地址。Git 需支持 `http.curloptResolve`。同页的“可信反向代理 IP/CIDR”负责入站 HTTPS 判定，与下载代理独立。

配置、普通文件、插件 support 配置和依赖保存必须携带读取时的版本；旧版本返回 409，缺版本返回 428，前端已经同步适配。具体变更、回归入口及尚未完成的部署事项见 [加固记录](docs/SECURITY/2026-09-28/SECURITY_HARDENING.md)。

已认证 API 的写请求会记录脱敏审计元数据，包括时间、方法、去除查询参数的路径、状态码和会话标识前缀；不记录请求体或请求头。日志位于 `data/elia-admin-panel/audit/events.jsonl`，文件超过 4 MiB 时轮转，并保留一个 `.previous` 文件。

从曾将首次密码写入日志的旧版本升级时，可在 Yunzai 根目录运行 `node plugins/EliaAdminPanel/scripts/harden-local-config.mjs`。脚本会关闭开发模式；若发现旧日志中的首次密码仍与当前凭据匹配，会轮换密码、生成 bootstrap 凭据文件并清空持久会话。

## Guoba 兼容

EliaAdminPanel 自身的运行配置由独立的面板设置接口管理，不再通过 `elia.support.js` 提供配置入口。扫描第三方插件时，优先读取 `elia.support.js`；没有时再读取 `guoba.support.js`。普通 Guoba 插件无需迁移现有配置。

插件列表将含 `index.js`、Git 仓库或 `*.support.js` 的插件目录归为大插件；`example` 目录及未识别为独立插件目录下的 `.js` 文件归为小插件。小插件可直接在插件页编辑源码，保存前自动备份，Ctrl+S 可保存，重启 Bot 后加载新代码。大插件按 `elia.support.js`、`guoba.support.js`、其他 `*.support.js` 的顺序查找配置工厂；没有 support 入口时，面板预览其 `config/` 或 `configs/` 中的 YAML、JSON、TOML、INI、CONF 和 properties 文件，并可跳转文件管理器编辑。

原生 `supportPanel()` 可同步或异步返回 `pluginInfo` 和 `configInfo`。标准 Guoba 的 `supportGuoba()` 需要同步返回对象，以匹配 Guoba 加载器的调用方式；其中配置读写方法仍可异步。插件列表中的 Logo 读取 `pluginInfo.iconPath`，支持插件目录内的 PNG、JPG、WebP、GIF 或 ICO 图片。完整的可复制示例见 [elia.support.example.js](elia.support.example.js)；将它复制到目标插件根目录并改名为 `elia.support.js`，示例配置保存在插件自己的 `config/example.json` 中。该示例文件名不会被面板当作 support 入口加载。下面是精简示例：

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

`schemas[].field` 支持点分路径；完整控件示例见 [elia.support.example.js](elia.support.example.js)。支持 `SOFT_GROUP_BEGIN` 分组、`Switch`、`InputNumber`、`Input`（包括 `componentProps.type: "password"`）、`ColorPicker`、`GColorPicker`、`InputTextArea`、单选/多选/tags 模式的 `Select`、`RadioGroup`、`CheckboxGroup`、`GTags`、`GSelectFriend`、`GSelectGroup`、`EasyCron` 和 `GSubForm`。`ColorPicker`/`GColorPicker` 保存为颜色字符串；兼容 Guoba 的普通 `Input` 字段若标签包含“颜色”，也会自动显示颜色选择器。多选值保存为数组，tags 可添加自定义值；好友和群组选择从当前机器人账号缓存加载。`configInfo.actions` 会显示为需确认后执行的操作。保存与操作都可以通过 `Result.ok(result, message)` / `Result.error(message)` 返回结果。

## 开源许可

本项目使用 GNU GPL v3，许可全文见 [LICENSE](LICENSE)，与 Elia-Yunzai 使用相同的开源许可。

## 开发验证

`pnpm --dir plugins/EliaAdminPanel test` 执行代理、输入校验、官方账号、FFmpeg、安全回归和真实临时 Git 仓库的测试。GitHub Actions 的“安全回归”工作流会在 push 和 pull request 时运行测试、类型检查、Secret 扫描及生产依赖审计。构建后，可在已安装 Puppeteer 的 Yunzai 根目录运行 `node --experimental-vm-modules plugins/EliaAdminPanel/tests/panel-smoke.mjs`，验证真实 API 和浏览器交互。冒烟测试使用临时工作区及模拟账号，不修改正在运行的 Bot 配置或插件。
