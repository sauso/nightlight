# Windows icon source

`Nightlight.png` is a lossless PNG conversion of the decoded artwork supplied at
https://nightlightbaby.app/assets/nightlight.webp (the website repository's
`assets/nightlight.webp`, Git blob `c34ceb6b76888c5f817f1a3490a9fd3d9c98ab85`).
Its transparency and artwork are preserved. PNG lets the .NET Framework build
tools read it without requiring a WebP codec or a download during the build.

`windows/build-icon.ps1` produces the 16, 20, 24, 32, 48, 64, 128 and 256 pixel
Windows icon frames from this source. The tray, setup, uninstaller and shortcuts
all use that generated icon. The existing web/PWA assets remain bundled with the
frontend.
