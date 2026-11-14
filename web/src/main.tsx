import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { App } from "./App"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <App />
        <Toaster position="bottom-center" offset={{ bottom: "var(--toast-bottom, 24px)" }} mobileOffset={{ bottom: "var(--toast-bottom, 16px)" }} />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
