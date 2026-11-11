import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { Redirect, Route, Switch, useSearch } from "wouter"
import { navigate } from "wouter/use-browser-location"
import { Spinner } from "@/components/ui/spinner"
import { api, SIGNED_OUT, UnauthorizedError, type Me } from "@/lib/api"
import { signInHref } from "@/lib/site"
import { CollectionsProvider } from "@/lib/collections"
import { CanvasHome } from "@/components/canvas/canvas-home"
import { BoardCanvas } from "@/components/canvas/board-canvas"
import { ReferencePage } from "@/components/reference-page"
import { AddFlowProvider } from "@/components/add-flow"

// Signed-out and account pages are split out so the canvas bundle doesn't carry them.
const GuidePage = lazy(() => import("@/components/guide-page").then((m) => ({ default: m.GuidePage })))
const LandingPage = lazy(() => import("@/components/landing-page").then((m) => ({ default: m.LandingPage })))
const SignInPage = lazy(() => import("@/components/auth/sign-in-page").then((m) => ({ default: m.SignInPage })))
const PasskeysPage = lazy(() => import("@/components/auth/passkeys-page").then((m) => ({ default: m.PasskeysPage })))

const Loading = () => (
  <div className="grid min-h-svh place-items-center">
    <Spinner className="size-5 text-muted-foreground" />
  </div>
)

/** All saves. Links from before the canvas (?collection=, ?view=) go to their new homes. */
function Home({ login }: { login: string }) {
  const params = new URLSearchParams(useSearch())
  const collection = params.get("collection")
  const view = params.get("view")
  if (collection) return <Redirect to={`/b/${encodeURIComponent(collection)}`} replace />
  if (view) return <Redirect to={`/?filter=${encodeURIComponent(view)}`} replace />
  return <CanvasHome login={login} />
}

export function App() {
  const [state, setState] = useState<"loading" | "anon" | "offline" | Me>("loading")

  // Any 401 means signed out, at boot or later (signed out on another device).
  useEffect(() => {
    const onSignedOut = () => {
      // Signed out mid-use: sign-in brings them back to where they were.
      if (typeof state === "object" && location.pathname !== "/sign-in") navigate(signInHref(), { replace: true })
      setState("anon")
    }
    window.addEventListener(SIGNED_OUT, onSignedOut)
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut)
  }, [state])

  const check = useCallback(() => {
    setState("loading")
    api
      .me()
      .then((me) => setState(me))
      // Anything but a 401 is a connection problem worth retrying.
      .catch((e) => e instanceof UnauthorizedError || setState("offline"))
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
        {/* Reachable signed out: the passkey form decides for itself whether a session exists. */}
        <Route path="/sign-in">
          <Suspense fallback={<Loading />}>
            <SignInPage />
          </Suspense>
        </Route>
        <Route path="/passkeys">
          <Suspense fallback={<Loading />}>
            <PasskeysPage />
          </Suspense>
        </Route>
        <Route path="/guide">
          <GuidePage signedIn={false} />
        </Route>
        {/* The bookmarklet's tab is kept through sign-in. */}
        <Route path="/add">
          <Redirect to={signInHref()} replace />
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
        <Route path="/sign-in">
          <Suspense fallback={<Loading />}>
            <SignInPage />
          </Suspense>
        </Route>
        <Route path="/passkeys">
          <Suspense fallback={<Loading />}>
            <PasskeysPage />
          </Suspense>
        </Route>
        <Route path="/r/:id">{(p) => <ReferencePage key={p.id} id={p.id} login={state.login} />}</Route>
        <Route path="/b/:id">{(p) => <BoardCanvas key={p.id} login={state.login} id={p.id} />}</Route>
        <Route>
          <Home login={state.login} />
        </Route>
      </Switch>
      </AddFlowProvider>
    </CollectionsProvider>
  )
}

