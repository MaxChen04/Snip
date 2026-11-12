// Preload for the Settings window only. It exposes the small cloud bridge and
// nothing else; the gallery keeps preload.cjs. The cloud window has no preload.
const { contextBridge, ipcRenderer } = require("electron")

function subscribe(channel, callback) {
  const handler = (_event, payload) => {
    try {
      callback(payload)
    } catch (error) {
      console.error("snip settings listener failed", error)
    }
  }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld("snipCloud", {
  state: () => ipcRenderer.invoke("snip:cloud-state", {}),
  enable: options => ipcRenderer.invoke("snip:cloud-enable", options ?? {}),
  disable: action => ipcRenderer.invoke("snip:cloud-disable", { action }),
  retryStep: step => ipcRenderer.invoke("snip:cloud-retry-step", { step }),
  cancel: () => ipcRenderer.invoke("snip:cloud-cancel", {}),
  abort: () => ipcRenderer.invoke("snip:cloud-abort", {}),
  answer: (key, value) => ipcRenderer.invoke("snip:cloud-answer", { key, value }),
  openUrl: url => ipcRenderer.invoke("snip:cloud-open-url", { url }),
  signOutAll: () => ipcRenderer.invoke("snip:cloud-sign-out-all", {}),
  deleteResources: confirmName => ipcRenderer.invoke("snip:cloud-delete-resources", { confirm: confirmName }),
  snapshot: (action, confirm) => ipcRenderer.invoke("snip:cloud-snapshot", { action, confirm }),
  ownerLink: () => ipcRenderer.invoke("snip:cloud-owner-link", {}),
  onProgress: callback => subscribe("snip:cloud-progress", callback),
  onLog: callback => subscribe("snip:cloud-log", callback),
  // The one URL that is meant for the person: a link their other browser opens.
  onLink: callback => subscribe("snip:cloud-link", callback),
})
