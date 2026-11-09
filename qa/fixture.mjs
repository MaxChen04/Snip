// Local fixture site: a hero that animates, a looping marquee, and a dark theme via prefers-color-scheme.
import http from "node:http"
const html = `<!doctype html><html><head><meta charset=utf-8><title>QA Fixture</title><meta name=viewport content="width=device-width,initial-scale=1"><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--card:#f3f3f7}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b10;--fg:#eee;--card:#1b1b24}}
body{margin:0;font:18px/1.5 system-ui;background:var(--bg);color:var(--fg)}
header{display:flex;justify-content:space-between;padding:20px 40px;position:sticky;top:0;background:var(--bg)}
.hero{height:620px;display:grid;place-items:center;background:linear-gradient(120deg,#ff6a3d,#7b61ff,#00c2ff);background-size:300% 300%;animation:g 3s linear infinite}
@keyframes g{0%{background-position:0 50%}100%{background-position:100% 50%}}
.hero h1{font-size:64px;color:#fff;margin:0}
.marquee{height:160px;overflow:hidden;background:var(--card);white-space:nowrap}
.marquee div{display:inline-block;padding:50px 0;font-size:40px;animation:m 4s linear infinite}
@keyframes m{from{transform:translateX(0)}to{transform:translateX(-50%)}}
section.s{height:520px;padding:60px 40px;border-top:1px solid #8884}
section.s:nth-of-type(odd){background:var(--card)}
footer{height:260px;background:#222;color:#ddd;padding:40px}
</style></head><body><header><b>Fixture</b><nav>Product Pricing Docs</nav></header>
<div class=hero><h1>Motion works</h1></div>
<div class=marquee><div>Alpha Beta Gamma Delta Epsilon Zeta Eta Theta &nbsp; Alpha Beta Gamma Delta Epsilon Zeta Eta Theta &nbsp;</div></div>
<section class=s><h2>Features</h2><p>Static section one.</p></section>
<section class=s><h2>Pricing</h2><p>Static section two.</p></section>
<section class=s><h2>FAQ</h2><p>Static section three.</p></section>
<footer>Footer</footer></body></html>`
const port = Number(process.argv[2] || 5391)
http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(html) }).listen(port, "127.0.0.1", () => console.log("fixture on", port))
