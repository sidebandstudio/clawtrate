// When the app's content is covered: whenever it is not active. iOS takes the
// app switcher's snapshot as the app becomes inactive, so the cover is already
// up when the picture is taken. Pure, so the unit tests cover it.

export function covered(state: string | null | undefined): boolean {
  return state !== "active";
}
