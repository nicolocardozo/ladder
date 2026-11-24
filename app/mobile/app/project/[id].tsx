import { useLocalSearchParams } from 'expo-router'
import { View } from 'react-native'
import { plural } from '@shared/i18n'
import { ProjectSessions } from '@/features/sessions/ProjectSessions'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { ScreenHeader } from '@/ui/ScreenHeader'

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useTheme()
  const project = useApp((s) => s.projects.find((p) => p.id === id))
  const count = useApp((s) => Object.values(s.sessions).filter((x) => x.projectId === id && !x.archived).length)
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title={project?.name ?? ''} subtitle={[project?.branch, plural(count, '1 session', '{n} sessions')].filter(Boolean).join(' · ')} />
      <ProjectSessions projectId={id} />
    </View>
  )
}
