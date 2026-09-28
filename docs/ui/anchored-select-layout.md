# Anchored selects and Layout A polish

The desktop console now enhances single-choice native `select` elements with a
shared, theme-aware listbox. It ships in the existing `appearance.mjs` and
`styles.css` response (base plus the local `layout-polish.css` fragment): no
additional public asset or ingress route is required.

## Interaction contract

- The original select remains the authority for name, value, disabled/required
  state, native FormData, reset and form validation. Browsers without Popover API
  support keep the original native control.
- A select-only combobox opens a top-layer listbox 6px below the trigger. It flips
  above when necessary, clamps to the viewport, and follows page/dialog scrolling.
  The DOM remains within the owning form/dialog; there is no body portal that
  would escape modal focus or form ownership.
- Arrow keys, Home/End, Page Up/Down and typeahead move the active option. Enter or
  Space commits once; Tab commits and moves on. Escape/outside click cancels the
  preview. Disabled/hidden options cannot be committed.
- At most one listbox is open. Closing/removing a form, disabling a control or
  leaving the page dismisses it. Changes dispatch one native input/change pair.
- Option text is assigned with textContent. No user-controlled HTML is generated.
  CSP, cookies, session checks, mutation permissions and backend routes are not
  changed. Positioning writes numeric CSS properties, not executable style text.

## Layout

The fixed A shell and six palette/mode combinations remain. Topbar controls are
compact, and search filters use an explicit two-row grid rather than wrapping
inline labels. The memory library is a four-column table of actual returned
content, category, lifecycle and creation time. It does not invent revisions,
visibility or trend data. Write forms are centered, width-bounded dialogs;
read-only memory/source details remain the existing right-hand drawer.

The new-memory action moves to the page heading under the same capability check.
Names, filter submission, URL state, pagination, detail/source/history navigation
and account-scoped preferences retain their existing contracts. Long tables have
local horizontal scrolling and repeated cards have consistent gaps.

## Verification

`services/oauth/test/console-select-presentation.test.mjs` supplements existing
presentation/CSP tests. `scripts/console_select_checks.py` adds real-browser
keyboard, FormData/reset/required/disabled, popup collision/scroll, modal, palette,
translation and viewport checks to `scripts/test-console-browser.py`.

The browser runner uses locator waits, not string-based `wait_for_function`;
the application CSP is not weakened. Select interactions use the visible controls
instead of bypassing them with programmatic selection. All business scenarios in
the existing browser runner are retained.

Local offline rendering is useful for visual comparison but is not a substitute
for the real HTTP/CSP workflow. CI checks use disposable accounts, loopback models
and databases; neither test harness should target production. Review the actual
CI result on the pull request. Native macOS Safari/VoiceOver acceptance remains a
manual deployment check even when Chromium CI passes.
