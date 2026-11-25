// Access from the phone stays hidden in packaged builds until the phone app is in the stores and the hosted relay
// is live: until then the default relay address is a placeholder. Development builds always have it.
export const PHONE_ACCESS_RELEASED = false

export function phoneAccessAllowed(packaged: boolean): boolean {
  return PHONE_ACCESS_RELEASED || !packaged
}
