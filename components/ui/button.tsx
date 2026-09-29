import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "admin-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(30,27,75,0.2),0_8px_18px_-8px_rgba(89,82,212,0.55)] hover:bg-primary/90 hover:-translate-y-px hover:shadow-[0_2px_4px_rgba(30,27,75,0.16),0_12px_24px_-8px_rgba(89,82,212,0.6)] active:translate-y-0 active:shadow-sm",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/75",
        outline: "border border-border bg-background hover:bg-muted",
        ghost: "hover:bg-muted text-foreground",
        destructive: "bg-destructive text-white shadow-[0_8px_18px_-8px_rgba(217,72,96,0.55)] hover:bg-destructive/90",
      },
      size: { default: "h-10 px-4", sm: "h-8 px-3 text-xs", lg: "h-11 px-5", icon: "size-10" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  ),
)
Button.displayName = "Button"
