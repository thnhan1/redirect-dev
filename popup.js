// ============================================================
//  n-redirect - popup.js
// ============================================================

const C = window.RedirectCore;
const DEFAULT_BASE = C.DEFAULT_BASE;
let currentConfig = {
  rules: [],
  aemAuthorRewrite: { enabled: true, localhostBase: DEFAULT_BASE, defaultSiteName: "mysite", prependEditorHtml: false, liveDomains: [] },
  htmlFallback: { enabled: true }
};
let dirty = false;
let autoSaveTimer = null;
let editingRuleIndex = null;
const $ = (id) => document.getElementById(id);

// ─── Auto Save (always on, 1s debounce) ─────────────────────
function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveAllConfig(true), 1000);
}

// ─── Utils ──────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, ms = 2000) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), ms);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("✓ Copied to clipboard"); }
  catch { toast("Copy failed"); }
}

function setDirty(v = true) {
  dirty = v;
  $("saveAllBtn").classList.toggle("dirty", v);
  if (v) scheduleAutoSave();
}

function highlightJson(text) {
  return esc(text).replace(
    /(&quot;(?:\\.|[^\\&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
    (m, str, colon, bool) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (bool) return `<span class="j-bool">${m}</span>`;
      if (m === "null") return `<span class="j-null">null</span>`;
      return `<span class="j-num">${m}</span>`;
    });
}

function ensureShape() {
  const c = currentConfig;
  c.rules = Array.isArray(c.rules) ? c.rules : [];
  c.aemAuthorRewrite = { enabled: false, localhostBase: DEFAULT_BASE, defaultSiteName: "mysite", ...(c.aemAuthorRewrite || {}) };
  c.aemAuthorRewrite.liveDomains = Array.isArray(c.aemAuthorRewrite.liveDomains) ? c.aemAuthorRewrite.liveDomains : [];
  c.htmlFallback = { enabled: false, ...(c.htmlFallback || {}) };
}

// ─── Tabs ───────────────────────────────────────────────────
function activeTab() { return document.querySelector(".tab.active")?.dataset.tab; }

// Sync the current tab's edits into currentConfig before leaving it
function leaveTab(from) {
  if (from === "json") {
    try { currentConfig = JSON.parse($("jsonArea").value); ensureShape(); return true; }
    catch { toast("Invalid JSON - fix it before switching tabs"); return false; }
  }
  collectUiToConfig();
  return true;
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const from = activeTab();
    if (from === tab.dataset.tab) return;
    if (!leaveTab(from)) return;

    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`panel-${tab.dataset.tab}`).classList.add("active");

    if (tab.dataset.tab === "json") setJsonText(JSON.stringify(currentConfig, null, 2));
    else renderAll();
  });
});

// ─── Render ─────────────────────────────────────────────────
function renderTags(containerId, list, attr) {
  $(containerId).innerHTML = list.map((v, i) =>
    `<span class="tag">${esc(v)}<button data-${attr}="${i}" title="Remove">✕</button></span>`).join("");
}

function renderAemSettings() {
  const aem = currentConfig.aemAuthorRewrite;
  $("aemEnabled").checked = !!aem.enabled;
  $("aemSiteName").value = aem.defaultSiteName || "";
  $("aemPrependEditor").checked = !!aem.prependEditorHtml;
  renderTags("liveDomainsList", aem.liveDomains, "domain");
}

function renderFallbackSettings() {
  $("htmlFallbackEnabled").checked = !!currentConfig.htmlFallback.enabled;
  const site = C.cleanSiteName(currentConfig.aemAuthorRewrite.defaultSiteName);
  if ($("fallbackSite")) $("fallbackSite").textContent = site;
}

