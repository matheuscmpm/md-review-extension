# Markdown Rich Review for GitHub Pull Requests

A Chrome / Microsoft Edge / Mozilla Firefox extension (MV3) that enhances GitHub Pull Request Files changed views for Markdown files.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- Rich diff enhancement - When you switch a `.md` file to GitHub's rich diff view, the extension overlays line numbers, comment indicators, and click-to-source navigation.
- Line-level comment indicators - Lines with existing review comments show a chat-bubble icon with superscript count in the right margin, plus a permanent dashed outline.
- Click-to-source - Click any element in the rich preview to jump to the corresponding line in the source diff, with automatic expansion of collapsed sections.
- Back to rich view - A header button lets you switch back from source diff to rich preview in one click. It only appears when you are in source diff mode.
- Comment bar - A summary bar at the top of each rich diff shows all commented lines with quick-jump badges.
- Toolbar popup - The extension popup controls pause/resume, scroll mode, and theme mode.
- Scroll mode - Choose smooth or instant scrolling from the popup.
- Theme mode - Choose Auto, Light, or Dark from the popup. Auto follows GitHub's detected theme.
- Toolbar icon states - The extension icon turns green when active and stays transparent when paused or on pages the extension does not use.
- Source line highlighting - Selected source lines are persistently highlighted with automatic retry for lazy-loaded diffs.
- Comment activity tracking - Starting a review or adding comments reflects back in the rich diff indicators in real time.

## Installation

### From source (developer mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/<your-username>/md-review-extension.git
   cd md-review-extension
   ```

2. Open your browser's extension page:
   - Edge: `edge://extensions`
   - Chrome: `chrome://extensions`
   - Firefox: `about:debugging#/runtime/this-firefox`

3. Enable Developer mode.

4. Load the extension from this project directory:
   - Edge / Chrome: click **Load unpacked**
   - Firefox: click **Load Temporary Add-on** and select `/home/runner/work/md-review-extension/md-review-extension/matheuscmpm/md-review-extension/manifest.json`

5. Navigate to any GitHub PR -> Files changed tab.

6. Click the extension icon in the browser toolbar to open the popup and adjust pause, scroll, or theme settings.

### From packaged archive

1. Download the latest package from [Releases](../../releases).
2. Choose the package for your browser:
   - Chrome / Edge: `.zip`
   - Firefox: `.xpi`
3. For Chrome / Edge, unzip and load it unpacked.
4. For Firefox, load the `.xpi` from `about:debugging#/runtime/this-firefox` as a temporary add-on, or submit the same package to AMO for signed distribution.

## Packaging

To create distributable browser packages locally:

```bash
npm run package
```

This outputs:

- `dist/markdown-rich-review-<version>.zip` for Chrome Web Store / Edge Add-ons
- `dist/markdown-rich-review-firefox-<version>.xpi` for Firefox testing or AMO submission

You can also build a single target:

```bash
npm run package:chrome
npm run package:firefox
```

## CI / CD

A GitHub Actions workflow ([`.github/workflows/release.yml`](.github/workflows/release.yml)) automates packaging and releasing:

| Trigger | What happens |
|---|---|
| Push to `main` | Packages browser artifacts and updates a rolling `latest` pre-release with the `.zip` and `.xpi` packages ([`ci.yml`](.github/workflows/ci.yml)) |
| Push a tag `v*` (e.g. `v2.4.0`) | Packages browser artifacts, creates a GitHub Release with the `.zip` and `.xpi` attached and auto-generated release notes ([`release.yml`](.github/workflows/release.yml)) |
| Manual dispatch (`workflow_dispatch`) | Packages browser artifacts and uploads them as build artifacts |

### Creating a release

1. Update the version in `manifest.json` and `package.json`.
2. Commit and push:
   ```bash
   git add -A && git commit -m "Release v2.4.0"
   git tag v2.4.0
   git push origin main --tags
   ```
3. The pipeline will automatically build and publish the browser packages.

## File structure

```text
md-review-extension/
|-- manifest.json              # MV3 extension manifest (Chrome/Edge/Firefox)
|-- background.js              # Updates toolbar icon state per tab
|-- content-script.js          # Main content script - all extension logic
|-- utils/
|   `-- domHelpers.js          # Shared DOM utility functions
|-- styles/
|   `-- reviewPane.css         # All extension styles
|-- icons/
|   |-- icon16.png             # Inactive extension icon 16x16
|   |-- icon32.png             # Inactive extension icon 32x32
|   |-- icon64.png             # Inactive extension icon 64x64
|   |-- icon16-active.png      # Active toolbar icon 16x16
|   |-- icon32-active.png      # Active toolbar icon 32x32
|   `-- icon64-active.png      # Active toolbar icon 64x64
|-- popup.html                 # Toolbar popup UI
|-- popup.js                   # Popup settings logic
|-- scripts/
|   `-- package.mjs            # Packaging script for Chrome/Edge/Firefox artifacts
|-- .github/
|   `-- workflows/
|       |-- ci.yml             # Latest build on every push to main
|       `-- release.yml        # Versioned release on tag push
|-- package.json
|-- LICENSE
`-- README.md
```

## How it works

The extension runs as a content script on GitHub PR Files changed pages. On those pages, it:

1. Detects `.md` files among the diff containers via embedded payload metadata and DOM inspection.
2. Enhances the rich diff view when the user switches to it, adding click handlers, line numbers, and comment indicators.
3. Fetches raw file content using the authenticated GitHub session to build a line map for accurate source-position mapping.
4. Navigates to the source diff on click, expanding collapsed sections, highlighting the target line, and restoring scroll position across native GitHub view toggles.

No GitHub API tokens or special permissions are required. The extension uses only the browser session already authenticated with GitHub.

## Firefox compatibility notes

- The manifest includes `browser_specific_settings.gecko` metadata for Firefox.
- The current Firefox target baseline is `121.0` and uses the same MV3 service worker/content-script architecture as Chromium-based browsers.
- Extension API calls that differ between callback-based `chrome.*` and promise-based `browser.*` implementations are normalized in the extension code so popup, background, and content-script behavior remain aligned across browsers.

## License

[MIT](LICENSE)
