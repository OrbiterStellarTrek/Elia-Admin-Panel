# 安全整改清单

对应 [安全审计报告](SECURITY_AUDIT_REPORT.md)。基准：`636f07d`，2026-09-28。按 P0 → P3 处理，括号内为报告编号。

2026-09-28 整改状态与验证边界见 [安全加固记录](SECURITY_HARDENING.md)。勾选表示本次已实现并有本机验证；部署和共享依赖事项单独保留。

## P0：立即处理

- [x] 当前持久配置已关闭 `devMode`，服务拒绝开发模式绑定非回环地址；已检查本机 50882 和 Windows portproxy。（MED-01）
- [x] 历史日志中的首次密码不匹配当前凭据；保留现有密码和历史日志。面板数据目录 Windows ACL 已收紧，后续凭据不再写普通日志。（LOW-02、MED-04）
- [ ] 运维确认其他端口/外部代理/路由器映射，以及日志备份访问权限和留存策略；重新启动 Bot 加载本次代码。

## P1：尽快修复

- [x] Next 内部开发 HTTP/Upgrade 校验会话和原始 Origin；真实 Next 的 `/_next/hmr` 握手 101，未登录 401，外站 403，注销断开。（MED-01）
- [x] 密码验证第一次 await 前预占额度，全局 KDF 上限 4；24 个同源并发请求被限流，计数累计 10 而不覆盖。（MED-02）
- [x] Elia/Guoba 共用凭据事件、磁盘撤销和版本检查；旧 Cookie、旧 WS、重新载入的旧会话和旧凭据签发均被拒绝。（MED-04）
- [x] JS/头像/Git/前缀代理统一网络策略：HTTPS/端口、全部 DNS、公网地址、连接固定、重定向限制；常规代理仅接受运维批准的固定 IP，代理侧限制属于可信边界。（MED-03）
- [x] 安装/更新/禁用/恢复/单 JS 安装共用规范化锁；clone 到随机 staging，失败只清理自身 staging。大小写竞争和成功结果保留完成回归。（MED-05）
- [x] 面板及宿主直接 ws 升级至 8.22.0，同步本机宿主 lockfile；实际解析和日志 WS 回归通过。宿主 lockfile 原本未跟踪，部署需携带。（DEP-01、DEP-02）

## P2：计划修复

- [x] 可信代理 IP/CIDR、HTTPS Secure/始终 Secure 策略，未信任转发头不生效，本机 HTTP 保持兼容。（LOW-01）
- [x] 首次密码/验证码交付到本机受保护文件，普通 logger/stdout 不含值；前端与 README 已同步。（LOW-02）
- [x] 配置/support 统一真实路径、父链与保护目录校验；拒绝 symlink/junction、硬链接及 Windows 别名，提交前复核路径。
- [ ] 运维落实 workspace ACL/最小宿主权限，并在实际部署验证本地 TOCTOU 边界；路径复核不等于彻底消除 TOCTOU。
- [x] 配置/文件/依赖/support 保存使用摘要和资源锁，旧版本返回 409、缺版本返回 428；前端适配，YAML 注释回归通过。
- [x] 面板内 pnpm 安装共用 workspace 锁；设置子进程/FFmpeg/下载/上传/WS 预算，定期清理限流 Map，日志推送背压完成回归。
- [ ] 复核 ICQQ/OICQ 的 Axios、follow-redirects、lodash、PM2 相关依赖公告与调用可达性，升级并做兼容回归；潜在风险不能直接作为确认 RCE/泄露结论。

## P3：安全加固

- [x] action 使用 Object.hasOwn；前端危险键与原型读取被拒绝，链接仅允许无凭据 http(s)，回归通过。
- [x] CSP Report-Only 与完整 Origin allowlist 已加入，保留 frame-ancestors/DENY/nosniff。
- [ ] 在真实 Next/Monaco 浏览器工作流观察 CSP 后收紧为强制策略。
- [x] 写操作记录脱敏审计 JSONL，排除请求体/Cookie/凭据；CI 加入安全回归、Secret 和依赖扫描。远端 CI 尚未运行。
- [ ] Bot 最小权限与未来低权限角色的后端逐路由授权属于部署/后续功能事项。
- [x] 新增隔离修复回归，覆盖 36 业务路由、WS/轮换/注销、真实 Next/HMR、下载、安装竞态与保存冲突。原诊断脚本保留为整改前基准。
