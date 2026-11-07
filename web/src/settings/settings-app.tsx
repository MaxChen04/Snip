import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import { cn } from "cn"
import logo from "../../public/logo.png"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ArrowUpRightIcon,
  CheckIcon,
  Clock,
  CopyIcon,
  Database,
  GlobeIcon,
  HardDrive,
  InfoIcon,
  LaptopIcon,
  Loader2Icon,
  MinusIcon,
  MoonIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SunIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "@/components/icons"
import { Meta, Panel, Row, references } from "./bits"
import { AbortSetupDialog, DeleteResourcesDialog, EnableDialog, ExportDeleteDialog, OwnerLinkDialog, SignOutDialog, SnapshotDeleteDialog, TurnOffDialog, type TurnOffChoice } from "./dialogs"
import { dirName, formatBytes, hostOf, shortDate, snapshotLabel, snapshotPhrase } from "./format"
import { copyText, pullPrompt, setupPrompt } from "./prompts"
import { errorAction } from "./retry"
import { commandFor, stepTitle, stepsFor } from "./steps"
import type { CloudRecord } from "./types"
import { useCloud, type LiveStep } from "./use-cloud"

type DialogName = "enable" | "turn-off" | "sign-out" | "delete" | "snapshot-delete" | "export-delete" | "abort" | "owner-link" | null

