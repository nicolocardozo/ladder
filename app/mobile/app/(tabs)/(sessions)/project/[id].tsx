import { Stack, useLocalSearchParams } from 'expo-router'
import { View } from 'react-native'
import { plural } from '@shared/i18n'
import { ProjectSessions } from '@/features/sessions/ProjectSessions'
import { useApp } from '@/store/app'
import { useLanguage } from '@/store/prefs'
import { Text } from '@/ui/Text'

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  useLanguage()
  const project = useApp((s) => s.projects.find((p) => p.id === id))
  const count = useApp((s) => Object.values(s.sessions).filter((x) => x.projectId === id && !x.archived).length)
  const subtitle = [project?.branch, plural(count, '1 session', '{n} sessions')].filter(Boolean).join(' · ')
  return (
    <>
      <Stack.Screen options={{ title: project?.name ?? '', headerLargeTitleEnabled: false }} />
      <ProjectSessions
        projectId={id}
        header={
          <View style={{ paddingHorizontal: 20, paddingBottom: 4 }}>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        }
      />
    </>
  )
}
