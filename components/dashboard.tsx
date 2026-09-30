"use client"

import { cn } from "@/lib/utils"
import { createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CapErrorEvent, CapSolveEvent, CapWidget as CapWidgetElement } from "cap-widget"
import dynamic from "next/dynamic"
import packageInfo from "@/package.json"
import { Collapse, useExitPresence } from "@/components/ui/motion"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { Toast } from "@/components/ui/toast"
import { FieldHelp } from "@/components/ui/field-help"
import { ConfirmPopover } from "@/components/ui/confirm-popover"
import { FrontendUpdater } from "@/components/frontend-updater"
import * as Dialog from "@radix-ui/react-dialog"
import Cropper, { type Area } from "react-easy-crop"
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, Bell, Bot, Braces, Check, ChevronDown, ChevronLeft,
  ChevronRight, CircleHelp, Clock3, Command, Cpu, Database, FileCode2, FileCog,
  Ellipsis, Eye, EyeOff, FileText, Folder, Gauge, Github, HardDrive, Image as ImageIcon, KeyRound, LayoutDashboard, LoaderCircle,
  LogOut, Maximize2, Menu, MessageSquareText, Minimize2, Monitor, Pencil, Plug, Plus, RefreshCw, Search, Send,
  Server, Settings2, Sparkles, TerminalSquare, Upload, UserRound, Users, X,
  WrapText,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command as CommandMenu, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Switch } from "@/components/ui/switch"
import { SchemaOptions } from "@/components/schema-options"
import { PluginTools, ScriptInstaller, ProxyFields } from "@/components/plugin-tools"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

const MonacoCodeEditor = dynamic(
  () => import("@/components/monaco-code-editor").then(module => module.MonacoCodeEditor),
  { ssr: false, loading: () => <div className="min-h-[545px] flex-1 animate-pulse bg-muted" /> },
)

type SecretInputProps = Omit<React.ComponentProps<typeof Input>, "type">
const MAX_AVATAR_BYTES = 1_500_000
const SECURITY_ENTRANCE_WARNING_MS = 30_000

function SecretInput({ className, ...props }: SecretInputProps) {
  const [visible, setVisible] = useState(false)
  return <div className="relative">
    <Input {...props} type={visible ? "text" : "password"} className={`pr-11 ${className || ""}`} />
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="absolute right-0 top-0 h-10 w-10 rounded-xl text-muted-foreground hover:text-foreground"
      aria-label={visible ? "隐藏内容" : "显示内容"}
      aria-pressed={visible}
      title={visible ? "隐藏内容" : "显示内容"}
      onClick={() => setVisible(current => !current)}
    >{visible ? <EyeOff /> : <Eye />}</Button>
  </div>
}

function ColorPickerField({ value, label, placeholder, onChange }: { value: string; label: string; placeholder?: string; onChange: (value: string) => void }) {
  const isHexColor = /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value)
  const pickerValue = isHexColor && value.length === 4
    ? `#${[...value.slice(1)].map(channel => channel + channel).join("")}`
    : isHexColor ? value : "#000000"
  return <div className="flex w-fit max-w-full items-center gap-2">
    <Input
      type="color"
      aria-label={`${label}颜色选择器`}
      className="h-10 w-12 shrink-0 cursor-pointer p-1"
      value={pickerValue}
      disabled={Boolean(value) && !isHexColor}
      onChange={event => onChange(event.target.value)}
    />
    <Input
      type="text"
      aria-label={`${label}颜色值`}
      className="w-36 shrink-0 font-mono"
      value={value}
      placeholder={placeholder || "#RRGGBB"}
      onChange={event => onChange(event.target.value)}
    />
  </div>
}

type Section = "overview" | "accounts" | "config" | "plugins" | "files" | "logs" | "debug" | "rules"
type Notice = { kind: "success" | "error" | "info"; message: string; exiting: boolean } | null
type Api = (url: string, init?: RequestInit) => Promise<any>
type Confirm = (message: string) => Promise<boolean>
type FriendOption = { id: string; name: string; avatar: string }
type GroupOption = { id: string; name: string; avatar: string }
type AccountProfileField = "nickname" | "avatar" | "signature" | "sex" | "age"
type ManagedAccount = {
  id: string
  online: boolean
  status: string
  nickname: string
  avatar: string
  profile: { nickname: string; avatar: string; signature: string; signatureReadStatus: "available" | "unavailable" | "unsupported"; sex: string; age: number | null; area: string }
  capabilities: Record<AccountProfileField, boolean>
}

const navigation: { id: Section; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "运行概览", icon: LayoutDashboard },
  { id: "accounts", label: "账号管理", icon: UserRound },
  { id: "config", label: "配置中心", icon: Settings2 },
  { id: "plugins", label: "插件控制", icon: Plug },
  { id: "files", label: "文件管理", icon: FileCode2 },
  { id: "logs", label: "运行日志", icon: TerminalSquare },
  { id: "debug", label: "消息调试", icon: MessageSquareText },
  { id: "rules", label: "正则查询", icon: Search },
]

function sectionPath(section: Section) {
  return section === "overview" ? "/" : `/${section}/`
}

function sectionFromPath(pathname: string): Section {
  const name = pathname.split("/").filter(Boolean)[0]
  return navigation.find(item => item.id === name)?.id || "overview"
}

function routeQuery(name: string) {
  return new URLSearchParams(window.location.search).get(name) || ""
}

function setRouteQuery(name: string, value: string) {
  const url = new URL(window.location.href)
  if (value) url.searchParams.set(name, value)
  else url.searchParams.delete(name)
  window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`)
}

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

const configFileCompactLabels: Record<string, string> = {
  "bot.yaml": "机器人",
  "db.yaml": "数据库",
  "group.yaml": "群组",
  "notice.yaml": "通知",
  "other.yaml": "其他",
  "qq.yaml": "QQ 账号",
  "redis.yaml": "Redis",
  "renderer.yaml": "渲染",
}

const configFileIcons: Record<string, typeof Bot> = {
  "bot.yaml": Bot,
  "db.yaml": Database,
  "group.yaml": Users,
  "notice.yaml": Bell,
  "other.yaml": Settings2,
  "qq.yaml": MessageSquareText,
  "redis.yaml": Server,
  "renderer.yaml": Monitor,
}

const configFileIconColors: Record<string, string> = {
  "bot.yaml": "text-muted-foreground",
  "db.yaml": "text-muted-foreground",
  "group.yaml": "text-muted-foreground",
  "notice.yaml": "text-muted-foreground",
  "other.yaml": "text-muted-foreground",
  "qq.yaml": "text-muted-foreground",
  "redis.yaml": "text-muted-foreground",
  "renderer.yaml": "text-muted-foreground",
}

const configFieldLabels: Record<string, string> = {
  log_level: "日志输出等级",
  ignore_self: "过滤机器人自身消息",
  resend: "风控时尝试分片发送",
  sendmsg_error: "发送失败时通知主人",
  restart_port: "重启接口端口",
  ffmpeg_path: "FFmpeg 路径",
  ffprobe_path: "FFprobe 路径",
  chromium_path: "Chromium 路径",
  puppeteer_ws: "Puppeteer 连接地址",
  puppeteer_timeout: "Puppeteer 超时时间（毫秒）",
  puppeteer_idle: "Puppeteer 空闲关闭时间（毫秒）",
  proxyAddress: "代理地址",
  online_msg: "上线时发送帮助",
  online_msg_exp: "上线帮助冷却时间（秒）",
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
  isInheritDefault: "继承全局配置",
  disable: "禁用的功能名称",
  onlyReplyAt: "群聊触发方式",
  botAlias: "机器人别名与触发前缀",
  ignoreOtherBotAt: "忽略对其他机器人的 @",
  otherBotQQ: "其他机器人 QQ 号",
  imgAddLimit: "添加表情权限",
  imgMaxSize: "表情图片大小上限（MB）",
  addPrivate: "允许私聊添加表情",
  enable: "仅启用的功能名称",
  iyuu: "IYUU 推送密钥",
  sct: "Server 酱 SendKey",
  feishu_webhook: "飞书机器人 Webhook",
  autoFriend: "自动同意好友申请",
  autoQuit: "自动退群人数阈值",
  masterQQ: "主人 QQ 号",
  disableGuildMsg: "禁用频道消息",
  disablePrivate: "限制普通私聊",
  disableMsg: "私聊限制提示内容",
  disableAdopt: "私聊放行正则",
  whiteGroup: "群组白名单",
  whiteQQ: "用户白名单",
  blackGroup: "群组黑名单",
  blackQQ: "用户黑名单",
  qq: "QQ 账号",
  pwd: "登录密码",
  platform: "QQ 登录设备类型",
  path: "数据路径",
  host: "Redis 主机地址",
  port: "Redis 端口",
  username: "Redis 用户名",
  password: "Redis 密码",
  db: "Redis 数据库编号",
  name: "渲染引擎名称",
}

const configFieldDescriptions: Record<string, string> = {
  log_level: "日志等级：trace、debug、info、warn、fatal、mark、error、off。mark 只显示命令日志。",
  online_msg: "Bot 上线后，向配置中的首个主人 QQ 发送帮助内容。",
  online_msg_exp: "同一 Bot 再次发送上线帮助前的等待时间，单位为秒。",
  onlyReplyAt: "0：群消息无需前缀；1：仅响应 @ 机器人或别名前缀；2：主人无需前缀，其他人仍需 @ 或别名前缀。仅在配置了机器人别名时生效。",
  imgAddLimit: "0：所有群员；1：群管理员；2：仅主人可添加表情。",
  addPrivate: "控制是否允许通过私聊添加表情，0 禁止，1 允许。",
  autoFriend: "开启后自动同意添加好友请求；关闭时不自动处理。",
  autoQuit: "Bot 加入群后，人数达到此值或更少时自动退群；群内有主人或 Bot 是群主时不会退群，0 关闭。",
  platform: "ICQQ 客户端构造时需要有效设备类型，即使跳过 ICQQ 登录也必须设置。",
  restart_port: "重启 API 使用的端口，仅在启用 ksr.js 时生效。",
  imgMaxSize: "添加表情时允许的图片大小上限，单位 MB。",
  puppeteer_timeout: "Puppeteer 截图超时时间，单位毫秒；留空或 0 使用默认行为。",
  puppeteer_idle: "浏览器空闲达到此时间后自动关闭以释放资源；单位毫秒，0 表示不自动关闭。",
  skip_login: "开启后不登录 ICQQ，但仍会加载 Yunzai 插件，Bot 使用占位 QQ 号运行。",
  serial_load: "逐个等待插件加载完成后再加载下一个；关闭时并行加载。",
}

const configSelectOptions: Record<string, { value: string; label: string }[]> = {
  log_level: ["trace", "debug", "info", "warn", "fatal", "mark", "error", "off"].map(value => ({ value, label: value })),
  dialect: ["mysql", "postgres", "sqlite", "db2", "mariadb", "mssql"].map(value => ({ value, label: value })),
  platform: [
    { value: "1", label: "Android 手机" },
    { value: "2", label: "Android 平板" },
    { value: "3", label: "Android 手表" },
    { value: "4", label: "macOS" },
    { value: "5", label: "iPad" },
    { value: "6", label: "Tim" },
  ],
  onlyReplyAt: [
    { value: "0", label: "不要求 @ 或前缀" },
    { value: "1", label: "所有人需 @ 机器人或使用别名前缀" },
    { value: "2", label: "主人免前缀，其他人需 @ 或使用别名前缀" },
  ],
  imgAddLimit: [
    { value: "0", label: "所有群员" },
    { value: "1", label: "群管理员" },
    { value: "2", label: "仅主人" },
  ],
}
const numericConfigSelectFields = new Set(["platform", "onlyReplyAt", "imgAddLimit"])

function configFileLabel(file: string) {
  return configFileLabels[file] || file
}

function ConfigFileIcon({ file, className = "" }: { file: string; className?: string }) {
  const Icon = configFileIcons[file] || FileCog
  return <Icon className={`${configFileIconColors[file] || "text-muted-foreground"} ${className}`} aria-hidden="true" />
}

function configFieldLabel(name: string) {
  if (name === "default") return "全局配置"
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

function formatCount(value: number | null | undefined) {
  return value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value)
}

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return [days ? `${days} 天` : "", `${hours} 小时`, `${minutes} 分钟`].filter(Boolean).join(" ")
}

function ErrorState({ message }: { message: string }) {
  return <div className="flex items-start gap-3 rounded-xl border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 p-4 text-sm text-rose-700 dark:text-rose-300"><CircleHelp className="mt-0.5 size-4 shrink-0" />{message}</div>
}

type SecurityEntranceWarning = { seconds: number; exiting: boolean; onDismiss: () => void; onExited: () => void }

function SecurityEntranceWarningToast({ seconds, exiting, onDismiss, onExited }: SecurityEntranceWarning) {
  return <Toast exiting={exiting} onExited={onExited} role="alert" aria-live="assertive" className="flex w-full items-start gap-2.5 rounded-lg border border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-950 dark:text-amber-300 shadow-xl">
    <CircleHelp className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
    <div className="min-w-0 flex-1">
      <p className="font-semibold">尚未配置安全入口</p>
      <p className="mt-1 text-xs leading-5 text-amber-900 dark:text-amber-300">请前往“插件控制 → EliaAdminPanel → 登录安全”设置安全入口路径，避免登录页与登录接口直接暴露。</p>
      <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">{seconds > 0 ? `${seconds} 秒后可关闭` : "现在可以关闭此提醒"}</p>
    </div>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={seconds > 0 ? `${seconds} 秒后可关闭安全入口提醒` : "关闭安全入口提醒"}
      title={seconds > 0 ? `${seconds} 秒后可关闭` : "关闭提醒"}
      disabled={seconds > 0 || exiting}
      className="size-8 shrink-0 text-amber-900 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
      onClick={onDismiss}
    ><X /></Button>
  </Toast>
}

function Login({ onLogin, initialError = "", imageApi, capApiEndpoint, securityEntranceWarning }: { onLogin: (expiresAt: number) => void; initialError?: string; imageApi: string; capApiEndpoint: string; securityEntranceWarning: SecurityEntranceWarning | null }) {
  const [captchaWidget, setCaptchaWidget] = useState<CapWidgetElement | null>(null)
  const [captchaWidgetReady, setCaptchaWidgetReady] = useState(false)
  const [mode, setMode] = useState<"code" | "password">("code")
  const [password, setPassword] = useState("")
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const [code, setCode] = useState("")
  const [captchaToken, setCaptchaToken] = useState("")
  const [codeToast, setCodeToast] = useState("")
  const [codeToastExiting, setCodeToastExiting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(initialError)
  const [expiresAt, setExpiresAt] = useState(0)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => { setImageLoaded(false); setImageFailed(false) }, [imageApi])

  useEffect(() => {
    let active = true
    if (!capApiEndpoint) {
      setCaptchaWidgetReady(false)
      return () => { active = false }
    }
    void import("cap-widget").then(() => {
      if (active) setCaptchaWidgetReady(true)
    }).catch(() => {
      if (active) setError("人机验证组件加载失败，请刷新页面后重试")
    })

    return () => { active = false }
  }, [capApiEndpoint])

  useEffect(() => {
    const widget = captchaWidget
    if (!captchaWidgetReady || !widget) return
    const handleSolve = (event: CapSolveEvent) => {
      setCaptchaToken(event.detail.token)
      setError("")
    }
    const handleReset = () => setCaptchaToken("")
    const handleError = (event: CapErrorEvent) => {
      setCaptchaToken("")
      setError(event.detail.message || "人机验证失败，请重试")
    }
    widget.addEventListener("solve", handleSolve)
    widget.addEventListener("reset", handleReset)
    widget.addEventListener("error", handleError)
    return () => {
      widget.removeEventListener("solve", handleSolve)
      widget.removeEventListener("reset", handleReset)
      widget.removeEventListener("error", handleError)
    }
  }, [captchaWidget, captchaWidgetReady])

  useEffect(() => {
    if (!expiresAt) return
    const update = () => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])

  useEffect(() => {
    if (!codeToast) return
    const timer = window.setTimeout(() => setCodeToastExiting(true), 30_000)
    return () => window.clearTimeout(timer)
  }, [codeToast])

  async function requestCode() {
    if (capApiEndpoint && !captchaToken) {
      setError("请先完成人机验证")
      return
    }
    setBusy(true)
    setError("")
    try {
      const result = await request("/api/auth/code/request", { method: "POST", body: JSON.stringify(capApiEndpoint ? { "cap-token": captchaToken } : {}) })
      setExpiresAt(Date.now() + result.expiresIn * 1000)
      setCodeToastExiting(false)
      setCodeToast(`${result.message || "验证码已写入本机凭据文件"}`)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
      captchaWidget?.reset()
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (capApiEndpoint && !captchaToken) {
      setError("请先完成人机验证")
      return
    }
    setBusy(true)
    setError("")
    try {
      let session: any
      const capToken = capApiEndpoint ? { "cap-token": captchaToken } : {}
      if (mode === "code") {
        session = await request("/api/auth/code/check", { method: "POST", body: JSON.stringify({ code, ...capToken }) })
      } else {
        session = await request("/api/auth/login", { method: "POST", body: JSON.stringify({ password, ...capToken }) })
      }
      onLogin(session.expiresAt)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
      captchaWidget?.reset()
    }
  }
  return (
    <main className="admin-login-shell relative isolate grid min-h-dvh place-items-center overflow-hidden px-5 py-20 lg:py-12">
      <div className="admin-login-bg" aria-hidden="true" />
      <ThemeSwitcher className="fixed right-4 top-4 z-20 w-36" />
      <div className="admin-login grid w-full min-w-0 grid-cols-1 max-w-[430px] items-stretch overflow-hidden rounded-2xl border border-border/70 lg:max-w-[1080px] lg:grid-cols-[minmax(0,1fr)_430px]">
      <section aria-label="登录图片" className="admin-login-art relative aspect-video w-full min-w-0 overflow-hidden bg-muted lg:aspect-auto">
        {!imageFailed && <img src={imageApi} alt="登录页展示图片" data-loaded={imageLoaded} onLoad={() => setImageLoaded(true)} onError={() => setImageFailed(true)} className="absolute inset-0 size-full object-cover" />}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/15 to-transparent" aria-hidden="true" />
        <div className="absolute inset-x-0 bottom-0 p-6 text-white" aria-hidden="true">
          <p className="mb-2 text-[10px] font-medium tracking-[0.22em] text-white/70">ELIA / 控制台</p>
          <p className="text-xl font-semibold tracking-tight drop-shadow">让管理更轻松</p>
          <p className="mt-1 text-xs text-white/85">面向 Yunzai 机器人的一站式管理控制台</p>
        </div>
      </section>
      <Card className="flex min-h-[430px] w-full min-w-0 max-w-[430px] flex-col rounded-none border-0 bg-card/95 shadow-none backdrop-blur-sm sm:min-h-[520px]">
        <CardHeader className="px-5 pt-7 sm:px-8 sm:pt-9">
          <div className="mb-4 flex items-center gap-4">
            <div className="admin-login-logo grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl p-1"><img src="/elia.png" alt="EliaAdminPanel" className="size-full object-contain" /></div>
            <div className="min-w-0">
              <CardTitle className="min-w-0 text-2xl">登录到 Elia Panel</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">验证身份以进入管理控制台</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col px-5 pb-6 sm:px-8 sm:pb-8">
          <Tabs value={mode} onValueChange={value => { setMode(value as "code" | "password"); setPasswordVisible(false); setError("") }} className="mb-5"><TabsList aria-label="登录方式" data-mode={mode} className="admin-login-tabs grid h-10 w-full grid-cols-2"><TabsTrigger value="code">验证码登录</TabsTrigger><TabsTrigger value="password">面板密码</TabsTrigger></TabsList></Tabs>
          <form onSubmit={submit} className="admin-form-enter space-y-4">
            {mode === "code" ? <>
              <div key="code" className="admin-form-enter flex h-11 w-full items-center overflow-hidden rounded-xl border border-input bg-card shadow-xs transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
                <Input autoFocus id="panel-code" aria-label="验证码" type="text" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.trim())} className="h-full w-auto min-w-0 flex-1 rounded-none border-0 bg-transparent px-4 shadow-none focus-visible:ring-0" />
                <Button type="button" variant="ghost" className="h-full shrink-0 rounded-none px-4 text-sm font-medium text-primary hover:bg-accent hover:text-accent-foreground" disabled={busy || remaining > 0 || (Boolean(capApiEndpoint) && !captchaToken)} onClick={requestCode}>
                  {busy && <LoaderCircle className="animate-spin" />}
                  {remaining > 0 ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}` : "获取验证码"}
                </Button>
              </div>
            </> : <div key="password" className="admin-form-enter flex h-11 w-full items-center overflow-hidden rounded-xl border border-input bg-card shadow-xs transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
              <Input autoFocus id="panel-password" aria-label="面板密码" type={passwordVisible ? "text" : "password"} autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} className="h-full w-auto min-w-0 flex-1 rounded-none border-0 bg-transparent px-4 shadow-none focus-visible:ring-0" />
              <Button type="button" variant="ghost" size="icon" className="mr-1 size-9 shrink-0 text-muted-foreground" aria-label={passwordVisible ? "隐藏密码" : "显示密码"} aria-controls="panel-password" aria-pressed={passwordVisible} onClick={() => setPasswordVisible(current => !current)}>{passwordVisible ? <EyeOff /> : <Eye />}</Button>
            </div>}
            {capApiEndpoint && <div className="admin-cap-wrapper" aria-label="人机验证">
              {captchaWidgetReady ? createElement("cap-widget", {
                ref: setCaptchaWidget,
                "data-cap-api-endpoint": capApiEndpoint,
                "data-cap-i18n-group-aria-label": "人机验证",
                "data-cap-i18n-initial-state": "点击验证你是人类",
                "data-cap-i18n-verifying-label": "正在验证...",
                "data-cap-i18n-solved-label": "验证通过",
                "data-cap-i18n-error-label": "验证失败",
                "data-cap-i18n-verify-aria-label": "点击完成安全验证",
                "data-cap-i18n-verifying-aria-label": "正在验证，请稍候",
                "data-cap-i18n-verified-aria-label": "验证通过",
                "data-cap-i18n-error-aria-label": "安全验证失败，请重试",
              }) : <div className="admin-cap-loading" role="status"><LoaderCircle className="size-4 animate-spin" />正在加载人机验证…</div>}
            </div>}
            {error && <ErrorState message={error} />}
            <Button className="admin-login-submit h-11 w-full rounded-xl px-12 font-semibold" disabled={busy || (Boolean(capApiEndpoint) && !captchaToken) || (mode === "code" ? !code : !password)}>{busy ? <LoaderCircle className="animate-spin" /> : mode === "password" ? <KeyRound /> : null}{busy ? "正在验证身份…" : mode === "code" ? "立即登录" : "进入控制台"}{!busy && <ArrowRight className="admin-login-arrow" />}</Button>
          </form>
          <div className="mt-auto space-y-2 border-t pt-4 text-center text-xs leading-5 text-muted-foreground">
            <p>主人可私聊 Bot 发送 <code className="rounded bg-muted px-1.5 py-0.5">#elia登录</code> 获取快捷登录地址</p>
          </div>
        </CardContent>
      </Card>
      </div>
      {(codeToast || securityEntranceWarning) && <div className="fixed right-4 top-4 z-[1100] flex w-[min(480px,calc(100vw-32px))] flex-col items-end gap-2 pointer-events-none sm:right-6 sm:top-6">
        {securityEntranceWarning && <SecurityEntranceWarningToast {...securityEntranceWarning} />}
        {codeToast && <Toast exiting={codeToastExiting} onExited={() => { setCodeToast(""); setCodeToastExiting(false) }} className="flex items-start gap-2.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-card px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300 shadow-xl"><Check className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 break-words [overflow-wrap:anywhere]">{codeToast}</span></Toast>}
      </div>}
    </main>
  )
}

