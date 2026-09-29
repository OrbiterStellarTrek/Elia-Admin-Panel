"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CircleHelp } from "lucide-react"

export function FieldHelp({ label, message }: { label: string; message: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 16, top: 16, arrowLeft: 16, side: "above" })
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const clickWasOpen = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = () => { if (timer.current) clearTimeout(timer.current) }
  const close = () => { cancel(); timer.current = setTimeout(() => setOpen(false), 120) }
  const show = () => { cancel(); setOpen(true) }
  const place = useCallback(() => {
    if (!trigger.current || !content.current) return
    const anchor = trigger.current.getBoundingClientRect()
    const box = content.current.getBoundingClientRect()
    const width = document.documentElement.clientWidth
    const height = window.innerHeight
    const left = Math.max(16, Math.min(anchor.left + anchor.width / 2 - box.width / 2, width - box.width - 16))
    const above = anchor.top - box.height - 8
    const side = above >= 16 ? "above" : "below"
    const preferredTop = side === "above" ? above : anchor.bottom + 8
    const arrowLeft = Math.max(12, Math.min(anchor.left + anchor.width / 2 - left, box.width - 12))
    setPosition({ left, top: Math.max(16, Math.min(preferredTop, height - box.height - 16)), arrowLeft, side })
  }, [])
  useLayoutEffect(() => { if (open) place() }, [open, message, place])
  useEffect(() => () => cancel(), [])
  useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { cancel(); setOpen(false) } }
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !content.current?.contains(event.target as Node)) setOpen(false)
    }
    const observer = new ResizeObserver(place)
    if (content.current) observer.observe(content.current)
    document.addEventListener("keydown", escape)
    document.addEventListener("pointerdown", outside)
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      observer.disconnect()
      document.removeEventListener("keydown", escape)
      document.removeEventListener("pointerdown", outside)
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [open, place])
  return <>
    <button ref={trigger} type="button" aria-label={`${label}说明`} aria-describedby={open ? id : undefined}
      className="relative -top-1 inline-grid size-4 shrink-0 self-start place-items-center rounded text-neutral-400 transition-colors before:absolute before:-inset-1 before:content-[''] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onPointerEnter={event => { if (event.pointerType !== "touch") { cancel(); timer.current = setTimeout(() => setOpen(true), 180) } }}
      onPointerDown={() => { clickWasOpen.current = open }} onPointerLeave={close} onFocus={show} onBlur={close}
      onClick={event => { cancel(); if (event.detail === 0) show(); else setOpen(!clickWasOpen.current) }}
    ><CircleHelp className="size-3" /></button>
    {open && createPortal(<div ref={content} id={id} role="tooltip"
      className="admin-field-tooltip fixed z-[100] w-max max-w-[min(320px,calc(100vw-32px))] rounded-lg text-xs leading-5 text-neutral-100 shadow-lg"
      style={{ left: position.left, top: position.top }} onPointerEnter={cancel} onPointerLeave={close}
    >
      <div className="relative z-10 max-h-[calc(100dvh-32px)] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 [overflow-wrap:anywhere]">{message}</div>
      <span aria-hidden="true" data-tooltip-arrow={position.side}
        className={`pointer-events-none absolute z-20 size-2 -translate-x-1/2 rotate-45 bg-neutral-900 ${position.side === "above" ? "-bottom-1 border-b border-r border-neutral-700" : "-top-1 border-l border-t border-neutral-700"}`}
        style={{ left: position.arrowLeft }} />
    </div>, document.body)}
  </>
}
