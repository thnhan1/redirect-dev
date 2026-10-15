// ============================================================
//  n-redirect - background.js (Service Worker)
//
//  Responsibilities:
//    1. Custom rules      -> compiled into declarativeNetRequest (native, zero-latency).
//                            Only regexes DNR cannot run (RE2 limits) are handled here.
//    2. Author rewriter   -> live-site URL / nested URL pasted into localhost
//                            -> {localhostBase}/content/{siteName}/....html
//    3. 404 auto-fix      -> on 403/404 at localhostBase, try ".html" and "/content/{siteName}".
//
//  Every redirect issued here must pass a per-tab hop guard, and every
//  custom rule is validated (rules-core.js) so recursive rules are never installed.
// ============================================================

importScripts("rules-core.js");
const C = self.RedirectCore;

const LOG = "[n-redirect]";
const CONFIG_URL = chrome.runtime.getURL("config.json");
const DEFAULT_BASE = C.DEFAULT_BASE;

const LOOP_WINDOW_MS = 5000;     // sliding window for the hop guard
const MAX_HOPS = 3;              // max SW-driven redirects per tab inside the window
const PROBE_TIMEOUT_MS = 2500;   // AEM author cold renders can be slow
const PROBE_CACHE_TTL_MS = 15000;
const PROBE_CACHE_MAX = 200;
const FALLBACK_STATUSES = new Set([403, 404]);
const LOGIN_RE = /\/login|granite\/core\/content\/login|j_security_check/i;

const inflight = new Map();      // tabId -> url currently being resolved
const hopLog = new Map();        // tabId -> { at, hops, urls:Set }
const probeCache = new Map();    // url -> { ok, at }

let cachedConfig = null;
let cachedConfigPromise = null;
let swOnlyPatterns = [];         // [{ rule, pat }] regexes DNR rejected -> handled in SW
let lastDnrSig = null;
let dnrQueue = Promise.resolve();

const FALLBACK_CONFIG = {
  rules: [],
  aemAuthorRewrite: { enabled: false, localhostBase: DEFAULT_BASE, defaultSiteName: "mysite", prependEditorHtml: false, liveDomains: [] },
  htmlFallback: { enabled: false }
};

// ─── Config ─────────────────────────────────────────────────
function normalizeConfig(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const aemIn = c.aemAuthorRewrite || {};
  const localhostBase = String(aemIn.localhostBase || DEFAULT_BASE).replace(/\/+$/, "");
  const localOrigin = C.toOrigin(localhostBase, "http");

  const aem = {
    enabled: !!aemIn.enabled,
    localhostBase,
    defaultSiteName: C.cleanSiteName(aemIn.defaultSiteName),
    prependEditorHtml: !!aemIn.prependEditorHtml,
    // Stored as bare origins; the localhost origin itself is rejected (it would rewrite AEM onto itself).
    liveDomains: [...new Set((Array.isArray(aemIn.liveDomains) ? aemIn.liveDomains : [])
      .map((d) => C.toOrigin(d))
      .filter((d) => d && d !== localOrigin))]
  };

  // Legacy keys (matchPatterns, pathPrefixes, skipIfPathEndsWith) are dropped:
  // the auto-fix is now scoped to localhostBase and derives its prefix from defaultSiteName.
  const htmlFallback = { enabled: !!(c.htmlFallback && c.htmlFallback.enabled) };

  const rules = (Array.isArray(c.rules) ? c.rules : [])
    .filter((r) => r && r.to && C.getFromList(r).length)
    .map((r, i) => {
      const fromList = C.getFromList(r);
      const name = r.name || r.id || `Rule ${i + 1}`;
      return {
        name,
        id: String(r.id || name || `rule-${i + 1}`),
        description: r.description || "",
        enabled: r.enabled !== false,
        matchType: C.MATCH_TYPES.includes(r.matchType) ? r.matchType : "prefix",
        from: fromList.length > 1 ? fromList : fromList[0],
        to: String(r.to).trim()
      };
    });

  return { rules, aemAuthorRewrite: aem, htmlFallback };
}

async function loadDefaultConfig() {
  const res = await fetch(CONFIG_URL);
  return normalizeConfig(await res.json());
}

