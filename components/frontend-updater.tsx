"use client"

import { useEffect, useState } from "react"
import { ArrowDownToLine, LoaderCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

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
      const result = await api("/api/frontend/update", { method: "POST", body: "{}" })
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
  return <Card><CardHeader>
    <CardTitle>面板前端</CardTitle>
    <CardDescription>{development ? "当前使用开发源码，关闭开发模式并重启 Bot 后可更新发布版本。" : "检查最新发布版本，有变化时自动下载并更新。"}</CardDescription>
  </CardHeader><CardContent className="space-y-3">
    <div className="text-xs text-muted-foreground">当前版本：<span className="break-all font-mono text-foreground">{development ? "开发模式" : status?.installed?.release || (status ? "本地构建" : error ? "读取失败" : "读取中…")}</span></div>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy || development || !status} onClick={update}>
        {busy ? <LoaderCircle className="animate-spin" /> : <ArrowDownToLine />}{busy ? "正在检查并更新…" : "检查并更新前端"}
      </Button>
      {updated && <Button type="button" size="sm" onClick={() => window.location.reload()}><RefreshCw />刷新使用新版本</Button>}
    </div>
    {error && <p role="alert" className="break-words text-xs leading-5 text-rose-600">{error}</p>}
  </CardContent></Card>
}
