import { supportPanel } from "./elia.support.js"

// Guoba 继续使用自己的入口，面板原生配置定义统一维护在 elia.support.js。
export async function supportGuoba() {
  const support = await supportPanel()
  support.pluginInfo = { ...support.pluginInfo, isV3: true, isV2: false, showInMenu: true }
  return support
}
