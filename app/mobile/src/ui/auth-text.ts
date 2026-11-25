// (Translated) texts for pairing errors. The host sends its own text in the Mac's language: here it is used only as a fallback.
import { t } from '@shared/i18n'
import type { RemoteAuthErrorCode } from '@shared/protocol'

export function authMessage(code: RemoteAuthErrorCode, hostError?: string): string {
  switch (code) {
    case 'bad-token':
      return t('This code is not valid anymore. Ask your Mac for a new code.')
    case 'token-expired':
      return t('This code has expired. Ask your Mac for a new code.')
    case 'token-used':
      return t('This code was already used. Ask your Mac for a new code.')
    case 'too-many-attempts':
      return t('Too many attempts. Ask your Mac for a new code.')
    case 'password-required':
      return t('Enter the password you set on your Mac.')
    case 'wrong-password':
      return t('Wrong password. Try again.')
    case 'device-revoked':
    case 'unknown-device':
      return t('This phone was disconnected from your Mac.')
    case 'bad-signature':
      return t('Your Mac could not verify this phone. Pair again.')
    case 'remote-disabled':
      return t('Access from your phone is turned off on your Mac.')
    case 'invalid-request':
      return hostError || t('Something went wrong. Try again.')
  }
}

/** Text for a pairing link that cannot be used. */
export function linkErrorText(reason: 'invalid' | 'expired' | 'no-relay'): string {
  switch (reason) {
    case 'expired':
      return t('This code has expired. Ask your Mac for a new code.')
    case 'no-relay':
      return t('This code cannot be used with this version of Ladder. Update Ladder on your Mac and try again.')
    default:
      return t('This is not a Ladder pairing code.')
  }
}
