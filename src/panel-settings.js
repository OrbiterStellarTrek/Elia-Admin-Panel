import crypto from "node:crypto"
import { readConfig, writeConfig, withConfigLock } from "./panel-config.js"
import { contentVersion, requireVersion, trustedProxy, withBudget } from "./security.js"
import { getCapApiEndpoint } from "../lib/cap-config.js"
import { validateDownloadProxy } from "./download-proxy.js"

const passwordIterations = 310_000
const defaultLoginImageApi = "https://t.alcy.cc/moe"

function createPasswordCredential(password) {
  return withBudget("password-kdf", 4, () => createPasswordCredentialUnbounded(password))
}
function createPasswordCredentialUnbounded(password) {
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

function validLoginImageApi(value) {
  if (typeof value !== "string" || value.length > 2048) return false
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

export function getPanelSettings() {
  return {
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
        bottomHelpMessage: "仅允许绑定回环地址；开发内部接口和 HMR 需要登录。生产或远程部署请关闭，修改后重启 Bot。",
        component: "Switch",
      },
      {
        field: "publicUrl",
        label: "公网访问地址",
        bottomHelpMessage: "主人快捷登录链接使用的站点根地址；可填写多个，每行一个或用逗号分隔，不要包含子路径。留空则根据监听地址生成。",
        component: "InputTextArea",
        componentProps: { rows: 3, placeholder: "https://bot.example.com" },
      },
      {
        field: "loginImageApi",
        label: "登录随机图 API",
        bottomHelpMessage: "登录页左侧随机图片接口，需直接返回图片或重定向到图片；仅允许 HTTP(S) 地址。",
        component: "Input",
        componentProps: { placeholder: defaultLoginImageApi, autocomplete: "url" },
      },
      { label: "登录安全", component: "SOFT_GROUP_BEGIN" },
      {
        field: "securityEntrance",
        label: "安全入口路径",
        bottomHelpMessage: "管理入口路径以普通文本显示。仅允许 1 至 256 个字母、数字、- 或 _。留空时回退到 SECURITY_ENTRANCE 环境变量；环境变量也未设置则关闭。修改后立即生效并撤销旧入口令牌。",
        component: "Input",
        componentProps: { placeholder: "留空表示关闭", autocomplete: "off" },
      },
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
        bottomHelpMessage: "留空表示不修改；至少 32 个 UTF-8 字节。保存后立即撤销所有旧会话和连接，Secret 不会回显。",
        component: "Input",
        componentProps: { type: "password", autocomplete: "new-password", placeholder: "留空表示保持不变" },
      },
      {
        field: "capServerUrl",
        label: "Cap 服务器地址",
        bottomHelpMessage: "填写 HTTPS 根地址，不要包含 Site Key 或路径；留空时读取 CAP_SERVER_URL 环境变量。",
        component: "Input",
        componentProps: { placeholder: "https://captcha.example.com", autocomplete: "url" },
      },
      {
        field: "capSiteKey",
        label: "Cap Site Key",
        bottomHelpMessage: "公开站点密钥；留空时读取 CAP_SITE_KEY 环境变量。服务器地址和 Site Key 配置后立即生效。",
        component: "Input",
        componentProps: { placeholder: "Site Key", autocomplete: "off" },
      },
      {
        field: "capSecretKey",
        label: "Cap Secret Key",
        bottomHelpMessage: "留空表示不修改；私钥以明文保存到 data/elia-admin-panel/config.yaml，读取时不会回显，保存后立即生效。",
        component: "Input",
        componentProps: { type: "password", autocomplete: "new-password", placeholder: "留空表示保持不变" },
      },
      { field: "cookieSecure", label: "始终使用 HTTPS Cookie", component: "Switch", bottomHelpMessage: "公网部署建议启用；启用后 HTTP 无法保持登录。本机 HTTP 开发可关闭。" },
      { label: "代理设置", component: "SOFT_GROUP_BEGIN" },
      { field: "downloadProxyMode", label: "下载代理类型", component: "Select", componentProps: { options: [
        { label: "不使用代理", value: "none" },
        { label: "常规 HTTP / SOCKS 代理", value: "standard" },
        { label: "HTTPS 链接前缀代理", value: "prefix" },
      ] }, bottomHelpMessage: "统一用于插件安装、插件更新、小插件直链下载和面板前端下载。保存后立即生效。" },
      { field: "downloadProxyUrl", label: "下载代理地址", component: "Input", componentProps: { placeholder: "http://127.0.0.1:7890 或 https://gh-proxy.com" }, bottomHelpMessage: "常规代理支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H，必须使用固定 IP 的根地址，不含账号密码。链接前缀代理需支持目标下载地址及 GitHub API。" },
      { field: "trustedProxies", label: "可信反向代理 IP/CIDR", component: "InputTextArea", bottomHelpMessage: "每行一个，仅这些来源可通过 X-Forwarded-Proto 声明 HTTPS。用于面板入站访问，与下载代理独立。默认不信任任何代理。" },
    ],
    async getConfigData() {
      const config = await readConfig()
      return {
        host: config.host || "127.0.0.1",
        port: config.port || 50882,
        devMode: config.devMode === true,
        publicUrl: config.publicUrl || "",
        loginImageApi: config.loginImageApi || defaultLoginImageApi,
        securityEntrance: config.securityEntrance || process.env.SECURITY_ENTRANCE || "",
        password: "",
        secret: "",
        capServerUrl: config.capServerUrl || process.env.CAP_SERVER_URL || "",
        capSiteKey: config.capSiteKey || process.env.CAP_SITE_KEY || "",
        capSecretKey: "",
        trustedProxies: (config.trustedProxies || []).join("\n"),
        cookieSecure: config.cookieSecure === true,
        downloadProxyMode: config.downloadProxyMode || "none",
        downloadProxyUrl: config.downloadProxyUrl || "",
        _version: contentVersion(JSON.stringify(config)),
      }
    },
    async setConfigData(data, { Result }) {
      return withConfigLock(async () => {
      const current = await readConfig()
      requireVersion(data._version, contentVersion(JSON.stringify(current)))
      const host = String(data.host ?? current.host ?? "127.0.0.1").trim()
      const port = Number(data.port ?? current.port ?? 50882)
      const devMode = data.devMode === undefined ? current.devMode === true : data.devMode === true
      const publicUrl = String(data.publicUrl ?? current.publicUrl ?? "").trim()
      const loginImageApi = String(data.loginImageApi ?? current.loginImageApi ?? defaultLoginImageApi).trim() || defaultLoginImageApi
      const securityEntrance = String(data.securityEntrance ?? current.securityEntrance ?? process.env.SECURITY_ENTRANCE ?? "").trim()
      const password = String(data.password ?? "")
      const secret = String(data.secret ?? "")
      const capServerUrl = String(data.capServerUrl ?? current.capServerUrl ?? process.env.CAP_SERVER_URL ?? "").trim()
      const capSiteKey = String(data.capSiteKey ?? current.capSiteKey ?? process.env.CAP_SITE_KEY ?? "").trim()
      const capSecretKey = String(data.capSecretKey ?? "").trim()
      const downloadProxyMode = data.downloadProxyMode ?? current.downloadProxyMode ?? "none"
      const downloadProxyUrl = String(data.downloadProxyUrl ?? current.downloadProxyUrl ?? "").trim()
      try { validateDownloadProxy(downloadProxyMode, downloadProxyUrl) }
      catch (error) { return Result.error(error.message) }

      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return Result.error("监听地址或端口无效")
      if (publicUrl && !validatePublicUrls(publicUrl)) return Result.error("公网访问地址必须是 http(s) 站点根地址，不能包含子路径、查询参数或凭据")
      if (!validLoginImageApi(loginImageApi)) return Result.error("登录随机图 API 必须是有效的 HTTP(S) 地址，且不能包含凭据")
      if (securityEntrance && !/^[A-Za-z0-9_-]{1,256}$/.test(securityEntrance)) return Result.error("安全入口路径仅允许 1 至 256 个字母、数字、- 或 _")
      if (password && password.length < 12) return Result.error("面板密码至少需要 12 个字符")
      if (password.length > 1024) return Result.error("面板密码不能超过 1024 个字符")
      if (secret && Buffer.byteLength(secret, "utf8") < 32) return Result.error("浏览器会话 Secret 至少需要 32 个 UTF-8 字节")
      if (capSecretKey.length > 4096) return Result.error("Cap Secret Key 不能超过 4096 个字符")
      if ((capServerUrl || capSiteKey) && !getCapApiEndpoint({ capServerUrl, capSiteKey }, {})) return Result.error("Cap 需要有效的 HTTPS 根地址和仅含字母、数字、_ 或 - 的 Site Key")
      if (devMode && !["127.0.0.1", "::1", "localhost"].includes(host)) return Result.error("开发模式仅允许绑定回环地址")
      const trustedProxies = data.trustedProxies === undefined ? current.trustedProxies || [] : String(data.trustedProxies).split(/[,\r\n]+/).map(value => value.trim()).filter(Boolean)
      if (trustedProxies.some(entry => !trustedProxy(entry.split("/")[0], [entry]))) return Result.error("可信代理必须填写有效 IP 或 CIDR")

      const next = { ...current, host, port, devMode, publicUrl, loginImageApi, securityEntrance, trustedProxies, downloadProxyMode, downloadProxyUrl, cookieSecure: data.cookieSecure === undefined ? current.cookieSecure === true : data.cookieSecure === true }
      delete next.password
      if (password) Object.assign(next, await createPasswordCredential(password))
      if (secret) next.secret = secret
      if (capServerUrl) next.capServerUrl = capServerUrl
      else delete next.capServerUrl
      if (capSiteKey) next.capSiteKey = capSiteKey
      else delete next.capSiteKey
      if (capSecretKey) next.capSecretKey = capSecretKey
      await writeConfig(next)

      const notes = []
      if (downloadProxyMode !== (current.downloadProxyMode || "none") || downloadProxyUrl !== (current.downloadProxyUrl || "")) notes.push("统一下载代理立即生效")
      if (password) notes.push("新密码立即生效，已撤销全部旧会话和连接")
      if (secret) notes.push("新 Secret 立即生效，已撤销全部旧会话和连接")
      if (host !== String(current.host || "127.0.0.1").trim() || port !== Number(current.port || 50882)) notes.push("监听地址和端口需重启 Bot 后生效")
      if (devMode !== (current.devMode === true)) notes.push("开发模式需重启 Bot 后生效")
      if (publicUrl !== String(current.publicUrl || "").trim()) notes.push("公网访问地址立即用于主人快捷登录链接")
      if (loginImageApi !== String(current.loginImageApi || defaultLoginImageApi).trim()) notes.push("登录随机图 API 立即生效")
      if (securityEntrance !== String(current.securityEntrance || "").trim()) notes.push("安全入口立即生效，旧入口令牌已撤销")
      if (capServerUrl !== String(current.capServerUrl || process.env.CAP_SERVER_URL || "").trim() || capSiteKey !== String(current.capSiteKey || process.env.CAP_SITE_KEY || "").trim()) notes.push("Cap 站点配置已保存并立即生效")
      if (capSecretKey) notes.push("Cap Secret Key 已保存并立即生效")
      return Result.ok({}, `配置已保存；${notes.join("；") || "没有需要立即生效的变更"}`)
      })
    },
  }
}
