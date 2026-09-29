"use client"

import type { HTMLAttributes } from "react"
import { cn } from "@/lib/utils"

// The owner retains the message until the actual exit animation completes.
export function Toast({ exiting = false, onExited, className, children, ...props }: HTMLAttributes<HTMLDivElement> & { exiting?: boolean; onExited: () => void }) {
  return <div
    role="status"
    {...props}
    className={cn("admin-toast pointer-events-auto w-fit max-w-full", exiting && "admin-toast-out", className)}
    onAnimationEnd={event => {
      if (event.target === event.currentTarget && event.animationName === "admin-toast-out" && exiting) onExited()
    }}
  >{children}</div>
}
