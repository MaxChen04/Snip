// Evaluated in the capture agent's own helper page (never a captured site): encodes still images into
// video with WebCodecs, in the browser the agent already runs. Installs window.snipVideo; the agent drives it
// with start, add (one image per call, in order) and finish, then muxes the chunks into a file itself.
// WebCodecs needs a secure context, which is why the helper page is served at http://localhost/.
() => {
  let encoder = null
  let size = null
  let quantizer = null
  let failure = null
  let parts = []
  let chunks = []
  let colorSpace = null

  window.snipVideo = {
    supported: async (config) => typeof VideoEncoder === "function" && !!(await VideoEncoder.isConfigSupported(config).catch(() => null))?.supported,

    start: async ({ config, q }) => {
      encoder?.state !== "closed" && encoder?.close()
      size = { width: config.width, height: config.height }
      quantizer = q
      failure = null
      parts = []
      chunks = []
      colorSpace = null
      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          if (metadata && metadata.decoderConfig && metadata.decoderConfig.colorSpace) colorSpace = metadata.decoderConfig.colorSpace
          const data = new Uint8Array(chunk.byteLength)
          chunk.copyTo(data)
          parts.push(data)
          chunks.push({ t: chunk.timestamp, k: chunk.type === "key", n: data.byteLength })
        },
        error: (e) => { failure = String(e && e.message || e) },
      })
      encoder.configure(config)
    },

    // timestamp in microseconds. Images of another size are scaled to the recording's size.
    add: async ({ image, mime, timestamp, key }) => {
      if (failure) throw new Error(failure)
      const blob = await (await fetch(`data:${mime};base64,${image}`)).blob()
      const bitmap = await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "medium" })
      const frame = new VideoFrame(bitmap, { timestamp })
      bitmap.close()
      const options = { keyFrame: key }
      if (quantizer != null) options.vp9 = { quantizer }
      encoder.encode(frame, options)
      frame.close()
      // Keep at most a few frames queued, so a slow encoder can't pile up decoded images.
      while (encoder.encodeQueueSize > 3) await new Promise((r) => encoder.addEventListener("dequeue", r, { once: true }))
    },

    finish: async () => {
      await encoder.flush()
      encoder.close()
      if (failure) throw new Error(failure)
      const url = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(new Blob(parts))
      })
      const out = { data: url.slice(url.indexOf(",") + 1), chunks, colorSpace }
      parts = []
      chunks = []
      return out
    },
  }
}
