// Layout of a session's Live Activity: lock screen and Dynamic Island. Runs in the native extension
// (ExpoWidgetsTarget), which evaluates this function without the module's scope: inside, only the factories imported above are used
// and texts arrive already translated in the props (`props.text`). Colors: Ladder's three-signal rule (citron working, amber waiting,
// rose error, mint done) always accompanied by shape and label; background and text are the system's.
import { HStack, Image, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui'
import { font, foregroundStyle, frame, lineLimit, minimumScaleFactor, monospacedDigit, padding, resizable, widgetURL } from '@expo/ui/swift-ui/modifiers'
import { createLiveActivity, type LiveActivityEnvironment, type LiveActivityLayout } from 'expo-widgets'
import type { ActivityProps } from '@/lib/live-activity'

function SessionActivity(props: ActivityProps, environment: LiveActivityEnvironment): LiveActivityLayout {
  'widget'
  // On iPhone the Live Activity material is dark even when the environment says "light" (lock screen): always the dark palette.
  const light = false
  const stale = environment.isStale === true && (props.phase === 'running' || props.phase === 'waiting')
  const primary = { type: 'hierarchical', style: 'primary' } as const
  const secondary = { type: 'hierarchical', style: 'secondary' } as const
  // Citron, amber, mint and rose of the Circuit theme on the dark background; dark variants on light (readable without the system blue).
  const tint = stale ? secondary : props.phase === 'running' ? (light ? '#5E6B00' : '#ECFC7F') : props.phase === 'waiting' ? (light ? '#B45309' : '#FDBB69') : props.phase === 'error' ? (light ? '#BE123C' : '#FDA4AE') : light ? '#0F766E' : '#8CE9B7'
  const accent = light ? '#5525CF' : '#AC97FF'
  const symbol = props.phase === 'running' ? 'circle.dashed' : props.phase === 'waiting' ? 'exclamationmark.triangle.fill' : props.phase === 'error' ? 'xmark.square.fill' : 'checkmark.circle.fill'
  const label = stale ? props.text.stale : props.phase === 'running' ? props.text.running : props.phase === 'waiting' ? props.text.waiting : props.phase === 'error' ? props.text.error : props.text.done
  const running = props.phase === 'running' || props.phase === 'waiting'
  const subtitle = [props.project, props.steps].filter((x) => !!x).join(' · ')
  const link = widgetURL(props.link)

  // Images (SF Symbols and marks) ignore the frame and color applied to them: they are sized and tinted from the container.
  const glyph = (size: number, color: string | typeof secondary) => (
    <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(color)]}>
      <Image systemName={symbol} modifiers={[resizable()]} />
    </HStack>
  )
  const mark = (size: number) =>
    props.mark === 'other' ? (
      <ZStack modifiers={[frame({ width: size, height: size })]}>
        <Text modifiers={[font({ weight: 'bold', size: size * 0.75 }), foregroundStyle(accent)]}>{props.initial}</Text>
      </ZStack>
    ) : (
      <HStack modifiers={[frame({ width: size, height: size }), foregroundStyle(accent)]}>
        <Image assetName={props.mark === 'claude' ? 'ClaudeMark' : 'CodexMark'} modifiers={[resizable()]} />
      </HStack>
    )
  // Timer that counts on its own while working or waiting; at end of turn, the duration written by the phone.
  const clock = (size: number, width: number) =>
    running ? (
      <Text date={new Date(props.startedAt)} dateStyle="timer" modifiers={[font({ size }), monospacedDigit(), foregroundStyle(secondary), lineLimit(1), frame({ width, alignment: 'trailing' })]} />
    ) : (
      <Text modifiers={[font({ size }), monospacedDigit(), foregroundStyle(secondary), lineLimit(1)]}>{props.took ?? ''}</Text>
    )

  return {
    banner: (
      <VStack alignment="leading" spacing={8} modifiers={[padding({ all: 14 }), link]}>
        <HStack spacing={8} alignment="center">
          {mark(20)}
          <VStack alignment="leading" spacing={1}>
            <Text modifiers={[font({ weight: 'semibold', size: 16 }), foregroundStyle(primary), lineLimit(1)]}>{props.title}</Text>
            {subtitle ? <Text modifiers={[font({ size: 12 }), foregroundStyle(secondary), lineLimit(1)]}>{subtitle}</Text> : null}
          </VStack>
          <Spacer minLength={4} />
          {clock(14, 84)}
        </HStack>
        <HStack spacing={6} alignment="center">
          {glyph(15, tint)}
          <Text modifiers={[font({ weight: 'semibold', size: 14 }), foregroundStyle(tint), lineLimit(1)]}>{label}</Text>
          {props.detail && !stale ? <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary), lineLimit(1)]}>{props.detail}</Text> : null}
          <Spacer minLength={0} />
        </HStack>
      </VStack>
    ),
    bannerSmall: (
      <HStack spacing={8} alignment="center" modifiers={[padding({ all: 10 }), link]}>
        {glyph(16, tint)}
        <VStack alignment="leading" spacing={0}>
          <Text modifiers={[font({ weight: 'semibold', size: 13 }), foregroundStyle(primary), lineLimit(1)]}>{props.title}</Text>
          <Text modifiers={[font({ size: 11 }), foregroundStyle(tint), lineLimit(1)]}>{label}</Text>
        </VStack>
        <Spacer minLength={0} />
      </HStack>
    ),
    compactLeading: <HStack modifiers={[padding({ leading: 4 }), link]}>{glyph(16, tint)}</HStack>,
    compactTrailing: <HStack modifiers={[padding({ trailing: 4 }), link]}>{clock(12, 38)}</HStack>,
    minimal: <HStack modifiers={[link]}>{glyph(16, tint)}</HStack>,
    expandedLeading: <HStack modifiers={[padding({ leading: 6 }), link]}>{mark(26)}</HStack>,
    expandedTrailing: <HStack modifiers={[padding({ trailing: 6 }), link]}>{clock(15, 76)}</HStack>,
    expandedCenter: (
      <VStack alignment="leading" spacing={1} modifiers={[link]}>
        <Text modifiers={[font({ weight: 'semibold', size: 15 }), foregroundStyle(primary), lineLimit(1), minimumScaleFactor(0.8)]}>{props.title}</Text>
        {subtitle ? <Text modifiers={[font({ size: 12 }), foregroundStyle(secondary), lineLimit(1)]}>{subtitle}</Text> : null}
      </VStack>
    ),
    expandedBottom: (
      <HStack spacing={6} alignment="center" modifiers={[link]}>
        {glyph(15, tint)}
        <Text modifiers={[font({ weight: 'semibold', size: 14 }), foregroundStyle(tint), lineLimit(1)]}>{label}</Text>
        {props.detail && !stale ? <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary), lineLimit(1)]}>{props.detail}</Text> : null}
        <Spacer minLength={0} />
      </HStack>
    )
  }
}

export default createLiveActivity<ActivityProps>('SessionActivity', SessionActivity)
