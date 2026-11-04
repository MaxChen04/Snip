// Entry for the public site build (vite.site.config.ts): only the signed-out
// pages, with no API calls. The app entry is main.tsx.
import { lazy, StrictMode, Suspense } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "next-themes"
import { Route, Switch } from "wouter"
import { Spinner } from "@/components/ui/spinner"
import { LandingPage } from "@/components/landing-page"
import "./index.css"

const GuidePage = lazy(() => import("@/components/guide-page").then((m) => ({ default: m.GuidePage })))

function NotFound() {
  return (
    <div className="grid min-h-svh place-items-center px-4 text-center">
      <div className="flex flex-col items-center gap-3">
        <p className="text-xs font-medium text-muted-foreground">404</p>
        <h1 className="text-2xl font-medium tracking-[-0.03em]">This page isn’t on the shelf</h1>
        <a href="/" className="mt-2 rounded-full bg-fill-2 px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-fill-3">
          Back to home
        </a>
      </div>
    </div>
  )
}

const Loading = () => (
  <div className="grid min-h-svh place-items-center">
    <Spinner className="size-5 text-muted-foreground" />
  </div>
)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <Suspense fallback={<Loading />}>
        <Switch>
          <Route path="/">
            <LandingPage />
          </Route>
          <Route path="/guide">
            <GuidePage signedIn={false} />
          </Route>
          <Route>
            <NotFound />
          </Route>
        </Switch>
      </Suspense>
    </ThemeProvider>
  </StrictMode>,
)
