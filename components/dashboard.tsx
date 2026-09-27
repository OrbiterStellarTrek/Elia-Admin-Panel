"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, Bot, Braces, Check, ChevronDown, ChevronLeft,
  ChevronRight, CircleHelp, Clock3, Command, Cpu, Database, FileCode2, FileCog,
  FileText, Folder, Gauge, Github, HardDrive, KeyRound, LayoutDashboard, LoaderCircle,
  LogOut, Menu, MessageSquareText, Monitor, Pencil, Plug, Plus, RefreshCw, Search,
  Server, Settings2, ShieldCheck, Sparkles, TerminalSquare, Upload, Users, X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

type Section = "overview" | "config" | "plugins" | "files" | "logs"
type Notice = { kind: "success" | "error" | "info"; message: string } | null
type Api = (url: string, init?: RequestInit) => Promise<any>

const navigation: { id: Section; label: string; description: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "运行概览", description: "运行状态、资源与快捷操作", icon: LayoutDashboard },
  { id: "config", label: "配置中心", description: "系统、群组与运行配置", icon: Settings2 },
  { id: "plugins", label: "插件控制", description: "兼容 Guoba 配置与操作", icon: Plug },
  { id: "files", label: "文件管理", description: "浏览并编辑工作区文本文件", icon: FileCode2 },
  { id: "logs", label: "运行日志", description: "查看近期 Bot 日志", icon: TerminalSquare },
]

const configFileLabels: Record<string, string> = {
  "bot.yaml": "机器人设置",
  "db.yaml": "数据库设置",
  "group.yaml": "群组设置",
  "notice.yaml": "通知设置",
  "other.yaml": "其他设置",
  "qq.yaml": "QQ 账号设置",
  "redis.yaml": "Redis 设置",
  "renderer.yaml": "渲染服务设置",
}

const configFieldLabels: Record<string, string> = {
  log_level: "日志等级",
  ignore_self: "过滤机器人自身消息",
  resend: "风控时尝试分片发送",
  sendmsg_error: "发送失败时通知主人",
  restart_port: "重启接口端口",
  ffmpeg_path: "FFmpeg 路径",
  ffprobe_path: "FFprobe 路径",
  chromium_path: "Chromium 路径",
  puppeteer_ws: "Puppeteer 连接地址",
  puppeteer_timeout: "Puppeteer 超时时间",
  proxyAddress: "代理地址",
  online_msg: "上线通知内容",
  online_msg_exp: "上线通知匹配规则",
  skip_login: "跳过自动登录",
  serial_load: "按顺序加载插件",
  sign_api_addr: "签名服务地址",
  ver: "协议版本",
  slider_ticket_addr: "滑块验证 Ticket 地址",
  dialect: "数据库类型",
  storage: "存储路径",
  logging: "记录 SQL 日志",
  groupGlobalCD: "群全局冷却时间",
  singleCD: "单人冷却时间",
  isInheritDefault: "继承默认群组配置",
  disable: "禁用列表",
  onlyReplyAt: "仅响应 @ 消息",
  botAlias: "机器人别名",
  ignoreOtherBotAt: "忽略对其他机器人的 @",
  otherBotQQ: "其他机器人 QQ 号",
  imgAddLimit: "图片添加频率限制",
  imgMaxSize: "图片最大体积",
  addPrivate: "允许私聊配置",
  enable: "启用列表",
  iyuu: "IYUU 推送密钥",
  sct: "Server 酱 SendKey",
  feishu_webhook: "飞书机器人 Webhook",
  autoFriend: "自动处理好友申请",
  autoQuit: "自动退群",
  masterQQ: "主人 QQ 号",
  disableGuildMsg: "禁用频道消息",
  disablePrivate: "禁用私聊消息",
  disableMsg: "禁用消息规则",
  disableAdopt: "禁用群组接入",
  whiteGroup: "群组白名单",
  whiteQQ: "用户白名单",
  blackGroup: "群组黑名单",
  blackQQ: "用户黑名单",
  qq: "QQ 账号",
  pwd: "登录密码",
  platform: "登录平台",
  path: "数据路径",
  host: "Redis 主机地址",
  port: "Redis 端口",
  username: "Redis 用户名",
  password: "Redis 密码",
  db: "Redis 数据库编号",
  name: "渲染引擎名称",
}

function configFileLabel(file: string) {
  return configFileLabels[file] || file
}

function configFieldLabel(name: string) {
  if (name === "default") return "默认群组配置"
  if (/^\d{5,}$/.test(name)) return `群组 ${name}`
  return configFieldLabels[name] || name.replace(/([A-Z])/g, " $1").replace(/[_-]/g, " ")
}

async function request(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...init.headers },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith("/api/auth/")) {
      window.dispatchEvent(new Event("panel:auth-expired"))
    }
    const error = new Error(body.error || `请求失败 (${response.status})`)
    ;(error as any).status = response.status
    throw error
  }
  return body
}

function formatBytes(value = 0) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return [days ? `${days} 天` : "", `${hours} 小时`, `${minutes} 分钟`].filter(Boolean).join(" ")
}

function ErrorState({ message }: { message: string }) {
  return <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"><CircleHelp className="mt-0.5 size-4 shrink-0" />{message}</div>
}

function Login({ onLogin, initialError = "" }: { onLogin: (expiresAt: number) => void; initialError?: string }) {
  const [mode, setMode] = useState<"code" | "password">("code")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const [expiresAt, setExpiresAt] = useState(0)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (!expiresAt) return
    const update = () => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])

  async function requestCode() {
    setBusy(true)
    setError("")
    try {
      const result = await request("/api/auth/code/request", { method: "POST", body: "{}" })
      setExpiresAt(Date.now() + result.expiresIn * 1000)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      let session: any
      if (mode === "code") {
        session = await request("/api/auth/code/check", { method: "POST", body: JSON.stringify({ code }) })
      } else {
        session = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) })
      }
      onLogin(session.expiresAt)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(ellipse_at_top_left,_#e7e9ff_0,_transparent_42%),radial-gradient(ellipse_at_bottom_right,_#e9f4fa_0,_transparent_42%)] px-5 py-12">
      <Card className="w-full max-w-[430px] overflow-hidden border-white/70 shadow-[0_30px_100px_-42px_rgba(58,67,150,.35)]">
        <div className="h-2 bg-gradient-to-r from-indigo-500 via-violet-400 to-sky-300" />
        <CardHeader className="px-8 pt-9">
          <div className="mb-4 grid size-12 place-items-center overflow-hidden rounded-2xl bg-indigo-50 p-1"><img src="/elia.png" alt="EliaAdminPanel" className="size-full object-contain" /></div>
          <CardTitle className="text-2xl">EliaAdminPanel</CardTitle>
          <CardDescription>登录以管理 Bot 配置、插件与工作区文件</CardDescription>
        </CardHeader>
        <CardContent className="px-8 pb-8">
          <div role="tablist" aria-label="登录方式" className="mb-5 grid grid-cols-2 rounded-xl bg-slate-100 p-1">
            <button type="button" role="tab" aria-selected={mode === "code"} onClick={() => { setMode("code"); setError("") }} className={`rounded-lg px-3 py-2 text-sm font-medium transition ${mode === "code" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>验证码登录</button>
            <button type="button" role="tab" aria-selected={mode === "password"} onClick={() => { setMode("password"); setError("") }} className={`rounded-lg px-3 py-2 text-sm font-medium transition ${mode === "password" ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}>面板密码</button>
          </div>
          <form onSubmit={submit} className="space-y-4">
            {mode === "code" ? <>
              <div className="space-y-2"><Label htmlFor="panel-code">登录验证码</Label><Input autoFocus id="panel-code" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.trim())} placeholder="从 Bot 控制台日志中复制验证码" /></div>
              <Button type="button" variant="outline" className="w-full" disabled={busy || remaining > 0} onClick={requestCode}>
                {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                {remaining > 0 ? `验证码已输出到 Bot 日志（${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}）` : "获取验证码"}
              </Button>
              <p className="text-xs leading-5 text-muted-foreground">点击获取后，到运行 Bot 的控制台查看验证码。验证码 5 分钟有效且只能使用一次。</p>
            </> : <div className="space-y-2"><Label htmlFor="panel-password">面板密码</Label><Input autoFocus id="panel-password" type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} placeholder="首次启动生成的密码或 YUNZAI_PANEL_PASSWORD" /></div>}
            {error && <ErrorState message={error} />}
            <Button className="w-full" disabled={busy || (mode === "code" ? !code : !password)}>{busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}进入控制台</Button>
          </form>
          <div className="mt-5 space-y-2 border-t pt-4 text-xs leading-5 text-muted-foreground">
            <p>主人也可私聊 Bot 发送 <code className="rounded bg-muted px-1.5 py-0.5">#面板登录</code> 获取快捷登录地址，地址 3 分钟有效且只能打开一次。</p>
            <p>面板密码只用于登录校验，不会保存在浏览器。登录后浏览器仅保留 12 小时有效的 HttpOnly 临时令牌。</p>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}

