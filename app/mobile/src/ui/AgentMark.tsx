// Provider icon next to the model: Claude, Codex; for ACP agents the initial in a circle.
import Svg, { Path } from 'react-native-svg'
import { View } from 'react-native'
import type { AgentId } from '@shared/protocol'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { Text } from './Text'
import { CLAUDE_CODE_PATHS, CODEX_PATHS } from './agent-paths'

export function AgentMark({ agent, size = 14, color }: { agent: AgentId; size?: number; color?: string }) {
  const { c } = useTheme()
  const name = useApp((s) => s.agents.find((a) => a.agent === agent)?.name)
  const fill = color ?? c.textMuted
  if (agent === 'claude-code' || agent === 'codex') {
    const paths = agent === 'claude-code' ? CLAUDE_CODE_PATHS : CODEX_PATHS
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill} accessibilityElementsHidden importantForAccessibility="no">
        {paths.map((d, i) => (
          <Path key={i} d={d} fillRule="evenodd" clipRule="evenodd" />
        ))}
      </Svg>
    )
  }
  const initial = (name ?? agent.replace(/^acp:/, '')).trim().charAt(0).toUpperCase()
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: fill, alignItems: 'center', justifyContent: 'center' }}>
      <Text variant="caption" style={{ fontSize: Math.round(size * 0.62), lineHeight: size, color: c.background, fontFamily: 'MonaSans-SemiBold' }} allowFontScaling={false}>
        {initial}
      </Text>
    </View>
  )
}

/** Readable model label: "Opus 4.7". */
export function useModelLabel(agent: AgentId, model: string | null): string {
  const label = useApp((s) => s.agents.find((a) => a.agent === agent)?.models.find((m) => m.id === model)?.label)
  const fallback = useApp((s) => s.agents.find((a) => a.agent === agent)?.models.find((m) => m.isDefault)?.label)
  return label ?? (model ? model : (fallback ?? ''))
}
