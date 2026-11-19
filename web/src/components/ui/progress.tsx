import { cn } from "cn"

/**
 * Progress: how far a run has got. `value` is the share done, 0 to 1, or null when the run has no share to report yet,
 * which sweeps a segment along the track. Any share above 0 shows at least a sliver. The one bar in the app; see the
 * loading notes in index.css.
 */
function Progress({ value, paused, label, className }: { value: number | null; paused?: boolean; label: string; className?: string }) {
  // Rounded down to a tenth, never up: 199 of 200 pages is 99.5, and only a finished run reads 100.
  const percent = value === null ? null : Math.floor(Math.min(1, Math.max(0, value)) * 1000) / 10
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={cn("h-1 overflow-hidden rounded-full bg-ink-4", className)}
    >
      {percent === null ? (
        <div data-slot="progress-sweep" className="progress-sweep h-full rounded-full" />
      ) : percent > 0 ? (
        <div
          className={cn("h-full rounded-full transition-[width] duration-300 ease-(--ease-out) motion-reduce:transition-none", paused ? "bg-ink-9" : "bg-ink-12")}
          style={{ width: `${Math.max(4, percent)}%` }}
        />
      ) : null}
    </div>
  )
}

export { Progress }
