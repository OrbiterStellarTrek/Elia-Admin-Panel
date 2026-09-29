"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { themeStorageKey as storageKey } from "@/lib/theme"

export type ThemeMode = "light" | "dark" | "system"
const isTheme = (value: string | null): value is ThemeMode => value === "light" || value === "dark" || value === "system"

const ThemeContext = createContext<{
  theme: ThemeMode
  resolvedTheme: "light" | "dark"
  setTheme: (theme: ThemeMode) => void
}>({ theme: "system", resolvedTheme: "light", setTheme: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<ThemeMode>("system")
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light")
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (isTheme(saved)) updateTheme(saved)
    } catch { /* Storage can be unavailable; theme switching still works. */ }
    setReady(true)
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) updateTheme(isTheme(event.newValue) ? event.newValue : "system")
    }
    window.addEventListener("storage", sync)
    return () => window.removeEventListener("storage", sync)
  }, [])

  useEffect(() => {
    if (!ready) return
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches)
      document.documentElement.classList.toggle("dark", dark)
      setResolvedTheme(dark ? "dark" : "light")
    }
    apply()
    media.addEventListener("change", apply)
    return () => media.removeEventListener("change", apply)
  }, [theme, ready])

  function setTheme(next: ThemeMode) {
    updateTheme(next)
    try { localStorage.setItem(storageKey, next) } catch { /* Keep the in-memory choice. */ }
  }

  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() { return useContext(ThemeContext) }
