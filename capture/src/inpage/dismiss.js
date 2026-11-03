// Evaluated in the captured page (and its frames): close cookie banners, consent walls and
// newsletter popups so screenshots show the actual design.
// Pass 1 clicks an "accept"/"close" control inside something that looks like a popup.
// Pass 2 hides whatever popup chrome is left (including closed shadow roots it can't click into).
// Returns how many things it clicked and hid.
(opts) => {
  const hideOnly = !!(opts && opts.hideOnly)
  const POPUP = /cookie|consent|gdpr|ccpa|cmp|privacy|axeptio|onetrust|optanon|didomi|usercentrics|cookiebot|cybot|truste|osano|termly|iubenda|klaro|tarteaucitron|qc-cmp|sp_message|sp-message|fc-consent|cookieyes|cky-|complianz|borlabs|moove|cc-window|cc-banner|newsletter|subscribe|popup|modal|lightbox/i
  const COOKIE_TEXT = /cookie|consent|privacy|gdpr|tracking|personal data/i
  const ACCEPT = /^(accept|accept all|accept cookies|accept all cookies|accept this|allow|allow all|allow cookies|allow all cookies|agree|i agree|agree and close|agree & close|ok|okay|got it|i understand|understood|continue|yes|sounds good|fine by me|alright)\b/i
  const CLOSE = /^(close|dismiss|no thanks|no, thanks|not now|maybe later|skip|×|✕|x)$/i

  // Walk the DOM including open shadow roots (many consent widgets render inside one).
  const all = []
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      all.push(el)
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  walk(document)

  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const s = getComputedStyle(el)
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05
  }
  const sig = (el) => `${el.id || ""} ${typeof el.className === "string" ? el.className : el.getAttribute("class") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-testid") || ""}`
  const host = (el) => {
    const root = el.getRootNode()
    return root instanceof ShadowRoot ? root.host : null
  }
  /** Nearest ancestor (crossing shadow boundaries) that is fixed/sticky or a dialog. */
  const popupAncestor = (el) => {
    for (let n = el, depth = 0; n && depth < 25; depth++) {
      if (n.nodeType === 1) {
        const s = getComputedStyle(n)
        if (s.position === "fixed" || s.position === "sticky" || n.getAttribute("role") === "dialog" || n.getAttribute("aria-modal") === "true" || n.tagName === "DIALOG")
          return n
      }
      n = n.parentElement || host(n)
    }
    return null
  }
  const looksLikePopup = (box) => {
    if (!box) return false
    if (box.matches?.("header, nav") || box.querySelector?.("nav")) return false
    let s = ""
    for (let n = box, d = 0; n && d < 4; d++, n = n.parentElement || host(n)) s += " " + sig(n)
    return POPUP.test(s) || COOKIE_TEXT.test((box.innerText || box.textContent || "").slice(0, 2000))
  }

  let clicked = 0
  if (!hideOnly) {
    const controls = all.filter((el) => el.matches("button, a, [role=button], input[type=button], input[type=submit]") && visible(el))
    const label = (el) => (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").trim().replace(/\s+/g, " ")
    // Prefer accepting the cookie banner; fall back to a close control on another popup.
    const pick = (re) =>
      controls.find((el) => {
        const t = label(el)
        return t.length <= 40 && re.test(t) && looksLikePopup(popupAncestor(el))
      })
    for (const re of [ACCEPT, CLOSE]) {
      const el = pick(re) || (re === CLOSE ? controls.find((c) => /close|dismiss/i.test(c.getAttribute("aria-label") || "") && looksLikePopup(popupAncestor(c))) : null)
      if (el) {
        try {
          el.click()
          clicked++
        } catch {}
      }
    }
  }

  // Pass 2: hide leftover popup layers. Only fixed/sticky boxes or known consent hosts, never the site header.
  let hidden = 0
  const vw = innerWidth
  const vh = innerHeight
  const hide = (el) => {
    el.style.setProperty("display", "none", "important")
    el.setAttribute("data-snip-hidden", "")
    hidden++
  }
  for (const el of all) {
    if (!el.isConnected || el.closest?.("[data-snip-hidden]") || !visible(el)) continue
    const s = getComputedStyle(el)
    const fixed = s.position === "fixed" || s.position === "sticky"
    const known = /^(onetrust-consent-sdk|onetrust-banner-sdk|CybotCookiebotDialog|usercentrics-root|didomi-host|axeptio_overlay|axeptio_main_button|qc-cmp2-container|cookiebanner|cookie-banner|cookie-law-info-bar|cmplz-cookiebanner-container|termly-code-snippet-support|iubenda-cs-banner|klaro|tarteaucitronRoot|sp_message_container)/i.test(el.id) || /^sp_message_container/.test(el.id)
    if (!fixed && !known) continue
    if (!known) {
      if (el.matches("header, nav") || el.querySelector("nav") || el.closest("header")) continue
      const r = el.getBoundingClientRect()
      const area = (r.width * r.height) / (vw * vh)
      const text = (el.innerText || "").slice(0, 2000)
      const isConsent = POPUP.test(sig(el)) || COOKIE_TEXT.test(text)
      // Empty full-screen dimmers left behind by modals.
      const isBackdrop = area > 0.8 && text.trim().length < 20 && !el.querySelector("img, video, canvas, svg")
      if (!isConsent && !isBackdrop) continue
      if (isConsent && area > 0.95 && text.length > 1500) continue // probably the page itself
    }
    hide(el)
  }
  // Consent iframes (Sourcepoint, TrustArc…) sitting in fixed containers.
  for (const f of document.querySelectorAll("iframe")) {
    if (/consent|cmp|privacy|sp_message|trustarc|cookie/i.test(`${f.src} ${f.id} ${f.title}`) && visible(f)) hide(f.closest("[id^=sp_message_container]") || f)
  }
  if (hidden || clicked) {
    // Modals often lock scrolling on html/body.
    for (const n of [document.documentElement, document.body]) {
      if (!n) continue
      if (getComputedStyle(n).overflow === "hidden") n.style.setProperty("overflow", "auto", "important")
      n.classList.remove("modal-open", "no-scroll", "noscroll", "overflow-hidden")
    }
  }
  return { clicked, hidden }
}
