import { getCapApiEndpoint, getCapSiteverifyEndpoint } from "../lib/cap-config.js"

const CAP_VERIFY_TIMEOUT_MS = 5000

function unavailable(reason = "service-unavailable") {
  return { success: false, status: 503, error: "人机验证服务暂时不可用，请稍后重试", reason }
}

export async function verifyCapToken(token, {
  secret = process.env.CAP_SECRET_KEY,
  apiEndpoint = getCapApiEndpoint(),
  fetchImpl = globalThis.fetch,
  timeoutMs = CAP_VERIFY_TIMEOUT_MS,
} = {}) {
  if (typeof token !== "string" || !token.trim()) {
    return { success: false, status: 400, error: "请先完成人机验证", reason: "missing-token" }
  }
  if (typeof secret !== "string" || !secret.trim()) {
    return unavailable("missing-secret")
  }
  const siteverifyEndpoint = getCapSiteverifyEndpoint(apiEndpoint)
  if (!siteverifyEndpoint) return unavailable("missing-endpoint")
  if (typeof fetchImpl !== "function") return unavailable("network-error")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(siteverifyEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: secret.trim(), response: token.trim() }),
      signal: controller.signal,
    })
    if (!response?.ok) return unavailable("upstream-error")

    const result = await response.json()
    if (typeof result?.success !== "boolean") return unavailable("invalid-response")
    if (result.success) return { success: true }

    const expired = /expir/i.test(String(result.error || ""))
    return {
      success: false,
      status: 400,
      error: expired ? "安全验证已过期，请重新验证" : "安全验证未通过，请重新验证",
      reason: expired ? "expired-token" : "invalid-token",
    }
  } catch {
    return unavailable("network-error")
  } finally {
    clearTimeout(timeout)
  }
}