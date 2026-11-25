// Costanti del canale remoto senza dipendenze: le usano sia Noise sia il relay (il Worker non deve portarsi dietro le librerie di cifratura).

/** Massimo di un messaggio Noise (handshake o trasporto), tag compreso. */
export const NOISE_MAX_MESSAGE = 65535
