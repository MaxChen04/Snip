import { notify } from "@/components/notify"
import type { DesignTokens } from "../../shared/types"
import { cn } from "@/lib/utils"

const copy = (v: string) => {
  void navigator.clipboard?.writeText(v)
  notify(`Copied ${v}`)
}

export function TokensPanel({ tokens, compact }: { tokens: DesignTokens; compact?: boolean }) {
  const n = compact ? 12 : 32
  const vars = Object.entries(tokens.cssVariables ?? {})
  return (
    <div className={cn("grid gap-8", !compact && "lg:grid-cols-2")}>
      <Section title="Colors">
        <div className={cn("grid gap-2", compact ? "grid-cols-4" : "grid-cols-4 sm:grid-cols-6 lg:grid-cols-8")}>
          {tokens.colors.slice(0, n * 2).map((c) => (
            <button key={c.value} onClick={() => copy(c.value)} className="group min-w-0 text-left" title={`${c.value} (${c.count})`}>
              <div className="aspect-square rounded-lg ring-1 ring-border" style={{ background: c.value }} />
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground group-hover:text-foreground">{c.value}</div>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Typography">
        <div className="space-y-3">
          {tokens.fonts.slice(0, 6).map((f) => (
            <button key={f.family} onClick={() => copy(f.family)} className="block w-full text-left">
              <div className="truncate text-lg" style={{ fontFamily: f.family }}>
                {f.family.split(",")[0]?.replace(/["']/g, "")}
              </div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">{f.family}</div>
            </button>
          ))}
          <ValueList items={tokens.fontSizes.slice(0, n)} />
        </div>
      </Section>

      <Section title="Spacing">
        <div className="space-y-1">
          {tokens.spacing.slice(0, n).map((s) => (
            <button key={s.value} onClick={() => copy(s.value)} className="flex w-full items-center gap-3 text-left">
              <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">{s.value}</span>
              <span className="h-2 rounded-xs bg-primary/60" style={{ width: `min(${s.value}, 100%)` }} />
            </button>
          ))}
        </div>
      </Section>

      <Section title="Radii & shadows">
        <div className="flex flex-wrap gap-3">
          {tokens.radii.slice(0, 10).map((r) => (
            <button key={r.value} onClick={() => copy(r.value)} className="text-center">
              <div className="size-12 bg-fill-2 ring-1 ring-border" style={{ borderRadius: r.value }} />
              <div className="mt-1 font-mono text-[10px] text-muted-foreground">{r.value}</div>
            </button>
          ))}
        </div>
        <div className="mt-4 grid gap-3">
          {tokens.shadows.slice(0, compact ? 4 : 8).map((s) => (
            <button key={s.value} onClick={() => copy(s.value)} className="flex items-center gap-3 text-left">
              <div className="size-10 shrink-0 rounded-lg bg-card" style={{ boxShadow: s.value }} />
              <span className="line-clamp-2 font-mono text-[10px] text-muted-foreground">{s.value}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Motion">
        <ValueList items={tokens.transitions.slice(0, n)} mono />
        {tokens.keyframes.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tokens.keyframes.slice(0, 40).map((k) => (
              <span key={k} className="rounded-md bg-fill-2 px-1.5 py-0.5 font-mono text-[10px]">
                @keyframes {k}
              </span>
            ))}
          </div>
        )}
      </Section>

      {vars.length > 0 && (
        <Section title={`CSS variables (${vars.length})`}>
          <div className="max-h-80 overflow-y-auto rounded-lg bg-fill-1 p-3 font-mono text-[11px] leading-relaxed">
            {vars.slice(0, 300).map(([k, v]) => (
              <div key={k} className="truncate">
                <span className="text-primary">{k}</span>: {v};
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-xs font-medium text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

function ValueList({ items, mono }: { items: { value: string; count: number }[]; mono?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((i) => (
        <button
          key={i.value}
          onClick={() => copy(i.value)}
          className={cn("max-w-full truncate rounded-md bg-fill-2 px-1.5 py-0.5 text-[11px] hover:bg-fill-3", mono && "font-mono")}
          title={`${i.count} uses`}
        >
          {i.value}
        </button>
      ))}
    </div>
  )
}
