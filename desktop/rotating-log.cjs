const fs = require("node:fs/promises")
const path = require("node:path")

function createLog(file, { maxBytes = 2 * 1024 * 1024, backups = 2, onError = () => {} } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 128 || !Number.isInteger(backups) || backups < 0) throw new Error("Invalid log limits")
  const limit = maxBytes * 2
  const marker = Buffer.from("\n[Snip: log output dropped]\n")
  let queue = [], queued = 0, running = false, closed = false, waiters = []

  function report(error) { try { onError(error) } catch {} }
  async function rotate() {
    if (!backups) { await fs.rm(file, { force: true }); return }
    await fs.rm(`${file}.${backups}`, { force: true })
    for (let i = backups - 1; i >= 1; i--) {
      try { await fs.rename(`${file}.${i}`, `${file}.${i + 1}`) } catch (error) { if (error.code !== "ENOENT") throw error }
    }
    try { await fs.rename(file, `${file}.1`) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
  async function append(data) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    let size = 0
    try { size = (await fs.stat(file)).size } catch (error) { if (error.code !== "ENOENT") throw error }
    if (size + data.length > maxBytes) await rotate()
    await fs.appendFile(file, data)
  }
  async function drain() {
    if (running) return
    running = true
    while (queue.length) {
      const data = queue.shift()
      queued -= data.length
      try { await append(data) } catch (error) { report(error) }
    }
    running = false
    if (closed) { const done = waiters; waiters = []; done.forEach(resolve => resolve()) }
  }
  function write(chunk) {
    if (closed || chunk == null) return
    // Keep only the newest bytes of a single large write before buffering it.
    let data = Buffer.isBuffer(chunk) ? Buffer.from(chunk.subarray(Math.max(0, chunk.length - maxBytes))) : Buffer.from(String(chunk).slice(-maxBytes))
    let dropped = Buffer.isBuffer(chunk) ? chunk.length > maxBytes : Buffer.byteLength(String(chunk)) > maxBytes
    if (data.length > maxBytes) { data = data.subarray(data.length - maxBytes); dropped = true }
    if (!data.length) return
    while (queue.length && (queued + data.length + marker.length > limit || queue.length >= 256)) {
      queued -= queue.shift().length
      dropped = true
    }
    if (dropped) {
      data = data.subarray(Math.max(0, data.length - (maxBytes - marker.length)))
      const firstNewline = data.indexOf(10)
      if (firstNewline >= 0 && firstNewline < data.length / 2) data = data.subarray(firstNewline + 1)
      data = Buffer.concat([marker, data])
    }
    queue.push(data); queued += data.length
    void drain()
  }
  function end(chunk) {
    if (!closed) { if (chunk != null) write(chunk); closed = true }
    if (!running && !queue.length) return Promise.resolve()
    return new Promise(resolve => waiters.push(resolve))
  }
  return { write, end }
}

module.exports = { createLog }
