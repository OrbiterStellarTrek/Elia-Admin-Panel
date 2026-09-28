// QQBot-Plugin passes its engine as account.adapter, with id === "QQBot".
export function isOfficialBot(account) {
  return String(account?.adapter?.id || account?.adapter || account?.version?.id || "").toLowerCase() === "qqbot"
}

export function pickNumericGroup(bot, id) {
  if (!/^\d+$/.test(String(id))) return undefined
  const cached = bot?.gl?.get?.(Number(id)) || bot?.gl?.get?.(String(id))
  const ownerId = cached?.bot_id ?? cached?.self_id
  const owner = ownerId == null ? null : bot?.[ownerId]
  if (isOfficialBot(owner) || isOfficialBot(bot)) return undefined
  const ids = [...new Set([...(Array.isArray(bot?.uin) ? bot.uin : []), ...Object.keys(bot || {}).filter(key => /^\d+$/.test(key))])]
  if (ids.length) {
    const accounts = ids.map(key => bot[key]).filter(Boolean)
    const numericAccount = accounts.find(account => !isOfficialBot(account) && (account.gl?.has?.(Number(id)) || account.gl?.has?.(String(id))))
    if (numericAccount) return numericAccount.pickGroup?.(Number(id))
    if (accounts.length && accounts.every(isOfficialBot)) return undefined
    // The aggregate picker may route to an official account and log an expected failure.
    if (accounts.some(isOfficialBot)) return undefined
  }
  return bot?.pickGroup?.(Number(id))
}

export function ffmpegPath(config) {
  return config?.bot?.ffmpeg_path || "ffmpeg"
}