async function loadFullConfig(force = false) {
  if (cachedConfig && !force) return cachedConfig;
  if (cachedConfigPromise && !force) return cachedConfigPromise;

  cachedConfigPromise = (async () => {
    try {
      const { userConfig } = await chrome.storage.local.get("userConfig");
      cachedConfig = userConfig ? normalizeConfig(userConfig) : await loadDefaultConfig();
      if (!userConfig) await chrome.storage.local.set({ userConfig: cachedConfig });
    } catch (err) {
      console.error(LOG, "Config load error:", err);
      cachedConfig = normalizeConfig(FALLBACK_CONFIG);
    }
    // Rebuild SW-only rule list after a worker restart (DNR rules themselves persist).
    await applyDeclarativeRules(cachedConfig).catch(() => {});
    cachedConfigPromise = null;
    return cachedConfig;
  })();
  return cachedConfigPromise;
}

// Config edited elsewhere (e.g. another popup instance). Ignore our own writes.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.userConfig) return;
  const next = normalizeConfig(changes.userConfig.newValue);
  if (cachedConfig && JSON.stringify(next) === JSON.stringify(cachedConfig)) return;
  cachedConfig = next;
  applyDeclarativeRules(next).catch(() => {});
});

// ─── DeclarativeNetRequest ──────────────────────────────────
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeSubst = (s) => s.replace(/\\/g, "\\\\");

function toDnr(pat, rule, id) {
  let regexFilter, regexSubstitution;
  switch (rule.matchType) {
    case "prefix":
      regexFilter = `^${escapeRegex(pat)}(.*)`;
      regexSubstitution = escapeSubst(rule.to) + "\\1";
      break;
    case "exact":
      regexFilter = `^${escapeRegex(pat)}$`;
      regexSubstitution = escapeSubst(rule.to);
      break;
    case "regex":
      regexFilter = pat;
      regexSubstitution = C.toDnrSubstitution(rule.to);
      break;
    default:
      return null;
  }
  return {
    id,
    priority: 1,
    action: { type: "redirect", redirect: { regexSubstitution } },
    condition: { regexFilter, isUrlFilterCaseSensitive: true, resourceTypes: ["main_frame", "sub_frame"] }
  };
}

// Serialized: concurrent updateDynamicRules calls would otherwise race on rule IDs.
function applyDeclarativeRules(cfg) {
  const run = dnrQueue.then(() => doApplyDeclarativeRules(cfg));
  dnrQueue = run.catch(() => {});
  return run;
}

// Returns [{ id, reason }] for rules that were NOT installed.
async function doApplyDeclarativeRules(cfg) {
  const rules = cfg.rules || [];
  const issues = C.validateRules(rules, cfg.aemAuthorRewrite);
  const blocked = new Set(issues.map((i) => i.index));
  const skipped = issues.map(({ id, name, reason }) => ({ id, name: name || id, reason }));
  const addRules = [];
  const swOnly = [];
  let dnrId = 1;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule.enabled || blocked.has(i)) continue;
    for (const pat of C.getFromList(rule)) {
      const dnr = toDnr(pat, rule, dnrId);
      if (!dnr) { skipped.push({ id: rule.id, reason: `Invalid pattern: ${pat}` }); continue; }
      if (rule.matchType === "regex") {
        const support = await chrome.declarativeNetRequest.isRegexSupported({ regex: pat });
        if (!support.isSupported) { swOnly.push({ rule, pat }); continue; } // still works, via SW
      }
      addRules.push(dnr);
      dnrId++;
    }
  }

  swOnlyPatterns = swOnly;
  const sig = JSON.stringify(addRules);
  if (sig !== lastDnrSig) {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules });
    lastDnrSig = sig;
  }
  if (skipped.length) console.warn(LOG, "Skipped rules:", skipped);
  return skipped;
}

// Is this URL something the SW needs to look at? (pure sync check, no I/O)
// The SW ONLY runs on the developer's localhostBase!
function isTargetUrl(urlObj, cfg) {
  if (C.isLocalBase(urlObj, cfg.aemAuthorRewrite)) return true;
  return swOnlyPatterns.some(({ rule, pat }) => C.applyPattern(rule, pat, urlObj.href) !== null);
}

