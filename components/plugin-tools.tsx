"use client"

import { useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { LoaderCircle, X } from "lucide-react"

type Api = (url: string, init?: RequestInit) => Promise<any>
type Proxy = { proxyMode: string; proxy: string }
type Notify = (kind: "success" | "error", message: string) => void

export function ProxyFields({ value, onChange }: { value: Proxy; onChange: (value: Proxy) => void }) {
  return <div className="space-y-2"><Label>下载代理</Label><select aria-label="代理类型" className="h-10 w-full rounded-lg border px-3 text-sm" value={value.proxyMode} onChange={event => onChange({ ...value, proxyMode: event.target.value })}><option value="none">不使用代理</option><option value="standard">常规 HTTP / SOCKS 代理</option><option value="prefix">链接前缀代理</option></select>{value.proxyMode !== "none" && <Input aria-label="代理地址" value={value.proxy} onChange={event => onChange({ ...value, proxy: event.target.value })} placeholder={value.proxyMode === "prefix" ? "https://gh-proxy.com" : "http://127.0.0.1:7890"} required />}</div>
}

function ToolDialog({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: React.ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[60] bg-slate-950/40 backdrop-blur-sm" /><Dialog.Content className="fixed left-1/2 top-1/2 z-[61] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-white p-5 shadow-2xl"><div className="mb-4 flex justify-between gap-3"><div><Dialog.Title className="font-semibold">{title}</Dialog.Title><Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">{description}</Dialog.Description></div><Dialog.Close asChild><Button type="button" size="icon" variant="ghost" aria-label="关闭"><X /></Button></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function PluginTools({ plugin, api, notify, confirm, onUpdated }: { plugin: any; api: Api; notify: Notify; confirm: (message: string) => Promise<boolean>; onUpdated: () => void | Promise<void> }) {
  const [open, setOpen] = useState<"git" | "dependencies" | null>(null)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<any>(null)
  const [kind, setKind] = useState("branch")
  const [ref, setRef] = useState("")
  const [prune, setPrune] = useState(false)
  const [proxy, setProxy] = useState<Proxy>({ proxyMode: "none", proxy: "" })
  const [dependencies, setDependencies] = useState("")
  const [dependencyVersion, setDependencyVersion] = useState("")
  const [install, setInstall] = useState(false)
  async function load(tool: "git" | "dependencies") {
    setBusy(true)
    try {
      const result = await api(`/api/plugins/${encodeURIComponent(plugin.id)}/${tool === "git" ? "git" : "dependencies"}`)
      if (tool === "dependencies") setDependencyVersion(result.version)
      if (tool === "git") { setInfo(result); setRef(result.branch || result.head); setKind(result.branch ? "branch" : "commit"); setPrune(false) }
      else { setDependencies(JSON.stringify(result.data, null, 2)); setInstall(false) }
      setOpen(tool)
    } catch (error) { notify("error", (error as Error).message) } finally { setBusy(false) }
  }
  async function fetchRefs() {
    setBusy(true)
    try { setInfo(await api(`/api/plugins/${encodeURIComponent(plugin.id)}/git/fetch`, { method: "POST", body: JSON.stringify(proxy) })); notify("success", "已获取远端分支和提交") }
    catch (error) { notify("error", (error as Error).message) } finally { setBusy(false) }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (open === "git" && !await confirm(`将 ${plugin.title} 更新到${kind === "branch" ? "分支" : "提交"} ${ref}？${prune ? "\n.git 将裁剪为一个提交，原历史会保留备份。" : ""}\n重启 Bot 后生效。`)) return
    setBusy(true)
    try {
      const body = open === "git" ? { ...proxy, kind, ref, pruneHistory: prune } : { data: JSON.parse(dependencies), install, version: dependencyVersion }
      const result = await api(`/api/plugins/${encodeURIComponent(plugin.id)}/${open === "git" ? "git/update" : "dependencies"}`, { method: open === "git" ? "POST" : "PUT", body: JSON.stringify(body) })
      notify("success", result.message); setOpen(null); await onUpdated()
    } catch (error) { notify("error", (error as Error).message) } finally { setBusy(false) }
  }
  return <>
    {plugin.hasPackage && <Button variant="outline" disabled={busy} onClick={() => load("dependencies")}>编辑依赖</Button>}
    {plugin.hasGit && <Button variant="outline" disabled={busy} onClick={() => load("git")}>手动更新</Button>}
    <ToolDialog open={open !== null} onOpenChange={value => { if (!value && !busy) setOpen(null) }} title={open === "git" ? "手动更新插件" : "编辑插件依赖"} description={open === "git" ? "选择或输入分支、commit；存在本地修改时会停止更新。" : "编辑 package.json 中的依赖对象；保存前自动备份。"}>
      <form onSubmit={submit} className="space-y-4">{open === "git" ? <>
        <p className="break-all text-xs text-muted-foreground">当前：{info?.branch || "游离提交"} · {info?.head?.slice(0, 12)}</p>
        <div className="flex gap-2"><Button type="button" variant={kind === "branch" ? "secondary" : "outline"} onClick={() => { setKind("branch"); setRef(info?.branch || info?.branches?.[0] || "") }}>分支</Button><Button type="button" variant={kind === "commit" ? "secondary" : "outline"} onClick={() => { setKind("commit"); setRef(info?.head || "") }}>commit</Button></div>
        <Label htmlFor={`update-ref-${plugin.id}`}>目标{kind === "branch" ? "分支" : "commit"}</Label><Input id={`update-ref-${plugin.id}`} list={`update-refs-${plugin.id}`} value={ref} onChange={event => setRef(event.target.value)} placeholder={kind === "branch" ? "输入或选择分支" : "输入或选择提交哈希"} required /><datalist id={`update-refs-${plugin.id}`}>{kind === "branch" ? info?.branches?.map((branch: string) => <option key={branch} value={branch} />) : info?.commits?.map((commit: any) => <option key={commit.hash} value={commit.hash}>{commit.message}</option>)}</datalist>
        <ProxyFields value={proxy} onChange={setProxy} /><Button type="button" variant="outline" disabled={busy} onClick={fetchRefs}>获取远端分支与提交</Button>
        <div className="flex items-center justify-between gap-3"><Label htmlFor={`prune-${plugin.id}`}>裁剪 .git，仅保留最新一个提交</Label><Switch id={`prune-${plugin.id}`} checked={prune} onCheckedChange={setPrune} /></div>
      </> : <><Textarea aria-label="依赖 JSON" className="min-h-72 font-mono text-xs" value={dependencies} onChange={event => setDependencies(event.target.value)} /><div className="flex items-center justify-between"><Label>保存后安装依赖（不执行生命周期脚本）</Label><Switch checked={install} onCheckedChange={setInstall} /></div></>}
      <Button type="submit" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}{open === "git" ? "更新到所选版本" : "保存依赖"}</Button></form>
    </ToolDialog>
  </>
}

export function ScriptInstaller({ api, notify, onInstalled }: { api: Api; notify: Notify; onInstalled: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState("upload")
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true)
    try {
      if (mode === "upload" && (!file || file.size > 1_500_000)) throw new Error("请选择不超过 1.5 MB 的 JS 文件")
      const result = mode === "upload" ? await api(`/api/plugins/install-script?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file }) : await api("/api/plugins/install-script", { method: "POST", body: JSON.stringify({ name, url }) })
      notify("success", result.message); setOpen(false); setFile(null); setUrl(""); setName(""); await onInstalled()
    } catch (error) { notify("error", (error as Error).message) } finally { setBusy(false) }
  }
  return <><Button variant="outline" onClick={() => setOpen(true)}>安装单 JS 插件</Button><ToolDialog open={open} onOpenChange={setOpen} title="安装单 JS 插件" description="安装到 plugins/example；支持本地上传或 HTTPS 文件直链，不覆盖同名文件。重启后加载。"><form onSubmit={submit} className="space-y-4"><select aria-label="安装方式" value={mode} onChange={event => setMode(event.target.value)} className="h-10 w-full rounded-lg border px-3"><option value="upload">上传 JS 文件</option><option value="url">HTTPS 文件直链</option></select>{mode === "upload" ? <Input aria-label="选择 JS 文件" type="file" accept=".js" required onChange={event => { const file = event.target.files?.[0] || null; setFile(file); if (file) setName(file.name) }} /> : <Input aria-label="JS 文件直链" type="url" placeholder="https://example.com/plugin.js" value={url} required onChange={event => { setUrl(event.target.value); if (!name) { try { const last = new URL(event.target.value).pathname.split("/").pop(); if (last?.endsWith(".js")) setName(last) } catch {} } }} />}<Label>安装文件名</Label><Input aria-label="安装文件名" value={name} required pattern=".+\.js" placeholder="plugin.js" onChange={event => setName(event.target.value)} /><Button type="submit" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}安装</Button></form></ToolDialog></>
}
