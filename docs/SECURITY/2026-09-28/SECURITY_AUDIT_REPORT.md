# Yunzai WebUI Security Audit Report

## Executive Summary

**审计日期：2026-09-28。审计对象：`D:\Bot\Elia-Yunzai\plugins\EliaAdminPanel`，基准提交 `636f07d`。** 文中插件文件路径相对于该目录；宿主文件标注为“宿主”。代码位置均对应本次审计快照。审计没有修改业务实现、真实 Bot 配置、登录凭据或现有 Git 工作。

范围包括插件全部前后端源码、配置适配器、现有测试、可见 Git 历史、实际安装的直接依赖及相关传递依赖，并追踪直接调用的宿主配置、插件加载器、日志、ICQQ 头像下载逻辑。其他 Yunzai 插件的任意业务行为、外部适配器服务、反向代理部署、操作系统权限配置不属于完整审计范围；跨入这些边界时在正文明确说明。

采用人工白盒调用链分析、按源代码提取路由的鉴权验证、隔离工作区 HTTP/WebSocket 验证、实际依赖解析、依赖公告核对和脱敏 Secret 扫描。网络验证仅连接本次自建的本机 TCP 服务；Git 安装竞态使用模拟进程；开发接口验证使用临时最小 Next.js 项目和真实面板代理代码，没有调用重启、编辑器、inspector、真实 Bot 操作或真实内网业务服务。外网访问仅用于依赖审计和读取公开安全公告，没有扫描互联网资产。

**确认 7 项发现：Critical 0、High 0、Medium 5、Low 2。** 依赖风险和未确认的利用链单独列出，不计入确认漏洞数量。最值得先处理的是开发模式的鉴权缺口、密码登录并发限流失效、密码轮换不撤销旧会话。SSRF 需要面板管理员会话；没有把管理员本来拥有的源码编辑和插件安装能力当作未授权 RCE。

项目有实际生效的安全机制：全部 36 个业务路由组合在未登录时返回 401；日志 WebSocket 检查 Cookie 与 Origin，并持续复核会话；令牌采用固定 HMAC-SHA256 签名、到期检查和服务端会话白名单；常规文件入口限制工作区、保护目录和符号链接；上传使用排他创建。不能因这些机制存在就忽略开发代理和异步竞态：相关缺口已通过独立验证确认。

本机配置快照为 `host: 127.0.0.1`、`devMode: true`，密码为加盐哈希，Secret 长度满足 32 字节。这里读取的是持久配置，**不代表已证明运行进程的实际监听状态，也不代表不存在外部端口映射或代理**。代码默认 `devMode: false`。

## Attack Surface

### 入口与信任边界

| 攻击面 | 实际入口 / 位置 | 身份与行为 |
|---|---|---|
| Yunzai 插件入口 | `index.js:1-46`，`EliaAdminPanel.init()` | 启动独立面板；快捷登录同时使用规则 `permission: master` 和 `e.isMaster` 校验 |
| 前端 | `app/layout.tsx`、各 `app/*/page.tsx`、`components/dashboard.tsx` | Next.js + React；主要栏目均复用 Dashboard；生产为静态导出 |
| HTTP 服务 | `src/server.js:1726-2419` | Express 5；默认 `127.0.0.1:50882`；与 Bot 同一进程和文件权限 |
| 登录入口 | `src/server.js:1745-1813` | 密码、日志验证码、主人一次性快捷码；状态接口公开，注销需要会话 |
| 业务鉴权 | `src/server.js:1815-1816` | `/api` 下业务路由统一 `requireAuth` 和 `checkOrigin`；没有普通用户角色 |
| 文件 / 配置 | `src/server.js:2036-2068, 2233-2354` | 管理员可读取、编辑、上传工作区内容；YAML 配置刷新宿主缓存 |
| 插件管理 | `src/server.js:2071-2230`、`src/plugin-management.js` | Git 安装/更新/历史裁剪、依赖保存和安装、单 JS 安装、禁用恢复、support 配置和 action |
| 消息调试 | `src/server.js:456-565, 1818-1833` | 管理员输入送入宿主处理链，事件固定为主人身份；群事件模拟群主和管理员 |
| 日志 | `src/server.js:1223-1357, 1499-1590, 2357-2377` | HTTP 日志尾部及 `/api/logs/ws` WebSocket；仅 command/error 文件名格式 |
| Shell / 子进程 | `src/server.js:243-284, 1404-1443, 1593-1635, 2102, 2115, 2152, 2162` | FFmpeg、Next CLI、PM2、Git、pnpm、JS 语法检查；pnpm 在 Windows 使用 Shell |
| Redis | `src/server.js:1187-1220` | 只调用全局 Redis 的 `mGet`，读取固定格式计数键，无用户输入构造 Redis 命令 |
| 数据库 | 插件源码无 SQL/ORM/NoSQL 调用 | 宿主有数据库依赖，但面板自身没有数据库查询接口 |
| 代理 / URL | `src/server.js:848-881, 1445-1497, 1637-1649, 1894-1907`；`src/plugin-management.js:7-17, 125-138` | 公网地址用于生成链接；开发代理目标固定；Git、下载直链、头像 URL 和下载代理可受管理员输入影响 |
| 静态资源 | `src/server.js:2384-2396`、`next.config.ts` | `out/` 公开提供登录 UI；未直接公开工作区或面板凭据目录 |
| CORS / Session / Header | `src/server.js:750-846, 1734-1743` | 无开放 CORS；Cookie 为 HttpOnly、SameSite=Strict；有 nosniff、DENY、no-store，缺少 CSP |

没有发现 Koa/Fastify、Web 终端、SSE、Zip 解压上传接口、Docker/systemctl 执行接口或独立 JWT 库。会话令牌是项目自定义的 HMAC 格式，不能套用不存在的 JWT `alg` 混淆漏洞。

### 每个敏感 API 的鉴权核对

下表所有业务路由都位于 `app.use("/api", requireAuth)` 后；隔离验证分别发送无 Cookie 请求，每个方法/路由组合均返回 **401**。禁用和归档别名分别计数，总计 **36** 个组合。

