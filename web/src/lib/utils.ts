export { cn } from "cn"

/** True once the text is on the clipboard; false when the browser refuses it or has no clipboard API. */
export const copyToClipboard = (text: string) =>
  (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => true, () => false)
