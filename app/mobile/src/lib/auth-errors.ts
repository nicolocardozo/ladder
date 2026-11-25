// Authentication error codes (RemoteAuthErrorCode) → what the user must be able to do. The text is composed by the UI with t();
// the host's is in the Mac's language and stays only as a fallback. Pure logic only.
import type { RemoteAuthErrorCode } from '../../../desktop/src/shared/protocol.ts'

export type AuthNext =
  /** The QR code is no longer valid: a new code from the Mac is needed. */
  | 'new-code'
  /** Retry with the password. */
  | 'password'
  /** The pairing is no longer valid: pair again from scratch. */
  | 'pair-again'
  /** Nothing to do now: retry later. */
  | 'later'

export function authNext(code: RemoteAuthErrorCode): AuthNext {
  switch (code) {
    case 'bad-token':
    case 'token-expired':
    case 'token-used':
    case 'too-many-attempts':
      return 'new-code'
    case 'password-required':
    case 'wrong-password':
      return 'password'
    case 'device-revoked':
    case 'unknown-device':
    case 'bad-signature':
      return 'pair-again'
    case 'remote-disabled':
    case 'invalid-request':
      return 'later'
  }
}