| 方法 | 路由 | 关键权限 / 输入边界 |
|---|---|---|
| POST | `/api/debug/message` | 管理员；消息 5000 字符；身份是模拟主人，非普通用户调试沙箱 |
| POST | `/api/cron/validate` | 管理员；表达式 120 字符、5/6 段 |
| GET | `/api/status` | 管理员；返回运行概况，不返回 Secret |
| GET | `/api/accounts` | 管理员；全量 Bot 账号概况 |
| PATCH | `/api/accounts/:id/profile` | 管理员；ID 必须存在，字段使用 `Object.hasOwn` allowlist；头像 URL 存在 SSRF 缺口 |
| GET | `/api/config` | 管理员；只列出直接目录中的 `.yaml` 普通文件 |
| GET | `/api/diagnostics/plugin-rules` | 管理员；读取宿主插件规则，可能实例化可信插件类 |
| GET | `/api/config/group-plugin-names/:groupId` | 管理员；数字群号或 `default` |
| GET | `/api/config/friends`、`/api/config/groups` | 管理员；读取缓存；没有用户查询对象注入 |
| GET / PUT | `/api/config/:name` | 管理员；严格文件名正则；此路径没有复用符号链接检查，见架构观察 |
| GET | `/api/plugins` | 管理员；动态加载工作区内已有 support；执行边界见架构观察 |
| GET | `/api/plugins/:id/git` | 管理员；插件名 allowlist、目录链接拒绝 |
| POST | `/api/plugins/:id/git/fetch`、`/api/plugins/:id/git/update` | 管理员；按插件互斥；Git 参数数组及 ref 校验 |
| GET / PUT | `/api/plugins/:id/dependencies` | 管理员；目录及 package.json 链接拒绝；版本必须为字符串 |
| POST | `/api/plugins/install-script` | 管理员；1.5 MB、`.js`、文件名检查、语法检查、排他创建；直链存在 SSRF |
| GET / PUT | `/api/plugins/:id/config` | 管理员；交给插件 support 工厂读写配置 |
| POST | `/api/plugins/:id/action` | 管理员；执行 support 的函数；需要加 own-property 检查 |
| POST | `/api/plugins/install` | 管理员；HTTPS 仓库校验；安装未参加统一互斥，失败清理有竞态 |
| GET | `/api/plugins/archives` | 管理员；面板数据目录中的归档列表 |
| POST | `/api/plugins/:id/disable`、`/api/plugins/:id/archive` | 管理员；自身插件不可禁用；归档保留文件 |
| POST | `/api/plugins/archives/:archiveId/restore` | 管理员；归档名正则、禁止覆盖已有目标；未加入安装共用锁 |
| GET | `/api/files`、`/api/files/read`、`/api/files/image`、`/api/files/audio` | 管理员；工作区限制、受保护目录拒绝、逐段 lstat 链接拒绝、类型/大小约束 |
| GET | `/api/debug/audio/:token` | 管理员；随机 Token、10 分钟缓存、32 MB 总缓存预算 |
| PUT | `/api/files/write` | 管理员；1.5 MB、扩展名 allowlist、路径检查、备份及临时文件替换 |
| POST | `/api/files/upload` | 管理员；20 MB；文件名拒绝分隔符和 Windows 保留名；`flag: wx` 不覆盖已有文件 |
| GET | `/api/logs` | 管理员；选择必须在实际日志列表；最多 512 KiB 尾部、600 行 |
| POST | `/api/runtime/restart` | 管理员；只支持已识别 ksr/PM2；没有用户可控 Shell 命令 |

公开登录端点为 GET `/api/auth/status` 和 POST `/api/auth/login`、`/api/auth/code/request`、`/api/auth/code/check`、`/api/auth/quick`；POST `/api/auth/logout` 自带鉴权。公开 HTML/JS 是显示登录页所需资源，不等于公开敏感 API。开发模式的非 `/api` 路由绕过上述边界，见 MED-01。

前端通过 `request()`（`components/dashboard.tsx:263-279`）使用相对 URL、`credentials: same-origin` 和 `cache: no-store`；插件 ID、文件名等请求参数使用 URL 编码。日志 WebSocket 使用当前站点的 `ws:`/`wss:` 地址，浏览器自动带同站点 Cookie。前端隐藏、确认按钮均未被当作后端权限控制。

## Findings Summary

| ID | Severity | Vulnerability | Component | Status |
|---|---|---|---|---|
| MED-01 | Medium | 开发模式的 Next.js 敏感接口未经面板鉴权，代理改写 Origin | 开发代理 | Confirmed：真实隔离 Next 服务 |
| MED-02 | Medium | 异步密码校验前未预占限流额度，并发请求绕过失败计数 | 密码登录 | Confirmed：24 次并发仅记 1 次 |
| MED-03 | Medium | 单 JS 下载与 ICQQ 头像 URL 缺少目标网络限制 | URL 下载 / 头像 | Confirmed：实际连接自建回环监听 |
| MED-04 | Medium | 修改面板密码不撤销已有 HTTP / WebSocket 会话 | 会话管理 | Confirmed：旧 Cookie 200，旧 WS 收到日志 |
| MED-05 | Medium | 同名插件安装竞争时，失败请求删除成功安装结果 | 插件安装 | Confirmed：隔离真实路由 + 模拟 Git |
| LOW-01 | Low | HTTPS 反向代理场景下会话 Cookie 仍缺少 Secure | Cookie / 代理 | Confirmed：HTTPS 转发头下仍无 Secure |
| LOW-02 | Low | 首次密码及一次性登录验证码进入持久日志 | 登录 / 宿主日志 | Confirmed：当前日志与隔离宿主 logger |

## Critical Findings

未确认 Critical 漏洞。没有发现无需登录即可执行 Bot/宿主机命令的代码路径。

## High Findings

未确认 High 漏洞。未知外部适配器行为、开发 inspector 的进一步利用以及依赖扫描的 High/Critical 标签，没有被直接转化为本项目已确认的 High/Critical 发现。

## Medium Findings

### [MED-01] 开发模式的 Next.js 敏感接口未经面板鉴权，代理改写 Origin

**严重等级：** Medium。**漏洞类型：** 缺失鉴权 / 开发攻击面暴露（CWE-306）。

**影响组件：** Express → Next 开发服务代理。**涉及文件：** `src/server.js`；实际安装依赖 `next/dist/next-devtools/server/devtools-config-middleware.js`、`restart-dev-server-middleware.js`、`attach-nodejs-debugger-middleware.js`。

**涉及函数 / 路由：** `proxyNextRequest()`、`proxyNextUpgrade()`、开发模式 fallback；`/__nextjs_server_status`、`/__nextjs_devtools_config`。**代码位置：** `src/server.js:1445-1497, 1556-1559, 1815-1816, 2384-2387`。Next 开发偏好接口在依赖文件 `devtools-config-middleware.js:31-68`；内部开发中间件由 `next/dist/server/dev/hot-reloader-webpack.js` 注册。

**漏洞描述：** 鉴权和来源检查只挂载在 `/api`。开启 `devMode` 后，其余 HTTP 请求无条件代理到 Next 开发服务；非日志 WebSocket 升级也直接转发。代理把来访请求的 Origin 改为本机上游 Origin，使 Next 无法按原始 Origin 拒绝外站请求。因而面板登录不能隔离开发工具操作。

**攻击前提：** `devMode: true`，攻击者能够连接面板端口；不需要面板密码或 Cookie。默认关闭开发模式，所以不是默认生产配置下的未授权业务 API 漏洞。当前持久配置已启用开发模式但绑定回环；远程风险取决于是否转发该端口。

**数据流：**

```text
未登录请求 /__nextjs_devtools_config，Origin 可由调用者指定
↓
不匹配 /api 鉴权中间件 → 开发模式 fallback
↓
proxyNextRequest 把 Host / Origin 改为 127.0.0.1:nextDevPort
↓
真实 Next dev 中间件写入 .next/dev/cache/next-devtools-config.json
```

**利用方式 / 最小验证：** 以下请求只修改临时 Next 项目的 UI 偏好；必须在隔离环境验证，不对正在使用的开发服务发送操作请求。

```http
POST /__nextjs_devtools_config HTTP/1.1
Host: 127.0.0.1:<隔离面板端口>
Origin: https://attacker.invalid
Content-Type: application/octet-stream
Content-Length: 16

{"theme":"dark"}
```

实际无 Cookie 请求返回 **204**，隔离项目的偏好文件真实变为 `theme: dark`；GET `/__nextjs_server_status` 无 Cookie 返回 **200** 和 executionId。这里使用 octet-stream 是因为通用 `express.json` 会提前消费 JSON 请求体，原代理没有重建该请求体；这不会构成鉴权保护。

**影响：** 未登录调用者可以访问本应只面向开发人员的内部接口。依赖源码另有开发重启、打开编辑器和开启 Node inspector 的中间件，因此不能把暴露范围等同于几项 UI 偏好。**这些危险接口没有执行；没有证明通过它们取得任意文件内容或 RCE。** HMR Upgrade 在代码上缺少面板鉴权，但实际隔离握手未成功，记为 **Needs Verification**，不声称已建立连接。

**修复建议：**