export function SettingsApp() {
  const cloud = useCloud()
  const [dialog, setDialog] = useState<DialogName>(null)
  const [turnOffChoice, setTurnOffChoice] = useState<TurnOffChoice>("stay")
  const [linkCopied, setLinkCopied] = useState(false)
  const mode = cloud.mode
  const working = cloud.busy || mode === "enabling" || mode === "disabling"
  const adopted = cloud.file?.move?.status === "skipped"
  // Say where the library actually is, not where it started.
  const intro =
    mode === "cloud"
      ? adopted
        ? "Your library lives in your Cloudflare account, and this Mac keeps its own copy. Captures still run on this Mac."
        : "Your library lives in your Cloudflare account. Captures still run on this Mac."
      : cloud.cloud?.detachedAt
        ? "Your library lives on this Mac. Your detached cloud copy is still live, so other devices and agents can still read it."
        : "Your library lives on this Mac. Enabling cloud copies it to your own Cloudflare account, so other devices and agents can read it."

  // A screenshot or a support run may open a specific dialog; harmless in normal use.
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("dialog") as DialogName
    if (!requested || !["enable", "turn-off", "sign-out", "delete", "snapshot-delete", "export-delete", "abort", "owner-link"].includes(requested)) return
    setDialog(requested)
    // The link sheet has nothing to show until a link exists.
    if (requested === "owner-link" && !cloud.link) void cloud.requestLink()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copyPrompt = async (kind: "setup" | "pull") => {
    const copied = await copyText(kind === "setup" ? setupPrompt() : pullPrompt())
    if (copied) toast.success(kind === "setup" ? "Setup prompt copied" : "Prompt copied")
    else toast.error("Couldn’t copy the prompt")
  }

  const startEnable = async () => {
    setDialog(null)
    await cloud.begin(() => cloud.bridge!.enable())
  }

  const chooseTurnOff = async (choice: TurnOffChoice) => {
    if (choice === "stay") {
      setDialog(null)
      return
    }
    setDialog(null)
    await cloud.begin(() => cloud.bridge!.disable(choice))
  }

  const confirmDelete = async () => {
    const host = hostOf(cloud.cloud?.url)
    setDialog(null)
    await cloud.begin(() => cloud.bridge!.deleteResources(host))
  }

  const confirmSnapshotDelete = async () => {
    const name = dirName(cloud.snapshotRecord?.path)
    setDialog(null)
    await cloud.begin(() => cloud.bridge!.snapshot("delete", name))
  }

  const confirmExportDelete = async () => {
    const name = dirName(cloud.snapshotRecord?.export?.path)
    setDialog(null)
    // The export is delete-only; there is no restore path for it by design.
    await cloud.begin(() => cloud.bridge!.snapshot("delete-export", name))
  }

  const signOut = async () => {
    setDialog(null)
    const reply = await cloud.bridge!.signOutAll()
    if (reply.error) toast.error(reply.error)
    // Exactly what happened: browsers and this app. Agent tokens expire on their own.
    else toast.success("Signed out of browsers and this app")
  }

  const undoSetup = async () => {
    setDialog(null)
    const reply = await cloud.bridge!.abort()
    if (reply.error) toast.error(reply.error)
    else toast.success("Setup undone. This Mac is back on its local library.")
  }

  const openCloud = () => {
    if (cloud.cloud?.url) void cloud.bridge!.openUrl(cloud.cloud.url)
  }

  // One-time link for a browser that has no passkey yet: the Worker's /sign-in page
  // sends people here by name, so this sheet has to exist and show the URL itself.
  const createLink = () => void cloud.requestLink()

  const copyOwnerLink = async (url: string) => {
    if (!(await copyText(url))) {
      toast.error("Couldn’t copy the link")
      return
    }
    setLinkCopied(true)
    window.setTimeout(() => setLinkCopied(false), 1800)
  }

  const showOwnerLink = () => {
    setDialog("owner-link")
    if (!cloud.link) createLink()
  }

  return (
    <div className="flex min-h-svh flex-col bg-ground text-foreground">
      <Header />
      <main className="mx-auto flex w-full max-w-[620px] flex-1 flex-col gap-7 px-6 pt-7 pb-16">
        {working || cloud.choice ? (
          <ProgressView
            cloud={cloud}
            onAdopt={() => void cloud.begin(() => cloud.bridge!.enable({ adoptExisting: true }))}
            onStopChoice={() => {
              cloud.clearChoice()
              void cloud.refresh()
            }}
            onResume={() => void cloud.begin(() => cloud.bridge!.retryStep(""))}
            onUndo={() => setDialog("abort")}
          />
        ) : (
          <>
            <div>
              <h1 className="text-xl tracking-[-0.02em]">Cloud</h1>
              <p className="mt-1.5 text-sm leading-[1.55] text-muted-foreground">{intro}</p>
            </div>

            {mode === "cloud" ? (
              <CloudPanels
                cloud={cloud}
                onOpen={openCloud}
                onTurnOff={() => {
                  setTurnOffChoice("stay")
                  setDialog("turn-off")
                }}
                onRestore={() => {
                  setTurnOffChoice("detach")
                  setDialog("turn-off")
                }}
                onDeleteSnapshot={() => setDialog("snapshot-delete")}
                onDeleteExport={() => setDialog("export-delete")}
                onSignOut={() => setDialog("sign-out")}
                onOwnerLink={showOwnerLink}
                onDeleteResources={() => setDialog("delete")}
                onCopyPrompt={copyPrompt}
                onPasskeys={() => void cloud.bridge!.openUrl(`${cloud.cloud?.url?.replace(/\/$/, "")}/passkeys`)}
              />
            ) : (
              <LocalPanels
                cloud={cloud}
                onEnable={() => setDialog("enable")}
                onOpen={openCloud}
                onCopyPrompt={copyPrompt}
                onRestorePrevious={async () => {
                  await cloud.begin(() => cloud.bridge!.snapshot("restore"))
                }}
                onDeleteSnapshot={() => setDialog("snapshot-delete")}
              />
            )}
          </>
        )}
      </main>

      <EnableDialog
        open={dialog === "enable"}
        onOpenChange={open => setDialog(open ? "enable" : null)}
        empty={cloud.local?.empty === true}
        refs={cloud.local?.refs ?? null}
        onConfirm={() => void startEnable()}
      />
      <TurnOffDialog
        open={dialog === "turn-off"}
        onOpenChange={open => setDialog(open ? "turn-off" : null)}
        host={hostOf(cloud.cloud?.url) || "Cloudflare"}
        localCopy={!cloud.snapshotRecord ? "an empty library" : snapshotPhrase(cloud.snapshotRecord) ?? "its local library"}
        initialChoice={turnOffChoice}
        onChoose={choice => void chooseTurnOff(choice)}
        onCopyPrompt={() => void copyPrompt("pull")}
      />
      <SignOutDialog open={dialog === "sign-out"} onOpenChange={open => setDialog(open ? "sign-out" : null)} onConfirm={() => void signOut()} />
      <DeleteResourcesDialog
        open={dialog === "delete"}
        onOpenChange={open => setDialog(open ? "delete" : null)}
        host={hostOf(cloud.cloud?.url)}
        onConfirm={() => void confirmDelete()}
      />
      <SnapshotDeleteDialog
        open={dialog === "snapshot-delete"}
        onOpenChange={open => setDialog(open ? "snapshot-delete" : null)}
        label={snapshotLabel(cloud.snapshotRecord) ?? "The previous library"}
        onConfirm={() => void confirmSnapshotDelete()}
      />
      <ExportDeleteDialog
        open={dialog === "export-delete"}
        onOpenChange={open => setDialog(open ? "export-delete" : null)}
        onConfirm={() => void confirmExportDelete()}
      />
      <OwnerLinkDialog
        open={dialog === "owner-link"}
        onOpenChange={open => setDialog(open ? "owner-link" : null)}
        link={cloud.link}
        pending={cloud.linkPending}
        error={cloud.linkError}
        copied={linkCopied}
        onCreate={() => {
          setLinkCopied(false)
          createLink()
        }}
        onCopy={url => void copyOwnerLink(url)}
        onOpen={url => void cloud.bridge!.openUrl(url)}
      />
      <AbortSetupDialog open={dialog === "abort"} onOpenChange={open => setDialog(open ? "abort" : null)} onConfirm={() => void undoSetup()} />
    </div>
  )
}

