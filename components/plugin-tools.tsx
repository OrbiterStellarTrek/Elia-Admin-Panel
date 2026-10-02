"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DependencyEditor, type DependencyData } from "@/components/dependency-editor"
import { Switch } from "@/components/ui/switch"
import { Collapse } from "@/components/ui/motion"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EditableCombobox } from "@/components/ui/editable-combobox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArrowRight, Check, ChevronDown, GitBranch, GitCommitHorizontal, LoaderCircle, RefreshCw, Upload, X } from "lucide-react"

type Api = (url: string, init?: RequestInit) => Promise<any>
type Notify = (kind: "success" | "error", message: string) => void

export function DownloadProxyHint() {
  return <p className="text-xs leading-5 text-muted-foreground">下载代理统一使用已保存的<a href="/settings/" className="ml-1 underline underline-offset-4">面板设置</a>。</p>
}

function ToolDialog({ open, onOpenChange, title, description, children, wide = false }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: React.ReactNode; wide?: boolean }) {
  const triggerRef = useRef<HTMLElement | null>(null)
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="admin-dialog-overlay fixed inset-0 z-[60] bg-neutral-950/40 backdrop-blur-sm" /><Dialog.Content onOpenAutoFocus={() => { triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }} onCloseAutoFocus={event => { if (triggerRef.current?.isConnected) { event.preventDefault(); triggerRef.current.focus() } }} className={`admin-dialog-content admin-tool-dialog fixed left-1/2 top-1/2 z-[61] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${wide ? "max-w-4xl" : "max-w-xl"} -translate-x-1/2 -translate-y-1/2 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border bg-card p-5 shadow-2xl`}><div className="mb-4 flex items-start justify-between gap-3"><div className="min-w-0 break-words"><Dialog.Title className="font-semibold">{title}</Dialog.Title><Dialog.Description className="mt-1 text-xs leading-5 text-muted-foreground">{description}</Dialog.Description></div><Dialog.Close asChild><Button type="button" size="icon" variant="ghost" className="shrink-0" aria-label="关闭"><X /></Button></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>
}