1. 生产和远程部署保持 `devMode: false`；启动时拒绝将开发模式直接绑定非回环地址，且文档明确禁止代理整套开发接口给不可信访问者。
2. 对开发内部路径和 HMR 分别增加面板会话检查；登录 UI 所需页面可公开，开发工具 API 和源码调试能力不应因此公开。与已安装 Next 版本对照维护允许公开的静态资源范围。
3. 在进入 HTTP/Upgrade 代理前对原始 Origin 执行相同的来源校验。只有通过校验后，为兼容内部服务进行必要的上游改写；不能用改写替代来源校验。
4. 升级请求应使用同一会话验证器，并在会话失效后断开已建立的开发连接；不只保护 `/api/logs/ws`。

示例接入位置（需配套 Upgrade 分支，不能仅复制 HTTP 示例）：

```js
app.use((req, res, next) => {
  if (!settings.devMode) return next()
  const internalDev = req.path.startsWith("/__nextjs")
    || req.path === "/_next/webpack-hmr"
  if (!internalDev) return next()
  checkOrigin(req, res, () => requireAuth(req, res, next))
})
// 放在开发代理之前；原始 Origin 必须在改写前验证。
```

**整改验收：** 未登录的状态/偏好等内部请求返回 401/403；已登录但外站 Origin 请求返回 403；正常登录 UI 和经过鉴权的 HMR 可用；关闭开发模式时不启动 Next dev。

### [MED-02] 异步密码校验前未预占限流额度，并发请求绕过失败计数

**严重等级：** Medium。**漏洞类型：** 认证限流竞态 / 资源消耗（CWE-362、CWE-307）。

**影响组件：** 密码登录。**涉及文件：** `src/server.js`。

**涉及函数 / 路由：** POST `/api/auth/login`、`verifyPanelPassword()`、`derivePassword()`。**代码位置：** `src/server.js:636-643, 674-683, 1754-1770`。

**漏洞描述：** 路由读取 IP 的失败计数后，先等待 PBKDF2 验证结束，才将失败次数写回 `loginAttempts`。当该 IP 首次访问或记录已清除时，每个并发请求都创建独立的 `count: 0` 对象，并在异步工作结束后各自写回 1。即使已有记录，校验启动前也没有增加或预占额度，多个请求可共同越过阈值检查。

**攻击前提：** 可连接面板登录端点，不需要登录。默认回环绑定限制远程可达性；如果端口被开放/转发，则可远程触发。

**数据流：**

```text
同一 IP 的并发 JSON password 请求
↓
读取尚未增加的 count → 每个请求均通过 count < 10
↓
异步 PBKDF2，310000 次 SHA-256 迭代
↓
完成后才 count += 1 并 set；独立对象互相覆盖
```

**利用方式：** 隔离诊断脚本同一 IP 同时发送 **24** 个错误密码请求：24 个均返回 **401**，没有 429，最终记录为 **count: 1**。对照测试顺序发送 11 次，前 10 次 401、第 11 次 429。没有进行大规模压力测试。

```http
POST /api/auth/login HTTP/1.1
Host: 127.0.0.1:<隔离面板端口>
Content-Type: application/json

{"password":"审计错误密码"}
```

**影响：** 同一来源可绕过预期的 15 分钟 10 次限制，扩大口令猜测次数，并将计算任务排入共享 Node 线程池；这可能影响同进程 Bot 的文件/加密任务。没有证明已经猜中强随机密码，也没有用 OOM/长时间负载证明进程失效。

**修复建议：** 在第一次 `await` 前同步预占请求额度，失败/成功语义与业务保持一致；额外设置全局 KDF 并发上限和短队列/直接拒绝策略，避免轮换 IP 就无限增加计算。清理过期 IP 记录，限制登录请求体大小。

```js
// 放在密码验证前，不能等失败后才登记。
if (!allowAttempt(loginAttempts, ip, 10, 15 * 60 * 1000)) {
  return res.status(429).json({ error: "登录尝试次数过多" })
}
if (loginKdfInflight >= 4) {
  return res.status(429).json({ error: "登录繁忙，请稍后重试" })
}
loginKdfInflight++
try {
  const valid = await verifyPanelPassword(submitted)
  // 继续已有成功/失败处理；额度不可被并发失败请求覆盖。
} finally {
  loginKdfInflight--
}
```

`loginKdfInflight` 是建议新增的进程级计数器。上限 4 为示例，应按宿主资源调整。只修改失败计数，不加全局计算预算，仍不足以防御多来源资源消耗。

**整改验收：** 从空记录开始的 24 个并发请求至少 14 个因额度被拒绝；实际执行 KDF 的并发数有界；顺序限流、成功登录和过期窗口均正常。

### [MED-03] 单 JS 下载与 ICQQ 头像 URL 缺少目标网络限制

**严重等级：** Medium。**漏洞类型：** SSRF（CWE-918）。

**影响组件：** 单 JS 直链安装、账号头像下载；Git 地址及下载代理也需一并加固。**涉及文件：** `src/plugin-management.js`、`src/server.js`；宿主直接依赖 `icqq/lib/client.js`、`icqq/lib/message/image.js`、`icqq/lib/internal/internal.js`。

**涉及函数 / 路由：** `downloadScript()`、POST `/api/plugins/install-script`、PATCH `/api/accounts/:id/profile`、`Client.setAvatar()`、`Image.fromWeb()`。**代码位置：** `src/plugin-management.js:125-138`；`src/server.js:1894-1907, 2106-2122`；已安装 ICQQ 的 `lib/client.js:324-325`、`lib/message/image.js:98-99, 160-175`、`lib/internal/internal.js:86-105`。

**漏洞描述：** JS 下载只检查协议为 HTTPS 和无 URL 凭据，没有 IP/域名/端口限制。头像入口也只检查 HTTPS 或 base64，随后把 URL 直接交给账号适配器；已安装 ICQQ 在 `Image.fromWeb()` 中通过 Axios 发起服务端请求。文件 MIME/语法/图片解码是在建立网络连接之后检查，不能阻止 SSRF。

**攻击前提：** 已持有面板管理员会话，并可以选择下载 URL；头像路径还要求对应账号的适配器支持 `setAvatar`。没有普通用户权限，不能称为“普通用户提升为管理员”。HTTPS 服务需满足正常 TLS 要求；不声称可以直接访问只提供 HTTP 的 metadata 服务。

**数据流：**

```text
管理员 body.url
↓
POST /api/plugins/install-script → downloadScript 仅检查 HTTPS / 凭据
↓
fetch(url, redirect: error) → 服务端网络连接

管理员 body.value（头像 URL）
↓
PATCH /api/accounts/:id/profile → protocol === https:
↓
account.setAvatar → ICQQ Image.fromWeb → axios.get(responseType: stream)
```

**利用方式 / 安全验证：**

```http
POST /api/plugins/install-script HTTP/1.1
Host: 127.0.0.1:<隔离面板端口>
Cookie: elia_panel_session=<隔离测试会话>
Content-Type: application/json

{"name":"audit.js","url":"https://127.0.0.1:<自建监听端口>/audit.js"}
```

本次对 `127.0.0.1`、`localhost`、十进制 `2130706433`、十六进制 `0x7f000001` 逐一验证，真实路由均连接到本次自建 TCP 监听。监听收到 TLS 数据后主动断开，因此 API 返回 500 是测试的预期结果，**连接已经发起，不能把 500 视为过滤成功**。

头像测试使用实际 `Client.prototype.setAvatar`，隔离账号和阻断真实 QQ 调用的桩；同样确认回环 TCP 连接，真实账号 API 调用次数为 0。对 `::1`、`0.0.0.0`、`10.0.0.1`、`169.254.169.254` 只验证 URL 进入下载函数的行为，替换 fetch，不访问这些目标；IPv6/真实内网/云 metadata 成功取数仍为 **Needs Verification**。

