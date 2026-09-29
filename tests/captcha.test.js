import test from "node:test"
import assert from "node:assert/strict"
import { getCapApiEndpoint, getCapSiteverifyEndpoint } from "../lib/cap-config.js"
import { verifyCapToken } from "../src/captcha.js"

const secret = "sk-test-secret"
const capServerUrl = "https://captcha.example.test"
const capSiteKey = "fixture-site-key"
const apiEndpoint = getCapApiEndpoint({ capServerUrl, capSiteKey }, {})
const siteverifyEndpoint = getCapSiteverifyEndpoint(apiEndpoint)
const jsonResponse = body => ({ ok: true, json: async () => body })

test("Cap endpoint is derived from configuration or environment and validates HTTPS", () => {
  assert.equal(apiEndpoint, "https://captcha.example.test/fixture-site-key/")
  assert.equal(siteverifyEndpoint, "https://captcha.example.test/fixture-site-key/siteverify")
  assert.equal(getCapApiEndpoint({}, { CAP_SERVER_URL: capServerUrl, CAP_SITE_KEY: capSiteKey }), apiEndpoint)
  assert.equal(getCapApiEndpoint({ capServerUrl, capSiteKey: "../bad" }, {}), "")
  assert.equal(getCapApiEndpoint({ capServerUrl: "http://captcha.example.test", capSiteKey }, {}), "")
  assert.equal(getCapApiEndpoint({ capServerUrl: `${capServerUrl}/proxy`, capSiteKey }, {}), "")
  assert.equal(getCapSiteverifyEndpoint(""), "")
})

test("Cap accepts a valid token using the configured endpoint and server secret", async () => {
  let request
  const result = await verifyCapToken("valid-token", {
    secret,
    apiEndpoint,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return jsonResponse({ success: true })
    },
  })

  assert.deepEqual(result, { success: true })
  assert.equal(request.url, siteverifyEndpoint)
  assert.equal(request.options.method, "POST")
  assert.deepEqual(JSON.parse(request.options.body), { secret, response: "valid-token" })
})

test("Cap rejects a missing token without contacting the service", async () => {
  let called = false
  const result = await verifyCapToken(" ", { secret, fetchImpl: async () => { called = true } })

  assert.equal(result.status, 400)
  assert.equal(result.reason, "missing-token")
  assert.equal(called, false)
})

test("Cap rejects invalid and expired tokens with retryable client errors", async () => {
  const verify = error => verifyCapToken("token", {
    secret,
    apiEndpoint,
    fetchImpl: async () => jsonResponse({ success: false, error }),
  })
  const invalid = await verify("invalid token")
  const expired = await verify("token expired")

  assert.equal(invalid.status, 400)
  assert.equal(invalid.reason, "invalid-token")
  assert.equal(expired.status, 400)
  assert.equal(expired.reason, "expired-token")
})

test("Cap fails closed when the secret is missing or verification is unavailable", async () => {
  const missingSecret = await verifyCapToken("token", { secret: "", fetchImpl: async () => jsonResponse({ success: true }) })
  const missingEndpoint = await verifyCapToken("token", { secret, apiEndpoint: "", fetchImpl: async () => jsonResponse({ success: true }) })
  const networkFailure = await verifyCapToken("token", { secret, apiEndpoint, fetchImpl: async () => { throw new Error("offline") } })

  assert.equal(missingSecret.status, 503)
  assert.equal(missingSecret.reason, "missing-secret")
  assert.equal(missingEndpoint.status, 503)
  assert.equal(missingEndpoint.reason, "missing-endpoint")
  assert.equal(networkFailure.status, 503)
  assert.equal(networkFailure.reason, "network-error")
})