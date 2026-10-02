"use client"

import { useEffect, useState } from "react"
import { ArrowDownToLine, LoaderCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

type Status = { mode: "development" | "release"; installed: { release: string; digest: string } | null }

export function FrontendUpdater({ api, notify }: {
  api: (url: string, init?: RequestInit) => Promise<any>
  notify: (kind: "success" | "error" | "info", message: string) => void
}) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [updated, setUpdated] = useState(false)
  useEffect(() => {
    let active = true
    api("/api/frontend/status").then(result => { if (active) setStatus(result) })
      .catch(reason => { if (active) setError((reason as Error).message) })
    return () => { active = false }
  }, [api])
  async function update() {
    setBusy(true)
    setError("")
    try {
      const result = await api("/api/frontend/update", { method: "POST", body: JSON.stringify({}) })
      setStatus(current => ({ mode: current?.mode || "release", installed: { release: result.release, digest: result.digest } }))
      setUpdated(current => current || result.updated)
      notify(result.updated ? "success" : "info", result.message)
    } catch (reason) {
      const message = (reason as Error).message
      setError(message)
      notify("error", message)
    } finally { setBusy(false) }
  }
  const development = status?.mode === "development"
  return <section aria-label="面板前端" className="space-y-4 border-t border-border p-4 sm:p-5"><header>
    <h2 className="text-base font-semibold tracking-tight">面板前端</h2>
    <p className="mt-1 text-sm leading-6 text-muted-foreground">{development ? "当前使用开发源码，关闭开发模式并重启 Bot 后可更新发布版本。" : "检查最新发布版本，有变化时自动下载并更新。"}</p>
  </header><div className="space-y-3">
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1 text-xs leading-5 text-muted-foreground"><span className="shrink-0">当前版本：</span><span className="min-w-0 break-all font-mono text-foreground">{development ? "开发模式" : status?.installed?.release || (status ? "本地构建" : error ? "读取失败" : "读取中…")}</span></div>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy || development || !status} onClick={update}>
        {busy ? <LoaderCircle className="animate-spin" /> : <ArrowDownToLine />}{busy ? "正在检查并更新…" : "检查并更新前端"}
      </Button>
      {updated && <Button type="button" size="sm" onClick={() => window.location.reload()}><RefreshCw />刷新使用新版本</Button>}
    </div>
    <p className="text-xs leading-5 text-muted-foreground">使用面板设置中已保存的下载代理。</p>
    {error && <p role="alert" className="break-words text-xs leading-5 text-destructive">{error}</p>}
  </div></section>
}