**相关 URL 分析：**

| URL 功能 | 检查与剩余风险 |
|---|---|
| JS 直链 | 已拒绝重定向、HTML、凭据、超限响应；未限制目标地址、端口和 DNS 解析结果 |
| 头像 | 面板只检查 HTTPS；ICQQ 使用 Axios 默认下载行为，没有面板级 DNS/IP 校验；外部 NapCat 等适配器的网络位置未验证 |
| Git HTTPS | `validateRemoteRepository` 拒绝常见字面 IP、端口、localhost、`.local`、凭据；未解析 DNS，`localhost.`、内部域名仍可通过；没有固定 Git redirect 策略 |
| HTTPS 前缀代理 | `gitTransport` 允许 `https://127.0.0.1:<port>` 作为前缀，绕过仓库原 URL 的公开域名意图；仅参数验证确认，未访问真实代理 |
| HTTP/SOCKS 代理 | 产品有明确使用本地代理的场景，不能把所有本地代理配置一概报告为漏洞；应由运维预设允许的代理地址，避免任意 body 地址变成网络跳板 |
| 调试图片/远程音频 | 返回浏览器使用的受限 http(s) URL，未由该归一化函数在服务端 fetch；不能把浏览器图片请求误报为服务端 SSRF |
| Next 开发代理 | 目标固定 `127.0.0.1:nextDevPort`，请求路径不控制上游主机；本身不是通用 SSRF，鉴权问题为 MED-01 |
| ksr 重启 / 公网地址 | ksr 固定回环和配置端口，并用 HMAC challenge；公网地址仅生成链接，非服务端抓取 |

**影响：** 管理员、窃取会话者或被诱导填写 URL 的管理员可以借宿主网络访问 HTTPS 回环/内网资源，带来探测、请求副作用和响应被安装为文件的风险。需要登录且该身份本来能安装代码，因此评级为 Medium；本次没有验证响应泄露、凭据转发或 SSRF → RCE。

**修复建议：** 建立所有下载功能共用的网络策略：先 WHATWG URL 归一化，限制协议、明确允许的主机/端口，解析全部 A/AAAA 地址，拒绝私有/回环/链路本地/未指定/保留地址及 IPv4-mapped IPv6；HTTP 客户端实际连接时固定已验证地址，同时保留原 Host/SNI 和证书校验，避免校验与连接二次 DNS 导致 Rebinding。跳转默认禁止；确需跳转时每一跳重新执行相同策略。

Git 不易在应用层可靠固定 DNS，应同时采取可信仓库域名 allowlist、`http.followRedirects=false`、代理 allowlist 和进程网络出口限制。限制代理必须显式保留经批准的本地代理能力。

推荐把头像远程 URL 在面板内按同一策略下载成有界 Buffer、校验图片 MIME/魔数，再传给适配器 base64/Buffer；不要继续让不同适配器自行决定目标网络。

```js
// 建议新增的统一客户端接口；不是当前仓库已有实现。
const { bytes, contentType } = await safeNetworkClient.download(url, {
  allowedHosts: approvedDownloadHosts,
  maxBytes: MAX_TEXT_BYTES,
  timeoutMs: 30_000,
  redirects: false,
})
// safeNetworkClient 必须实施解析结果校验与连接固定，不能只检查 URL 字符串。
```

**整改验收：** 上述真实回环测试不再产生 TCP 连接；IPv4 替代写法、IPv6 映射、内部 DNS、302 跳转和两阶段 DNS 变化均被拒绝；批准的公网下载和本地代理工作正常。

### [MED-04] 修改面板密码不撤销已有 HTTP / WebSocket 会话

**严重等级：** Medium。**漏洞类型：** 会话失效管理缺口（CWE-613）。

**影响组件：** 面板密码重设和会话存储。**涉及文件：** `elia.support.js`、`src/server.js`。

**涉及函数 / 路由：** `supportPanel().configInfo.setConfigData()`、PUT `/api/plugins/EliaAdminPanel/config`、`verifySessionToken()`、日志 WebSocket。**代码位置：** `elia.support.js:132-159`；`src/server.js:756-774, 791-836, 1519-1527, 2129-2133`。

**漏洞描述：** 密码重设只写入新盐和 PBKDF2 哈希；会话签名 Secret、`sessions` Map 和持久会话白名单不变。会话校验不关联凭据版本，因此已有会话固定 12 小时仍可使用，Bot 重启后也可恢复。Secret 轮换后重启能撤销旧签名，但密码轮换没有自动撤销机制。

**攻击前提：** 攻击者已得到旧 Cookie，或在旧密码失陷时已经登录。管理员随后通过密码重设尝试收回访问；不存在无 Cookie 的直接绕过。

**数据流：**

```text
管理员提交新 password
↓
setConfigData 写入新 passwordSalt / passwordHash
↓
旧会话仍保留原 sid、exp、签名 Secret 和服务端白名单
↓
旧 Cookie / 已建立日志 WS 的 verifySessionToken 继续成功
```

**利用方式 / 验证：** 隔离工作区登录取得 Cookie，调用以下路由重设随机密码，再用旧 Cookie 读取 `package.json`，仍返回 **200**；旧日志 WebSocket 发送 catchup 后仍收到日志。

```http
PUT /api/plugins/EliaAdminPanel/config HTTP/1.1
Host: 127.0.0.1:<隔离面板端口>
Cookie: elia_panel_session=<旧的隔离测试会话>
Content-Type: application/json

{"password":"<新生成的至少12字符隔离密码>"}
```

对照：显式注销旧会话后，旧 Cookie 返回 **401**，日志连接关闭码 **4401**，说明正常注销撤销机制确实生效，缺口在密码变更流程。

**影响：** 密码泄露后的恢复操作不能立即驱逐攻击者；攻击者继续拥有文件编辑、插件安装、主人消息调试等完整权限。不能把“新密码立即生效”当作“旧会话立即失效”。

**修复建议：** 密码与会话逻辑共享明确的认证状态服务，密码重设事务成功后撤销所有会话，持久化撤销状态，并立即关闭已关联的 WebSocket；要求发起变更的浏览器重新登录。也可以增加持久 `credentialVersion`，令牌与会话存储绑定该版本，验证时版本不符即拒绝。

同时处理“旧密码验证正在进行而密码已轮换”的竞态：验证完成时再次比较起始凭据版本，版本改变则不能签发新会话。会话存储写入失败应 fail closed，不能重启后复活旧会话。

```js
// 建议抽取到共享认证服务，供 Elia/Guoba 两个设置入口共同调用。
await authService.replacePasswordAndRevokeSessions(newPassword)
// 内部：原子保存新凭据版本 → 清空内存会话 → 持久撤销 → 关闭连接。
```

以上为建议接口，当前代码不存在 `authService`。Guoba 配置入口复用 `elia.support.js`，修复应同时覆盖 Guoba，而不只修一个 HTTP handler。

**整改验收：** 密码更改后，旧 HTTP 会话和旧 WS 立即失效，重启后也无效；旧密码的在途验证不能创建有效会话。

### [MED-05] 同名插件安装竞争时，失败请求删除成功安装结果

**严重等级：** Medium。**漏洞类型：** 竞态 / 资源所有权错误（CWE-362、CWE-367）。

**影响组件：** Git 插件安装。**涉及文件：** `src/server.js`。

**涉及函数 / 路由：** POST `/api/plugins/install`、`withPluginOperation()`。**代码位置：** `src/server.js:1660-1664, 2142-2155, 2193-2195`。

**漏洞描述：** 更新/禁用/依赖操作已有互斥，但新安装没有使用它。两个同名请求可以都通过 `fs.access(target)` 的“目录不存在”检查。一个成功创建并完成安装后，另一个 clone 失败，异常处理无条件递归删除相同 target；没有验证该目录是否由当前请求创建或正在被其他操作使用。

