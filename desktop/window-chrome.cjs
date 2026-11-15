// Keep native controls while the page paints all the way to the window edge.
// The overlay geometry also releases the controls' inset in native fullscreen.
function mainWindowChrome(platform = process.platform) {
  return platform === "darwin" ? {
    titleBarStyle: "hiddenInset",
    titleBarOverlay: { height: 64 },
    trafficLightPosition: { x: 18, y: 26 },
  } : {}
}

function installWindowChrome(window, platform = process.platform) {
  if (platform !== "darwin") return
  // CSS only: hosted libraries must keep working without a privileged preload.
  // Apply on each document, including the loading and connection-error pages.
  window.webContents.on("dom-ready", () => {
    void window.webContents.insertCSS(`
      header {
        padding-left: max(24px, calc(env(titlebar-area-x, 0px) + 8px));
        -webkit-app-region: drag;
      }
      header > *, [role="dialog"], [role="menu"],
      [data-slot="popover-content"], [data-slot="dialog-overlay"] {
        -webkit-app-region: no-drag;
      }
      /* A narrow grab area remains on pages without a header. No painted bar. */
      html::before {
        content: "";
        position: fixed;
        inset: 0 0 auto;
        height: 8px;
        z-index: 2147483647;
        -webkit-app-region: drag;
      }
    `).catch(() => {}) // The window may close while its document is loading.
  })
}

module.exports = { mainWindowChrome, installWindowChrome }
