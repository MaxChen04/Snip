import { useState, type ReactNode } from "react"
import { ArrowUpRightIcon, CheckIcon, CopyIcon, LaptopIcon, ShieldCheckIcon, XIcon } from "@/components/icons"
import { Logo } from "@/components/brand"
import { notify } from "@/components/notify"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { claudeCodeCommand, codexCommand, codexToml, isLocalOrigin, mcpJsonConfig, mcpUrl, opencodeJson } from "@/lib/mcp"
import { cn } from "@/lib/utils"

// Pattern from MCP connect screens on Mobbin (Descript, Cursor, Perplexity): the server URL up
// top with its own copy button, then per-client steps, then what happens on first sign-in.

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    notify(`Copied ${label}`)
    return true
  } catch {
    window.prompt(`Copy the ${label}`, text)
    return false
  }
}

function CopyButton({ text, label, className, children }: { text: string; label: string; className?: string; children?: ReactNode }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(text, label)) {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        }
      }}
      aria-label={`Copy ${label}`}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
        className ?? "bg-foreground text-background hover:bg-foreground/85",
      )}
    >
      {done ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      {children ?? (done ? "Copied" : "Copy")}
    </button>
  )
}

function Code({ text, label }: { text: string; label: string }) {
  return (
    <div className="relative min-w-0 rounded-xl bg-fill-2 ring-1 ring-border">
      <pre className="px-3.5 py-3 pr-20 font-mono text-xs leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</pre>
      <CopyButton text={text} label={label} className="absolute top-2 right-2 h-7 bg-background px-2.5 ring-1 ring-border hover:bg-fill-3" />
    </div>
  )
}

function Steps({ children }: { children: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {children.map((step, i) => (
        <li key={i} className="flex gap-3">
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-fill-2 text-2xs font-medium text-muted-foreground tabular-nums">{i + 1}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-px text-sm leading-[1.5]">{step}</div>
        </li>
      ))}
    </ol>
  )
}

function ClientSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-baseline gap-2 text-xs font-medium">
        {title}
        {note && <span className="font-normal text-muted-foreground">{note}</span>}
      </h3>
      {children}
    </section>
  )
}

const kbd = "rounded bg-fill-2 px-1 py-px font-mono text-[0.85em]"

