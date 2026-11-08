// Evaluated in the captured page: the longest CSS transition or animation (duration + delay), in ms, on a
// hover target and its first descendants, in their current state. Effects often animate a child (an image inside
// a card), not the target. Called at rest for leaving and while hovered for entering: a :hover rule can bring its
// own timing.
(selector) => {
  const node = document.querySelector(selector)
  if (!node) return 0
  const seconds = (list) => list.split(",").map((v) => {
    const t = v.trim()
    return t.endsWith("ms") ? parseFloat(t) / 1000 : parseFloat(t) || 0
  })
  // Each transitioned property (or animation name) takes the duration and delay at its index, with both lists
  // repeated as needed, so every pairing up to that count has to be checked.
  const longest = (names, durations, delays) => {
    const d = seconds(durations)
    const l = seconds(delays)
    const n = Math.max(names.split(",").length, d.length, l.length)
    let s = 0
    for (let i = 0; i < n; i++) s = Math.max(s, d[i % d.length] + l[i % l.length])
    return s
  }
  let ms = 0
  const els = [node, ...Array.from(node.querySelectorAll("*")).slice(0, 60)]
  for (const el of els) {
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo)
      ms = Math.max(ms, longest(cs.transitionProperty, cs.transitionDuration, cs.transitionDelay) * 1000)
      if (cs.animationName && cs.animationName !== "none") ms = Math.max(ms, longest(cs.animationName, cs.animationDuration, cs.animationDelay) * 1000)
    }
  }
  return Math.round(ms)
}