function renderRulesList() {
  const rules = currentConfig.rules;
  $("ruleCount").textContent = rules.length;
  const box = $("rulesContainer");

  if (!rules.length) {
    box.innerHTML = '<div class="empty"><div class="big">📭</div>No rules yet</div>';
    return;
  }

  const issues = new Map(C.validateRules(rules, currentConfig.aemAuthorRewrite).map((i) => [i.index, i.reason]));

  box.innerHTML = rules.map((r, i) => {
    const fromList = C.getFromList(r);
    const fromHtml = fromList.map((f, idx) =>
      `<div><span style="opacity:0.65">${idx === 0 ? "FROM" : "↳&nbsp;&nbsp;&nbsp;"}</span> ${esc(f)}</div>`
    ).join("");
    const warn = issues.get(i);

    return `
    <div class="rule ${r.enabled ? "" : "off"} ${warn ? "warn" : ""}">
      <div class="rule-head">
        <span class="rule-id">${esc(C.ruleName(r, i))}</span>
        <span class="kind">${esc(r.matchType || "prefix")}</span>
        <label class="switch"><input type="checkbox" data-rule-toggle="${i}" ${r.enabled ? "checked" : ""}><span class="slider"></span></label>
        <button class="icon edit" data-rule-edit="${i}" title="Edit rule">✏️</button>
        <button class="icon del" data-rule-delete="${i}" title="Delete rule">🗑️</button>
      </div>
      <div class="rule-body">
        <div class="from">${fromHtml}</div>
        <div class="to"><span style="opacity:0.65">TO&nbsp;&nbsp;</span> ${esc(r.to)}</div>
        ${r.description ? `<div class="d">${esc(r.description)}</div>` : ""}
      </div>
      ${warn ? `<div class="rule-warn">⚠ Not applied: ${esc(warn)}</div>` : ""}
    </div>`;
  }).join("");
}

function renderAll() {
  renderAemSettings();
  renderFallbackSettings();
  renderRulesList();
}

function setJsonText(text) {
  $("jsonArea").value = text;
  syncJson();
}

function syncJson() {
  const text = $("jsonArea").value;
  $("jsonHighlight").innerHTML = highlightJson(text) + "\n";
  const s = $("jsonStatus");
  try { JSON.parse(text); s.textContent = "✓ Valid JSON"; s.className = "status ok"; }
  catch (e) { s.textContent = "✗ " + e.message; s.className = "status err"; }
}

// ─── Collect / Load / Save ──────────────────────────────────
function collectUiToConfig() {
  ensureShape();
  const aem = currentConfig.aemAuthorRewrite;
  aem.enabled = $("aemEnabled").checked;
  aem.localhostBase = aem.localhostBase || DEFAULT_BASE;
  aem.defaultSiteName = $("aemSiteName").value.trim() || "mysite";
  aem.prependEditorHtml = $("aemPrependEditor").checked;
  currentConfig.htmlFallback.enabled = $("htmlFallbackEnabled").checked;
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res || res.status === "error") throw new Error(res?.error || "No response from background");
  return res;
}

async function loadData() {
  try {
    const res = await send({ type: "GET_STATUS" });
    if (res.config) currentConfig = res.config;
  } catch (err) {
    toast("Could not load config: " + err.message);
  }
  ensureShape();
  renderAll();
  setDirty(false);
}

async function persist(msg, isAuto = false) {
  const res = await send(msg);
  currentConfig = res.config;
  ensureShape();
  // Don't re-render inputs the user may still be typing in during an auto-save
  if (activeTab() === "json") { if (!isAuto) setJsonText(JSON.stringify(currentConfig, null, 2)); }
  else if (isAuto) { renderRulesList(); renderFallbackSettings(); renderTags("liveDomainsList", currentConfig.aemAuthorRewrite.liveDomains, "domain"); }
  else renderAll();
  setDirty(false);
  if (res.skipped?.length) {
    toast(`Saved. Skipped ${res.skipped.length} rule(s): ${res.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`, 5000);
  } else {
    toast(isAuto ? "✓ Auto-saved" : "✓ Saved & applied");
  }
}

async function saveAllConfig(isAuto = false) {
  try {
    if (!leaveTab(activeTab())) return;
    await persist({ type: "SAVE_CONFIG", config: currentConfig }, isAuto);
  } catch (err) {
    if (!isAuto) toast("Save failed: " + err.message);
  }
}

