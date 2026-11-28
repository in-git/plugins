// 右键菜单二维码 —— 后台 Service Worker
// 三个菜单项：页面地址 / 链接地址 / 选中文字
// 点击后向当前 tab 的内容脚本发送 SHOW_QR 消息

const MENU_PAGE = 'qr-page';
const MENU_LINK = 'qr-link';
const MENU_SEL = 'qr-selection';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_PAGE,
    title: '生成二维码：当前页面',
    contexts: ['page', 'image', 'video', 'audio'],
  });
  chrome.contextMenus.create({
    id: MENU_LINK,
    title: '生成二维码：链接地址',
    contexts: ['link'],
  });
  chrome.contextMenus.create({
    id: MENU_SEL,
    title: '生成二维码："%s"',
    contexts: ['selection'],
  });
});

// 点击扩展图标（工具栏按钮）→ 弹窗输入框 + QR
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  const url = tab.url || '';
  // 用 executeScript 兜底（MV3 service worker 没有 setTimeout，用 Promise 包一下）
  const sendOrInject = async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_QR', text: url });
      return;
    } catch (e) {
      // 受限页面（chrome:// / edge:// / chrome-extension:// 等）content_scripts 被禁止注入
      // 直接忽略即可，不报错
      if (/^(chrome|edge|chrome-extension|edge-extension|about):/i.test(url)) return;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['tailwind-css.js', 'ui.js', 'content.js'] });
        await new Promise((r) => setTimeout(r, 120));
        await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_QR', text: url });
      } catch (e2) {
        // 再失败就算了
      }
    }
  };
  await sendOrInject();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;

  let text;
  switch (info.menuItemId) {
    case MENU_LINK:
      text = info.linkUrl || tab.url;
      break;
    case MENU_SEL:
      text = info.selectionText || '';
      break;
    case MENU_PAGE:
    default:
      text = tab.url || '';
      break;
  }

  if (!text) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_QR', text });
  } catch (err) {
    // 内容脚本可能还没注入（极罕见）；兜底用 executeScript 注入后重试
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['tailwind-css.js', 'ui.js', 'content.js'],
      });
      // 等一帧让 content.js 注册好 listener
      setTimeout(async () => {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_QR', text });
        } catch (e) {
          console.warn('[二维码助手] 注入后仍无法发送消息', e);
        }
      }, 100);
    } catch (e) {
      console.warn('[二维码助手] 无法注入内容脚本', e);
    }
  }
});
