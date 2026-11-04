import { useState, type ReactNode } from "react"
import { ArrowUpRightIcon, CheckIcon, CopyIcon, LaptopIcon, ShieldCheckIcon, XIcon } from "lucide-react"
import { Logo } from "@/App"
import { notify } from "@/components/notify"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { claudeCodeCommand, isLocalOrigin, mcpJsonConfig, mcpUrl } from "@/lib/mcp"
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
              Add Snip as a remote MCP server so Claude, Cursor or any MCP client can search and pull your references.
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
                This is your local Snip. Agents on this Mac can use it while Snip is running. For cloud agents such as Claude.ai, open your deployed Snip and copy
                its URL instead.
              </span>
            </p>
          )}
        </div>

        <Tabs defaultValue="claude-code" className="min-w-0 flex-col gap-4 border-t px-5 pt-4 pb-5">
          <TabsList className="w-full">
            <TabsTrigger value="claude-code" className="flex-1">Claude Code</TabsTrigger>
            <TabsTrigger value="claude" className="flex-1">Claude app</TabsTrigger>
            <TabsTrigger value="cursor" className="flex-1">Cursor</TabsTrigger>
            <TabsTrigger value="other" className="flex-1">Other</TabsTrigger>
          </TabsList>

          <TabsContent value="claude-code">
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
          </TabsContent>

          <TabsContent value="claude">
            <Steps>
              {[
                <span>
                  In Claude.ai or Claude Desktop, open <b className="font-medium">Settings → Connectors</b> and choose <b className="font-medium">Add custom connector</b>.
                </span>,
                <>
                  <span>Name it Snip and paste the URL:</span>
                  <Code text={url} label="MCP URL" />
                </>,
                <span>Choose Connect and finish the sign-in.</span>,
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
            The first time, your client opens GitHub sign-in and a consent screen. Only allowed GitHub accounts get in.
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