// ─── Page existence probe ───────────────────────────────────
// "Exists" = final HTTP 200 that is not the AEM login page.
// 401/403/3xx do NOT prove a page exists (AEM answers them for any path when logged out).
async function probe(url, signal) {
  const hit = probeCache.get(url);
  if (hit && Date.now() - hit.at < PROBE_CACHE_TTL_MS) return hit.ok;

  const opts = (method) => ({
    method, credentials: "include", cache: "no-store", redirect: "follow",
    signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)].filter(Boolean))
  });
  try {
    let res = await fetch(url, opts("HEAD"));
    if (res.status === 405 || res.status === 501) res = await fetch(url, opts("GET"));
    const ok = res.status === 200 && !(res.redirected && LOGIN_RE.test(res.url));
    if (probeCache.size >= PROBE_CACHE_MAX) probeCache.clear();
    probeCache.set(url, { ok, at: Date.now() });
    return ok;
  } catch {
    return false; // timeout / abort / network: not cached
  }
}

// Probes all candidates in parallel but resolves in priority order:
// returns as soon as the best available candidate is known, then aborts the rest.
async function firstAvailable(candidates) {
  const ctrl = new AbortController();
  const pending = candidates.map((u) => probe(u, ctrl.signal));
  try {
    for (let i = 0; i < pending.length; i++) {
      if (await pending[i]) return candidates[i];
    }
    return null;
  } finally {
    ctrl.abort();
  }
}

// ─── Navigation + hop guard ─────────────────────────────────
function getHopLog(tabId) {
  const now = Date.now();
  let log = hopLog.get(tabId);
  if (!log || now - log.at > LOOP_WINDOW_MS) {
    log = { at: now, hops: 0, urls: new Set() };
    hopLog.set(tabId, log);
  }
  return log;
}

// URL we just redirected from/to in this tab -> leave it alone (prevents ping-pong and Back-button bounce).
function recentlyHandled(tabId, url) {
  const log = hopLog.get(tabId);
  return !!log && Date.now() - log.at <= LOOP_WINDOW_MS && log.urls.has(url);
}

function navigate(tabId, from, to) {
  if (!to || to === from) return false;
  const log = getHopLog(tabId);
  if (log.urls.has(to) || log.hops >= MAX_HOPS) {
    console.warn(LOG, `Loop guard blocked ${from} → ${to}`);
    return false;
  }
  log.at = Date.now();
  log.hops++;
  log.urls.add(from).add(to);
  console.info(LOG, `${from} → ${to}`);
  chrome.tabs.update(tabId, { url: to }).catch(() => {});
  return true;
}

// ─── 1. SW-only custom rules ────────────────────────────────
function processSwOnlyRules(tabId, url) {
  for (const { rule, pat } of swOnlyPatterns) {
    const to = C.applyPattern(rule, pat, url);
    if (to !== null && to !== url) return navigate(tabId, url, to);
  }
  return false;
}

// ─── 2. Author rewriter ─────────────────────────────────────
// Live URL pasted after the localhost URL, e.g.
//   http://localhost:4502/aem/start.htmlhttps://example.com/us/en?x=1
// Only the PATH is inspected, so query strings such as ?redirect=https://... are never hijacked.
function extractNested(urlObj) {
  let path = urlObj.pathname;
  try { path = decodeURIComponent(path); } catch {}
  const idx = path.search(/https?:\/\/?[^/]/i);
  if (idx < 0) return null;
  const nested = C.parseUrl(path.slice(idx).replace(/^(https?):\/(?!\/)/i, "$1://"));
  if (!nested) return null;
  return {
    path: nested.pathname || "/",
    tail: (nested.search || urlObj.search) + (nested.hash || urlObj.hash)
  };
}

async function processAemRewrite(tabId, urlObj, aem) {
  if (!aem.enabled || !C.isLocalBase(urlObj, aem)) return false;

  const nested = extractNested(urlObj);
  if (!nested) return false;

  const candidates = C.aemCandidates(nested.path, nested.tail, aem);
  // Nested URL is never a valid localhost page: pick first 200 match, else default .html candidate
  const chosen = (await firstAvailable(candidates)) || candidates[0];
  return navigate(tabId, urlObj.href, chosen);
}

