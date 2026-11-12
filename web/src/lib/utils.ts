export { cn } from "cn"

/** True once the text is on the clipboard; false when the browser refuses it or has no clipboard API. */
export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
