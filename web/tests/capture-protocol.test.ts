import { test } from "node:test"
import assert from "node:assert/strict"
import { app } from "../worker/app"

// The Worker's answer to an agent on another capture protocol: 426, which side is out of date, and the protocol it expects.

const env = { CAPTURE_TOKEN: "test-token" } as unknown as Env
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
const agent = (protocol: string | null, path = "/jobs/claim", method = "POST") =>
  app.request(`http://localhost/agent${path}`, { method, headers: { authorization: "Bearer test-token", ...(protocol === null ? {} : { "x-snip-capture-protocol": protocol }) } }, env, ctx)

test("an agent older than the Worker is refused with the protocol the Worker expects, and told to update the Snip app", async () => {
  for (const protocol of ["3", "2", null, "", "four"]) {
    const response = await agent(protocol)
    assert.equal(response.status, 426, `protocol ${JSON.stringify(protocol)}`)
    const body = await response.json() as { error: string; expectedProtocol: number }
    assert.equal(body.expectedProtocol, 4)
    assert.match(body.error, /older than your cloud library.*Update the Snip app/)
  }
})

test("an agent newer than the Worker is told the cloud library needs updating", async () => {
  for (const protocol of ["5", "6", "12"]) {
    const response = await agent(protocol)
    assert.equal(response.status, 426, `protocol ${protocol}`)
    const body = await response.json() as { error: string; expectedProtocol: number }
    assert.equal(body.expectedProtocol, 4)
    assert.match(body.error, /cloud library is older than this Snip.*npm run update/)
  }
})

test("the gate covers every agent route, and an agent on the Worker's protocol passes it", async () => {
  for (const [path, method] of [["/jobs/claim", "POST"], ["/heartbeat", "POST"], ["/files/no-write", "PUT"], ["/ping", "GET"]] as const) {
    assert.equal((await agent("3", path, method)).status, 426, path)
    assert.equal((await agent("5", path, method)).status, 426, path)
  }
  assert.equal((await agent("4", "/ping", "GET")).status, 200)
})