export default function Dashboard({ initialSection = "overview" }: { initialSection?: Section }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null)
  const [loginImageApi, setLoginImageApi] = useState("https://t.alcy.cc/moez")
  const [capApiEndpoint, setCapApiEndpoint] = useState("")
  const [loginError, setLoginError] = useState("")
  const [section, setSection] = useState<Section>(initialSection)
  const [fileManagerPath, setFileManagerPath] = useState(() => typeof window === "undefined" ? "." : routeQuery("path") || ".")
  const [notice, setNotice] = useState<Notice>(null)
  const [securityEntranceWarningDeadline, setSecurityEntranceWarningDeadline] = useState<number | null>(null)
  const [securityEntranceWarningSeconds, setSecurityEntranceWarningSeconds] = useState(30)
  const [securityEntranceWarningExiting, setSecurityEntranceWarningExiting] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const confirmationResolver = useRef<((confirmed: boolean) => void) | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const sidebarPresent = useExitPresence(sidebarOpen)
  const [sidebarCollapsed, setSidebarCollapsed] = useBrowserBooleanPreference("mainSidebarCollapsed")
  const [restartAvailable, setRestartAvailable] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartAnchor, setRestartAnchor] = useState<HTMLButtonElement | null>(null)
  const closeRestartConfirmation = useCallback(() => setRestartAnchor(null), [])
  const api: Api = useCallback((url, init) => request(url, init), [])
  const confirm = useCallback<Confirm>((message: string) => new Promise<boolean>(resolve => {
    if (confirmationResolver.current) {
      resolve(false)
      return
    }
    confirmationResolver.current = resolve
    setConfirmation(message)
  }), [])
  const resolveConfirmation = useCallback((confirmed: boolean) => {
    const resolve = confirmationResolver.current
    confirmationResolver.current = null
    setConfirmation(null)
    resolve?.(confirmed)
  }, [])
  const notify = useCallback((kind: "success" | "error" | "info", message: string) => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    setNotice({ kind, message, exiting: false })
    noticeTimer.current = window.setTimeout(() => {
      setNotice(current => current ? { ...current, exiting: true } : null)
    }, 4200)
  }, [])
  const navigateTo = useCallback((nextSection: Section, accountId?: string) => {
    if (nextSection === "files") setFileManagerPath(".")
    const target = nextSection === "accounts" && accountId
      ? `${sectionPath(nextSection)}?account=${encodeURIComponent(accountId)}`
      : sectionPath(nextSection)
    window.history.pushState(null, "", target)
    setSection(nextSection)
    setSidebarOpen(false)
  }, [])

  useEffect(() => {
    const syncRoute = () => {
      setSection(sectionFromPath(window.location.pathname))
      setFileManagerPath(routeQuery("path") || ".")
    }
    window.addEventListener("popstate", syncRoute)
    return () => window.removeEventListener("popstate", syncRoute)
  }, [])

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    confirmationResolver.current?.(false)
    confirmationResolver.current = null
  }, [])

  useEffect(() => {
    const handler = (event: Event) => {
      const requestedPath = (event as CustomEvent<string>).detail
      setFileManagerPath(requestedPath || "plugins")
      window.history.pushState(null, "", `/files/?path=${encodeURIComponent(requestedPath || "plugins")}`)
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
    if (!authenticated) return
    let active = true
    const refresh = () => api("/api/status")
      .then(result => { if (active) setRestartAvailable(Boolean(result.restartAvailable)) })
      .catch(() => { if (active) setRestartAvailable(false) })
    refresh()
    const timer = window.setInterval(refresh, 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [authenticated, api])

  useEffect(() => { setRestartAnchor(null) }, [section, sidebarCollapsed, sidebarOpen, authenticated])

  useEffect(() => {
    let active = true
    const quickCode = window.location.hash.match(/^#\/(?:ml|quick)\/([^/?#]+)/)?.[1]
    const statusRequest = request("/api/auth/status")
      .then(result => {
        if (active) {
          setLoginImageApi(result.loginImageApi || "https://t.alcy.cc/moez")
          setCapApiEndpoint(result.capApiEndpoint || "")
          if (process.env.NODE_ENV !== "development" && result.securityEntranceConfigured === false) {
            setSecurityEntranceWarningDeadline(Date.now() + SECURITY_ENTRANCE_WARNING_MS)
            setSecurityEntranceWarningSeconds(30)
          } else {
            setSecurityEntranceWarningDeadline(null)
            setSecurityEntranceWarningExiting(false)
          }
        }
        return result
      })
      .catch(() => null)
    if (quickCode) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
      request("/api/auth/quick", { method: "POST", body: JSON.stringify({ code: quickCode }) })
        .then(result => {
          if (!active) return
          setSessionExpiresAt(result.expiresAt)
          notify("success", "登录成功！欢迎回来，主人~")
          setAuthenticated(true)
        })
        .catch(reason => {
          if (!active) return
          setLoginError((reason as Error).message)
          setAuthenticated(false)
        })
    } else {
      statusRequest
        .then(result => {
          if (!active) return
          setSessionExpiresAt(result?.authenticated ? result.expiresAt : null)
          setAuthenticated(Boolean(result?.authenticated))
        })
    }
    return () => { active = false }
  }, [notify])

  useEffect(() => {
    if (securityEntranceWarningDeadline === null) return
    const update = () => setSecurityEntranceWarningSeconds(Math.max(0, Math.ceil((securityEntranceWarningDeadline - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [securityEntranceWarningDeadline])

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

  function dismissSecurityEntranceWarning() {
    if (securityEntranceWarningDeadline === null || Date.now() < securityEntranceWarningDeadline) return
    setSecurityEntranceWarningExiting(true)
  }

  const securityEntranceWarning = securityEntranceWarningDeadline === null
    ? null
    : { seconds: securityEntranceWarningSeconds, exiting: securityEntranceWarningExiting, onDismiss: dismissSecurityEntranceWarning, onExited: () => { setSecurityEntranceWarningDeadline(null); setSecurityEntranceWarningExiting(false) } }

  if (authenticated === null) return <main className="grid min-h-screen place-items-center text-muted-foreground"><LoaderCircle className="size-7 animate-spin" /></main>
  if (!authenticated) return <Login imageApi={loginImageApi} capApiEndpoint={capApiEndpoint} initialError={loginError} securityEntranceWarning={securityEntranceWarning} onLogin={expiresAt => { setLoginError(""); setSessionExpiresAt(expiresAt); notify("success", "登录成功！欢迎回来，主人~"); setAuthenticated(true) }} />

  async function logout() {
    try { await api("/api/auth/logout", { method: "POST" }) } catch {}
    setAuthenticated(false)
  }

  async function restart() {
    setRestartAnchor(null)
    if (restarting || !restartAvailable) return
    setRestarting(true)
    try { const result = await api("/api/runtime/restart", { method: "POST", body: "{}" }); notify("success", result.message || "重启请求已发送") }
    catch (reason) { notify("error", (reason as Error).message) }
    finally { setRestarting(false) }
  }

  return (
      <div className="admin-panel-shell min-h-screen" style={{ "--admin-sidebar-size": sidebarCollapsed ? "56px" : "220px", "--admin-sidebar-half-size": sidebarCollapsed ? "28px" : "110px" } as React.CSSProperties}>
      <aside data-open={sidebarOpen} data-collapsed={sidebarCollapsed} className={`admin-panel-sidebar fixed inset-y-0 left-0 z-40 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="admin-sidebar-expanded scrollbar-thin absolute inset-y-0 left-0 flex flex-col overflow-y-auto px-3 pt-5 pb-0">
          <div className="flex items-center gap-3 px-2 pb-7">
            <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-sidebar-border bg-background p-1"><img src="/elia.png" alt="EliaAdminPanel" className="size-full object-contain" /></div>
            <div className="min-w-0"><div className="truncate text-sm font-semibold tracking-tight">Elia Panel</div><div className="mt-0.5 truncate text-[10px] text-muted-foreground">机器人管理控制台</div></div>
            <Button type="button" variant="ghost" className={cn("h-auto justify-start whitespace-normal p-0", "ml-auto text-muted-foreground md:hidden")} onClick={() => setSidebarOpen(false)} aria-label="关闭菜单"><X className="size-5" /></Button>
          </div>
          <div className="px-2 pb-2 text-[10px] font-semibold tracking-wide text-muted-foreground">控制台</div>
          <nav aria-label="主导航" className="admin-nav shrink-0 space-y-1" style={{ "--nav-index": navigation.findIndex(item => item.id === section) } as React.CSSProperties}>
            {navigation.map(item => {
              const Icon = item.icon
              const selected = section === item.id
              return <Button type="button" variant="ghost" key={item.id} aria-current={selected ? "page" : undefined} aria-label={item.label} onClick={() => navigateTo(item.id)} className={cn("h-auto justify-start whitespace-normal p-0", `group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"}`)}>
                <Icon className={`size-[18px] shrink-0 ${selected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"}`} />
                <span className="min-w-0 flex-1 text-[13px] font-medium">{item.label}</span>
              </Button>
            })}
          </nav>
          <div className="admin-sidebar-actions mt-auto shrink-0 space-y-1 px-1 pb-3">
            <ThemeSwitcher sidebar />
            <Button variant="ghost" type="button" aria-label="重启 Bot" title={restartAvailable ? "重启 Bot" : "未检测到 ksr 或 PM2 守护程序"} aria-haspopup="dialog" aria-expanded={restartAnchor !== null} disabled={!restartAvailable || restarting} onClick={event => { const anchor = event.currentTarget; setRestartAnchor(current => current === anchor ? null : anchor) }} className={cn("h-auto justify-start whitespace-normal p-0", "flex h-10 w-full items-center gap-2 rounded-lg px-3 text-xs text-foreground transition hover:bg-sidebar-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40")}>{restarting ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <RefreshCw className="size-4 shrink-0" />}重启 Bot</Button>
            <Button type="button" variant="ghost" aria-label="退出登录" onClick={logout} className={cn("h-auto justify-start whitespace-normal p-0", "flex h-10 w-full items-center gap-2 rounded-lg px-3 text-xs text-muted-foreground transition hover:bg-sidebar-accent hover:text-foreground")}><LogOut className="size-4 shrink-0" />退出登录</Button>
            <div className="px-3 py-2 text-[10px] text-muted-foreground">Elia Panel <span className="float-right">{packageInfo.version}</span></div>
            <div className="-mx-1 hidden border-t border-sidebar-border pt-2 md:block"><Button type="button" variant="ghost" aria-label="收起侧边栏" aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(true)} className={cn("h-auto justify-start whitespace-normal p-0", "flex h-10 w-full items-center gap-2 rounded-lg px-3 text-xs font-medium text-foreground transition hover:bg-sidebar-accent hover:text-foreground")}><ChevronLeft className="size-4" />收起</Button></div>
          </div>
        </div>
        <div className="admin-sidebar-compact scrollbar-thin absolute inset-y-0 left-0 flex flex-col overflow-y-auto items-center px-1.5 pt-5 pb-3">
          <div title="EliaAdminPanel" className="mb-7 grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-sidebar-border bg-background p-1"><img src="/elia.png" alt="EliaAdminPanel" className="size-full object-contain" /></div>
          <nav className="admin-nav w-full shrink-0 space-y-1" aria-label="主导航" style={{ "--nav-index": navigation.findIndex(item => item.id === section) } as React.CSSProperties}>
            {navigation.map(item => {
              const Icon = item.icon
              const selected = section === item.id
              return <Button type="button" variant="ghost" key={item.id} aria-current={selected ? "page" : undefined} title={item.label} aria-label={item.label} onClick={() => navigateTo(item.id)} className={cn("h-auto justify-center whitespace-normal p-0", `group relative grid h-10 w-full place-items-center rounded-lg transition ${selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"}`)}><Icon className="size-[18px]" /></Button>
            })}
          </nav>
          <div className="admin-sidebar-actions mt-auto w-full shrink-0 space-y-1 pt-2">
            <ThemeSwitcher compact sidebar />
            <Button variant="ghost" type="button" title={restartAvailable ? "重启 Bot" : "未检测到 ksr 或 PM2 守护程序"} aria-label="重启 Bot" aria-haspopup="dialog" aria-expanded={restartAnchor !== null} disabled={!restartAvailable || restarting} onClick={event => { const anchor = event.currentTarget; setRestartAnchor(current => current === anchor ? null : anchor) }} className={cn("h-auto justify-center whitespace-normal p-0", "grid h-10 w-full place-items-center rounded-lg text-foreground transition hover:bg-sidebar-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40")}>{restarting ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}</Button>
            <Button type="button" variant="ghost" title="退出登录" aria-label="退出登录" onClick={logout} className={cn("h-auto justify-center whitespace-normal p-0", "grid h-10 w-full place-items-center rounded-lg text-muted-foreground transition hover:bg-sidebar-accent hover:text-foreground")}><LogOut className="size-4" /></Button>
            <Button type="button" variant="ghost" title="展开侧边栏" aria-label="展开侧边栏" aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(false)} className={cn("h-auto justify-center whitespace-normal p-0", "grid h-10 w-full place-items-center rounded-lg text-foreground transition hover:bg-sidebar-accent hover:text-foreground")}><ChevronRight className="size-4" /></Button>
          </div>
        </div>
      </aside>

      {sidebarPresent && <Button type="button" variant="ghost" data-state={sidebarOpen ? "open" : "closed"} inert={!sidebarOpen} className="admin-mobile-overlay h-auto p-0 fixed inset-0 z-30 bg-neutral-900/30 md:hidden" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单背景" />}
      <div className="min-h-screen">
        <Button variant="outline" size="icon" className="fixed left-4 top-4 z-30 bg-card/95 shadow-md md:hidden" aria-label="打开菜单" onClick={() => setSidebarOpen(true)}><Menu /></Button>
        <main key={section} data-motion-page={section} className={section === "files" ? "file-manager-fullscreen h-dvh min-h-0 max-w-none overflow-hidden p-0" : section === "debug" ? "h-dvh min-h-0 max-w-none overflow-hidden px-0 pb-0 pt-16 md:pt-0" : section === "logs" || section === "rules" ? "logs-fullscreen flex h-dvh min-h-0 max-w-none flex-col overflow-hidden px-0 pb-0 pt-16 md:pt-0" : section === "plugins" ? "max-w-none px-0 pb-0 pt-16 md:pt-0" : section === "config" ? "max-w-none px-0 pb-0 pt-16 md:pt-0" : "mx-auto max-w-[1600px] px-4 pb-28 pt-16 sm:px-6 md:pt-8 lg:px-9 lg:pb-32"}>
          {section === "overview" && <Overview api={api} notify={notify} navigate={navigateTo} />}
          {section === "accounts" && <AccountManager api={api} notify={notify} confirm={confirm} />}
          {section === "config" && <ConfigCenter api={api} notify={notify} confirm={confirm} />}
          {section === "plugins" && <PluginCenter api={api} notify={notify} confirm={confirm} />}
          {section === "files" && <FileManager api={api} notify={notify} confirm={confirm} initialPath={fileManagerPath} />}
          {section === "logs" && <LogViewer api={api} />}
          {section === "debug" && <MessageDebugger api={api} />}
          {section === "rules" && <PluginMatchHelper api={api} notify={notify} confirm={confirm} page />}
        </main>
      </div>
      {(notice || (authenticated && securityEntranceWarningDeadline !== null)) && <div className="fixed right-4 top-4 z-[1100] flex w-[min(480px,calc(100vw-32px))] flex-col items-end gap-2 pointer-events-none sm:right-6 sm:top-6">
        {authenticated && securityEntranceWarning && <SecurityEntranceWarningToast {...securityEntranceWarning} />}
        {notice && <Toast exiting={notice.exiting} onExited={() => setNotice(current => current?.exiting ? null : current)} aria-live="polite" className={`flex items-start gap-2.5 rounded-lg border bg-card px-4 py-3 text-sm shadow-xl ${notice.kind === "error" ? "border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300" : notice.kind === "success" ? "border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300" : "border-border text-foreground"}`}><span className="mt-0.5 shrink-0">{notice.kind === "error" ? <CircleHelp className="size-4" /> : <Check className="size-4" />}</span><span className="min-w-0 break-words [overflow-wrap:anywhere]">{notice.message}</span></Toast>}
      </div>}
      {restartAnchor && <ConfirmPopover anchor={restartAnchor} title="重启 Bot？" message="当前运行任务可能会中断。确定要重启吗？" confirmLabel="确认重启" onCancel={closeRestartConfirmation} onConfirm={restart} />}
      <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open) resolveConfirmation(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认操作</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">{confirmation ?? " "}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild><Button type="button" variant="outline">取消</Button></AlertDialogCancel>
            <AlertDialogAction asChild><Button type="button" onClick={() => resolveConfirmation(true)}>确认</Button></AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

type PageAction = { label: string; render: (iconOnly: boolean) => React.ReactNode }

function PageIntro({ actions }: { actions: PageAction[] }) {
  const [open, setOpen] = useState(false)
  if (actions.length <= 4) return <TooltipProvider delayDuration={300}><div aria-label="页面操作" className="admin-page-actions fixed bottom-4 right-4 z-30 flex flex-col gap-1.5 rounded-xl border border-border/80 bg-card/90 p-1.5 backdrop-blur-md sm:bottom-6 sm:right-6">
    {actions.map(action => <Tooltip key={action.label}><TooltipTrigger asChild>{action.render(true)}</TooltipTrigger><TooltipContent side="left" sideOffset={10}>{action.label}</TooltipContent></Tooltip>)}
  </div></TooltipProvider>
  return <div className="fixed bottom-4 right-4 z-30 sm:bottom-6 sm:right-6">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" variant="outline" size="icon" className="size-11 bg-background shadow-sm" aria-label={open ? "关闭页面操作" : "打开页面操作"} title="页面操作">{open ? <X /> : <Ellipsis />}</Button></PopoverTrigger>
      <PopoverContent side="top" align="end" className="z-[55] w-56 max-w-[calc(100vw-2rem)] p-2" aria-label="页面操作">
        <div className="flex flex-col gap-2 [&_button]:w-full [&_button]:justify-start" onClick={() => setOpen(false)}>{actions.map(action => <Fragment key={action.label}>{action.render(false)}</Fragment>)}</div>
      </PopoverContent>
    </Popover>
  </div>
}

function PluginMatchHelper({ api, notify, confirm, onSelect, selectedPatterns = [], page = false }: { api: Api; notify: any; confirm: Confirm; onSelect?: (pattern: string) => void; selectedPatterns?: string[]; page?: boolean }) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = page || localOpen
  const setOpen = setLocalOpen
  const triggerRef = useRef<HTMLElement | null>(null)
  const [groupId, setGroupId] = useState("default")
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([{ id: "default", name: "全局" }])
  const [groupName, setGroupName] = useState("全局")
  const [rules, setRules] = useState<any[]>([])
  const [blockedPluginNames, setBlockedPluginNames] = useState<string[]>([])
  const [search, setSearch] = useState("")
  const [testMessage, setTestMessage] = useState("")
  const [messageType, setMessageType] = useState<"group" | "private">(onSelect ? "private" : "group")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [scanErrors, setScanErrors] = useState<any[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const result = await api(`/api/diagnostics/plugin-rules?groupId=${encodeURIComponent(groupId)}`)
      setGroups(Array.isArray(result.groups) ? result.groups : [{ id: "default", name: "全局" }])
      setGroupName(groupId === "default" ? "全局" : String(result.groupName || groupId))
      setRules(Array.isArray(result.rules) ? result.rules : [])
      setBlockedPluginNames(Array.isArray(result.blockedPluginNames) ? result.blockedPluginNames : [])
      setScanErrors(Array.isArray(result.scanErrors) ? result.scanErrors : [])
    } catch (reason) { setError((reason as Error).message) }
    finally { setLoading(false) }
  }, [api, groupId])

  useEffect(() => { if (open) void load() }, [load, open])

  const expectedEvent = ["message", messageType, messageType === "group" ? "normal" : "friend"]
  function eventMatches(pattern: string) {
    if (!pattern) return true
    const parts = pattern.split(".")
    const resolved = parts.map((part, index) => part === "*" ? "*" : expectedEvent[index] || "")
    return pattern === resolved.join(".")
  }

  const query = search.trim().toLowerCase()
  const hasTestMessage = Boolean(testMessage.trim())
  const filteredRules = rules.filter(rule => {
    const searchable = `${rule.pluginName} ${rule.sourcePlugin} ${rule.sourceKey} ${rule.fnc} ${rule.pattern}/${rule.flags} ${rule.event} ${rule.pluginEvent}`.toLowerCase()
    if (query && !searchable.includes(query)) return false
    if (onSelect && (!eventMatches(rule.pluginEvent) || !eventMatches(rule.event) || rule.regexError)) return false
    if (!hasTestMessage) return true
    if (!eventMatches(rule.pluginEvent) || (rule.event && !eventMatches(rule.event)) || rule.regexError) return false
    try {
      const expression = new RegExp(rule.pattern, rule.flags)
      expression.lastIndex = 0
      return expression.test(testMessage)
    } catch { return false }
  })

  async function quickDisable(rule: any, scope: "name" | "source") {
    const names = scope === "source" ? rule.sourcePluginNames as string[] : [String(rule.pluginName)]
    const additions = [...new Set(names)].filter(name => name && !blockedPluginNames.includes(name))
    if (!additions.length) return
    const scopeLabel = scope === "source" ? `整个插件 ${rule.sourcePlugin}` : `子插件 ${rule.pluginName}`
    const sharedSources = [...new Set(additions.flatMap(name => Array.isArray(rule.nameSources) ? rule.nameSources : []).filter((source: string) => source !== rule.sourcePlugin))]
    const impactNote = sharedSources.length ? `\n注意：同名插件还来自 ${sharedSources.join("、")}，Yunzai 按名称屏蔽时这些来源也会一起受影响。` : ""
    if (!await confirm(`将${scopeLabel}对应的 ${additions.join("、")} 加入「${groupName}」的禁用列表，并立即刷新运行时配置？${impactNote}`)) return
    setBusy(true)
    try {
      const current = await api("/api/config/group.yaml")
      const nextData = { ...(isObject(current.data) ? current.data : {}) }
      const existing = groupId === "default" ? nextData.default : nextData[groupId]
      const target = { ...(isObject(existing) ? existing : groupId === "default" ? {} : { isInheritDefault: 1 }) }
      const currentDisabled = Array.isArray(target.disable)
        ? target.disable.map(String)
        : typeof target.disable === "string" ? target.disable.split(/\r?\n/).filter(Boolean) : []
      target.disable = [...new Set([...currentDisabled, ...additions])]
      nextData[groupId] = target
      const result = await api("/api/config/group.yaml", { method: "PUT", body: JSON.stringify({ data: nextData, baseContent: current.content, version: current.version }) })
      notify("success", result.message || `${scopeLabel}已加入禁用列表`)
      await load()
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }

  const description = onSelect ? "选择私聊规则加入放行名单，点击保存更改后生效。Yunzai 使用不带 flags 的正则，含 flags 的规则需要手动调整。" : "查找插件正则匹配，可快速屏蔽对应插件"
  const content = <>
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-5">
            <div>{page ? <><h1 className="text-2xl font-semibold tracking-tight">正则查询</h1><p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">{description}</p></> : <><Dialog.Title className="text-lg font-semibold">插件正则排查</Dialog.Title><Dialog.Description className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{description}</Dialog.Description></>}</div>
            <div className="flex shrink-0 items-center gap-1"><Button type="button" size="icon" variant="ghost" aria-label="刷新插件规则" title="刷新插件规则" onClick={() => void load()} disabled={loading}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /></Button>{!page && <Dialog.Close asChild><Button type="button" size="icon" variant="ghost" aria-label="关闭插件正则排查"><X className="size-4" /></Button></Dialog.Close>}</div>
          </div>
          <div className="grid shrink-0 gap-4 border-b border-border bg-muted/60 px-6 py-4 sm:grid-cols-2 lg:grid-cols-[minmax(180px,0.9fr)_minmax(180px,1fr)_minmax(210px,1.2fr)_auto]">
            <div className="min-w-0 space-y-2"><Label className="text-xs">{onSelect ? "规则范围" : "屏蔽作用范围"}</Label><Select value={groupId} onValueChange={setGroupId}><SelectTrigger aria-label="屏蔽作用群组" className="h-10 bg-card text-sm"><SelectValue placeholder="选择群组" /></SelectTrigger><SelectContent className="z-[70]">{groups.map(group => <SelectItem key={group.id} value={group.id}>{group.id === "default" ? "全局" : `${group.name} · ${group.id}`}</SelectItem>)}</SelectContent></Select></div>
            <div className="min-w-0 space-y-2"><Label htmlFor="plugin-rule-search" className="text-xs">搜索插件、子插件或正则</Label><div className="relative"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input id="plugin-rule-search" className="h-10 pl-9 text-sm" placeholder="名称、处理方法、正则内容…" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
            <div className="min-w-0 space-y-2"><Label htmlFor="plugin-rule-message" className="text-xs">测试消息（可选）</Label><Input id="plugin-rule-message" className="h-10 text-sm" maxLength={512} placeholder="粘贴触发的原始消息（最多 512 字）" value={testMessage} onChange={event => setTestMessage(event.target.value)} /></div>
            <div className="space-y-2"><Label className="text-xs">消息类型</Label><ToggleGroup type="single" value={messageType} onValueChange={value => { if (value) setMessageType(value as "group" | "private") }} aria-label="消息类型" className="flex h-10 items-center rounded-md border border-border bg-card p-0.5">{([["group", "群聊"], ["private", "私聊"]] as const).map(([type, label]) => <ToggleGroupItem value={type} key={type} disabled={Boolean(onSelect && type === "group")} className={`flex-1 rounded px-2.5 py-1 text-xs transition ${messageType === type ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{label}</ToggleGroupItem>)}</ToggleGroup></div>
          </div>
          <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border bg-card px-6 py-2 text-[11px] text-muted-foreground"><span className="font-medium text-foreground">{hasTestMessage ? `正则命中 ${filteredRules.length} 条 · 仅检测规则与事件类型，不执行插件代码` : `当前群组共 ${rules.length} 条规则`}</span><span>{onSelect ? "加入后点击保存更改，写入私聊放行名单" : "禁用按 Yunzai 实际匹配的插件名称写入 group.yaml"}</span></div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
            {error && <p role="alert" className="rounded-lg bg-rose-50 dark:bg-rose-950/40 p-3 text-xs text-rose-700 dark:text-rose-300">{error}</p>}
            {loading ? <div className="grid min-h-40 place-items-center text-xs text-muted-foreground"><LoaderCircle className="mb-2 size-5 animate-spin" />正在读取当前已加载插件</div>
              : !error && !filteredRules.length ? <div className="grid min-h-40 place-items-center text-xs text-muted-foreground">{hasTestMessage ? "没有规则匹配这条消息" : "没有找到匹配规则"}</div>
                : filteredRules.map((rule, ruleIndex) => {
                  const nameBlocked = blockedPluginNames.includes(rule.pluginName)
                  const sourceNames = Array.isArray(rule.sourcePluginNames) ? rule.sourcePluginNames : [rule.pluginName]
                  const sourceNeedsBlock = sourceNames.some((name: string) => !blockedPluginNames.includes(name))
                  return <div key={`${rule.id}:${ruleIndex}`} className="border-b border-border py-3 last:border-0">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="text-sm font-semibold text-foreground">{rule.pluginName}</span>{rule.enabled ? <Badge className="border-0 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">当前启用</Badge> : <Badge className="border-0 bg-muted text-foreground">当前未启用</Badge>}{hasTestMessage && <Badge className="border-0 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300">命中测试消息</Badge>}</div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                        {onSelect ? <Button type="button" size="sm" variant="outline" disabled={Boolean(rule.regexError || rule.flags || selectedPatterns.includes(rule.pattern))} title={rule.flags ? "Yunzai 的私聊放行正则不支持 flags，请手动调整" : undefined} onClick={() => onSelect(rule.pattern)}>{selectedPatterns.includes(rule.pattern) ? "已添加" : "加入私聊放行"}</Button> : <>{sourceNames.length > 1 && <Button type="button" size="sm" variant="outline" className="h-8 px-2.5" disabled={busy || nameBlocked} onClick={() => void quickDisable(rule, "name")}>屏蔽此子插件</Button>}
                        <Button type="button" size="sm" variant="outline" className="h-8 px-2.5" disabled={busy || !sourceNeedsBlock} onClick={() => void quickDisable(rule, sourceNames.length > 1 ? "source" : "name")}>{sourceNames.length > 1 ? "屏蔽整个插件" : "屏蔽插件"}</Button></>}
                        </div>
                      </div>
                      <code className="block w-full break-all rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-5 text-foreground">/{rule.pattern}/{rule.flags}</code>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>处理：{rule.fnc}</span><span>来源：{rule.sourceKey || rule.sourcePlugin}</span><span>事件：{rule.event || rule.pluginEvent || "未限制"}</span><span>权限：{rule.permission}</span>{Array.isArray(rule.nameSources) && rule.nameSources.length > 1 && <span className="text-amber-700 dark:text-amber-300">同名来源：{rule.nameSources.join("、")}（屏蔽将全部生效）</span>}{rule.regexError && <span className="text-rose-600 dark:text-rose-300">正则无效：{rule.regexError}</span>}</div>
                    </div>
                  </div>
                })}
            {scanErrors.length > 0 && <p className="mt-3 text-[10px] text-amber-700 dark:text-amber-300">有 {scanErrors.length} 个插件类无法读取规则；其余规则仍可检索。</p>}
          </div>
  </>

  if (page) return <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">{content}</section>

  return <>
    {onSelect && <Button type="button" size="sm" variant="outline" aria-label="选择私聊放行正则" title="选择插件正则" onClick={() => setOpen(true)}><CircleHelp />从插件正则中选择</Button>}
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-overlay fixed inset-0 z-[60] bg-neutral-950/40 backdrop-blur-[2px]" />
        <Dialog.Content onOpenAutoFocus={() => { triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }} onCloseAutoFocus={event => { if (triggerRef.current?.isConnected) { event.preventDefault(); triggerRef.current.focus() } }} className="admin-dialog-content fixed left-1/2 top-1/2 z-[61] flex h-[min(88dvh,820px)] w-[calc(100%-1.5rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl focus:outline-none sm:w-[calc(100%-3rem)]">
          {content}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}

function Metric({ icon: Icon, label, value, detail }: { icon: typeof Cpu; label: string; value: string; detail: string }) {
  return <Card className="admin-metric"><CardContent className="p-3 sm:p-5"><div className="flex items-center justify-between gap-3"><div className="text-xs font-medium text-muted-foreground sm:text-sm">{label}</div><span className="admin-metric-icon grid size-7 shrink-0 place-items-center rounded-lg"><Icon className="size-3.5" /></span></div><div className="mt-2 text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">{value}</div><div className="mt-2 text-[11px] leading-relaxed text-muted-foreground sm:text-xs">{detail}</div></CardContent></Card>
}

function Overview({ api, notify, navigate }: { api: Api; notify: any; navigate: (section: Section, accountId?: string) => void }) {
  const [status, setStatus] = useState<any>(null)
  const [error, setError] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try { setStatus(await api("/api/status")); setError("") } catch (reason) { setError((reason as Error).message) } finally { setRefreshing(false) }
  }, [api])
  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 15000); return () => window.clearInterval(timer) }, [refresh])
  return <>
    <PageIntro actions={[{ label: "刷新状态", render: iconOnly => <Button variant="outline" size={iconOnly ? "icon" : "default"} aria-label="刷新状态" title="刷新状态" onClick={refresh} disabled={refreshing}>{refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{!iconOnly && "刷新状态"}</Button> }]} />
    {error && <div className="mb-5"><ErrorState message={error} /></div>}
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">运行概览</h1><p className="mt-1.5 text-sm text-muted-foreground">查看 Bot 运行情况与消息统计。</p></div><div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground"><span className={`size-1.5 rounded-full ${error ? "bg-amber-500" : status ? "bg-emerald-500" : "bg-muted-foreground"}`} />{error ? "状态更新失败" : !status ? "正在读取状态" : "每 15 秒自动更新"}</div></header>
    <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <Metric icon={Activity} label="运行状态" value={status ? "运行中" : error ? "连接失败" : "读取中"} detail={status ? `进程 PID ${status.pid}` : "正在连接 Bot"} />
      <Metric icon={Clock3} label="持续运行" value={status ? formatUptime(status.uptime) : "—"} detail={status?.startedAt ? `启动于 ${new Date(status.startedAt).toLocaleString("zh-CN")}` : "等待运行信息"} />
      <Metric icon={Cpu} label="内存占用" value={status ? formatBytes(status.memory.rss) : "—"} detail={status ? `堆内存 ${formatBytes(status.memory.heapUsed)} / ${formatBytes(status.memory.heapTotal)}` : "Node.js 进程 RSS"} />
      <Metric icon={Users} label="群组缓存" value={status ? String(status.groupCount) : "—"} detail={status ? `${status.accounts.length} 个机器人账号` : "当前 Bot 群组数量"} />
    </div>
    <h2 className="admin-section-heading mb-3 mt-7 flex items-center gap-2 text-sm font-semibold"><MessageSquareText className="size-4 text-primary" />消息统计</h2>
    <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5">
      <Metric icon={Send} label="今日发送" value={formatCount(status?.messages?.sentToday)} detail={status?.messages?.redisAvailable ? "Redis 当日计数" : "Redis 未连接"} />
      <Metric icon={Clock3} label="本周发送" value={formatCount(status?.messages?.sentThisWeek)} detail={status?.messages?.redisAvailable ? "Redis 本周累计" : "Redis 未连接"} />
      <Metric icon={Clock3} label="本月发送" value={formatCount(status?.messages?.sentThisMonth)} detail={status?.messages?.redisAvailable ? "Redis 月度计数" : "Redis 未连接"} />
      <Metric icon={Send} label="累计发送" value={formatCount(status?.messages?.sentTotal)} detail={status?.messages?.redisAvailable ? "Redis 累计计数" : "Redis 未连接"} />
      <Metric icon={MessageSquareText} label="运行期间接收" value={formatCount(status?.messages?.receivedSinceStart)} detail={status?.messages?.receivedSinceStart == null ? "适配器未提供接收计数" : "机器人账号运行时计数"} />
    </div>
    <h2 className="admin-section-heading mb-3 mt-7 flex items-center gap-2 text-sm font-semibold"><ImageIcon className="size-4 text-primary" />图片统计</h2>
    <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <Metric icon={ImageIcon} label="今日生成图片" value={formatCount(status?.messages?.screenshotsToday)} detail={status?.messages?.redisAvailable ? "Redis 当日计数" : "Redis 未连接"} />
      <Metric icon={Clock3} label="本周生成图片" value={formatCount(status?.messages?.screenshotsThisWeek)} detail={status?.messages?.redisAvailable ? "Redis 本周累计" : "Redis 未连接"} />
      <Metric icon={Clock3} label="本月生成图片" value={formatCount(status?.messages?.screenshotsThisMonth)} detail={status?.messages?.redisAvailable ? "Redis 月度计数" : "Redis 未连接"} />
      <Metric icon={ImageIcon} label="累计生成图片" value={formatCount(status?.messages?.screenshotsTotal)} detail={status?.messages?.redisAvailable ? "Redis 累计计数" : "Redis 未连接"} />
    </div>
    <div className="grid gap-5 xl:grid-cols-[1.45fr_1fr]">
      <Card className="overflow-hidden"><CardHeader className="flex-row items-start justify-between"><div><CardTitle>Bot 实例</CardTitle><CardDescription className="mt-1">Yunzai 运行环境与连接信息</CardDescription></div><Badge className="border-emerald-100 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300"><span className="mr-1.5 size-1.5 rounded-full bg-emerald-500" />{status ? "运行正常" : "连接中"}</Badge></CardHeader><CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          <InfoTile icon={Server} label="Yunzai 版本" value={status?.version || "读取中"} />
          <InfoTile icon={Monitor} label="主机平台" value={status?.platform || "读取中"} />
          <InfoTile icon={HardDrive} label="主机名称" value={status?.host || "读取中"} />
          <InfoTile icon={Database} label="面板地址" value={status?.panel ? `${status.panel.host}:${status.panel.port}` : "读取中"} />
        </div>
        <div className="mt-5 border-t border-border pt-4"><div className="mb-3 flex items-center justify-between gap-3"><div className="text-xs font-semibold">机器人账号</div><Button variant="ghost" type="button" onClick={() => navigate("accounts")} title="前往账号管理" className={cn("h-auto justify-start whitespace-normal p-0", "inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>管理账号<ChevronRight className="size-3.5" /></Button></div>{status?.accounts?.length ? <div className="space-y-2">{status.accounts.map((account: any) => <Button variant="ghost" key={account.id} type="button" onClick={() => navigate("accounts", String(account.id))} aria-label={`管理账号 ${account.nickname || `账号 ${account.id}`}，QQ ${account.id}`} title="管理此账号" className={cn("h-auto justify-start whitespace-normal p-0", "group flex w-full items-center justify-between rounded-xl bg-muted px-3.5 py-3 text-left transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}><span className="flex min-w-0 items-center gap-3"><span className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-card text-foreground shadow-sm"><Bot className="size-4" /><img src={account.avatar} alt="" referrerPolicy="no-referrer" className="absolute inset-0 size-full object-cover" onError={event => event.currentTarget.remove()} /></span><span className="min-w-0"><span className="block truncate text-sm font-medium">{account.nickname || `账号 ${account.id}`}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">QQ {account.id}</span></span></span><span className="flex shrink-0 items-center gap-2"><Badge className={account.online ? "border-emerald-100 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300" : "border-border bg-card text-muted-foreground"}>{account.status}</Badge><ChevronRight className="size-4 text-neutral-300 transition group-hover:text-muted-foreground" /></span></Button>)}</div> : <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">当前没有可显示的机器人账号</div>}</div>
      </CardContent></Card>
      <div className="space-y-5">
        <FrontendUpdater api={api} notify={notify} />
        <Card><CardHeader><CardTitle>快速入口</CardTitle><CardDescription>常用的控制功能</CardDescription></CardHeader><CardContent className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-1">{[
          { icon: FileCog, title: "编辑运行配置", desc: "Bot、群组与系统 YAML 配置", section: "config" as Section },
          { icon: Plug, title: "管理插件设置", desc: "加载插件提供的兼容配置项", section: "plugins" as Section },
          { icon: FileCode2, title: "浏览工作区文件", desc: "查看并编辑文本资源文件", section: "files" as Section },
          { icon: TerminalSquare, title: "查看运行日志", desc: "定位近期错误与命令记录", section: "logs" as Section },
        ].map(item => <Button type="button" variant="ghost" key={item.title} onClick={() => navigate(item.section)} className={cn("h-auto justify-start whitespace-normal p-0", "admin-quick-entry group flex items-center gap-3 rounded-xl border border-border p-3 text-left transition hover:border-border hover:bg-accent/40")}><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground group-hover:bg-card"><item.icon className="size-4" /></span><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{item.title}</span><span className="mt-1 block text-[10px] text-muted-foreground">{item.desc}</span></span><ChevronRight className="size-4 text-neutral-300 group-hover:text-muted-foreground" /></Button>)}</CardContent></Card>
      </div>
    </div>
  </>
}

function AccountManager({ api, notify, confirm }: { api: Api; notify: any; confirm: Confirm }) {
  const [accounts, setAccounts] = useState<ManagedAccount[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [drafts, setDrafts] = useState({ nickname: "", signature: "", sex: "unknown", age: "" })
  const [avatarDraft, setAvatarDraft] = useState("")
  const [avatarPreview, setAvatarPreview] = useState("")
  const [cropSource, setCropSource] = useState("")
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [applyingCrop, setApplyingCrop] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftAccountId, setDraftAccountId] = useState("")
  const [error, setError] = useState("")
  const avatarInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setDraftAccountId("")
    try {
      const result = await api("/api/accounts")
      const nextAccounts: ManagedAccount[] = Array.isArray(result.accounts) ? result.accounts : []
      setAccounts(nextAccounts)
      setSelectedId(current => nextAccounts.some(account => account.id === current) ? current : nextAccounts[0]?.id || "")
      setError("")
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [api])

  useEffect(() => {
    const requestedAccountId = routeQuery("account")
    if (requestedAccountId) setSelectedId(requestedAccountId)
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const activeAccount = accounts.find(account => account.id === selectedId)
  useEffect(() => {
    if (!activeAccount) return
    const { profile } = activeAccount
    setDrafts({
      nickname: profile.nickname || "",
      signature: profile.signature || "",
      sex: ["male", "female", "unknown"].includes(profile.sex) ? profile.sex : "unknown",
      age: profile.age == null ? "" : String(profile.age),
    })
    setDraftAccountId(activeAccount.id)
  }, [activeAccount?.id, activeAccount?.profile])
  useEffect(() => {
    setAvatarDraft("")
    setAvatarPreview("")
    setCropSource("")
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setCroppedAreaPixels(null)
  }, [activeAccount?.id])
  useEffect(() => {
    if (!cropSource.startsWith("blob:")) return
    return () => URL.revokeObjectURL(cropSource)
  }, [cropSource])

  const pendingUpdates: { field: AccountProfileField; value: string }[] = []
  if (activeAccount && draftAccountId === activeAccount.id) {
    const { profile, capabilities } = activeAccount
    if (capabilities.nickname && drafts.nickname !== profile.nickname) pendingUpdates.push({ field: "nickname", value: drafts.nickname })
    if (capabilities.signature && drafts.signature !== profile.signature) pendingUpdates.push({ field: "signature", value: drafts.signature })
    if (capabilities.sex && drafts.sex !== profile.sex) pendingUpdates.push({ field: "sex", value: drafts.sex })
    if (capabilities.age && drafts.age !== (profile.age == null ? "" : String(profile.age))) pendingUpdates.push({ field: "age", value: drafts.age })
    if (capabilities.avatar && avatarDraft) pendingUpdates.push({ field: "avatar", value: avatarDraft })
  }
  const fieldLabels: Record<AccountProfileField, string> = { nickname: "昵称", avatar: "头像", signature: "个性签名", sex: "性别", age: "年龄" }
  const invalidPendingUpdate = pendingUpdates.some(({ field, value }) => {
    if (field === "nickname") return !value.trim() || value.length > 60
    if (field === "age") return !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 120
    if (field === "signature") return value.length > 255
    return false
  })

  async function saveAll() {
    if (!activeAccount || saving || !pendingUpdates.length || invalidPendingUpdate) return
    const updates = [...pendingUpdates]
    setSaving(true)
    let savedCount = 0
    try {
      for (const update of updates) {
        await api(`/api/accounts/${encodeURIComponent(activeAccount.id)}/profile`, {
          method: "PATCH",
          body: JSON.stringify(update),
        })
        savedCount += 1
      }
      setAvatarDraft("")
      setAvatarPreview("")
      await refresh()
      notify("success", `${savedCount} 项资料已保存`)
    } catch (reason) {
      const failedField = updates[savedCount]?.field
      const savedMessage = savedCount ? `已保存 ${savedCount} 项，` : ""
      notify("error", `${savedMessage}${fieldLabels[failedField || "nickname"]}保存失败：${(reason as Error).message}。草稿已保留，可再次保存。`)
    } finally {
      setSaving(false)
    }
  }

  function chooseAvatar(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    input.value = ""
    if (!file) return
    if (!file.type.startsWith("image/")) return notify("error", "请选择图片文件")
    setCropSource(URL.createObjectURL(file))
    setCrop({ x: 0, y: 0 })
    setZoom(1)
    setCroppedAreaPixels(null)
  }

  async function applyAvatarCrop() {
    if (!cropSource || !croppedAreaPixels || applyingCrop) return
    setApplyingCrop(true)
    try {
      const image = new Image()
      image.src = cropSource
      await image.decode()
      const canvas = document.createElement("canvas")
      const context = canvas.getContext("2d")
      if (!context) throw new Error("当前浏览器不支持图片裁剪")
      let croppedBlob: Blob | null = null
      for (const outputSize of [512, 384, 256, 192, 128]) {
        canvas.width = outputSize
        canvas.height = outputSize
        context.fillStyle = "#fff"
        context.fillRect(0, 0, outputSize, outputSize)
        context.drawImage(
          image,
          croppedAreaPixels.x,
          croppedAreaPixels.y,
          croppedAreaPixels.width,
          croppedAreaPixels.height,
          0,
          0,
          outputSize,
          outputSize,
        )
        for (const quality of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5]) {
          croppedBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", quality))
          if (croppedBlob && croppedBlob.size <= MAX_AVATAR_BYTES) break
        }
        if (croppedBlob && croppedBlob.size <= MAX_AVATAR_BYTES) break
      }
      if (!croppedBlob || croppedBlob.size > MAX_AVATAR_BYTES) throw new Error("裁剪后的图片仍超过 1.5 MB，请选择其他图片")
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ""))
        reader.onerror = () => reject(new Error("无法读取裁剪后的头像"))
        reader.readAsDataURL(croppedBlob)
      })
      const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1)
      if (!encoded) throw new Error("无法生成裁剪后的头像")
      setAvatarPreview(dataUrl)
      setAvatarDraft(`base64://${encoded}`)
      setCropSource("")
    } catch (reason) {
      notify("error", (reason as Error).message || "裁剪头像失败")
    } finally {
      setApplyingCrop(false)
    }
  }

  const canEdit = (field: AccountProfileField) => Boolean(activeAccount?.capabilities[field]) && !saving
  return <>
    {activeAccount && <PageIntro actions={[{ label: "保存更改", render: iconOnly => <Button type="button" size={iconOnly ? "icon" : "default"} aria-label="保存更改" title={pendingUpdates.length ? `保存 ${pendingUpdates.length} 项更改` : " 没有待保存的更改"} disabled={!pendingUpdates.length || invalidPendingUpdate || saving} onClick={() => void saveAll()}>{saving ? <LoaderCircle className="animate-spin" /> : <Check />}{!iconOnly && (saving ? "保存中" : "保存更改")}</Button> }]} />}
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">账号管理</h1><p className="mt-1 text-sm text-muted-foreground">机器人 QQ 个人资料</p></div>
      <Button type="button" variant="outline" onClick={async () => { if (!pendingUpdates.length || await confirm("刷新会丢弃尚未保存的修改，继续吗？")) void refresh() }} disabled={refreshing || saving} aria-label="刷新账号资料" title="刷新账号资料"><RefreshCw className={refreshing ? "animate-spin" : ""} />刷新</Button>
    </div>
    {error && <div className="mb-5"><ErrorState message={error} /></div>}
    {loading && !accounts.length ? <div className="grid min-h-56 place-items-center text-muted-foreground"><LoaderCircle className="size-6 animate-spin" /></div>
      : !accounts.length ? <div className="rounded-xl border border-dashed border-border px-5 py-12 text-center text-sm text-muted-foreground">当前没有可管理的机器人账号</div>
        : <div className="grid gap-6 lg:grid-cols-[250px_minmax(0,1fr)]">
          <aside className="min-w-0">
            <h2 className="mb-3 text-sm font-semibold">机器人账号</h2>
            <div className="space-y-1">
              {accounts.map(account => <Button variant="ghost" key={account.id} type="button" disabled={saving || refreshing} onClick={async () => { if (selectedId === account.id || saving || refreshing) return; if (pendingUpdates.length && !await confirm("切换账号会丢弃尚未保存的修改，继续吗？")) return; setDraftAccountId(""); setSelectedId(account.id) }} className={cn("h-auto justify-start whitespace-normal p-0", `flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${selectedId === account.id ? "border-border bg-accent" : "border-transparent hover:border-border hover:bg-card"}`)}>
                <span className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-muted-foreground"><Bot className="size-5" /><img src={account.avatar} alt="" referrerPolicy="no-referrer" className="absolute inset-0 size-full object-cover" onError={event => event.currentTarget.remove()} /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{account.nickname || `账号 ${account.id}`}</span><span className="mt-0.5 block text-xs text-muted-foreground">QQ {account.id}</span></span>
                <span aria-label={account.status} title={account.status} className={`size-2 shrink-0 rounded-full ${account.online ? "bg-emerald-500" : "bg-neutral-300"}`} />
              </Button>)}
            </div>
          </aside>
          {activeAccount && <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
              <div><h2 className="text-base font-semibold">个人资料</h2><p className="mt-1 text-xs text-muted-foreground">QQ {activeAccount.id}</p></div>
              <Badge className={activeAccount.online ? "border-emerald-100 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300" : "border-border bg-muted text-muted-foreground"}>{activeAccount.status}</Badge>
            </div>
            <div className="divide-y divide-border px-5 sm:px-6">
              <div className="flex flex-wrap items-center gap-4 py-5">
                <span className="relative grid size-16 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-muted-foreground"><UserRound className="size-7" /><img key={activeAccount.profile.avatar} src={avatarPreview || activeAccount.profile.avatar} alt="账号头像" referrerPolicy="no-referrer" className="absolute inset-0 size-full object-cover" onError={event => event.currentTarget.remove()} /></span>
                <div className="min-w-0 flex-1"><Label className="text-sm font-medium">头像</Label><p className="mt-1 text-xs text-muted-foreground">JPG、PNG、WebP，裁切后自动压缩至 1.5 MB 以内</p></div>
                <Input ref={avatarInput} type="file" accept="image/*" aria-label="选择账号头像" className="hidden" disabled={!canEdit("avatar")} onChange={chooseAvatar} />
                <div className="flex w-full gap-2 sm:w-auto">
                  <Button type="button" variant="outline" className="flex-1 sm:flex-none" disabled={!canEdit("avatar")} title={canEdit("avatar") ? "选择新头像" : "当前适配器不支持修改此资料"} onClick={() => avatarInput.current?.click()}><Upload />选择图片</Button>
                </div>
              </div>
              <div className="py-5">
                <div className="space-y-2"><Label htmlFor="account-nickname">昵称</Label><Input id="account-nickname" maxLength={60} value={drafts.nickname} disabled={!canEdit("nickname")} onChange={event => setDrafts(current => ({ ...current, nickname: event.target.value }))} /></div>
              </div>
              <div className="py-5">
                <div className="space-y-2"><Label htmlFor="account-signature">个性签名</Label><Textarea id="account-signature" maxLength={255} rows={3} className="min-h-20 resize-y" value={drafts.signature} disabled={!canEdit("signature")} onChange={event => setDrafts(current => ({ ...current, signature: event.target.value }))} placeholder={activeAccount.profile.signatureReadStatus === "available" ? "当前未设置签名" : activeAccount.profile.signatureReadStatus === "unsupported" ? "适配器未提供签名读取接口" : "暂无法读取当前签名"} /></div>
              </div>
              <div className="grid gap-4 py-5 sm:grid-cols-2">
                <div className="space-y-2"><Label htmlFor="account-sex">性别</Label><Select value={drafts.sex} onValueChange={sex => setDrafts(current => ({ ...current, sex }))}><SelectTrigger id="account-sex" disabled={!canEdit("sex")} className="bg-card"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="male">男</SelectItem><SelectItem value="female">女</SelectItem><SelectItem value="unknown">未知</SelectItem></SelectContent></Select></div>
                <div className="space-y-2"><Label htmlFor="account-age">年龄</Label><Input id="account-age" type="number" min={1} max={120} value={drafts.age} disabled={!canEdit("age")} onChange={event => setDrafts(current => ({ ...current, age: event.target.value }))} placeholder="未提供" /></div>
              </div>
            </div>
          </section>}
        </div>}
    {cropSource && <Dialog.Root open onOpenChange={open => { if (!open) setCropSource("") }}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-overlay fixed inset-0 z-[60] bg-neutral-950/40 backdrop-blur-[2px]" />
        <Dialog.Content className="admin-dialog-content fixed left-1/2 top-1/2 z-[61] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl focus:outline-none">
          <div className="flex items-start justify-between gap-4">
            <div><Dialog.Title className="text-base font-semibold">裁剪头像</Dialog.Title><Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">调整图片位置与缩放，圆形区域将作为头像。</Dialog.Description></div>
            <Dialog.Close asChild><Button type="button" size="icon" variant="ghost" aria-label="关闭头像裁剪"><X /></Button></Dialog.Close>
          </div>
          <div className="relative mx-auto mt-4 aspect-[4/3] w-full max-w-[420px] overflow-hidden rounded-xl bg-neutral-950">
            <Cropper
              image={cropSource}
              crop={crop}
              zoom={zoom}
              rotation={0}
              aspect={1}
              cropShape="round"
              minZoom={1}
              maxZoom={3}
              zoomSpeed={0.2}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_, areaPixels) => setCroppedAreaPixels(areaPixels)}
            />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Label className="shrink-0 text-xs">缩放</Label>
            <Slider id="avatar-crop-zoom" aria-label="缩放" min={1} max={3} step={0.01} value={[zoom]} onValueChange={value => setZoom(value[0] ?? 1)} className="flex-1 cursor-pointer" />
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{zoom.toFixed(2)}×</span>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={applyingCrop} onClick={() => setCropSource("")}>取消</Button>
            <Button type="button" disabled={!croppedAreaPixels || applyingCrop} onClick={() => void applyAvatarCrop()}>{applyingCrop ? <LoaderCircle className="animate-spin" /> : <Check />}应用裁剪</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>}
  </>
}

function InfoTile({ icon: Icon, label, value }: { icon: typeof Server; label: string; value: string }) {
  return <div className="flex items-center gap-3 rounded-xl border border-border p-3"><span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" /></span><div className="min-w-0"><div className="text-[10px] text-muted-foreground">{label}</div><div className="mt-1 truncate text-xs font-medium">{value}</div></div></div>
}

function ConfigCenter({ api, notify, confirm }: { api: Api; notify: any; confirm: Confirm }) {
  const [files, setFiles] = useState<string[]>([])
  const [selected, setSelected] = useState("")
  const [activeGroupId, setActiveGroupId] = useState("default")
  const [addGroupOpen, setAddGroupOpen] = useState(false)
  const [newGroupId, setNewGroupId] = useState("")
  const [newGroupPickerOpen, setNewGroupPickerOpen] = useState(false)
  const [newGroupSearch, setNewGroupSearch] = useState("")
  const [groupActionError, setGroupActionError] = useState("")
  const [pluginNameOptions, setPluginNameOptions] = useState<string[]>([])
  const [pluginNameGroup, setPluginNameGroup] = useState("")
  const [pluginNamesLoading, setPluginNamesLoading] = useState(false)
  const [pluginNamesError, setPluginNamesError] = useState("")
  const [friendOptions, setFriendOptions] = useState<FriendOption[]>()
  const [friendsLoading, setFriendsLoading] = useState(false)
  const [friendsError, setFriendsError] = useState("")
    const [groupOptions, setGroupOptions] = useState<GroupOption[]>()
    const [groupsLoading, setGroupsLoading] = useState(false)
    const [groupsError, setGroupsError] = useState("")
  const [fileSidebarCollapsed, setFileSidebarCollapsed] = useBrowserBooleanPreference("configSidebarCollapsed")
  const [data, setData] = useState<any>(null)
  const [defaults, setDefaults] = useState<any>(null)
  const [raw, setRaw] = useState("")
  const [loadedContent, setLoadedContent] = useState("")
  const [configVersion, setConfigVersion] = useState("")
  const [rawMode, setRawMode] = useState(false)
  const [editorFullscreen, setEditorFullscreen] = useState(false)
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [dirty, setDirty] = useState(false)
  useEffect(() => { api("/api/config").then(result => { setFiles(result.files); const requested = routeQuery("file"); if (result.files[0]) setSelected(result.files.includes(requested) ? requested : result.files[0]) }).catch(reason => setError(reason.message)) }, [api])
  const selectedLabel = configFileLabel(selected)
  const load = useCallback(async (name: string) => {
    setLoading(true); setError("")
    try { const result = await api(`/api/config/${encodeURIComponent(name)}`); setSelected(name); setActiveGroupId("default"); setData(result.data); setDefaults(result.defaults); setRaw(result.content); setLoadedContent(result.content); setConfigVersion(result.version); setDirty(false); setRawMode(false); setEditorFullscreen(false) }
    catch (reason) { setError((reason as Error).message) }
    finally { setLoading(false) }
  }, [api])
  function chooseFile(name: string) {
    if (name === selected) return
    setRouteQuery("file", name)
    void load(name)
  }
  useEffect(() => {
    const syncSelection = () => {
      if (sectionFromPath(window.location.pathname) !== "config") return
      const requested = routeQuery("file")
      const target = files.includes(requested) ? requested : files[0]
      if (target && target !== selected) void load(target)
    }
    window.addEventListener("popstate", syncSelection)
    return () => window.removeEventListener("popstate", syncSelection)
  }, [files, selected, load])
  useEffect(() => {
    if (!editorFullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setEditorFullscreen(false) }
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [editorFullscreen])
  useEffect(() => { if (selected && !data) load(selected) }, [selected, data, load])
  const visible = files.filter(file => `${file} ${configFileLabel(file)}`.toLowerCase().includes(search.toLowerCase()))
  const groupSectionKeys = selected.toLowerCase() === "group.yaml" && isObject(data)
    ? Object.keys(data).filter(key => (key === "default" || /^\d+$/.test(key)) && isObject(data[key])).sort((left, right) => left === "default" ? -1 : right === "default" ? 1 : 0)
    : []
  const activeGroupSection = groupSectionKeys.includes(activeGroupId) ? activeGroupId : groupSectionKeys[0] || ""
  const configuredGroupIds = new Set(groupSectionKeys.filter(groupId => groupId !== "default"))
  const filteredNewGroupOptions = (groupOptions || []).filter(group => `${group.name} ${group.id}`.toLowerCase().includes(newGroupSearch.trim().toLowerCase()))
  useEffect(() => {
    if (selected.toLowerCase() !== "group.yaml" || !activeGroupSection) {
      setPluginNameOptions([])
      setPluginNameGroup("")
      setPluginNamesError("")
      setPluginNamesLoading(false)
      return
    }
    let cancelled = false
    setPluginNameOptions([])
    setPluginNamesError("")
    setPluginNamesLoading(true)
    api(`/api/config/group-plugin-names/${encodeURIComponent(activeGroupSection)}`)
      .then(result => {
        if (cancelled) return
        setPluginNameOptions(Array.isArray(result.pluginNames) ? result.pluginNames : [])
        setPluginNameGroup(String(result.groupName || activeGroupSection))
      })
      .catch(reason => { if (!cancelled) setPluginNamesError((reason as Error).message) })
      .finally(() => { if (!cancelled) setPluginNamesLoading(false) })
    return () => { cancelled = true }
  }, [activeGroupSection, api, selected])
  useEffect(() => {
    if (!selected) {
      setFriendOptions(undefined)
      setFriendsError("")
      setFriendsLoading(false)
      return
    }
    let cancelled = false
    setFriendOptions([])
    setFriendsError("")
    setFriendsLoading(true)
    api("/api/config/friends")
      .then(result => { if (!cancelled) setFriendOptions(Array.isArray(result.friends) ? result.friends : []) })
      .catch(reason => { if (!cancelled) setFriendsError((reason as Error).message) })
      .finally(() => { if (!cancelled) setFriendsLoading(false) })
    return () => { cancelled = true }
  }, [api, selected])
    useEffect(() => {
      if (!selected) {
        setGroupOptions(undefined)
        setGroupsError("")
        setGroupsLoading(false)
        return
      }
      let cancelled = false
      setGroupOptions([])
      setGroupsError("")
      setGroupsLoading(true)
      api("/api/config/groups")
        .then(result => { if (!cancelled) setGroupOptions(Array.isArray(result.groups) ? result.groups : []) })
        .catch(reason => { if (!cancelled) setGroupsError((reason as Error).message) })
        .finally(() => { if (!cancelled) setGroupsLoading(false) })
      return () => { cancelled = true }
    }, [api, selected])
  const groupOverrides = activeGroupSection !== "default" && isObject(data?.[activeGroupSection]) ? data[activeGroupSection] : {}
  const mergedGroupSettings = activeGroupSection && activeGroupSection !== "default"
    ? { ...(isObject(defaults?.default) ? defaults.default : {}), ...(isObject(data?.default) ? data.default : {}), ...groupOverrides }
    : null
  const activeGroupSettings = activeGroupSection === "default"
    ? data?.default
    : mergedGroupSettings?.isInheritDefault === 1
      ? mergedGroupSettings
      : { ...mergedGroupSettings, enable: Object.prototype.hasOwnProperty.call(groupOverrides, "enable") ? groupOverrides.enable : [], disable: Object.prototype.hasOwnProperty.call(groupOverrides, "disable") ? groupOverrides.disable : [] }
  function update(path: string[], value: any) { setData((old: any) => setNested(old, path, value)); setDirty(true) }
  function addGroup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const groupId = newGroupId.trim()
    if (!/^\d+$/.test(groupId)) { setGroupActionError("群号只能包含数字"); return }
    if (Object.prototype.hasOwnProperty.call(data, groupId)) { setGroupActionError("这个群已经有单独配置了"); return }
    setData((current: any) => ({ ...current, [groupId]: { isInheritDefault: 1 } }))
    setDirty(true)
    setActiveGroupId(groupId)
    setAddGroupOpen(false)
    setNewGroupId("")
    setNewGroupPickerOpen(false)
    setGroupActionError("")
  }
  async function removeGroup(groupId: string) {
    if (!await confirm(`确定删除群 ${groupId} 的单独配置？删除内容会在点击“保存更改”后写入配置文件。`)) return
    setData((current: any) => {
      const next = { ...current }
      delete next[groupId]
      return next
    })
    setDirty(true)
    setActiveGroupId(current => current === groupId ? "default" : current)
  }
  async function save() {
    if (!selected || saving || (!dirty && !rawMode)) return
    setSaving(true)
    try {
      await api(`/api/config/${encodeURIComponent(selected)}`, { method: "PUT", body: JSON.stringify({ ...(rawMode ? { content: raw } : { data, ...(raw !== loadedContent ? { baseContent: raw } : {}) }), version: configVersion }) })
      notify("success", `${selectedLabel} 已保存并刷新运行时配置`)
      await load(selected)
    } catch (reason) { setError((reason as Error).message); notify("error", (reason as Error).message) }
    finally { setSaving(false) }
  }
  useSaveShortcut(save)
  return <>
    <PageIntro actions={[{ label: "保存更改", render: iconOnly => <Button size={iconOnly ? "icon" : "default"} aria-label="保存更改" title="保存更改" onClick={save} disabled={!selected || saving || (!dirty && !rawMode)}>{saving ? <LoaderCircle className="animate-spin" /> : <Check />}{!iconOnly && "保存更改"}</Button> }]} />
    <div
      className={`config-center-grid grid min-h-dvh gap-5 xl:gap-0 ${fileSidebarCollapsed ? "is-collapsed" : ""}`}
      style={{ "--config-sidebar-width": fileSidebarCollapsed ? "72px" : "245px" } as React.CSSProperties}
    >
      <div className="relative h-fit min-w-0 xl:h-dvh">
      <div className="config-center-sidebar-fixed relative h-full min-w-0">
      <Card className="relative h-fit overflow-visible xl:h-full xl:overflow-hidden xl:rounded-none">
        <div className={`absolute inset-0 z-10 hidden flex-col gap-1 overflow-y-auto p-2 scrollbar-thin transition-opacity duration-200 xl:flex ${fileSidebarCollapsed ? "opacity-100" : "pointer-events-none opacity-0"}`}>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          {files.map(file => <TooltipProvider key={file} delayDuration={200}><Tooltip><TooltipTrigger asChild><Button variant="ghost" type="button" aria-label={`${configFileLabel(file)}，${file}`} aria-current={selected === file ? "page" : undefined} onClick={() => chooseFile(file)} className={cn("h-auto justify-start whitespace-normal p-0", `relative flex h-[52px] w-full flex-col items-center justify-center gap-0.5 rounded-lg transition ${selected === file ? "bg-sidebar-accent text-sidebar-foreground" : "text-muted-foreground hover:bg-muted"}`)}>
            <ConfigFileIcon file={file} className="size-4" />
            <span className={`text-[8px] leading-3 ${selected === file ? "font-medium" : ""}`}>{configFileCompactLabels[file] || configFileLabel(file)}</span>
          </Button></TooltipTrigger><TooltipContent side="right">{configFileLabel(file)}<span className="mt-0.5 block text-[10px] opacity-80">{file}</span></TooltipContent></Tooltip></TooltipProvider>)}
          </div>
          <div className="flex shrink-0 justify-start border-t border-border pt-2"><Button size="icon" variant="ghost" className="size-8" aria-label="展开配置文件侧栏" title="展开配置文件侧栏" onClick={() => setFileSidebarCollapsed(false)}><ChevronRight className="size-4" /></Button></div>
        </div>
        <div className={`transition-opacity duration-150 xl:flex xl:h-full xl:min-h-0 xl:flex-col ${fileSidebarCollapsed ? "xl:pointer-events-none xl:opacity-0" : "opacity-100"}`}>
          <div className="p-4 pb-3">
            <div className="mb-3 flex items-center justify-between gap-2 text-xs font-semibold"><span>配置文件 <Badge className="ml-1 border-0 bg-muted text-foreground">{files.length}</Badge></span></div>
            <div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="h-9 pl-9 text-xs" placeholder="筛选配置…" value={search} onChange={event => setSearch(event.target.value)} /></div>
          </div>
          <div className="max-h-[min(560px,calc(100dvh-12rem))] space-y-1 overflow-y-auto px-2 pb-3 xl:min-h-0 xl:max-h-none xl:flex-1">{visible.map(file => <Button variant="ghost" key={file} type="button" title={`${configFileLabel(file)} · ${file}`} aria-current={selected === file ? "page" : undefined} onClick={() => chooseFile(file)} className={cn("h-auto justify-start whitespace-normal p-0", `flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected === file ? "bg-accent font-medium text-foreground" : "text-foreground hover:bg-muted"}`)}><ConfigFileIcon file={file} className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">{configFileLabel(file)}</span></Button>)}</div>
          <div className="hidden shrink-0 justify-start border-t border-border px-2 py-2 xl:flex"><Button size="icon" variant="ghost" className="size-8" aria-label="收起配置文件侧栏" title="收起配置文件侧栏" onClick={() => setFileSidebarCollapsed(true)}><ChevronLeft className="size-4" /></Button></div>
        </div>
      </Card>
      </div>
      </div>
      <Card className={`min-w-0 ${editorFullscreen ? "fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden rounded-none border-0" : rawMode ? "flex h-full min-h-0 flex-col overflow-hidden" : ""}`}>
        <CardHeader className="shrink-0 flex-col items-start gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div><CardTitle className="text-base">{selected ? selectedLabel : "选择配置文件"}</CardTitle><CardDescription className="mt-1">config/config/{selected}</CardDescription></div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant={rawMode ? "secondary" : "outline"} onClick={async () => {
              if (!rawMode) {
                if (dirty && !await confirm("切换源码模式会放弃尚未保存的图形化修改，继续吗？")) return
                setDirty(raw !== loadedContent)
                setEditorFullscreen(false)
                setRawMode(true)
                return
              }
              try {
                const parsed = parseYaml(raw)
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("YAML 内容必须是对象")
                setData(parsed)
                setDirty(raw !== loadedContent)
                setEditorFullscreen(false)
                setRawMode(false)
              } catch (reason) { notify("error", `YAML 无法解析：${(reason as Error).message}`) }
            }}><Braces />{rawMode ? "图形化编辑" : "YAML 源码"}</Button>
            {rawMode && <Button type="button" size="icon" variant="ghost" className="size-8" aria-label={editorFullscreen ? "退出全屏编辑" : "全屏编辑"} aria-pressed={editorFullscreen} title={editorFullscreen ? "退出全屏编辑 (Esc)" : "全屏编辑"} onClick={() => setEditorFullscreen(current => !current)}>{editorFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</Button>}
            {editorFullscreen && <Button size="sm" onClick={save} disabled={!selected || saving || (!dirty && !rawMode)}>{saving ? <LoaderCircle className="animate-spin" /> : <Check />}保存更改</Button>}
            <Button size="icon" variant="ghost" aria-label="重新加载" onClick={() => selected && load(selected)}><RefreshCw className="size-4" /></Button>
          </div>
        </CardHeader>
        {!rawMode && groupSectionKeys.length > 0 && <div role="group" aria-label="群组设置分组" className="flex shrink-0 items-center border-b border-border bg-card px-3 sm:px-5">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {groupSectionKeys.map(groupId => {
            const active = groupId === activeGroupSection
            return <div key={groupId} className={`flex shrink-0 items-center border-b-2 transition-colors ${active ? "border-primary" : "border-transparent"}`}>
              <Button variant="ghost" type="button" aria-pressed={active} title={groupId === "default" ? "全局配置" : `群 ${groupId}`} onClick={() => setActiveGroupId(groupId)} className={cn("h-auto justify-start whitespace-normal p-0", `flex shrink-0 items-center gap-2 py-2 pl-3 text-xs font-medium ${groupId === "default" ? "pr-3" : "pr-1"} ${active ? "text-primary" : "text-muted-foreground hover:text-foreground"}`)}>
                <span className="relative grid size-6 shrink-0 place-items-center overflow-hidden rounded-full bg-muted">
                  <Users className="size-3.5 text-muted-foreground" />
                  {groupId !== "default" && <img src={`https://p.qlogo.cn/gh/${encodeURIComponent(groupId)}/${encodeURIComponent(groupId)}/100/`} alt="" loading="lazy" decoding="async" className="absolute inset-0 size-full object-cover" onError={event => { event.currentTarget.style.display = "none" }} />}
                </span>
                {groupId === "default" ? "全局" : `群 ${groupId}`}
              </Button>
              {groupId !== "default" && <Button variant="ghost" type="button" aria-label={`删除群 ${groupId}`} title="删除此群配置" onClick={() => removeGroup(groupId)} className={cn("h-auto justify-center whitespace-normal p-0", "mr-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground/60 transition hover:bg-rose-50 dark:hover:bg-rose-950/50 hover:text-rose-600 dark:hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}><X className="size-3.5" /></Button>}
            </div>
          })}
          </div>
          <Button type="button" size="icon" variant="ghost" className="ml-1 size-8 shrink-0" aria-label="新增群配置" title="新增群配置" onClick={() => { setNewGroupId(""); setNewGroupSearch(""); setNewGroupPickerOpen(false); setGroupActionError(""); setAddGroupOpen(true) }}><Plus className="size-4" /></Button>
        </div>}
        <CardContent className={rawMode || editorFullscreen ? "flex min-h-0 flex-1 flex-col p-0" : "p-5"}>
        {error && <div className="mb-4"><ErrorState message={error} /></div>}
        {loading && <div className="grid min-h-64 place-items-center"><LoaderCircle className="size-6 animate-spin text-muted-foreground" /></div>}
        {!loading && rawMode && <MonacoCodeEditor key={selected} path={selected || "config.yaml"} value={raw} className="min-h-0 flex-1 overflow-hidden border-t border-border" onChange={value => { setRaw(value); setDirty(true) }} />}
        {!loading && !rawMode && groupSectionKeys.length > 0 && activeGroupSection && isObject(activeGroupSettings) && <div key={activeGroupSection} className="admin-fields-enter space-y-5">{Object.entries(activeGroupSettings).map(([key, value]) => {
          const listDoesNotInherit = activeGroupSection !== "default" && (key === "enable" || key === "disable") && activeGroupSettings.isInheritDefault !== 1 && !Object.prototype.hasOwnProperty.call(groupOverrides, key)
          const defaultValue = activeGroupSection === "default" ? defaults?.default?.[key] : listDoesNotInherit ? undefined : data.default?.[key] ?? defaults?.default?.[key]
          const mutuallyExclusiveName = key === "enable" ? "disable" : key === "disable" ? "enable" : ""
          const mutuallyExclusiveValues = mutuallyExclusiveName && Array.isArray(activeGroupSettings[mutuallyExclusiveName]) ? activeGroupSettings[mutuallyExclusiveName] : undefined
          return <ConfigField key={key} name={key} value={value} defaultValue={defaultValue} path={[activeGroupSection, key]} onChange={update} depth={1} pluginNames={key === "enable" || key === "disable" ? pluginNameOptions : undefined} pluginNameGroup={pluginNameGroup} pluginNamesLoading={pluginNamesLoading} pluginNamesError={pluginNamesError} friendOptions={friendOptions} friendsLoading={friendsLoading} friendsError={friendsError} groupOptions={groupOptions} groupsLoading={groupsLoading} groupsError={groupsError} mutuallyExclusiveValues={mutuallyExclusiveValues} mutuallyExclusiveLabel={mutuallyExclusiveName ? configFieldLabel(mutuallyExclusiveName) : undefined} />
        })}</div>}
        {!loading && !rawMode && data && groupSectionKeys.length === 0 && <div className="admin-fields-enter space-y-5">{Object.entries(data).map(([key, value]) => <Fragment key={key}><ConfigField name={key} value={value} defaultValue={defaults?.[key]} path={[key]} onChange={update} friendOptions={friendOptions} friendsLoading={friendsLoading} friendsError={friendsError} groupOptions={groupOptions} groupsLoading={groupsLoading} groupsError={groupsError} />{key === "disableAdopt" && <PluginMatchHelper api={api} notify={notify} confirm={confirm} selectedPatterns={Array.isArray(value) ? value : []} onSelect={pattern => update([key], [...new Set([...(Array.isArray(value) ? value : []), pattern])])} />}</Fragment>)}</div>}
        {!loading && !data && !error && <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">选择左侧配置文件开始编辑</div>}
        </CardContent>
      </Card>
    </div>
    <Dialog.Root open={addGroupOpen} onOpenChange={open => { setAddGroupOpen(open); if (!open) { setGroupActionError(""); setNewGroupPickerOpen(false) } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-overlay fixed inset-0 z-[60] bg-neutral-950/40 backdrop-blur-[2px]" />
        <Dialog.Content className="admin-dialog-content fixed left-1/2 top-1/2 z-[61] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl focus:outline-none">
          <Dialog.Title className="text-base font-semibold">新增群配置</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">新群默认继承全局配置，可在创建后单独调整。</Dialog.Description>
          <form onSubmit={addGroup} className="mt-4 space-y-3">
            <div className="space-y-1.5"><Label htmlFor="new-group-id" className="text-xs">群号</Label><Input id="new-group-id" autoFocus inputMode="numeric" pattern="[0-9]+" value={newGroupId} onChange={event => { setNewGroupId(event.target.value); setGroupActionError("") }} placeholder="输入纯数字群号" required /><Button type="button" size="sm" variant="outline" className="h-8 w-full text-[11px]" aria-expanded={newGroupPickerOpen} onClick={() => { setNewGroupSearch(""); setNewGroupPickerOpen(open => !open) }}><Users className="size-3.5" />{newGroupPickerOpen ? "收起群聊列表" : "从群聊列表选择"}</Button></div>
            {newGroupPickerOpen && <div className="overflow-hidden rounded-lg border border-border">
              <CommandMenu shouldFilter={false} tabIndex={0} className="min-h-0 flex-1"><CommandInput aria-label="搜索可配置群聊" placeholder="搜索群名或群号…" value={newGroupSearch} onValueChange={setNewGroupSearch}  /><CommandList aria-label="可新增配置的群聊" className="max-h-48 space-y-1 overflow-y-auto p-1.5">
                {groupsLoading ? <div className="grid min-h-20 place-items-center text-xs text-muted-foreground"><LoaderCircle className="mb-2 size-4 animate-spin" />正在获取群聊</div>
                  : groupsError ? <p role="alert" className="p-3 text-xs text-rose-600 dark:text-rose-300">{groupsError}</p>
                    : filteredNewGroupOptions.length ? filteredNewGroupOptions.map(group => {
                      const alreadyConfigured = configuredGroupIds.has(group.id)
                      const selectedGroup = newGroupId === group.id
                      return <CommandItem value={group.id} key={group.id} aria-selected={selectedGroup} aria-disabled={alreadyConfigured} disabled={alreadyConfigured} onSelect={() => { setNewGroupId(group.id); setGroupActionError(""); setNewGroupPickerOpen(false) }} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${alreadyConfigured ? "cursor-not-allowed text-muted-foreground" : selectedGroup ? "bg-accent text-foreground" : "text-foreground hover:bg-muted"}`}>
                        <span className="relative grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-muted-foreground"><Users className="size-3.5" /><img src={group.avatar} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" onError={event => { event.currentTarget.style.display = "none" }} /></span>
                        {selectedGroup ? <Check className="size-3.5 shrink-0" /> : <Plus className="size-3.5 shrink-0 text-muted-foreground" />}
                        <span className="min-w-0 flex-1"><span className="block truncate">{group.name}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">{group.id}</span></span><span className="text-[10px] text-muted-foreground">{alreadyConfigured ? "已有配置" : ""}</span>
                      </CommandItem>
                    })
                    : <p className="p-3 text-xs text-muted-foreground">{groupOptions?.length ? "没有匹配的群聊" : "当前没有可选择的群聊"}</p>}
              </CommandList></CommandMenu>
            </div>}
            {groupActionError && <p role="alert" className="text-xs text-rose-600 dark:text-rose-300">{groupActionError}</p>}
            <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="outline" onClick={() => { setAddGroupOpen(false); setNewGroupPickerOpen(false) }}>取消</Button><Button type="submit"><Plus />添加群</Button></div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}

function setNested(value: any, path: string[], next: any): any {
  if (!path.length || path.some(key => ["__proto__", "constructor", "prototype"].includes(key))) return value
  const copy = Array.isArray(value) ? [...value] : { ...(value || {}) }
  if (path.length === 1) copy[path[0]] = next
  else copy[path[0]] = setNested(value && Object.hasOwn(value, path[0]) ? value[path[0]] : undefined, path.slice(1), next)
  return copy
}
function getNested(value: any, path: string) { return path.split(".").reduce((current, key) => current && !["__proto__", "constructor", "prototype"].includes(key) && Object.hasOwn(current, key) ? current[key] : undefined, value) }
function safePluginLink(value: any) { try { const url = new URL(String(value)); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "" } catch { return "" } }
function isObject(value: any) { return value !== null && typeof value === "object" && !Array.isArray(value) }
function secretField(name: string) { return /(password|passwd|secret|token|cookie|private.?key|\bpwd\b)/i.test(name) }
function useSaveShortcut(onSave: () => void | Promise<void>) {
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || (event.key.toLowerCase() !== "s" && event.code !== "KeyS")) return
      event.preventDefault()
      event.stopPropagation()
      void saveRef.current()
    }
    document.addEventListener("keydown", handleKeyDown, true)
    return () => document.removeEventListener("keydown", handleKeyDown, true)
  }, [])
}

type UIPreferenceKey = "mainSidebarCollapsed" | "configSidebarCollapsed" | "pluginSidebarCollapsed"
const UI_PREFERENCES_KEY = "elia-admin-panel:ui-preferences"

function readUIPreferences(): Partial<Record<UIPreferenceKey, boolean>> {
  try {
    const stored = window.localStorage.getItem(UI_PREFERENCES_KEY)
    if (!stored) return {}
    const parsed = JSON.parse(stored)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function useBrowserBooleanPreference(name: UIPreferenceKey, initialValue = false) {
  const [value, setValue] = useState(initialValue)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const stored = readUIPreferences()[name]
    if (typeof stored === "boolean") setValue(stored)
    setLoaded(true)
  }, [name])
  useEffect(() => {
    if (!loaded) return
    try { window.localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ ...readUIPreferences(), [name]: value })) } catch {}
  }, [loaded, name, value])
  return [value, setValue] as const
}

function listField(name: string) {
  return /^(enable|disable|botAlias|otherBotQQ|masterQQ|disableAdopt|white(?:Group|QQ)?|black(?:Group|QQ)?)$/i.test(name)
    || /(?:whitelist|blacklist|allowlist|denylist|(?:qq|group|user)?ids?)$/i.test(name)
}
function multilineTextField(name: string, value: unknown) {
  if (typeof value !== "string") return false
  return value.includes("\n") || value.length > 120 || /(msg|message|content|notice|template|prompt|description|rule|expression|text)$/i.test(name)
}
function inferredListItemType(name: string) {
  return /qq|group|(?:^|[_-])ids?$/i.test(name) ? "number" : "string"
}
function numericBooleanField(name: string, value: unknown) {
  return (name === "autoFriend" || name === "addPrivate" || name === "isInheritDefault") && (value === 0 || value === 1)
}
function TagListField({ values, label, itemType = "string", placeholder = "输入新项", pluginNames, pluginNameGroup, pluginNamesLoading = false, pluginNamesError = "", friendOptions, friendsLoading = false, friendsError = "", groupOptions, groupsLoading = false, groupsError = "", mutuallyExclusiveValues = [], mutuallyExclusiveLabel = "另一名单", avatarKind, onChange }: { values: any[]; label: string; itemType?: "string" | "number" | "boolean"; placeholder?: string; pluginNames?: string[]; pluginNameGroup?: string; pluginNamesLoading?: boolean; pluginNamesError?: string; friendOptions?: FriendOption[]; friendsLoading?: boolean; friendsError?: string; groupOptions?: GroupOption[]; groupsLoading?: boolean; groupsError?: string; mutuallyExclusiveValues?: any[]; mutuallyExclusiveLabel?: string; avatarKind?: "qq" | "group"; onChange: (value: any[]) => void }) {
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSearch, setPickerSearch] = useState("")
  const [selectedPluginNames, setSelectedPluginNames] = useState<string[]>([])
  const [friendPickerOpen, setFriendPickerOpen] = useState(false)
  const [friendSearch, setFriendSearch] = useState("")
  const [selectedFriendIds, setSelectedFriendIds] = useState<string[]>([])
  const [groupPickerOpen, setGroupPickerOpen] = useState(false)
  const [groupSearch, setGroupSearch] = useState("")
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const filteredPluginNames = (pluginNames || []).filter(name => name.toLowerCase().includes(pickerSearch.trim().toLowerCase()))
  const existingValues = new Set(values.map(String))
  const mutuallyExclusiveSet = new Set(mutuallyExclusiveValues.map(String))
  const existingConflicts = values.filter(item => mutuallyExclusiveSet.has(String(item)))
  const filteredFriends = (friendOptions || []).filter(friend => `${friend.name} ${friend.id}`.toLowerCase().includes(friendSearch.trim().toLowerCase()))
  const filteredGroups = (groupOptions || []).filter(group => `${group.name} ${group.id}`.toLowerCase().includes(groupSearch.trim().toLowerCase()))

  function addValues(text = draft) {
    const entries = text.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
    if (!entries.length) return
    const conflicts = entries.filter(item => mutuallyExclusiveSet.has(item))
    if (conflicts.length) { setError(`${conflicts.join("、")} 已在${mutuallyExclusiveLabel}中，不能重复添加`); return }
    let additions: any[] = entries
    if (itemType === "number") {
      additions = entries.map(Number)
      if (additions.some(item => !Number.isFinite(item))) { setError("请输入有效数字"); return }
    } else if (itemType === "boolean") {
      const parsed = entries.map(item => /^(true|1|yes)$/i.test(item) ? true : /^(false|0|no)$/i.test(item) ? false : null)
      if (parsed.some(item => item === null)) { setError("请输入 true/false、1/0 或 yes/no"); return }
      additions = parsed
    }
    onChange([...values, ...additions])
    setDraft("")
    setError("")
  }

  function addSelectedPlugins() {
    const additions = selectedPluginNames.filter(name => !existingValues.has(name) && !mutuallyExclusiveSet.has(name))
    if (additions.length) onChange([...values, ...additions])
    setSelectedPluginNames([])
    setPickerOpen(false)
  }

  function addSelectedFriends() {
    const additions = selectedFriendIds.filter(id => !existingValues.has(id)).map(id => itemType === "number" ? Number(id) : id)
    if (additions.length) onChange([...values, ...additions])
    setSelectedFriendIds([])
    setFriendPickerOpen(false)
  }

  function addSelectedGroups() {
    const additions = selectedGroupIds.filter(id => !existingValues.has(id)).map(id => itemType === "number" ? Number(id) : id)
    if (additions.length) onChange([...values, ...additions])
    setSelectedGroupIds([])
    setGroupPickerOpen(false)
  }

  return <div className="space-y-1.5">
    <div role="group" aria-label={`${label}列表`} className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-xl border border-input bg-background p-2 shadow-sm transition focus-within:ring-2 focus-within:ring-ring">
    {values.map((item, index) => <span key={`${index}-${String(item)}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground">
      {avatarKind && /^\d+$/.test(String(item)) && <span className="relative grid size-5 shrink-0 place-items-center overflow-hidden rounded-full bg-card text-muted-foreground">{avatarKind === "group" ? <Users className="size-3" /> : <UserRound className="size-3" />}<img src={avatarKind === "group" ? (groupOptions || []).find(group => group.id === String(item))?.avatar || `https://p.qlogo.cn/gh/${encodeURIComponent(String(item))}/${encodeURIComponent(String(item))}/100/` : (friendOptions || []).find(friend => friend.id === String(item))?.avatar || `https://q1.qlogo.cn/g?b=qq&s=100&nk=${encodeURIComponent(String(item))}`} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" onError={event => { event.currentTarget.style.display = "none" }} /></span>}
      <span className="max-w-[min(32ch,60vw)] truncate" title={String(item)}>{item}</span>
      <Button variant="ghost" type="button" className={cn("h-auto justify-center whitespace-normal p-0", "grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition hover:bg-card hover:text-rose-600 dark:hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")} aria-label={`删除${label}：${item}`} title="删除此项" onClick={() => onChange(values.filter((_, valueIndex) => valueIndex !== index))}><X className="size-3.5" /></Button>
    </span>)}
    <Input aria-label={`${label}，添加一项`} className="h-8 min-w-32 flex-1 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0" inputMode={itemType === "number" ? "decimal" : undefined} placeholder={placeholder} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addValues() } }} onPaste={event => { const text = event.clipboardData.getData("text"); if (text.includes("\n")) { event.preventDefault(); addValues([draft, text].filter(Boolean).join("\n")) } }} />
    <Button type="button" size="icon" variant="ghost" className="size-8 shrink-0" aria-label={`添加${label}`} title="添加一项" disabled={!draft.trim()} onClick={() => addValues()}><Plus className="size-4" /></Button>
    {friendOptions !== undefined && <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 px-2 text-[11px]" aria-label={`从好友中选择${label}`} title="从好友列表中选择" onClick={() => { setFriendSearch(""); setSelectedFriendIds([]); setFriendPickerOpen(true) }}><Users className="size-3.5" />选择好友</Button>}
      {groupOptions !== undefined && <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 px-2 text-[11px]" aria-label={`从群聊中选择${label}`} title="从群聊列表中选择" onClick={() => { setGroupSearch(""); setSelectedGroupIds([]); setGroupPickerOpen(true) }}><Users className="size-3.5" />选择群聊</Button>}
    {pluginNames !== undefined && <Button type="button" size="sm" variant="outline" className="h-8 shrink-0 px-2 text-[11px]" aria-label={`从插件名称选择${label}`} title="从已加载插件中选择" onClick={() => { setPickerSearch(""); setSelectedPluginNames([]); setPickerOpen(true) }}><Search className="size-3.5" />选择插件</Button>}
    </div>
    {error && <p role="alert" className="text-[10px] text-rose-600 dark:text-rose-300">{error}</p>}
    {existingConflicts.length > 0 && <p role="alert" className="text-[10px] text-amber-700 dark:text-amber-300">{existingConflicts.map(String).join("、")} 同时存在于{mutuallyExclusiveLabel}，运行时会按禁用名单处理。</p>}
        {groupOptions !== undefined && <Dialog.Root open={groupPickerOpen} onOpenChange={open => { setGroupPickerOpen(open); if (!open) setSelectedGroupIds([]) }}>
          <Dialog.Portal>
            <Dialog.Overlay className="admin-dialog-overlay fixed inset-0 z-[60] bg-neutral-950/40 backdrop-blur-[2px]" />
            <Dialog.Content className="admin-dialog-content fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card p-5 shadow-2xl focus:outline-none">
              <Dialog.Title className="text-base font-semibold">选择群聊</Dialog.Title>
              <Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">选择后添加到{label}；已存在的群聊不可重复添加。</Dialog.Description>
              <CommandMenu shouldFilter={false} tabIndex={0} className="min-h-0 flex-1"><CommandInput aria-label="搜索群聊" placeholder="搜索群名或群号…" value={groupSearch} onValueChange={setGroupSearch}  /><CommandList aria-label="群聊列表" aria-multiselectable="true" className="mt-3 min-h-24 flex-1 space-y-1 overflow-y-auto rounded-lg border border-border p-1.5">
                {groupsLoading ? <div className="grid min-h-24 place-items-center text-xs text-muted-foreground"><LoaderCircle className="mb-2 size-4 animate-spin" />正在获取群聊</div>
                  : groupsError ? <p role="alert" className="p-3 text-xs text-rose-600 dark:text-rose-300">{groupsError}</p>
                    : filteredGroups.length ? filteredGroups.map(group => {
                      const added = existingValues.has(group.id)
                      const checked = selectedGroupIds.includes(group.id)
                      return <CommandItem value={group.id} key={group.id} aria-selected={added || checked} disabled={added} onSelect={() => setSelectedGroupIds(current => checked ? current.filter(id => id !== group.id) : [...current, group.id])} className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition ${added ? "text-muted-foreground" : checked ? "bg-accent text-foreground" : "text-foreground hover:bg-muted"}`}>
                        <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-muted-foreground"><Users className="size-4" /><img src={group.avatar} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" onError={event => { event.currentTarget.style.display = "none" }} /></span>
                        {checked || added ? <Check className="size-3.5 shrink-0" /> : <Plus className="size-3.5 shrink-0 text-muted-foreground" />}
                        <span className="min-w-0 flex-1"><span className="block truncate">{group.name}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">{group.id}</span></span><span className="text-[10px] text-muted-foreground">{added ? "已添加" : ""}</span>
                      </CommandItem>
                    })
                    : <p className="p-3 text-xs text-muted-foreground">{groupOptions.length ? "没有匹配的群聊" : "当前没有已缓存的群聊"}</p>}
              </CommandList></CommandMenu>
              <div className="mt-3 flex items-center justify-between gap-3"><span className="text-[10px] text-muted-foreground">已选 {selectedGroupIds.length} 个群</span><div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setGroupPickerOpen(false)}>取消</Button><Button type="button" size="sm" disabled={!selectedGroupIds.length || groupsLoading} onClick={addSelectedGroups}><Check />添加所选</Button></div></div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>}
    {pluginNames !== undefined && <Dialog.Root open={pickerOpen} onOpenChange={open => { setPickerOpen(open); if (!open) setSelectedPluginNames([]) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-overlay fixed inset-0 z-[60] bg-neutral-950/40 backdrop-blur-[2px]" />
        <Dialog.Content className="admin-dialog-content fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card p-5 shadow-2xl focus:outline-none">
          <Dialog.Title className="text-base font-semibold">选择{label}</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">{pluginNameGroup || "当前群组"} · 名称与 Yunzai 插件匹配规则一致。</Dialog.Description>
          <CommandMenu shouldFilter={false} tabIndex={0} className="min-h-0 flex-1"><CommandInput aria-label="搜索插件名称" placeholder="搜索已加载插件…" value={pickerSearch} onValueChange={setPickerSearch}  /><CommandList aria-label="已加载插件名称" aria-multiselectable="true" className="mt-3 min-h-24 flex-1 space-y-1 overflow-y-auto rounded-lg border border-border p-1.5">
            {pluginNamesLoading ? <div className="grid min-h-24 place-items-center text-xs text-muted-foreground"><LoaderCircle className="mb-2 size-4 animate-spin" />正在获取插件名称</div>
              : pluginNamesError ? <p role="alert" className="p-3 text-xs text-rose-600 dark:text-rose-300">{pluginNamesError}</p>
                : filteredPluginNames.length ? filteredPluginNames.map(name => {
                  const added = existingValues.has(name)
                  const excluded = mutuallyExclusiveSet.has(name)
                  const checked = selectedPluginNames.includes(name)
                  return <CommandItem value={name} key={name} aria-selected={added || checked} disabled={added || excluded} onSelect={() => setSelectedPluginNames(current => checked ? current.filter(item => item !== name) : [...current, name])} className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition ${added || excluded ? "text-muted-foreground" : checked ? "bg-accent text-foreground" : "text-foreground hover:bg-muted"}`}>
                    {checked || added ? <Check className="size-3.5 shrink-0" /> : <Plus className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate">{name}</span><span className="text-[10px] text-muted-foreground">{added ? "已添加" : excluded ? `在${mutuallyExclusiveLabel}` : ""}</span>
                  </CommandItem>
                })
                : <p className="p-3 text-xs text-muted-foreground">{pluginNames?.length ? "没有匹配的插件" : "当前没有已加载的插件名称"}</p>}
          </CommandList></CommandMenu>
          <div className="mt-3 flex items-center justify-between gap-3"><span className="text-[10px] text-muted-foreground">已选 {selectedPluginNames.length} 项</span><div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(false)}>取消</Button><Button type="button" size="sm" disabled={!selectedPluginNames.length || pluginNamesLoading} onClick={addSelectedPlugins}><Check />添加所选</Button></div></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>}
    {friendOptions !== undefined && <Dialog.Root open={friendPickerOpen} onOpenChange={open => { setFriendPickerOpen(open); if (!open) setSelectedFriendIds([]) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-overlay fixed inset-0 z-[60] bg-neutral-950/40 backdrop-blur-[2px]" />
        <Dialog.Content className="admin-dialog-content fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card p-5 shadow-2xl focus:outline-none">
          <Dialog.Title className="text-base font-semibold">选择好友</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">选择后添加到{label}；未缓存的 QQ 号仍可手动输入。</Dialog.Description>
          <CommandMenu shouldFilter={false} tabIndex={0} className="min-h-0 flex-1"><CommandInput aria-label="搜索好友" placeholder="搜索昵称、备注或 QQ 号…" value={friendSearch} onValueChange={setFriendSearch}  /><CommandList aria-label="好友列表" aria-multiselectable="true" className="mt-3 min-h-24 flex-1 space-y-1 overflow-y-auto rounded-lg border border-border p-1.5">
            {friendsLoading ? <div className="grid min-h-24 place-items-center text-xs text-muted-foreground"><LoaderCircle className="mb-2 size-4 animate-spin" />正在获取好友列表</div>
              : friendsError ? <p role="alert" className="p-3 text-xs text-rose-600 dark:text-rose-300">{friendsError}</p>
                : filteredFriends.length ? filteredFriends.map(friend => {
                  const added = existingValues.has(friend.id)
                  const checked = selectedFriendIds.includes(friend.id)
                  return <CommandItem value={friend.id} key={friend.id} aria-selected={added || checked} disabled={added} onSelect={() => setSelectedFriendIds(current => checked ? current.filter(id => id !== friend.id) : [...current, friend.id])} className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition ${added ? "text-muted-foreground" : checked ? "bg-accent text-foreground" : "text-foreground hover:bg-muted"}`}>
                    <span className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-muted-foreground"><UserRound className="size-4" /><img src={friend.avatar} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" onError={event => { event.currentTarget.style.display = "none" }} /></span>
                    {checked || added ? <Check className="size-3.5 shrink-0" /> : <Plus className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1"><span className="block truncate">{friend.name}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">{friend.id}</span></span><span className="text-[10px] text-muted-foreground">{added ? "已添加" : ""}</span>
                  </CommandItem>
                })
                : <p className="p-3 text-xs text-muted-foreground">{friendOptions.length ? "没有匹配的好友" : "当前没有已缓存的好友"}</p>}
          </CommandList></CommandMenu>
          <div className="mt-3 flex items-center justify-between gap-3"><span className="text-[10px] text-muted-foreground">已选 {selectedFriendIds.length} 位</span><div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => setFriendPickerOpen(false)}>取消</Button><Button type="button" size="sm" disabled={!selectedFriendIds.length || friendsLoading} onClick={addSelectedFriends}><Check />添加所选</Button></div></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>}
  </div>
}

function StringListField({ name, value, label, pluginNames, pluginNameGroup, pluginNamesLoading, pluginNamesError, friendOptions, friendsLoading, friendsError, groupOptions, groupsLoading, groupsError, mutuallyExclusiveValues, mutuallyExclusiveLabel, onChange }: { name: string; value: string; label: string; pluginNames?: string[]; pluginNameGroup?: string; pluginNamesLoading?: boolean; pluginNamesError?: string; friendOptions?: FriendOption[]; friendsLoading?: boolean; friendsError?: string; groupOptions?: GroupOption[]; groupsLoading?: boolean; groupsError?: string; mutuallyExclusiveValues?: any[]; mutuallyExclusiveLabel?: string; onChange: (value: string) => void }) {
  const values = value.split(/\r?\n/).filter(item => item.trim() !== "")
  const avatarKind = /group/i.test(name) ? "group" : /qq|user/i.test(name) ? "qq" : undefined
  return <TagListField values={values} label={label} placeholder="添加一项" pluginNames={pluginNames} pluginNameGroup={pluginNameGroup} pluginNamesLoading={pluginNamesLoading} pluginNamesError={pluginNamesError} friendOptions={avatarKind === "qq" ? friendOptions : undefined} friendsLoading={friendsLoading} friendsError={friendsError} groupOptions={avatarKind === "group" ? groupOptions : undefined} groupsLoading={groupsLoading} groupsError={groupsError} mutuallyExclusiveValues={mutuallyExclusiveValues} mutuallyExclusiveLabel={mutuallyExclusiveLabel} avatarKind={avatarKind} onChange={next => onChange(next.join("\n"))} />
}

function isSimpleRecord(value: any) {
  return isObject(value) && Object.values(value).every(item => item === null || typeof item !== "object")
}

function RecordListField({ rows, template, label, onChange }: { rows: any[]; template: Record<string, any>; label: string; onChange: (value: any[]) => void }) {
  function updateField(index: number, field: string, value: any) {
    onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row))
  }

  const keyValueLabels = label.includes("替换")
    ? { key: "匹配规则", value: "替换文本" }
    : { key: "键", value: "值" }

  return <div className="space-y-2.5">
    {rows.map((row, index) => <div key={index} className="rounded-xl border border-border bg-card p-3.5 shadow-xs">
      <div className="mb-3 flex items-center justify-between"><span className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground"><span className="grid size-4 place-items-center rounded-md bg-accent text-[10px] font-semibold tabular-nums text-foreground">{index + 1}</span>{label}</span><Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-rose-600" aria-label={`删除${label} ${index + 1}`} title="删除此项" onClick={() => onChange(rows.filter((_, rowIndex) => rowIndex !== index))}><X className="size-3.5" /></Button></div>
      <div className="grid gap-3 sm:grid-cols-2">{Object.entries(row).map(([field, current]) => <div key={field} className="min-w-0 space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">{keyValueLabels[field as "key" | "value"] || configFieldLabel(field)}</Label>
        {typeof current === "boolean"
          ? <div className="flex h-9 items-center justify-between rounded-lg border border-border px-3"><span className="text-[10px] text-muted-foreground">{current ? "是" : "否"}</span><Switch checked={current} onCheckedChange={next => updateField(index, field, next)} /></div>
          : typeof current === "number"
            ? <Input type="number" className="h-9 text-xs" value={current} onChange={event => updateField(index, field, event.target.value === "" ? "" : Number(event.target.value))} />
            : <Input className="h-9 text-xs" value={current == null ? "" : String(current)} placeholder="可留空" onChange={event => updateField(index, field, event.target.value)} />}
      </div>)}</div>
    </div>)}
    <Button type="button" size="sm" variant="outline" className="h-8 text-[11px]" onClick={() => onChange([...rows, { ...template }])}><Plus className="size-3.5" />添加{label.includes("规则") ? "规则" : "项目"}</Button>
  </div>
}

function StructuredConfigField({ value, label, onChange, arrayOnly = false }: { value: any; label: string; onChange: (value: any) => void; arrayOnly?: boolean }) {
  const serialized = stringifyYaml(value) || ""
  const [draft, setDraft] = useState(serialized)
  useEffect(() => setDraft(serialized), [serialized])
  return <Textarea
    aria-label={`${label}，YAML 多行编辑`}
    className="min-h-32 resize-y font-mono text-xs leading-6"
    spellCheck={false}
    value={draft}
    onChange={event => {
      const next = event.target.value
      setDraft(next)
      try {
        const parsed = parseYaml(next)
        if (arrayOnly ? Array.isArray(parsed) : isObject(parsed) || Array.isArray(parsed)) onChange(parsed)
      } catch {}
    }}
  />
}

function ConfigListField({ name, label, value, defaultValue, onChange, forceItemType, forceAvatarKind, pluginNames, pluginNameGroup, pluginNamesLoading, pluginNamesError, friendOptions, friendsLoading, friendsError, groupOptions, groupsLoading, groupsError, mutuallyExclusiveValues, mutuallyExclusiveLabel }: { name: string; label: string; value: any; defaultValue?: any; onChange: (value: any) => void; forceItemType?: "string" | "number" | "boolean"; forceAvatarKind?: "qq" | "group"; pluginNames?: string[]; pluginNameGroup?: string; pluginNamesLoading?: boolean; pluginNamesError?: string; friendOptions?: FriendOption[]; friendsLoading?: boolean; friendsError?: string; groupOptions?: GroupOption[]; groupsLoading?: boolean; groupsError?: string; mutuallyExclusiveValues?: any[]; mutuallyExclusiveLabel?: string }) {
  const values = Array.isArray(value) ? value : []
  const defaults = Array.isArray(defaultValue) ? defaultValue : []
  const sampleValues = values.length ? values : defaults
  const complex = sampleValues.some(item => isObject(item) || Array.isArray(item))
  const primitiveTypes = new Set(sampleValues.filter(item => item !== null && item !== undefined).map(item => typeof item))
  const structured = complex || primitiveTypes.size > 1
  const recordList = structured && sampleValues.length > 0 && sampleValues.every(isSimpleRecord)
  const detectedType = sampleValues.find(item => item !== null && item !== undefined)
  const itemType = (forceItemType || (detectedType ? typeof detectedType : inferredListItemType(name))) as "string" | "number" | "boolean"
  if (recordList) {
    const template = sampleValues.find(isSimpleRecord) || { key: "", value: "" }
    return <RecordListField rows={values} template={template} label={label} onChange={onChange} />
  }
  if (structured) return <StructuredConfigField value={values} label={label} onChange={onChange} arrayOnly />

  if (name === "disableAdopt") return <div className="space-y-2.5">
    <p className="text-[11px] leading-5 text-muted-foreground">{configFieldDescriptions.disableAdopt}</p>
    <TagListField values={values} label={label} placeholder="例如：stoken" onChange={onChange} />
  </div>

  const supportsPluginNames = name === "enable" || name === "disable"
  const avatarKind = forceAvatarKind || (/group/i.test(name) ? "group" : /qq|user/i.test(name) ? "qq" : undefined)
  return <TagListField values={values} label={label} itemType={itemType} placeholder={itemType === "number" ? "输入数字" : itemType === "boolean" ? "输入 true/false" : "输入新项"} pluginNames={supportsPluginNames ? pluginNames : undefined} pluginNameGroup={pluginNameGroup} pluginNamesLoading={pluginNamesLoading} pluginNamesError={pluginNamesError} friendOptions={avatarKind === "qq" ? friendOptions : undefined} friendsLoading={friendsLoading} friendsError={friendsError} groupOptions={avatarKind === "group" ? groupOptions : undefined} groupsLoading={groupsLoading} groupsError={groupsError} mutuallyExclusiveValues={supportsPluginNames ? mutuallyExclusiveValues : undefined} mutuallyExclusiveLabel={mutuallyExclusiveLabel} avatarKind={avatarKind} onChange={next => onChange(next)} />
}

function ConfigField({ name, value, defaultValue, path, onChange, depth = 0, pluginNames, pluginNameGroup, pluginNamesLoading, pluginNamesError, friendOptions, friendsLoading, friendsError, groupOptions, groupsLoading, groupsError, mutuallyExclusiveValues, mutuallyExclusiveLabel }: { name: string; value: any; defaultValue?: any; path: string[]; onChange: (path: string[], value: any) => void; depth?: number; pluginNames?: string[]; pluginNameGroup?: string; pluginNamesLoading?: boolean; pluginNamesError?: string; friendOptions?: FriendOption[]; friendsLoading?: boolean; friendsError?: string; groupOptions?: GroupOption[]; groupsLoading?: boolean; groupsError?: string; mutuallyExclusiveValues?: any[]; mutuallyExclusiveLabel?: string }) {
  const label = configFieldLabel(name)
  if (isObject(value)) return <div className={`${depth ? "ml-3 border-l border-border pl-4" : ""}`}><div className="mb-3 flex items-center gap-2 border-b border-border/60 pb-2"><span className="grid size-6 place-items-center rounded-md bg-accent text-foreground"><Braces className="size-3.5" /></span><span className="text-sm font-semibold">{label}</span></div><div className="space-y-4">{Object.entries(value).map(([child, current]) => {
    const peerName = child === "enable" ? "disable" : child === "disable" ? "enable" : ""
    const peerValues = peerName && Array.isArray(value[peerName]) ? value[peerName] : undefined
    return <ConfigField key={child} name={child} value={current} defaultValue={defaultValue?.[child]} path={[...path, child]} onChange={onChange} depth={depth + 1} pluginNames={pluginNames} pluginNameGroup={pluginNameGroup} pluginNamesLoading={pluginNamesLoading} pluginNamesError={pluginNamesError} friendOptions={friendOptions} friendsLoading={friendsLoading} friendsError={friendsError} groupOptions={groupOptions} groupsLoading={groupsLoading} groupsError={groupsError} mutuallyExclusiveValues={peerValues} mutuallyExclusiveLabel={peerName ? configFieldLabel(peerName) : undefined} />
  })}</div></div>
  const hintValue = Array.isArray(defaultValue) ? defaultValue.join(", ") : isObject(defaultValue) ? stringifyYaml(defaultValue).replace(/\s+/g, " ").trim() : String(defaultValue)
  const hint = defaultValue !== undefined && JSON.stringify(value) !== JSON.stringify(defaultValue) ? `默认值：${hintValue}` : ""
  const nullableList = (value === null || value === undefined) && listField(name)
  const multilineText = multilineTextField(name, value)
  const numericToggle = numericBooleanField(name, value)
  const selectOptions = configSelectOptions[name]
  const selectValue = value === null || value === undefined ? "" : String(value)
  const hasValidSelection = selectOptions?.some(option => option.value === selectValue)
  return <div className={`grid gap-3 ${depth ? "md:grid-cols-[minmax(150px,240px)_minmax(240px,1fr)]" : "md:grid-cols-[minmax(170px,245px)_minmax(240px,1fr)]"}`}>
    <div className="pt-1"><div className="text-xs font-medium capitalize">{label}</div>{configFieldDescriptions[name] && <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{configFieldDescriptions[name]}</div>}{hint && <div className="mt-1 text-[10px] text-muted-foreground">{hint}</div>}</div>
    <div className="min-w-0">{selectOptions ? <Select value={selectValue} onValueChange={selected => onChange(path, numericConfigSelectFields.has(name) ? Number(selected) : selected)}><SelectTrigger aria-label={label} className={` ${hasValidSelection ? "border-border" : "border-amber-400 text-amber-800 dark:text-amber-300"}`}><SelectValue placeholder="未设置，请选择" /></SelectTrigger><SelectContent>{!hasValidSelection && selectValue && <SelectItem value={selectValue} disabled>无效值：{selectValue}，请选择</SelectItem>}{selectOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>
      : typeof value === "boolean" || numericToggle ? <div className="flex h-10 items-center justify-between rounded-xl border border-border px-3"><span className="text-xs text-muted-foreground">{value ? "已启用" : "已关闭"}</span><Switch checked={Boolean(value)} onCheckedChange={next => onChange(path, numericToggle ? (next ? 1 : 0) : next)} /></div>
      : name === "masterQQ" ? <ConfigListField name={name} label={label} value={Array.isArray(value) ? value : value == null ? [] : [value]} forceItemType="number" forceAvatarKind="qq" friendOptions={friendOptions} friendsLoading={friendsLoading} friendsError={friendsError} onChange={next => onChange(path, next)} />
      : typeof value === "number" ? <Input type="number" value={value} onChange={event => onChange(path, event.target.value === "" ? "" : Number(event.target.value))} />
      : Array.isArray(value) || nullableList ? <ConfigListField name={name} label={label} value={value} defaultValue={defaultValue} pluginNames={pluginNames} pluginNameGroup={pluginNameGroup} pluginNamesLoading={pluginNamesLoading} pluginNamesError={pluginNamesError} friendOptions={friendOptions} friendsLoading={friendsLoading} friendsError={friendsError} groupOptions={groupOptions} groupsLoading={groupsLoading} groupsError={groupsError} mutuallyExclusiveValues={mutuallyExclusiveValues} mutuallyExclusiveLabel={mutuallyExclusiveLabel} onChange={next => onChange(path, next)} />
      : listField(name) && typeof value === "string" ? <StringListField name={name} label={label} value={value} pluginNames={pluginNames} pluginNameGroup={pluginNameGroup} pluginNamesLoading={pluginNamesLoading} pluginNamesError={pluginNamesError} friendOptions={friendOptions} friendsLoading={friendsLoading} friendsError={friendsError} groupOptions={groupOptions} groupsLoading={groupsLoading} groupsError={groupsError} mutuallyExclusiveValues={mutuallyExclusiveValues} mutuallyExclusiveLabel={mutuallyExclusiveLabel} onChange={next => onChange(path, next)} />
      : value === null || value === undefined ? secretField(name) ? <SecretInput value="" placeholder="未设置" onChange={event => onChange(path, event.target.value || null)} /> : <Input value="" placeholder="未设置" onChange={event => onChange(path, event.target.value || null)} />
      : multilineText && !secretField(name) ? <Textarea aria-label={`${label}，多行编辑`} className="min-h-24 resize-y text-sm leading-6" value={String(value)} onChange={event => onChange(path, event.target.value)} />
      : secretField(name) ? <SecretInput value={String(value)} onChange={event => onChange(path, event.target.value)} /> : <Input type="text" value={String(value)} onChange={event => onChange(path, event.target.value)} />}</div>
  </div>
}

function splitPluginSchemaGroups(schemas: any[]) {
  const groups: { label: string; schemas: any[] }[] = []
  const ungrouped: any[] = []
  let currentGroup: { label: string; schemas: any[] } | null = null
  for (const schema of schemas) {
    if (schema.component === "SOFT_GROUP_BEGIN") {
      if (!currentGroup && ungrouped.length) groups.push({ label: "常规设置", schemas: ungrouped.splice(0) })
      currentGroup = { label: schema.label || `设置组 ${groups.length + 1}`, schemas: [] }
      groups.push(currentGroup)
    } else if (currentGroup) {
      currentGroup.schemas.push(schema)
    } else {
      ungrouped.push(schema)
    }
  }
  if (!groups.length) return [{ label: "", schemas: ungrouped }]
  if (ungrouped.length) groups.unshift({ label: "常规设置", schemas: ungrouped })
  return groups
}

function groupSchemaFields(schemas: any[], data: any) {
  const groups: { kind: "cards" | "wide" | "field"; schemas: any[] }[] = []
  for (const schema of schemas) {
    if (!schema?.field) continue
    const component = String(schema.component || "Input")
    const value = getNested(data, schema.field)
    const props = schema.componentProps || {}
    const optionLabels = (Array.isArray(props.options) ? props.options : []).map((option: any) => String(option && typeof option === "object" ? option.label ?? option.title ?? option.value ?? "" : option))
    const compactOptionGroup = (component === "CheckboxGroup" || (component === "Select" && (props.mode === "multiple" || props.mode === "tags"))) && optionLabels.length <= 8 && optionLabels.reduce((length: number, text: string) => length + Array.from(text).length, 0) <= 36
    const recordList = Array.isArray(value) && value.length > 0 && value.every(isSimpleRecord)
    const fullWidth = (Array.isArray(value) && !compactOptionGroup) || isObject(value) || component === "InputTextArea" || component === "EasyCron" || component === "GTags" || (component === "CheckboxGroup" && !compactOptionGroup) || component === "GSelectFriend" || component === "GSelectGroup" || component === "GSubForm" || (component === "Select" && (props.mode === "multiple" || props.mode === "tags") && !compactOptionGroup) || (multilineTextField(schema.field, value) && !secretField(schema.field))
    const compact = component === "Switch" || ["Input", "InputNumber", "Select", "RadioGroup", "ColorPicker", "GColorPicker"].includes(component) || compactOptionGroup
    const kind = recordList ? "wide" : compact && !fullWidth ? "cards" : "field"
    const previous = groups[groups.length - 1]
    if (kind === "cards" && previous?.kind === "cards") previous.schemas.push(schema)
    else groups.push({ kind, schemas: [schema] })
  }
  return groups
}

function PluginCenter({ api, notify, confirm }: { api: Api; notify: any; confirm: Confirm }) {
  const validateCron = useCallback((expression: string) => api("/api/cron/validate", { method: "POST", body: JSON.stringify({ expression }) }), [api])
  const [plugins, setPlugins] = useState<any[]>([])
  const [pluginSidebarCollapsed, setPluginSidebarCollapsed] = useBrowserBooleanPreference("pluginSidebarCollapsed")
  const [sourceFullscreen, setSourceFullscreen] = useState(false)
  const [archives, setArchives] = useState<any[]>([])
  const [selected, setSelected] = useState<any>(null)
  const [activeSchemaGroup, setActiveSchemaGroup] = useState(0)
  const [data, setData] = useState<any>({})
  const [sourceContent, setSourceContent] = useState("")
  const [sourceVersion, setSourceVersion] = useState("")
  const [pluginConfigVersion, setPluginConfigVersion] = useState("")
  const [sourceDirty, setSourceDirty] = useState(false)
  const [selectedConfigFile, setSelectedConfigFile] = useState("")
  const [configPreview, setConfigPreview] = useState("")
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [largeSearch, setLargeSearch] = useState("")
  const [smallSearch, setSmallSearch] = useState("")
  const [showInstall, setShowInstall] = useState(false)
  const [installUrl, setInstallUrl] = useState("")
  const [installProxy, setInstallProxy] = useState({ proxyMode: "none", proxy: "" })
  const [showUnconfigured, setShowUnconfigured] = useState(false)
  const [installName, setInstallName] = useState("")
  const [installDependencies, setInstallDependencies] = useState(false)
  const [restartAfterInstall, setRestartAfterInstall] = useState(false)
  const [actionArgs, setActionArgs] = useState("{}")
  const [schemaFriendOptions, setSchemaFriendOptions] = useState<FriendOption[]>()
  const [schemaFriendsLoading, setSchemaFriendsLoading] = useState(false)
  const [schemaFriendsError, setSchemaFriendsError] = useState("")
  const [schemaGroupOptions, setSchemaGroupOptions] = useState<GroupOption[]>()
  const [schemaGroupsLoading, setSchemaGroupsLoading] = useState(false)
  const [schemaGroupsError, setSchemaGroupsError] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    if (!sourceFullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSourceFullscreen(false)
    }
    document.addEventListener("keydown", handleKeyDown, true)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener("keydown", handleKeyDown, true)
    }
  }, [sourceFullscreen])
  const refresh = useCallback(async () => {
    setLoading(true); setError("")
    try {
      const [result, archiveResult] = await Promise.all([api("/api/plugins"), api("/api/plugins/archives")])
      setPlugins(result.plugins); setArchives(archiveResult.archives)
      if (selected) setSelected(result.plugins.find((plugin: any) => plugin.id === selected.id) || null)
      if (!selected && result.plugins.length) {
        const requested = routeQuery("plugin")
        setSelected(result.plugins.find((plugin: any) => plugin.id === requested) || result.plugins[0])
      }
    }
    catch (reason) { setError((reason as Error).message) }
    finally { setLoading(false) }
  }, [api, selected])
  useEffect(() => { refresh() }, []) // initial discovery
  const activeConfigFile = selected?.configFiles?.find((file: any) => file.path === selectedConfigFile) || selected?.configFiles?.[0]
  const schemaGroups = selected?.hasConfig ? splitPluginSchemaGroups(selected.schemas) : []
  const hasSchemaGroupTabs = Boolean(selected?.hasConfig && selected.schemas.some((schema: any) => schema.component === "SOFT_GROUP_BEGIN"))
  const activeSchemaGroupData = schemaGroups[activeSchemaGroup] || schemaGroups[0]
  const schemaRows = groupSchemaFields(hasSchemaGroupTabs ? activeSchemaGroupData?.schemas || [] : selected?.schemas || [], data)
  const schemaItems = schemaRows.flatMap(row => row.schemas.map((schema, index) => ({ kind: row.kind, schema, index })))
  type SchemaLayoutEntry =
    | { kind: "panel"; items: typeof schemaItems }
    | { kind: "block"; schema: any; index: number }
  const schemaLayout: SchemaLayoutEntry[] = []
  for (let index = 0; index < schemaItems.length; index++) {
    const item = schemaItems[index]
    if (item.kind === "cards") {
      const items = [item]
      while (index + 1 < schemaItems.length && schemaItems[index + 1].kind === "cards") items.push(schemaItems[++index])
      schemaLayout.push({ kind: "panel", items })
    } else {
      schemaLayout.push({ kind: "block", schema: item.schema, index: item.index })
    }
  }
  const needsSchemaFriends = Boolean(selected?.hasConfig && selected.schemas.some((schema: any) => schema.component === "GSelectFriend" || /qq|friend|user/i.test(String(schema.field || ""))))
  const needsSchemaGroups = Boolean(selected?.hasConfig && selected.schemas.some((schema: any) => schema.component === "GSelectGroup" || /group/i.test(String(schema.field || ""))))
  useEffect(() => {
    let cancelled = false
    if (needsSchemaFriends) {
      setSchemaFriendOptions([])
      setSchemaFriendsError("")
      setSchemaFriendsLoading(true)
      api("/api/config/friends")
        .then(result => { if (!cancelled) setSchemaFriendOptions(Array.isArray(result.friends) ? result.friends : []) })
        .catch(reason => { if (!cancelled) setSchemaFriendsError((reason as Error).message) })
        .finally(() => { if (!cancelled) setSchemaFriendsLoading(false) })
    } else {
      setSchemaFriendOptions(undefined)
      setSchemaFriendsError("")
      setSchemaFriendsLoading(false)
    }
    if (needsSchemaGroups) {
      setSchemaGroupOptions([])
      setSchemaGroupsError("")
      setSchemaGroupsLoading(true)
      api("/api/config/groups")
        .then(result => { if (!cancelled) setSchemaGroupOptions(Array.isArray(result.groups) ? result.groups : []) })
        .catch(reason => { if (!cancelled) setSchemaGroupsError((reason as Error).message) })
        .finally(() => { if (!cancelled) setSchemaGroupsLoading(false) })
    } else {
      setSchemaGroupOptions(undefined)
      setSchemaGroupsError("")
      setSchemaGroupsLoading(false)
    }
    return () => { cancelled = true }
  }, [api, needsSchemaFriends, needsSchemaGroups, selected?.id])
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setError("")
    setDetailLoading(true)
    const loadSelected = async () => {
      try {
        if (selected.kind === "small") {
          const result = await api(`/api/files/read?path=${encodeURIComponent(selected.sourcePath)}`)
          if (!cancelled) { setSourceContent(result.content); setSourceVersion(result.version); setSourceDirty(false) }
        } else if (selected.hasConfig) {
          const result = await api(`/api/plugins/${encodeURIComponent(selected.id)}/config`)
          if (!cancelled) { setData(result.data || {}); setPluginConfigVersion(result.version) }
        } else if (activeConfigFile) {
          const result = await api(`/api/files/read?path=${encodeURIComponent(activeConfigFile.path)}`)
          if (!cancelled) setConfigPreview(result.content)
        }
      } catch (reason) {
        if (!cancelled) setError((reason as Error).message)
      } finally {
        if (!cancelled) setDetailLoading(false)
      }
    }
    void loadSelected()
    return () => { cancelled = true }
  }, [api, selected?.id, selected?.kind, selected?.hasConfig, selected?.sourcePath, activeConfigFile?.path])
  function selectPlugin(plugin: any) {
    if (selected?.id === plugin.id) return
    setSelected(plugin)
    setActiveSchemaGroup(0)
    setData({})
    setSourceContent("")
    setSourceDirty(false)
    setSelectedConfigFile(plugin.configFiles?.[0]?.path || "")
    setConfigPreview("")
    setError("")
  }
  function choosePlugin(plugin: any) {
    if (selected?.id === plugin.id) return
    setRouteQuery("plugin", plugin.id)
    selectPlugin(plugin)
  }
  useEffect(() => {
    const syncSelection = () => {
      if (sectionFromPath(window.location.pathname) !== "plugins") return
      const requested = routeQuery("plugin")
      const target = plugins.find(plugin => plugin.id === requested) || plugins[0]
      if (target && target.id !== selected?.id) selectPlugin(target)
    }
    window.addEventListener("popstate", syncSelection)
    return () => window.removeEventListener("popstate", syncSelection)
  }, [plugins, selected?.id])
  const largePlugins = plugins.filter(plugin => plugin.kind === "large")
  const smallPlugins = plugins.filter(plugin => plugin.kind === "small")
  const hasUnconfiguredLargePlugins = largePlugins.some(plugin => !plugin.hasSupportFile && !plugin.configFiles?.length)
  const shownLarge = largePlugins.filter(plugin => `${plugin.title} ${plugin.name} ${plugin.author}`.toLowerCase().includes(largeSearch.toLowerCase()))
  const shownSmall = smallPlugins.filter(plugin => `${plugin.title} ${plugin.name} ${plugin.author}`.toLowerCase().includes(smallSearch.toLowerCase()))
  function update(field: string, value: any) { setData((old: any) => setNested(old, field.split("."), value)) }
  function renderSchemaField(schema: any, index: number, compactCard = false) {
    return <SchemaField key={`${schema.field}-${index}`} schema={schema} value={getNested(data, schema.field)} onChange={value => update(schema.field, value)} validateCron={validateCron} friendOptions={schemaFriendOptions} friendsLoading={schemaFriendsLoading} friendsError={schemaFriendsError} groupOptions={schemaGroupOptions} groupsLoading={schemaGroupsLoading} groupsError={schemaGroupsError} compactCard={compactCard} />
  }
  async function save() {
    if (!selected || busy) return
    setBusy(true)
    try {
      const values: Record<string, any> = {}
      for (const schema of selected.schemas) if (schema.field) values[schema.field] = getNested(data, schema.field)
      const result = await api(`/api/plugins/${encodeURIComponent(selected.id)}/config`, { method: "PUT", body: JSON.stringify({ ...values, ...(data._version ? { _version: data._version } : {}), _panelVersion: pluginConfigVersion }) })
      if (result.code !== undefined && result.code !== 0) throw new Error(result.message || "保存失败")
      notify("success", result.message || `${selected.title} 配置已保存`)
      const saved = await api(`/api/plugins/${encodeURIComponent(selected.id)}/config`)
      setData(saved.data || {})
      setPluginConfigVersion(saved.version)
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  async function saveSource() {
    if (!selected?.sourcePath || !sourceDirty || busy) return
    setBusy(true)
    try {
      const result = await api("/api/files/write", { method: "PUT", body: JSON.stringify({ path: selected.sourcePath, content: sourceContent, version: sourceVersion }) })
      setSourceVersion(result.version)
      setSourceDirty(false)
      notify("success", result.message || "源码已保存")
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  useSaveShortcut(() => {
    if (!selected || busy) return
    if (selected.kind === "small") return saveSource()
    if (selected.hasConfig) return save()
  })
  async function runAction(action: string) {
    let args: any
    try { args = JSON.parse(actionArgs) } catch { notify("error", "操作参数必须是有效 JSON"); return }
    if (!await confirm(`确定执行插件操作“${action}”吗？`)) return
    setBusy(true)
    try { const result = await api(`/api/plugins/${encodeURIComponent(selected.id)}/action`, { method: "POST", body: JSON.stringify({ action, args }) }); if (result.code !== undefined && result.code !== 0) throw new Error(result.message || "操作失败"); notify("success", result.message || "操作完成") }
    catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  async function installPlugin(event: React.FormEvent) {
    event.preventDefault()
    const installOptions = [
      installDependencies ? "安装 package.json 依赖（不执行生命周期脚本）" : "跳过依赖安装",
      restartAfterInstall ? "安装完成后尝试重启 Bot" : "安装完成后不自动重启",
    ]
    if (!await confirm(`从以下 HTTPS 仓库下载插件？\n${installUrl}\n\n${installOptions.join("\n")}`)) return
    setBusy(true)
    try {
      const result = await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ ...installProxy, url: installUrl, name: installName || undefined, installDependencies, restartBot: restartAfterInstall }) })
      setShowInstall(false); setInstallUrl(""); setInstallName(""); setInstallDependencies(false); setRestartAfterInstall(false)
      await refresh()
      notify("success", result.message)
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  async function archivePlugin() {
    if (!selected || selected.directory.includes("/") || selected.id.toLowerCase() === "eliaadminpanel") return
    if (!await confirm(`禁用“${selected.title}”？\n\n重启 Bot 后停止加载；插件文件将完整保留，可随时重新启用。`)) return
    setBusy(true)
    try {
      const result = await api(`/api/plugins/${encodeURIComponent(selected.id)}/disable`, { method: "POST", body: "{}" })
      setSelected(null); setData({}); await refresh(); notify("success", result.message)
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  async function restorePlugin(archive: any) {
    if (!await confirm(`恢复“${archive.name}”到 plugins/${archive.name}？`)) return
    setBusy(true)
    try {
      const result = await api(`/api/plugins/archives/${encodeURIComponent(archive.id)}/restore`, { method: "POST", body: "{}" })
      await refresh(); notify("success", result.message)
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setBusy(false) }
  }
  function openFileManager(path: string) {
    window.dispatchEvent(new CustomEvent("panel:navigate-files", { detail: path }))
  }
  function renderPlugin(plugin: any) {
    const PluginIcon = plugin.kind === "small" ? FileCode2 : Plug
    const canOpen = plugin.kind === "small" || plugin.hasConfig || plugin.hasSupport || plugin.configFiles?.length > 0
    return <Button variant="ghost" key={plugin.id} type="button" onClick={() => choosePlugin(plugin)} aria-current={selected?.id === plugin.id ? "page" : undefined} className={cn("h-auto justify-start whitespace-normal p-0", `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === plugin.id ? "bg-accent text-foreground" : "hover:bg-muted"}`)}>
      <span className={`grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl ${plugin.iconData ? "bg-card" : plugin.kind === "small" ? "bg-muted text-foreground" : "bg-accent text-foreground"}`}>
        {plugin.iconData ? <img src={plugin.iconData} alt="" className="size-full object-contain" /> : <PluginIcon className="size-4" style={plugin.iconColor && plugin.kind === "large" ? { color: plugin.iconColor } : undefined} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{plugin.title}</span>
      {canOpen && <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />}
    </Button>
  }
  function renderCompactPlugin(plugin: any) {
    const PluginIcon = plugin.kind === "small" ? FileCode2 : Plug
    const canOpen = plugin.kind === "small" || plugin.hasConfig || plugin.hasSupport || plugin.configFiles?.length > 0
    return <Button variant="ghost" key={plugin.id} type="button" onClick={() => choosePlugin(plugin)} aria-label={plugin.title} title={plugin.title} aria-current={selected?.id === plugin.id ? "page" : undefined} className={cn("h-auto justify-start whitespace-normal p-0", `relative mx-auto flex size-11 items-center justify-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === plugin.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted"}`)}>
      <span className={`grid size-8 place-items-center overflow-hidden rounded-lg ${plugin.iconData ? "bg-card" : plugin.kind === "small" ? "bg-muted text-foreground" : "bg-accent text-foreground"}`}>
        {plugin.iconData ? <img src={plugin.iconData} alt="" className="size-full object-contain" /> : <PluginIcon className="size-4" style={plugin.iconColor && plugin.kind === "large" ? { color: plugin.iconColor } : undefined} />}
      </span>
      {canOpen && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-emerald-500 ring-2 ring-white" />}
    </Button>
  }
  return <>
    <Dialog.Root open={showInstall} onOpenChange={setShowInstall}>
    <PageIntro actions={[
      { label: "安装插件", render: iconOnly => <Dialog.Trigger asChild><Button variant="outline" size={iconOnly ? "icon" : "default"} aria-label="安装插件" title="安装插件"><Plus />{!iconOnly && "安装插件"}</Button></Dialog.Trigger> },
      { label: "重新扫描", render: iconOnly => <Button variant="outline" size={iconOnly ? "icon" : "default"} aria-label="重新扫描" title="重新扫描" onClick={refresh} disabled={loading}>{loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{!iconOnly && "重新扫描"}</Button> },
    ]} />
    {error && <div className="mb-4"><ErrorState message={error} /></div>}
    <div className={`plugin-center-grid grid min-h-0 gap-5 xl:gap-0 xl:items-start ${pluginSidebarCollapsed ? "is-collapsed" : ""}`} style={{ "--plugin-sidebar-width": pluginSidebarCollapsed ? "56px" : "280px" } as React.CSSProperties}>
      <div className="relative h-[55dvh] min-h-[280px] max-h-[420px] min-w-0 xl:h-auto xl:min-h-0">
        <div className="plugin-center-sidebar-fixed relative flex h-full min-w-0 flex-col gap-3">
        <div className={`absolute inset-0 z-20 hidden flex-col rounded-tl-none rounded-tr-2xl rounded-br-2xl rounded-bl-none border border-border bg-card p-1 shadow-sm transition-opacity duration-200 xl:flex ${pluginSidebarCollapsed ? "opacity-100" : "pointer-events-none opacity-0"}`}>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <div aria-label="大插件" className="space-y-1">{largePlugins.filter(plugin => plugin.hasSupportFile || plugin.configFiles?.length || showUnconfigured || plugin.id === selected?.id).map(renderCompactPlugin)}{hasUnconfiguredLargePlugins && <Button size="icon" variant="ghost" aria-label={showUnconfigured ? "收起无配置插件" : "展开无配置插件"} title={showUnconfigured ? "收起无配置插件" : "展开无配置插件"} onClick={() => setShowUnconfigured(value => !value)}><ChevronDown className={`transition-transform duration-200 ${showUnconfigured ? "rotate-180" : ""}`} /></Button>}</div>
            <div aria-label="小插件" className="mt-2 space-y-1 border-t border-border pt-2">{smallPlugins.map(renderCompactPlugin)}</div>
          </div>
          <div className="mt-2 flex shrink-0 justify-start border-t border-border px-1 pt-2"><Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="展开插件侧栏" title="展开插件侧栏" onClick={() => setPluginSidebarCollapsed(false)}><ChevronRight className="size-4" /></Button></div>
        </div>
        <div className={`flex min-h-0 flex-1 flex-col transition-opacity duration-150 ${pluginSidebarCollapsed ? "xl:pointer-events-none xl:opacity-0" : "opacity-100"}`}>
          <Card className="flex max-h-[50%] min-h-0 flex-[0_1_auto] flex-col overflow-hidden rounded-tl-none rounded-tr-2xl rounded-br-none rounded-bl-none">
            <div className="flex items-center justify-between px-3.5 pb-2 pt-3 text-xs font-semibold"><span>大插件<Badge className="ml-1 border-0 bg-muted text-foreground">{largePlugins.length}</Badge></span></div>
            <div className="px-3 pb-2"><div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="h-9 pl-9 text-xs" placeholder="搜索大插件…" value={largeSearch} onChange={event => setLargeSearch(event.target.value)} /></div></div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {shownLarge.filter(plugin => plugin.hasSupportFile || plugin.configFiles?.length).map(renderPlugin)}{shownLarge.some(plugin => !plugin.hasSupportFile && !plugin.configFiles?.length) && <div><Button type="button" size="sm" variant="ghost" className="w-full justify-between" onClick={() => setShowUnconfigured(value => !value)}>无配置插件（{shownLarge.filter(plugin => !plugin.hasSupportFile && !plugin.configFiles?.length).length}）<ChevronDown className={`transition-transform duration-200 ${showUnconfigured ? "rotate-180" : ""}`} /></Button><Collapse open={showUnconfigured || Boolean(largeSearch.trim())}>{shownLarge.filter(plugin => !plugin.hasSupportFile && !plugin.configFiles?.length).map(renderPlugin)}</Collapse></div>}
              {!loading && !shownLarge.length && <div className="p-5 text-center text-xs text-muted-foreground">没有找到插件</div>}
            </div>
          </Card>
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-none rounded-tr-none rounded-br-2xl rounded-bl-none border-t-0">
            <div className="flex items-center justify-between px-3.5 pb-2 pt-3 text-xs font-semibold"><span>小插件<Badge className="ml-1 border-0 bg-muted text-foreground">{smallPlugins.length}</Badge></span><ScriptInstaller api={api} notify={notify} onInstalled={refresh} /></div>
            <div className="px-3 pb-2"><div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="h-9 pl-9 text-xs" placeholder="搜索小插件…" value={smallSearch} onChange={event => setSmallSearch(event.target.value)} /></div></div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {shownSmall.map(renderPlugin)}
              {!loading && !shownSmall.length && <div className="p-5 text-center text-xs text-muted-foreground">没有找到插件</div>}
            </div>
            {archives.length > 0 && <div className="max-h-28 shrink-0 overflow-y-auto border-t border-border px-3 py-2"><div className="mb-1.5 text-[10px] font-semibold text-muted-foreground">已禁用插件 · {archives.length}</div>{archives.map(archive => <div key={archive.id} className="flex items-center gap-2 rounded-lg px-2 py-1"><span className="min-w-0 flex-1 truncate text-[10px] text-foreground">{archive.name}</span><Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" disabled={busy} onClick={() => restorePlugin(archive)}>启用</Button></div>)}</div>}
            <div className="flex shrink-0 justify-start border-t border-border px-2 py-2"><Button size="icon" variant="ghost" className="size-8" aria-label="收起插件侧栏" title="收起插件侧栏" onClick={() => setPluginSidebarCollapsed(true)}><ChevronLeft className="size-4" /></Button></div>
          </Card>
        </div>
        </div>
      </div>
      <Card className={sourceFullscreen ? "fixed inset-0 z-50 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-none border-0" : selected?.kind === "small" ? "flex h-[calc(100dvh-4rem)] min-h-0 min-w-0 flex-col overflow-hidden rounded-none border-l-0 md:h-dvh" : "min-w-0"}>
        {sourceFullscreen && <Button type="button" size="icon" variant="outline" className="fixed right-4 top-4 z-[51] size-8 bg-card/90 shadow-sm" aria-label="退出全屏编辑" title="退出全屏编辑 (Esc)" onClick={() => setSourceFullscreen(false)}><Minimize2 className="size-4" /></Button>}
        <div className={sourceFullscreen ? "hidden" : "shrink-0 sticky top-px z-20 bg-card/95 backdrop-blur-sm"}>
        <CardHeader className="flex-row items-start justify-between border-b border-border pb-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle className="truncate text-base">{selected?.title || "选择插件"}</CardTitle>{selected?.kind === "small" && sourceDirty && <span aria-label="有未保存修改" className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
              {safePluginLink(selected?.link) && <a href={safePluginLink(selected.link)} target="_blank" rel="noreferrer" aria-label={`${selected.title} 插件仓库`} title="打开插件仓库" className="shrink-0 rounded text-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Github className="size-4" /></a>}
            </div>
            {selected?.kind === "small" && <CardDescription className="mt-1 break-all text-xs">{selected.sourcePath}</CardDescription>}
            {!sourceFullscreen && selected?.author && <div className="mt-1 text-[11px] text-muted-foreground">作者：{Array.isArray(selected.author) ? selected.author.join("、") : selected.author}</div>}
            {(selected?.description || (!selected && "选择左侧插件查看其配置或源码") || (selected?.kind !== "small" && selected?.sourcePath)) && <CardDescription className="mt-1 truncate">{selected?.description || (!selected ? "选择左侧插件查看其配置或源码" : selected?.sourcePath)}</CardDescription>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">{selected?.kind === "large" && <PluginTools key={selected.id} plugin={selected} api={api} notify={notify} confirm={confirm} onUpdated={refresh} />}{selected?.hasConfig && <Button onClick={save} disabled={busy}><Check />保存配置</Button>}{selected?.kind === "small" && <Button type="button" size="icon" variant="ghost" aria-label={sourceFullscreen ? "退出全屏编辑" : "全屏编辑"} title={sourceFullscreen ? "退出全屏编辑 (Esc)" : "全屏编辑"} onClick={() => setSourceFullscreen(value => !value)}>{sourceFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</Button>}{selected?.kind === "small" && <Button title="Ctrl+S 保存 · 重启后加载" onClick={saveSource} disabled={busy || detailLoading || !sourceDirty}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}保存源码</Button>}{selected?.kind === "large" && !selected.hasConfig && selected.configFiles?.length > 0 && <Button variant="outline" onClick={() => activeConfigFile && openFileManager(activeConfigFile.path)}><FileCode2 />在文件管理中编辑</Button>}{selected && selected.kind === "large" && selected.directory && selected.id.toLowerCase() !== "eliaadminpanel" && <Button variant="outline" className="text-rose-700 dark:text-rose-300 hover:bg-rose-50" onClick={archivePlugin} disabled={busy}><ArrowDownToLine />禁用插件</Button>}</div>
        </CardHeader>
        {hasSchemaGroupTabs && <div role="group" aria-label="插件配置分组" className="scrollbar-thin flex gap-0.5 overflow-x-auto border-b border-border px-3">
          {schemaGroups.map((group, index) => <Button variant="ghost" key={`${group.label}-${index}`} type="button" aria-pressed={index === activeSchemaGroup} onClick={() => setActiveSchemaGroup(index)} className={cn("h-auto justify-start whitespace-normal p-0", `relative shrink-0 px-3.5 py-3 text-xs font-medium transition-colors ${index === activeSchemaGroup ? "text-primary after:absolute after:inset-x-2.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary" : "text-muted-foreground hover:text-foreground"}`)}>{group.label}</Button>)}
        </div>}
        </div>
        <CardContent className={sourceFullscreen ? "flex min-h-0 flex-1 flex-col p-0" : selected?.kind === "small" ? "flex min-h-0 flex-1 flex-col p-0" : "p-5"}>
        {!selected ? <div className="grid min-h-64 place-items-center text-sm text-muted-foreground">{loading ? "正在扫描插件目录…" : "选择左侧插件"}</div>
          : selected.kind === "small" ? <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{detailLoading ? <div className="grid min-h-0 flex-1 place-items-center"><LoaderCircle className="size-6 animate-spin text-muted-foreground" /></div> : <MonacoCodeEditor key={selected.sourcePath} path={selected.sourcePath} value={sourceContent} readOnly={busy} className="relative min-h-0 flex-1 overflow-hidden" onChange={value => { setSourceContent(value); setSourceDirty(true) }} />}</div>
          : selected.hasConfig ? <div key={`${selected.id}-${activeSchemaGroup}`} className="admin-fields-enter space-y-3.5">{detailLoading ? <div className="grid min-h-48 place-items-center"><LoaderCircle className="size-6 animate-spin text-muted-foreground" /></div> : schemaLayout.map(item => {
            if (item.kind === "panel") {
              const multi = item.items.length > 1
              return <div key={`panel-${item.items[0].schema.field}`} className={`grid min-w-0 gap-px overflow-hidden rounded-xl border border-border bg-border/60 shadow-xs ${multi ? "sm:grid-cols-2" : ""}`}>{item.items.map(({ schema, index }) => <div key={schema.field} className="min-w-0 bg-card px-4 py-2 transition-colors hover:bg-accent/25">{renderSchemaField(schema, index, true)}</div>)}</div>
            }
            return <div key={`block-${item.schema.field}`} className="min-w-0">{renderSchemaField(item.schema, item.index)}</div>
          })}</div>
            : selected.configFiles?.length > 0 ? <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50/70 dark:bg-amber-950/40 px-4 py-3"><div><div className="text-xs font-semibold text-amber-950 dark:text-amber-300">未找到 *.support.js 配置入口</div><p className="mt-1 text-[10px] text-amber-900 dark:text-amber-300/75">以下是当前插件 config/configs 目录中的配置文件，可预览并在文件管理器中编辑。</p></div><Select value={activeConfigFile?.path || ""} onValueChange={setSelectedConfigFile}><SelectTrigger aria-label="选择插件配置文件" className="h-9 w-auto max-w-full bg-card text-xs"><SelectValue placeholder="选择配置文件" /></SelectTrigger><SelectContent>{selected.configFiles.map((file: any) => <SelectItem key={file.path} value={file.path}>{file.name}</SelectItem>)}</SelectContent></Select></div><div className="overflow-hidden rounded-xl border border-border"><div className="flex items-center justify-between border-b border-border bg-muted/80 px-4 py-2.5 text-xs"><span className="truncate font-medium">{activeConfigFile?.path}</span>{activeConfigFile && <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">{formatBytes(activeConfigFile.size)}</span>}</div>{detailLoading ? <div className="grid min-h-[420px] place-items-center"><LoaderCircle className="size-6 animate-spin text-muted-foreground" /></div> : <Textarea readOnly spellCheck={false} aria-label="插件配置文件预览" className="min-h-[420px] resize-y rounded-none border-0 bg-muted/30 p-5 font-mono text-[12px] leading-6 shadow-none focus-visible:ring-0" value={configPreview} />}</div></div>
              : <div className="rounded-2xl border border-dashed border-border bg-muted/70 px-6 py-10 text-center"><div className="mx-auto grid size-11 place-items-center rounded-2xl bg-card text-muted-foreground shadow-sm"><Plug className="size-5" /></div><div className="mt-3 text-sm font-medium">{selected.hasSupport ? "插件提供了 support 入口，但没有可视化配置表单" : "未找到 *.support.js 或可预览的配置文件"}</div><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">{selected.hasSupport ? "请检查配置入口是否提供 configInfo.schemas 和 getConfigData()。" : "可打开插件目录浏览源码，或添加 elia.support.js / guoba.support.js 配置入口。"}</p><Button variant="outline" size="sm" className="mt-4" onClick={() => openFileManager(selected.sourcePath)}><FileCode2 />浏览插件目录</Button></div>}
        {!sourceFullscreen && selected?.actions?.length > 0 && <div className="mt-8 border-t border-border pt-5"><div className="mb-1 text-sm font-semibold">插件操作</div><p className="mb-3 text-xs text-muted-foreground">调用 Guoba 兼容接口 configInfo.actions；运行前会进行确认。</p><Textarea className="mb-3 min-h-20 font-mono text-xs" value={actionArgs} onChange={event => setActionArgs(event.target.value)} /><div className="flex flex-wrap gap-2">{selected.actions.map((action: any) => <Button key={action.key} variant="outline" size="sm" disabled={!action.available || busy} onClick={() => runAction(action.key)}><Sparkles />{action.key}</Button>)}</div></div>}
      </CardContent></Card>
    </div>
    <Dialog.Portal>
      <Dialog.Overlay className="admin-dialog-overlay fixed inset-0 z-[60] bg-neutral-950/40 backdrop-blur-[2px]" />
      <Dialog.Content className="admin-dialog-content fixed left-1/2 top-1/2 z-[61] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl focus:outline-none">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <Dialog.Title className="text-base font-semibold">安装插件</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">通过 HTTPS 仓库地址下载插件；依赖安装脚本不会自动运行。</Dialog.Description>
          </div>
          <Dialog.Close asChild><Button type="button" variant="ghost" size="icon" aria-label="关闭安装弹窗"><X /></Button></Dialog.Close>
        </div>
        <form onSubmit={installPlugin} className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="plugin-install-url" className="text-xs">HTTPS 仓库地址</Label><Input id="plugin-install-url" value={installUrl} onChange={event => setInstallUrl(event.target.value)} placeholder="https://github.com/owner/plugin.git" required /></div>
          <div className="space-y-1.5"><Label htmlFor="plugin-install-name" className="text-xs">插件目录名</Label><Input id="plugin-install-name" value={installName} onChange={event => setInstallName(event.target.value)} placeholder="可选，默认使用仓库名" /></div>
          <ProxyFields value={installProxy} onChange={setInstallProxy} />
          <div className="grid grid-cols-1 divide-y divide-border rounded-lg border border-border px-3 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="flex items-center justify-between gap-3 py-3 sm:pr-3"><Label htmlFor="plugin-install-dependencies" className="text-xs">安装对应依赖</Label><Switch id="plugin-install-dependencies" checked={installDependencies} onCheckedChange={setInstallDependencies} /></div>
            <div className="flex items-center justify-between gap-3 py-3 sm:pl-3"><Label htmlFor="plugin-restart-after-install" className="text-xs">重启 Bot</Label><Switch id="plugin-restart-after-install" checked={restartAfterInstall} onCheckedChange={setRestartAfterInstall} /></div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Dialog.Close asChild><Button type="button" variant="outline">取消</Button></Dialog.Close>
            <Button type="submit" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <ArrowDownToLine />}下载并安装</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
    </Dialog.Root>
  </>
}

function CronExpressionField({ value, onChange, validate }: { value: string; onChange: (value: string) => void; validate: (expression: string) => Promise<any> }) {
  const [quickEdit, setQuickEdit] = useState(false)
  const [mode, setMode] = useState<5 | 6>(value.trim().split(/\s+/).length === 5 ? 5 : 6)
  const [validation, setValidation] = useState<any>(null)
  const expression = value.trim()
  const tokens = expression ? expression.split(/\s+/) : []
  const hasSupportedShape = tokens.length === 5 || tokens.length === 6

  useEffect(() => {
    if (tokens.length === 5 || tokens.length === 6) setMode(tokens.length)
  }, [expression])

  useEffect(() => {
    let cancelled = false
    setValidation(null)
    if (!expression || !hasSupportedShape) return
    const timer = window.setTimeout(() => {
      void validate(expression).then(result => { if (!cancelled) setValidation(result) })
        .catch(reason => { if (!cancelled) setValidation({ valid: false, message: (reason as Error).message }) })
    }, 350)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [expression, hasSupportedShape, validate])

  const segments = hasSupportedShape
    ? tokens.length === 6 ? tokens : ["0", ...tokens]
    : ["0", "0", "1", "*", "*", "?"]
  const fieldNames = mode === 6
    ? ["秒", "分", "时", "日", "月", "星期"]
    : ["分", "时", "日", "月", "星期"]

  function changeSegment(index: number, next: string) {
    const updated = [...segments]
    updated[index] = next.trim() || "*"
    onChange((mode === 6 ? updated : updated.slice(1)).join(" "))
  }

  function applyPreset(preset: "daily" | "weekdays" | "hourly" | "minute") {
    const fields = preset === "daily" ? ["0", "20", "1", "*", "*", "?"]
      : preset === "weekdays" ? ["0", "20", "1", "*", "*", "1-5"]
        : preset === "hourly" ? ["0", "0", "*", "*", "*", "?"]
          : ["0", "*", "*", "*", "*", "?"]
    onChange((mode === 6 ? fields : preset === "minute" ? ["*", "*", "*", "*", "*"] : fields.slice(1, 6)).join(" "))
  }

  function changeMode(next: 5 | 6) {
    if (next === mode) return
    if (next === 6) {
      onChange(`0 ${expression}`)
      setMode(6)
      return
    }
    if (segments[0] !== "0") {
      setValidation({ valid: false, message: "当前秒字段不是 0；切换到 5 段格式会丢失秒级设置" })
      return
    }
    onChange(segments.slice(1).join(" "))
    setMode(5)
  }

  return <div className="space-y-2">
    <div className="flex gap-2"><Input aria-label="Cron 表达式" className="font-mono text-sm" value={value} placeholder="分 时 日 月 星期（或在前面增加秒字段）" onChange={event => onChange(event.target.value)} /><Button type="button" variant="outline" className="shrink-0" aria-expanded={quickEdit} onClick={() => setQuickEdit(open => !open)}>{quickEdit ? "收起快速编辑" : "快速编辑"}<ChevronDown className={`transition-transform ${quickEdit ? "rotate-180" : ""}`} /></Button></div>
    <p className="text-[10px] leading-4 text-muted-foreground">支持 Node 定时器常见的 5 段格式与含秒的 6 段格式；保存前会使用当前 Yunzai 的 cron-parser 实际校验。</p>
    <p aria-live="polite" aria-atomic="true" className={`min-h-[15px] text-[10px] leading-[15px] ${validation ? validation.valid ? "text-emerald-700 dark:text-emerald-300" : "text-rose-600 dark:text-rose-300" : ""}`}>{validation ? <>{validation.message}{validation.valid && validation.nextRun ? ` · 下次执行：${new Date(validation.nextRun).toLocaleString("zh-CN")}` : ""}</> : ""}</p>
    <Collapse open={quickEdit}><div className="space-y-3 rounded-xl border border-border bg-muted/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex gap-1.5">{([[5, "5 段"], [6, "6 段（含秒）"]] as const).map(([fieldCount, title]) => <Button key={fieldCount} type="button" size="sm" variant={mode === fieldCount ? "default" : "outline"} className="h-7 px-2.5 text-[10px]" onClick={() => changeMode(fieldCount)}>{title}</Button>)}</div><div className="flex flex-wrap gap-1.5">{[["每天 1:20", "daily"], ["工作日 1:20", "weekdays"], ["每小时", "hourly"], ["每分钟", "minute"]].map(([title, preset]) => <Button key={preset} type="button" size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={() => applyPreset(preset as "daily" | "weekdays" | "hourly" | "minute")}>{title}</Button>)}</div></div>
      {hasSupportedShape ? <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${mode === 6 ? "xl:grid-cols-6" : "xl:grid-cols-5"}`}>{fieldNames.map((name, index) => { const segmentIndex = mode === 6 ? index : index + 1; return <Label key={name} className="space-y-1 text-[10px] text-muted-foreground">{name}<Input aria-label={`Cron ${name}`} className="h-9 bg-card font-mono text-xs" value={segments[segmentIndex]} placeholder={name === "星期" ? "* / 1-5 / ?" : "* / 数字 / 范围"} onChange={event => changeSegment(segmentIndex, event.target.value)} /></Label> })}</div> : <p className="text-[10px] text-amber-700 dark:text-amber-300">原表达式字段数异常。选择上方快捷模板可生成标准格式，或手动修正表达式。</p>}
      <p className="text-[10px] leading-4 text-muted-foreground">字段顺序：{mode === 6 ? "秒 分 时 日 月 星期" : "分 时 日 月 星期"}。支持 `*`、`?`、范围（`1-5`）、步长（`*/5`）与列表（`1,3,5`）；最终格式以此 Yunzai 实际安装版本校验为准。</p>
    </div></Collapse>
  </div>
}

function SchemaField({ schema, value, onChange, validateCron, friendOptions, friendsLoading, friendsError, groupOptions, groupsLoading, groupsError, compactCard = false }: { schema: any; value: any; onChange: (value: any) => void; validateCron: (expression: string) => Promise<any>; friendOptions?: FriendOption[]; friendsLoading?: boolean; friendsError?: string; groupOptions?: GroupOption[]; groupsLoading?: boolean; groupsError?: string; compactCard?: boolean }) {
  const component = String(schema.component || "Input")
  const props = schema.componentProps || {}
  const label = schema.label || schema.field
  const help = [...new Set([schema.helpMessage, schema.bottomHelpMessage].filter(Boolean))].join("\n")
  const options: any[] = props.options || []
  const listWidget = component === "GTags" || component === "CheckboxGroup" || component === "GSelectFriend" || component === "GSelectGroup"
  const forceAvatarKind = component === "GSelectFriend" ? "qq" : component === "GSelectGroup" ? "group" : undefined
  const textValue = typeof value === "string" ? value : value == null ? "" : String(value)
  const colorInput = component === "ColorPicker" || component === "GColorPicker" || (component === "Input" && String(label).includes("颜色") && (!props.type || props.type === "text"))
  if (compactCard && component === "Switch") return <div className="flex min-h-9 items-center justify-between gap-3">
    <div className="min-w-0"><div className="flex items-center gap-1"><Label className="text-xs">{label}{schema.required && <span className="ml-1 text-rose-500">*</span>}</Label>{help && <FieldHelp label={label} message={help} />}</div></div>
    <div className="flex shrink-0 items-center gap-2"><span className={`text-[10px] font-medium ${value ? "text-foreground" : "text-muted-foreground"}`}>{value ? "已启用" : "已关闭"}</span><Switch checked={Boolean(value)} onCheckedChange={onChange} /></div>
  </div>
  if (compactCard) return <div className="space-y-1">
    <div><div className="flex items-center gap-1"><Label className="text-xs">{label}{schema.required && <span className="ml-1 text-rose-500">*</span>}</Label>{help && <FieldHelp label={label} message={help} />}</div></div>
    {component === "InputNumber" ? <Input className="h-9" type="number" min={props.min} max={props.max} step={props.step || "any"} value={value ?? ""} placeholder={props.placeholder} onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))} /> : component === "Select" || component === "RadioGroup" || component === "CheckboxGroup" ? <SchemaOptions component={component} props={props} value={value} label={label} onChange={onChange} compact /> : secretField(schema.field) || props.type === "password" ? <SecretInput autoComplete={props.autocomplete} value={textValue} placeholder={props.placeholder} onChange={onChange} /> : colorInput ? <ColorPickerField value={textValue} label={label} placeholder={props.placeholder} onChange={onChange} /> : <Input className="h-9" type="text" autoComplete={props.autocomplete} value={textValue} placeholder={props.placeholder} onChange={event => onChange(event.target.value)} />}
  </div>
  return <div className="space-y-1.5 rounded-xl border border-border bg-muted/40 px-3.5 py-3 transition-colors hover:border-border hover:bg-accent/30">
    <div><div className="flex items-center gap-1"><Label className="text-xs">{label}{schema.required && <span className="ml-1 text-rose-500">*</span>}</Label>{help && <FieldHelp label={label} message={help} />}</div></div>
    <div>{component === "Switch" ? <div className="flex h-10 items-center justify-between rounded-xl border border-border px-3"><span className="text-xs text-muted-foreground">{value ? "已启用" : "已关闭"}</span><Switch checked={Boolean(value)} onCheckedChange={onChange} /></div>
      : component === "InputNumber" ? <Input type="number" min={props.min} max={props.max} step={props.step || "any"} value={value ?? ""} placeholder={props.placeholder} onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))} />
      : component === "RadioGroup" || component === "Select" || component === "CheckboxGroup" ? <SchemaOptions component={component} props={props} value={value} label={label} onChange={onChange} />
      : component === "EasyCron" ? <CronExpressionField value={textValue} onChange={onChange} validate={validateCron} />
      : colorInput ? <ColorPickerField value={textValue} label={label} placeholder={props.placeholder} onChange={onChange} />
      : Array.isArray(value) ? <ConfigListField name={schema.field} label={label} value={value} forceAvatarKind={forceAvatarKind} friendOptions={friendOptions} friendsLoading={friendsLoading} friendsError={friendsError} groupOptions={groupOptions} groupsLoading={groupsLoading} groupsError={groupsError} onChange={onChange} />
      : listWidget ? <ConfigListField name={schema.field} label={label} value={typeof value === "string" ? value.split(/\r?\n/).filter(Boolean) : value} forceItemType="string" forceAvatarKind={forceAvatarKind} friendOptions={friendOptions} friendsLoading={friendsLoading} friendsError={friendsError} groupOptions={groupOptions} groupsLoading={groupsLoading} groupsError={groupsError} onChange={onChange} />
      : component === "GSubForm" || isObject(value) ? <StructuredConfigField value={value} label={label} onChange={onChange} />
      : component === "InputTextArea" || (multilineTextField(schema.field, value) && !secretField(schema.field)) ? <Textarea aria-label={`${label}，多行编辑`} className="min-h-24 resize-y text-sm leading-6" value={textValue} rows={props.rows} placeholder={props.placeholder} onChange={event => onChange(event.target.value)} />
      : secretField(schema.field) || props.type === "password" ? <SecretInput autoComplete={props.autocomplete} value={textValue} placeholder={props.placeholder} onChange={event => onChange(event.target.value)} /> : <Input type="text" autoComplete={props.autocomplete} value={textValue} placeholder={props.placeholder} onChange={event => onChange(event.target.value)} />}</div>
  </div>
}

function FileManager({ api, notify, confirm, initialPath = "." }: { api: Api; notify: any; confirm: Confirm; initialPath?: string }) {
  const [editorFullscreen, setEditorFullscreen] = useState(false)
  const [imageLightbox, setImageLightbox] = useState(false)
  const [directory, setDirectory] = useState(".")
  const [directoryDraft, setDirectoryDraft] = useState(initialPath)
  const [listWidth, setListWidth] = useState(320)
  const fileGridRef = useRef<HTMLDivElement>(null)
  const [entries, setEntries] = useState<any[]>([])
  const [current, setCurrent] = useState<any>(null)
  const [content, setContent] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const uploadInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState("")
  function reportFileError(reason: unknown) {
    const message = (reason as Error).message
    if (message === "面板凭据与会话数据由面板保护，不能通过文件管理器访问") {
      notify("error", message)
      return
    }
    setError(message)
  }
  const browse = useCallback(async (path: string, updateUrl = false) => {
    setLoading(true); setError("")
    try {
      const result = await api(`/api/files?path=${encodeURIComponent(path)}`)
      setDirectory(result.path); setEntries(result.entries); setCurrent(null); setContent(""); setDirty(false)
      if (updateUrl) setRouteQuery("path", path === "." ? "" : path)
    } catch (reason) {
      try {
        const file = await api(`/api/files/read?path=${encodeURIComponent(path)}`)
        const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "."
        const result = await api(`/api/files?path=${encodeURIComponent(parent)}`)
        setDirectory(result.path); setEntries(result.entries); setCurrent(file); setContent(file.content || ""); setDirty(false)
        if (updateUrl) setRouteQuery("path", path)
      } catch (readError) { reportFileError(readError) }
    }
    finally { setLoading(false) }
  }, [api, notify])
  useEffect(() => { browse(initialPath) }, [browse, initialPath])
  useEffect(() => { setDirectoryDraft(directory) }, [directory])
  async function jumpDirectory(path: string) {
    if (dirty && !await confirm("当前文件有未保存修改，继续切换目录吗？")) return
    const next = path.trim().replace(/\\/g, "/").replace(/^\/+/, "") || "."
    await browse(next, true)
  }
  useEffect(() => {
    if (!editorFullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditorFullscreen(false)
    }
    document.addEventListener("keydown", handleKeyDown, true)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener("keydown", handleKeyDown, true)
    }
  }, [editorFullscreen])
  async function openFile(entry: any) {
    if (dirty && !await confirm("当前文件有未保存修改，继续切换吗？")) return
    if (entry.type === "binary") { notify("info", "文件已上传，当前类型不支持在线编辑或预览"); return }
    if (entry.type === "image") {
      setCurrent(entry); setContent(""); setDirty(false); setError(""); setImageLightbox(false); setRouteQuery("path", entry.path)
      return
    }
    setLoading(true); setError("")
    try { const result = await api(`/api/files/read?path=${encodeURIComponent(entry.path)}`); setCurrent(result); setContent(result.content); setDirty(false); setRouteQuery("path", entry.path) }
    catch (reason) { reportFileError(reason) }
    finally { setLoading(false) }
  }
  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return
    if (dirty && !await confirm("上传后将刷新目录，当前文件有未保存修改，继续吗？")) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MB`)
        await api(`/api/files/upload?path=${encodeURIComponent(directory)}&name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file })
      }
      notify("success", "文件已上传")
    } catch (reason) { notify("error", (reason as Error).message) }
    finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = ""; await browse(directory) }
  }
  const save = useCallback(async () => {
    if (!current || !dirty || saving || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try { const result = await api("/api/files/write", { method: "PUT", body: JSON.stringify({ path: current.path, content, version: current.version }) }); setCurrent((previous: any) => ({ ...previous, version: result.version })); setDirty(false); notify("success", result.message || "文件已保存") }
    catch (reason) { notify("error", (reason as Error).message) }
    finally { savingRef.current = false; setSaving(false) }
  }, [api, content, current, dirty, notify, saving])
  useSaveShortcut(save)
  const crumbs = directory === "." ? [] : directory.split("/")
  const selectedImageUrl = current?.type === "image" ? `/api/files/image?path=${encodeURIComponent(current.path)}` : ""
  return <>
    <Input ref={uploadInput} type="file" multiple className="hidden" aria-label="选择上传文件" onChange={event => void uploadFiles(event.target.files)} />
    <PageIntro actions={[{ label: "上传文件", render: iconOnly => <Button variant="outline" size={iconOnly ? "icon" : "default"} aria-label="上传文件" title="上传到当前目录（每个文件最多 20 MB）" disabled={uploading} onClick={() => uploadInput.current?.click()}>{uploading ? <LoaderCircle className="animate-spin" /> : <Upload />}{!iconOnly && "上传文件"}</Button> }, { label: "保存文件", render: iconOnly => <Button size={iconOnly ? "icon" : "default"} aria-label="保存文件" title="保存文件" onClick={save} disabled={!current || !dirty || saving}>{saving ? <LoaderCircle className="animate-spin" /> : <Check />}{!iconOnly && "保存文件"}</Button> }]} />
    {error && <div className="mb-4"><ErrorState message={error} /></div>}
    <Card className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-1.5"><div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-xs"><Button type="button" variant="ghost" onClick={() => jumpDirectory(".")} className={cn("h-auto justify-start whitespace-normal p-0", `rounded-md px-2 py-1 ${directory === "." ? "font-semibold text-foreground" : "text-muted-foreground hover:bg-muted"}`)}>工作区</Button><form className="flex min-w-0 flex-1 items-center gap-1 sm:max-w-sm" onSubmit={event => { event.preventDefault(); void jumpDirectory(directoryDraft) }}><Input aria-label="目录路径" value={directoryDraft} onChange={event => setDirectoryDraft(event.target.value)} placeholder="输入目录路径，如 plugins/EliaAdminPanel" className="h-8 min-w-0 font-mono text-xs" /><Button type="submit" variant="ghost" size="icon" className="size-8 shrink-0" aria-label="跳转目录" title="跳转目录" disabled={loading}><ArrowRight /></Button></form></div></div>

      <div ref={fileGridRef} style={{ "--file-list-width": `${listWidth}px` } as React.CSSProperties} className="file-browser-grid grid min-h-0 flex-1"><div className="min-h-0 border-b border-border md:border-b-0"><div className="flex h-11 items-center justify-between px-4 text-[10px] font-semibold uppercase tracking-[.12em] text-muted-foreground"><span className="flex items-center gap-1.5">文件浏览器{loading && <LoaderCircle role="status" aria-label="正在加载" className="size-3.5 animate-spin text-muted-foreground" />}</span><span>{entries.length} 项</span></div><div className={`max-h-[550px] overflow-y-auto px-2 pb-3 scrollbar-thin`}>{directory !== "." && <Button type="button" variant="ghost" onClick={() => jumpDirectory(crumbs.length > 1 ? crumbs.slice(0, -1).join("/") : ".")} className={cn("h-auto justify-start whitespace-normal p-0", "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted")}><ArrowLeft className="size-3.5" />上级目录</Button>}{entries.map(entry => <Button type="button" variant="ghost" key={entry.path} onClick={() => entry.type === "directory" ? jumpDirectory(entry.path) : openFile(entry)} className={cn("h-auto justify-start whitespace-normal p-0", `flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition ${current?.path === entry.path ? "bg-accent text-foreground" : "text-foreground hover:bg-muted"}`)}><span className={`${entry.type === "directory" ? "text-amber-500" : entry.type === "image" ? "text-sky-500" : "text-muted-foreground"}`}>{entry.type === "directory" ? <Folder className="size-4" /> : entry.type === "image" ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}</span><span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>{entry.type !== "directory" && <span className="text-[9px] text-muted-foreground">{formatBytes(entry.size)}</span>}{entry.type === "directory" && <ChevronRight className="size-3 text-neutral-300" />}</Button>)}{!loading && !entries.length && <div className="p-5 text-center text-xs text-muted-foreground">当前目录没有可显示的内容</div>}</div></div>
        <div role="separator" tabIndex={0} aria-label="调整文件列表宽度" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={650} aria-valuenow={Math.round(listWidth)} title="拖动调整宽度，也可使用左右方向键" onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = fileGridRef.current?.getBoundingClientRect(); if (bounds) setListWidth(Math.max(220, Math.min(650, bounds.width - 320, event.clientX - bounds.left))) }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setListWidth(width => Math.max(220, Math.min(650, width + (event.key === "ArrowLeft" ? -20 : 20)))) } if (event.key === "Home") { event.preventDefault(); setListWidth(220) } if (event.key === "End") { event.preventDefault(); setListWidth(650) } }} className="group relative hidden cursor-col-resize touch-none items-center justify-center outline-none focus-visible:bg-accent/70 md:flex"><span className="pointer-events-none absolute inset-y-0 w-px bg-border group-hover:bg-primary group-focus-visible:bg-primary" /><span className="pointer-events-none z-10 h-10 w-1 rounded-full bg-neutral-300 group-hover:bg-primary group-focus-visible:bg-primary" /></div>
        <div className={editorFullscreen ? "fixed inset-0 z-50 flex min-h-0 min-w-0 flex-col overflow-hidden bg-background" : "flex min-h-0 min-w-0 flex-col"}>{editorFullscreen && <Button type="button" size="icon" variant="outline" className="fixed right-4 top-4 z-[51] size-8 bg-card/90 shadow-sm" aria-label="退出全屏编辑" title="退出全屏编辑 (Esc)" onClick={() => setEditorFullscreen(false)}><Minimize2 className="size-4" /></Button>}<div className={editorFullscreen ? "hidden" : "flex h-11 shrink-0 items-center justify-between border-b border-border px-4"}><div className="flex min-w-0 items-center gap-2 text-xs">{current?.type === "image" ? <ImageIcon className="size-4 text-sky-500" /> : <FileCode2 className="size-4 text-muted-foreground" />}<span className="truncate font-medium">{current?.path || "选择一个文本文件或图片"}</span>{dirty && <span className="size-1.5 rounded-full bg-amber-500" />}</div><div className="flex shrink-0 items-center gap-2">{current && <span className="hidden text-[10px] text-muted-foreground sm:block">{current.type === "image" ? `${formatBytes(current.size)} · 图片预览` : `${formatBytes(new Blob([content]).size)} · UTF-8`}</span>}<Button type="button" size="icon" variant="ghost" className="size-8" aria-label={editorFullscreen ? "退出全屏编辑" : "全屏编辑"} title={editorFullscreen ? "退出全屏编辑 (Esc)" : "全屏编辑"} disabled={!current} onClick={() => setEditorFullscreen(value => !value)}>{editorFullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</Button></div></div>{current?.type === "image" ? <div className={`grid flex-1 place-items-center overflow-auto bg-muted p-5 ${editorFullscreen ? "min-h-0" : "min-h-[420px]"}`}><Button variant="ghost" type="button" aria-label={`放大查看 ${current.path}`} title="点击查看大图" className={cn("h-auto justify-center whitespace-normal p-0", "grid max-h-full max-w-full cursor-zoom-in place-items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")} onClick={() => setImageLightbox(true)}><img src={selectedImageUrl} alt={current.path} className={`max-w-full object-contain ${editorFullscreen ? "max-h-[calc(100dvh-10rem)]" : "max-h-[min(70vh,720px)]"}`} /></Button></div> : current ? <div className="flex min-h-0 flex-1 flex-col"><MonacoCodeEditor key={current.path} path={current.path} value={content} className="relative min-h-0 flex-1 overflow-hidden" onChange={value => { setContent(value); setDirty(true) }} /></div> : <div className="grid flex-1 place-items-center p-8 text-center"><div><div className="mx-auto grid size-12 place-items-center rounded-2xl bg-accent text-foreground"><FileCode2 className="size-5" /></div><div className="mt-3 text-sm font-medium">选择文件以开始编辑</div><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">支持 YAML、JSON、JavaScript、TypeScript、Markdown、CSS、HTML 等文本文件；单文件上限 1.5 MB。</p></div></div>}</div>
      </div></Card>
    <Dialog.Root open={imageLightbox && current?.type === "image"} onOpenChange={setImageLightbox}>
      <Dialog.Portal>
        <Dialog.Overlay className="admin-dialog-overlay fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm" />
        <Dialog.Content className="admin-dialog-content fixed inset-3 z-[71] flex items-center justify-center rounded-xl bg-black/90 p-3 shadow-2xl focus:outline-none sm:inset-6 sm:p-6">
          <Dialog.Title className="sr-only">{current?.path || "图片预览"}</Dialog.Title>
          <Dialog.Close asChild><Button type="button" variant="ghost" size="icon" aria-label="关闭图片预览" className="absolute right-2 top-2 z-10 text-white hover:bg-white/15 hover:text-white"><X /></Button></Dialog.Close>
          {selectedImageUrl && <img src={selectedImageUrl} alt={current?.path || "图片预览"} className="max-h-full max-w-full object-contain" />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}

function MessageDebugger({ api }: { api: Api }) {
  const [mobileView, setMobileView] = useState<"compose" | "history">("compose")
  const [messageType, setMessageType] = useState<"private" | "group">("private")
  const [isMaster, setIsMaster] = useState(true)
  const [isGroupAdmin, setIsGroupAdmin] = useState(true)
  const [userId, setUserId] = useState("55555")
  const [groupId, setGroupId] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [history, setHistory] = useState<any[]>([])
  const [splitPercent, setSplitPercent] = useState(42)
  const splitGridRef = useRef<HTMLDivElement>(null)
  const conversationEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ block: "end" })
  }, [history])

  function adjustSplit(amount: number) {
    setSplitPercent(current => Math.min(65, Math.max(28, current + amount)))
  }

  function updateSplit(clientX: number) {
    const bounds = splitGridRef.current?.getBoundingClientRect()
    if (!bounds) return
    const availableWidth = bounds.width - 8
    const next = ((clientX - bounds.left - 4) / availableWidth) * 100
    setSplitPercent(Math.min(65, Math.max(28, next)))
  }

  function renderReplySegment(segment: any, key: string): React.ReactNode {
    if (segment.type === "chat-message") return <div key={key} className="my-1 max-w-full overflow-hidden rounded-lg border border-border bg-muted/70">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2 text-[10px] font-medium text-foreground"><Users className="size-3.5 shrink-0 text-muted-foreground" /><span>{segment.nickname || "消息发送者"}</span>{segment.userId && <span className="font-mono text-muted-foreground">{segment.userId}</span>}</div>
      <div className="max-h-[52dvh] space-y-2 overflow-y-auto p-3">{(segment.segments || []).map((child: any, index: number) => renderReplySegment(child, `${key}-${index}`))}</div>
    </div>
    if (segment.type === "object") return <div key={key} className="my-1 divide-y divide-border/70 overflow-hidden rounded-lg border border-border bg-muted/70">
      {segment.entries.map((entry: any, index: number) => <div key={`${key}-${index}`} className="grid gap-1 px-3 py-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-3"><span className="text-[10px] font-medium text-muted-foreground">{entry.label}</span><pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{entry.value}</pre></div>)}
    </div>
    if (segment.type === "image") return <figure key={key} className="my-1 max-w-full">
      {segment.src ? <img src={segment.src} alt={segment.alt || "插件回复图片"} loading="lazy" referrerPolicy="no-referrer" className="max-h-[min(60dvh,480px)] max-w-full rounded-lg border border-border object-contain" /> : <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"><ImageIcon className="size-4 shrink-0" />图片无法预览{segment.alt && segment.alt !== "图片" ? `：${segment.alt}` : ""}</div>}
      {(segment.width || segment.height || segment.size) && <figcaption className="mt-1 text-[10px] text-muted-foreground">{segment.width && segment.height ? `${segment.width} × ${segment.height}` : ""}{segment.size ? ` · ${formatBytes(segment.size)}` : ""}</figcaption>}
    </figure>
    if (segment.type === "audio") return <div key={key} className="my-1 flex min-w-0 flex-col items-start gap-1">
      {segment.src ? <audio controls preload="none" src={segment.src} aria-label={segment.alt || "语音消息"} className="h-10 w-full max-w-[360px]" /> : <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"><span aria-hidden="true">♫</span>{segment.alt || "语音格式无法在浏览器中播放"}</div>}
      {segment.name && <span className="max-w-full truncate text-[10px] text-muted-foreground">{segment.name}</span>}
    </div>
    if (segment.type === "forward") return <div key={key} className="my-1 max-w-full overflow-hidden rounded-lg border border-border bg-muted/70">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[10px] font-medium text-foreground"><MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" /><span>{segment.title || "合并转发"}</span><span className="ml-auto shrink-0 text-muted-foreground">{segment.nodes?.length ? `${segment.nodes.length} 条` : ""}</span></div>
      {segment.nodes?.length ? <div className="divide-y divide-border/70">{segment.nodes.map((node: any, index: number) => <div key={`${key}-${index}`} className="space-y-1.5 px-3 py-2">
        <div className="text-[10px] font-medium text-muted-foreground">{node.nickname || node.userId || `消息 ${node.index || index + 1}`}</div>
        <div className="space-y-2">{(node.segments || []).map((child: any, childIndex: number) => renderReplySegment(child, `${key}-${index}-${childIndex}`))}</div>
      </div>)}</div> : <div className="px-3 py-2 text-xs text-muted-foreground">{segment.summary || "转发节点内容不可读取"}</div>}
      {segment.summary && segment.nodes?.length > 0 && <div className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">{segment.summary}</div>}
    </div>
    return <span key={key} className="whitespace-pre-wrap break-words">{segment.text ?? String(segment)}</span>
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !message.trim()) return
    setBusy(true)
    setError("")
    try {
      const result = await api("/api/debug/message", {
        method: "POST",
        body: JSON.stringify({ message, userId, messageType, groupId, isMaster, isGroupAdmin }),
      })
      setHistory(old => [...old, {
        id: `${Date.now()}-${Math.random()}`,
        sentAt: new Date(),
        message,
        messageType,
        userId,
        groupId,
        replies: result.replies || [],
        summary: result.message,
      }].slice(-20))
      setMessage("")
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <>
    <div ref={splitGridRef} style={{ "--debug-left-track": `${splitPercent}fr`, "--debug-right-track": `${100 - splitPercent}fr` } as React.CSSProperties} className="debug-workbench-grid grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] xl:grid-rows-1">
      <div className="px-3 pt-3 xl:hidden">
        <ToggleGroup type="single" value={mobileView} onValueChange={value => { if (value) setMobileView(value as "compose" | "history") }} className="grid grid-cols-2 gap-2 rounded-xl bg-muted p-1" aria-label="调试视图">
          <ToggleGroupItem value="compose" className="rounded-lg px-3 py-2 text-xs font-medium transition">发送消息</ToggleGroupItem>
          <ToggleGroupItem value="history" className="rounded-lg px-3 py-2 text-xs font-medium transition">调试记录</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <section className={`${mobileView === "compose" ? "flex" : "hidden xl:flex"} min-h-0 min-w-0 flex-col overflow-hidden border-b border-border bg-card px-4 py-4 sm:px-7 sm:py-5 xl:border-b-0 xl:border-r-0 xl:px-8 xl:py-7`}>
        <div className="mb-5 border-b border-border pb-4"><CardTitle className="text-base">发送调试消息</CardTitle><CardDescription>选择私聊或群聊，填写模拟发送方 ID 与消息内容。</CardDescription></div>
        <form className="scrollbar-hidden mb-5 min-h-0 flex-1 space-y-4 overflow-y-auto" onSubmit={sendMessage}>
          <ToggleGroup type="single" value={messageType} onValueChange={value => { if (value) setMessageType(value as "group" | "private") }} className="grid grid-cols-2 gap-2 rounded-xl bg-muted p-1" aria-label="消息类型">
            {([["private", "私聊"], ["group", "群聊"]] as const).map(([type, label]) => <ToggleGroupItem value={type} key={type} className={`rounded-lg px-3 py-2 text-xs font-medium transition ${messageType === type ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{label}</ToggleGroupItem>)}
          </ToggleGroup>
          <div className={`grid grid-cols-1 gap-x-3 transition-[row-gap] duration-300 ease-out ${messageType === "group" ? "gap-y-3" : "gap-y-0"}`}>
            <div className="space-y-2"><Label htmlFor="debug-user-id">发送方 ID</Label><Input id="debug-user-id" value={userId} maxLength={80} onChange={event => setUserId(event.target.value)} placeholder="例如：123456789" /></div>
            <div className="min-w-0"><Collapse open={messageType === "group"}><div className="space-y-2"><Label htmlFor="debug-group-id">群号</Label><Input id="debug-group-id" value={groupId} maxLength={80} onChange={event => setGroupId(event.target.value)} placeholder="例如：987654321" /></div></Collapse></div>
          </div>
          <div className="rounded-xl border border-border px-3 py-2">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5"><Label htmlFor="debug-is-master" className="text-xs">以主人权限运行</Label><p className="text-[10px] text-muted-foreground">模拟消息按主人身份处理</p></div>
              <Switch id="debug-is-master" checked={isMaster} onCheckedChange={setIsMaster} />
            </div>
            <Collapse open={messageType === "group"}><div className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <div className="space-y-0.5"><Label htmlFor="debug-is-group-admin" className="text-xs">以群主/管理员身份运行</Label><p className="text-[10px] text-muted-foreground">关闭后按普通群成员处理</p></div>
              <Switch id="debug-is-group-admin" checked={isGroupAdmin} onCheckedChange={setIsGroupAdmin} />
            </div></Collapse>
          </div>
          <div className="space-y-2"><Label htmlFor="debug-message">消息内容</Label><Textarea id="debug-message" className="min-h-24 resize-y font-mono text-sm leading-6 sm:min-h-36" value={message} maxLength={5000} onChange={event => setMessage(event.target.value)} placeholder="输入要交给插件处理的文本消息…" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} /><div className="flex justify-between text-[10px] text-muted-foreground"><span>支持以 # 开头的命令与普通聊天文本</span><span>{message.length}/5000</span></div></div>
          {error && <ErrorState message={error} />}
          <Button className="w-full" disabled={busy || !message.trim() || !userId.trim() || (messageType === "group" && !groupId.trim())}>{busy ? <LoaderCircle className="animate-spin" /> : <Send />}送入插件处理链</Button>
        </form>
      </section>
      <div
        role="separator"
        tabIndex={0}
        aria-label="调整左右分区宽度"
        aria-orientation="vertical"
        aria-valuemin={28}
        aria-valuemax={65}
        aria-valuenow={Math.round(splitPercent)}
        aria-valuetext={`左侧 ${Math.round(splitPercent)}%`}
        title="拖动调整宽度，也可使用左右方向键"
        onPointerDown={event => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSplit(event.clientX)
        }}
        onPointerUp={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onKeyDown={event => {
          if (event.key === "ArrowLeft") { event.preventDefault(); adjustSplit(-2) }
          if (event.key === "ArrowRight") { event.preventDefault(); adjustSplit(2) }
          if (event.key === "Home") { event.preventDefault(); setSplitPercent(28) }
          if (event.key === "End") { event.preventDefault(); setSplitPercent(65) }
        }}
        className="group relative hidden cursor-col-resize touch-none items-center justify-center outline-none focus-visible:bg-accent/70 xl:flex"
      >
        <span className="pointer-events-none absolute inset-y-0 w-px bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
        <span className="pointer-events-none z-10 h-10 w-1 rounded-full bg-neutral-300 transition group-hover:h-14 group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>
      <section className={`${mobileView === "history" ? "flex" : "hidden xl:flex"} min-h-0 min-w-0 flex-col overflow-hidden bg-muted/40`}>
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-5 py-3 sm:px-7 sm:py-4 xl:px-8 xl:py-4"><div><CardTitle className="text-base">调试记录</CardTitle><CardDescription className="mt-1">本次面板会话最近 20 条</CardDescription></div><Button variant="outline" size="sm" disabled={!history.length} onClick={() => setHistory([])}>清空</Button></div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5 xl:p-6">{history.length ? <>{history.map(item => <article key={item.id} className="space-y-3">
          <div className="flex justify-end"><div className="max-w-[98%]">
            <div className="mb-1 flex items-center justify-end gap-2 text-[10px] text-muted-foreground"><span>面板 · {item.messageType === "group" ? `群聊 ${item.groupId}` : `私聊 · ${item.userId}`}</span><time>{item.sentAt.toLocaleTimeString("zh-CN")}</time></div>
            <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-xs leading-5 text-primary-foreground shadow-sm">{item.message}</div>
          </div></div>
          {item.replies.length ? item.replies.map((reply: any, index: number) => <div key={index} className="flex justify-start"><div className="max-w-[92%]">
            <div className="mb-1 flex min-w-0 items-center gap-2 text-[10px]"><span className="font-medium text-foreground">{reply?.plugin?.name ? `插件 · ${reply.plugin.name}` : "插件回复 · 来源未识别"}</span>{reply?.plugin?.handler && <span className="truncate text-muted-foreground">{reply.plugin.handler}</span>}</div>
            {reply?.plugin?.path && <div className="mb-1 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground" title={`plugins/${reply.plugin.path}`}><FileCode2 className="size-3 shrink-0" /><span className="truncate font-mono">plugins/{reply.plugin.path}</span></div>}
            <div className="space-y-2 whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-border bg-card px-4 py-3 text-xs leading-5 shadow-sm">{Array.isArray(reply?.segments) ? reply.segments.map((segment: any, segmentIndex: number) => renderReplySegment(segment, `${item.id}-${index}-${segmentIndex}`)) : reply?.text}</div>
          </div></div>) : <div className="flex justify-start"><div className="max-w-[92%] rounded-xl border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground">{item.summary}</div></div>}
        </article>)}<div ref={conversationEndRef} /> </> : <div className="grid min-h-full place-items-center text-center"><div><div className="mx-auto grid size-11 place-items-center rounded-2xl bg-accent text-foreground"><MessageSquareText className="size-5" /></div><p className="mt-3 text-sm font-medium">还没有调试记录</p><p className="mt-1 text-xs text-muted-foreground">发送消息后，插件回复会显示在这里。</p></div></div>}</div>
      </section>
    </div>
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
    <PageIntro actions={[
      { label: wrapLines ? "关闭自动换行" : "自动换行", render: iconOnly => <Button variant={wrapLines ? "secondary" : "outline"} size={iconOnly ? "icon" : "default"} aria-label={wrapLines ? "关闭自动换行" : "自动换行"} title={wrapLines ? "关闭自动换行" : "自动换行"} onClick={() => setWrapLines(value => !value)}><WrapText />{!iconOnly && (wrapLines ? "关闭自动换行" : "自动换行")}</Button> },
      { label: "刷新日志", render: iconOnly => <Button variant="outline" size={iconOnly ? "icon" : "default"} aria-label="刷新日志" title="刷新日志" onClick={() => refresh(selected, true)} disabled={loading}>{loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}{!iconOnly && "刷新日志"}</Button> },
    ]} />
    {error && <div className="mb-4"><ErrorState message={error} /></div>}
    <Card className="overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"><div className="flex flex-wrap items-center gap-2"><TerminalSquare className="size-4 text-muted-foreground" /><Label htmlFor="log-file-select" className="text-xs font-medium">日期与类型</Label><Select value={selected} onValueChange={file => void refresh(file, true)} disabled={!files.length}><SelectTrigger id="log-file-select" aria-label="日期与类型" className="h-9 w-auto min-w-56 bg-card text-xs"><SelectValue placeholder="没有可用日志" /></SelectTrigger><SelectContent>{files.map(file => <SelectItem key={file} value={file}>{logFileLabel(file)}</SelectItem>)}</SelectContent></Select></div><div className="relative w-full sm:w-64"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="h-9 pl-9 text-xs" placeholder="搜索日志内容…" value={search} onChange={event => setSearch(event.target.value)} /></div></div><div className="flex items-center justify-between px-4 py-2 text-[10px] text-muted-foreground"><span>{selected ? `${logFileLabel(selected)} · ${selected}` : "没有可用日志"}</span><span className="flex items-center gap-3"><span>{visibleEntries.length} 行 · 保留末尾最多 600 行</span><span className="inline-flex items-center gap-1.5"><span className={`size-1.5 rounded-full ${liveStatus === "connected" ? "bg-emerald-500" : "bg-amber-400"}`} />{liveStatus === "connected" ? "实时连接" : liveStatus === "connecting" ? "正在连接" : "正在重连"}</span></span></div><pre ref={logViewRef} onScroll={event => { const element = event.currentTarget; setFollowLatest(element.scrollHeight - element.scrollTop - element.clientHeight <= 48) }} className={`scrollbar-thin min-h-[560px] max-h-[calc(100vh-300px)] overflow-auto bg-neutral-950 p-4 font-mono text-[11px] leading-[1.75] text-neutral-200 ${wrapLines ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`}>{loading && !entries.length ? "正在读取…" : visibleEntries.length ? visibleEntries.map((entry, index) => <span key={`${selected}-${entry.id}-${index}`} className="block min-h-[1.75em]">{colorizeLogLine(entry.text).map((segment, segmentIndex) => <span key={segmentIndex} style={segment.color ? { color: segment.color } : undefined}>{segment.text}</span>)}</span>) : "暂无日志内容"}</pre></Card>
  </>
}
