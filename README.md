# Redirect local

A lightweight, powerful Manifest V3 Chrome Extension for local web developers and **Adobe Experience Manager (AEM)** authors.

Automatically redirects live-site URLs into local AEM Author environments, recovers 404 missing `.html` pages, and executes instant native URL redirect rules with recursion loop protection.

---

## ✨ Features

- **⚡ AEM Author Rewriter**: Automatically rewrites live domains (or nested URLs accidentally pasted into localhost) into `http://localhost:4502/content/{site}/...html`. Only redirects when the local target returns HTTP 200.
- **✏️ One-Click Edit Mode**: Quickly toggle the current AEM page between **Preview** and **Editor** (`/editor.html/...`).
- **📋 Native DNR Rules**: Custom redirect rules compiled directly into Chrome's **DeclarativeNetRequest (DNR)** engine for instant, C++ native redirection speed before network requests go out.
- **🛡️ Anti-Recursion Engine**: Advanced loop detection prevents circular redirects (such as `/index/index/index...` or ping-pong chains) before rules are saved.
- **🔍 404 Auto-Fix**: Automatically appends `.html` or prefixes `/content/{site}` when a local page returns 404 or 403.
- **💾 Silent Auto-Save**: All changes are automatically debounced and saved in the background.
- **🌓 Light & Dark Theme**: Built-in dark mode with automatic OS preference sync.

---

## 🚀 Installation

1. Open your browser and navigate to:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked**.
4. Select the `redirect-dev` directory.

---

## ⚙️ Configuration Format

You can configure options through the popup UI or directly edit the **JSON** tab:

```json
{
  "rules": [
    {
      "name": "Localhost HTTPS to HTTP",
      "description": "Redirect https://localhost:4502/* → http://localhost:4502/*",
      "enabled": true,
      "matchType": "prefix",
      "from": "https://localhost:4502/",
      "to": "http://localhost:4502/"
    }
  ],
  "aemAuthorRewrite": {
    "enabled": true,
    "localhostBase": "http://localhost:4502",
    "defaultSiteName": "mysite",
    "prependEditorHtml": false,
    "liveDomains": [
      "https://example.com"
    ]
  },
  "htmlFallback": {
    "enabled": true
  }
}
```

---

## 🔒 Privacy & Permissions

- **100% Local**: No external analytics, tracking, or network requests to third parties.
- See full details in [PRIVACY_POLICY.md](./PRIVACY_POLICY.md).

---

## 📄 License

This project is licensed under the [MIT License](./LICENSE).
