const SCROLL_BEHAVIOR_STORAGE_KEY = "md-review-scroll-behavior";
const THEME_MODE_STORAGE_KEY = "md-review-theme-mode";
const EXTENSION_ENABLED_STORAGE_KEY = "md-review-extension-enabled";
const extensionApi = globalThis.browser ?? globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined";

function loadOptions(defaults, onLoad) {
  if (!extensionApi?.storage?.local?.get) {
    onLoad(defaults);
    return;
  }

  if (usesPromiseApi) {
    extensionApi.storage.local.get(defaults).then(onLoad).catch(() => onLoad(defaults));
    return;
  }

  extensionApi.storage.local.get(defaults, (items) => {
    if (extensionApi.runtime?.lastError) {
      onLoad(defaults);
      return;
    }

    onLoad(items);
  });
}

function setOption(key, value) {
  if (!extensionApi?.storage?.local?.set) return;

  if (usesPromiseApi) {
    extensionApi.storage.local.set({ [key]: value }).catch(() => {});
    return;
  }

  extensionApi.storage.local.set({ [key]: value });
}

function loadState() {
  loadOptions(
    {
      [SCROLL_BEHAVIOR_STORAGE_KEY]: "auto",
      [THEME_MODE_STORAGE_KEY]: "auto",
      [EXTENSION_ENABLED_STORAGE_KEY]: true,
    },
    (items = {}) => {
      const enabledCheckbox = document.getElementById("extension-enabled");
      if (enabledCheckbox) {
        enabledCheckbox.checked = items[EXTENSION_ENABLED_STORAGE_KEY] !== false;
      }

      const scrollCheckbox = document.getElementById("smooth-scroll");
      if (scrollCheckbox) {
        scrollCheckbox.checked = items[SCROLL_BEHAVIOR_STORAGE_KEY] === "smooth";
      }

      const themeSelect = document.getElementById("theme-mode");
      if (themeSelect) {
        themeSelect.value = items[THEME_MODE_STORAGE_KEY] === "light" || items[THEME_MODE_STORAGE_KEY] === "dark"
          ? items[THEME_MODE_STORAGE_KEY]
          : "auto";
      }
    },
  );
}

document.addEventListener("DOMContentLoaded", () => {
  const enabledCheckbox = document.getElementById("extension-enabled");
  if (enabledCheckbox) {
    enabledCheckbox.addEventListener("change", () => {
      setOption(EXTENSION_ENABLED_STORAGE_KEY, enabledCheckbox.checked);
    });
  }

  const scrollCheckbox = document.getElementById("smooth-scroll");
  if (scrollCheckbox) {
    scrollCheckbox.addEventListener("change", () => {
      setOption(SCROLL_BEHAVIOR_STORAGE_KEY, scrollCheckbox.checked ? "smooth" : "auto");
    });
  }

  const themeSelect = document.getElementById("theme-mode");
  if (themeSelect) {
    themeSelect.addEventListener("change", () => {
      setOption(THEME_MODE_STORAGE_KEY, themeSelect.value);
    });
  }

  loadState();
});