// ─── 3. 404 auto-fix (localhostBase only) ───────────────────
// Every step is idempotent (".html" only if no extension, "/content/{site}" only if not
// already under /content/), so candidates can never grow into /content/x/content/x/...
function fallbackCandidates(urlObj, aem) {
  const path = urlObj.pathname;
  const tail = urlObj.search + urlObj.hash;
  const noSlash = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (noSlash === "/") return [];

  const last = noSlash.split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  const ext = dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
  if (ext && ext !== "html") return []; // assets, selectors, JSON... not a page-path typo

  const out = [];
  const add = (p) => {
    const u = urlObj.origin + C.cleanSlashes(p) + tail;
    if (u !== urlObj.href && !out.includes(u)) out.push(u);
  };

  if (ext === "html") { if (path !== noSlash) add(noSlash); }  // "/a.html/" -> "/a.html"
  else add(noSlash + ".html");                                // "/content/site/a" -> ".../a.html"

  if (!noSlash.startsWith("/content/") && !C.isAemSystemPath(noSlash)) {
    const prefixed = `/content/${aem.defaultSiteName}${noSlash}`;
    add(ext ? prefixed : prefixed + ".html");                 // "/us/en" -> "/content/site/us/en.html"
  }
  return out;
}

async function processFallback(tabId, urlObj, cfg) {
  if (!cfg.htmlFallback.enabled || !C.isLocalBase(urlObj, cfg.aemAuthorRewrite)) return false;
  const candidates = fallbackCandidates(urlObj, cfg.aemAuthorRewrite);
  if (!candidates.length) return false;
  const valid = await firstAvailable(candidates);
  return valid ? navigate(tabId, urlObj.href, valid) : false;
}

// ─── Orchestrator ───────────────────────────────────────────
// failed = true when the main frame came back with 403/404.
async function resolveAndRedirect(tabId, url, failed) {
  if (tabId < 0 || !C.isHttp(url)) return;
  if (inflight.get(tabId) === url || recentlyHandled(tabId, url)) return;
  const urlObj = C.parseUrl(url);
  if (!urlObj) return;

  // Cheap sync bail-out before any await when config is already in memory.
  if (cachedConfig && !isTargetUrl(urlObj, cachedConfig)) return;
  const cfg = await loadFullConfig();
  if (!isTargetUrl(urlObj, cfg)) return;

  inflight.set(tabId, url);
  try {
    if (processSwOnlyRules(tabId, url)) return;
    if (failed) await processFallback(tabId, urlObj, cfg);
    else await processAemRewrite(tabId, urlObj, cfg.aemAuthorRewrite);
  } catch (err) {
    console.error(LOG, "Resolve error:", err);
  } finally {
    if (inflight.get(tabId) === url) inflight.delete(tabId);
  }
}

// ─── Listeners ──────────────────────────────────────────────
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) resolveAndRedirect(d.tabId, d.url, false);
});

// Narrow filter: the auto-fix only runs on localhost, so other sites never wake the worker here.
chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (FALLBACK_STATUSES.has(d.statusCode)) resolveAndRedirect(d.tabId, d.url, true);
}, { urls: ["*://localhost/*", "*://127.0.0.1/*"], types: ["main_frame"] });

chrome.tabs.onRemoved.addListener((tabId) => {
  inflight.delete(tabId);
  hopLog.delete(tabId);
});

// ─── Init & messages ────────────────────────────────────────
async function init() {
  try {
    await loadFullConfig(true);
  } catch (err) {
    console.error(LOG, "Init error:", err);
  }
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

async function saveConfig(raw) {
  const config = normalizeConfig(raw);
  cachedConfig = config;                 // set first so onChanged recognizes our own write
  await chrome.storage.local.set({ userConfig: config });
  const skipped = await applyDeclarativeRules(config);
  return { status: "saved", config, skipped };
}

async function handleMessage(msg) {
  switch (msg?.type) {
    case "GET_STATUS":
      return { status: "ok", config: await loadFullConfig() };
    case "SAVE_CONFIG":
      return saveConfig(msg.config);
    case "RESET_CONFIG":
      return saveConfig(await (await fetch(CONFIG_URL)).json());
  }
  return { status: "unknown" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ status: "error", error: String(err?.message || err) }));
  return true;
});
