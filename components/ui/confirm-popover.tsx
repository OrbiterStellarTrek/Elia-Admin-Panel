"use client"

import { useId, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"

export function ConfirmPopover({ anchor, title, message, confirmLabel, onCancel, onConfirm }: {
  anchor: HTMLButtonElement; title: string; message: string; confirmLabel: string
  onCancel: () => void; onConfirm: () => void
}) {
  const id = useId()
  const cancel = useRef<HTMLButtonElement>(null)
  return <Popover open onOpenChange={open => { if (!open) onCancel() }}>
    <PopoverAnchor virtualRef={{ current: anchor }} />
    <PopoverContent side="top" sideOffset={10} className="z-[100] w-64 max-w-[calc(100vw-32px)] p-3.5" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`} onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus() }} onCloseAutoFocus={event => { event.preventDefault(); if (anchor.isConnected) anchor.focus() }}>
      <p id={`${id}-title`} className="text-xs font-semibold">{title}</p>
      <p id={`${id}-message`} className="mt-1.5 text-xs leading-5 text-muted-foreground">{message}</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button ref={cancel} type="button" size="sm" variant="ghost" onClick={onCancel}>取消</Button>
        <Button type="button" size="sm" onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </PopoverContent>
  </Popover>
}