export function PluginTools({ plugin, api, notify, confirm, onUpdated }: { plugin: any; api: Api; notify: Notify; confirm: (message: string) => Promise<boolean>; onUpdated: () => void | Promise<void> }) {
  const [open, setOpen] = useState<"git" | "dependencies" | null>(null)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<any>(null)
  const [kind, setKind] = useState("branch")
  const [ref, setRef] = useState("")
  const [prune, setPrune] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [dependencies, setDependencies] = useState<DependencyData>({})
  const [dependencyVersion, setDependencyVersion] = useState("")
  const [install, setInstall] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState("")
  const [activity, setActivity] = useState<"fetch" | "update" | null>(null)
  const dialogSession = useRef(0)
  const pendingCheck = useRef<{ key: string; promise: Promise<any> } | null>(null)
  const checking = activity === "fetch"
  useEffect(() => {
    setOpen(null); setBusy(false); setActivity(null)
    return () => { dialogSession.current += 1 }
  }, [plugin.id])
  function closeTool() {
    if (busy) return
    dialogSession.current += 1
    setOpen(null); setActivity(null)
  }
  async function load(tool: "git" | "dependencies") {
    const session = ++dialogSession.current
    setBusy(true)
    try {
      const result = await api(`/api/plugins/${encodeURIComponent(plugin.id)}/${tool === "git" ? "git" : "dependencies"}`)
      if (session !== dialogSession.current) return
      if (tool === "dependencies") setDependencyVersion(result.version)
      if (tool === "git") {
        const defaultBranch = result.branch || ["main", "master"].find(branch => result.branches?.includes(branch)) || result.branches?.[0]
        setInfo(result); setRef(defaultBranch || result.head); setKind(defaultBranch ? "branch" : "commit"); setPrune(false); setAdvancedOpen(false); setCheckedAt(null); setFetchError("")
      }
      else { setDependencies(result.data); setInstall(false) }
      setOpen(tool)
      if (tool === "git") { setBusy(false); await fetchRefs() }
    } catch (error) { if (session === dialogSession.current) notify("error", (error as Error).message) }
    finally { if (session === dialogSession.current) setBusy(false) }
  }
  async function fetchRefs() {
    const session = dialogSession.current
    const key = String(plugin.id)
    setActivity("fetch"); setFetchError(""); setCheckedAt(null)
    // Reopening the dialog can reuse the same check while Git is still fetching.
    const check = pendingCheck.current?.key === key ? pendingCheck.current : { key, promise: api(`/api/plugins/${encodeURIComponent(plugin.id)}/git/fetch`, { method: "POST", body: JSON.stringify({}) }) }
    pendingCheck.current = check
    try {
      const result = await check.promise
      if (session !== dialogSession.current) return
      setInfo(result); setCheckedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })); notify("success", "已刷新远端版本，请确认目标版本后更新")
    } catch (error) {
      if (session !== dialogSession.current) return
      setFetchError((error as Error).message); notify("error", (error as Error).message)
    } finally {
      if (pendingCheck.current === check) pendingCheck.current = null
      if (session === dialogSession.current) setActivity(null)
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (open === "git" && (busy || checking || info?.dirty || !ref.trim())) return
    if (open === "git" && !await confirm(`将 ${plugin.title} 从 ${info?.head?.slice(0, 12)} 更新到${kind === "branch" ? "分支最新版" : "指定提交"} ${ref.trim()}？${prune ? "\n.git 将裁剪为一个提交，原历史会保留备份。" : ""}\n重启 Bot 后生效。`)) return
    setBusy(true); setActivity("update")
    try {
      const body = open === "git" ? { kind, ref, pruneHistory: prune } : { data: dependencies, install, version: dependencyVersion }
      const result = await api(`/api/plugins/${encodeURIComponent(plugin.id)}/${open === "git" ? "git/update" : "dependencies"}`, { method: open === "git" ? "POST" : "PUT", body: JSON.stringify(body) })
      notify("success", result.message); setOpen(null); await onUpdated()
    } catch (error) { notify("error", (error as Error).message) } finally { setBusy(false); setActivity(null) }
  }
  const selectedCommit = ref.trim() ? info?.commits?.find((commit: any) => commit.hash.startsWith(ref.trim())) : undefined
  const target = kind === "branch" ? info?.branchTips?.find((branch: any) => branch.name === ref.trim()) : selectedCommit
  const sameVersion = target?.hash === info?.head
  return <>
    {plugin.hasPackage && <Button variant="outline" disabled={busy} onClick={() => load("dependencies")}>编辑依赖</Button>}
    {plugin.hasGit && <Button variant="outline" disabled={busy} onClick={() => load("git")}>手动更新</Button>}
    <ToolDialog open={open !== null} onOpenChange={value => { if (!value) closeTool() }} wide={open === "git" && kind === "commit"} title={open === "git" ? "更新插件" : "编辑插件依赖"} description={open === "git" ? `为 ${plugin.title} 选择更新版本，重启 Bot 后生效。` : "按依赖类型编辑包与版本；从 registry.npmmirror.com 查询真实版本，保存前自动备份。"}>
      <form onSubmit={submit} className="space-y-4">{open === "git" ? <div className="admin-plugin-update-layout min-w-0" data-history-open={kind === "commit"}>
        <div className="min-w-0 space-y-4" aria-label="更新设置">
        <div className="rounded-xl border bg-muted/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted-foreground">当前安装版本</span><span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs"><GitBranch className="size-3.5 shrink-0" /><span className="truncate" title={info?.branch || "指定提交"}>{info?.branch || "指定提交"}</span></span></div>
          <div className="mt-2 flex items-center gap-2"><GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" /><code className="text-sm font-medium">{info?.head?.slice(0, 12)}</code></div>
          {info?.commits?.find((commit: any) => commit.hash === info.head)?.message && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{info.commits.find((commit: any) => commit.hash === info.head).message}</p>}
        </div>
        <fieldset disabled={busy || checking} className="min-w-0 space-y-3">
          <legend className="mb-2 text-sm font-medium">更新方式</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[{ value: "branch", title: "分支最新版", hint: "获取分支最新代码", icon: GitBranch }, { value: "commit", title: "指定历史版本", hint: "从历史记录中选择", icon: GitCommitHorizontal }].map(option => <label key={option.value} className={`flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring ${kind === option.value ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}>
              <input type="radio" name={`update-kind-${plugin.id}`} value={option.value} checked={kind === option.value} onChange={() => { setKind(option.value); setRef(option.value === "branch" ? info?.branch || info?.branches?.[0] || "" : info?.head || "") }} className="sr-only" />
              <option.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{option.title}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.hint}</span></span><span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${kind === option.value ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>{kind === option.value && <Check className="size-3" />}</span>
            </label>)}
          </div>
          <div className="space-y-2"><Label htmlFor={`update-ref-${plugin.id}`}>{kind === "branch" ? "更新分支" : "提交哈希"}</Label><EditableCombobox id={`update-ref-${plugin.id}`} label={kind === "branch" ? "目标分支" : "目标提交"} value={ref} onValueChange={setRef} placeholder={kind === "branch" ? "输入或选择分支" : "输入 7 至 40 位提交哈希"} options={kind === "branch" ? (info?.branches || []).map((branch: string) => ({ value: branch, label: `${branch}${branch === info?.branch ? "（当前分支）" : ""}` })) : (info?.commits || []).map((commit: any) => ({ value: commit.hash, label: `${commit.hash.slice(0, 12)} · ${commit.message}` }))} required /></div>
          <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs leading-5 text-muted-foreground" role="status">{activity === "fetch" ? "正在获取远端版本…" : checkedAt ? `远端版本已刷新 · ${checkedAt}` : "尚未检查远端，记录来自本地缓存"}</p><Button type="button" size="sm" variant="outline" onClick={fetchRefs}>{activity === "fetch" ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}检查更新</Button></div>
          <DownloadProxyHint />
          {fetchError && <p role="alert" className="break-words text-xs leading-5 text-destructive">检查失败：{fetchError}。可检查面板设置中的下载代理后重试。</p>}
          <div className="rounded-xl border bg-muted/30 p-3" aria-live="polite"><div className="flex min-w-0 items-start gap-2 text-sm font-medium leading-6"><ArrowRight className="mt-1 size-4 shrink-0" /><span className="min-w-0 break-all">{kind === "branch" ? `更新到 ${ref.trim() || "所选分支"} 最新版` : "切换到所选历史版本"}</span></div><p className="mt-2 break-words text-xs leading-5 text-muted-foreground">{target ? target.message : kind === "branch" ? "执行更新时会获取该分支的最新代码。" : "可从提交历史选择版本，或填写已知的提交哈希。"}</p>{(target?.hash || kind === "commit" && ref.trim()) && <code className="mt-2 block break-all text-xs">{info?.head?.slice(0, 12)} → {(target?.hash || ref.trim()).slice(0, 12)}</code>}{sameVersion && <p className="mt-2 text-xs text-muted-foreground">{kind === "commit" ? "所选提交就是当前安装版本。" : checkedAt ? "与本次检查记录中的当前版本一致。" : "与本地缓存中的当前版本一致，请先检查更新。"}</p>}</div>
          <div className="overflow-hidden rounded-xl border">
            <button type="button" aria-expanded={advancedOpen} aria-controls={`update-advanced-${plugin.id}`} onClick={() => setAdvancedOpen(value => !value)} className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">高级选项<span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">{prune ? "裁剪历史已开启" : "提交历史"}<ChevronDown className={`size-4 transition-transform duration-300 motion-reduce:transition-none ${advancedOpen ? "rotate-180" : ""}`} /></span></button>
            <div id={`update-advanced-${plugin.id}`}><Collapse open={advancedOpen}><fieldset disabled={!advancedOpen || busy} className="min-w-0 space-y-4 border-t p-3"><div className="flex items-start justify-between gap-4"><div className="space-y-1"><Label htmlFor={`prune-${plugin.id}`}>仅保留一个提交</Label><p className="text-xs leading-5 text-muted-foreground">减少 .git 占用；原提交历史会备份，默认保留完整历史。</p></div><Switch id={`prune-${plugin.id}`} checked={prune} onCheckedChange={setPrune} /></div></fieldset></Collapse></div>
          </div>
        </fieldset>
        <p className={`text-xs leading-5 ${info?.dirty ? "text-destructive" : "text-muted-foreground"}`} role={info?.dirty ? "alert" : undefined}>{info?.dirty ? "检测到本地修改或未跟踪文件，请先处理后再更新。" : "存在本地修改时会停止更新；更新完成后需重启 Bot。"}</p>
        </div>
        <div className="admin-plugin-history-shell" data-open={kind === "commit"} inert={kind !== "commit"} aria-hidden={kind !== "commit"}>
        <div className="admin-plugin-history-inner">
        <section aria-label="提交历史" className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-muted/20">
          <div className="shrink-0 space-y-2 border-b p-4">
            <h3 className="flex items-center gap-2 text-sm font-medium"><GitCommitHorizontal className="size-4" />提交历史<span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{info?.commits?.length || 0}</span></h3>
            <p className="text-xs leading-5 text-muted-foreground">点击记录即可选择版本，并同步更新目标。</p>
          </div>
          <div className="max-h-80 min-h-0 flex-1 overflow-y-auto overscroll-contain md:max-h-none">
            {(info?.commits || []).map((commit: any) => {
              const selected = target?.hash === commit.hash
              return <button type="button" key={commit.hash} disabled={busy || checking} aria-pressed={selected} onClick={() => { setKind("commit"); setRef(commit.hash) }} className={`flex w-full items-start gap-3 border-b p-4 text-left text-xs transition-colors last:border-0 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50 ${selected ? "bg-primary/5" : ""}`}>
                <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1"><span className="block break-words text-sm leading-6">{commit.message}</span><span className="mt-1 flex flex-wrap items-center gap-2"><code className="text-muted-foreground">{commit.hash.slice(0, 12)}</code>{commit.hash === info?.head && <span className="rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">当前版本</span>}{selected && <span className="text-[10px] font-medium">已选择</span>}</span></span>
                {selected && <Check className="mt-1 size-4 shrink-0" />}
              </button>
            })}
            {!info?.commits?.length && <p className="p-6 text-center text-xs leading-6 text-muted-foreground">暂无提交记录，可检查更新获取远端历史。</p>}
          </div>
        </section>
        </div>
        </div>
      </div> : <><DependencyEditor value={dependencies} onChange={setDependencies} disabled={busy} /><div className="flex items-start justify-between gap-4 rounded-lg border p-3"><Label htmlFor={`install-dependencies-${plugin.id}`} className="min-w-0 leading-6">保存后安装依赖<span className="block text-xs font-normal leading-5 text-muted-foreground">不执行生命周期脚本</span></Label><Switch id={`install-dependencies-${plugin.id}`} checked={install} onCheckedChange={setInstall} disabled={busy} /></div></>}
      <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 flex flex-wrap justify-end gap-2 border-t bg-card px-5 pb-5 pt-4"><Button type="button" variant="outline" disabled={busy} onClick={closeTool}>取消</Button><Button type="submit" disabled={busy || checking || open === "git" && (!ref.trim() || info?.dirty)}>{activity === "update" && <LoaderCircle className="animate-spin" />}{open === "git" ? activity === "update" ? "正在更新…" : kind === "branch" ? "更新到分支最新版" : "更新到此版本" : "保存依赖"}</Button></div></form>
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
  const [dragActive, setDragActive] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const selectUploadFile = useCallback((nextFile: File | null) => {
    if (!nextFile) return
    if (!nextFile.name.toLowerCase().endsWith(".js")) return notify("error", "仅支持 .js 文件")
    setFile(nextFile)
    setName(nextFile.name)
  }, [notify])

  useEffect(() => {
    if (!open || mode !== "upload") return
    const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes("Files")
    const handleDragEnter = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      dragDepth.current += 1
      setDragActive(true)
    }
    const handleDragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    }
    const handleDragLeave = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragActive(false)
    }
    const handleDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragActive(false)
      selectUploadFile(event.dataTransfer?.files.item(0) || null)
    }
    window.addEventListener("dragenter", handleDragEnter)
    window.addEventListener("dragover", handleDragOver)
    window.addEventListener("dragleave", handleDragLeave)
    window.addEventListener("drop", handleDrop)
    return () => {
      window.removeEventListener("dragenter", handleDragEnter)
      window.removeEventListener("dragover", handleDragOver)
      window.removeEventListener("dragleave", handleDragLeave)
      window.removeEventListener("drop", handleDrop)
      dragDepth.current = 0
    }
  }, [open, mode, selectUploadFile])

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true)
    try {
      if (mode === "upload" && (!file || file.size > 1_500_000)) throw new Error("请选择不超过 1.5 MB 的 JS 文件")
      const result = mode === "upload" ? await api(`/api/plugins/install-script?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file }) : await api("/api/plugins/install-script", { method: "POST", body: JSON.stringify({ name, url }) })
      notify("success", result.message); setOpen(false); setFile(null); setUrl(""); setName(""); await onInstalled()
    } catch (error) { notify("error", (error as Error).message) } finally { setBusy(false) }
  }
  return <>
    <Button variant="outline" onClick={() => { dragDepth.current = 0; setDragActive(false); setOpen(true) }}>安装单 JS 插件</Button>
    <ToolDialog open={open} onOpenChange={value => { if (!value && !busy) { dragDepth.current = 0; setDragActive(false); setOpen(false) } }} title="安装单 JS 插件" description="安装到 plugins/example；支持本地上传或 HTTPS 文件直链，不覆盖同名文件。重启后加载。">
      <form onSubmit={submit} className="space-y-4">
        <Tabs value={mode} onValueChange={value => { dragDepth.current = 0; setDragActive(false); setMode(value) }} className="min-w-0"><TabsList aria-label="安装方式" className="relative grid w-full grid-cols-2"><span aria-hidden="true" className="installer-tab-indicator" style={{ transform: mode === "url" ? "translateX(100%)" : "translateX(0)" }} /><TabsTrigger className="relative z-10 min-w-0 px-1 text-xs sm:text-sm data-[state=active]:bg-transparent data-[state=active]:shadow-none" value="upload" disabled={busy}>上传 JS 文件</TabsTrigger><TabsTrigger className="relative z-10 min-w-0 px-1 text-xs sm:text-sm data-[state=active]:bg-transparent data-[state=active]:shadow-none" value="url" disabled={busy}>HTTPS 文件直链</TabsTrigger></TabsList>
        <TabsContent value="upload" className="installer-tab-content mt-4 space-y-2">
          <Label htmlFor="install-script-file">本地 JS 文件</Label>
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-muted/70 p-3">
            <Button type="button" variant="outline" className="shrink-0" disabled={busy} onClick={() => fileInput.current?.click()}><Upload />选择文件</Button>
            <span className={`min-w-0 flex-1 truncate text-sm ${file ? "text-foreground" : "text-muted-foreground"}`} title={file?.name || "尚未选择 JS 文件"}>{file?.name || "尚未选择 JS 文件"}</span>
            {file && <Button type="button" size="icon" variant="ghost" className="shrink-0" disabled={busy} aria-label="移除已选择文件" title="移除已选择文件" onClick={() => { setFile(null); setName(current => current === file.name ? "" : current); if (fileInput.current) fileInput.current.value = "" }}><X /></Button>}
          </div>
          <Input ref={fileInput} id="install-script-file" className="hidden" aria-label="选择 JS 文件" type="file" accept=".js" onChange={event => { selectUploadFile(event.currentTarget.files?.[0] || null); event.currentTarget.value = "" }} />
        </TabsContent><TabsContent value="url" className="installer-tab-content mt-4 space-y-2">
          <Label htmlFor="install-script-url">HTTPS 文件直链</Label>
          <Input id="install-script-url" aria-label="JS 文件直链" type="url" placeholder="https://example.com/plugin.js" value={url} required onChange={event => { setUrl(event.target.value); if (!name) { try { const last = new URL(event.target.value).pathname.split("/").pop(); if (last?.endsWith(".js")) setName(last) } catch {} } }} />
        </TabsContent></Tabs>
        <div className="space-y-2">
          <Label htmlFor="install-script-name">安装文件名</Label>
          <Input id="install-script-name" aria-label="安装文件名" value={name} required pattern=".+\.js" placeholder="plugin.js" onChange={event => setName(event.target.value)} />
        </div>
        <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 flex flex-wrap justify-end gap-2 border-t bg-card px-5 pb-5 pt-4"><Button type="button" variant="outline" disabled={busy} onClick={() => { dragDepth.current = 0; setDragActive(false); setOpen(false) }}>取消</Button><Button type="submit" disabled={busy}>{busy && <LoaderCircle className="animate-spin" />}安装</Button></div>
      </form>
    </ToolDialog>
    {open && mode === "upload" && dragActive && typeof document !== "undefined" && createPortal(
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-3 z-[1000] grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-neutral-950/20 backdrop-blur-[2px]">
        <div className="flex items-center gap-3 rounded-xl bg-card px-5 py-4 text-sm font-medium text-foreground shadow-xl"><Upload className="size-5 text-foreground" />松开鼠标即可添加 JS 文件</div>
      </div>,
      document.body,
    )}
  </>
}