export default function Dashboard() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null)
  const [loginError, setLoginError] = useState("")
  const [section, setSection] = useState<Section>("overview")
  const [fileManagerPath, setFileManagerPath] = useState(".")
  const [notice, setNotice] = useState<Notice>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const api: Api = useCallback((url, init) => request(url, init), [])
  const notify = useCallback((kind: "success" | "error" | "info", message: string) => {
    setNotice({ kind, message })
    window.setTimeout(() => setNotice(null), 4200)
  }, [])
  const navigateTo = useCallback((nextSection: Section) => {
    if (nextSection === "files") setFileManagerPath(".")
    setSection(nextSection)
    setSidebarOpen(false)
  }, [])

  useEffect(() => {
    const handler = (event: Event) => {
      const requestedPath = (event as CustomEvent<string>).detail
      setFileManagerPath(requestedPath || "plugins")
      setSection("files")
      setSidebarOpen(false)
    }
    window.addEventListener("panel:navigate-files", handler)
    return () => window.removeEventListener("panel:navigate-files", handler)
  }, [])

  useEffect(() => {
    const handleExpiredSession = () => {
      setLoginError("登录令牌已失效，请重新登录")
      setSessionExpiresAt(null)
      setAuthenticated(false)
    }
    window.addEventListener("panel:auth-expired", handleExpiredSession)
    return () => window.removeEventListener("panel:auth-expired", handleExpiredSession)
  }, [])

  useEffect(() => {
    let active = true
    const quickCode = window.location.hash.match(/^#\/(?:ml|quick)\/([^/?#]+)/)?.[1]
    if (quickCode) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
      request("/api/auth/quick", { method: "POST", body: JSON.stringify({ code: quickCode }) })
        .then(result => {
          if (!active) return
          setSessionExpiresAt(result.expiresAt)
          setAuthenticated(true)
        })
        .catch(reason => {
          if (!active) return
          setLoginError((reason as Error).message)
          setAuthenticated(false)
        })
    } else {
      request("/api/auth/status")
        .then(result => {
          if (!active) return
          setSessionExpiresAt(result.authenticated ? result.expiresAt : null)
          setAuthenticated(result.authenticated)
        })
        .catch(() => { if (active) setAuthenticated(false) })
    }
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!authenticated || !sessionExpiresAt) return
    const remaining = sessionExpiresAt - Date.now()
    if (remaining <= 0) {
      setLoginError("登录令牌已过期，请重新登录")
      setAuthenticated(false)
      return
    }
    const timer = window.setTimeout(() => {
      setLoginError("登录令牌已过期，请重新登录")
      setSessionExpiresAt(null)
      setAuthenticated(false)
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [authenticated, sessionExpiresAt])

  const active = navigation.find(item => item.id === section)!
  const ActiveIcon = active.icon
  if (authenticated === null) return <main className="grid min-h-screen place-items-center text-muted-foreground"><LoaderCircle className="size-7 animate-spin" /></main>
  if (!authenticated) return <Login initialError={loginError} onLogin={expiresAt => { setLoginError(""); setSessionExpiresAt(expiresAt); setAuthenticated(true) }} />

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }) } catch {}
    setAuthenticated(false)
  }

  return (
      <div className="admin-panel-shell min-h-screen" style={{ "--admin-sidebar-size": sidebarCollapsed ? "56px" : "220px" } as React.CSSProperties}>
      <aside data-collapsed={sidebarCollapsed} className={`admin-panel-sidebar fixed inset-y-0 left-0 z-40 flex flex-col border-r border-[#373737] bg-[#202124] px-4 pb-0 pt-5 text-slate-100 shadow-xl transition-transform duration-200 md:translate-x-0 ${sidebarCollapsed ? "md:px-1.5" : "md:px-3"} ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="admin-sidebar-brand flex items-center gap-3 overflow-hidden px-2 pb-7">
          <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[14px] bg-white/10 p-1 shadow-md shadow-indigo-950/40"><img src="/elia.png" alt="EliaAdminPanel" className="size-full object-contain" /></div>
          <div className="min-w-0"><div className="truncate font-semibold tracking-tight">EliaAdminPanel</div></div>
          <button className="ml-auto text-muted-foreground md:hidden" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单"><X className="size-5" /></button>
        </div>
        <div className="admin-sidebar-group overflow-hidden px-2 pb-2 text-[10px] font-semibold uppercase tracking-[.16em] text-slate-500">控制台</div>
        <nav className="space-y-1">
          {navigation.map(item => {
            const Icon = item.icon
            const selected = section === item.id
            return <button key={item.id} title={sidebarCollapsed ? item.label : undefined} aria-label={item.label} onClick={() => navigateTo(item.id)} className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${selected ? "bg-[#2c3448] text-blue-200" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}>
              <Icon className={`size-[18px] shrink-0 ${selected ? "text-blue-300" : "text-slate-500 group-hover:text-slate-300"}`} />
              <span aria-hidden={sidebarCollapsed} className="admin-sidebar-label min-w-0 flex-1"><span className="block text-[13px] font-medium">{item.label}</span><span className="mt-0.5 block truncate text-[10px] text-slate-500">{item.description}</span></span>
              {selected && <span aria-hidden="true" className="admin-sidebar-selected size-1.5 rounded-full bg-blue-300" />}
            </button>
          })}
        </nav>
        <div className="mt-auto space-y-3 px-1 pb-3">
          <div title={sidebarCollapsed ? "本机会话已加密" : undefined} className="admin-sidebar-session-card rounded-xl bg-white/5 p-3.5">
            <div className="admin-sidebar-session-heading flex items-center text-xs font-medium text-slate-200"><ShieldCheck className="size-4 shrink-0 text-emerald-400" /><span aria-hidden={sidebarCollapsed} className="admin-sidebar-label">本机会话已加密</span></div>
            <p aria-hidden={sidebarCollapsed} className="admin-sidebar-copy text-[10px] leading-4 text-slate-500">工作区修改会自动留存备份，可从面板文件管理中查看。</p>
          </div>
          <button title={sidebarCollapsed ? "退出登录" : undefined} aria-label="退出登录" onClick={logout} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-400 transition hover:bg-white/5 hover:text-white"><LogOut className="size-4 shrink-0" /><span aria-hidden={sidebarCollapsed} className="admin-sidebar-label">退出登录</span></button>
          <div aria-hidden={sidebarCollapsed} className="admin-sidebar-version px-3 text-[10px] text-slate-600">ELIAADMINPANEL <span className="float-right">0.1.0</span></div>
          <div className="-mx-1 hidden border-t border-white/10 pt-2 md:block">
            <button title={sidebarCollapsed ? "展开侧边栏" : undefined} aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(value => !value)} className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-xs font-medium text-blue-300 transition hover:bg-white/5 hover:text-blue-200">
              <ChevronLeft className={`size-4 shrink-0 transition-transform duration-200 ${sidebarCollapsed ? "rotate-180" : ""}`} />
              <span aria-hidden={sidebarCollapsed} className="admin-sidebar-label">{sidebarCollapsed ? "展开" : "收起"}</span>
            </button>
          </div>
        </div>
      </aside>

      {sidebarOpen && <button className="fixed inset-0 z-30 bg-slate-900/30 md:hidden" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单背景" />}
      <div className="min-h-screen">
        <header className="sticky top-0 z-20 flex h-[70px] items-center justify-between border-b border-border/80 bg-white/90 px-5 backdrop-blur-xl md:px-9">
          <div className="flex min-w-0 items-center gap-3"><Button variant="ghost" size="icon" className="md:hidden" aria-label="打开菜单" onClick={() => setSidebarOpen(true)}><Menu /></Button><div className="grid size-9 place-items-center rounded-xl bg-indigo-50 text-indigo-600"><ActiveIcon className="size-[18px]" /></div><div className="min-w-0"><div className="text-[14px] font-semibold">{active.label}</div><div className="hidden text-[11px] text-muted-foreground sm:block">{active.description}</div></div></div>
          <div className="flex items-center gap-2 sm:gap-4"><Badge className="gap-1.5 border-emerald-100 bg-emerald-50 text-emerald-700"><span className="size-1.5 rounded-full bg-emerald-500" />本机管理</Badge><span className="hidden text-xs text-slate-400 lg:block">Yunzai</span><Button variant="ghost" size="icon" aria-label="退出登录" onClick={logout}><LogOut className="size-4 text-slate-500" /></Button></div>
        </header>
        <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-9 lg:py-8">
          {section === "overview" && <Overview api={api} notify={notify} navigate={navigateTo} />}
          {section === "config" && <ConfigCenter api={api} notify={notify} />}
          {section === "plugins" && <PluginCenter api={api} notify={notify} />}
          {section === "files" && <FileManager api={api} notify={notify} initialPath={fileManagerPath} />}
          {section === "logs" && <LogViewer api={api} />}
        </main>
      </div>
      {notice && <div className={`fixed bottom-6 right-6 z-50 flex max-w-[min(480px,calc(100vw-32px))] items-start gap-2.5 rounded-2xl border bg-white px-4 py-3 text-sm shadow-xl ${notice.kind === "error" ? "border-rose-200 text-rose-700" : notice.kind === "success" ? "border-emerald-200 text-emerald-700" : "border-indigo-200 text-indigo-700"}`}><span className="mt-0.5">{notice.kind === "error" ? <CircleHelp className="size-4" /> : <Check className="size-4" />}</span>{notice.message}</div>}
    </div>
  )
}

function PageIntro({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><div className="mb-2 text-[10px] font-semibold uppercase tracking-[.18em] text-indigo-500">{eyebrow}</div><h1 className="text-[25px] font-semibold tracking-tight">{title}</h1><p className="mt-1.5 text-sm text-muted-foreground">{description}</p></div>{action}</div>
}

function Metric({ icon: Icon, label, value, detail, tone = "indigo" }: { icon: typeof Cpu; label: string; value: string; detail: string; tone?: string }) {
  const palette: Record<string, string> = { indigo: "bg-indigo-50 text-indigo-600", blue: "bg-sky-50 text-sky-600", green: "bg-emerald-50 text-emerald-600", violet: "bg-violet-50 text-violet-600" }
  return <Card><CardContent className="flex items-start justify-between p-5"><div><div className="text-xs text-muted-foreground">{label}</div><div className="mt-2 text-[23px] font-semibold tracking-tight">{value}</div><div className="mt-1 text-[11px] text-muted-foreground">{detail}</div></div><div className={`grid size-10 place-items-center rounded-xl ${palette[tone]}`}><Icon className="size-[18px]" /></div></CardContent></Card>
}

function Overview({ api, notify, navigate }: { api: Api; notify: any; navigate: (section: Section) => void }) {
  const [status, setStatus] = useState<any>(null)
  const [error, setError] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try { setStatus(await api("/api/status")); setError("") } catch (reason) { setError((reason as Error).message) } finally { setRefreshing(false) }
  }, [api])
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 15000); return () => window.clearInterval(timer) }, [refresh])
  async function restart() {
    if (!window.confirm("确定要重启 Bot 吗？当前运行任务可能会中断。")) return
    setRestarting(true)
    try { const result = await api("/api/runtime/restart", { method: "POST", body: "{}" }); notify("success", result.message || "重启请求已发送") }
    catch (reason) { notify("error", (reason as Error).message) }
    finally { setRestarting(false) }
  }
  return <>
    <PageIntro eyebrow="System overview" title="运行概览" description="查看 Bot 当前运行状态，并快速进入需要管理的区域。" action={<Button variant="outline" onClick={refresh} disabled={refreshing}>{refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}刷新状态</Button>} />
    {error && <div className="mb-5"><ErrorState message={error} /></div>}
    <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric icon={Activity} label="运行状态" value={status ? "运行中" : "读取中"} detail={status ? `进程 PID ${status.pid}` : "正在连接 Bot"} tone="green" />
      <Metric icon={Clock3} label="持续运行" value={status ? formatUptime(status.uptime) : "—"} detail={status?.startedAt ? `启动于 ${new Date(status.startedAt).toLocaleString("zh-CN")}` : "等待运行信息"} tone="indigo" />
      <Metric icon={Cpu} label="内存占用" value={status ? formatBytes(status.memory.rss) : "—"} detail={status ? `堆内存 ${formatBytes(status.memory.heapUsed)} / ${formatBytes(status.memory.heapTotal)}` : "Node.js 进程 RSS"} tone="blue" />
      <Metric icon={Users} label="群组缓存" value={status ? String(status.groupCount) : "—"} detail={status ? `${status.accounts.length} 个机器人账号` : "当前 Bot 群组数量"} tone="violet" />
    </div>
    <div className="grid gap-5 xl:grid-cols-[1.45fr_1fr]">
      <Card className="overflow-hidden"><CardHeader className="flex-row items-start justify-between"><div><CardTitle>Bot 实例</CardTitle><CardDescription className="mt-1">Yunzai 运行环境与连接信息</CardDescription></div><Badge className="border-emerald-100 bg-emerald-50 text-emerald-700"><span className="mr-1.5 size-1.5 rounded-full bg-emerald-500" />{status ? "运行正常" : "连接中"}</Badge></CardHeader><CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          <InfoTile icon={Server} label="Yunzai 版本" value={status?.version || "读取中"} />
          <InfoTile icon={Monitor} label="主机平台" value={status?.platform || "读取中"} />
          <InfoTile icon={HardDrive} label="主机名称" value={status?.host || "读取中"} />
          <InfoTile icon={Database} label="面板地址" value={status?.panel ? `${status.panel.host}:${status.panel.port}` : "读取中"} />
        </div>
        <div className="mt-5 border-t border-border pt-4"><div className="mb-3 text-xs font-semibold">机器人账号</div>{status?.accounts?.length ? <div className="space-y-2">{status.accounts.map((account: any) => <div key={account.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3.5 py-3"><div className="flex items-center gap-3"><div className="grid size-8 place-items-center rounded-full bg-white text-indigo-600 shadow-sm"><Bot className="size-4" /></div><div><div className="text-sm font-medium">{account.nickname || `账号 ${account.id}`}</div><div className="mt-0.5 text-[11px] text-muted-foreground">QQ {account.id}</div></div></div><Badge className={account.online ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-500"}>{account.status}</Badge></div>)}</div> : <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">当前没有可显示的机器人账号</div>}</div>
      </CardContent></Card>
      <div className="space-y-5">
        <Card><CardHeader><CardTitle>快速入口</CardTitle><CardDescription>常用的控制功能</CardDescription></CardHeader><CardContent className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-1">{[
          { icon: FileCog, title: "编辑运行配置", desc: "Bot、群组与系统 YAML 配置", section: "config" as Section },
          { icon: Plug, title: "管理插件设置", desc: "加载插件提供的兼容配置项", section: "plugins" as Section },
          { icon: FileCode2, title: "浏览工作区文件", desc: "查看并编辑文本资源文件", section: "files" as Section },
          { icon: TerminalSquare, title: "查看运行日志", desc: "定位近期错误与命令记录", section: "logs" as Section },
        ].map(item => <button key={item.title} onClick={() => navigate(item.section)} className="group flex items-center gap-3 rounded-xl border border-border/80 p-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50/40"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-slate-50 text-indigo-600 group-hover:bg-white"><item.icon className="size-4" /></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{item.title}</span><span className="mt-1 block text-[10px] text-muted-foreground">{item.desc}</span></span><ChevronRight className="size-4 text-slate-300 group-hover:text-indigo-500" /></button>)}</CardContent></Card>
        <Card className="border-indigo-100 bg-gradient-to-br from-indigo-50/80 to-white"><CardHeader><div className="flex items-center gap-2"><div className="grid size-8 place-items-center rounded-xl bg-indigo-100 text-indigo-600"><Sparkles className="size-4" /></div><CardTitle>进程操作</CardTitle></div><CardDescription>通过当前进程守护程序执行 Bot 重启</CardDescription></CardHeader><CardContent><Button variant="outline" className="w-full border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-50" disabled={!status?.restartAvailable || restarting} onClick={restart}>{restarting ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}重启 Bot {status?.restartAvailable ? "" : "（未检测到守护程序）"}</Button>{!status?.restartAvailable && <p className="mt-2.5 text-[10px] leading-4 text-muted-foreground">仅在使用 ksr 或 PM2 托管时启用，避免意外结束未托管的进程。</p>}</CardContent></Card>
      </div>
    </div>
  </>
}

function InfoTile({ icon: Icon, label, value }: { icon: typeof Server; label: string; value: string }) {
  return <div className="flex items-center gap-3 rounded-xl border border-border/70 p-3"><span className="grid size-8 place-items-center rounded-lg bg-slate-50 text-slate-500"><Icon className="size-4" /></span><div className="min-w-0"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-1 truncate text-xs font-medium">{value}</div></div></div>
}

function ConfigCenter({ api, notify }: { api: Api; notify: any }) {
  const [files, setFiles] = useState<string[]>([])
  const [selected, setSelected] = useState("")
  const [fileSidebarCollapsed, setFileSidebarCollapsed] = useState(false)
  const [data, setData] = useState<any>(null)
  const [defaults, setDefaults] = useState<any>(null)
  const [raw, setRaw] = useState("")
  const [rawMode, setRawMode] = useState(false)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [dirty, setDirty] = useState(false)
  useEffect(() => { api("/api/config").then(result => { setFiles(result.files); if (result.files[0]) setSelected(result.files[0]) }).catch(reason => setError(reason.message)) }, [api])
  const selectedLabel = configFileLabel(selected)
  const load = useCallback(async (name: string) => {
    setLoading(true); setError("")
    try { const result = await api(`/api/config/${encodeURIComponent(name)}`); setSelected(name); setData(result.data); setDefaults(result.defaults); setRaw(result.content); setDirty(false); setRawMode(false) }
    catch (reason) { setError((reason as Error).message) }
    finally { setLoading(false) }
  }, [api])
  useEffect(() => { if (selected && !data) load(selected) }, [selected, data, load])
  const visible = files.filter(file => `${file} ${configFileLabel(file)}`.toLowerCase().includes(search.toLowerCase()))
  function update(path: string[], value: any) { setData((old: any) => setNested(old, path, value)); setDirty(true) }
  async function save() {
    setSaving(true)
    try {
      const content = rawMode ? raw : undefined
      await api(`/api/config/${encodeURIComponent(selected)}`, { method: "PUT", body: JSON.stringify(content ? { content } : { data }) })
      notify("success", `${selectedLabel} 已保存并刷新运行时配置`)
      await load(selected)
    } catch (reason) { setError((reason as Error).message); notify("error", (reason as Error).message) }
    finally { setSaving(false) }
  }
  return <>
    <PageIntro eyebrow="运行配置" title="配置中心" description="图形化编辑 YAML 配置；群组规则、黑白名单与运行参数统一管理。" action={<Button onClick={save} disabled={!selected || saving || (!dirty && !rawMode)}>{saving ? <LoaderCircle className="animate-spin" /> : <Check />}保存更改</Button>} />
    <div className={`grid min-h-[640px] gap-5 ${fileSidebarCollapsed ? "xl:grid-cols-[60px_minmax(0,1fr)]" : "xl:grid-cols-[245px_minmax(0,1fr)]"}`}>
      <Card className="h-fit overflow-hidden">
        {fileSidebarCollapsed && <div className="hidden gap-1 p-2 xl:grid">
          <Button size="icon" variant="ghost" className="mx-auto mb-1" aria-label="展开配置文件侧栏" title="展开配置文件侧栏" onClick={() => setFileSidebarCollapsed(false)}><ChevronRight /></Button>
          {files.map(file => <button key={file} title={configFileLabel(file)} aria-label={configFileLabel(file)} onClick={() => load(file)} className={`grid size-10 place-items-center rounded-lg transition ${selected === file ? "bg-indigo-50 text-indigo-700" : "text-slate-500 hover:bg-slate-50"}`}><FileCog className="size-4" /></button>)}
        </div>}
        <div className={fileSidebarCollapsed ? "xl:hidden" : ""}>
          <div className="p-4 pb-3">
            <div className="mb-3 flex items-center justify-between gap-2 text-xs font-semibold"><span>配置文件 <Badge className="ml-1 border-0 bg-slate-100 text-slate-600">{files.length}</Badge></span><Button size="icon" variant="ghost" className="hidden size-7 xl:inline-flex" aria-label="收起配置文件侧栏" title="收起配置文件侧栏" onClick={() => setFileSidebarCollapsed(true)}><ChevronLeft className="size-4" /></Button></div>
            <div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><Input className="h-9 pl-9 text-xs" placeholder="筛选配置…" value={search} onChange={event => setSearch(event.target.value)} /></div>
          </div>
          <div className="max-h-[560px] space-y-1 overflow-y-auto px-2 pb-3">{visible.map(file => <button key={file} title={file} onClick={() => load(file)} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs transition ${selected === file ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-50"}`}><FileCog className="size-4 shrink-0 text-slate-400" /><span className="min-w-0 flex-1 truncate">{configFileLabel(file)}</span><span className="text-[10px] text-slate-400">YAML</span></button>)}</div>
        </div>
      </Card>
      <Card className="min-w-0"><CardHeader className="flex-row items-center justify-between border-b border-border/70 pb-4"><div><CardTitle className="text-base">{selected ? selectedLabel : "选择配置文件"}</CardTitle><CardDescription className="mt-1">config/config/{selected}</CardDescription></div><div className="flex items-center gap-2"><Button size="sm" variant={rawMode ? "secondary" : "outline"} onClick={() => { if (!rawMode) { if (dirty && !window.confirm("切换源码模式会放弃尚未保存的图形化修改，继续吗？")) return; setRaw(stringifyYaml(data || {})); setRawMode(true); return } try { const parsed = parseYaml(raw); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("YAML 内容必须是对象"); setData(parsed); setDirty(true); setRawMode(false) } catch (reason) { notify("error", `YAML 无法解析：${(reason as Error).message}`) } }}><Braces />{rawMode ? "图形化编辑" : "YAML 源码"}</Button><Button size="icon" variant="ghost" aria-label="重新加载" onClick={() => selected && load(selected)}><RefreshCw className="size-4" /></Button></div></CardHeader><CardContent className="p-5">
        {error && <div className="mb-4"><ErrorState message={error} /></div>}
        {loading && <div className="grid min-h-64 place-items-center"><LoaderCircle className="size-6 animate-spin text-indigo-500" /></div>}
        {!loading && rawMode && <Textarea className="min-h-[560px] resize-y font-mono text-xs leading-6" spellCheck={false} value={raw} onChange={event => { setRaw(event.target.value); setDirty(true) }} />}
        {!loading && !rawMode && data && <div className="space-y-5">{Object.entries(data).map(([key, value]) => <ConfigField key={key} name={key} value={value} defaultValue={defaults?.[key]} path={[key]} onChange={update} />)}</div>}
        {!loading && !data && !error && <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">选择左侧配置文件开始编辑</div>}
      </CardContent></Card>
    </div>
  </>
}