function Header() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const dark = mounted && resolvedTheme === "dark"
  const electron = typeof navigator !== "undefined" && /Electron/.test(navigator.userAgent)
  return (
    <header
      className="sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 bg-ground/85 pr-3 backdrop-blur"
      style={{ paddingLeft: electron ? 84 : 16, WebkitAppRegion: "drag" } as CSSProperties}
    >
      <div className="flex min-w-0 items-center gap-2">
        <img src={logo} alt="" draggable={false} className="size-4 object-contain opacity-90" />
        <span className="text-xs font-medium">Snip</span>
        <span className="text-xs text-ink-9">Settings</span>
      </div>
      <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
        <Button variant="ghost" size="icon-sm" aria-label={dark ? "Use light appearance" : "Use dark appearance"} onClick={() => setTheme(dark ? "light" : "dark")}>
          {dark ? <SunIcon /> : <MoonIcon />}
        </Button>
      </div>
    </header>
  )
}

function LocalPanels({
  cloud,
  onEnable,
  onOpen,
  onCopyPrompt,
  onRestorePrevious,
  onDeleteSnapshot,
}: {
  cloud: ReturnType<typeof useCloud>
  onEnable: () => void
  onOpen: () => void
  onCopyPrompt: (kind: "setup" | "pull") => Promise<void>
  onRestorePrevious: () => void
  onDeleteSnapshot: () => void
}) {
  const detached = cloud.cloud?.detachedAt ? cloud.cloud : null
  const local = cloud.local
  const count = local?.refs ?? null
  const empty = local?.empty === true
  return (
    <>
      <Panel
        title="This Mac"
        badge={<Badge variant="outline">Local</Badge>}
        description={empty ? "An empty library, ready for its first reference." : "Captures run here. Nothing leaves this Mac until you turn on cloud."}
      >
        <Row
          icon={<HardDrive className="size-4" />}
          title={empty ? "Nothing captured yet" : count != null ? references(count) : "Your local library"}
          body={
            local?.reachable === false
              // Do not claim the server is stopped: this is also what a slow start
              // or a refused request looks like. Say only what is known.
              ? "Snip couldn’t read the count from this library just now. Enabling cloud is still safe."
              : empty
                ? "Turn on cloud now and capture from any device, or capture here first and copy later."
                : "Database and screenshots stay in your Snip library folder."
          }
          action={
            <Button onClick={onEnable} disabled={!cloud.bridge || cloud.snapshot.ready === false}>
              {cloud.snapshot.ready === false ? "Starting…" : "Enable cloud"}
            </Button>
          }
        />
      </Panel>

      {cloud.snapshotRecord?.kind === "backup" ? (
        // A pull replaces this Mac's library and keeps the old one. It is only
        // reachable here, because after a pull the app is local, not cloud.
        <Panel title="Previous library" description="The library this Mac used before the cloud copy came back.">
          <Row
            icon={<HardDrive className="size-4" />}
            title={`${references(cloud.snapshotRecord.refs)} · ${shortDate(cloud.snapshotRecord.takenAt) ?? "from before the copy"}`}
            body="Switch back to it, or delete it once you no longer need it."
            action={
              <>
                <Button variant="outline" size="sm" onClick={onRestorePrevious}>
                  Switch back to previous library
                </Button>
                <Button variant="ghost" size="sm" onClick={onDeleteSnapshot} aria-label="Delete previous library">
                  <Trash2Icon />
                </Button>
              </>
            }
          />
        </Panel>
      ) : null}

      {detached ? <DetachedPanel cloud={detached} onOpen={onOpen} /> : null}

      <Panel title="Let your agent do it" description="Your agent can run the same setup, pause at the browser steps, and report back. It never needs a secret in chat.">
        <Row
          icon={<CopyIcon className="size-4" />}
          title="Copy a prompt for your agent"
          body="Works with any coding agent that can run npm in this folder."
          action={
            <Button variant="outline" onClick={() => void onCopyPrompt("setup")} disabled={!cloud.bridge}>
              <CopyIcon data-icon="inline-start" />
              Copy prompt
            </Button>
          }
        />
      </Panel>
    </>
  )
}

