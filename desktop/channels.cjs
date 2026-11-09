const channels = Object.freeze({
  stable: Object.freeze({ name: "Snip", bundleId: "dev.snip.desktop", icon: "Snip.icns", port: 5173 }),
  nightly: Object.freeze({ name: "Snip Dev", bundleId: "dev.snip.desktop.nightly", icon: "Snip-dev.icns", port: 5175 }),
})

function channelConfig(channel = "stable") {
  if (!Object.hasOwn(channels, channel)) throw new Error(`Unknown Snip channel: ${channel}`)
  return channels[channel]
}

// Nightlies have their own monotonically increasing version sequence. Stable
// versions are never compared with this sequence or offered to Snip Dev.
function nightlyVersion(sequence) {
  if (!/^[1-9]\d*$/.test(String(sequence)) || !Number.isSafeInteger(Number(sequence))) throw new Error("Nightly builds require a positive integer SNIP_NIGHTLY_BUILD (the workflow run number).")
  return `0.0.${sequence}`
}

module.exports = { channelConfig, nightlyVersion }
