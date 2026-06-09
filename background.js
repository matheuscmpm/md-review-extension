const INACTIVE_ICON = {
  16: "icons/icon16.png",
  32: "icons/icon32.png",
  64: "icons/icon64.png",
};

const ACTIVE_ICON = {
  16: "icons/icon16-active.png",
  32: "icons/icon32-active.png",
  64: "icons/icon64-active.png",
};

const extensionApi = globalThis.browser ?? globalThis.chrome;
const usesPromiseApi = typeof globalThis.browser !== "undefined";

function ignorePromiseRejection(result) {
  if (usesPromiseApi && typeof result?.catch === "function") {
    result.catch(() => {});
  }
}

function setTabIcon(tabId, active) {
  if (!extensionApi?.action?.setIcon || typeof tabId !== "number" || tabId < 0) return;

  ignorePromiseRejection(extensionApi.action.setIcon({
    tabId,
    path: active ? ACTIVE_ICON : INACTIVE_ICON,
  }));
}

function queryTabs(queryInfo) {
  if (!extensionApi?.tabs?.query) return Promise.resolve([]);

  if (usesPromiseApi) {
    return extensionApi.tabs.query(queryInfo).catch(() => []);
  }

  return new Promise((resolve) => {
    extensionApi.tabs.query(queryInfo, (tabs) => {
      resolve(Array.isArray(tabs) ? tabs : []);
    });
  });
}

async function setAllTabsInactive() {
  const tabs = await queryTabs({});
  for (const tab of tabs) {
    if (typeof tab.id === "number") {
      setTabIcon(tab.id, false);
    }
  }
}

extensionApi?.runtime?.onMessage?.addListener((message, sender) => {
  if (!message || message.type !== "md-review-set-icon") return;
  if (!sender.tab || typeof sender.tab.id !== "number") return;
  setTabIcon(sender.tab.id, Boolean(message.active));
});

extensionApi?.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) {
    setTabIcon(tabId, false);
  }
});

extensionApi?.runtime?.onInstalled?.addListener(() => {
  setAllTabsInactive().catch(() => {});
});

extensionApi?.runtime?.onStartup?.addListener(() => {
  setAllTabsInactive().catch(() => {});
});
