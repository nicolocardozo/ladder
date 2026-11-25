// "Agent activity" widget: how many sessions are working and how many are waiting for you, with the titles of the waiting ones.
// Home Screen (small, medium) and Lock Screen (rectangular, inline). Runs in the extension, without network and without the module's
// scope: it reads only the properties the app writes to the shared group (`props`, including already translated texts). After ten minutes
// without updates the timeline goes `stale` on its own and the widget writes its age instead of claiming what is happening.
import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui'
import { containerBackground, font, foregroundStyle, frame, lineLimit, monospacedDigit, resizable, widgetURL } from '@expo/ui/swift-ui/modifiers'
import { createWidget, type WidgetEnvironment } from 'expo-widgets'
import type { WidgetProps } from '@/lib/widget-snapshot'

export function AgentActivityWidget(published: Partial<WidgetProps> | undefined, environment: WidgetEnvironment) {
  'widget'
  const family = environment.widgetFamily
  const accessory = family === 'accessoryRectangular' || family === 'accessoryInline'
  const inline = family === 'accessoryInline'
  const small = family === 'systemSmall'
  const light = environment.colorScheme === 'light'
  // Lock Screen and "tinted" widget: a single color, so shape and label make the difference.
  const mono = environment.widgetRenderingMode === 'accented' || environment.widgetRenderingMode === 'vibrant' || accessory
  const primary = { type: 'hierarchical', style: 'primary' } as const
  const secondary = { type: 'hierarchical', style: 'secondary' } as const

  const props = published ?? {}
  const loaded = props.text !== undefined && props.working !== undefined
  const text = props.text ?? { working: 'Working', waiting: 'Waiting', quiet: 'All quiet', updated: 'Updated', open: 'Open Ladder', offline: 'Offline' }
  const working = props.working ?? 0
  const waiting = props.waiting ?? 0
  const stale = props.stale === true
  const top = props.top ?? []
  const workingTint = stale || mono ? secondary : light ? '#5E6B00' : '#ECFC7F'
  const waitingTint = stale || mono ? primary : light ? '#B45309' : '#FDBB69'
  const background = accessory ? 'clear' : light ? '#FFFFFF' : '#181424'
  const modifiers = [containerBackground(background, 'widget'), widgetURL(props.link ?? 'ladder://')]

  const symbol = (name: 'circle.dashed' | 'exclamationmark.triangle.fill', size: number, color: string | typeof primary | typeof secondary) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(color)]}>
      <Image systemName={name} modifiers={[resizable()]} />
    </HStack>
  )
  const count = (kind: 'working' | 'waiting', size: number) => {
    const n = kind === 'working' ? working : waiting
    const color = kind === 'working' ? workingTint : waitingTint
    return (
      <HStack spacing={5} alignment="center">
        {symbol(kind === 'working' ? 'circle.dashed' : 'exclamationmark.triangle.fill', size, color)}
        <Text modifiers={[font({ weight: 'bold', size }), monospacedDigit(), foregroundStyle(n > 0 && !stale ? primary : secondary)]}>{String(n)}</Text>
        <Text modifiers={[font({ weight: 'medium', size: size * 0.62 }), foregroundStyle(color), lineLimit(1)]}>{kind === 'working' ? text.working : text.waiting}</Text>
      </HStack>
    )
  }
  // "Updated 12 min ago": written by the phone for each timeline entry (in the chosen language).
  const age = props.agoLabel ? <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>{props.agoLabel}</Text> : null
  const footer = !loaded ? (
    <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>{text.open}</Text>
  ) : stale || props.connected === false ? (
    stale ? age : <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>{text.offline}</Text>
  ) : null
  const quiet = loaded && working === 0 && waiting === 0

  if (inline) {
    const line = !loaded ? text.open : quiet ? text.quiet : `${working} ${text.working} · ${waiting} ${text.waiting}`
    return (
      <HStack modifiers={modifiers}>
        <Text>{line}</Text>
      </HStack>
    )
  }

  if (accessory) {
    return (
      <VStack alignment="leading" spacing={2} modifiers={modifiers}>
        <Text modifiers={[font({ weight: 'semibold', size: 12 }), foregroundStyle(primary), lineLimit(1)]}>Ladder</Text>
        {!loaded ? (
          <Text modifiers={[font({ size: 12 }), foregroundStyle(secondary), lineLimit(1)]}>{text.open}</Text>
        ) : (
          <HStack spacing={10} alignment="center">
            {count('working', 15)}
            {count('waiting', 15)}
            <Spacer minLength={0} />
          </HStack>
        )}
        {waiting > 0 && top[0] ? <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>{top[0].title}</Text> : stale ? age : null}
      </VStack>
    )
  }

  const rows = top.slice(0, small ? 1 : 3)
  return (
    <VStack alignment="leading" spacing={small ? 6 : 8} modifiers={modifiers}>
      <HStack spacing={5} alignment="center">
        <HStack modifiers={[frame({ width: 15, height: 10 }), foregroundStyle(light ? '#5525CF' : '#AC97FF')]}>
          <Image assetName="LadderMark" modifiers={[resizable()]} />
        </HStack>
        <Text modifiers={[font({ weight: 'semibold', size: 12 }), foregroundStyle(secondary)]}>Ladder</Text>
        <Spacer minLength={0} />
      </HStack>
      {loaded && !quiet ? (
        small ? (
          <VStack alignment="leading" spacing={3}>
            {count('working', 18)}
            {count('waiting', 18)}
          </VStack>
        ) : (
          <HStack spacing={18} alignment="center">
            {count('working', 22)}
            {count('waiting', 22)}
            <Spacer minLength={0} />
          </HStack>
        )
      ) : (
        <Text modifiers={[font({ weight: 'semibold', size: 15 }), foregroundStyle(primary), lineLimit(2)]}>{quiet ? text.quiet : text.open}</Text>
      )}
      {rows.length > 0 ? (
        <VStack alignment="leading" spacing={3}>
          {rows.map((row, i) => (
            <VStack key={`${row.id}:${i}`} alignment="leading" spacing={0}>
              <Text modifiers={[font({ weight: 'semibold', size: 13 }), foregroundStyle(primary), lineLimit(1)]}>{row.title}</Text>
              {!small && row.project ? <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>{row.project}</Text> : null}
            </VStack>
          ))}
        </VStack>
      ) : null}
      <Spacer minLength={0} />
      {footer}
    </VStack>
  )
}

export default createWidget<Partial<WidgetProps>>('AgentActivity', AgentActivityWidget)
