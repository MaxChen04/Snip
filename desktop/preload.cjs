const { contextBridge, ipcRenderer } = require("electron")
let restored = { values: {}, position: null }
try {
  const arg = process.argv.find(value => value.startsWith("--snip-ui-state="))
  if (arg) {
    const bytes = Uint8Array.from(atob(arg.slice("--snip-ui-state=".length)), char => char.charCodeAt(0))
    restored = JSON.parse(new TextDecoder().decode(bytes))
  }
} catch {}

contextBridge.exposeInMainWorld("snipDesktop", {
  initialState: restored.values,
  remember: (key, value) => ipcRenderer.send("snip:ui-state", { key, value }),
  checkQueue: () => ipcRenderer.send("snip:retry-capture"),
})

window.addEventListener("DOMContentLoaded", () => {
  let timer, restoring = false
  const remember = () => {
    if (!restoring) ipcRenderer.send("snip:position", { url: location.href, x: scrollX, y: scrollY })
  }
  window.addEventListener("scroll", () => { clearTimeout(timer); timer = setTimeout(remember, 250) }, { passive: true })
  document.addEventListener("visibilitychange", remember)
  const target = restored.position
  if (!target || target.url !== location.href || !target.y) return
  restoring = true
  // Let paginated content load while moving toward the saved position. Stop
  // restoring as soon as the user interacts; never fight a new scroll gesture.
  const observer = new ResizeObserver(() => restore())
  let deadline
  const cancel = () => {
    restoring = false
    observer.disconnect()
    clearTimeout(deadline)
    for (const name of ["wheel", "touchstart", "keydown"]) window.removeEventListener(name, cancel)
  }
  function restore() {
    if (location.href !== target.url) { cancel(); return }
    window.scrollTo(target.x, target.y)
    if (Math.abs(scrollY - target.y) < 2) cancel()
  }
  for (const name of ["wheel", "touchstart", "keydown"]) window.addEventListener(name, cancel, { passive: true })
  observer.observe(document.body)
  deadline = setTimeout(cancel, 20000)
  restore()
})
