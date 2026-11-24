// Codici d'errore dell'autenticazione (RemoteAuthErrorCode) → cosa deve poter fare l'utente. Il testo lo compone la UI con t();
// quello dell'host è nella lingua del Mac e resta solo come ripiego. Solo logica pura.
import type { RemoteAuthErrorCode } from '../../../desktop/src/shared/protocol.ts'

export type AuthNext =
  /** Il codice QR non serve più: serve un codice nuovo dal Mac. */
  | 'new-code'
  /** Riprova con la password. */
  | 'password'
  /** L'abbinamento non vale più: si abbina da capo. */
  | 'pair-again'
  /** Niente da fare adesso: riprovare più tardi. */
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
