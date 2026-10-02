"use client"

import { useState } from "react"
import { CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

export function FieldHelp({ label, message }: { label: string; message: string }) {
  const [open, setOpen] = useState(false)
  return <TooltipProvider delayDuration={180}><Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label={`${label}说明`} className="size-5 shrink-0 self-center p-0 text-muted-foreground [&_svg]:size-3.5" onClick={() => setOpen(value => !value)}><CircleHelp /></Button></TooltipTrigger>
    <TooltipContent side="top" className="z-[100] max-w-[min(320px,calc(100vw-32px))] whitespace-pre-wrap break-words text-xs leading-5">{message}</TooltipContent>
  </Tooltip></TooltipProvider>
}
