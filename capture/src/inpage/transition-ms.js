// Evaluated in the captured page: the longest CSS transition or animation (duration + delay), in ms, on a
// hover target and its first descendants. Effects often animate a child (an image inside a card), not the target.
(selector) => {
  const node = document.querySelector(selector)
  if (!node) return 0
  const seconds = (list) => list.split(",").map((v) => {
    const t = v.trim()
    return t.endsWith("ms") ? parseFloat(t) / 1000 : parseFloat(t) || 0
  })
  // CSS repeats the shorter of the duration and delay lists to match the longer one.
  const longest = (durations, delays) => {
    const d = seconds(durations)
    const l = seconds(delays)
    return Math.max(0, ...d.map((v, i) => v + (l[i % l.length] || 0)))
  }
  let ms = 0
  const els = [node, ...Array.from(node.querySelectorAll("*")).slice(0, 60)]
  for (const el of els) {
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo)
      ms = Math.max(ms, longest(cs.transitionDuration, cs.transitionDelay) * 1000)
      if (cs.animationName && cs.animationName !== "none") ms = Math.max(ms, longest(cs.animationDuration, cs.animationDelay) * 1000)
    }
  }
  return Math.round(ms)
}
