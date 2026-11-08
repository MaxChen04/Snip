# Third-party notices

Snip includes the following third-party material. Each keeps its own license; Snip's license (Apache 2.0 + Commons Clause) does not apply to it.

## Example screenshots

The images in `web/public/landing/` are screenshots of third-party websites (including linear.app, vercel.com, stripe.com, rauno.me and anchor.com). They appear on the landing page only to illustrate what a capture looks like. The designs, content and trademarks shown belong to their owners and are **not** licensed under Snip's license. Don't reuse them. If you own one of these sites and want it removed, open an issue.

Your own captures are copies of other people's websites too. Snip stores them privately for your reference; check a site's terms before you share or republish anything you capture.

## Fonts

| Font | Where | Source | License |
| --- | --- | --- | --- |
| Inter (variable, latin subset) | `web/src/settings/fonts/InterVariable-latin.woff2` | https://github.com/rsms/inter | SIL Open Font License 1.1 |

The Settings window bundles Inter locally so it loads no remote content. The full license text is at `web/src/settings/fonts/Inter-OFL.txt`. The rest of the app loads Inter from Google Fonts at runtime.

## Code and design guidance

| Component | Where | Source | License |
| --- | --- | --- | --- |
| shadcn/ui | `web/src/components/ui/` (generated components) | https://github.com/shadcn-ui/ui | MIT |
| SortUI | `web/src/components/ui/`, theme in `web/src/index.css` | https://github.com/sortui/ui | MIT |
| tactile-design skill | `.agents/skills/tactile-design/` | https://github.com/kosta4a/tactile-design | MIT |

npm dependencies are not vendored; their licenses ship with each package in `node_modules`.

### shadcn/ui

```
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### SortUI

```
MIT License

Copyright (c) 2026 SortUI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### tactile-design

```
MIT License

Copyright (c) 2026 the tactile-design authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