function CloudPanels({
  cloud,
  onOpen,
  onTurnOff,
  onRestore,
  onDeleteSnapshot,
  onDeleteExport,
  onSignOut,
  onOwnerLink,
  onDeleteResources,
  onCopyPrompt,
  onPasskeys,
}: {
  cloud: ReturnType<typeof useCloud>
  onOpen: () => void
  onTurnOff: () => void
  onRestore: () => void
  onDeleteSnapshot: () => void
  onDeleteExport: () => void
  onSignOut: () => void
  onOwnerLink: () => void
  onDeleteResources: () => void
  onCopyPrompt: (kind: "setup" | "pull") => Promise<void>
  onPasskeys: () => void
}) {
  const url = cloud.cloud?.url ?? ""
  const host = hostOf(url)
  const snapshot = cloud.snapshotRecord
  const label = snapshotLabel(snapshot)
  const detached = cloud.cloud?.detachedAt
  const adopted = cloud.file?.move?.status === "skipped" && cloud.file?.move?.reason === "adopted-existing"
  const deployed = cloud.cloud?.workerVersion
  const expected = cloud.cloud?.expectedWorkerVersion
  const changedOutside = !!deployed && !!expected && deployed !== expected
  return (
    <>
      {changedOutside ? (
        <section className="flex items-start gap-3 rounded-xl bg-fill-2 px-4 py-3.5 text-sm leading-[1.55]">
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-ink-10" />
          <p>
            Your cloud copy was changed outside Snip.{" "}
            <span className="text-ink-11">
              It runs {deployed}; this Mac expects {expected}. Reading and capturing still work.
            </span>
          </p>
        </section>
      ) : null}
      {adopted ? (
        <section className="flex items-start gap-3 rounded-xl bg-fill-2 px-4 py-3.5 text-sm leading-[1.55]">
          <InfoIcon className="mt-0.5 size-4 shrink-0 text-ink-10" />
          <p>
            Your cloud library already had {references(cloud.cloud?.adoptedLibrary?.refs ?? snapshot?.refs)}, so Snip switched to it.{" "}
            <span className="text-ink-11">
              This Mac's library ({references(snapshot?.refs ?? null)}) is kept here and was not copied.
            </span>
          </p>
        </section>
      ) : null}
      <Panel
        title="Cloud library"
        badge={<Badge variant="success">Connected</Badge>}
        // Never "verified" for an adopted library: no copy was checked, it was taken as-is.
        description={adopted ? `adopted · ${references(cloud.cloud?.adoptedLibrary?.refs ?? null)}. Nothing was copied from this Mac.` : "Snip reads and writes this library. Captures still run on this Mac."}
      >
        <Row
          icon={<GlobeIcon className="size-4" />}
          title={<span className="font-mono text-xs">{host}</span>}
          body={detached ? `Detached from this Mac on ${shortDate(detached) ?? "an earlier date"}, still live.` : "Your own Cloudflare account, on the workers.dev address."}
          action={
            <Button variant="outline" size="sm" onClick={onOpen}>
              Open
              <ArrowUpRightIcon data-icon="inline-end" />
            </Button>
          }
        />
        {/* This Mac's own library was never copied, so there is nothing to "restore":
            detach is the way back. No Restore and no Delete on this row. */}
        {snapshot?.kind === "live" || snapshot?.keptLocal ? (
          <Row
            icon={<HardDrive className="size-4" />}
            title={`This Mac's library · ${references(snapshot?.refs ?? null)}`}
            body={
              adopted
                ? "Kept on this Mac. Not copied to the cloud."
                : "Kept on this Mac and not updated while you use your cloud library. Changes you make in the cloud stay in the cloud."
            }
            action={
              <Button variant="outline" size="sm" onClick={onRestore}>
                Switch back to it
              </Button>
            }
          />
        ) : snapshot?.kind === "backup" && label ? (
          // Only a pull leaves a real second library behind; that one can be swapped back.
          <Row
            icon={<HardDrive className="size-4" />}
            title={`Previous library · ${references(snapshot.refs)}`}
            body={`${label}. This Mac used it before the copy came back.`}
            action={
              <>
                <Button variant="outline" size="sm" onClick={onRestore}>
                  Switch back to previous library
                </Button>
                <Button variant="ghost" size="sm" onClick={onDeleteSnapshot} aria-label="Delete previous library">
                  <Trash2Icon />
                </Button>
              </>
            }
          />
        ) : null}
        {snapshot?.export ? (
          // Insurance, not a restore point: the dump cannot rebuild the stored files.
          <Row
            icon={<Database className="size-4" />}
            title={`Export from ${shortDate(snapshot.export.takenAt) ?? "before cloud"} — ${formatBytes(snapshot.export.bytes) ?? "database and file list"}`}
            body="A copy of the database and file list made during setup. It can’t be restored on its own."
            action={
              <Button variant="ghost" size="sm" onClick={onDeleteExport} aria-label="Delete export">
                <Trash2Icon />
              </Button>
            }
          />
        ) : null}
      </Panel>

      {/* v1 signs in with passkeys only, so this window never advertises a second
          identity provider. An install that already has one keeps working; it is
          simply not something Settings sets up. */}
      <Panel
        title="Access"
        description={
          cloud.snapshot.cloudStatus?.ownerId
            ? `Signed in as ${cloud.snapshot.cloudStatus.ownerId}. Other browsers use a passkey.`
            : "This Mac signed in through an owner link. Other browsers use a passkey."
        }
      >
        <Row
          icon={<ShieldCheckIcon className="size-4" />}
          title="Passkeys"
          body="Add or remove the passkeys that sign other browsers in to this library."
          action={
            <Button variant="outline" size="sm" onClick={onPasskeys}>
              Manage
              <ArrowUpRightIcon data-icon="inline-end" />
            </Button>
          }
        />
        <Row
          icon={<GlobeIcon className="size-4" />}
          title="Sign in another browser"
          body="Creates a one-time link that signs a browser in once. Use it before that browser has a passkey of its own."
          action={
            <Button variant="outline" size="sm" onClick={onOwnerLink}>
              Create link…
            </Button>
          }
        />
        <Row
          icon={<ShieldCheckIcon className="size-4" />}
          title="Sign out all devices"
          body="Signs out browsers and this app. Agents keep access until their token expires, up to 7 days."
          action={
            <Button variant="outline" size="sm" onClick={onSignOut}>
              Sign out…
            </Button>
          }
        />
      </Panel>

      <Panel title="Turn off cloud" description="Leave the cloud copy where it is and go back to this Mac. Nothing is deleted.">
        <Row
          icon={<LaptopIcon className="size-4" />}
          title="Use this Mac’s library again"
          body="The cloud library stays reachable for other devices and agents."
          action={
            <Button variant="outline" size="sm" onClick={onTurnOff}>
              Turn off cloud…
            </Button>
          }
        />
      </Panel>

      <Panel title="Let your agent do it">
        <Row
          icon={<CopyIcon className="size-4" />}
          title="Copy a prompt for your agent"
          body="Useful when you want the cloud library copied back without doing the steps yourself."
          action={
            <Button variant="outline" size="sm" onClick={() => void onCopyPrompt("pull")}>
              <CopyIcon data-icon="inline-start" />
              Copy prompt
            </Button>
          }
        />
      </Panel>

      <section className="rounded-xl px-5 py-4 shadow-[inset_0_0_0_1px_var(--red-6)]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-medium text-(--red-11)">
              <TriangleAlertIcon className="size-3.5" />
              Delete cloud resources
            </h2>
            <p className="mt-1 text-xs leading-[1.5] text-muted-foreground">
              Removes the Worker, database, KV and stored screenshots from Cloudflare. Devices and agents lose access, and it can’t be undone.
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={onDeleteResources}>
            Delete…
          </Button>
        </div>
      </section>

      <Meta>
        {cloud.snapshotRecord?.takenAt ? "Turn off cloud to restore the snapshot, or copy the cloud library back first." : "This library started empty, so there is no snapshot to restore."}
      </Meta>
    </>
  )
}

