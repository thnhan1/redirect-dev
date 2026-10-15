// ============================================================
//  n-redirect - rules-core.js
//
//  Shared, side-effect-free helpers used by BOTH:
//    - background.js  (via importScripts)
//    - popup.html     (via <script>)
//  Keeping a single implementation guarantees the popup validates
//  rules with exactly the same semantics the service worker uses.
// ============================================================

(() => {
  const DEFAULT_BASE = "http://localhost:4502";
  const MATCH_TYPES = ["prefix", "exact", "regex"];
  const MAX_CHAIN = 8; // hops followed when simulating a redirect chain

  // First path segments that belong to AEM itself, never to a site page.
  const AEM_SYSTEM_ROOTS = new Set([
    "libs", "apps", "etc", "conf", "var", "bin", "system", "crx", "mnt", "aem",
    "home", "tmp", "oak", "editor.html", "sites.html", "assets.html", "projects.html",
    "start.html", "welcome.html", "useradmin", "crx.html", "siteadmin"
  ]);

  // ─── Generic URL helpers ───────────────────────────────────
  const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);
  const parseUrl = (u) => { try { return new URL(u); } catch { return null; } };
  const cleanSlashes = (p) => p.replace(/\/{2,}/g, "/");
  const cleanSiteName = (s) => String(s || "mysite").trim().replace(/^\/+|\/+$/g, "").replace(/^content\//, "") || "mysite";

  // "example.com", "https://example.com/us/en" -> "https://example.com"
  function toOrigin(input, defaultScheme = "https") {
    let s = String(input || "").trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${defaultScheme}://${s.replace(/^\/+/, "")}`;
    const u = parseUrl(s);
    if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) return null;
    return u.origin;
  }

  function sameHostPort(a, b) {
    if (!a || !b) return false;
    const port = (u) => u.port || (u.protocol === "https:" ? "443" : "80");
    const loop = (h) => (h === "127.0.0.1" ? "localhost" : h);
    return loop(a.hostname.toLowerCase()) === loop(b.hostname.toLowerCase()) && port(a) === port(b);
  }

  function isLocalBase(urlObj, aem) {
    return sameHostPort(urlObj, parseUrl(aem?.localhostBase || DEFAULT_BASE));
  }

  // ─── AEM path helpers ──────────────────────────────────────
  function isAemSystemPath(path) {
    const first = (path.split("/")[1] || "").toLowerCase();
    return AEM_SYSTEM_ROOTS.has(first) || first.includes(".");
  }

  // Idempotent: a path already under /content/ or /editor.html/ is never prefixed again.
  function buildAemUrl(path, tail, aem) {
    const base = String(aem?.localhostBase || DEFAULT_BASE).replace(/\/+$/, "");
    const site = cleanSiteName(aem?.defaultSiteName);
    let p = cleanSlashes(path.startsWith("/") ? path : "/" + path);
    if (!p.startsWith("/content/") && !p.startsWith("/editor.html/")) {
      p = p === "/" ? `/content/${site}` : `/content/${site}${p}`;
    }
    if (aem?.prependEditorHtml && !p.startsWith("/editor.html/")) p = `/editor.html${p}`;
    return base + p + (tail || "");
  }

  // Append .html to the path (never touches query/hash). Null if the last segment already has an extension.
  function withHtmlExt(urlStr) {
    const u = parseUrl(urlStr);
    if (!u) return null;
    const path = u.pathname.replace(/\/+$/, "");
    const lastSeg = path.split("/").pop() || "";
    if (!path || lastSeg.includes(".")) return null;
    u.pathname = path + ".html";
    return u.toString();
  }

  // Candidate AEM URLs (preferred first) for a live-site path.
  function aemCandidates(path, tail, aem) {
    const raw = buildAemUrl(path, tail, aem);
    const html = withHtmlExt(raw);
    return html ? [html, raw] : [raw];
  }

  // ─── Rules ─────────────────────────────────────────────────
  function getFromList(rule) {
    if (!rule || rule.from == null) return [];
    const list = Array.isArray(rule.from) ? rule.from : String(rule.from).split(/\r?\n/);
    return list.map((s) => String(s).trim()).filter(Boolean);
  }

  // Accept both JS-style ($1) and DNR-style (\1) back-references.
  const toJsReplacement = (to) => String(to).replace(/\\(\d)/g, "$$$1");
  const toDnrSubstitution = (to) => String(to).replace(/\$(\d)/g, "\\$1").replace(/\$&/g, "\\0");

  const regexCache = new Map();
  function compile(pat) {
    if (regexCache.has(pat)) return regexCache.get(pat);
    let re = null;
    try { re = new RegExp(pat); } catch {}
    regexCache.set(pat, re);
    return re;
  }

  // Returns the redirect target for a single pattern, or null when it does not match.
  function applyPattern(rule, pat, url) {
    switch (rule.matchType || "prefix") {
      case "exact": return url === pat ? rule.to : null;
      case "prefix": return url.startsWith(pat) ? rule.to + url.slice(pat.length) : null;
      case "regex": {
        const re = compile(pat);
        return re && re.test(url) ? url.replace(re, toJsReplacement(rule.to)) : null;
      }
    }
    return null;
  }

  function applyRule(rule, url) {
    if (!rule?.enabled || !rule.to) return null;
    for (const pat of getFromList(rule)) {
      const out = applyPattern(rule, pat, url);
      if (out !== null) return out;
    }
    return null;
  }

  // Best-effort literal prefix of a regex, e.g. "^(http://a/content/site)(.*)" -> "http://a/content/site"
  function regexLiteralPrefix(pat) {
    const s = pat.replace(/^\^/, "");
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const next = s[i + 1] || "";
      if (c === "\\") {
        if (next && /\W/.test(next)) { out += next; i++; continue; }
        break; // \d, \w, \s ... -> not literal anymore
      }
      if (c === "(") { if (s.startsWith("?:", i + 1)) i += 2; continue; }
      if (c === ")") continue;
      if (c === "." && !"*+?{".includes(next)) { out += "."; continue; }
      if (".*+?[]{}|$".includes(c)) {
        if ("*?{".includes(c)) out = out.slice(0, -1); // previous char is optional
        break;
      }
      out += c;
    }
    return out;
  }

  // Inputs that the rule would match + outputs it can produce, used to simulate chains.
  function ruleProbes(rule) {
    const type = rule.matchType || "prefix";
    const probes = []; // { input?, output }
    for (const pat of getFromList(rule)) {
      const inputs = type === "regex"
        ? [regexLiteralPrefix(pat), regexLiteralPrefix(pat) + "/zz-probe"]
        : type === "prefix" ? [pat, pat + "zz-probe/zz"] : [pat];
      for (const input of inputs) {
        if (!input) continue;
        const output = applyPattern(rule, pat, input);
        if (output !== null) probes.push({ input, output });
      }
    }
    if (type === "regex") {
      const tpl = toJsReplacement(rule.to);
      probes.push({ output: tpl.replace(/\$(\d|&)/g, "") }, { output: tpl.replace(/\$(\d|&)/g, "zz-probe") });
    }
    return probes;
  }

  // One simulated hop: a user rule, or the AEM live-domain rewrite (raw path, no probing).
  function nextHop(rules, url, aem) {
    for (const r of rules) {
      const out = applyRule(r, url);
      if (out !== null) return out;
    }
    if (aem?.enabled) {
      const u = parseUrl(url);
      if (u && (aem.liveDomains || []).includes(u.origin)) return buildAemUrl(u.pathname, u.search + u.hash, aem);
    }
    return null;
  }

  function simulateChain(rules, start, aem, seenInit = []) {
    const seen = new Set(seenInit);
    let cur = start;
    seen.add(cur);
    for (let hop = 0; hop < MAX_CHAIN; hop++) {
      const next = nextHop(rules, cur, aem);
      if (next === null) return null;
      if (next === cur) return "redirects to itself";
      if (seen.has(next)) return `redirect loop (${next})`;
      seen.add(next);
      cur = next;
    }
    return `recursive redirect - target keeps matching (e.g. ${cur})`;
  }

  function ruleName(rule, index) {
    if (!rule) return `Rule #${(index ?? 0) + 1}`;
    return rule.name || rule.id || `Rule #${(index ?? 0) + 1}`;
  }

  // Returns [{ index, name, id, reason }] for every rule that is invalid or recursive.
  function validateRules(rules, aem) {
    const list = Array.isArray(rules) ? rules : [];
    const active = list.filter((r) => r?.enabled);
    const issues = [];
    list.forEach((rule, index) => {
      if (!rule?.enabled) return;
      const name = ruleName(rule, index);
      const id = rule.id || name;
      const type = rule.matchType || "prefix";
      const fromList = getFromList(rule);
      if (!MATCH_TYPES.includes(type)) return issues.push({ index, name, id, reason: `Unknown match type "${type}"` });
      if (!fromList.length || !rule.to) return issues.push({ index, name, id, reason: "From and To are required" });
      if (type === "regex") {
        const bad = fromList.find((p) => !compile(p));
        if (bad) return issues.push({ index, name, id, reason: `Invalid regex: ${bad}` });
      } else if (!isHttp(rule.to) || !parseUrl(rule.to)) {
        return issues.push({ index, name, id, reason: `To must be a full http(s) URL` });
      }
      // Classic mistake: prefix rule whose target starts with its own source -> /index/index/index...
      if (type === "prefix") {
        const self = fromList.find((p) => rule.to.startsWith(p));
        if (self) return issues.push({ index, name, id, reason: `Recursive: To starts with From "${self}" (use match type "exact")` });
      }
      for (const { input, output } of ruleProbes(rule)) {
        const reason = simulateChain(active, output, aem, input ? [input] : []);
        if (reason) return issues.push({ index, name, id, reason: `Recursive: ${reason}` });
      }
    });
    return issues;
  }

  globalThis.RedirectCore = {
    DEFAULT_BASE, MATCH_TYPES,
    isHttp, parseUrl, cleanSlashes, cleanSiteName, toOrigin, isLocalBase, isAemSystemPath,
    buildAemUrl, withHtmlExt, aemCandidates,
    getFromList, toDnrSubstitution, compile, applyPattern, applyRule, validateRules, ruleName
  };
})();
