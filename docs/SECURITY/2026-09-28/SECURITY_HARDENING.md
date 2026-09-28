# 安全加固记录

日期：2026-09-28。对应 `SECURITY_TODO.md`；`SECURITY_AUDIT_REPORT.md` 保留整改前基准，不把其历史观察改写成当前结果。

## 已完成

| 项目 | 修复与验证 |
| --- | --- |
| MED-01 | Next 登录文档与必要构建资源可公开，内部开发 HTTP、RSC、源码映射、HMR 需要会话；改写前检查原始 Origin。拒绝开发模式绑定非回环地址。真实 Next 16.3.6 的 `/_next/hmr` 完成 101 握手，未登录 401、外站 403，正常开发配置 POST 返回 204，注销后 HMR 断开。 |
| MED-02 | 密码登录在首次 await 前预占额度；全局 KDF 上限 4。成功登录只退回自己的额度，不清空其他并发失败。24 次同源并发测试：不超过 4 次进入校验，限流计数累计 10，其余返回 429。 |
| MED-03 | JS/头像使用统一 HTTPS 客户端；标准端口、全部 DNS 地址校验、已校验 IP 固定、禁止自动环境代理；头像每跳复核，JS 拒绝重定向。Git 直连和前缀代理固定 DNS 并禁止重定向；常规代理要求 YAML 精确批准的固定 IP。回环/内网/替代 IP 和混合 A/AAAA 在连接前被拒绝。头像先下载成 base64，适配器不再接收用户 URL。 |
| MED-04 | Elia/Guoba 共用配置存储、写入锁与变更事件。凭据版本随持久会话保存；轮换立即撤销 HTTP、日志 WS、HMR、快捷码和验证码，旧版本登录不能签发新会话。无运行面板时，保存凭据同样清空磁盘会话；重启载入仍检查版本。 |
| MED-05 | 安装/更新/禁用/恢复以及单 JS 安装共用大小写规范化目录锁，拒绝 Windows 尾点/保留名。Git clone 进入随机私有 staging，发布前检查目标存在性；失败只清理自己创建的 staging，不删除已发布插件。 |
| DEP-01/02 | 面板及宿主直接 `ws` 依赖升级到 8.22.0，更新宿主 workspace lockfile 和实际安装；日志握手、8 KiB 载荷、会话回收完成回归。其他插件的独立旧 ws 不在此升级中。 |
| LOW-01 | 明确信任代理 IP/CIDR；只有可信来源的精确 `X-Forwarded-Proto: https` 可触发 Secure，也可启用始终 Secure。Origin 采用已配置公网地址和监听地址构成的完整允许列表，不反射任意 Host。 |
| LOW-02 | 首次密码/验证码通过受保护本机文件交付，普通 logger/stdout 不含值；消费后删除，验证码到期定期清理，避免 PM2 stdout 捕获泄露。 |
| 文件与保存 | 配置、support 父链、文件管理统一逐段 lstat/realpath；拒绝链接、硬链接、保护目录、Windows 别名。配置/文件/依赖/support 保存增加摘要和锁，冲突 409、缺版本 428；提交前复核文件版本和路径，YAML 注释保留。 |
| 资源预算 | 子进程 4、FFmpeg 2、下载 4、上传 2、WS 总计 32/单会话 4。面板 pnpm 安装共用 workspace 锁。限流表上限 4096 并定期清理；WS 消息每 10 秒 30 次，超过 1 MiB 待发量关闭慢客户端，日志读取忙状态固定到 socket。 |
| 前端与审计 | action 使用 Object.hasOwn；嵌套赋值拒绝危险键、读取只访问 own 属性；插件链接只允许无凭据 http(s)。新增 CSP Report-Only、脱敏操作审计 JSONL（4 MiB 轮转，保留一份），新增 CI 回归/Secret/依赖检查。 |

依赖修复范围依据 [ws 上游公告](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p)。Git 地址固定使用 [官方 http.curloptResolve 配置](https://git-scm.com/docs/git-config#Documentation/git-config.txt-httpcurloptResolve)。

## 本机整改

- 已将持久配置 `devMode` 设为 false；需重新启动 Bot 才加载新服务代码和生产模式。
- 已收紧 `data/elia-admin-panel` Windows ACL，确认 config 文件继承权限仅为当前账号、Administrators、SYSTEM。其他运行账号需显式授权后再启动。
- 对历史日志中的首次密码做哈希比对，未匹配当前凭据，故保持当前密码；未输出明文，未删除历史日志或备份。
- 检查时未发现 50882 监听和 Windows portproxy 规则；这不能证明不存在其他端口、外部代理、路由器映射或云端入口。上述边界仍由运维确认。
- 根目录 `pnpm-lock.yaml` 原本未被宿主 Git 跟踪；本机已更新实际文件，部署时需携带同一 lockfile，不能仅依赖插件 package.json。

## 验证入口

本次最终结果：开启真实 Next 验收时 27 项测试全部通过，TypeScript 类型检查、生产静态构建、Secret 检查和插件相对 HEAD 的 diff 空白检查均通过。

在 Yunzai 根目录执行：

```powershell
pnpm --filter elia-admin-panel test
pnpm --filter elia-admin-panel typecheck
pnpm --filter elia-admin-panel build
node plugins/EliaAdminPanel/scripts/check-secrets.mjs
$env:PANEL_SECURITY_DEV = '1'
node --experimental-vm-modules --test plugins/EliaAdminPanel/tests/security-regression.test.js
Remove-Item Env:PANEL_SECURITY_DEV
```

测试全部业务写入使用临时工作区，Bot/cfg/loader 与业务子进程被隔离；回环探针仅连接测试创建的监听，Git 使用模拟进程。原有 Git 回归使用真实临时仓库。Next 开发验收只启动最小临时项目，不调用编辑器、inspector 或开发重启接口。`tests/security-audit.mjs` 是整改前诊断快照，不再作为当前验收入口。

## 尚未完成的部署与共享依赖事项

- CSP 目前为 Report-Only；还需在实际 Next/Monaco 浏览器工作流收集违规，再收紧为强制策略。未声称完成浏览器全部交互验收。
- 文件提交前复核缩小 TOCTOU 窗口；不构成对拥有 workspace 写权限的本地攻击者的完全防护。宿主工作区 ACL、低权限服务账号、外部代理和日志备份留存需运维落实。
- 获批 HTTP/SOCKS 代理会解析远端地址，属于明示可信边界；固定远端 DNS 的保障适用于直连与 HTTPS 前缀代理。代理侧仍须执行目的地址和重定向限制。
- 对整个 workspace 重新执行官方 registry audit，并区分面板 importer 与宿主/其他插件路径。当前面板 importer 未命中公告；宿主 ICQQ/OICQ 的 Axios、follow-redirects、lodash、PM2/js-yaml 和其他插件 ws 仍有公告。头像已不经过这些 Axios 的 URL 下载路径；模板、YAML、PM2 相关公告不能据此认定面板确认 RCE。共享依赖升级仍需 Bot/适配器兼容验证，未批量 override 或强行升级主版本。
- CI 工作流已加入源码，尚未在远端运行；启发式 Secret 扫描不能保证发现所有自定义凭据。
- Elia HTTP 配置接口强制校验版本；本次 Guoba 工厂验证携带 `_version` 完成校验。旧 Guoba UI 若丢弃这个未知字段，仍有共享写锁与会话撤销，但不能保证发现两个旧表单的顺序覆盖；实际 Guoba UI 的版本字段保留情况尚未验证。