// ─── Edit mode (toggle AEM Editor / Preview) ────────────────
$("openInEditorBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const urlObj = C.parseUrl(tab?.url);
  if (!urlObj) return toast("Invalid page URL");
  if (!/^https?:$/.test(urlObj.protocol)) return toast("This page is not supported");

  const aem = currentConfig.aemAuthorRewrite;
  const base = (aem.localhostBase || DEFAULT_BASE).replace(/\/+$/, "");
  const tail = urlObj.search + urlObj.hash;
  const path = C.cleanSlashes(urlObj.pathname);

  // Editor -> Preview
  if (path.startsWith("/editor.html/")) {
    await chrome.tabs.update(tab.id, { url: base + path.slice("/editor.html".length) + tail });
    return toast("Switched to Preview");
  }
  if (C.isLocalBase(urlObj, aem) && !path.startsWith("/content/") && C.isAemSystemPath(path)) {
    return toast("Not a content page");
  }

  // Preview / Live -> Editor
  const preview = C.buildAemUrl(path, "", { ...aem, prependEditorHtml: false });
  const target = C.withHtmlExt(preview) || preview;
  const contentPath = target.slice(base.length);
  await chrome.tabs.update(tab.id, { url: `${base}/editor.html${contentPath}${tail}` });
  toast("Opened in AEM Editor");
});

// ─── Events ─────────────────────────────────────────────────
$("saveAllBtn").addEventListener("click", () => saveAllConfig(false));

// Any form change marks the config as dirty
["aemEnabled", "aemSiteName", "aemPrependEditor", "htmlFallbackEnabled"].forEach((id) => {
  $(id).addEventListener("input", () => { collectUiToConfig(); renderFallbackSettings(); setDirty(); });
});

// Live domain: scheme comes from the selector, the user only types the host.
// A pasted full URL is accepted too: its scheme wins and the path is dropped.
function addDomain() {
  const input = $("newLiveDomainInput");
  const raw = input.value.trim();
  if (!raw) return;
  const pastedScheme = raw.match(/^(https?):\/\//i)?.[1]?.toLowerCase();
  if (pastedScheme) $("newLiveDomainScheme").value = pastedScheme;
  const origin = C.toOrigin(raw, $("newLiveDomainScheme").value);
  if (!origin) return toast("Invalid domain");

  const aem = currentConfig.aemAuthorRewrite;
  if (origin === C.toOrigin(aem.localhostBase || DEFAULT_BASE, "http")) return toast("Live domain cannot be the localhost base (redirect loop)");
  if (aem.liveDomains.includes(origin)) return toast("Already exists");

  aem.liveDomains.push(origin);
  input.value = "";
  renderAemSettings();
  setDirty();
}

$("addLiveDomainBtn").addEventListener("click", addDomain);
$("newLiveDomainInput").addEventListener("keydown", (e) => e.key === "Enter" && addDomain());
// Typing/pasting "https://..." switches the selector and strips the scheme from the field
$("newLiveDomainInput").addEventListener("input", (e) => {
  const m = e.target.value.match(/^\s*(https?):\/\/(.*)$/i);
  if (!m) return;
  $("newLiveDomainScheme").value = m[1].toLowerCase();
  e.target.value = m[2];
});

// Event delegation: no need to re-bind listeners after each render
$("liveDomainsList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-domain]");
  if (!b) return;
  currentConfig.aemAuthorRewrite.liveDomains.splice(+b.dataset.domain, 1);
  renderAemSettings(); setDirty();
});
$("rulesContainer").addEventListener("change", (e) => {
  if (e.target.dataset.ruleToggle === undefined) return;
  currentConfig.rules[+e.target.dataset.ruleToggle].enabled = e.target.checked;
  renderRulesList(); setDirty();
});

