# Web Assets Directory

This directory is like Next.js `public` folder - files here are served directly.

## Usage

Files in `web/assets/` are copied directly to the build output and can be accessed via URL:

- Place file: `web/assets/logo.png`
- Access in HTML: `<img src="assets/logo.png" />`
- Access in code: Use full URL or relative path

## Example Structure

```
web/
  ├── assets/
  │   ├── logo.png
  │   ├── favicon.ico
  │   └── images/
  │       └── banner.jpg
  ├── index.html
  └── manifest.json
```

## For Telegram Mini Apps

You can reference these files directly in your HTML or use them in Flutter web code.