**攻击前提：** 已登录管理员，两个请求同时安装相同名称；管理员双击、多个浏览器或重试也可能触发。默认路径无特殊配置即可复现。

**数据流：**

```text
同名安装请求 A / B
↓
A、B 均在目录尚未出现时通过 fs.access
↓
A clone 完成并返回 200；B clone 因目标出现或其他原因失败
↓
B catch → fs.rm(target, recursive: true) → 删除 A 的成功结果
```

**利用方式 / 安全验证：** 诊断脚本对真实路由并发提交两个相同 body；模拟 Git 只在临时目录创建无副作用 `index.js`。精确控制两个 clone 完成顺序，A 返回 **200**、B 返回 **500**，成功插件目录最终 **不存在**。

```http
POST /api/plugins/install HTTP/1.1
Host: 127.0.0.1:<隔离面板端口>
Cookie: elia_panel_session=<隔离测试会话>
Content-Type: application/json

{"url":"https://example.com/audit.git","name":"race-fixture"}
```

该样例由模拟进程处理，没有克隆外部仓库或删除真实插件。它证明的是失败清理的所有权错误，不是仓库 URL 导致任意目录删除。

**影响：** 删除另一次成功安装的插件，引发插件缺失、配置/代码丢失及下次重启故障；没有证明可以通过目录名遍历删除工作区外路径。

**修复建议：**

1. 安装、更新、禁用、恢复以及涉及同一目录的依赖变更共用互斥。Windows 上将锁键规范化为小写，避免 `Example` 和 `example` 指向同一目录却使用不同锁。
2. 在锁内检查目标，并先 clone 到 `data/elia-admin-panel` 下随机创建的独立 staging 目录；完成入口和内容验证后再发布到最终目录。
3. 失败只清理当前请求拥有的 staging 目录；移除 catch 中对任意最终 target 的无条件删除。最终发布必须保留“目标已存在则拒绝”的语义。
4. pnpm 会修改共享 workspace/lockfile，还需要全局依赖安装锁；单插件锁不能隔离其他插件的 pnpm 安装。

```js
const key = process.platform === "win32" ? name.toLowerCase() : name
await withPluginOperation(key, async () => {
  // 检查 target；创建随机 staging；clone 到 staging；验证；拒绝覆盖后发布。
  // finally 只删除自己创建的 staging，绝不无条件 fs.rm(target)。
})
```

**整改验收：** 同名并发安装第二个请求返回 409，或安全等待后确认已有目标；第一个结果完整保留。对名称大小写、安装与恢复/禁用竞争也做回归。

## Low Findings

### [LOW-01] HTTPS 反向代理场景下会话 Cookie 仍缺少 Secure

**严重等级：** Low。**漏洞类型：** Cookie 传输保护缺失（CWE-614）。

**影响组件：** 会话 Cookie。**涉及文件：** `src/server.js`。

**涉及函数 / 路由：** `setSessionCookie()`、`clearSessionCookie()`、全部登录方式。**代码位置：** `src/server.js:791-799, 1734-1743`。

**漏洞描述：** Secure 完全依赖 `req.secure`。Express 自身通过 HTTP 监听，且没有设置可信反向代理，因此 TLS 在外部代理终止时，通常即使有 `X-Forwarded-Proto: https`，`req.secure` 仍为 false。浏览器得到不带 Secure 的管理员 Cookie。

**攻击前提：** 经 HTTPS 代理使用面板，并存在可访问同域 HTTP、主动网络降级或缺少 HTTPS/HSTS 强制策略的条件。默认纯本机 HTTP 场景本来不适合强制 Secure，此项主要影响 HTTPS 部署。

**数据流：**

```text
浏览器 HTTPS 登录 → TLS 终止代理通过 HTTP 转发
↓
Express 未信任该代理 → req.secure = false
↓
Set-Cookie 有 HttpOnly / SameSite=Strict，但无 Secure
```

**利用方式 / 验证：** 隔离登录请求附带 `X-Forwarded-Proto: https`，返回 200；Set-Cookie 仍无 Secure。仅验证属性缺口，没有嗅探真实用户 Cookie 或进行降级攻击。

**影响：** Cookie 可能在同站点 HTTP 请求中被发送；SameSite 和 HttpOnly 不提供传输加密。如果部署已经确保 HTTPS-only/HSTS，实际风险相应降低。

**修复建议：** 配置明确的 HTTPS Cookie 策略；只信任实际代理 IP/CIDR，而不是无条件 `trust proxy: true` 或直接相信任意 X-Forwarded-Proto。经公网 HTTPS 部署强制 Secure，在反向代理强制 HTTP→HTTPS 和适当 HSTS；本机开发模式单独允许不带 Secure。

```js
app.set("trust proxy", configuredTrustedProxyRanges)
// 必须由运维给出真实代理地址，避免客户端伪造转发头。
const secure = settings.requireHttpsCookie || req.secure
res.cookie("elia_panel_session", token, {
  httpOnly: true,
  sameSite: "strict",
  secure,
  path: "/",
  maxAge: SESSION_TTL_MS,
})
```

`configuredTrustedProxyRanges`、`requireHttpsCookie` 为建议新增配置。清 Cookie 必须使用相同属性。**整改验收：** 可信 HTTPS 代理路径产生 Secure Cookie，直接来自非可信来源的转发头不能影响安全判断，本机登录不回归。

### [LOW-02] 首次密码及一次性登录验证码进入持久日志

**严重等级：** Low。**漏洞类型：** 敏感信息日志泄露（CWE-532）。

**影响组件：** 首次密码、验证码登录、宿主日志。**涉及文件：** `src/server.js`；宿主 `lib/config/log.js`。

**涉及函数 / 路由：** `initializePassword()`、POST `/api/auth/code/request`、`safeLogger()`。**代码位置：** `src/server.js:99-105, 661-671, 1772-1779`；宿主 `lib/config/log.js:28-37, 49-52, 73-84`。

**漏洞描述：** 首次随机密码通过 `safeLogger("mark", ...)` 输出，验证码通过 `safeLogger("warn", ...)` 输出。实际宿主 logger 的 mark/warn 进入 command 文件 appender，所以“仅在 Bot 控制台显示一次”并不意味着不落盘。首次密码可能长期有效，一次性验证码在 5 分钟窗口内可用于登录。

**攻击前提：** 攻击者能读宿主日志文件、日志备份或第三方日志汇聚；对验证码还需处于有效期且未被消费。Web 日志接口本身需要管理员鉴权，**没有发现匿名读取日志进而登录的循环绕过**。

**数据流：**

```text
首次密码 / 服务端随机一次性验证码
↓
safeLogger → global.logger.mark / warn
↓
宿主 log4js command appender
↓
logs/command.<日期>.log 及其备份/汇聚
```

**利用方式 / 验证：** 只读检查确认当前 `logs/command.2026-09-27.log` 存在首次密码与验证码日志行；没有输出值、提交值、使用这些凭据或判断旧密码现在是否仍有效。另在临时目录使用真实宿主日志配置记录两个无敏感含义的标记，mark/warn 均实际落盘。

**影响：** 日志访问权限成为管理员凭据访问权限；长期密码的暴露窗口超过一次性验证码。现有日志中的验证码多数可能已经过期，不能把每条历史验证码都当成当前有效 Secret。

**修复建议：** 首次凭据通过受控初始化流程交付，避免调用持久日志渠道；例如交互式 TTY 初始化或专用受限管理通道。一次性验证码如果必须从控制台取，应与文件 appender 分离；同时注意 PM2/服务管理器会捕获 stdout，不能简单改成 `console.log` 就宣称不落盘。普通日志只记录“生成/消费”事件，不记录值。

