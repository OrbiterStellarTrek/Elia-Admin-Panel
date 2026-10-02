import * as React from "react"
import { cn } from "@/lib/utils"

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => (
    <input ref={ref} type={type} className={cn("h-10 min-w-0 w-full rounded-md border border-input bg-card px-3 text-sm shadow-xs outline-none transition placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:placeholder:text-muted-foreground disabled:shadow-none disabled:opacity-100 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20", className)} {...props} />
  ),
)
Input.displayName = "Input"
