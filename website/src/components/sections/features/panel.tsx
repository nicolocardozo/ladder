import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// Dark Circuit panel inside the cards' visual area
export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "absolute overflow-hidden rounded-xl bg-c-bg text-[12.5px] leading-[1.4] text-c-text shadow-[0_0_0_1px_rgb(24_20_36/0.9),0_24px_50px_-16px_rgb(60_30_160/0.45)]",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function PanelHead({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-[38px] items-center gap-2 border-b border-c-line px-3.5 font-medium">
      {children}
      {right ? <span className="ml-auto text-[11.5px] font-normal text-c-muted">{right}</span> : null}
    </div>
  )
}
