import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { Route, Switch } from "wouter"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"
import { api, UnauthorizedError } from "@/lib/api"
import { CollectionsProvider } from "@/lib/collections"
import { GalleryPage } from "@/components/gallery-page"
import { ReferencePage } from "@/components/reference-page"
import { AddFlowProvider } from "@/components/add-flow"

// Signed-out pages are split out so the app bundle doesn't carry them.
const GuidePage = lazy(() => import("@/components/guide-page").then((m) => ({ default: m.GuidePage })))
const LandingPage = lazy(() => import("@/components/landing-page").then((m) => ({ default: m.LandingPage })))

const Loading = () => (
  <div className="grid min-h-svh place-items-center">
    <Spinner className="size-5 text-muted-foreground" />
  </div>
)

export function App() {
  const [state, setState] = useState<"loading" | "anon" | "offline" | { login: string }>("loading")

  const check = useCallback(() => {
    setState("loading")
    api
      .me()
      .then((me) => setState(me))
      // Only a 401 means signed out; anything else is a connection problem worth retrying.
      .catch((e) => setState(e instanceof UnauthorizedError ? "anon" : "offline"))
  }, [])

  useEffect(check, [check])

  if (state === "loading") return <Loading />

  if (state === "offline") {
    return (
      <div className="grid min-h-svh place-items-center gap-3 text-center text-sm text-muted-foreground">
        <div>
          <p>Couldn't reach Snip.</p>
          <button type="button" onClick={check} className="mt-3 rounded-full bg-fill-2 px-3.5 py-1.5 text-xs font-medium text-foreground hover:bg-fill-3">
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (state === "anon") {
    return (
      <Suspense fallback={<Loading />}>
      <Switch>
        <Route path="/guide">
          <GuidePage signedIn={false} />
        </Route>
        <Route>
          <LandingPage />
        </Route>
      </Switch>
      </Suspense>
    )
  }

  return (
    <CollectionsProvider>
      <AddFlowProvider>
      <Switch>
        <Route path="/guide">
          <Suspense fallback={<Loading />}>
            <GuidePage signedIn />
          </Suspense>
        </Route>
        <Route path="/r/:id">{(p) => <ReferencePage key={p.id} id={p.id} login={state.login} />}</Route>
        <Route>
          <GalleryPage login={state.login} />
        </Route>
      </Switch>
      </AddFlowProvider>
    </CollectionsProvider>
  )
}

export function Logo({ className }: { className?: string }) {
  return <img src="/logo.png" alt="" aria-hidden="true" draggable={false} className={cn("object-contain select-none", className)} />
}

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" data-icon="inline-start" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