function startEditRule(idx) {
  const r = currentConfig.rules[idx];
  if (!r) return;
  editingRuleIndex = idx;
  $("rulesFormTitle").textContent = `Edit rule: ${C.ruleName(r, idx)}`;
  $("ruleNameInput").value = r.name || "";
  $("ruleTypeInput").value = r.matchType || "prefix";
  $("ruleFromInput").value = C.getFromList(r).join("\n");
  $("ruleToInput").value = r.to || "";
  $("ruleDescInput").value = r.description || "";
  $("addRuleBtn").textContent = "✓ Save changes";
  $("cancelRuleEditBtn").classList.remove("hidden");
  $("ruleFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
  $("ruleFromInput").focus();
}

const RULE_FORM_FIELDS = ["ruleNameInput", "ruleFromInput", "ruleToInput", "ruleDescInput"];

function cancelEditRule() {
  editingRuleIndex = null;
  $("rulesFormTitle").textContent = "Add new rule";
  RULE_FORM_FIELDS.forEach((i) => ($(i).value = ""));
  $("addRuleBtn").textContent = "＋ Add rule";
  $("cancelRuleEditBtn").classList.add("hidden");
}

$("rulesContainer").addEventListener("click", (e) => {
  const editBtn = e.target.closest("[data-rule-edit]");
  if (editBtn) return startEditRule(+editBtn.dataset.ruleEdit);
  const delBtn = e.target.closest("[data-rule-delete]");
  if (delBtn) {
    const idx = +delBtn.dataset.ruleDelete;
    if (editingRuleIndex === idx) cancelEditRule();
    else if (editingRuleIndex !== null && editingRuleIndex > idx) editingRuleIndex--;
    currentConfig.rules.splice(idx, 1);
    renderRulesList(); setDirty();
  }
});

$("cancelRuleEditBtn").addEventListener("click", cancelEditRule);

$("addRuleBtn").addEventListener("click", () => {
  const fromRaw = $("ruleFromInput").value.trim();
  const to = $("ruleToInput").value.trim();
  const matchType = $("ruleTypeInput").value;

  if (!fromRaw || !to) return toast("From and To are required");

  const fromList = fromRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!fromList.length) return toast("At least one source URL is required");

  // Name is a free label: optional and may repeat (rules are identified by position)
  const idx = editingRuleIndex !== null ? editingRuleIndex : currentConfig.rules.length;
  const name = $("ruleNameInput").value.trim() || `Rule ${idx + 1}`;
  const from = fromList.length > 1 ? fromList : fromList[0];
  const enabled = editingRuleIndex !== null ? (currentConfig.rules[editingRuleIndex]?.enabled ?? true) : true;
  const ruleData = { name, description: $("ruleDescInput").value.trim(), enabled, matchType, from, to };

  // Validate against the full rule set: rejects invalid regex and recursive / looping rules
  const nextRules = [...currentConfig.rules];
  nextRules[idx] = { ...ruleData, enabled: true };
  const issue = C.validateRules(nextRules, currentConfig.aemAuthorRewrite).find((i) => i.index === idx);
  if (issue) return toast(`✗ ${issue.reason}`, 5000);

  if (editingRuleIndex !== null) {
    currentConfig.rules[editingRuleIndex] = ruleData;
    cancelEditRule();
    toast("✓ Rule updated");
  } else {
    currentConfig.rules.push(ruleData);
    RULE_FORM_FIELDS.forEach((i) => ($(i).value = ""));
    toast("✓ Rule added");
  }

  renderRulesList(); setDirty();
});

// JSON editor
$("jsonArea").addEventListener("input", () => {
  syncJson();
  // Only auto-save once the JSON is valid
  try {
    JSON.parse($("jsonArea").value);
    setDirty();
  } catch {
    // still typing
  }
});
$("jsonArea").addEventListener("scroll", (e) => {
  $("jsonHighlight").scrollTop = e.target.scrollTop;
  $("jsonHighlight").scrollLeft = e.target.scrollLeft;
});
$("copyJsonBtn").addEventListener("click", () => copy($("jsonArea").value));
$("formatJsonBtn").addEventListener("click", () => {
  try { setJsonText(JSON.stringify(JSON.parse($("jsonArea").value), null, 2)); toast("✓ Formatted"); }
  catch { toast("Invalid JSON"); }
});
$("resetBtn").addEventListener("click", async () => {
  if (!confirm("Restore the whole configuration to defaults?")) return;
  try { await persist({ type: "RESET_CONFIG" }); } catch (err) { toast("Error: " + err.message); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveAllConfig(false); }
});

// Theme toggle lives in theme.js (loaded in <head>).

// ─── Init ───────────────────────────────────────────────────
loadData();
