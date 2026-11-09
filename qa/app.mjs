import { startApp, stopApp, waitHttp, origin, readPid, CHANNELS } from "./lib.mjs"
const [cmd, ch, ...rest] = process.argv.slice(2)
if (!CHANNELS[ch]) throw new Error("channel: stable|dev")
if (cmd === "start") {
  const idle = rest.includes("--default-idle") ? {} : { SNIP_WINDOW_IDLE_SECONDS: "0" }
  const pid = startApp(ch, idle)
  console.log(ch, "pid", pid)
  await waitHttp(origin(ch) + "/api/me")
  console.log("ready", origin(ch))
} else if (cmd === "stop") console.log(JSON.stringify(await stopApp(ch)))
