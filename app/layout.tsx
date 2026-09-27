import type { Metadata } from "next"
import type React from "react"
import "./globals.css"

export const metadata: Metadata = {
  title: "EliaAdminPanel · 管理面板",
  description: "独立的 Yunzai WebUI 管理控制台",
  icons: { icon: "/elia.png", apple: "/elia.png" },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>
}
