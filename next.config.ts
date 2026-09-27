import type { NextConfig } from "next"
import path from "node:path"
import { createRequire } from "node:module"
import MonacoWebpackPlugin from "monaco-editor-webpack-plugin"

const require = createRequire(import.meta.url)
const monacoCssPath = path.join(path.dirname(require.resolve("monaco-editor")), "editor/editor.main.css")

const nextConfig: NextConfig = {
  output: "export",
  outputFileTracingRoot: process.cwd(),
  trailingSlash: true,
  images: { unoptimized: true },
  webpack(config, { isServer }) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "monaco-editor/min/vs/editor/editor.main.css": monacoCssPath,
    }
    if (!isServer) {
      config.plugins.push(new MonacoWebpackPlugin({
        languages: ["css", "html", "javascript", "json", "typescript", "yaml"],
        filename: "static/chunks/[name].worker.js",
      }))
    }
    return config
  },
}

export default nextConfig
