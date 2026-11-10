// Entry for the static Settings window (vite.settings.config.ts). Loaded from disk by
// desktop/main.cjs over snip://, with the bridge from preload-settings.cjs.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SettingsApp } from "./settings-app"
// index.css already asks for "Inter Variable"; this declares it from the bundle.
import "./fonts.css"
import "../index.css"

// In development there is no preload: use the fixture bridge so every state can be
// rendered in a plain browser. The import is dropped from a production build.
if (import.meta.env.DEV && !window.snipCloud) {
  void import("./dev/fixture").then(({ createFixtureBridge }) => {
    window.snipCloud = createFixtureBridge()
    render()
  })
} else {
  render()
}

function render() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <TooltipProvider>
          <SettingsApp />
          <Toaster position="bottom-center" />
        </TooltipProvider>
      </ThemeProvider>
    </StrictMode>,
  )
}
