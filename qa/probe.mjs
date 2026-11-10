import { connect } from "./lib.mjs"
const [ch, file] = process.argv.slice(2)
const { browser, page } = await connect(ch)
const fn = (await import(file)).default
try { console.log(JSON.stringify(await fn(page), null, 1)) } finally { await browser.close() }
