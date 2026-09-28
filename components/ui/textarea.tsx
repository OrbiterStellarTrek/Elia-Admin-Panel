import * as React from "react"
import { cn } from "@/lib/utils"

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn("flex min-h-24 w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-500 disabled:placeholder:text-slate-400 disabled:shadow-none disabled:opacity-100 focus-visible:ring-2 focus-visible:ring-ring", className)} {...props} />
  ),
)
Textarea.displayName = "Textarea"
