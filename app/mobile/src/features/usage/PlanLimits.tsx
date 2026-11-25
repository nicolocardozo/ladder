// "Plan limits" screen: one subscription per section, with its usage windows, reset time in local time and how
// old the data is. Pulling down re-reads every account (`agents.usage`; the host does at most one real read per minute per account,
// the rest comes from its cache and the data time says so).
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { t } from '@shared/i18n'
import type { AgentId } from '@shared/protocol'
import { accountsToRead, readAll, type UsageRead } from '@/host/usage'
import { canAct } from '@/host/controller'
import { useNow } from '@/lib/use-now'
import { accountName, buildUsageAccounts, liveWindows, updatedLabel, usageAlert, usageAlertText, type UsageAccount } from '@/lib/usage'
import { useApp } from '@/store/app'
import { useTheme } from '@/theme/theme'
import { RADIUS } from '@/theme/type'
import { AgentMark } from '@/ui/AgentMark'
import { IconButton } from '@/ui/Button'
import { Text } from '@/ui/Text'
import { AlertGlyph, AlertNote, UsageRow } from './UsageBits'

export function PlanLimits() {
  const { c } = useTheme()
  const params = useLocalSearchParams<{ agent?: string; profileId?: string }>()
  const agents = useApp((s) => s.agents)
  const profiles = useApp((s) => s.profiles)
  const online = useApp((s) => canAct(s.conn))
  const now = useNow(30_000)
  const current = params.agent ? { agent: params.agent as AgentId, profileId: params.profileId || null } : null
  const accounts = useMemo(() => buildUsageAccounts(agents, profiles, current), [agents, profiles, current?.agent, current?.profileId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [refreshing, setRefreshing] = useState(false)
  const [failed, setFailed] = useState<Set<string>>(new Set())
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts

  const run = useCallback(async (all: boolean) => {
    const list = accountsToRead(accountsRef.current, all)
    if (!list.length) return
    setRefreshing(true)
    const results: Record<string, UsageRead> = await readAll(list)
    setFailed(new Set(Object.entries(results).filter(([, r]) => r === 'error').map(([k]) => k)))
    setRefreshing(false)
  }, [])

  // On open: only accounts never read or with stale data.
  useEffect(() => {
    if (online) void run(false)
  }, [online, run])

  return (
    <>
      <Stack.Screen
        options={{
          title: t('Plan limits'),
          headerRight: () => <IconButton icon="refresh" label={t('Refresh all usage')} onPress={() => void run(true)} disabled={refreshing || !online} />
        }}
      />
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void run(true)} tintColor={c.textMuted} colors={[c.accent]} progressBackgroundColor={c.surface} />}
      >
        {accounts.length === 0 ? (
          <View style={{ paddingTop: 48, alignItems: 'center', gap: 6 }}>
            <Text variant="title">{t('No subscriptions linked')}</Text>
            <Text variant="body" tone="muted" style={{ textAlign: 'center' }}>
              {t('Sign in to Claude Code or Codex on your Mac and their plan limits show up here.')}
            </Text>
          </View>
        ) : null}
        {accounts.map((account) => (
          <AccountCard key={account.key} account={account} now={now} refreshing={refreshing} failed={failed.has(account.key)} />
        ))}
        {!online && accounts.length > 0 ? (
          <Text variant="caption" tone="muted" style={{ textAlign: 'center' }}>
            {t('Reconnect to your Mac to update the limits.')}
          </Text>
        ) : null}
      </ScrollView>
    </>
  )
}

function AccountCard({ account, now, refreshing, failed }: { account: UsageAccount; now: number; refreshing: boolean; failed: boolean }) {
  const { c } = useTheme()
  const name = accountName(account)
  const windows = liveWindows(account.status?.usage, now)
  const alert = usageAlert(windows)
  const alertText = alert ? usageAlertText(alert, now) : null
  const empty = !account.native ? t('Usage isn’t available for this agent.') : refreshing ? t('Reading your plan limits…') : t('No usage data yet. It appears after the first reply.')
  return (
    <View accessibilityRole="summary" style={{ borderRadius: RADIUS.lg, backgroundColor: c.surface, padding: 16, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <AgentMark agent={account.agent} size={18} color={c.text} />
        <View style={{ flex: 1 }}>
          <Text variant="title" numberOfLines={1} accessibilityRole="header">
            {name}
          </Text>
          {account.native ? (
            <Text variant="caption" tone="muted">
              {failed ? `${t('Update failed')} · ${updatedLabel(account.status?.usageAt, now)}` : updatedLabel(account.status?.usageAt, now)}
            </Text>
          ) : null}
        </View>
        {alert && alertText ? (
          <View accessible accessibilityRole="image" accessibilityLabel={alertText.what}>
            <AlertGlyph limited={alert.limited} size={20} />
          </View>
        ) : null}
      </View>
      {account.current && alert && alertText ? <AlertNote alert={alert} text={alertText} /> : null}
      {windows.length > 0 ? (
        windows.map((usage) => <UsageRow key={usage.key} usage={usage} now={now} />)
      ) : (
        <Text variant="body" tone="muted">
          {empty}
        </Text>
      )}
    </View>
  )
}
