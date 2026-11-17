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
      header:not(.snip-top-bar) {
        padding-left: max(24px, calc(env(titlebar-area-x, 0px) + 8px));
        -webkit-app-region: drag;
      }
      .snip-top-bar {
        -webkit-app-region: drag;
      }
      .snip-toolbar-leading {
        /* Separate navigation from native window controls without offsetting
           the whole toolbar (which would shift its search center). */
        padding-left: max(0px, calc(env(titlebar-area-x, 0px) - 8px));
      }
      .snip-top-bar .snip-home-link { display: none; }
      header > *, [role="dialog"], [role="menu"],
      [data-slot="popover-content"], [data-slot="dialog-overlay"] {
        -webkit-app-region: no-drag;
      }
      .snip-top-bar > .snip-toolbar-leading {
        -webkit-app-region: drag;
      }
      .snip-toolbar-leading > * {
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
