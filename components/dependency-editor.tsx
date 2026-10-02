"use client"

import { useEffect, useState } from "react"
import { Check, ChevronsUpDown, LoaderCircle, Plus, Search, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

const groups = [
  { key: "dependencies", label: "运行" },
  { key: "devDependencies", label: "开发" },
  { key: "peerDependencies", label: "对等" },
  { key: "optionalDependencies", label: "可选" },
] as const
export type DependencyData = Record<string, Record<string, string>>
type PackageInfo = { name: string; description: string; tags: Record<string, string>; versions: string[]; deprecated?: string }
const registry = "https://registry.npmmirror.com"
const packageCache = new Map<string, { at: number; data: PackageInfo }>()

async function readRegistry(path: string, signal: AbortSignal) {
  const response = await fetch(`${registry}${path}`, { credentials: "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) })
  if (!response.ok) throw new Error(response.status === 404 ? "镜像中未找到这个包，可继续手工填写版本。" : `镜像查询失败（${response.status}），请重试。`)
  return response.json()
}

function RegistryVersion({ value, onChange, info, disabled }: { value: string; onChange: (value: string) => void; info: PackageInfo; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const options = [...Object.entries(info.tags).map(([tag, version]) => ({ value: version, label: `${tag} · ${version}` })), ...info.versions.map(version => ({ value: version, label: version }))]
  const visible = options.filter(option => option.label.toLowerCase().includes(query.toLowerCase())).slice(0, 80)
  return <div className="flex min-w-0 items-center gap-2"><Input aria-label="镜像版本" value={value} disabled={disabled} onChange={event => onChange(event.target.value)} className="min-w-0 font-mono" />
    <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><Button type="button" size="icon" variant="outline" className="shrink-0" disabled={disabled} aria-label="选择镜像版本"><ChevronsUpDown /></Button></PopoverTrigger>
      <PopoverContent className="z-[80] w-80 max-w-[calc(100vw-2rem)] p-0" align="end"><Command shouldFilter={false}><CommandInput aria-label="搜索镜像版本" placeholder="搜索版本或发布标签…" value={query} onValueChange={setQuery} /><CommandList><CommandEmpty>没有匹配版本，可手工填写。</CommandEmpty>{visible.map((option, index) => <CommandItem key={`${option.label}-${index}`} value={`${option.label}-${index}`} onSelect={() => { onChange(option.value); setOpen(false) }}><Check className={value === option.value ? "opacity-100" : "opacity-0"} />{option.label}</CommandItem>)}</CommandList></Command></PopoverContent>
    </Popover></div>
}

export function DependencyEditor({ value, onChange, disabled }: { value: DependencyData; onChange: (value: DependencyData) => void; disabled: boolean }) {
  const [group, setGroup] = useState("dependencies")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<{ name: string; description: string; version: string }[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState("")
  const [packageName, setPackageName] = useState("")
  const [lookupName, setLookupName] = useState("")
  const [lookupMode, setLookupMode] = useState(false)
  const [info, setInfo] = useState<PackageInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  const [version, setVersion] = useState("")
  const [prefix, setPrefix] = useState("^")
  useEffect(() => {
    const text = query.trim()
    setResults([]); setSearchError("")
    if (text.length < 2) { setSearching(false); return }
    const controller = new AbortController()
    setSearching(true)
    const timer = setTimeout(async () => {
      try {
        const data = await readRegistry(`/-/v1/search?text=${encodeURIComponent(text)}&size=10`, controller.signal)
        if (!Array.isArray(data.objects)) throw new Error("镜像返回的搜索结果无效。")
        if (!controller.signal.aborted) setResults(data.objects.map((item: any) => ({ name: item.package.name, description: item.package.description || "", version: item.package.version })))
      } catch (reason) { if (!controller.signal.aborted) setSearchError((reason as Error).name === "TimeoutError" ? "镜像查询超时，请重试。" : (reason as Error).message) }
      finally { if (!controller.signal.aborted) setSearching(false) }
    }, 350)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query])
  useEffect(() => {
    setInfo(null); setError("")
    if (!packageName) return
    const controller = new AbortController()
    setLoading(true)
    async function load() {
      try {
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName)) throw new Error("请输入有效的 npm 包名。")
        const cached = packageCache.get(packageName)
        let next = cached && Date.now() - cached.at < 300000 ? cached.data : null
        if (!next) {
          const data = await readRegistry(`/${encodeURIComponent(packageName)}`, controller.signal)
          if (!data.versions || !data["dist-tags"]) throw new Error("镜像返回的包信息无效。")
          next = { name: data.name, description: data.description || "", tags: data["dist-tags"], versions: Object.keys(data.versions).sort((a, b) => b.localeCompare(a, "en", { numeric: true })), deprecated: data.versions[data["dist-tags"].latest]?.deprecated }
          packageCache.set(packageName, { at: Date.now(), data: next })
        }
        if (!controller.signal.aborted) { setInfo(next); setVersion(next.tags.latest || next.versions[0] || "") }
      } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).name === "TimeoutError" ? "镜像查询超时，请重试。" : (reason as Error).message) }
      finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    return () => controller.abort()
  }, [packageName, retry])
  function update(name: string, next: string) { onChange({ ...value, [group]: { ...value[group], [name]: next } }) }
  function remove(name: string) { const next = { ...value[group] }; delete next[name]; onChange({ ...value, [group]: next }) }
  const existing = Boolean(packageName && Object.hasOwn(value[group] || {}, packageName))
  const packagePanel = <div className={lookupMode ? "min-w-0 space-y-3" : "min-w-0 space-y-3 rounded-lg border bg-muted/30 p-3"}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="break-all font-mono text-sm font-medium">{packageName}</p>{info && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{info.description}</p>}</div>{!lookupMode && <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={() => setPackageName("")}>收起</Button>}</div>
      {loading && <p role="status" className="flex items-center gap-2 text-xs"><LoaderCircle className="size-3 animate-spin" />读取版本列表…</p>}
      {error && <div role="alert" className="flex items-start justify-between gap-2 text-xs text-destructive"><p className="min-w-0 break-words leading-5">{error}</p><Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={() => { packageCache.delete(packageName); setRetry(count => count + 1) }}>重试</Button></div>}
      {info && <div key={info.name} className="admin-version-details space-y-3"><p className="break-words text-xs leading-5 text-muted-foreground">最新版本 {info.tags.latest || "未提供"} · {info.versions.length} 个版本</p>{info.deprecated && <p className="break-words text-xs leading-5 text-amber-700 dark:text-amber-400">已弃用：{info.deprecated}</p>}<div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_130px]"><RegistryVersion value={version} onChange={setVersion} info={info} disabled={disabled} /><Select value={prefix} onValueChange={setPrefix} disabled={disabled}><SelectTrigger aria-label="版本范围" className="whitespace-nowrap text-xs"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="^">^ 兼容更新</SelectItem><SelectItem value="~">~ 补丁更新</SelectItem><SelectItem value="exact">锁定版本</SelectItem></SelectContent></Select></div><Button type="button" size="sm" disabled={disabled || !info.versions.includes(version)} onClick={() => { update(packageName, `${prefix === "exact" ? "" : prefix}${version}`); if (lookupName) setLookupName("") }}><Plus />{existing ? "应用到此依赖" : "添加到当前类型"}</Button></div>}
    </div>
  return <fieldset disabled={disabled} className="min-w-0 space-y-4">
    <Tabs value={group} onValueChange={next => { setGroup(next); if (lookupName) { setLookupName(""); setPackageName("") } }}><TabsList aria-label="依赖类型" className="grid w-full grid-cols-4">{groups.map(item => <TabsTrigger key={item.key} value={item.key} className="min-w-0 gap-1.5 px-1 text-xs" disabled={disabled}>{item.label}<span className="tabular-nums text-[10px] opacity-70">{Object.keys(value[item.key] || {}).length}</span></TabsTrigger>)}</TabsList></Tabs>
    <div className="space-y-2"><Label htmlFor="dependency-search">从 npmmirror 添加依赖</Label><div className="relative"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input id="dependency-search" aria-label="搜索 npm 包" placeholder="输入包名，如 lodash 或 @radix-ui/react-select" className="pl-9" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); setLookupMode(false); setLookupName(""); setPackageName(query.trim()); setRetry(count => count + 1) } }} /></div>
      {searching && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />正在查询镜像…</p>}
      {searchError && <p role="alert" className="text-xs text-destructive">{searchError}</p>}
      {query.trim().length >= 2 && !searching && !searchError && !results.length && <p className="text-xs text-muted-foreground">没有搜索结果，按回车可查询完整包名。</p>}
      {!!results.length && <Command shouldFilter={false} className="rounded-md border"><CommandList className="max-h-40">{results.map(result => <CommandItem key={result.name} value={result.name} onSelect={() => { setLookupMode(false); setLookupName(""); setPackageName(result.name); setRetry(count => count + 1) }} disabled={disabled}><div className="min-w-0"><div className="break-all font-mono text-xs">{result.name}<span className="ml-2 text-muted-foreground">{result.version}</span></div><p className="truncate text-xs text-muted-foreground">{result.description}</p></div></CommandItem>)}</CommandList></Command>}
    </div>
    {packageName && !lookupMode && packagePanel}
    <div className="max-h-[36vh] min-w-0 space-y-2 overflow-y-auto overscroll-contain pr-1">{Object.entries(value[group] || {}).map(([name, range]) => <div key={name} className="rounded-lg border p-3"><div className="flex min-w-0 items-center justify-between gap-2"><Label htmlFor={`dependency-${group}-${name}`} className="min-w-0 break-all font-mono text-xs">{name}</Label><Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`删除依赖 ${name}`} disabled={disabled} onClick={() => remove(name)}><Trash2 className="size-3.5" /></Button></div><div className="mt-2 flex min-w-0 items-center gap-2"><Input id={`dependency-${group}-${name}`} aria-label={`${name} 版本范围`} value={range} required className="min-w-0 font-mono text-xs" onChange={event => update(name, event.target.value)} /><Popover open={lookupName === name} onOpenChange={open => { if (open) { setLookupMode(true); setLookupName(name); setPackageName(name); setPrefix(range.startsWith("~") ? "~" : range.startsWith("^") ? "^" : "exact"); setRetry(count => count + 1) } else if (lookupName === name) { setLookupName("") } }}><PopoverTrigger asChild><Button type="button" variant="outline" size="sm" className="h-10 shrink-0" disabled={disabled} aria-label={`查版本 ${name}`}>查版本</Button></PopoverTrigger><PopoverContent side="top" align="end" sideOffset={8} collisionPadding={16} className="z-[80] w-96 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto" aria-label={`${name} 版本查询`}>{packageName === name && packagePanel}</PopoverContent></Popover></div></div>)}{!Object.keys(value[group] || {}).length && <p className="py-4 text-center text-xs text-muted-foreground">当前类型没有依赖，可从镜像搜索添加。</p>}</div>
  </fieldset>
}
