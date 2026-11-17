# macOS toolbar alignment

## Diagnosis
The header used an auto-margin search field between unequal left and right groups.
The macOS shell additionally padded the entire header for traffic lights. Together,
these centered search in the *remaining gap*, not the window. Expanding the field on
focus caused another spatial change. Branding, navigation and native window controls
also competed in the leading region.

## Changes
- Equal flexible side lanes hold a stable, window-centered search field.
- Search retains its position and width on focus and input, with concise placeholder
  text and the existing detailed accessible name/help.
- The macOS shell reserves native-control space within the leading lane only.
- In macOS, remove the redundant logo. Boards, including All saves, are reached
  from the filter dock's Boards button. Web branding is unchanged.
- Preserve the native traffic lights, transparent titlebar, drag regions, keyboard
  labels and menu controls.
- At narrow web widths, search gets its own row instead of squeezing neighboring
  controls. Long board names truncate within their lane.

The 480px side-space reserve, 384px maximum search width and 639px reflow threshold
are Snip implementation choices, not Apple-specified universal metrics.

## Apple sources
Reviewed November 17, 2026:
- https://developer.apple.com/design/human-interface-guidelines/toolbars
  Deliberate item selection, logical grouping, reduced toolbar backgrounds and
  useful content-oriented titles.
- https://developer.apple.com/design/human-interface-guidelines/windows
  Preserve system window controls and adapt to changing window sizes.
- https://developer.apple.com/design/human-interface-guidelines/layout
  Adapt layout to available space without losing useful content or controls.

This is an Electron/HTML toolbar, not an AppKit toolbar or Liquid Glass implementation.

## Verification scope
- New browser tests measure native-style clearance and window centering at
  720, 900, 1280 and 1728 CSS pixels, including search input/clear and menu dismissal.
- Narrow web layout at 375px and long-board navigation at 720px are covered.
- New shell tests preserve macOS-only injection and separate drag/no-drag regions.
- Real macOS 26.6.2 (25G83), Electron 45.3.0 synthetic isolated preview inspected
  visually. Native AX window controls and named toolbar controls were present.
- The supplied attachment could not be downloaded through the supported file
  transfer flow. The installed app and isolated preview were inspected instead.
- Native keyboard/fullscreen/drag verification was not completed after UI
  automation lost the preview window. VoiceOver, Full Keyboard Access, Increase
  Contrast, Reduce Transparency, hardware display changes and contrast measurement
  were not run. Automated DOM checks do not establish those capabilities.
- No installed app, saved library, release, or original dirty checkout was changed.

## Recorded test results
- Typecheck: passed (web and capture).
- Web/settings build: passed; existing bundle-size warning remains.
- Core: 394/394 passed.
- Desktop app: 298/298 passed.
- Browser/settings: 148/148 passed.
- After the final pointer-event refinement: rebuilt and reran all 6 new layout
  tests plus 6 existing board-name/canvas-focus tests, all passed. The aggregate
  browser run completed successfully and included the final layout test version;
  earlier scenarios in that run preceded this three-line CSS refinement.
- Dependencies reused from the existing local checkout: Node 25.9.0, React 19.3.1,
  Vite 8.3.5, Playwright 1.64.1. A clean locked-dependency CI install was not run.
