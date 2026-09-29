import type { Metadata } from "next"
import type React from "react"
import { ThemeProvider } from "@/components/theme-provider"
import { themeScript } from "@/lib/theme"
import "./globals.css"
import "monaco-editor/min/vs/editor/editor.main.css"
import "react-easy-crop/react-easy-crop.css"

export const metadata: Metadata = {
  title: "EliaAdminPanel · 管理面板",
  description: "独立的 Yunzai WebUI 管理控制台",
  applicationName: "EliaAdminPanel",
  icons: { icon: "/elia.png", apple: "/elia.png" },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head><body><ThemeProvider>{children}</ThemeProvider></body></html>
}
