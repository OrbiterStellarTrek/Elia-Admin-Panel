"use client"

import { useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export function EditableCombobox({ id, label, value, onValueChange, options, placeholder, required }: {
  id: string; label: string; value: string; onValueChange: (value: string) => void
  options: { value: string; label: string }[]; placeholder?: string; required?: boolean
}) {
  const [open, setOpen] = useState(false)
  return <div className="flex gap-2">
    <Input id={id} aria-label={label} value={value} onChange={event => onValueChange(event.target.value)} placeholder={placeholder} required={required} />
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" variant="outline" size="icon" aria-label={`选择${label}`}><ChevronsUpDown /></Button></PopoverTrigger>
      <PopoverContent align="end" className="z-[80] w-80 max-w-[calc(100vw-2rem)] p-0">
        <Command><CommandInput aria-label={`搜索${label}`} placeholder="搜索候选项…" /><CommandList>
          <CommandEmpty>没有匹配项，可在输入框手动填写。</CommandEmpty>
          {options.map(option => <CommandItem key={option.value} value={`${option.value} ${option.label}`} onSelect={() => { onValueChange(option.value); setOpen(false) }}>
            <Check className={value === option.value ? "opacity-100" : "opacity-0"} /><span className="min-w-0 break-all">{option.label}</span>
          </CommandItem>)}
        </CommandList></Command>
      </PopoverContent>
    </Popover>
  </div>
}