function setNested(value: any, path: string[], next: any): any {
  const copy = Array.isArray(value) ? [...value] : { ...(value || {}) }
  if (path.length === 1) copy[path[0]] = next
  else copy[path[0]] = setNested(value?.[path[0]], path.slice(1), next)
  return copy
}
function getNested(value: any, path: string) { return path.split(".").reduce((current, key) => current?.[key], value) }
function isObject(value: any) { return value !== null && typeof value === "object" && !Array.isArray(value) }
function secretField(name: string) { return /(password|passwd|secret|token|cookie|private.?key|\bpwd\b)/i.test(name) }

function ConfigField({ name, value, defaultValue, path, onChange, depth = 0 }: { name: string; value: any; defaultValue?: any; path: string[]; onChange: (path: string[], value: any) => void; depth?: number }) {
  const label = configFieldLabel(name)
  if (isObject(value)) return <div className={`${depth ? "ml-3 border-l border-border pl-4" : ""}`}><div className="mb-3 flex items-center gap-2 border-b border-border/60 pb-2"><span className="grid size-6 place-items-center rounded-md bg-indigo-50 text-indigo-600"><Braces className="size-3.5" /></span><span className="text-sm font-semibold">{label}</span></div><div className="space-y-4">{Object.entries(value).map(([child, current]) => <ConfigField key={child} name={child} value={current} defaultValue={defaultValue?.[child]} path={[...path, child]} onChange={onChange} depth={depth + 1} />)}</div></div>
  const hint = defaultValue !== undefined && JSON.stringify(value) !== JSON.stringify(defaultValue) ? `默认值：${Array.isArray(defaultValue) ? defaultValue.join(", ") : String(defaultValue)}` : ""
  const multiline = /disable|enable|white|black|alias|adopt|list|path|address|msg/i.test(name)
  return <div className={`grid gap-3 ${depth ? "md:grid-cols-[minmax(150px,240px)_minmax(240px,1fr)]" : "md:grid-cols-[minmax(170px,245px)_minmax(240px,1fr)]"}`}>
    <div className="pt-1"><div className="text-xs font-medium capitalize">{label}</div>{hint && <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>}</div>
    <div className="min-w-0">{typeof value === "boolean" ? <div className="flex h-10 items-center justify-between rounded-xl border border-border/80 px-3"><span className="text-xs text-slate-500">{value ? "已启用" : "已关闭"}</span><Switch checked={value} onCheckedChange={next => onChange(path, next)} /></div>
      : typeof value === "number" ? <Input type="number" value={value} onChange={event => onChange(path, event.target.value === "" ? "" : Number(event.target.value))} />
      : Array.isArray(value) ? <Textarea className="min-h-20 font-mono text-xs" value={value.every(item => !isObject(item)) ? value.join("\n") : JSON.stringify(value, null, 2)} onChange={event => { try { onChange(path, value.every(item => !isObject(item)) ? event.target.value.split("\n").filter(Boolean) : JSON.parse(event.target.value)) } catch {} }} />
      : value === null || value === undefined ? <Input value="" placeholder="未设置" onChange={event => onChange(path, event.target.value || null)} />
      : <Input type={secretField(name) ? "password" : "text"} value={String(value)} className={multiline ? "font-mono text-xs" : ""} onChange={event => onChange(path, event.target.value)} />}</div>
  </div>
}

