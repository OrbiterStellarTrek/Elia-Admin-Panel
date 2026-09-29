"use client"

import { useEffect, useState, type ReactNode } from "react"

// Keep closing surfaces mounted long enough for their CSS exit animation.
// Open surfaces render immediately; effect cleanup also handles rapid toggles.
export function useExitPresence(open: boolean) {
  const [present, setPresent] = useState(open)
  useEffect(() => {
    if (open) {
      setPresent(true)
      return
    }
    const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160
    const timer = window.setTimeout(() => setPresent(false), delay)
    return () => window.clearTimeout(timer)
  }, [open])
  return open || present
}

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return <div className="admin-collapse" data-open={open} inert={!open} aria-hidden={!open}>
    <div className="admin-collapse-inner">{children}</div>
  </div>
}
