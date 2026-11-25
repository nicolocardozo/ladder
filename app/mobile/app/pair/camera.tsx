import { useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { Linking } from 'react-native'
import { t } from '@shared/i18n'
import { PairStep } from '@/features/pair/PairStep'
import { Button } from '@/ui/Button'

/** Explanation of the camera permission, before the system request. */
export default function CameraStep() {
  const router = useRouter()
  const [permission, request] = useCameraPermissions()
  const denied = permission && !permission.granted && !permission.canAskAgain
  return (
    <PairStep
      icon="camera"
      step={t('Step 1 of 4')}
      title={t('Scan the code on your Mac')}
      body={t('On your Mac, open Ladder and choose Settings → Phone. Ladder uses the camera only to read that code. Nothing is recorded or saved.')}
      actions={
        <>
          <Button
            label={denied ? t('Open Settings') : permission?.granted ? t('Continue') : t('Allow camera')}
            variant="primary"
            onPress={async () => {
              if (denied) return void Linking.openSettings()
              if (!permission?.granted) {
                const r = await request()
                if (!r.granted) return
              }
              router.push('/pair/scan')
            }}
          />
          {__DEV__ ? <Button label={t('Connect manually (development)')} variant="quiet" onPress={() => router.push('/connect-manual')} /> : null}
        </>
      }
    />
  )
}