export function ConnectMcpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const url = mcpUrl()
  const local = isLocalOrigin()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100svh-2rem)] grid-cols-[minmax(0,1fr)] gap-0 overflow-x-hidden overflow-y-auto rounded-3xl p-0 sm:max-w-[520px]">
        <div className="flex items-start gap-3 px-5 pt-5 pb-4">
          <Logo className="size-9 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <DialogTitle className="text-base font-medium">Connect Snip to your agent</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Add Snip as a remote MCP server so Claude, Codex, OpenCode, Cursor or any MCP client can search and pull your references.
            </DialogDescription>
          </div>
          <DialogClose className="-mt-1 -mr-1.5 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-fill-2 hover:text-foreground" aria-label="Close">
            <XIcon className="size-4" />
          </DialogClose>
        </div>

        <div className="flex flex-col gap-2 px-5 pb-5">
          <span className="text-xs font-medium text-muted-foreground">MCP server URL</span>
          <div className="flex items-center gap-1.5 rounded-full bg-fill-2 p-1 pl-3.5 ring-1 ring-border">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="MCP server URL"
              className="h-8 min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
            />
            <CopyButton text={url} label="MCP URL" />
          </div>
          {local && (
            <p className="flex items-start gap-2 rounded-xl bg-fill-2 px-3 py-2.5 text-xs leading-[1.5] text-muted-foreground">
              <LaptopIcon className="mt-px size-3.5 shrink-0" />
              <span>
                This is your local Snip. Agents on this Mac can use it while Snip is running. For cloud agents such as Claude.ai, host Snip on Cloudflare and use
                the deployed URL instead: see{" "}
                <a href="/guide#cloud" className="font-medium text-foreground underline underline-offset-2">
                  cloud mode
                </a>
                .
              </span>
            </p>
          )}
        </div>

        <Tabs defaultValue="claude" className="min-w-0 flex-col gap-4 border-t px-5 pt-4 pb-5">
          <TabsList className="h-auto! w-full flex-wrap justify-start">
            {[
              ["claude", "Claude"],
              ["codex", "Codex"],
              ["opencode", "OpenCode"],
              ["cursor", "Cursor"],
              ["other", "Other"],
            ].map(([value, label]) => (
              <TabsTrigger key={value} value={value} className="flex-auto">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="claude" className="flex flex-col gap-5">
            <ClientSection title="Claude Code">
              <Steps>
                {[
                  <>
                    <span>Run this in your terminal:</span>
                    <Code text={claudeCodeCommand(url)} label="Claude Code command" />
                  </>,
                  <span>
                    Start Claude Code and run <code className={kbd}>/mcp</code>, pick <b className="font-medium">snip</b> and choose Authenticate.
                  </span>,
                ]}
              </Steps>
            </ClientSection>
            <ClientSection title="Claude.ai and Claude Desktop" note="set up separately">
              <Steps>
                {[
                  <span>
                    Open <b className="font-medium">Settings → Connectors</b> and choose <b className="font-medium">Add custom connector</b>.
                  </span>,
                  <span>Name it Snip, paste the MCP URL above, then Connect and finish the sign-in.</span>,
                ]}
              </Steps>
              {local && <p className="text-xs leading-[1.5] text-muted-foreground">Connectors reach Snip from Claude's servers, so they need your deployed URL, not localhost.</p>}
            </ClientSection>
          </TabsContent>

          <TabsContent value="codex">
            <Steps>
              {[
                <>
                  <span>Run this in your terminal. The Codex CLI, IDE extension and Codex desktop app share the same config:</span>
                  <Code text={codexCommand(url)} label="Codex command" />
                </>,
                <>
                  <span>
                    Or add it to <code className={kbd}>~/.codex/config.toml</code> yourself:
                  </span>
                  <Code text={codexToml(url)} label="Codex config" />
                </>,
                <>
                  <span>Sign in:</span>
                  <Code text="codex mcp login snip" label="Codex login command" />
                </>,
              ]}
            </Steps>
          </TabsContent>

          <TabsContent value="opencode">
            <Steps>
              {[
                <>
                  <span>
                    Add this to <code className={kbd}>~/.config/opencode/opencode.json</code>, or <code className={kbd}>opencode.json</code> in a project. OpenCode uses an{" "}
                    <code className={kbd}>mcp</code> block with <code className={kbd}>type: "remote"</code>:
                  </span>
                  <Code text={opencodeJson(url)} label="OpenCode config" />
                </>,
                <>
                  <span>OpenCode starts sign-in on first use. To sign in now:</span>
                  <Code text="opencode mcp auth snip" label="OpenCode auth command" />
                </>,
              ]}
            </Steps>
          </TabsContent>

          <TabsContent value="cursor">
            <Steps>
              {[
                <>
                  <span>
                    Add this to <code className={kbd}>~/.cursor/mcp.json</code>, or under Cursor Settings → MCP → Add custom MCP:
                  </span>
                  <Code text={mcpJsonConfig(url)} label="Cursor config" />
                </>,
                <span>Reload MCP servers and select Snip to sign in.</span>,
              ]}
            </Steps>
          </TabsContent>

          <TabsContent value="other">
            <Steps>
              {[
                <>
                  <span>Add a remote MCP server using Streamable HTTP with this URL:</span>
                  <Code text={url} label="MCP URL" />
                </>,
                <>
                  <span>
                    If your client reads an <code className={kbd}>mcpServers</code> JSON file, use:
                  </span>
                  <Code text={mcpJsonConfig(url)} label="MCP config" />
                </>,
              ]}
            </Steps>
          </TabsContent>
        </Tabs>

        <div className="flex flex-col gap-3 border-t bg-fill-1 px-5 py-4 sm:flex-row sm:items-center">
          <p className="flex flex-1 items-start gap-2 text-xs leading-[1.5] text-muted-foreground">
            <ShieldCheckIcon className="mt-px size-3.5 shrink-0" />
            {local ? "Your client opens a consent screen in this local Snip. Review the request before allowing access to your library." : "The first time, your client opens GitHub sign-in and a consent screen. Only allowed GitHub accounts get in."}
          </p>
          <a
            href="/guide#connect"
            className="flex h-8 shrink-0 items-center gap-1 self-start rounded-full px-3 text-xs font-medium text-muted-foreground ring-1 ring-border hover:bg-fill-2 hover:text-foreground sm:self-auto"
          >
            Tools and setup guide
            <ArrowUpRightIcon className="size-3.5" />
          </a>
        </div>
      </DialogContent>
    </Dialog>
  )
}
