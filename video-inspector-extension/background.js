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

function send(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
}

chrome.action.onClicked.addListener((tab) => send(tab && tab.id, { type: 'vi-toggle' }));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  send(tab && tab.id, { type: 'vi-open-last' });
});
