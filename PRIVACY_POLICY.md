# Privacy Policy & Security

**Last Updated:** October 2026

**Redirect local** is a developer-focused Chrome Extension designed to route and manage local development and Adobe Experience Manager (AEM) Author URLs.

---

### 1. Data Collection & Privacy
- **Zero Tracking:** Redirect local does not track, store, or transmit any personally identifiable information (PII).
- **No External Servers:** The extension does not connect to any third-party analytics, remote tracking servers, or telemetry services.
- **Local Storage:** All user configuration, redirect rules, and preferences are stored exclusively on your device using Chrome's local storage (`chrome.storage.local` and browser `localStorage`).

---

### 2. Permissions Justification
Redirect local strictly requests only permissions necessary for its core redirect functionalities:

- **`declarativeNetRequest`**: Used to perform fast, native browser-level URL redirects according to your configured rules without inspecting request bodies.
- **`storage`**: Used to persist your site settings, custom redirect rules, and theme preferences locally.
- **`webNavigation`**: Used to detect navigation events on your local development server when pasting nested URLs.
- **`webRequest`**: Limited strictly to `localhost` and `127.0.0.1` main frames to trigger the 404 Auto-Fix feature when a local page fails.
- **Host Permissions (`localhost`, `127.0.0.1`)**: Strictly scoped to local development servers only. No external web traffic is ever observed or intercepted.

---

### 3. Open Source & License
This extension is open source under the **MIT License**. You are free to inspect, audit, and modify the source code locally.
