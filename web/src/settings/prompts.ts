// The Copy-prompt buttons use the same text as the MCP prompts, so neither surface can
// drift from the other (contracts §6). Only clipboard handling lives here.
import { PULL_CLOUD_PROMPT, SETUP_CLOUD_PROMPT } from "../../shared/cloud-prompts"
import { copyToClipboard } from "@/lib/utils"

export const setupPrompt = () => SETUP_CLOUD_PROMPT
export const pullPrompt = () => PULL_CLOUD_PROMPT

export async function copyText(text: string): Promise<boolean> {
  if (await copyToClipboard(text)) return true
  try {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.top = "-1000px"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand("copy")
    area.remove()
    return copied
  } catch {
    return false
  }
}
