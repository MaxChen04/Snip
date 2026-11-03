import { useEffect, useState } from "react"
import { Route, Switch } from "wouter"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { api, UnauthorizedError } from "@/lib/api"
import { CollectionsProvider } from "@/lib/collections"
import { GalleryPage } from "@/components/gallery-page"
import { ReferencePage } from "@/components/reference-page"
import { AddFlowProvider } from "@/components/add-flow"

export function App() {
  const [state, setState] = useState<"loading" | "anon" | { login: string }>("loading")

  useEffect(() => {
    api
      .me()
      .then((me) => setState(me))
      .catch((e) => setState(e instanceof UnauthorizedError ? "anon" : "anon"))
  }, [])

  if (state === "loading") {
    return (
      <div className="grid min-h-svh place-items-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    )
  }

  if (state === "anon") {
    return (
      <div className="grid min-h-svh place-items-center px-4">
        <div className="flex max-w-sm flex-col items-center gap-5 text-center">
          <Logo className="size-10" />
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold">Refshelf</h1>
            <p className="text-sm text-muted-foreground">Your private library of website design references.</p>
          </div>
          <Button size="lg" render={<a href={`/auth/login?next=${encodeURIComponent(location.pathname)}`} />} nativeButton={false}>
            <GithubMark />
            Sign in with GitHub
          </Button>
        </div>
      </div>
    )
  }

  return (
    <CollectionsProvider>
      <AddFlowProvider>
      <Switch>
        <Route path="/r/:id">{(p) => <ReferencePage id={p.id} login={state.login} />}</Route>
        <Route>
          <GalleryPage login={state.login} />
        </Route>
      </Switch>
      </AddFlowProvider>
    </CollectionsProvider>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="3" y="5" width="11" height="14" rx="3" className="fill-primary" />
      <rect x="18" y="5" width="11" height="9" rx="3" className="fill-foreground/80" />
      <rect x="3" y="22" width="11" height="5" rx="2.5" className="fill-foreground/30" />
      <rect x="18" y="17" width="11" height="10" rx="3" className="fill-foreground/55" />
    </svg>
  )
}

function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" data-icon="inline-start">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
