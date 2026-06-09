/**
 * content-script.js — Markdown Review Extension
 *
 * Enhances GitHub PR diff view for .md files:
 *   1. Enhances .md files when opened in "rich diff" view (GitHub's built-in markdown renderer)
 *   2. Overlays comment badges on sections that have existing review comments
 *   3. Clicking a badge navigates to that line in the source diff
 */

(() => {
  "use strict";

  const { isPRFilesPage, qs, qsa, createElement, debounce } = DomHelpers;
  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const usesPromiseApi = typeof globalThis.browser !== "undefined";

  function _readLocalStorage(defaults, onSuccess, onError = () => {}) {
    if (!extensionApi?.storage?.local?.get) {
      onError();
      return;
    }

    if (usesPromiseApi) {
      extensionApi.storage.local.get(defaults).then(onSuccess).catch(() => onError());
      return;
    }

    extensionApi.storage.local.get(defaults, (items) => {
      if (extensionApi.runtime?.lastError) {
        onError();
        return;
      }

      onSuccess(items);
    });
  }

  function _listenLocalStorageChanges(onChange) {
    extensionApi?.storage?.onChanged?.addListener?.((changes, areaName) => {
      if (areaName !== "local") return;
      onChange(changes);
    });
  }

  function _sendRuntimeMessage(message) {
    if (!extensionApi?.runtime?.sendMessage) return;

    try {
      const result = extensionApi.runtime.sendMessage(message);
      if (usesPromiseApi && typeof result?.catch === "function") {
        result.catch(() => {});
      }
    } catch {
      // Ignore icon update failures in page contexts where the runtime bridge is unavailable.
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Parse embedded payload                                           */
  /* ---------------------------------------------------------------- */

  function _getPayload() {
    const scriptEl = document.querySelector('script[data-target="react-app.embeddedData"]');
    if (!scriptEl) return null;
    try {
      return JSON.parse(scriptEl.textContent);
    } catch { return null; }
  }

  function _getDiffSummaries() {
    const payload = _getPayload();
    const route = payload?.payload?.pullRequestsChangesRoute ||
                  payload?.payload?.pullRequestsFilesRoute;
    return route?.diffSummaries || [];
  }

  function _getHeadOid() {
    const payload = _getPayload();
    const route = payload?.payload?.pullRequestsChangesRoute ||
                  payload?.payload?.pullRequestsFilesRoute;
    const candidateOids = [
      route?.comparison?.fullDiff?.headOid,
      route?.comparison?.headOid,
      route?.comparison?.headRefOid,
      route?.comparison?.headRef?.target?.oid,
      route?.comparison?.headRef?.oid,
      route?.pullRequest?.headRefOid,
      route?.pullRequest?.headRef?.target?.oid,
      payload?.payload?.pullRequest?.headRefOid,
    ];

    for (const oid of candidateOids) {
      if (_isCommitOid(oid)) return oid;
    }

    return "";
  }

  function _getRepoInfo() {
    const payload = _getPayload();
    const route = payload?.payload?.pullRequestsChangesRoute ||
                  payload?.payload?.pullRequestsFilesRoute;
    const repo = route?.repository || {};
    return { owner: repo.ownerLogin || "", name: repo.name || "" };
  }

  function _getHeadRepoInfo() {
    const payload = _getPayload();
    const route = payload?.payload?.pullRequestsChangesRoute ||
                  payload?.payload?.pullRequestsFilesRoute;

    const headRepo =
      route?.comparison?.fullDiff?.headRepository ||
      route?.comparison?.headRepository ||
      route?.comparison?.headRef?.repository ||
      null;

    if (headRepo) {
      return {
        owner: headRepo.ownerLogin || headRepo.owner?.login || "",
        name: headRepo.name || "",
      };
    }

    return _getRepoInfo();
  }

  /* ---------------------------------------------------------------- */
  /*  Fetch full file content                                            */
  /* ---------------------------------------------------------------- */

  const _fileCache = new Map();
  const _fileRetryAfter = new Map();
  const _lineMapByDigest = new Map();
  const _localCommentActivityByDigest = new Map();
  const _suppressedCommentLinesByDigest = new Map();
  let _commentActivityTrackingInstalled = false;
  const FILE_FETCH_RETRY_MS = 60 * 1000;
  const LOCAL_COMMENT_ACTIVITY_TTL_MS = 3 * 60 * 1000;
  const LOCAL_EDITOR_ACTIVITY_TTL_MS = 10 * 60 * 1000;
  const LOCAL_SUPPRESSION_TTL_MS = 2 * 60 * 1000;

  function _normalizeTextForMatch(text) {
    return (text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function _stripMarkdownSyntax(text) {
    return text
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\*\s+/, "")
      .replace(/^-\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
  }

  function _isCommitOid(value) {
    return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
  }

  function _isValidPathDigest(value) {
    return /^[0-9a-f]{10,}$/i.test(String(value || ""));
  }

  function _getHashLineTarget() {
    const match = String(window.location.hash || "").match(/^#diff-([0-9a-f]+)(?:R(\d+))?/i);
    if (!match) return null;

    const pathDigest = String(match[1] || "").toLowerCase();
    const lineNum = match[2] ? parseInt(match[2], 10) : null;

    return {
      pathDigest,
      lineNum: Number.isInteger(lineNum) ? lineNum : null,
    };
  }

  function _getActiveTimedLineMap(mapByDigest, pathDigest) {
    const lineMap = mapByDigest.get(pathDigest);
    if (!lineMap) return null;

    const now = Date.now();
    for (const [lineNum, expiresAt] of lineMap) {
      if (expiresAt <= now) {
        lineMap.delete(lineNum);
      }
    }

    if (lineMap.size === 0) {
      mapByDigest.delete(pathDigest);
      return null;
    }

    return lineMap;
  }

  function _setTimedLine(mapByDigest, pathDigest, lineNum, ttlMs) {
    if (!_isValidPathDigest(pathDigest) || !Number.isInteger(lineNum) || lineNum <= 0) return false;

    let lineMap = _getActiveTimedLineMap(mapByDigest, pathDigest);
    if (!lineMap) {
      lineMap = new Map();
      mapByDigest.set(pathDigest, lineMap);
    }

    const now = Date.now();
    const expiresAt = now + ttlMs;
    const existing = lineMap.get(lineNum) || 0;
    lineMap.set(lineNum, Math.max(existing, expiresAt));
    return true;
  }

  function _deleteTimedLine(mapByDigest, pathDigest, lineNum) {
    if (!_isValidPathDigest(pathDigest) || !Number.isInteger(lineNum) || lineNum <= 0) return false;

    const lineMap = _getActiveTimedLineMap(mapByDigest, pathDigest);
    if (!lineMap) return false;

    const changed = lineMap.delete(lineNum);
    if (lineMap.size === 0) {
      mapByDigest.delete(pathDigest);
    }
    return changed;
  }

  function _markLocalCommentActivity(pathDigest, lineNum, ttlMs = LOCAL_COMMENT_ACTIVITY_TTL_MS) {
    return _setTimedLine(_localCommentActivityByDigest, pathDigest, lineNum, ttlMs);
  }

  function _unmarkLocalCommentActivity(pathDigest, lineNum) {
    return _deleteTimedLine(_localCommentActivityByDigest, pathDigest, lineNum);
  }

  function _markSuppressedCommentLine(pathDigest, lineNum, ttlMs = LOCAL_SUPPRESSION_TTL_MS) {
    return _setTimedLine(_suppressedCommentLinesByDigest, pathDigest, lineNum, ttlMs);
  }

  function _unmarkSuppressedCommentLine(pathDigest, lineNum) {
    return _deleteTimedLine(_suppressedCommentLinesByDigest, pathDigest, lineNum);
  }

  function _syncLiveEditorActivity(fileContainer, pathDigest) {
    if (!_isValidPathDigest(pathDigest)) return;

    const editors = qsa("textarea", fileContainer).filter((el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.disabled || el.readOnly) return false;
      if (el.offsetParent === null) return false;
      return true;
    });

    for (const editor of editors) {
      const lineNum = _getLineNumberFromActionContext(editor, fileContainer);
      if (!lineNum) continue;
      _markLocalCommentActivity(pathDigest, lineNum, LOCAL_EDITOR_ACTIVITY_TTL_MS);
      _unmarkSuppressedCommentLine(pathDigest, lineNum);
    }
  }

  function _extractLineNumberFromRow(row) {
    if (!row) return null;
    const lineNode = qs("[data-line-number]", row);
    if (!lineNode) return null;
    const parsed = parseInt(lineNode.getAttribute("data-line-number") || "", 10);
    if (!parsed || Number.isNaN(parsed)) return null;
    return parsed;
  }

  function _getLineNumberFromActionContext(actionEl, fileContainer, pathDigest = "") {
    const direct = actionEl.closest("[data-line-number]");
    if (direct) {
      const parsed = parseInt(direct.getAttribute("data-line-number") || "", 10);
      if (parsed && !Number.isNaN(parsed)) return parsed;
    }

    const startRow = actionEl.closest("tr");
    if (!startRow) return null;

    let row = startRow;
    let hops = 0;
    while (row && fileContainer.contains(row) && hops < 8) {
      const lineNum = _extractLineNumberFromRow(row);
      if (lineNum) return lineNum;
      row = row.previousElementSibling;
      hops++;
    }

    const hashTarget = _getHashLineTarget();
    if (hashTarget && hashTarget.lineNum && hashTarget.pathDigest === String(pathDigest || "").toLowerCase()) {
      return hashTarget.lineNum;
    }

    return null;
  }

  function _installCommentActivityTracking() {
    if (_commentActivityTrackingInstalled) return;
    _commentActivityTrackingInstalled = true;

    document.addEventListener("click", (event) => {
      const actionEl = event.target?.closest?.("button, [role='button'], summary");
      if (!actionEl) return;

      const label = _normalizeTextForMatch(
        `${actionEl.textContent || ""} ${actionEl.getAttribute("aria-label") || ""}`
      );
      if (!label) return;

      if (!_isExtensionEnabled()) return;

      const isMarkAction =
        label.includes("line comment") ||
        label.includes("start review") ||
        label.includes("add review comment") ||
        label.includes("add single comment") ||
        label.includes("add comment") ||
        label.includes("submit review comment") ||
        label.includes("submit review") ||
        label.includes("comment on this line") ||
        label.includes("reply");

      const isClearAction =
        label === "cancel" ||
        label.includes("cancel comment") ||
        label.includes("discard review") ||
        label.includes("delete comment") ||
        label.includes("remove comment") ||
        label.includes("delete") ||
        label.includes("remove");

      if (!isMarkAction && !isClearAction) return;

      let fileContainer = actionEl.closest("div[id^='diff-']");
      let pathDigest = String((fileContainer?.id || "").replace(/^diff-/, "")).toLowerCase();
      const hashTarget = _getHashLineTarget();

      if (!_isValidPathDigest(pathDigest) && hashTarget?.pathDigest) {
        pathDigest = hashTarget.pathDigest;
      }

      if (!fileContainer && _isValidPathDigest(pathDigest)) {
        fileContainer = document.getElementById(`diff-${pathDigest}`);
      }

      if (!_isValidPathDigest(pathDigest)) return;

      const lineNum = _getLineNumberFromActionContext(actionEl, fileContainer, pathDigest)
        || hashTarget?.lineNum
        || null;

      if (!lineNum) {
        if (fileContainer) {
          _syncLiveEditorActivity(fileContainer, pathDigest);
        }
        setTimeout(processFiles, 120);
        return;
      }

      let changed = false;
      if (isMarkAction) {
        changed = _markLocalCommentActivity(pathDigest, lineNum, LOCAL_COMMENT_ACTIVITY_TTL_MS);
        _unmarkSuppressedCommentLine(pathDigest, lineNum);
      } else if (isClearAction) {
        const removed = _unmarkLocalCommentActivity(pathDigest, lineNum);
        const suppressed = _markSuppressedCommentLine(pathDigest, lineNum, LOCAL_SUPPRESSION_TTL_MS);
        changed = removed || suppressed;
      }

      if (changed) {
        setTimeout(processFiles, 50);
      }
    }, true);
  }

  function _toRawUrlFromBlobUrl(blobUrl) {
    try {
      const url = new URL(blobUrl, window.location.origin);
      if (!url.pathname.includes("/blob/")) return null;
      url.pathname = url.pathname.replace("/blob/", "/raw/");
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return null;
    }
  }

  function _looksLikeHtml(text) {
    const sample = (text || "").slice(0, 300).toLowerCase();
    return sample.includes("<!doctype html") || sample.includes("<html");
  }

  const THEME_DARK_CLASS = "md-review-theme-dark";
  const THEME_MODE_STORAGE_KEY = "md-review-theme-mode";
  const GITHUB_DARK_MODE_SELECTORS = [
    "[data-color-mode='dark']",
    ".dark",
  ];
  const DEFAULT_THEME_MODE = "auto";
  let _lastLoggedThemeMode = null;
  let _themeMode = DEFAULT_THEME_MODE;

  function _parseCssColor(color) {
    const value = String(color || "").trim().toLowerCase();
    if (!value) return null;

    const hex = value.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      const digits = hex[1];
      const expand = (segment) => segment.length === 1 ? segment + segment : segment;

      if (digits.length === 3 || digits.length === 4) {
        return [
          parseInt(expand(digits[0]), 16),
          parseInt(expand(digits[1]), 16),
          parseInt(expand(digits[2]), 16),
        ];
      }

      if (digits.length === 6 || digits.length === 8) {
        return [
          parseInt(digits.slice(0, 2), 16),
          parseInt(digits.slice(2, 4), 16),
          parseInt(digits.slice(4, 6), 16),
        ];
      }
    }

    const rgb = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (rgb) {
      return [
        parseInt(rgb[1], 10),
        parseInt(rgb[2], 10),
        parseInt(rgb[3], 10),
      ];
    }

    return null;
  }

  function _isDarkCssColor(color) {
    const rgb = _parseCssColor(color);
    if (!rgb) return false;

    const [r, g, b] = rgb.map((channel) => channel / 255);
    const luminance =
      0.2126 * r +
      0.7152 * g +
      0.0722 * b;

    return luminance < 0.45;
  }

  function _readGithubThemeColorVar(varName) {
    const root = document.documentElement;
    const body = document.body;
    const candidates = [root, body].filter(Boolean);

    for (const node of candidates) {
      const value = window.getComputedStyle(node).getPropertyValue(varName).trim();
      if (value) return value;
    }

    return "";
  }

  function _isGitHubDarkMode() {
    if (typeof document === "undefined") return false;

    const root = document.documentElement;
    const body = document.body;

    if (root?.getAttribute("data-color-mode") === "dark") return true;
    if (body?.getAttribute("data-color-mode") === "dark") return true;

    if (root?.classList.contains("dark") || body?.classList.contains("dark")) return true;

    const matchingSelector = GITHUB_DARK_MODE_SELECTORS.some((selector) => {
      return Boolean(root?.matches?.(selector) || body?.matches?.(selector));
    });
    if (matchingSelector) return true;

    const canvasColor = _readGithubThemeColorVar("--color-canvas-default");
    if (canvasColor) return _isDarkCssColor(canvasColor);

    const bgColor = body ? window.getComputedStyle(body).backgroundColor : "";
    if (bgColor) return _isDarkCssColor(bgColor);

    return false;
  }

  function _normalizeThemeMode(value) {
    const mode = String(value || "").toLowerCase();
    return mode === "light" || mode === "dark" ? mode : "auto";
  }

  function _getThemeMode() {
    return _themeMode;
  }

  function _setThemeMode(value) {
    _themeMode = _normalizeThemeMode(value);
    _syncThemeMode();
  }

  function _loadThemeModePreference() {
    _readLocalStorage({ [THEME_MODE_STORAGE_KEY]: DEFAULT_THEME_MODE }, (items) => {
      _setThemeMode(items?.[THEME_MODE_STORAGE_KEY]);
    });
  }

  function _syncThemeMode() {
    const root = document.documentElement;
    if (!root) return;
    const mode = _getThemeMode();
    const isDark = mode === "dark" ? true : mode === "light" ? false : _isGitHubDarkMode();
    root.classList.toggle(THEME_DARK_CLASS, isDark);

    if (_lastLoggedThemeMode !== isDark || _lastLoggedThemeMode === null) {
      _lastLoggedThemeMode = isDark;
      const label = mode === "auto"
        ? `GitHub dark mode detected: ${isDark ? "dark" : "light"}`
        : `Theme forced: ${mode}`;
      console.log(`[MD Review] ${label}`);
    }
  }

  function _installThemeObserver() {
    _syncThemeMode();

    _loadThemeModePreference();

    const observer = new MutationObserver(() => {
      _syncThemeMode();
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-color-mode"],
      subtree: false,
    });

    const attachBodyObserver = () => {
      if (!document.body) return;
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "data-color-mode"],
        subtree: false,
      });
    };

    attachBodyObserver();
    document.addEventListener("DOMContentLoaded", attachBodyObserver, { once: true });

    document.addEventListener("DOMContentLoaded", _syncThemeMode, { once: true });
    document.addEventListener("turbo:load", _syncThemeMode);
    document.addEventListener("pjax:end", _syncThemeMode);

    _listenLocalStorageChanges((changes) => {
      const change = changes?.[THEME_MODE_STORAGE_KEY];
      if (!change) return;
      _setThemeMode(change.newValue);
    });
  }

  function _createCommentBadgeIcon(size = 16) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("fill", "currentColor");

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"
    );
    svg.appendChild(path);

    return svg;
  }

  function _isMarkdownPath(path) {
    return typeof path === "string" && /\.md$/i.test(path.trim());
  }

  function _normalizeRepoPath(path) {
    return (path || "").trim().replace(/^\/+/, "");
  }

  function _getContainerFilePath(container) {
    if (!container) return "";

    const directCandidates = [
      container.getAttribute("data-tagsearch-path"),
      container.getAttribute("data-path"),
      qs(".file-header [data-path]", container)?.getAttribute("data-path"),
      qs(".file-info [data-path]", container)?.getAttribute("data-path"),
      qs(".file-header a[title]", container)?.getAttribute("title"),
      qs(".file-info a[title]", container)?.getAttribute("title"),
    ];

    for (const candidate of directCandidates) {
      const normalized = _normalizeRepoPath(candidate);
      if (normalized) return normalized;
    }

    const pathLinks = qsa(".file-header a, .file-info a", container);
    for (const link of pathLinks) {
      const title = _normalizeRepoPath(link.getAttribute("title") || "");
      if (title) return title;

      const text = _normalizeRepoPath(link.textContent || "");
      if (!text) continue;
      if (text.includes("/") || /\.[a-z0-9]+$/i.test(text)) {
        return text;
      }
    }

    return "";
  }

  function _getRawUrlCandidates(filePath, container) {
    const candidates = [];
    const blobCandidates = [];
    const normalizedPath = (filePath || "").replace(/^\/+/, "");
    if (!normalizedPath) return candidates;

    const encodedPath = normalizedPath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    // Per-file candidates from the file header.
    if (container) {
      const blobLinks = qsa('a[href*="/blob/"]', container);
      for (const link of blobLinks) {
        const raw = _toRawUrlFromBlobUrl(link.href);
        if (!raw) continue;

        let decodedPathname = "";
        try {
          decodedPathname = decodeURIComponent(new URL(raw).pathname);
        } catch {
          continue;
        }

        const suffix = `/${normalizedPath}`;
        if (!decodedPathname.endsWith(suffix)) continue;

        const rawPrefix = decodedPathname.slice(0, -suffix.length);
        const refMatch = rawPrefix.match(/^\/[^/]+\/[^/]+\/raw\/(.+)$/);
        const ref = refMatch?.[1] || "";
        if (!_isCommitOid(ref)) continue;

        blobCandidates.push(raw);
      }
    }

    // Fallbacks from embedded payload metadata.
    const headOid = _getHeadOid();
    const baseRepo = _getRepoInfo();
    const headRepo = _getHeadRepoInfo();

    if (_isCommitOid(headOid)) {
      if (headRepo.owner && headRepo.name) {
        candidates.push(`https://github.com/${headRepo.owner}/${headRepo.name}/raw/${headOid}/${encodedPath}`);
      }
      if (baseRepo.owner && baseRepo.name) {
        candidates.push(`https://github.com/${baseRepo.owner}/${baseRepo.name}/raw/${headOid}/${encodedPath}`);
      }
    }

    return [...new Set([...candidates, ...blobCandidates])];
  }

  /**
   * Fetch raw file content from GitHub using browser session auth.
   */
  async function _fetchFileContent(filePath, container) {
    const retryAfter = _fileRetryAfter.get(filePath) || 0;
    if (Date.now() < retryAfter) {
      return null;
    }

    const urls = _getRawUrlCandidates(filePath, container);
    if (urls.length === 0) {
      _fileRetryAfter.set(filePath, Date.now() + FILE_FETCH_RETRY_MS);
      return null;
    }

    for (const url of urls) {
      if (_fileCache.has(url)) return _fileCache.get(url);

      try {
        let resp;
        try {
          resp = await fetch(url, { credentials: "same-origin" });
        } catch {
          resp = await fetch(url, { credentials: "omit" });
        }

        if (!resp.ok) {
          continue;
        }

        const text = await resp.text();
        if (!text || _looksLikeHtml(text)) {
          continue;
        }

        _fileCache.set(url, text);
        _fileRetryAfter.delete(filePath);
        return text;
      } catch {
      }
    }

    _fileRetryAfter.set(filePath, Date.now() + FILE_FETCH_RETRY_MS);
    return null;
  }

  function _addLineMapEntry(lineMap, key, lineNum) {
    if (!key || key.length < 2) return;
    const existing = lineMap.get(key);
    if (existing) {
      existing.push(lineNum);
      return;
    }
    lineMap.set(key, [lineNum]);
  }

  /**
   * Build a complete line map from the full file content.
   * Every line's text maps to its 1-based line number.
   */
  function _buildFullLineMap(fileContent) {
    const lineMap = new Map();
    if (!fileContent) return lineMap;

    const lines = fileContent.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const raw = _normalizeTextForMatch(lines[i]);
      _addLineMapEntry(lineMap, raw, lineNum);

      // Also store rendered version (strip markdown syntax)
      const rendered = _normalizeTextForMatch(_stripMarkdownSyntax(lines[i]));
      if (rendered !== raw) _addLineMapEntry(lineMap, rendered, lineNum);
    }
    return lineMap;
  }

  function _parseSourcePosLine(element) {
    const node = element?.closest?.("[data-sourcepos]");
    const value = node?.getAttribute?.("data-sourcepos") || "";
    const match = value.match(/^(\d+):\d+-\d+:\d+$/);
    return match ? parseInt(match[1], 10) : null;
  }

  function _getControlLabel(el) {
    const text = (el?.textContent || "").trim().toLowerCase();
    const aria = (el?.getAttribute?.("aria-label") || "").trim().toLowerCase();
    return `${text} ${aria}`.trim();
  }

  function _getFileViewControlCandidates(fileContainer) {
    const roots = qsa('ul[aria-label="File view"], [role="tablist"][aria-label*="File view" i]', fileContainer);
    const controls = [];

    for (const root of roots) {
      controls.push(...qsa("button, [role='tab'], a", root));
    }

    if (controls.length > 0) {
      return controls.filter(el => !el.classList?.contains(BACK_TO_RICH_BTN_CLASS));
    }

    return qsa('button[aria-label], [role="tab"][aria-label], a[aria-label]', fileContainer)
      .filter(el => !el.classList?.contains(BACK_TO_RICH_BTN_CLASS));
  }

  function _getSourceDiffButton(fileContainer) {
    const byAria = qs('button[aria-label*="Source" i]', fileContainer);
    if (byAria) return byAria;

    const byGenericControl = _getFileViewControlCandidates(fileContainer)
      .find((el) => {
        const label = _getControlLabel(el);
        if (!label) return false;
        if (label.includes("rich") || label.includes("render")) return false;
        return label.includes("source") || label === "code" || label.includes("source diff") || label.includes("code diff");
      });
    if (byGenericControl) return byGenericControl;

    const segControl = qs('ul[aria-label="File view"]', fileContainer);
    if (segControl) {
      const items = qsa("li", segControl);
      if (items.length >= 1) {
        const firstBtn = qs("button", items[0]);
        if (firstBtn) return firstBtn;
      }
    }

    const allButtons = qsa("button", fileContainer);
    return allButtons.find(btn => btn.textContent.trim().toLowerCase().includes("source")) || null;
  }

  function _getRichDiffButton(fileContainer) {
    const byAria = qsa('button[aria-label*="Rich" i], [role="tab"][aria-label*="Rich" i], a[aria-label*="Rich" i]', fileContainer)
      .find(btn => !btn.classList.contains("md-review-back-to-rich-btn"));
    if (byAria) return byAria;

    const byGenericControl = _getFileViewControlCandidates(fileContainer)
      .find((el) => {
        const label = _getControlLabel(el);
        return label.includes("rich") || label.includes("rendered") || label.includes("render diff");
      });
    if (byGenericControl) return byGenericControl;

    const segControl = qs('ul[aria-label="File view"]', fileContainer);
    if (segControl) {
      const items = qsa("li", segControl);
      if (items.length >= 2) {
        const secondBtn = qs("button", items[1]);
        if (secondBtn) return secondBtn;
      }
    }

    const allButtons = qsa("button", fileContainer)
      .filter(btn => !btn.classList.contains("md-review-back-to-rich-btn"));

    const richDiffBtn = allButtons.find(btn =>
      btn.textContent.trim().toLowerCase().includes("rich diff")
    );
    if (richDiffBtn) return richDiffBtn;

    return allButtons.find(btn => btn.textContent.trim().toLowerCase() === "rich") || null;
  }

  function _isSourceDiffVisible(fileContainer) {
    return Boolean(
      qs("td[data-line-number]", fileContainer) ||
      qs("a[data-line-number]", fileContainer) ||
      qs(".blob-code", fileContainer) ||
      qs(".js-file-line-container", fileContainer)
    );
  }

  const SOURCE_SELECTED_LINE_CLASS = "md-review-selected-line";
  const SOURCE_COMMENTED_LINE_CLASS = "md-review-commented-line";
  const BACK_TO_RICH_BTN_CLASS = "md-review-back-to-rich-btn";
  const _pendingLazyLineWatchers = new Set();
  const _pendingRichScrollByDigest = new Map();
  const _pendingSourceLineByDigest = new Map();
  const _pendingRichViewLoads = new Map();
  const _suppressedRichClickLoads = new Set();
  const _installedToggleButtons = new WeakSet();
  const SCROLL_BEHAVIOR_STORAGE_KEY = "md-review-scroll-behavior";
  const DEFAULT_SCROLL_BEHAVIOR = "auto";
  let _scrollBehavior = DEFAULT_SCROLL_BEHAVIOR;

  function _normalizeScrollBehavior(value) {
    return value === "smooth" ? "smooth" : "auto";
  }

  function _getScrollBehavior() {
    return _scrollBehavior;
  }

  function _setScrollBehavior(value) {
    _scrollBehavior = _normalizeScrollBehavior(value);
  }

  function _loadScrollBehaviorPreference() {
    _readLocalStorage({ [SCROLL_BEHAVIOR_STORAGE_KEY]: DEFAULT_SCROLL_BEHAVIOR }, (items) => {
      _setScrollBehavior(items?.[SCROLL_BEHAVIOR_STORAGE_KEY]);
    });
  }

  _listenLocalStorageChanges((changes) => {
    const change = changes?.[SCROLL_BEHAVIOR_STORAGE_KEY];
    if (!change) return;
    _setScrollBehavior(change.newValue);
  });

  _loadScrollBehaviorPreference();

  function _getTopVisibleSourceLine(fileContainer) {
    const candidates = [
      ...qsa("tr", fileContainer),
      ...qsa("td[data-line-number][data-diff-side='RIGHT']", fileContainer),
      ...qsa("td[data-line-number][data-diff-side='right']", fileContainer),
      ...qsa("td[data-line-number]", fileContainer),
      ...qsa("a[data-line-number]", fileContainer),
    ];

    let best = null;
    let bestScore = Infinity;

    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.offsetParent === null) continue;

      const lineNode = el.matches?.("[data-line-number]") ? el : qs("[data-line-number]", el);
      if (!lineNode) continue;

      const rect = (el.tagName === "TR" ? el : lineNode).getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;

      const lineNum = parseInt(lineNode.getAttribute("data-line-number") || "", 10);
      if (!lineNum || Number.isNaN(lineNum)) continue;

      const score = Math.abs(rect.top);
      if (score < bestScore) {
        best = lineNum;
        bestScore = score;
      }
    }

    return best;
  }

  function _getTopVisibleRichLine(article) {
    const candidates = qsa("[data-md-review-line-number]", article).map((el) => {
      const lineNum = parseInt(el.getAttribute("data-md-review-line-number") || "", 10);
      if (!Number.isInteger(lineNum) || lineNum <= 0) return null;
      return { el, lineNum };
    }).filter(Boolean);

    let best = null;
    let bestScore = Infinity;

    for (const candidate of candidates) {
      if (!(candidate.el instanceof HTMLElement)) continue;
      if (candidate.el.offsetParent === null) continue;

      const rect = candidate.el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;

      const score = Math.abs(rect.top);
      if (score < bestScore) {
        best = candidate.lineNum;
        bestScore = score;
      }
    }

    return best;
  }

  function _queueRichViewScroll(pathDigest, lineNum) {
    if (!_isValidPathDigest(pathDigest) || !Number.isInteger(lineNum) || lineNum <= 0) return;
    _pendingRichScrollByDigest.set(pathDigest, lineNum);
  }

  function _queueSourceViewFocus(pathDigest, lineNum) {
    if (!_isValidPathDigest(pathDigest) || !Number.isInteger(lineNum) || lineNum <= 0) return;
    _pendingSourceLineByDigest.set(pathDigest, lineNum);
  }

  function _findNearestRichBlockForLine(article, targetLine) {
    const candidates = qsa("[data-md-review-line-number]", article).map((el) => {
      const lineNum = parseInt(el.getAttribute("data-md-review-line-number") || "", 10);
      return Number.isInteger(lineNum) && lineNum > 0 ? { el, lineNum } : null;
    }).filter(Boolean);

    if (candidates.length === 0) return null;

    let best = candidates[0];
    let bestDistance = Math.abs(best.lineNum - targetLine);

    for (let i = 1; i < candidates.length; i++) {
      const candidate = candidates[i];
      const distance = Math.abs(candidate.lineNum - targetLine);
      if (distance < bestDistance || (distance === bestDistance && candidate.lineNum < best.lineNum)) {
        best = candidate;
        bestDistance = distance;
      }
    }

    return best.el.closest("tr") || best.el;
  }

  function _applyPendingRichViewScroll(article, pathDigest, attempt = 0) {
    if (!_isValidPathDigest(pathDigest)) return false;

    const targetLine = _pendingRichScrollByDigest.get(pathDigest);
    if (!targetLine) return false;

    if (!article?.isConnected) return false;

    const target = _findNearestRichBlockForLine(article, targetLine);
    if (!target) return false;

    const applied = target.getBoundingClientRect().height > 0;
    if (applied) {
      target.scrollIntoView({ behavior: _getScrollBehavior(), block: "start" });
      _pendingRichScrollByDigest.delete(pathDigest);
      return true;
    }

    if (attempt < 6) {
      setTimeout(() => _applyPendingRichViewScroll(article, pathDigest, attempt + 1), 200);
    }

    return false;
  }

  function _clearSourceLineHighlight(fileContainer) {
    const highlighted = qsa(`.${SOURCE_SELECTED_LINE_CLASS}`, fileContainer);
    highlighted.forEach(el => el.classList.remove(SOURCE_SELECTED_LINE_CLASS));
  }

  function _switchBackToRich(fileContainer, pathDigest) {
    const topLine = _getTopVisibleSourceLine(fileContainer);
    if (Number.isInteger(topLine) && topLine > 0) {
      _queueRichViewScroll(pathDigest, topLine);
    }

    const richDiffBtn = _getRichDiffButton(fileContainer);
    if (richDiffBtn) {
      richDiffBtn.click();
    }
  }

  function _restorePendingSourceFocus(fileContainer, pathDigest, attempt = 0) {
    if (!_isValidPathDigest(pathDigest)) return false;

    const lineNum = _pendingSourceLineByDigest.get(pathDigest);
    if (!Number.isInteger(lineNum) || lineNum <= 0) return false;

    if (!_isSourceDiffVisible(fileContainer)) {
      if (attempt < 20) {
        setTimeout(() => _restorePendingSourceFocus(fileContainer, pathDigest, attempt + 1), 250);
      }
      return false;
    }

    _pendingSourceLineByDigest.delete(pathDigest);
    _focusSourceLine(fileContainer, pathDigest, lineNum);
    return true;
  }

  function _installNativeViewToggleHandlers(fileContainer, pathDigest) {
    const attachToButton = (button, kind) => {
      if (!(button instanceof HTMLElement)) return;
      if (_installedToggleButtons.has(button)) return;
      _installedToggleButtons.add(button);

      const onPress = () => {
        if (kind === "rich" && _suppressedRichClickLoads.has(pathDigest)) return;

        if (kind === "source") {
          if (!_isRichDiffVisible(fileContainer)) return;
          const article = qs("article", fileContainer);
          const pendingLine = _pendingSourceLineByDigest.get(pathDigest);
          const topRichLine = Number.isInteger(pendingLine) && pendingLine > 0
            ? pendingLine
            : _getTopVisibleRichLine(article);
          if (Number.isInteger(topRichLine) && topRichLine > 0) {
            _queueSourceViewFocus(pathDigest, topRichLine);
          }
        }

        if (kind === "rich") {
          if (!_isSourceDiffVisible(fileContainer)) return;
          const topLine = _getTopVisibleSourceLine(fileContainer);
          if (Number.isInteger(topLine) && topLine > 0) {
            _queueRichViewScroll(pathDigest, topLine);
          }
        }
      };

      button.addEventListener("pointerdown", onPress, true);
      button.addEventListener("mousedown", onPress, true);
      button.addEventListener("click", onPress, true);
    };

    attachToButton(_getSourceDiffButton(fileContainer), "source");
    attachToButton(_getRichDiffButton(fileContainer), "rich");
  }

  function _maybeAutoLoadRichView(fileContainer, pathDigest) {
    if (!_isExtensionEnabled()) return;
    if (_isRichDiffVisible(fileContainer)) return;

    const richBtn = _getRichDiffButton(fileContainer);
    if (!richBtn) return;

    const now = Date.now();
    const lastAttempt = _pendingRichViewLoads.get(pathDigest) || 0;
    if (now - lastAttempt < 1200) return;

    _pendingRichViewLoads.set(pathDigest, now);
    _suppressedRichClickLoads.add(pathDigest);
    try {
      richBtn.click();
    } finally {
      setTimeout(() => _suppressedRichClickLoads.delete(pathDigest), 0);
    }
  }

  function _getPreferredDiffHeaderRow(fileContainer) {
    const headerWrapper = qs("[class*='Diff-module__diffHeaderWrapper__']", fileContainer);
    if (!headerWrapper) return null;

    return (
      qs("[class*='DiffFileHeader-module__diff-file-header__'][class*='DiffFileHeader-module__container-flex-wrap__']", headerWrapper) ||
      qs("[class*='DiffFileHeader-module__diff-file-header__']", headerWrapper) ||
      qs("[class*='DiffFileHeader-module__container-flex-wrap__']", headerWrapper)
    );
  }

  function _ensureBackToRichButton(fileContainer) {
    if (_isRichDiffVisible(fileContainer)) {
      const existingSlot = qs(".md-review-back-to-rich-slot", fileContainer);
      if (existingSlot) existingSlot.style.display = "none";
      return;
    }

    const existingSlot = qs(".md-review-back-to-rich-slot", fileContainer);
    if (existingSlot) existingSlot.style.display = "";

    let button = qs(`.${BACK_TO_RICH_BTN_CLASS}`, fileContainer);

    if (!button) {
      button = createElement("button", {
        className: BACK_TO_RICH_BTN_CLASS,
        type: "button",
        textContent: "Back to rich view",
        title: "Switch this file back to rich diff",
        "aria-label": "Switch back to rich diff",
      });

      button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pathDigest = String((fileContainer.id || "").replace(/^diff-/, "")).toLowerCase();
        _switchBackToRich(fileContainer, pathDigest);
      });
    }

    const headerRow = _getPreferredDiffHeaderRow(fileContainer);

    if (headerRow) {
      let slot = qs(".md-review-back-to-rich-slot", headerRow);
      if (!slot) {
        slot = createElement("div", {
          className: "md-review-back-to-rich-slot d-flex flex-items-center",
        });
      }

      if (button.parentNode !== slot) {
        slot.appendChild(button);
      }

      const topLevelDivs = Array.from(headerRow.children)
        .filter((child) => child.tagName === "DIV" && child !== slot);
      const lastDiv = topLevelDivs[topLevelDivs.length - 1] || null;

      if (slot.parentNode !== headerRow) {
        if (lastDiv && lastDiv.parentNode === headerRow) {
          headerRow.insertBefore(slot, lastDiv.nextSibling);
        } else {
          headerRow.appendChild(slot);
        }
      } else {
        if (lastDiv && lastDiv.nextSibling !== slot) {
          headerRow.insertBefore(slot, lastDiv.nextSibling);
        }
      }
      return;
    }

    fileContainer.insertBefore(button, fileContainer.firstChild || null);
  }

  function _findLineTarget(fileContainer, pathDigest, lineNum) {
    const lineAnchorId = `diff-${pathDigest}R${lineNum}`;
    const byId = fileContainer.querySelector(`[id="${lineAnchorId}"]`);
    if (byId) return byId;

    const selectors = [
      `td[data-line-number="${lineNum}"][data-diff-side="RIGHT"]`,
      `td[data-line-number="${lineNum}"][data-diff-side="right"]`,
      `td[data-line-number="${lineNum}"]`,
      `a[data-line-number="${lineNum}"]`,
    ];

    for (const selector of selectors) {
      const hit = qs(selector, fileContainer);
      if (hit) return hit;
    }

    return null;
  }

  function _expandCollapsedSourceSections(fileContainer) {
    const matchTokens = ["load diff", "load more", "show more", "expand", "unfold"];

    const candidates = qsa("button", fileContainer).filter((btn) => {
      if (!btn || btn.disabled) return false;

      const text = (btn.textContent || "").trim().toLowerCase();
      const aria = (btn.getAttribute("aria-label") || "").trim().toLowerCase();
      const label = `${text} ${aria}`.trim();
      if (!label) return false;
      if (label.includes("collapse")) return false;

      return matchTokens.some(token => label.includes(token));
    });

    let clicked = 0;
    for (const btn of candidates.slice(0, 6)) {
      btn.click();
      clicked++;
    }

    return clicked > 0;
  }

  function _applySourceLineSelection(fileContainer, pathDigest, lineNum, shouldScroll) {
    const target = _findLineTarget(fileContainer, pathDigest, lineNum);
    if (!target) return false;

    _clearSourceLineHighlight(fileContainer);

    const row = target.closest("tr") || target;

    if (shouldScroll) {
      row.scrollIntoView({ behavior: _getScrollBehavior(), block: "center" });
    }

    row.classList.add(SOURCE_SELECTED_LINE_CLASS);
    if (target !== row) {
      target.classList.add(SOURCE_SELECTED_LINE_CLASS);
    }

    return true;
  }

  function _watchForLazySourceLine(fileContainer, pathDigest, lineNum) {
    if (!lineNum) return;

    const watcherKey = `${pathDigest}:R${lineNum}`;
    if (_pendingLazyLineWatchers.has(watcherKey)) return;
    _pendingLazyLineWatchers.add(watcherKey);

    const timeoutMs = 20000;
    const startedAt = Date.now();
    let finished = false;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      _pendingLazyLineWatchers.delete(watcherKey);
      observer.disconnect();
      clearInterval(ticker);
    };

    const tryResolve = () => {
      if (_applySourceLineSelection(fileContainer, pathDigest, lineNum, true)) {
        setTimeout(() => _applySourceLineSelection(fileContainer, pathDigest, lineNum, false), 600);
        cleanup();
        return true;
      }

      _expandCollapsedSourceSections(fileContainer);

      if (Date.now() - startedAt >= timeoutMs) {
        const fileAnchor = document.getElementById(`diff-${pathDigest}`);
        (fileAnchor || fileContainer).scrollIntoView({ behavior: _getScrollBehavior(), block: "start" });
        cleanup();
        return true;
      }

      return false;
    };

    const observer = new MutationObserver(() => {
      if (!finished) tryResolve();
    });

    observer.observe(fileContainer, { childList: true, subtree: true });

    const ticker = setInterval(() => {
      if (!finished) tryResolve();
    }, 500);

    tryResolve();
  }

  function _focusSourceLine(fileContainer, pathDigest, lineNum) {
    const maxAttempts = 36;
    let attempts = 0;
    let hashSet = false;

    function tryFocus() {
      attempts++;

      if (!lineNum) {
        fileContainer.scrollIntoView({ behavior: _getScrollBehavior(), block: "start" });
        return;
      }

      if (!_isSourceDiffVisible(fileContainer)) {
        const sourceDiffBtn = _getSourceDiffButton(fileContainer);
        if (sourceDiffBtn) {
          sourceDiffBtn.click();
        }

        if (attempts < maxAttempts) {
          setTimeout(tryFocus, 50);
          return;
        }
      }

      const hash = `#diff-${pathDigest}R${lineNum}`;
      if (!hashSet && window.location.hash !== hash) {
        history.replaceState(null, "", hash);
        hashSet = true;
      }

      if (_applySourceLineSelection(fileContainer, pathDigest, lineNum, true)) {
        setTimeout(() => _applySourceLineSelection(fileContainer, pathDigest, lineNum, false), 400);
        setTimeout(() => _applySourceLineSelection(fileContainer, pathDigest, lineNum, false), 1200);
        return;
      }

      if (attempts < maxAttempts) {
        const expanded = _expandCollapsedSourceSections(fileContainer);
        setTimeout(tryFocus, expanded ? 50 : 50);
        return;
      }

      _watchForLazySourceLine(fileContainer, pathDigest, lineNum);
    }

    setTimeout(tryFocus, 50);
  }

  function _isRichDiffVisible(fileContainer) {
    const article = qs("article", fileContainer);
    if (!article || article.children.length === 0) return false;

    // Check if article is actually visible (not hidden by display:none or similar)
    const style = window.getComputedStyle(article);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function _switchToSourceAndFocus(fileContainer, pathDigest, lineNum, markersMap) {

    let attempts = 0;
    const maxAttempts = 14;

    function tryOpenSourceAndFocus() {
      attempts++;

      if (!_isSourceDiffVisible(fileContainer)) {
        const sourceDiffBtn = _getSourceDiffButton(fileContainer);
        if (sourceDiffBtn) {
          sourceDiffBtn.click();
        }

        if (attempts < maxAttempts) {
          setTimeout(tryOpenSourceAndFocus, 50);
          return;
        }
      }

      _focusSourceLine(fileContainer, pathDigest, lineNum);

      // Now that we're in source mode, show the back-to-rich button
      setTimeout(() => _ensureBackToRichButton(fileContainer), 300);

      if (lineNum) {
        setTimeout(() => _applySourceLineSelection(fileContainer, pathDigest, lineNum, false), 1600);
        setTimeout(() => _applySourceLineSelection(fileContainer, pathDigest, lineNum, false), 3000);
      }

      if (markersMap) {
        setTimeout(() => _decorateSourceCommentLines(fileContainer, markersMap, pathDigest), 300);
        setTimeout(() => _decorateSourceCommentLines(fileContainer, markersMap, pathDigest), 1000);
      }
    }

    tryOpenSourceAndFocus();
  }

  /* ---------------------------------------------------------------- */
  /*  Comment badges + click-to-source                                 */
  /* ---------------------------------------------------------------- */

  const BADGE_CLASS = "md-review-comment-badge";
  const ENHANCED_ATTR = "data-md-review-enhanced";
  const _activeEnhanceObservers = [];
  const _richClickHandlers = new WeakMap();

  /**
   * Wait for the rich diff article to appear, then enhance it.
    * Fetches full file content for accurate line mapping.
   */
  function _enhanceRichDiff(container, markersMap, pathDigest, filePath) {
    async function enhance() {
      if (!_isExtensionEnabled()) return;
      const article = qs("article", container);
      if (!article || article.children.length === 0) return;
      if (article.hasAttribute(ENHANCED_ATTR)) return;
      article.setAttribute(ENHANCED_ATTR, "true");

      // Fetch full file content for complete line mapping
      const fileContent = await _fetchFileContent(filePath, container);
      const lineMap = _buildFullLineMap(fileContent);
      _lineMapByDigest.set(pathDigest, lineMap);

      _makeClickable(article, pathDigest, lineMap, markersMap);
      _addCommentBadges(article, markersMap, pathDigest);
      _decorateCommentedBlocks(article, markersMap, lineMap, pathDigest);
      _decorateSourceCommentLines(container, markersMap, pathDigest);
      _applyPendingRichViewScroll(article, pathDigest);
    }

    // Retry until article appears
    let attempts = 0;
    function tryEnhance() {
      if (!_isExtensionEnabled()) return;
      const article = qs("article", container);
      if (article && article.children.length > 0 && !article.hasAttribute(ENHANCED_ATTR)) {
        enhance();
        return;
      }
      attempts++;
      if (attempts < 40) setTimeout(tryEnhance, 100);
    }
    setTimeout(tryEnhance, 100);

    // Watch for article re-renders (user toggles view modes)
    const observer = new MutationObserver(() => {
      if (!_isExtensionEnabled()) return;
      const article = qs("article", container);
      if (article && article.children.length > 0 && !article.hasAttribute(ENHANCED_ATTR)) {
        enhance();
      }
    });
    observer.observe(container, { childList: true, subtree: true });
    _activeEnhanceObservers.push(observer);
  }

  function _pickMatchedLine(lines, probeTextLength, preferUnique) {
    if (!Array.isArray(lines) || lines.length === 0) return null;
    if (lines.length === 1) return lines[0];
    if (preferUnique) return null;
    if (probeTextLength < 24) return null;
    return lines[0];
  }

  /**
   * Find the best line number match for a given text.
   */
  function _findBestLineMatch(text, lineMap, options = {}) {
    const {
      allowSubstring = true,
      preferUnique = true,
      minSubstringLength = 24,
      minWordCount = 4,
    } = options;

    const normalized = _normalizeTextForMatch(text);
    if (!normalized || normalized.length < 2) return null;

    // Exact match
    const exact = _pickMatchedLine(lineMap.get(normalized), normalized.length, preferUnique);
    if (exact) return exact;

    // First line only
    const firstLine = _normalizeTextForMatch(normalized.split("\n")[0]);
    if (firstLine.length > 1) {
      const firstLineMatch = _pickMatchedLine(lineMap.get(firstLine), firstLine.length, preferUnique);
      if (firstLineMatch) return firstLineMatch;
    }

    const firstLineStripped = _normalizeTextForMatch(_stripMarkdownSyntax(firstLine));
    if (firstLineStripped.length > 1) {
      const strippedMatch = _pickMatchedLine(lineMap.get(firstLineStripped), firstLineStripped.length, preferUnique);
      if (strippedMatch) return strippedMatch;
    }

    if (!allowSubstring) {
      return null;
    }

    // Substring match — find best (longest) match
    const words = firstLine.split(" ").filter(Boolean);
    if (firstLine.length < minSubstringLength || words.length < minWordCount) {
      return null;
    }

    let bestMatch = null;
    let bestScore = 0;

    for (const [mapText, mapLines] of lineMap) {
      if (mapLines.length !== 1) continue;

      let score = 0;

      if (mapText.includes(firstLine)) {
        const coverage = firstLine.length / mapText.length;
        if (coverage < 0.72) continue;
        score = firstLine.length + coverage * 100;
      } else if (firstLine.includes(mapText)) {
        const coverage = mapText.length / firstLine.length;
        if (coverage < 0.82) continue;
        score = mapText.length + coverage * 100;
      }

      if (score > bestScore) {
        bestMatch = mapLines[0];
        bestScore = score;
      }
    }

    return bestMatch;
  }

  /**
   * Make elements in the rich diff clickable — clicking navigates
   * to the corresponding line in the source diff.
   */
  function _makeClickable(article, pathDigest, lineMap, markersMap) {
    // Add a subtle indicator and click handler to block-level elements
    article.classList.add("md-review-clickable");

    const existingHandler = _richClickHandlers.get(article);
    if (existingHandler) {
      article.removeEventListener("click", existingHandler);
    }

    const handleRichClick = (e) => {
      // Don't do anything if extension is paused
      if (!_isExtensionEnabled()) return;

      // Don't intercept clicks on actual links or comment badges
      if (e.target.closest("a[href]:not(.md-review-code-link)")) return;
      if (e.target.closest(`.${BADGE_CLASS}`)) return;
      if (e.target.closest(".md-review-comment-bar")) return;
      if (e.target.closest('summary[role="button"][aria-haspopup="dialog"]')) return;
      if (e.target.closest('button[aria-haspopup="dialog"], [role="button"][aria-haspopup="dialog"]')) return;

      e.preventDefault();
      e.stopPropagation();

      const blockTarget = e.target.closest("li, p, h1, h2, h3, h4, h5, h6, tr, blockquote, pre") || e.target;
      const clickedText = (blockTarget.textContent || "").trim();

      // Prefer source position data when available.
      let lineNum = _parseSourcePosLine(blockTarget);

      // Otherwise find best textual match.
      if (!lineNum) {
        lineNum = _findBestLineMatch(clickedText, lineMap, {
          allowSubstring: true,
          preferUnique: true,
          minSubstringLength: 28,
          minWordCount: 5,
        });
      }

      // If no match on the clicked element, try parent elements
      if (!lineNum) {
        let parent = blockTarget.parentElement;
        while (parent && parent !== article) {
          const parentText = (parent.textContent || "").trim().split("\n")[0].trim();
          lineNum = _parseSourcePosLine(parent) || _findBestLineMatch(parentText, lineMap, {
            allowSubstring: true,
            preferUnique: true,
            minSubstringLength: 28,
            minWordCount: 5,
          });
          if (lineNum) break;
          parent = parent.parentElement;
        }
      }

      // If still no match, find the nearest line in the map by looking
      // at ALL map entries and finding the closest textual neighbor
      // Switch to source diff by clicking the segmented control button
      const fileContainer = article.closest("div[id^='diff-']");
      if (fileContainer) {
        _queueSourceViewFocus(pathDigest, lineNum);
        _switchToSourceAndFocus(fileContainer, pathDigest, lineNum, markersMap);
      }
    };

    article.addEventListener("click", handleRichClick);
    _richClickHandlers.set(article, handleRichClick);
  }

  function _isThreadResolved(thread) {
    if (!thread || typeof thread !== "object") return false;

    if (typeof thread.isResolved === "boolean") return thread.isResolved;
    if (typeof thread.resolved === "boolean") return thread.resolved;

    const state = String(
      thread.state || thread.resolutionState || thread.viewerThreadStatus || ""
    ).toLowerCase();

    return state === "resolved";
  }

  function _getCommentLineStats(markersMap, pathDigest = "") {
    const lineStats = new Map();
    const suppressedMap = _getActiveTimedLineMap(_suppressedCommentLinesByDigest, pathDigest);
    const suppressedLines = suppressedMap ? new Set(suppressedMap.keys()) : null;

    if (markersMap && typeof markersMap === "object") {
      for (const [lineKey, markerData] of Object.entries(markersMap)) {
        const lineMatch = lineKey.match(/^[A-Z]?(\d+)$/i);
        if (!lineMatch) continue;

        const lineNum = parseInt(lineMatch[1], 10);
        if (!lineNum || Number.isNaN(lineNum)) continue;
        if (suppressedLines?.has(lineNum)) continue;

        const threads = Array.isArray(markerData?.threads) ? markerData.threads : [];
        if (threads.length === 0) continue;

        let resolved = 0;
        for (const thread of threads) {
          if (_isThreadResolved(thread)) resolved++;
        }

        lineStats.set(lineNum, { total: threads.length, resolved });
      }
    }

    const localLines = _getActiveTimedLineMap(_localCommentActivityByDigest, pathDigest);
    if (localLines) {
      for (const lineNum of localLines.keys()) {
        if (suppressedLines?.has(lineNum)) continue;
        if (!lineStats.has(lineNum)) {
          lineStats.set(lineNum, { total: 1, resolved: 0 });
        }
      }
    }

    return lineStats;
  }

  function _resolveRichBlockLine(block, lineMap) {
    const sourcePos = _parseSourcePosLine(block);
    if (sourcePos) return sourcePos;

    if (!lineMap || lineMap.size === 0) return null;

    const blockText = (block.textContent || "").trim();
    if (!blockText) return null;

    return _findBestLineMatch(blockText, lineMap, {
      allowSubstring: false,
      preferUnique: true,
    });
  }

  function _getNodeDepth(node) {
    let depth = 0;
    let current = node;
    while (current && current.parentElement) {
      depth++;
      current = current.parentElement;
    }
    return depth;
  }

  function _isBetterRichAnnotationCandidate(candidate, existing) {
    if (!existing) return true;

    if (candidate.hasSourcePos !== existing.hasSourcePos) {
      return candidate.hasSourcePos;
    }

    if (candidate.depth !== existing.depth) {
      return candidate.depth < existing.depth;
    }

    const candidateTextLen = (candidate.block.textContent || "").trim().length;
    const existingTextLen = (existing.block.textContent || "").trim().length;
    return candidateTextLen > existingTextLen;
  }

  function _setRichGutterOffsets(article, block) {
    try {
      const articleRect = article.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      const desiredLineViewportX = articleRect.left - 52;
      const minVisibleViewportX = 8;
      const lineViewportX = Math.max(minVisibleViewportX, desiredLineViewportX);
      const lineLeft = Math.round(lineViewportX - blockRect.left);
      const commentLeft = lineLeft + 40;

      block.style.setProperty("--md-review-line-left", `${lineLeft}px`);
      block.style.setProperty("--md-review-comment-left", `${commentLeft}px`);
    } catch {
      block.style.removeProperty("--md-review-line-left");
      block.style.removeProperty("--md-review-comment-left");
    }
  }

  function _decorateCommentedBlocks(article, markersMap, lineMap, pathDigest) {
    const lineStats = _getCommentLineStats(markersMap, pathDigest);

    qsa(".md-review-line-annotated, .md-review-line-has-comments", article).forEach((el) => {
      el.classList.remove("md-review-line-annotated");
      el.classList.remove("md-review-line-has-comments");
      el.removeAttribute("data-md-review-line-number");
      el.removeAttribute("data-md-review-line-label");
      el.removeAttribute("data-md-review-comment-count");
      el.removeAttribute("data-md-review-resolved-count");
      el.removeAttribute("title");
      el.style.removeProperty("--md-review-line-left");
      el.style.removeProperty("--md-review-comment-left");
    });
    qsa(".md-review-margin-badge", article).forEach(el => el.remove());

    const sourcePosBlocks = qsa("[data-sourcepos]", article);
    const fallbackBlocks = qsa("li, p, h1, h2, h3, h4, h5, h6, tr, blockquote, pre", article);
    const blocks = sourcePosBlocks.length > 0 ? sourcePosBlocks : fallbackBlocks;
    const unsupportedTags = new Set(["ARTICLE", "TABLE", "THEAD", "TBODY", "TR", "UL", "OL"]);
    const chosenByLine = new Map();

    for (const block of blocks) {
      if (unsupportedTags.has(block.tagName)) continue;

      const lineNum = _resolveRichBlockLine(block, lineMap);
      if (!lineNum) continue;

       const candidate = {
        block,
        lineNum,
        hasSourcePos: block.hasAttribute("data-sourcepos"),
        depth: _getNodeDepth(block),
      };

      const existing = chosenByLine.get(lineNum);
      if (_isBetterRichAnnotationCandidate(candidate, existing)) {
        chosenByLine.set(lineNum, candidate);
      }
    }

    for (const lineNum of lineStats.keys()) {
      if (!chosenByLine.has(lineNum) && fallbackBlocks.length > 0) {
        for (const block of fallbackBlocks) {
          if (unsupportedTags.has(block.tagName)) continue;
          if (chosenByLine.has(lineNum)) break;
          const blockText = (block.textContent || "").trim();
          if (!blockText) continue;
          const matchedLine = _findBestLineMatch(blockText, lineMap, { allowSubstring: false, preferUnique: true });
          if (matchedLine === lineNum) {
            chosenByLine.set(lineNum, { block, lineNum, hasSourcePos: false, depth: _getNodeDepth(block) });
          }
        }
      }
    }

    for (const [lineNum, candidate] of chosenByLine.entries()) {
      const block = candidate.block;
      _setRichGutterOffsets(article, block);

      block.classList.add("md-review-line-annotated");
      block.setAttribute("data-md-review-line-number", String(lineNum));
      block.setAttribute("data-md-review-line-label", String(lineNum));

      const baseTitle = `Line ${lineNum}`;
      block.setAttribute("title", baseTitle);

      const stats = lineStats.get(lineNum);
      if (!stats) continue;

      const resolvedSuffix = stats.resolved > 0 ? ` · ✓${stats.resolved}` : "";
      const title = stats.resolved > 0
        ? `${stats.total} comments (${stats.resolved} resolved) on line ${lineNum}`
        : `${stats.total} comments on line ${lineNum}`;

      block.classList.add("md-review-line-has-comments");
      block.setAttribute("data-md-review-comment-count", String(stats.total));
      block.setAttribute("data-md-review-resolved-count", String(stats.resolved));
      block.setAttribute("title", title);

      // Create a real DOM badge for the comment indicator
      const badge = createElement("span", {
        className: "md-review-margin-badge",
        title: title,
      });
      badge.appendChild(_createCommentBadgeIcon(16));
      badge.appendChild(createElement("sup", {
        className: "md-review-margin-badge__count",
        textContent: String(stats.total),
      }));
      block.prepend(badge);
    }
  }

  function _decorateSourceCommentLines(fileContainer, markersMap, pathDigest) {
    const lineStats = _getCommentLineStats(markersMap, pathDigest);

    qsa(`.${SOURCE_COMMENTED_LINE_CLASS}`, fileContainer).forEach((el) => {
      el.classList.remove(SOURCE_COMMENTED_LINE_CLASS);
    });

    if (lineStats.size === 0) return;

    for (const [lineNum] of lineStats) {
      const target = _findLineTarget(fileContainer, pathDigest, lineNum);
      if (!target) continue;

      const row = target.closest("tr") || target;
      row.classList.add(SOURCE_COMMENTED_LINE_CLASS);
    }
  }

  /**
   * Add comment indicator badges to the top of the rich diff.
   */
  function _addCommentBadges(article, markersMap, pathDigest) {
    const existingBar = qs(".md-review-comment-bar", article);
    if (existingBar) existingBar.remove();

    const lineStats = _getCommentLineStats(markersMap, pathDigest);
    if (lineStats.size === 0) return;

    const totalComments = [...lineStats.values()].reduce((sum, stats) => sum + stats.total, 0);
    const totalResolved = [...lineStats.values()].reduce((sum, stats) => sum + stats.resolved, 0);

    const badges = [];

    for (const [lineNum, stats] of [...lineStats.entries()].sort((a, b) => a[0] - b[0])) {
      const commentCount = stats.total;
      const resolvedLabel = stats.resolved > 0 ? ` (${stats.resolved} resolved)` : "";

      const badge = createElement("a", {
        className: BADGE_CLASS,
        title: `${commentCount} comment${commentCount > 1 ? "s" : ""}${resolvedLabel} on line ${lineNum} - click to view in diff`,
        href: `#diff-${pathDigest}R${lineNum}`,
      });
      badge.appendChild(_createCommentBadgeIcon(14));
      badge.appendChild(createElement("span", {
        textContent: `Line ${lineNum}`,
      }));

      badge.addEventListener("click", (e) => {
        e.preventDefault();
        const fileContainer = article.closest("div[id^='diff-']");
        if (!fileContainer) return;
        _switchToSourceAndFocus(fileContainer, pathDigest, lineNum, markersMap);
      });

      badges.push(badge);
    }

    if (badges.length > 0) {
      const bar = createElement("div", { className: "md-review-comment-bar" });
      const label = createElement("span", {
        className: "md-review-comment-bar__label",
        textContent: `Comments ${badges.length} line${badges.length > 1 ? "s" : ""} - ${totalComments} comments${totalResolved > 0 ? ` (${totalResolved} resolved)` : ""}`,
      });
      bar.appendChild(label);
      badges.forEach(b => bar.appendChild(b));

      if (article.firstChild) {
        article.insertBefore(bar, article.firstChild);
      } else {
        article.appendChild(bar);
      }
    }
  }

  function _refreshCommentIndicators(container, markersMap, pathDigest) {
    const article = qs("article", container);
    if (!article || !article.hasAttribute(ENHANCED_ATTR)) return;

    const lineMap = _lineMapByDigest.get(pathDigest) || new Map();

    _addCommentBadges(article, markersMap, pathDigest);
    _decorateCommentedBlocks(article, markersMap, lineMap, pathDigest);
    _decorateSourceCommentLines(container, markersMap, pathDigest);
  }

  /* ---------------------------------------------------------------- */
  /*  Main logic                                                       */
  /* ---------------------------------------------------------------- */

  const INIT_ATTR = "data-md-review-initialized";
  const AUTO_RICH_ATTR = "data-md-review-auto-rich-attempted";
  const TOGGLE_STORAGE_KEY = "md-review-extension-enabled";
  const DEFAULT_EXTENSION_ENABLED = true;
  let _extensionEnabled = DEFAULT_EXTENSION_ENABLED;
  let _extensionStateLoaded = false;

  _installThemeObserver();
  _installCommentActivityTracking();
  _loadExtensionEnabledPreference();

  function _isExtensionEnabled() {
    return _extensionEnabled;
  }

  function _loadExtensionEnabledPreference() {
    _readLocalStorage(
      { [TOGGLE_STORAGE_KEY]: DEFAULT_EXTENSION_ENABLED },
      (items) => {
        _extensionEnabled = items?.[TOGGLE_STORAGE_KEY] !== false;
        _extensionStateLoaded = true;
        _applyExtensionEnabledState();
      },
      () => {
        _extensionStateLoaded = true;
        _applyExtensionEnabledState();
      }
    );
  }

  _listenLocalStorageChanges((changes) => {
    const change = changes?.[TOGGLE_STORAGE_KEY];
    if (!change) return;
    _extensionEnabled = change.newValue !== false;
    _applyExtensionEnabledState();
  });

  let _pauseInProgress = false;

  function _removeAllEnhancements() {
    _pauseInProgress = true;

    // 0. Disconnect all per-container MutationObservers to stop re-enhancement
    while (_activeEnhanceObservers.length > 0) {
      const obs = _activeEnhanceObservers.pop();
      obs.disconnect();
    }

    // 1. Remove all injected DOM elements first
    qsa(".md-review-margin-badge").forEach(el => el.remove());
    qsa(".md-review-comment-bar").forEach(el => el.remove());
    qsa(`.${BACK_TO_RICH_BTN_CLASS}`).forEach(el => el.remove());
    qsa(".md-review-back-to-rich-slot").forEach(el => el.remove());

    // 2. Strip all annotation classes and attributes from decorated elements
    qsa(".md-review-line-annotated, .md-review-line-has-comments").forEach(el => {
      el.classList.remove("md-review-line-annotated", "md-review-line-has-comments");
      el.removeAttribute("data-md-review-line-number");
      el.removeAttribute("data-md-review-line-label");
      el.removeAttribute("data-md-review-comment-count");
      el.removeAttribute("data-md-review-resolved-count");
      el.removeAttribute("title");
      el.style.removeProperty("--md-review-line-left");
      el.style.removeProperty("--md-review-comment-left");
    });

    // 3. Strip source diff decorations
    qsa(`.${SOURCE_SELECTED_LINE_CLASS}`).forEach(el => el.classList.remove(SOURCE_SELECTED_LINE_CLASS));
    qsa(`.${SOURCE_COMMENTED_LINE_CLASS}`).forEach(el => el.classList.remove(SOURCE_COMMENTED_LINE_CLASS));

    // 4. Strip clickable class (the click listener stays but gates on _isExtensionEnabled)
    qsa(".md-review-clickable").forEach(el => el.classList.remove("md-review-clickable"));

    // 5. Clear enhancement and init markers so re-enabling works
    qsa(`[${ENHANCED_ATTR}]`).forEach(el => el.removeAttribute(ENHANCED_ATTR));
    qsa(`[${INIT_ATTR}]`).forEach(el => el.removeAttribute(INIT_ATTR));
    qsa(`[${AUTO_RICH_ATTR}]`).forEach(el => el.removeAttribute(AUTO_RICH_ATTR));
    _pendingRichViewLoads.clear();
    _pendingSourceLineByDigest.clear();

    setTimeout(() => { _pauseInProgress = false; }, 200);
  }

  function _updateActionIcon(isRelevantPage) {
    const active = Boolean(isRelevantPage && _isExtensionEnabled());
    _sendRuntimeMessage({ type: "md-review-set-icon", active });
  }

  function _applyExtensionEnabledState() {
    if (!_extensionStateLoaded) return;

    if (!_isExtensionEnabled()) {
      _removeAllEnhancements();
      _updateActionIcon(false);
      return;
    }

    setTimeout(processFiles, 50);
  }

  function processFiles() {
    if (!_extensionStateLoaded) return;

    if (!isPRFilesPage()) {
      _updateActionIcon(false);
      return;
    }

    let hasMarkdownFiles = false;

    if (!_isExtensionEnabled()) {
      _updateActionIcon(false);
      return;
    }

    const summaries = _getDiffSummaries();
    const summaryByDigest = new Map();

    for (const summary of summaries) {
      const digest = String(summary?.pathDigest || "");
      if (!digest) continue;
      summaryByDigest.set(digest, summary);
    }

    const diffContainers = qsa("div[id^='diff-']");

    for (const container of diffContainers) {
      const pathDigest = String((container.id || "").replace(/^diff-/, ""));
      if (!/^[0-9a-f]{10,}$/i.test(pathDigest)) continue;

      const summary = summaryByDigest.get(pathDigest) || {};
      const filePath = _normalizeRepoPath(summary.path || _getContainerFilePath(container));
      if (!_isMarkdownPath(filePath)) continue;

      hasMarkdownFiles = true;
      _syncLiveEditorActivity(container, pathDigest);
      _installNativeViewToggleHandlers(container, pathDigest);

      const autoRichAttempted = container.getAttribute(AUTO_RICH_ATTR) === "true";
      if (!autoRichAttempted) {
        if (!_isRichDiffVisible(container)) {
          _maybeAutoLoadRichView(container, pathDigest);
          container.setAttribute(AUTO_RICH_ATTR, "true");
          continue;
        }

        container.setAttribute(AUTO_RICH_ATTR, "true");
      }

      if (!_isRichDiffVisible(container)) {
        const pendingSourceLine = _pendingSourceLineByDigest.get(pathDigest);
        if (Number.isInteger(pendingSourceLine) && pendingSourceLine > 0) {
          _restorePendingSourceFocus(container, pathDigest);
        }
        continue;
      }

      _pendingRichViewLoads.delete(pathDigest);

      const markersMap = summary.markersMap || {};

      if (container.getAttribute(INIT_ATTR) === "true") {
        _refreshCommentIndicators(container, markersMap, pathDigest);
        continue;
      }

      container.setAttribute(INIT_ATTR, "true");

      _enhanceRichDiff(container, markersMap, pathDigest, filePath);
    }

    _updateActionIcon(hasMarkdownFiles);
  }

  /* ---------------------------------------------------------------- */
  /*  Bootstrap                                                        */
  /* ---------------------------------------------------------------- */

  // Run after a delay to let GitHub's React app render
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(processFiles, 150));
  } else {
    setTimeout(processFiles, 150);
  }

  // Re-run on navigation
  document.addEventListener("turbo:load", () => {
    _localCommentActivityByDigest.clear();
    _suppressedCommentLinesByDigest.clear();
    _pendingRichViewLoads.clear();
    _pendingSourceLineByDigest.clear();
    setTimeout(processFiles, 150);
  });
  document.addEventListener("pjax:end", () => {
    _localCommentActivityByDigest.clear();
    _suppressedCommentLinesByDigest.clear();
    _pendingRichViewLoads.clear();
    _pendingSourceLineByDigest.clear();
    setTimeout(processFiles, 150);
  });

  // Re-run when new diff containers load
  const _debouncedProcess = debounce(() => {
    if (_isExtensionEnabled() && !_pauseInProgress) processFiles();
  }, 1000);
  new MutationObserver(_debouncedProcess).observe(document.body, {
    childList: true, subtree: true
  });
})();
