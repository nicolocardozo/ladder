// Badge "Default": marca il modello o il livello di effort con cui parte una sessione. Il tooltip dice da dove viene.
import { t } from '@shared/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { defaultSourceHint, type DefaultSource } from '@/lib/effective-defaults'

export function DefaultBadge({ source, agentName }: { source: DefaultSource | null; agentName: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span />} className="inline-flex h-4 shrink-0 items-center rounded-sm bg-foreground/10 px-1 text-xs leading-none text-muted-foreground">
        {t('Default')}
      </TooltipTrigger>
      <TooltipContent side="top">{defaultSourceHint(source, agentName)}</TooltipContent>
    </Tooltip>
  )
}