function DetachedPanel({ cloud, onOpen }: { cloud: CloudRecord; onOpen: () => void }) {
  return (
    <Panel title="Detached copy" badge={<Badge variant="outline">Still live</Badge>} description={`Kept in your Cloudflare account since ${shortDate(cloud.detachedAt) ?? "you turned off cloud"}. Nothing here is deleted.`}>
      <Row
        icon={<GlobeIcon className="size-4" />}
        title={<span className="font-mono text-xs">{hostOf(cloud.url)}</span>}
        body="Devices and agents signed in to it keep working. Turn cloud back on to use it here again."
        action={
          <Button variant="outline" size="sm" onClick={onOpen}>
            Open
            <ArrowUpRightIcon data-icon="inline-end" />
          </Button>
        }
      />
    </Panel>
  )
}

function ProgressView({
  cloud,
  onAdopt,
  onStopChoice,
  onResume,
  onUndo,
}: {
  cloud: ReturnType<typeof useCloud>
  onAdopt: () => void
  onStopChoice: () => void
  onResume: () => void
  onUndo: () => void
}) {
  const command = commandFor(cloud.running?.command ?? null, cloud.mode)
  const ids = useMemo(() => stepsFor(command), [command])
  const doneCount = ids.filter(id => {
    const status = cloud.steps[id]?.status
    return status === "done" || status === "skipped"
  }).length
  const error = cloud.error
  const percent = ids.length ? Math.round((doneCount / ids.length) * 100) : 0
  const copy = {
    setup: { title: "Setting up your cloud library", body: "Keep this window open. Cloudflare asks for two approvals: your account, and R2 if it's off." },
    pull: { title: "Bringing your cloud library back", body: "Snip downloads a fresh copy, checks it, then switches this Mac to it." },
    detach: { title: "Turning off cloud", body: "This Mac goes back to its local library. The cloud copy stays live." },
    "delete-resources": { title: "Deleting cloud resources", body: "Removing the Worker, database, KV and stored files from Cloudflare." },
    "snapshot restore": { title: "Restoring the snapshot", body: "Bringing the copy from before cloud back as the live library." },
    "snapshot delete": { title: "Deleting the snapshot", body: "Removing the local copy from before cloud." },
  }[command] ?? { title: "Working", body: "Keep this window open." }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl tracking-[-0.02em]">{copy.title}</h1>
        <p className="mt-1.5 max-w-[460px] text-sm leading-[1.55] text-muted-foreground">{copy.body}</p>
      </div>

      <div className="flex items-center gap-3">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-ink-4">
          <div className="h-full rounded-full bg-ink-12 transition-[width] duration-500 ease-out" style={{ width: `${Math.max(percent, doneCount ? 4 : 0)}%` }} />
        </div>
        <span className="text-2xs tabular-nums text-muted-foreground">
          {doneCount} of {ids.length}
        </span>
      </div>

      {cloud.choice ? (
        <ChoiceCard choice={cloud.choice} onAdopt={onAdopt} onStop={onStopChoice} />
      ) : cloud.needed ? (
        <NeedsInputCard
          needed={cloud.needed}
          onContinue={async values => {
            for (const [key, value] of Object.entries(values)) await cloud.bridge!.answer(key, value)
            await cloud.begin(() => cloud.bridge!.retryStep(""))
          }}
          onCancel={cloud.clearNeeded}
        />
      ) : cloud.action ? (
        <HumanActionCard action={cloud.action} onOpen={url => void cloud.bridge?.openUrl(url)} />
      ) : null}
      {error && !cloud.choice ? (
        <ErrorCard
          error={error}
          onRetry={() => void cloud.begin(() => cloud.bridge!.retryStep(error.step ?? ""))}
          onRefresh={() => void cloud.refresh()}
        />
      ) : null}

      <ol className="flex flex-col">
        {ids.map(id => {
          const step = cloud.steps[id]
          // A choice stops the run: the step that asked is waiting for a person, not working.
          const status = cloud.choice?.step === id && step?.status === "running" ? "waiting" : step?.status ?? "pending"
          return (
            <li key={id} className="flex min-h-7 items-center gap-2.5">
              <StepMark status={status} />
              <span
                className={cn(
                  "text-xs transition-colors duration-150",
                  status === "done" || status === "skipped" ? "text-ink-9" : status === "running" || status === "waiting" ? "text-foreground" : status === "failed" ? "text-(--red-11)" : "text-ink-8",
                )}
              >
                {stepTitle(id, step?.message)}
              </span>
              {status === "skipped" ? <span className="text-2xs text-ink-8">Skipped</span> : null}
            </li>
          )
        })}
      </ol>

      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-2xs text-muted-foreground">
          {cloud.note?.message ?? (cloud.busy ? "You can keep using Snip while this runs." : cloud.choice ? "Nothing has changed yet." : "Stopped. Nothing on Cloudflare was changed.")}
        </span>
        <div className="flex items-center gap-1.5">
          {cloud.busy ? (
            // Cancel is a SIGINT: the run stops safely and stays resumable.
            <Button variant="ghost" size="sm" onClick={() => void cloud.bridge?.cancel()}>
              Cancel
            </Button>
          ) : !cloud.choice && !cloud.needed ? (
            <>
              <Button variant="outline" size="sm" onClick={onResume}>
                Resume
              </Button>
              {cloud.mode === "enabling" ? (
                <Button variant="ghost" size="sm" className="text-(--red-11) hover:text-(--red-11)" onClick={onUndo}>
                  Undo setup
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function StepMark({ status }: { status: LiveStep["status"] }) {
  if (status === "done") {
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-(--green-3) text-(--green-11)">
        <CheckIcon className="size-3" />
      </span>
    )
  }
  if (status === "running") {
    return <Loader2Icon className="size-4 shrink-0 animate-spin text-ink-10" />
  }
  if (status === "waiting") {
    return <Clock className="size-4 shrink-0 text-ink-10" />
  }
  if (status === "failed") {
    return <TriangleAlertIcon className="size-4 shrink-0 text-(--red-11)" />
  }
  if (status === "skipped") {
    return (
      <span className="grid size-4 shrink-0 place-items-center rounded-full bg-fill-2 text-ink-8">
        <MinusIcon className="size-3" />
      </span>
    )
  }
  return <span className="mx-1 size-2 shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--ink-7)]" />
}

/**
 * A terminal decision the engine refuses to guess. The options come from the event so
 * the wording can never drift between the app and the CLI.
 */
function ChoiceCard({ choice, onAdopt, onStop }: { choice: NonNullable<ReturnType<typeof useCloud>["choice"]>; onAdopt: () => void; onStop: () => void }) {
  const counts = choice.data?.counts
  const url = choice.data?.url
  return (
    <div className="rounded-xl bg-card p-4 shadow-[inset_0_0_0_1px_var(--ink-6)]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-fill-2 text-ink-10">
          <TriangleAlertIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-5">{choice.message}</p>
          {url ? <p className="mt-1 font-mono text-xs text-muted-foreground">{hostOf(url)}</p> : null}
          {counts ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {(counts.refs ?? 0).toLocaleString()} references · {(counts.pages ?? 0).toLocaleString()} pages · {(counts.collections ?? 0).toLocaleString()} collections
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {choice.options.map(option => {
          const stop = option.id === "stop"
          return (
            <button
              key={option.id}
              type="button"
              onClick={stop ? onStop : onAdopt}
              className={cn(
                "rounded-lg px-3.5 py-2.5 text-left transition-colors duration-150 ease-out active:scale-[0.995]",
                stop ? "bg-control text-foreground shadow-button hover:bg-control-hover" : "bg-primary text-primary-foreground shadow-primary hover:bg-(--primary-hover)",
              )}
            >
              <span className="block text-sm">{option.label}</span>
              {option.detail ? <span className={cn("mt-0.5 block text-xs", stop ? "text-muted-foreground" : "text-primary-foreground/75")}>{option.detail}</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * `needs_input` is terminal: the engine does not read stdin. Ask here, then re-run;
 * completed steps re-verify in seconds, so re-entry is cheap.
 */
function NeedsInputCard({
  needed,
  onContinue,
  onCancel,
}: {
  needed: NonNullable<ReturnType<typeof useCloud>["needed"]>
  onContinue: (values: Record<string, string>) => Promise<void>
  onCancel: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  useEffect(() => {
    setValues({})
  }, [needed])
  const ready = needed.every(entry => (values[entry.key] ?? "").trim().length > 0)
  return (
    <div className="rounded-xl bg-card p-4 shadow-[inset_0_0_0_1px_var(--ink-6)]">
      <p className="flex items-start gap-2 text-sm leading-5">
        <InfoIcon className="mt-0.5 size-4 shrink-0 text-ink-10" />
        Snip needs one more thing before it can continue.
      </p>
      <div className="mt-3 flex flex-col gap-2.5">
        {needed.map(entry => (
          <label key={entry.key} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{entry.label}</span>
            <Input
              autoFocus={entry === needed[0]}
              type={entry.secret ? "password" : "text"}
              value={values[entry.key] ?? ""}
              onChange={event => setValues(current => ({ ...current, [entry.key]: event.target.value }))}
              spellCheck={false}
              autoComplete="off"
              aria-label={entry.label}
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!ready} onClick={() => void onContinue(values)}>
          Continue
        </Button>
      </div>
    </div>
  )
}

function HumanActionCard({ action, onOpen }: { action: NonNullable<ReturnType<typeof useCloud>["action"]>; onOpen: (url: string) => void }) {
  const r2 = action.action === "enable_r2"
  return (
    <div className="flex items-start gap-3 rounded-xl bg-fill-2 px-4 py-3.5 shadow-[inset_0_0_0_1px_var(--ink-4)]">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-card text-ink-10 shadow-button">
        <GlobeIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-5">{r2 ? "Turn on R2 in Cloudflare" : "Finish in your browser"}</p>
        <p className="mt-0.5 text-xs leading-[1.5] text-muted-foreground">
          {action.message ?? (r2 ? "Cloudflare needs R2 for screenshots. Turn it on there, then come back here." : "One step happens in your browser.")}
        </p>
      </div>
      <Button size="sm" onClick={() => action.url && onOpen(action.url)} disabled={!action.url}>
        Open
        <ArrowUpRightIcon data-icon="inline-end" />
      </Button>
    </div>
  )
}

function ErrorCard({ error, onRetry, onRefresh }: { error: NonNullable<ReturnType<typeof useCloud>["error"]>; onRetry: () => void; onRefresh: () => void }) {
  const action = errorAction(error)
  return (
    <div className="rounded-xl bg-(--red-3) px-4 py-3.5">
      <p className="flex items-center gap-2 text-sm leading-5 text-(--red-11)">
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        {error.message}
      </p>
      {error.hint ? <p className="mt-1 text-xs leading-[1.5] text-ink-11">{error.hint}</p> : null}
      {action === "none" ? null : (
        <div className="mt-2.5">
          <Button size="sm" variant="outline" onClick={action === "refresh" ? onRefresh : onRetry}>
            <RefreshCwIcon data-icon="inline-start" />
            {action === "refresh" ? "Refresh" : "Retry"}
          </Button>
        </div>
      )}
    </div>
  )
}
