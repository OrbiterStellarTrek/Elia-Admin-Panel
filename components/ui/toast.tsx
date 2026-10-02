"use client"

import { useEffect, useRef, type HTMLAttributes } from "react"
import { cn } from "@/lib/utils"

// Animation events handle normal exits; the timer also covers disabled or interrupted motion.
export function Toast({ exiting = false, onExited, onAnimationEnd, className, children, ...props }: HTMLAttributes<HTMLDivElement> & { exiting?: boolean; onExited: () => void }) {
  const element = useRef<HTMLDivElement>(null)
  const completed = useRef(false)
  const exitCallback = useRef(onExited)
  useEffect(() => { exitCallback.current = onExited }, [onExited])
  useEffect(() => {
    completed.current = false
    if (!exiting || !element.current) return
    const style = window.getComputedStyle(element.current)
    const milliseconds = (value: string) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000) || 0
    const names = style.animationName.split(",").map(value => value.trim())
    const durations = style.animationDuration.split(",").map(milliseconds)
    const delays = style.animationDelay.split(",").map(milliseconds)
    const index = names.indexOf("admin-toast-out")
    const duration = index < 0 ? 0 : Math.max(0, durations[index % durations.length] + delays[index % delays.length])
    const timer = window.setTimeout(() => {
      if (completed.current) return
      completed.current = true
      exitCallback.current()
    }, duration > 0 ? duration + 50 : 0)
    return () => window.clearTimeout(timer)
  }, [exiting])

  return <div
    ref={element}
    role="status"
    aria-atomic="true"
    {...props}
    className={cn("admin-toast pointer-events-auto w-fit max-w-full", exiting && "admin-toast-out", className)}
    onAnimationEnd={event => {
      onAnimationEnd?.(event)
      if (event.target === event.currentTarget && event.animationName === "admin-toast-out" && exiting && !completed.current) {
        completed.current = true
        exitCallback.current()
      }
    }}
  >{children}</div>
}
