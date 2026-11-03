// Nav theme follows the section under it; reveal-on-scroll; hero parallax; copy button.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Nav: switch to light styling over light sections.
  const lightSections = [...document.querySelectorAll(".light, .closing, .footer")];
  const updateNav = () => {
    const y = 40;
    const onLight = lightSections.some((el) => {
      const r = el.getBoundingClientRect();
      return r.top <= y && r.bottom >= y;
    });
    document.body.classList.toggle("on-light", onLight);
  };
  addEventListener("scroll", updateNav, { passive: true });
  updateNav();

  // Reveal blocks as they enter.
  const targets = document.querySelectorAll(
    ".window, .statement p, .container > *, .grid article, .flow li, .steps li, .stats div, .closing > *:not(.floaters)"
  );
  if (!reduce && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      }),
      { rootMargin: "0px 0px -8% 0px" }
    );
    targets.forEach((el, i) => {
      el.classList.add("reveal");
      el.style.transitionDelay = `${(i % 3) * 70}ms`;
      io.observe(el);
    });
  }

  // Hero parallax: cards drift with the pointer, by depth.
  const cards = document.querySelectorAll(".card[data-depth]");
  if (!reduce && matchMedia("(pointer: fine)").matches) {
    let raf = 0;
    addEventListener("pointermove", (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const dx = e.clientX / innerWidth - 0.5;
        const dy = e.clientY / innerHeight - 0.5;
        cards.forEach((c) => {
          const d = parseFloat(c.dataset.depth);
          c.style.setProperty("--px", `${(-dx * 36 * d).toFixed(1)}px`);
          c.style.setProperty("--py", `${(-dy * 28 * d).toFixed(1)}px`);
        });
      });
    });
  }

  // Copy-to-clipboard.
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = "Copied";
      } catch {
        btn.textContent = "Select & copy";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1600);
    });
  });
})();
