# Nightlight current PNG artwork

> **Historic (2026-11-05):** these are the PREVIOUS illustrated artwork. The web app now uses the SVG logo
> (`frontend/public/icons/nightlight-logo.svg`) and icons made from it; see `docs/design-language.md` section 4.3.
> The Android and iOS app icons still use this older artwork until the mobile repo is updated.

This folder packages the existing Nightlight artwork without redrawing or restyling it.
The files are byte-for-byte copies of the PNG assets currently used by the web and mobile
applications. No live application assets have been changed.

## Files

- `nightlight-ios-app-icon-1024.png` — current 1024 × 1024 iOS app icon.
- `nightlight-app-icon-512.png` and `nightlight-app-icon-192.png` — current standard
  app and PWA icons.
- `nightlight-android-maskable-512.png` and `nightlight-android-maskable-192.png` —
  current maskable Android/PWA compositions with safe-area padding.
- `nightlight-now-playing-512.png` — current full-bleed iOS Now Playing artwork.
- `nightlight-album-art-512.png` — an identical copy of the Now Playing artwork,
  named separately for album-art use.

The Now Playing and album-art files are intentionally square and full bleed. Do not add
rounded corners; the operating system applies its own presentation treatment.
