"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "@/components/theme-provider"
import * as monaco from "monaco-editor"
import "monaco-editor/language/css/monaco.contribution.js"
import "monaco-editor/language/html/monaco.contribution.js"
import "monaco-editor/language/json/monaco.contribution.js"
import "monaco-editor/language/typescript/monaco.contribution.js"

export function editorLanguageForPath(path: string) {
  if (path.toLowerCase().endsWith(".js.disable")) return "javascript"
  const extension = path.split(".").pop()?.toLowerCase()
  if (["yml", "yaml"].includes(extension || "")) return "yaml"
  if (extension === "json" || extension === "jsonc") return "json"
  if (["js", "mjs", "cjs", "jsx"].includes(extension || "")) return "javascript"
  if (["ts", "mts", "cts", "tsx"].includes(extension || "")) return "typescript"
  if (["md", "mdx"].includes(extension || "")) return "markdown"
  if (["html", "htm", "xml", "svg"].includes(extension || "")) return "html"
  if (["css", "scss", "less"].includes(extension || "")) return "css"
  if (["sh", "bash", "zsh"].includes(extension || "")) return "shell"
  if (["ps1", "psm1", "psd1"].includes(extension || "")) return "powershell"
  if (extension === "sql") return "sql"
  if (extension === "ini" || extension === "conf") return "ini"
  return "plaintext"
}

export function MonacoCodeEditor({
  path,
  value,
  onChange,
  readOnly = false,
  className,
}: {
  path: string
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const language = editorLanguageForPath(path)
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const model = monaco.editor.createModel(
      value,
      language,
      monaco.Uri.parse(`inmemory://elia-admin-panel/${encodeURIComponent(path)}`),
    )
    const editor = monaco.editor.create(host, {
      model,
      automaticLayout: true,
      readOnly,
      ariaLabel: `${path} 文件内容编辑器`,
      fontSize: 13,
      lineHeight: 22,
      minimap: { enabled: true, autohide: "mouseover" },
      padding: { top: 14, bottom: 14 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      wordWrap: "on",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      renderLineHighlight: "line",
      theme: document.documentElement.classList.contains("dark") ? "vs-dark" : "vs",
    })
    editorRef.current = editor
    const changeSubscription = model.onDidChangeContent(() => onChange(model.getValue()))

    return () => {
      changeSubscription.dispose()
      editorRef.current = null
      editor.dispose()
      model.dispose()
    }
    // A new file receives its own model and undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, language])

  useEffect(() => {
    monaco.editor.setTheme(resolvedTheme === "dark" ? "vs-dark" : "vs")
  }, [resolvedTheme])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly })
  }, [readOnly])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (model && model.getValue() !== value) model.setValue(value)
  }, [value])

  return <div ref={hostRef} className={className || "min-h-[545px] flex-1"} />
}
