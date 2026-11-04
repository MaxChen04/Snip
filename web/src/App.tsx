import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { Route, Switch } from "wouter"
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

