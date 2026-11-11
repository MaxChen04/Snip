import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { connect } from "node:net"
import { chromium } from "playwright"
import { captureJob } from "../src/capture"
import { createCaptureNetwork, PrivateAddressError } from "../src/network-guard"

async function fixture() {
  let hits = 0
  const marker = "PRIVATE_TEST_RESPONSE_DO_NOT_EXPORT"
  const server = http.createServer((_req, res) => { hits++; res.end(marker) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  return { marker, hits: () => hits, port: (server.address() as {port:number}).port,
    url: `http://127.0.0.1:${(server.address() as {port:number}).port}/private`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

test("browser redirects, frames, styles and API downloads cannot reach private addresses", {timeout:45000}, async () => {
  const target = await fixture()
  const browser = await chromium.launch({headless:true})
  try {
    for (const kind of ["redirect", "frame", "stylesheet", "api", "https"] as const) {
      const network = await createCaptureNetwork()
      const context = await browser.newContext({proxy:network.proxy, serviceWorkers:"block"})
      try {
        await context.route("http://8.8.8.8/**", route => route.fulfill(kind === "redirect"
          ? {status:302, headers:{location:target.url}}
          : {contentType:"text/html",body:`<html><head>${kind === "stylesheet" ? `<link rel="stylesheet" href="${target.url}">` : ""}</head><body>${kind === "frame" ? `<iframe src="${target.url}"></iframe>` : "public fixture"}</body></html>`}))
        if (kind === "api" || kind === "https") {
          await context.request.get(kind === "https" ? target.url.replace("http:", "https:") : target.url, {timeout:5000}).catch(() => {})
        } else {
          const page = await context.newPage()
          await page.goto("http://8.8.8.8/", {waitUntil:"networkidle",timeout:8000}).catch(() => {})
          // Browser local-network policy may also block a frame before it reaches the proxy.
          if (kind === "frame" || kind === "stylesheet") await context.request.get(target.url, {timeout:5000}).catch(() => {})
        }
        assert.equal(target.hits(), 0, kind)
        assert.throws(() => network.assertAllowed(), PrivateAddressError, kind)
      } finally { await context.close(); await network.close() }
    }
  } finally { await browser.close(); await target.close() }
})

test("capture rejects a private stylesheet instead of publishing its response", {timeout:45000}, async () => {
  const target = await fixture()
  const browser = await chromium.launch({headless:true})
  let uploads = 0
  try {
    const routedBrowser = {
      async newContext(options:any) {
        const context = await browser.newContext(options)
        await context.route("http://8.8.8.8/**", route => route.fulfill({contentType:"text/html",
          body:`<html><head><title>Public fixture</title><link rel="stylesheet" href="${target.url}"></head><body>Public fixture</body></html>`}))
        return context
      }
    }
    const api = {async control(){return null},async progress(){},async upload(){uploads++},async addPage(){},async complete(){}}
    await assert.rejects(captureJob(routedBrowser as any,api as any,{id:"r",url:"http://8.8.8.8/",attempt:"a".repeat(32),mode:"single",maxPages:1,resume:null,options:null}),PrivateAddressError)
    assert.equal(target.hits(),0)
    assert.equal(uploads,0)
  } finally { await browser.close(); await target.close() }
})

test("HTTP and CONNECT dial the validated IP without a second DNS lookup", {timeout:20000}, async () => {
  const target = await fixture()
  const dialed:string[] = []
  let lookups = 0
  const network = await createCaptureNetwork({
    resolve: async () => [{address:++lookups <= 2 ? "8.8.8.8" : "127.0.0.1",family:4}],
    connect: (address, port) => {
      dialed.push(address)
      assert.equal(port,target.port)
      // Test-only transport maps the approved public IP to this isolated fixture.
      return connect({host:"127.0.0.1",port})
    }
  })
  const browser = await chromium.launch({headless:true})
  const context = await browser.newContext({proxy:network.proxy})
  await context.route("**/favicon.ico", route=>route.abort())
  try {
    const page = await context.newPage()
    await page.goto(`http://fixture.example:${target.port}/`)
    assert.match(await page.textContent("body") ?? "",new RegExp(target.marker))
    await context.request.get(`http://fixture.example:${target.port}/api`)
    assert.ok(dialed.length >= 2)
    assert.ok(dialed.every(ip=>ip === "8.8.8.8"))
    await context.request.get(`http://fixture.example:${target.port}/rebound`).catch(()=>{})
    assert.throws(()=>network.assertAllowed(),PrivateAddressError)
  } finally { await context.close(); await browser.close(); await network.close(); await target.close() }
})

import { createHash } from 'node:crypto'

test('WebSocket upgrades retain public connectivity and refuse private targets', {timeout:15000}, async () => {
  let upgrades = 0
  const server = http.createServer()
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
  server.on('upgrade',(req,socket)=>{
    upgrades++
    const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(Buffer.from([0x81,2,111,107]))
    socket.on('error',()=>{})
    socket.on('end',()=>socket.destroy())
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port=(server.address() as {port:number}).port
  const network=await createCaptureNetwork({resolve:async()=>[{address:'8.8.8.8',family:4}],connect:()=>connect({host:'127.0.0.1',port})})
  const browser=await chromium.launch({headless:true})
  const context=await browser.newContext({proxy:network.proxy})
  try {
    const page=await context.newPage()
    const message=await page.evaluate(url=>new Promise<string>(resolve=>{
      const ws=new WebSocket(url)
      setTimeout(()=>resolve('timeout'),3000)
      ws.onmessage=e=>{resolve(e.data);ws.close()}
      ws.onerror=()=>resolve('error')
    }),`ws://fixture.example:${port}/socket`)
    assert.equal(message,'ok')
    const before=upgrades
    await page.evaluate(url=>new Promise<void>(resolve=>{
      const ws=new WebSocket(url)
      setTimeout(()=>resolve(),3000)
      ws.onerror=()=>resolve()
      ws.onopen=()=>{ws.close();resolve()}
    }),`ws://127.0.0.1:${port}/socket`)
    assert.equal(upgrades,before)
    assert.throws(()=>network.assertAllowed(),PrivateAddressError)
  } finally {
    await context.close();await browser.close();await network.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve=>server.close(()=>resolve()))
  }
})

test("a private icon or unused font loses that file, not the capture", {timeout:90000}, async () => {
  const target = await fixture()
  const browser = await chromium.launch({headless:true})
  let completed: {favicon:string|null}|null = null
  let pages = 0
  try {
    const routedBrowser = {
      async newContext(options:any) {
        const context = await browser.newContext(options)
        await context.route("http://8.8.8.8/", route => route.fulfill({contentType:"text/html",
          body:`<html><head><title>Public fixture</title><link rel="icon" href="${target.url}"><style>@font-face{font-family:Unused;src:url("${target.url}")}</style></head><body>Public fixture</body></html>`}))
        return context
      }
    }
    const api = {async control(){return null},async progress(){},async upload(key:string){return key},async addPage(){pages++},async complete(_id:string,c:{favicon:string|null}){completed=c}}
    await captureJob(routedBrowser as any,api as any,{id:"r",url:"http://8.8.8.8/",attempt:"a".repeat(32),mode:"crawl",maxPages:1,resume:null,options:null,features:["icon"]})
    assert.equal(target.hits(),0)
    assert.equal(pages,1)
    assert.equal(completed!.favicon,target.url,"the icon was not saved, so its URL is kept")
  } finally { await browser.close(); await target.close() }
})
