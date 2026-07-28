# Design QA — Carpo-Prompt

## Reference

- Source: the original PromptCard v1.3.2 extension bundle.
- Carpo-Prompt intentionally retains its dark floating-card pattern, orange accent, compact popup, and supplied icon assets while replacing the product name and output languages.

## Static checks completed

- Manifest JSON parses and every declared local script, stylesheet, icon, and web-accessible asset exists.
- Service worker, content script, popup script, and prompt module pass JavaScript syntax checks.
- Prompt contract contains `ko` and `en`, excludes `zh` and `ja`, and retains the 12-field structured prompt object.
- The core interaction wiring is present: image/page context-menu click or image-hover action → in-page panel → custom vision API → Korean/English/JSON tabs → clipboard actions.
- Local file picker, drop zone, visible-page capture and crop, editable history, prompt-card PNG export, image copy, movable/minimizable card, and generator autofill hooks are present.

## Visual comparison

Visual capture is not available in this workspace: the supplied reference is a Chrome extension bundle and no user-selected browser or browser-capture surface is available. A side-by-side comparison of the installed extension and the original UI has therefore not been performed.

## Final result: blocked

Load the project as an unpacked extension in Chrome, capture the popup and an in-page result card, then compare both against the original PromptCard extension before marking visual QA as passed.
