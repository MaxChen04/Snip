import { CheckIcon } from "lucide-react"
import { toast } from "sonner"
import { fileUrl } from "@/lib/api"

/** Cosmos-style confirmation: a dark pill with an optional thumbnail and one action. */
export function notify(text: string, opts: { thumbKey?: string | null; action?: { label: string; onClick: () => void } } = {}) {
  toast.custom(
    (id) => (
      <div className="flex h-11 items-center gap-2.5 rounded-full bg-neutral-900 py-1.5 pr-1.5 pl-1.5 text-sm text-white shadow-lg ring-1 ring-white/10 dark:bg-neutral-100 dark:text-neutral-900 dark:ring-black/10">
        {opts.thumbKey ? (
          <img src={fileUrl(opts.thumbKey)} alt="" className="size-8 rounded-full object-cover object-top" />
        ) : (
          <span className="size-8 rounded-full bg-gradient-to-br from-primary/80 to-fuchsia-400/80" />
        )}
        <span className="pr-1 font-medium whitespace-nowrap">{text}</span>
        {opts.action ? (
          <button
            onClick={() => {
              opts.action!.onClick()
              toast.dismiss(id)
            }}
            className="h-8 rounded-full bg-white/15 px-3.5 text-xs font-medium hover:bg-white/25 dark:bg-black/10 dark:hover:bg-black/20"
          >
            {opts.action.label}
          </button>
        ) : (
          <span className="grid size-8 place-items-center rounded-full bg-white text-neutral-900 dark:bg-neutral-900 dark:text-white">
            <CheckIcon className="size-4" />
          </span>
        )}
      </div>
    ),
    { duration: 4000, unstyled: true, className: "flex! justify-center! w-full!" },
  )
}