对已有日志执行凭据暴露评估：仍有效的首次密码应轮换并撤销会话，日志备份/汇聚中的敏感行按保留策略处理；不要在代码修复时直接删除用户日志。

**整改验收：** 普通日志与 Web 日志中没有明文登录材料；初始化交付和验证码登录仍可使用；文档准确说明真实的日志捕获范围。

## Informational Findings

本节记录验证结论，不增加漏洞数量。

| 检查类别 | 结论与证据 |
|---|---|
| 未授权 / IDOR | 36 个业务方法/路由均拒绝无 Cookie 请求；系统没有普通面板角色，各登录方式均得到完整管理员会话。管理员读取其他 Bot 账号配置符合当前产品权限模型 |
| Token / Session | 固定 HMAC-SHA256、恒时签名比较、输入长度限制、exp 和 Map 精确匹配；随机 sid 32 字节，持久文件只存 SHA-256 摘要。篡改 Cookie 被拒绝；没有 JWT alg 选择面 |
| Session 固定 / 一次性码 | 登录总是生成新随机 sid；验证码与快捷码在签发前同步消费。两者第一次成功、再次使用 401，验证码响应不含码 |
| 注销 | HTTP 会话白名单删除并持久化；旧 Cookie 401，已登录日志 WS 在下一次消息复核后关闭 4401。定时复核间隔 15 秒，广播路径不逐包复核，存在至多定时窗口的撤销延迟，可进一步优化 |
| WS 握手 | `/api/logs/ws` 无 Cookie 401、外站 Origin 403、有 Cookie 101；不是握手后才鉴权 |
| WS 消息 | `maxPayload: 8192`；发送 8193 字节关闭 1009。消息 JSON 解析，类型只处理 subscribe/catchup，日志文件格式 allowlist，无命令解释器 |
| 路由变体 | `/API/...`、重复斜杠、尾斜杠未泄露数据；编码的 `/api%2f...`、`/%61pi/...` 在生产路径落入 HTML fallback，返回 200 是页面而非敏感 API JSON，没有认定为鉴权绕过 |
| 文件穿越 | `path.resolve + path.relative` 限制工作区，拒绝 `..` 逃逸和跨盘绝对路径；受保护目录按段检查，大小写变体也拒绝；临时目录 junction 403 |
| Windows 别名 | 尾随点/空格、猜测的 8.3 短名均未读到文件，当前运行环境返回 500；本机实际目录列表未显示该面板目录短名。不能据此报告已利用别名绕过；其他开启短名的卷仍应做回归 |
| 上传 | 禁止路径分隔符、控制字符、结尾点/空格、保留设备名；排他写入不覆盖同名文件。二进制上传是管理员功能，不能把允许 `.js` 上传本身当漏洞 |
| XSS / HTML | 日志使用 `{segment.text}` React 文本节点；调试消息、群名、昵称、插件标题也通过 JSX 文本渲染。未发现 innerHTML/dangerouslySetInnerHTML/v-html/document.write。实际 React 渲染将 `<img ...>` 转义 |
| 原型污染 | 后端 `Object.assign` 主要用于 Error 或服务端生成凭据，没有发现用户输入进入全局递归 merge。前端 `setNested` 的 `__proto__` 路径可改变新对象的原型，但没有污染全局 Object.prototype，未确认可利用链 |
| 命令注入 | Git 使用参数数组及严格名称/ref 检查，拒绝 `--...`、路径表达式等；Windows pnpm 的 Shell 参数由严格插件名与固定选项构成，依赖版本写 manifest，未拼入命令字符串。未发现用户输入进入 eval/Function/vm |
| 重启 | PM2 命令和配置路径固定；ksr 使用回环 challenge + HMAC，不把 Token 返回给前端；没有任意终端命令 API |
| SQL / NoSQL / Redis | 插件没有 SQL/ORM 查询；Redis 只读固定计数键，无用户输入拼接命令。不能把宿主 package.json 有 sequelize/sqlite3 当成面板 SQL 注入 |
| CORS / CSRF | 没有 wildcard/反射 CORS；业务和登录接口有 Origin host 比较，Cookie SameSite=Strict，已验证外站 Origin 被拒绝。缺少 Origin 的非浏览器请求仍需 Cookie；未确认普通业务 CSRF |
| 错误 / Header 注入 | 500 对浏览器返回通用错误，不返回堆栈；堆栈进入受限宿主日志。没有确认用户输入进入不受约束响应 Header 的 CRLF 注入 |
| 公网地址 / Redirect | 公网地址设置仅接受不含凭据/查询/路径的 http(s) 站点根地址；快捷码放在 fragment，前端使用后从地址栏删除；未发现公共 open redirect |
| 静态文件 | 生产 Express 只提供 out；没有把 ROOT/data/.git/node_modules 作为静态目录。默认静态 dotfile 行为和实际部署 symlink 仍需保持防护 |

## Dependency Risks

### 扫描方式与实际版本

插件没有自己的 lockfile，通过宿主 `pnpm-lock.yaml` 的 `plugins/EliaAdminPanel` importer 管理；宿主 lockfile 与已安装 `node_modules/.pnpm/lock.yaml` 同为 316054 字节。版本确认使用实际模块解析及包内 package.json，不能只看声明范围。

| 依赖 | 实际安装版本 | 本项目使用方式 |
|---|---|---|
| express | 5.2.1 | HTTP 路由、JSON/raw 解析、静态文件 |
| ws | 8.20.0 | 日志 WebSocket |
| yaml | 2.8.3 | 配置解析与保留注释编辑 |
| next | 16.3.6 | 静态构建；开启 devMode 时运行开发服务 |
| react / react-dom | 19.3.0 / 19.3.0 | 前端渲染 |
| icqq / oicq（宿主） | 0.6.10 / 2.3.1 | 账号和消息能力；头像路径到达 ICQQ 网络请求 |
| axios（ICQQ / OICQ） | 1.16.1 / 0.27.2 | 适配器下载；不是面板 fetch 的实现 |
| node-schedule（宿主） | 2.1.1 | Cron parser 定位 |
| log4js / pm2（宿主） | 6.9.1 / 6.0.14 | 持久日志 / 固定重启命令 |
| lodash（宿主） | 4.17.23 | loader 中的日常对象/字符串工具 |

