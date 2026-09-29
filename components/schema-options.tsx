"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export function SchemaOptions({ component, props, value, label, onChange, compact = false }: { component: string; props: any; value: any; label: string; onChange: (value: any) => void; compact?: boolean }) {
  const [draft, setDraft] = useState("")
  const multiple = component === "CheckboxGroup" || props.mode === "multiple" || props.mode === "tags" || props.multiple === true
  const selected = multiple ? (Array.isArray(value) ? value : value == null ? [] : [value]) : [value]
  const options = (Array.isArray(props.options) ? props.options : []).flatMap((option: any) => {
    if (option && typeof option === "object") return [{ value: option.value, label: option.label ?? option.title ?? String(option.value ?? ""), disabled: option.disabled }]
    return [{ value: option, label: String(option), disabled: false }]
  }).filter((option: any) => option.value !== undefined && option.value !== null)
  for (const item of selected) if (item != null && !options.some((option: any) => option.value === item)) options.push({ value: item, label: String(item), disabled: false })
  const selectedIndex = options.findIndex((option: any) => option.value === value)
  if ((component === "Select" || component === "RadioGroup") && !multiple) return <div className="space-y-2">
    <Select disabled={props.disabled} value={selectedIndex >= 0 ? String(selectedIndex) : ""} onValueChange={index => { const option = options[Number(index)]; if (option) onChange(option.value) }}>
      <SelectTrigger aria-label={label} className={compact ? "h-9" : undefined}><SelectValue placeholder={props.placeholder || "请选择"} /></SelectTrigger>
      <SelectContent>{options.map((option: any, index: number) => <SelectItem key={`${typeof option.value}:${String(option.value)}:${index}`} value={String(index)} disabled={option.disabled}>{option.label || String(option.value)}</SelectItem>)}</SelectContent>
    </Select>
    {props.allowClear && selectedIndex >= 0 && <Button type="button" size="sm" variant="ghost" disabled={props.disabled} onClick={() => onChange(undefined)}>清空</Button>}
  </div>
  return <div className="space-y-2">
    <ToggleGroup {...(multiple ? { type: "multiple" as const, value: options.flatMap((option: any, index: number) => selected.includes(option.value) ? [String(index)] : []) } : { type: "single" as const, value: selectedIndex >= 0 ? String(selectedIndex) : "" })} aria-label={label} onValueChange={(indices: string[] | string) => { if (Array.isArray(indices)) onChange(indices.map(index => options[Number(index)].value)); else if (indices) onChange(options[Number(indices)].value) }} disabled={props.disabled} className={`flex flex-wrap justify-start ${compact ? "gap-1.5" : "gap-2"}`}>
      {options.map((option: any, index: number) => <ToggleGroupItem key={`${typeof option.value}:${String(option.value)}`} value={String(index)} disabled={option.disabled} variant="outline" size="sm" className={`${compact ? "h-auto px-2 py-1.5 !text-xs" : "h-auto px-3 py-2 text-xs"} border-input text-muted-foreground data-[state=off]:bg-muted/20 data-[state=off]:hover:bg-accent/60 data-[state=on]:!border-emerald-300 data-[state=on]:bg-emerald-700 data-[state=on]:text-white data-[state=on]:hover:bg-emerald-800`}>{option.label || String(option.value)}</ToggleGroupItem>)}
    </ToggleGroup>
    {props.mode === "tags" && <div className="flex gap-2"><Input aria-label={`${label}，自定义项`} value={draft} placeholder="输入自定义项" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); const item = draft.trim(); if (item && !selected.includes(item)) onChange([...selected, item]); setDraft("") } }} /><Button type="button" variant="outline" disabled={!draft.trim() || props.disabled} onClick={() => { const item = draft.trim(); if (item && !selected.includes(item)) onChange([...selected, item]); setDraft("") }}>添加</Button></div>}
    {props.allowClear && selected.some((item: any) => item != null) && <Button type="button" size="sm" variant="ghost" disabled={props.disabled} onClick={() => onChange(multiple ? [] : undefined)}>清空</Button>}
  </div>
}