function PluginCenter({ api, notify }: { api: Api; notify: any }) {
  const [plugins, setPlugins] = useState<any[]>([])
  const [archives, setArchives] = useState<any[]>([])
  const [selected, setSelected] = useState<any>(null)
  const [data, setData] = useState<any>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [showInstall, setShowInstall] = useState(false)
  const [installUrl, setInstallUrl] = useState("")
  const [installName, setInstallName] = useState("")
  const [actionArgs, setActionArgs] = useState("{}")
  const [error, setError] = useState("")
  const refresh = useCallback(async () => {
    setLoading(true); setError("")
    try {
      const [result, archiveResult] = await Promise.all([api("/api/plugins"), api("/api/plugins/archives")])
      setPlugins(result.plugins); setArchives(archiveResult.archives)
      if (!selected && result.plugins.length) setSelected(result.plugins[0])
    }
    catch (reason) { setError((reason as Error).message) }
    finally { setLoading(false) }
  }, [api, selected])
  useEffect(() => { refresh() }, []) // initial discovery
  const loadConfig = useCallback(async (plugin: any) => {
    setSelected(plugin); setData({})
    if (!plugin?.hasConfig) return
    try { const result = await api(`/api/plugins/${encodeURIComponent(plugin.id)}/config`); setData(result.data || {}) }
    catch (reason) { setError((reason as Error).message) }
  }, [api])
  useEffect(() => { if (selected) loadConfig(selected) }, [selected?.id])
  const shown = plugins.filter(plugin => `${plugin.title} ${plugin.name} ${plugin.author}`.toLowerCase().includes(search.toLowerCase()))
  function update(field: string, value: any) { setData((old: any) => setNested(old, field.split("."), value)) }
  async function save() {
    if (!selected) return
    setBusy(true)
    try {
      const values: Record<string, any> = {}
      for (const schema of selected.schemas) if (schema.field) values[schema.field] = getNested(data, schema.field)
      const result = await api(`/api/plugins/${encodeURIComponent(selected.id)}/config`, { method: "PUT", body: JSON.stringify(values) })
      if (result.code !== undefined && result.code !== 0) throw new Error(result.message || "保存失败")
      notify("success", result.message || `${selected.title} 配置已保存`)
      await loadConfig(selected)
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  async function runAction(action: string) {
    let args: any
    try { args = JSON.parse(actionArgs) } catch { notify("error", "操作参数必须是有效 JSON"); return }
    if (!window.confirm(`确定执行插件操作“${action}”吗？`)) return
    setBusy(true)
    try { const result = await api(`/api/plugins/${encodeURIComponent(selected.id)}/action`, { method: "POST", body: JSON.stringify({ action, args }) }); if (result.code !== undefined && result.code !== 0) throw new Error(result.message || "操作失败"); notify("success", result.message || "操作完成") }
    catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  async function installPlugin(event: React.FormEvent) {
    event.preventDefault()
    if (!window.confirm(`从以下 HTTPS 仓库下载插件？\n${installUrl}\n\n依赖安装脚本不会自动运行。`)) return
    setBusy(true)
    try {
      const result = await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ url: installUrl, name: installName || undefined }) })
      setShowInstall(false); setInstallUrl(""); setInstallName("")
      await refresh()
      notify("success", result.message)
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  async function archivePlugin() {
    if (!selected || selected.directory.includes("/") || selected.id.toLowerCase() === "eliaadminpanel") return
    if (!window.confirm(`将“${selected.title}”移入可恢复归档？\n\n归档后重启 Bot 即可卸载；插件文件保存在 data/elia-admin-panel/archived-plugins，可随时恢复。`)) return
    setBusy(true)
    try {
      const result = await api(`/api/plugins/${encodeURIComponent(selected.id)}/archive`, { method: "POST", body: "{}" })
      setSelected(null); setData({}); await refresh(); notify("success", result.message)
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  async function restorePlugin(archive: any) {
    if (!window.confirm(`恢复“${archive.name}”到 plugins/${archive.name}？`)) return
    setBusy(true)
    try {
      const result = await api(`/api/plugins/archives/${encodeURIComponent(archive.id)}/restore`, { method: "POST", body: "{}" })
      await refresh(); notify("success", result.message)
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  return <>
    <PageIntro eyebrow="Plugin control" title="插件控制" description="管理本地插件、安装仓库插件，并兼容 Guoba 的 schema、配置和操作接口。" action={<div className="flex gap-2"><Button variant="outline" onClick={() => setShowInstall(!showInstall)}><Plus />安装插件</Button><Button variant="outline" onClick={refresh} disabled={loading}>{loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}重新扫描</Button></div>} />
    {error && <div className="mb-4"><ErrorState message={error} /></div>}
    <div className="grid min-h-[640px] gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
      <Card className="h-fit overflow-hidden"><div className="p-4 pb-3"><div className="mb-3 flex items-center justify-between text-xs font-semibold">本地插件<Badge className="border-0 bg-slate-100 text-slate-600">{plugins.length}</Badge></div><div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><Input className="h-9 pl-9 text-xs" placeholder="搜索插件…" value={search} onChange={event => setSearch(event.target.value)} /></div></div>{showInstall && <form onSubmit={installPlugin} className="mx-3 mb-3 space-y-2 rounded-xl border border-indigo-100 bg-indigo-50/50 p-3"><Label className="text-[11px]">HTTPS 仓库地址</Label><Input className="h-9 bg-white text-xs" value={installUrl} onChange={event => setInstallUrl(event.target.value)} placeholder="https://github.com/owner/plugin.git" required /><Input className="h-9 bg-white text-xs" value={installName} onChange={event => setInstallName(event.target.value)} placeholder="插件目录名（可选，默认仓库名）" /><p className="text-[10px] leading-4 text-muted-foreground">只下载代码，不自动执行依赖安装脚本。下载后请安装依赖并重启 Bot。</p><Button size="sm" className="w-full" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <ArrowDownToLine />}下载并安装</Button></form>}<div className="max-h-[470px] space-y-1 overflow-y-auto px-2 pb-3">{shown.map(plugin => <button key={plugin.id} onClick={() => loadConfig(plugin)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${selected?.id === plugin.id ? "bg-indigo-50 text-indigo-700" : "hover:bg-slate-50"}`}><span className={`grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl ${plugin.hasConfig ? "bg-indigo-100 text-indigo-600" : "bg-slate-100 text-slate-500"}`}>{plugin.iconData ? <img src={plugin.iconData} alt="" className="size-full object-contain" /> : <Plug className="size-4" style={plugin.iconColor ? { color: plugin.iconColor } : undefined} />}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{plugin.title}</span><span className="mt-1 block truncate text-[10px] text-muted-foreground">{plugin.hasConfig ? "支持可视化配置" : plugin.directory}</span></span>{plugin.hasConfig && <span className="size-1.5 rounded-full bg-emerald-500" />}</button>)}{!loading && !shown.length && <div className="p-5 text-center text-xs text-muted-foreground">没有找到插件</div>}</div>{archives.length > 0 && <div className="border-t border-border px-3 py-3"><div className="mb-2 text-[10px] font-semibold text-slate-500">可恢复归档 · {archives.length}</div><div className="max-h-36 space-y-1 overflow-y-auto">{archives.map(archive => <div key={archive.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5"><span className="min-w-0 flex-1 truncate text-[10px] text-slate-600">{archive.name}</span><Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" disabled={busy} onClick={() => restorePlugin(archive)}>恢复</Button></div>)}</div></div>}</Card>
      <Card className="min-w-0"><CardHeader className="flex-row items-start justify-between border-b border-border/70 pb-4"><div className="min-w-0"><CardTitle className="truncate text-base">{selected?.title || "选择插件"}</CardTitle><CardDescription className="mt-1 truncate">{selected?.description || selected?.directory || "选择左侧插件查看其配置接口"}</CardDescription></div><div className="flex shrink-0 gap-2">{selected?.hasConfig && <Button onClick={save} disabled={busy}><Check />保存配置</Button>}{selected && !selected.directory.includes("/") && selected.id.toLowerCase() !== "eliaadminpanel" && <Button variant="outline" className="text-rose-700 hover:bg-rose-50" onClick={archivePlugin} disabled={busy}><ArrowDownToLine />归档插件</Button>}</div></CardHeader><CardContent className="p-5">
        {selected?.author && <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground"><span>作者：{Array.isArray(selected.author) ? selected.author.join("、") : selected.author}</span>{selected.link && <a href={selected.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-600 hover:underline"><Github className="size-3" />仓库</a>}</div>}
        {selected?.hasConfig ? <div className="space-y-5">{selected.schemas.map((schema: any, index: number) => schema.component === "SOFT_GROUP_BEGIN" ? <div key={`group-${index}`} className="border-b border-border pb-2 pt-2 text-xs font-semibold text-slate-700">{schema.label}</div> : schema.field ? <SchemaField key={`${schema.field}-${index}`} schema={schema} value={getNested(data, schema.field)} onChange={value => update(schema.field, value)} /> : null)}</div> : selected ? <div className="rounded-2xl border border-dashed border-border bg-slate-50/70 px-6 py-10 text-center"><div className="mx-auto grid size-11 place-items-center overflow-hidden rounded-2xl bg-white text-slate-500 shadow-sm">{selected.iconData ? <img src={selected.iconData} alt="" className="size-full object-contain" /> : <Plug className="size-5" style={selected.iconColor ? { color: selected.iconColor } : undefined} />}</div><div className="mt-3 text-sm font-medium">此插件没有兼容配置入口</div><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">可通过文件管理器编辑插件目录。插件配置页支持 elia.support.js（导出 supportPanel()），也兼容 guoba.support.js（导出 supportGuoba()）。</p><Button variant="outline" size="sm" className="mt-4" onClick={() => window.dispatchEvent(new CustomEvent("panel:navigate-files"))}><FileCode2 />打开文件管理</Button></div> : <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">{loading ? "正在扫描插件目录…" : "选择左侧插件"}</div>}
        {selected?.actions?.length > 0 && <div className="mt-8 border-t border-border pt-5"><div className="mb-1 text-sm font-semibold">插件操作</div><p className="mb-3 text-xs text-muted-foreground">调用 Guoba 兼容接口 configInfo.actions；运行前会进行确认。</p><Textarea className="mb-3 min-h-20 font-mono text-xs" value={actionArgs} onChange={event => setActionArgs(event.target.value)} /><div className="flex flex-wrap gap-2">{selected.actions.map((action: any) => <Button key={action.key} variant="outline" size="sm" disabled={!action.available || busy} onClick={() => runAction(action.key)}><Sparkles />{action.key}</Button>)}</div></div>}
      </CardContent></Card>
    </div>
  </>
}

function SchemaField({ schema, value, onChange }: { schema: any; value: any; onChange: (value: any) => void }) {
  const component = String(schema.component || "Input")
  const props = schema.componentProps || {}
  const label = schema.label || schema.field
  const help = schema.bottomHelpMessage || schema.helpMessage
  const options: any[] = props.options || []
  const multiline = component === "InputTextArea" || component === "GTags" || component === "CheckboxGroup" || component === "GSelectFriend"
  const textValue = Array.isArray(value) ? value.join("\n") : value == null ? "" : String(value)
  return <div className="grid gap-3 md:grid-cols-[minmax(155px,250px)_minmax(220px,1fr)]">
    <div className="pt-1"><Label className="text-xs">{label}{schema.required && <span className="ml-1 text-rose-500">*</span>}</Label>{help && <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{help}</p>}</div>
    <div>{component === "Switch" ? <div className="flex h-10 items-center justify-between rounded-xl border border-border/80 px-3"><span className="text-xs text-slate-500">{value ? "已启用" : "已关闭"}</span><Switch checked={Boolean(value)} onCheckedChange={onChange} />{schema.bottomHelpMessage && <span className="hidden">{schema.bottomHelpMessage}</span>}</div>
      : component === "InputNumber" ? <Input type="number" min={props.min} max={props.max} step={props.step || "any"} value={value ?? ""} placeholder={props.placeholder} onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))} />
      : component === "RadioGroup" || component === "Select" ? <div className="flex flex-wrap gap-2">{options.map((option: any) => { const optionValue = typeof option === "object" ? option.value : option; const optionLabel = typeof option === "object" ? option.label : option; return <button key={String(optionValue)} type="button" onClick={() => onChange(optionValue)} className={`rounded-lg border px-3 py-2 text-xs transition ${value === optionValue ? "border-indigo-300 bg-indigo-50 font-medium text-indigo-700" : "border-border bg-white text-slate-600 hover:bg-slate-50"}`}>{optionLabel}</button> })}</div>
      : component === "InputTextArea" || component === "GTags" || component === "CheckboxGroup" || component === "GSelectFriend" || component === "GSubForm" || (Array.isArray(value) && value.length > 1) ? <Textarea className="min-h-20 text-xs" value={textValue} placeholder={props.placeholder || "每行一项"} onChange={event => onChange(Array.isArray(value) || component === "GTags" || component === "CheckboxGroup" || component === "GSelectFriend" ? event.target.value.split("\n").filter(Boolean) : event.target.value)} />
      : <Input type={secretField(schema.field) ? "password" : "text"} value={textValue} placeholder={props.placeholder} onChange={event => onChange(event.target.value)} />}</div>
  </div>
}

function FileManager({ api, notify, initialPath = "." }: { api: Api; notify: any; initialPath?: string }) {
  const [directory, setDirectory] = useState(".")
  const [entries, setEntries] = useState<any[]>([])
  const [current, setCurrent] = useState<any>(null)
  const [content, setContent] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [search, setSearch] = useState("")
  const [error, setError] = useState("")
  const browse = useCallback(async (path: string) => {
    setLoading(true); setError("")
    try { const result = await api(`/api/files?path=${encodeURIComponent(path)}`); setDirectory(result.path); setEntries(result.entries); setCurrent(null); setContent(""); setDirty(false) }
    catch (reason) { setError((reason as Error).message) }
    finally { setLoading(false) }
  }, [api])
  useEffect(() => { browse(initialPath) }, [browse, initialPath])
  async function openFile(entry: any) {
    if (dirty && !window.confirm("当前文件有未保存修改，继续切换吗？")) return
    setLoading(true); setError("")
    try { const result = await api(`/api/files/read?path=${encodeURIComponent(entry.path)}`); setCurrent(result); setContent(result.content); setDirty(false) }
    catch (reason) { setError((reason as Error).message) }
    finally { setLoading(false) }
  }
  const save = useCallback(async () => {
    if (!current || !dirty || saving) return
    setSaving(true)
    try { const result = await api("/api/files/write", { method: "PUT", body: JSON.stringify({ path: current.path, content }) }); setDirty(false); notify("success", result.message || "文件已保存") }
    catch (reason) { notify("error", (reason as Error).message) }
    finally { setSaving(false) }
  }, [api, content, current, dirty, notify, saving])
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (current && dirty && !saving) void save()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [current, dirty, save, saving])
  const filtered = entries.filter(entry => entry.name.toLowerCase().includes(search.toLowerCase()))
  const crumbs = directory === "." ? [] : directory.split("/")
  return <>
    <PageIntro eyebrow="Workspace files" title="文件管理" description="浏览 Yunzai 工作区中的可读文本文件；每次保存都会创建时间戳备份。按 Ctrl+S / ⌘+S 保存当前文件。" action={<Button onClick={save} disabled={!current || !dirty || saving}>{saving ? <LoaderCircle className="animate-spin" /> : <Check />}保存文件</Button>} />
    {error && <div className="mb-4"><ErrorState message={error} /></div>}
    <Card className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"><div className="flex min-w-0 items-center gap-1 text-xs"><button onClick={() => browse(".")} className={`rounded-md px-2 py-1 ${directory === "." ? "font-semibold text-indigo-700" : "text-muted-foreground hover:bg-muted"}`}>工作区</button>{crumbs.map((crumb, index) => { const path = crumbs.slice(0, index + 1).join("/"); return <span key={path} className="flex items-center gap-1"><ChevronRight className="size-3 text-slate-300" /><button onClick={() => browse(path)} className={`max-w-32 truncate rounded-md px-1.5 py-1 ${index === crumbs.length - 1 ? "font-semibold text-indigo-700" : "text-muted-foreground hover:bg-muted"}`}>{crumb}</button></span> })}</div><div className="relative w-full sm:w-64"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><Input className="h-9 pl-9 text-xs" placeholder="筛选当前目录…" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
      <div className="grid min-h-[600px] xl:grid-cols-[320px_minmax(0,1fr)]"><div className="border-b border-border xl:border-b-0 xl:border-r"><div className="flex h-11 items-center justify-between px-4 text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400"><span>文件浏览器</span><span>{entries.length} 项</span></div><div className="max-h-[550px] overflow-y-auto px-2 pb-3 scrollbar-thin">{directory !== "." && <button onClick={() => browse(crumbs.length > 1 ? crumbs.slice(0, -1).join("/") : ".")} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-slate-500 hover:bg-slate-50"><ArrowLeft className="size-3.5" />上级目录</button>}{loading && <div className="grid h-24 place-items-center"><LoaderCircle className="size-5 animate-spin text-indigo-500" /></div>}{filtered.map(entry => <button key={entry.path} onClick={() => entry.type === "directory" ? browse(entry.path) : openFile(entry)} className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition ${current?.path === entry.path ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-50"}`}><span className={`${entry.type === "directory" ? "text-amber-500" : "text-slate-400"}`}>{entry.type === "directory" ? <Folder className="size-4" /> : <FileText className="size-4" />}</span><span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>{entry.type === "file" && <span className="text-[9px] text-slate-400">{formatBytes(entry.size)}</span>}{entry.type === "directory" && <ChevronRight className="size-3 text-slate-300" />}</button>)}{!loading && !filtered.length && <div className="p-5 text-center text-xs text-muted-foreground">当前目录没有可显示的内容</div>}</div></div>
        <div className="flex min-w-0 flex-col"><div className="flex h-11 items-center justify-between border-b border-border px-4"><div className="flex min-w-0 items-center gap-2 text-xs"><FileCode2 className="size-4 text-indigo-500" /><span className="truncate font-medium">{current?.path || "选择一个文本文件"}</span>{dirty && <span className="size-1.5 rounded-full bg-amber-500" />}</div>{current && <span className="hidden text-[10px] text-muted-foreground sm:block">{formatBytes(new Blob([content]).size)} · UTF-8</span>}</div>{current ? <Textarea spellCheck={false} className="min-h-[545px] flex-1 resize-y rounded-none border-0 bg-[#fbfbfd] p-5 font-mono text-[12px] leading-6 shadow-none focus-visible:ring-0" value={content} onChange={event => { setContent(event.target.value); setDirty(true) }} /> : <div className="grid flex-1 place-items-center p-8 text-center"><div><div className="mx-auto grid size-12 place-items-center rounded-2xl bg-indigo-50 text-indigo-600"><FileCode2 className="size-5" /></div><div className="mt-3 text-sm font-medium">选择文件以开始编辑</div><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">支持 YAML、JSON、JavaScript、TypeScript、Markdown、CSS、HTML 等文本文件；单文件上限 1.5 MB。</p></div></div>}</div>
      </div><div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-slate-50/70 px-4 py-2.5 text-[10px] text-muted-foreground"><span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-emerald-600" />写入前自动备份 · 自动忽略 node_modules / .git / 构建产物</span>{current?.modifiedAt && <span>上次修改：{new Date(current.modifiedAt).toLocaleString("zh-CN")}</span>}</div></Card>
  </>
}

function logFileLabel(file: string) {
  const match = file.match(/^(command|error)(?:\.(\d{4}-\d{2}-\d{2}))?\.log$/)
  if (!match) return file
  const type = match[1] === "command" ? "命令日志" : "错误日志"
  return `${match[2] || "当前"} · ${type}`
}

const ansiForegroundColors: Record<number, string> = {
  30: "#cbd5e1", 31: "#f87171", 32: "#4ade80", 33: "#facc15",
  34: "#60a5fa", 35: "#e879f9", 36: "#22d3ee", 37: "#e2e8f0",
  90: "#94a3b8", 91: "#fb7185", 92: "#4ade80", 93: "#fde047",
  94: "#60a5fa", 95: "#f0abfc", 96: "#67e8f9", 97: "#ffffff",
}

const logLevelColors: Record<string, string> = {
  MARK: ansiForegroundColors[90],
  ERRO: ansiForegroundColors[91],
  WARN: ansiForegroundColors[93],
  INFO: ansiForegroundColors[32],
  DEBU: ansiForegroundColors[94],
}

function colorizeLogLine(line: string) {
  const segments: { text: string; color?: string }[] = []
  const ansi = /\u001b\[([0-9;]*)m/g
  let cursor = 0
  let color: string | undefined

  const appendText = (text: string) => {
    const levelPattern = /\[[^\]\r\n]+\]\[(MARK|ERRO|WARN|INFO|DEBU)\]/g
    let plainCursor = 0
    for (const match of text.matchAll(levelPattern)) {
      const index = match.index ?? 0
      if (index > plainCursor) segments.push({ text: text.slice(plainCursor, index), color })
      segments.push({ text: match[0], color: logLevelColors[match[1]] })
      plainCursor = index + match[0].length
    }
    if (plainCursor < text.length) segments.push({ text: text.slice(plainCursor), color })
  }

  for (const match of line.matchAll(ansi)) {
    const index = match.index ?? 0
    if (index > cursor) appendText(line.slice(cursor, index))
    const codes = (match[1] || "0").split(";").map(Number)
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i]
      if (code === 0 || code === 39) color = undefined
      else if (ansiForegroundColors[code]) color = ansiForegroundColors[code]
      else if (code === 38 && codes[i + 1] === 2 && codes.length > i + 4) {
        color = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`
        i += 4
      } else if (code === 38 && codes[i + 1] === 5 && codes.length > i + 2) {
        const value = codes[i + 2]
        if (value < 16) {
          color = ansiForegroundColors[value < 8 ? value + 30 : value + 82]
        } else if (value < 232) {
          const channel = (part: number) => part === 0 ? 0 : 55 + part * 40
          const n = value - 16
          color = `rgb(${channel(Math.floor(n / 36))}, ${channel(Math.floor(n / 6) % 6)}, ${channel(n % 6)})`
        } else {
          const gray = 8 + (value - 232) * 10
          color = `rgb(${gray}, ${gray}, ${gray})`
        }
        i += 2
      }
    }
    cursor = index + match[0].length
  }
  if (cursor < line.length) appendText(line.slice(cursor))
  return segments.length ? segments : [{ text: "" }]
}

type LogEntry = { id: number; text: string }

function mergeLogEntries(current: LogEntry[], incoming: LogEntry[], replace = false) {
  const merged = new Map<number, LogEntry>()
  if (!replace) for (const entry of current) merged.set(entry.id, entry)
  for (const entry of incoming) {
    if (Number.isSafeInteger(entry.id) && typeof entry.text === "string") merged.set(entry.id, entry)
  }
  return [...merged.values()].sort((left, right) => left.id - right.id).slice(-600)
}

function LogViewer({ api }: { api: Api }) {
  const [files, setFiles] = useState<string[]>([])
  const [selected, setSelected] = useState("")
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [followLatest, setFollowLatest] = useState(true)
  const [wrapLines, setWrapLines] = useState(true)
  const [liveStatus, setLiveStatus] = useState<"connecting" | "connected" | "reconnecting">("connecting")
  const logCursorRef = useRef({ file: "", cursor: 0, identity: "" })
  const logViewRef = useRef<HTMLPreElement>(null)
  const refresh = useCallback(async (file?: string, jumpToLatest = false) => {
    if (jumpToLatest) setFollowLatest(true)
    setLoading(true)
    try {
      const result = await api(`/api/logs${file ? `?file=${encodeURIComponent(file)}` : ""}`)
      const snapshot: LogEntry[] = Array.isArray(result.entries)
        ? result.entries
        : String(result.content || "").split(/\r?\n/).map((text: string, id: number) => ({ id, text }))
      setFiles(result.files)
      setSelected(result.selected)
      setEntries(mergeLogEntries([], snapshot, true))
      logCursorRef.current = { file: result.selected, cursor: Number(result.cursor) || 0, identity: String(result.identity || "") }
      setError("")
    }
    catch (reason) { setError((reason as Error).message) }
    finally { setLoading(false) }
  }, [api])
  useEffect(() => { void refresh(undefined, true) }, [refresh])
  useEffect(() => {
    if (!selected) return
    let active = true
    let retryTimer = 0
    let retryCount = 0
    let socket: WebSocket | null = null
    const checkSession = () => {
      void request("/api/auth/status").then(result => {
        if (!result.authenticated) window.dispatchEvent(new Event("panel:auth-expired"))
      }).catch(() => {})
    }
    const connect = () => {
      if (!active) return
      setLiveStatus(retryCount ? "reconnecting" : "connecting")
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:"
      socket = new WebSocket(`${scheme}//${window.location.host}/api/logs/ws`)
      socket.onopen = () => {
        if (!active || !socket) return
        retryCount = 0
        setLiveStatus("connected")
        const checkpoint = logCursorRef.current
        socket.send(JSON.stringify({
          type: "subscribe",
          file: selected,
          cursor: checkpoint.file === selected ? checkpoint.cursor : null,
          identity: checkpoint.file === selected ? checkpoint.identity : "",
        }))
      }
      socket.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data))
          if (message.type !== "logs" || message.file !== selected || !Array.isArray(message.entries)) return
          setEntries(current => mergeLogEntries(current, message.entries, Boolean(message.replace)))
          logCursorRef.current = { file: selected, cursor: Number(message.cursor) || 0, identity: String(message.identity || "") }
        } catch {}
      }
      socket.onerror = () => socket?.close()
      socket.onclose = event => {
        if (!active) return
        if (event.code === 4401) {
          window.dispatchEvent(new Event("panel:auth-expired"))
          return
        }
        if (event.code === 1006) checkSession()
        setLiveStatus("reconnecting")
        const delay = Math.min(10_000, 500 * (2 ** Math.min(retryCount, 5)))
        retryCount += 1
        retryTimer = window.setTimeout(connect, delay)
      }
    }
    connect()
    const catchupTimer = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "catchup" }))
    }, 10_000)
    return () => {
      active = false
      window.clearTimeout(retryTimer)
      window.clearInterval(catchupTimer)
      socket?.close()
    }
  }, [selected])
  useEffect(() => {
    if (followLatest && logViewRef.current) logViewRef.current.scrollTop = logViewRef.current.scrollHeight
  }, [entries, followLatest])
  const visibleEntries = useMemo(() => entries.filter(entry => !search || entry.text.toLowerCase().includes(search.toLowerCase())), [entries, search])
  return <>
    <PageIntro eyebrow="Runtime logs" title="运行日志" description="默认打开今天的命令日志最新内容；文件更新会实时推送，断线后自动重连并补取最近 50 条。" action={<div className="flex gap-2"><Button variant={wrapLines ? "secondary" : "outline"} onClick={() => setWrapLines(value => !value)}>{wrapLines ? "关闭自动换行" : "自动换行"}</Button><Button variant="outline" onClick={() => refresh(selected, true)} disabled={loading}>{loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}刷新日志</Button></div>} />
    {error && <div className="mb-4"><ErrorState message={error} /></div>}
    <Card className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"><div className="flex flex-wrap items-center gap-2"><TerminalSquare className="size-4 text-indigo-500" /><label htmlFor="log-file-select" className="text-xs font-medium">日期与类型</label><select id="log-file-select" value={selected} onChange={event => void refresh(event.target.value, true)} className="h-9 min-w-56 rounded-lg border border-border bg-white px-3 text-xs text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" disabled={!files.length}>{files.length ? files.map(file => <option key={file} value={file}>{logFileLabel(file)}</option>) : <option value="">没有可用日志</option>}</select></div><div className="relative w-full sm:w-64"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><Input className="h-9 pl-9 text-xs" placeholder="搜索日志内容…" value={search} onChange={event => setSearch(event.target.value)} /></div></div><div className="flex items-center justify-between px-4 py-2 text-[10px] text-muted-foreground"><span>{selected ? `${logFileLabel(selected)} · ${selected}` : "没有可用日志"}</span><span className="flex items-center gap-3"><span>{visibleEntries.length} 行 · 保留末尾最多 600 行</span><span className="inline-flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${liveStatus === "connected" ? "bg-emerald-500" : "bg-amber-400"}`} />{liveStatus === "connected" ? "实时连接" : liveStatus === "connecting" ? "正在连接" : "正在重连"}</span></span></div><pre ref={logViewRef} onScroll={event => { const element = event.currentTarget; setFollowLatest(element.scrollHeight - element.scrollTop - element.clientHeight <= 48) }} className={`scrollbar-thin min-h-[560px] max-h-[calc(100vh-300px)] overflow-auto bg-[#171a26] p-4 font-mono text-[11px] leading-[1.75] text-slate-200 ${wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>{loading && !entries.length ? "正在读取…" : visibleEntries.length ? visibleEntries.map((entry, index) => <span key={`${selected}-${entry.id}-${index}`} className="block min-h-[1.75em]">{colorizeLogLine(entry.text).map((segment, segmentIndex) => <span key={segmentIndex} style={segment.color ? { color: segment.color } : undefined}>{segment.text}</span>)}</span>) : "暂无日志内容"}</pre><div className="flex items-center gap-2 border-t border-border px-4 py-3 text-[10px] text-muted-foreground"><Activity className="size-3.5 text-emerald-500" />文件变更会即时推送，并每 10 秒补取最近 50 条；滚动查看旧内容后会暂停自动跟随</div></Card>
  </>
}
