'use strict';

const MENU_ID = 'video-inspector-open-last';

function createMenu() {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '下载页面视频',
    contexts: ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio']
  }, () => void chrome.runtime.lastError);
}

chrome.runtime.onInstalled.addListener(createMenu);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(createMenu);

function send(tabId, message, frameId) {
  if (tabId == null) return;
  const options = typeof frameId === 'number' ? { frameId } : undefined;
  chrome.tabs.sendMessage(tabId, message, options || {}, () => void chrome.runtime.lastError);
}

chrome.action.onClicked.addListener((tab) => send(tab && tab.id, { type: 'vi-toggle' }));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  // 只发给右键所在的那个 frame：视频常嵌在跨域 iframe 里，顶层文档扫不到
  send(tab && tab.id, { type: 'vi-open-last' }, info.frameId);
});
