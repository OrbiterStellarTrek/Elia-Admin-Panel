import * as React from "react"
import { cn } from "@/lib/utils"

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input ref={ref} type={type} className={cn("h-10 w-full rounded-xl border border-input bg-background px-3 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-500 disabled:placeholder:text-slate-400 disabled:shadow-none disabled:opacity-100 focus-visible:ring-2 focus-visible:ring-ring", className)} {...props} />
  ),
)
Input.displayName = "Input"
