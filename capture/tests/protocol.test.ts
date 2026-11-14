import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { CaptureUpgradeError, SnipApi } from "../src/api"
import { CaptureRuntime, type CaptureStatus } from "../src/runtime"

// What a capture agent says when a Worker refuses its protocol with 426: which side is out of date.

/** A Worker that answers every agent call with `respond`, as the 426 gate in front of /agent does. */
async function worker(respond: (res: http.ServerResponse) => void, fn: (base: string) => Promise<void>) {
  const server = http.createServer((_req, res) => respond(res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
const reply = (status: number, body: string, type = "application/json") => (res: http.ServerResponse) => { res.writeHead(status, { "content-type": type }); res.end(body) }

/** The answer of Worker 1.4.0 (commit 20b4be6) to an agent on any protocol but 3: no version header, no protocol in the body, and no endpoint that tells a capture token more. */
const OLD_WORKER = reply(426, JSON.stringify({ error: "Capture agent upgrade required. Install the latest Snip capture agent." }))

const AGENT_OLDER = /older than your cloud library.*Update the Snip app/
const CLOUD_OLDER = /cloud library is older than this Snip.*npm run update/

const refusal = async (base: string) => {
  const error = await new SnipApi(base, "token").claim().then(() => null, (e: unknown) => e)
  assert.ok(error instanceof CaptureUpgradeError, `claim was refused with a CaptureUpgradeError, got ${String(error)}`)
  return error
}

test("a new agent refused by an old Worker, which says nothing of its protocol, says the cloud library needs updating", async () => {
  await worker(OLD_WORKER, async (base) => {
    const error = await refusal(base)
    assert.match(error.message, CLOUD_OLDER)
    assert.doesNotMatch(error.message, /Install the latest Snip capture agent/, "the old Worker's direction is not repeated")
  })
})

test("a Worker that names its protocol decides the direction: a newer one needs the Snip app updated, an older one the cloud library", async () => {
  await worker(reply(426, JSON.stringify({ error: "x", expectedProtocol: 5 })), async (base) => assert.match((await refusal(base)).message, AGENT_OLDER))
  await worker(reply(426, JSON.stringify({ error: "x", expectedProtocol: 3 })), async (base) => assert.match((await refusal(base)).message, CLOUD_OLDER))
})

test("a 426 that is not the Worker's JSON is not blamed on either side", async () => {
  await worker(reply(426, "<html>Upgrade Required</html>", "text/html"), async (base) => {
    const message = (await refusal(base)).message
    assert.doesNotMatch(message, /^Your cloud library is older/)
    assert.doesNotMatch(message, /^This capture agent is older/)
    assert.match(message, /Update the Snip app/)
    assert.match(message, /npm run update/)
  })
})

test("the runtime reports the direction as the agent's status and in its log, where `npm run capture` shows it", async () => {
  await worker(OLD_WORKER, async (base) => {
    const statuses: CaptureStatus[] = []
    const logged: string[] = []
    const runtime = new CaptureRuntime({
      api: new SnipApi(base, "token"), launch: async () => ({ isConnected: () => true, close: async () => {} }), capture: async () => {},
      status: (s) => statuses.push(s), pollMs: 5, idleMs: 50, once: true, logError: (m) => logged.push(m),
    })
    await runtime.run()
    assert.match(statuses.find((s) => s.state === "disconnected")?.error ?? "", CLOUD_OLDER)
    assert.ok(logged.some((m) => CLOUD_OLDER.test(m)), `logged: ${JSON.stringify(logged)}`)
  })
})
