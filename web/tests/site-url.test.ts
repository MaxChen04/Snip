import { test } from "node:test"
import assert from "node:assert/strict"
import { checkSiteUrl, MAX_SITE_URL_LENGTH } from "../shared/site-url"

// The one rule for a web address. The Worker and the app both use it, so this table is the whole contract.

const accepted: [input: string, href: string][] = [
  ["example.com", "https://example.com/"],
  ["  Example.COM/Path?q=1#frag  ", "https://example.com/Path?q=1"],
  ["linear.app", "https://linear.app/"],
  ["http://upper.example.com", "http://upper.example.com/"],
  ["HTTPS://ANDO.SO", "https://ando.so/"],
  ["example.com:8080/x", "https://example.com:8080/x"],
  ["localhost", "https://localhost/"],
  ["localhost:3000", "https://localhost:3000/"],
  ["LOCALHOST:3000/app", "https://localhost:3000/app"],
  ["http://localhost:8787", "http://localhost:8787/"],
  ["127.0.0.1", "https://127.0.0.1/"],
  ["http://127.0.0.1:4173/", "http://127.0.0.1:4173/"],
  ["192.168.1.20", "https://192.168.1.20/"],
  ["http://2130706433/", "http://127.0.0.1/"],
  ["http://[::1]:5173/", "http://[::1]:5173/"],
  ["[2001:db8::1]", "https://[2001:db8::1]/"],
  ["https://[2001:db8::1]:8443/a?b=c", "https://[2001:db8::1]:8443/a?b=c"],
]

const refused: [input: string, says: string][] = [
  ["", "Enter a web address"],
  ["   ", "Enter a web address"],
  ["not a url", "A web address cannot contain spaces"],
  ["https://example.com/some path", "A web address cannot contain spaces"],
  ["https://exa mple.com", "A web address cannot contain spaces"],
  ["example.com\nstripe.com", "A web address cannot contain spaces"],
  ["https://", "That is not a valid web address"],
  ["https://exa[mple.com", "That is not a valid web address"],
  ["https://user:pw@example.com", "A web address cannot contain a username or password"],
  ["https://user@example.com/", "A web address cannot contain a username or password"],
  ["file:///etc/passwd", "Only http and https addresses can be captured"],
  ["ftp://example.com/file", "Only http and https addresses can be captured"],
  ["javascript:alert(1)", "Only http and https addresses can be captured"],
  ["mailto:someone@example.com", "Only http and https addresses can be captured"],
  ["data:text/html;base64,PGgxPmhpPC9oMT4=", "Only http and https addresses can be captured"],
  ["intranet", "A web address needs a host name, like example.com"],
  ["https://intranet/", "A web address needs a host name, like example.com"],
  ["intranet:3000", "A web address needs a host name, like example.com"],
  ["linear", "A web address needs a host name, like example.com"],
]

test("a web address is accepted as one normalised URL: https added only when there is no scheme, the fragment dropped", () => {
  for (const [input, href] of accepted) {
    const checked = checkSiteUrl(input)
    assert.ok("url" in checked, `${input}: ${"error" in checked ? checked.error : ""}`)
    assert.equal(checked.url.href, href, input)
  }
})

test("each refusal is its own sentence, and a refusal never carries a URL", () => {
  for (const [input, says] of refused) {
    const checked = checkSiteUrl(input)
    assert.deepEqual(checked, { error: says }, JSON.stringify(input))
    assert.doesNotMatch(says, /Invalid URL|is not a function|string did not match/i, "a sentence, not a parser error")
  }
})

test("a web address is at most 2,048 characters as typed, and too long has its own sentence", () => {
  assert.equal(MAX_SITE_URL_LENGTH, 2048)
  const pad = (head: string, length: number) => head + "a".repeat(length - head.length)
  for (const head of ["https://example.com/", "example.com/", "http://localhost:3000/", "http://[::1]/"]) {
    const ok = checkSiteUrl(pad(head, 2048))
    assert.ok("url" in ok, `${head}... at 2,048 characters is accepted`)
    assert.deepEqual(checkSiteUrl(pad(head, 2049)), { error: "That web address is too long." }, `${head}... at 2,049 characters is refused`)
  }
  assert.deepEqual(checkSiteUrl("https://example.com/" + "a".repeat(3000)), { error: "That web address is too long." })
  // Whitespace around the address does not count towards the length, and what is too long is judged before anything else about it.
  assert.ok("url" in checkSiteUrl(`  ${pad("https://example.com/", 2048)}  `))
  assert.deepEqual(checkSiteUrl("not a url ".repeat(300)), { error: "That web address is too long." })
  assert.deepEqual(checkSiteUrl("https://user:pw@example.com/" + "a".repeat(3000)), { error: "That web address is too long." })
})
