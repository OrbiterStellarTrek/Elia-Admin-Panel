"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export function SchemaOptions({ component, props, value, label, onChange, compact = false }: { component: string; props: any; value: any; label: string; onChange: (value: any) => void; compact?: boolean }) {
  const [draft, setDraft] = useState("")
  const multiple = component === "CheckboxGroup" || props.mode === "multiple" || props.mode === "tags" || props.multiple === true
  const selected = multiple ? (Array.isArray(value) ? value : value == null ? [] : [value]) : [value]
  const options = (Array.isArray(props.options) ? props.options : []).flatMap((option: any) => {
    if (option && typeof option === "object") return [{ value: option.value, label: option.label ?? option.title ?? String(option.value ?? ""), disabled: option.disabled }]
    return [{ value: option, label: String(option), disabled: false }]
  }).filter((option: any) => option.value !== undefined && option.value !== null)
  for (const item of selected) if (item != null && !options.some((option: any) => option.value === item)) options.push({ value: item, label: String(item), disabled: false })
  function toggle(item: any) {
    if (multiple) onChange(selected.includes(item) ? selected.filter((value: any) => value !== item) : [...selected, item])
    else onChange(item)
  }
  const selectedIndex = options.findIndex((option: any) => option.value === value)
  if ((component === "Select" || component === "RadioGroup") && !multiple) return <div className="space-y-2">
    <Select disabled={props.disabled} value={selectedIndex >= 0 ? String(selectedIndex) : undefined} onValueChange={index => { const option = options[Number(index)]; if (option) onChange(option.value) }}>
      <SelectTrigger aria-label={label} className={compact ? "h-9" : undefined}><SelectValue placeholder={props.placeholder || "请选择"} /></SelectTrigger>
      <SelectContent>{options.map((option: any, index: number) => <SelectItem key={`${typeof option.value}:${String(option.value)}:${index}`} value={String(index)} disabled={option.disabled}>{option.label || String(option.value)}</SelectItem>)}</SelectContent>
    </Select>
    {props.allowClear && selectedIndex >= 0 && <Button type="button" size="sm" variant="ghost" disabled={props.disabled} onClick={() => onChange(undefined)}>清空</Button>}
  </div>
  return <div className="space-y-2">
    <div role="group" aria-label={label} className={`flex flex-wrap ${compact ? "gap-1.5" : "gap-2"}`}>{options.map((option: any) => <button key={`${typeof option.value}:${String(option.value)}`} type="button" aria-pressed={selected.includes(option.value)} disabled={props.disabled || option.disabled} onClick={() => toggle(option.value)} className={`admin-choice rounded-lg border ${compact ? "px-2 py-1.5 !text-xs" : "px-3 py-2 text-xs"} transition disabled:opacity-50 ${selected.includes(option.value) ? "border-border bg-accent font-medium text-foreground" : "border-border bg-card text-foreground hover:bg-muted"}`}>{option.label || String(option.value)}</button>)}</div>
    {props.mode === "tags" && <div className="flex gap-2"><Input aria-label={`${label}，自定义项`} value={draft} placeholder="输入自定义项" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); const item = draft.trim(); if (item && !selected.includes(item)) onChange([...selected, item]); setDraft("") } }} /><Button type="button" variant="outline" disabled={!draft.trim() || props.disabled} onClick={() => { const item = draft.trim(); if (item && !selected.includes(item)) onChange([...selected, item]); setDraft("") }}>添加</Button></div>}
    {props.allowClear && selected.some((item: any) => item != null) && <Button type="button" size="sm" variant="ghost" disabled={props.disabled} onClick={() => onChange(multiple ? [] : undefined)}>清空</Button>}
  </div>
}
