import * as React from "react"
import { cn } from "@/lib/utils"

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn("flex min-h-24 min-w-0 w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm leading-6 shadow-xs outline-none transition placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:placeholder:text-muted-foreground disabled:shadow-none disabled:opacity-100 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20", className)} {...props} />
  ),
)
Textarea.displayName = "Textarea"
