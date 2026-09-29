"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

export function ConfirmPopover({ anchor, title, message, confirmLabel, onCancel, onConfirm }: {
  anchor: HTMLButtonElement; title: string; message: string; confirmLabel: string
  onCancel: () => void; onConfirm: () => void
}) {
  const id = useId()
  const content = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState({ left: 16, top: 16, arrowLeft: 16, above: true })
  const place = useCallback(() => {
    if (!content.current) return
    const button = anchor.getBoundingClientRect()
    const box = content.current.getBoundingClientRect()
    const left = Math.max(16, Math.min(button.left + button.width / 2 - box.width / 2, document.documentElement.clientWidth - box.width - 16))
    const above = button.top - box.height - 10 >= 16
    const top = above ? button.top - box.height - 10 : button.bottom + 10
    setPosition({ left, top: Math.max(16, Math.min(top, window.innerHeight - box.height - 16)), above,
      arrowLeft: Math.max(12, Math.min(button.left + button.width / 2 - left, box.width - 12)) })
  }, [anchor])
  useLayoutEffect(place, [place])
  useEffect(() => {
    cancel.current?.focus({ preventScroll: true })
    return () => { if (anchor.isConnected) anchor.focus({ preventScroll: true }) }
  }, [anchor])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!content.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onCancel()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onCancel() } }
    const observer = new ResizeObserver(place)
    if (content.current) observer.observe(content.current)
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", escape)
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      observer.disconnect()
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", escape)
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [anchor, onCancel, place])
  return createPortal(<div ref={content} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}
    className="admin-field-tooltip fixed z-[100] w-64 max-w-[calc(100vw-32px)] rounded-xl bg-popover text-popover-foreground shadow-xl"
    style={{ left: position.left, top: position.top }}>
    <div className="relative z-10 max-h-[calc(100dvh-32px)] overflow-auto rounded-xl border border-border bg-popover p-3.5">
      <p id={`${id}-title`} className="text-xs font-semibold">{title}</p>
      <p id={`${id}-message`} className="mt-1.5 text-xs leading-5 text-muted-foreground">{message}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button ref={cancel} type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">取消</button>
        <button type="button" onClick={onConfirm} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{confirmLabel}</button>
      </div>
    </div>
    <span aria-hidden="true" className={`pointer-events-none absolute z-20 size-2 -translate-x-1/2 rotate-45 bg-popover ${position.above ? "-bottom-1 border-b border-r border-border" : "-top-1 border-l border-t border-border"}`} style={{ left: position.arrowLeft }} />
  </div>, document.body)
}
