// 点击扩展图标：聚焦已打开的笔记页，没有则新开一个标签页
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('index.html');
  try {
    const { tabId } = await chrome.storage.session.get('tabId');
    if (tabId) {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        await chrome.tabs.update(tabId, { active: true });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
    }
  } catch (err) {
    // 标签页已关闭，继续新开
  }
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.session.set({ tabId: tab.id });
});
