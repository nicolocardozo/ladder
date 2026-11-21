import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Kbd } from '@/components/ui/kbd'

interface IconButtonProps {
  icon: LucideIcon
  label: string
  shortcut?: string
  onClick?: () => void
  className?: string
}

/** Pulsante con sola icona, sempre con etichetta accessibile e tooltip. */
export function IconButton({ icon: Icon, label, shortcut, onClick, className }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={label}
        onClick={onClick}
        className={cn(
          'no-drag grid size-7 place-items-center rounded-md text-muted-foreground transition-colors',
          'hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 outline-none',
          className
        )}
      >
        <Icon className="size-[15px]" strokeWidth={1.75} />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {shortcut && <Kbd className="ml-1.5">{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
