import { CheckIcon } from "@/components/icons"
import { toast } from "sonner"
import { fileUrl } from "@/lib/api"

/** Confirmation toast: a raised overlay pill with an optional thumbnail and one action. */
export function notify(
  text: string,
  opts: { thumbKey?: string | null; action?: { label: string; onClick: () => void }; position?: "top-center" | "bottom-center" } = {},
) {
  toast.custom(
    (id) => (
      <div className="surface-raised flex h-10 items-center gap-2.5 rounded-full bg-popover py-1 pr-1 pl-1 text-xs text-foreground shadow-menu">
        {opts.thumbKey ? (
          <img src={fileUrl(opts.thumbKey)} alt="" className="size-8 rounded-full object-cover object-top shadow-button" />
        ) : (
          <span className="grid size-8 place-items-center rounded-full bg-(--green-3) text-(--green-11) shadow-badge">
            <CheckIcon className="size-4" />
          </span>
        )}
        <span className={opts.action ? "pr-1 font-medium whitespace-nowrap" : "pr-3 font-medium whitespace-nowrap"}>{text}</span>
        {opts.action ? (
          <button
            onClick={() => {
              opts.action!.onClick()
              toast.dismiss(id)
            }}
            className="tactile press h-8 rounded-full px-3.5 text-xs font-medium"
          >
            {opts.action.label}
          </button>
        ) : null}
      </div>
    ),
    { duration: 4000, unstyled: true, position: opts.position, className: "flex! justify-center! w-full!" },
  )
}
