const SITE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function getCapApiEndpoint(config = {}, env = process.env) {
	const configuredServer = typeof config.capServerUrl === "string" ? config.capServerUrl.trim() : ""
	const configuredSiteKey = typeof config.capSiteKey === "string" ? config.capSiteKey.trim() : ""
	const serverUrl = configuredServer || String(env.CAP_SERVER_URL || "").trim()
	const siteKey = configuredSiteKey || String(env.CAP_SITE_KEY || "").trim()
	if (!serverUrl || !SITE_KEY_PATTERN.test(siteKey)) return ""

	try {
		const server = new URL(serverUrl)
		if (server.protocol !== "https:" || server.username || server.password || server.pathname !== "/" || server.search || server.hash) return ""
		return new URL(`${encodeURIComponent(siteKey)}/`, server.origin).toString()
	} catch {
		return ""
	}
}

export function getCapSiteverifyEndpoint(apiEndpoint) {
	if (typeof apiEndpoint !== "string" || !apiEndpoint.trim()) return ""
	try {
		const endpoint = new URL(apiEndpoint)
		if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || !endpoint.pathname.endsWith("/") || endpoint.search || endpoint.hash) return ""
		return new URL("siteverify", endpoint).toString()
	} catch {
		return ""
	}
}