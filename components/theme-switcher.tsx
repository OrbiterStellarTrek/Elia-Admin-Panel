"use client"

import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme, type ThemeMode } from "@/components/theme-provider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

const modes = [
  { value: "light", label: "浅色模式", icon: Sun },
  { value: "dark", label: "深色模式", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
] as const

export function ThemeSwitcher({ compact = false, sidebar = false, className }: { compact?: boolean; sidebar?: boolean; className?: string }) {
  const { theme, setTheme } = useTheme()
  const current = modes.find(mode => mode.value === theme)!
  const Icon = current.icon
  return <Select value={theme} onValueChange={value => setTheme(value as ThemeMode)}>
    <SelectTrigger aria-label="颜色模式" title={`颜色模式：${current.label}`} className={cn("text-foreground", sidebar && "rounded-lg border-0 bg-transparent shadow-none hover:bg-sidebar-accent text-sidebar-foreground", compact && "justify-center px-0 [&>svg]:hidden", className)}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Icon className={cn("size-4 shrink-0", compact && "mx-auto")} aria-hidden="true" />
        <span className={compact ? "sr-only" : "min-w-0 flex-1 text-left text-xs"}><SelectValue>{current.label}</SelectValue></span>
      </span>
    </SelectTrigger>
    <SelectContent side="top" align="start" sideOffset={6} className="min-w-40">
      {modes.map(({ value, label, icon: ModeIcon }) => <SelectItem key={value} value={value} textValue={label}>
        <span className="flex items-center gap-2"><ModeIcon className="size-4 shrink-0" aria-hidden="true" />{label}</span>
      </SelectItem>)}
    </SelectContent>
  </Select>
}
