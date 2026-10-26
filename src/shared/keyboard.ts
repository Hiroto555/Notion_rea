export function composing(
  event: { isComposing?: boolean; keyCode?: number },
  active = false,
) {
  return active || !!event.isComposing || event.keyCode === 229;
}
