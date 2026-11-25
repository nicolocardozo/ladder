// Dependency-free remote channel constants: used by both Noise and the relay (the Worker must not drag along the encryption libraries).

/** Massimo di un messaggio Noise (handshake o trasporto), tag compreso. */
export const NOISE_MAX_MESSAGE = 65535
