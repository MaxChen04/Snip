import { test } from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { AGENT_OLDER_MESSAGE, CAPTURE_PROTOCOL, CAPTURE_PROTOCOL_HEADER, CLOUD_OLDER_MESSAGE, MISMATCH_MESSAGE } from "../shared/capture-protocol"
import * as agent from "../../capture/src/api"

// The agent, the doctor and the provisioning engine ship without web/shared, so each keeps its own copy of the protocol number and the
// agent of its messages. These tests keep every copy equal to web/shared/capture-protocol.ts, which the Worker and the app read.

test("the capture agent speaks, and words its refusals in, what the Worker and the app do", () => {
  assert.equal(agent.CAPTURE_PROTOCOL, CAPTURE_PROTOCOL)
  assert.equal(agent.CAPTURE_PROTOCOL_HEADER, CAPTURE_PROTOCOL_HEADER)
  assert.equal(agent.AGENT_OLDER_MESSAGE, AGENT_OLDER_MESSAGE)
  assert.equal(agent.CLOUD_OLDER_MESSAGE, CLOUD_OLDER_MESSAGE)
  assert.equal(agent.MISMATCH_MESSAGE, MISMATCH_MESSAGE)
})

test("the doctor and the provisioning engine send the protocol the Worker expects", async () => {
  for (const file of ["scripts/doctor.mjs", "desktop/provision/setup.cjs"]) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8")
    const sent = [...source.matchAll(/["']x-snip-capture-protocol["']\s*:\s*["'](\d+)["']/g)].map((m) => m[1])
    assert.ok(sent.length > 0, `${file} sends the header`)
    for (const protocol of sent) assert.equal(protocol, String(CAPTURE_PROTOCOL), file)
  }
})
