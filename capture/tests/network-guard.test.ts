import { test } from "node:test"
import assert from "node:assert/strict"
import { assertPublicUrl, isPrivateHostLiteral, isPrivateIp, PrivateAddressError } from "../src/network-guard"

test("private, loopback and link-local addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"])
    assert.equal(isPrivateIp(ip), true, ip)
  for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111", "192.169.0.1"]) assert.equal(isPrivateIp(ip), false, ip)
  for (const host of ["localhost", "app.localhost", "printer.local", "router", "[::1]", "metadata.google.internal"]) assert.equal(isPrivateHostLiteral(host), true, host)
  for (const host of ["example.com", "linear.app", "8.8.8.8"]) assert.equal(isPrivateHostLiteral(host), false, host)
})

test("private start URLs fail with instructions unless allowed", async () => {
  delete process.env.ALLOW_PRIVATE_URLS
  await assert.rejects(assertPublicUrl("http://127.0.0.1:3000/"), PrivateAddressError)
  await assert.rejects(assertPublicUrl("http://localhost:5173/"), /ALLOW_PRIVATE_URLS=true/)
  process.env.ALLOW_PRIVATE_URLS = "true"
  try {
    await assertPublicUrl("http://127.0.0.1:3000/")
  } finally {
    delete process.env.ALLOW_PRIVATE_URLS
  }
})