先运行 `pnpm audit --json`，默认 npmmirror 没有实现安全审计 endpoint，返回 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`。随后仅对本次命令指定官方 registry，没有修改项目配置：

```powershell
pnpm audit --json --registry=https://registry.npmjs.org
```

扫描返回 75 条全 workspace 公告记录：Critical 1、High 40、Moderate 31、Low 3。**这包括其他插件和宿主依赖，不能称为该 WebUI 有 75 个漏洞。** 按实际依赖路径过滤，EliaAdminPanel 自身只有下列两条 ws 公告；其他依赖按相关调用路径复核。

### DEP-01：ws 碎片内存消耗 — 潜在风险 / Needs Verification

实际 `ws@8.20.0` 落在受影响范围；上游给出的修复版本为 8.21.0。安全公告说明，小碎片和小数据块的结构对象可能放大内存消耗。[ws 官方公告 GHSA-96hv-2xvq-fx4p](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p)。

可达路径是已鉴权 `/api/logs/ws` → ws Receiver。用实际 Receiver 输入 256 个一字节未结束碎片，确认保留 256 个 fragment Buffer；没有运行上游的无限发送/OOM PoC。项目 `maxPayload: 8 KiB` 是重要缓解，超过 8192 字节已被实测拒绝；因此**不能把上游面向默认载荷限制的 High 标签直接继承为本插件 High 漏洞**。实际进程资源耗尽在此配置下未证实。推荐仍升级到含该修复的受支持版本，并加每会话连接/消息频率和总连接上限。

### DEP-02：ws close TypedArray 未初始化内存 — 版本受影响，当前调用不可达

`ws@8.20.0` 在公告范围内，修复版本为 8.20.1。[ws 官方公告 GHSA-58qx-3vcg-4xpx](https://github.com/websockets/ws/security/advisories/GHSA-58qx-3vcg-4xpx)。触发点是把特定 TypedArray 传给 `websocket.close()` 的 reason；本插件调用 reason 为固定字符串，且没有将客户端输入转为 TypedArray 传入 close，因此**未确认项目内可达的信息泄露路径**。随 DEP-01 一起升级即可，不应另外宣称发现了 Bot 内存泄露。

### 宿主相关风险

| 包 / 已核实版本 | 扫描命中与调用路径判断 | 状态 / 建议 |
|---|---|---|
| Axios 1.16.1（ICQQ）、0.27.2（OICQ） | 扫描包含原型污染 gadget、代理/重定向、序列化等公告；头像可到达 GET 下载，但没有证明面板能污染全局原型、控制代理凭据或调用有缺陷的序列化方法。面板无 URL 网络策略的问题已独立记为 MED-03，不依赖这些 CVE | 潜在风险；核对适配器兼容性后升级。1.x 扫描相关公告给出 1.18.0 修复门槛，0.x 相关公告最高门槛为 0.33.0；不是保证这两个门槛修复所有未来问题 |
| follow-redirects 1.15.11（OICQ） | 扫描命中跨域重定向自定义认证头泄露；本次头像入口没有提交自定义认证头，未确认敏感 Header 泄露 | 潜在风险；审查适配器真实 Header 并升级 |
| lodash 4.17.23 | 命中 template imports 注入、unset/omit 路径问题；直接审查 loader/config 未发现此 WebUI 输入进入这些危险 API | 潜在风险；安排宿主升级与兼容回归 |
| PM2 6.0.14 / js-yaml 4.1.1 | 扫描命中 ReDoS、YAML 复杂度问题；面板只用固定 PM2 重启路径，没有将任意远程 YAML 传给该 parser | 潜在风险；固定配置自身可读写能力属于管理员权限，不能机械报告为远程注入 |
| PM2 的 systeminformation / basic-ftp 等 | 扫描命中 Linux 命令/FTP 问题；本机是 Windows，当前面板没有对应输入路径 | 未确认可达性；不计入确认漏洞 |
| 其他插件、sqlite3 构建链、Puppeteer 安装解压链 | audit 输出有其记录；本面板没有对应运行期解压或查询入口，其他插件业务超出本次范围 | 不计作 WebUI 运行期漏洞；宿主依赖维护另行处理 |

没有执行 `pnpm audit --fix`、安装升级、执行依赖生命周期脚本或更改 lockfile。依赖升级后的验收应重新解析实际安装版本，复查完整 importer 路径，并回归日志、构建和适配器头像功能。

## Secret Scan

检查插件全部 **29 个可见历史提交**（所有本地可见 refs）、**125 个唯一历史 Blob**、**41 个审计前已跟踪当前文件**，并复核当前配置、面板会话文件、**181 个生成的文本构建资源**中的典型 Secret 特征和相关宿主日志。构建资源未匹配到上述典型 Secret 特征。没有尝试恢复不可见远端历史或 unreachable Git 对象；启发式扫描不保证识别所有自定义格式的 Secret。

检查模式包括私钥 PEM/OpenSSH 标头、AWS/GitHub/OpenAI 等常见 Token 格式、Webhook 地址，以及 password/secret/token/api-key 的字面量赋值；候选结合用途人工分类，没有输出真实值。

| 类别 | 结果 |
|---|---|
| 当前源码 / 可见历史真实 Secret | 未发现已提交的真实密钥、静态管理员密码、JWT/Cookie Secret、私钥或真实 Webhook |
| 字面量候选 | 历史各版本的 `feishu_webhook: "飞书机器人 Webhook"` 和 `password: "Redis 密码"` 是界面字段说明；不是实际凭据 |
| 测试 / 文档 | 随机生成隔离密码、示例域名、代理样例、测试 Git 身份属于测试/占位信息，未作为 Secret 漏洞计数 |
| `data/elia-admin-panel/config.yaml` | 宿主未跟踪，位于插件仓库外；当前无明文 password，保存加盐哈希和随机 Secret；没有在报告中复制值 |
| `data/elia-admin-panel/sessions.json` | 宿主未跟踪，位于插件仓库外；代码保存 sid 摘要及到期时间，不能从摘要直接重放 Cookie |
| 宿主 YAML 配置 | 检查敏感字段用途与跟踪状态，未把字段名称或空值报告为泄露；管理员读取工作区配置是明确产品能力 |
| 持久日志 | 确认存在首次密码及验证码相关行，见 LOW-02；不公开值，不默认历史验证码仍有效 |

当前没有“发现已提交 Secret 必须清理 Git 历史”的确认结论。应添加持续 Secret 检查，并在日志整改时确认旧首次密码是否还有效，再决定凭据轮换与日志留存处理。

## Security Architecture Observations

### 1. 管理员等价于 Bot 进程控制者

所有成功登录都获得同一种完整管理员身份；源码编辑、插件安装、support 工厂动态 import、主人模拟消息和重启都是该角色的既有能力。没有独立低权限面板用户，也没有运行沙箱。恶意管理员借这些能力执行代码是设计边界，不是单独的权限绕过发现。部署应把面板 Cookie 当作宿主控制凭据，并以最小 OS 权限运行 Bot。未来加入只读/操作员角色时，必须在后端逐路由授权，不能只隐藏按钮。

`--ignore-scripts` 能跳过依赖生命周期脚本，但不会审查安装后由 Yunzai 加载的代码，也不等于整个包管理器执行环境沙箱。新增插件列表会加载 support 工厂，插件规则排查会实例化插件类，不能用于审查未经信任代码而假定无副作用。

### 2. 路径防护应统一覆盖所有文件操作

文件管理入口有工作区边界和逐段 lstat；配置 API `GET/PUT /api/config/:name` 未复用链接检查；`findPluginSupport()` 也未显式检查目录父链。动态 support 模块本来就是可信代码边界，现有配置目录未验证有恶意链接，所以**没有把这些差异计作已确认任意文件读写**。建议统一使用路径安全辅助函数：验证祖先链接，已有对象经 realpath 后重新检查 ROOT/保护目录边界，创建文件时验证真实父目录。

单纯 `lstat` 后再 `readFile/rename` 有 TOCTOU 窗口。是否可由低权限本地攻击者利用取决于目录 ACL、实际 symlink 创建权限和共享目录配置，**Needs Verification**。无需登录的远程调用者不能用 JSON 创建符号链接；不要把仅假设本地攻击者已能写宿主目录的场景当作默认远程 Critical。

管理员允许读取 `.env`、Yunzai YAML、package.json 和 pnpm-lock.yaml；这些位于工作区内且符合文本类型时可读，是产品用途。工作区外 SSH Key 路径被路径边界拒绝；部分无扩展名/PEM 文件同时不在类型 allowlist。保护目录、硬链接、短名及安全发布需要持续测试，不能只依赖字符串包含判断。

### 3. 并发控制与丢失更新

普通文件保存采用临时文件替换，面板配置文件带 0600 及排他临时文件；session 写入也排队。仍没有配置/普通文件的版本冲突检查；用户传来的 `baseContent` 只用于保留 YAML 格式，不会证明它是最新版本。两个管理员可覆盖对方更新，包括主人列表等权限配置。建议增加内容摘要/版本号和 `If-Match`，冲突返回 409/412；结合原子替换和资源锁，不把“原子写文件”误认为“原子读改写”。

### 4. 开发与生产必须有明确的网络边界

本机持久配置已经开启 devMode。MED-01 证明面板登录不能隔离 Next 内部开发接口；只有回环绑定且没有外部转发时，风险主要限于本机可访问者。当前没有核查真实代理、端口映射或防火墙，不能据此断言不存在外部访问。

非日志 Upgrade 路径会进入 Next；原始 Origin 改写也存在于 Upgrade。此次 HMR handshake 没有成功，应继续验证实际客户端需要的路径和 Next 版本协议，**不将其描述为已利用连接**。开发重启、launch-editor、inspector 的敏感行为基于实际依赖源码记录；没有在用户机器上执行这些操作或声称实现 RCE。

### 5. 请求/连接资源预算

现有界限包括 JSON 3 MB、单 JS/文本 1.5 MB、上传 20 MB、日志尾部 512 KiB、增量 2 MiB、WS 8 KiB、音频缓存 32 MB、转码 20 秒/输出 8 MB/每事件 3 次、Git/pnpm 超时和输出截断。这些机制实际降低 DoS 风险。

仍缺全局登录 KDF、Git/pnpm、FFmpeg、WebSocket 连接和并发上传预算；IP 限流 Map 没有周期清理，日志订阅重新创建 busy 状态也能增加并发读取。多数消耗接口需完整管理员权限，未进行破坏性压力测试，不能只因“没有全局 limit”就报告已确认 OOM。计划加并发队列/连接上限、过期 Map 清理和 WS bufferedAmount 背压。

前端规则测试调用 `new RegExp(...).test(testMessage)`，宿主调试链也执行第三方正则。可否 ReDoS 取决于实际安装规则，不在本面板内产生任意 regex API；没有运行灾难性正则导致 UI/Bot 卡死。建议高风险规则诊断用可终止 Worker，限制测试长度。

### 6. 前端安全加固

没有确认日志、昵称、群消息 Stored/DOM XSS。插件链接 `href={selected.link}` 来自已有 support，建议仍限制为 http(s)；React 的防 javascript URL 机制不能替代清晰策略。前端 `setNested/getNested` 应拒绝 `__proto__`、`constructor`、`prototype` 并使用 own-property 访问；目前仅复现新对象原型改变，没有全局污染链。

后端插件 actions 查找应先 `Object.hasOwn(actions, actionName)`，再验证函数，避免从原型链找到 `constructor` 等非显式操作；当前没有确认可利用的提权/命令执行链。

已有 X-Frame-Options=DENY、nosniff、no-store、Referrer-Policy。建议增加适配 Next/Monaco Worker 的 CSP（先 Report-Only）、`frame-ancestors 'none'`，并将 Origin 判断升级为配置允许的完整 origin（协议、主机、端口）。缺 CSP 本身没有被报告为 XSS。

### 7. 审计日志与敏感返回

500 堆栈不直接返回前端，但会进入宿主 error/command 日志；第三方库错误中可能包含下载 URL 或插件输出。需要脱敏而非仅屏蔽 HTTP 返回。建议独立记录高危操作的操作者会话摘要、目标、结果和时间，排除 Cookie、password、Secret、验证码和带凭据 URL。配置界面的密码输入掩码不意味着后端返回已脱敏；管理员配置读取权限应维持明确边界。

## Recommended Remediation Priority

**P0：立即处理的暴露面**

- 核对当前 devMode=true 是否经过代理/端口映射对外；生产或远程部署立即关闭开发模式/限制入口来源（MED-01）。没有证据要求因本报告无条件下线回环本机面板。
- 若旧首次密码已被非授权人员获取，轮换密码及 Secret、撤销会话，并核查日志备份访问权限（LOW-02、MED-04）；未确认泄露给外部时不要声称必须清理 Git 历史。

**P1：尽快修复代码缺口**

- 开发内部 HTTP/Upgrade 统一会话检查；验证原始 Origin（MED-01）。
- 在异步校验前预占登录额度，加全局 KDF 并发预算（MED-02）。
- 密码变更联动撤销持久会话和 WS，防止在途旧密码登录（MED-04）。
- 下载客户端统一 SSRF 策略，头像在面板安全下载后交给适配器（MED-03）。
- 安装共用规范化互斥锁，使用私有 staging，只清理自己拥有的目录（MED-05）。
- 在兼容性验证后升级 ws 至包含 8.21.0 修复的受支持版本，并更新/核对宿主 lockfile（DEP-01/02）。

**P2：计划修复部署与一致性问题**

- 可信代理范围、HTTPS Cookie 与 HTTPS-only 策略（LOW-01）。
- 凭据交付与普通持久日志分离，准确更新文档（LOW-02）。
- 统一配置/support 路径检查，增加真实路径与符号链接回归；配置保存版本冲突检查。
- 审查并升级相关 Axios/OICQ/ICQQ、lodash、PM2 依赖，按实际调用路径验证，不能只采用 audit 标签。
- 增加共享 pnpm 安装锁、全局进程/连接并发预算、限流缓存清理和日志推送背压。

**P3：安全加固**

- own-property action 分派、前端危险键拒绝、链接协议限制。
- CSP Report-Only 后收紧、完整 Origin allowlist、最小宿主权限。
- 持续 Secret 扫描及高危操作脱敏审计；如产品引入只读角色，同步后端逐路由授权。

## Conclusion

生产业务 API 和日志 WebSocket 的基础鉴权、密码哈希、令牌签名与路径限制已有有效实现；本次未确认未授权 RCE、数据库注入、跨工作区任意文件读写或前端日志 XSS。项目最主要的剩余问题集中在开发代理与生产权限边界、异步认证/安装的竞态、密码变更后的会话回收和 URL 下载网络边界。

上述 7 项发现均给出实际数据流和安全验证，管理员前提、默认配置差异和未证明影响已经明确。修复优先完成 MED-01/02/04，再落实下载策略、安装所有权和部署/日志加固；不能用一次依赖升级替代这些业务逻辑整改。

### 验证记录与复现入口

本次新增诊断脚本 `tests/security-audit.mjs`。它不是“现有漏洞必须永远存在”的测试：输出观察结果而不要求漏洞状态作为通过标准，便于整改前后比较。只在从 Yunzai 根目录执行时使用；所有业务写入均定位到随机临时工作区，真实 cfg/loader/Bot 被隔离，Git 模拟，网络只到自建回环监听。

```powershell
# 基础安全诊断：36 路由鉴权、登录/会话、SSRF、日志 WS、安装竞态等
node --experimental-vm-modules plugins/EliaAdminPanel/tests/security-audit.mjs

# 额外启动真实 Next dev：仅运行临时最小项目，验证开发代理
$env:PANEL_AUDIT_DEV = '1'
node --experimental-vm-modules plugins/EliaAdminPanel/tests/security-audit.mjs
Remove-Item Env:PANEL_AUDIT_DEV

# 原有针对代理、ref、依赖等的回归测试
node --test plugins/EliaAdminPanel/tests/plugin-management.test.js
```

基础诊断完成 **24 项观测**；开发模式诊断完成 **27 项观测**；原有测试 **7/7 通过**。React 转义采用实际渲染验证，未声称完成整套浏览器交互冒烟或公网部署验证。未进行真实重启、真实插件安装、恶意文件读取、OOM、暴力猜中口令或外部服务攻击。

测试过程中一次 HMR 等待被主动停止；该测试进程及其子进程已终止。自动审批拒绝删除遗留隔离目录 `D:\Dev\msys64\tmp\elia-security-audit-gIQHtu`（返回 `blocked by policy`），所以保留该目录，未绕过审批清理。其余正常完成的临时工作区由脚本清理；未触及真实 Bot 目录。
