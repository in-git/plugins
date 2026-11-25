(function () {
  try {
    if (typeof window.__IMG_INSPECTOR_BOOT__ === 'function') {
      window.__IMG_INSPECTOR_BOOT__();
    }
  } catch (e) {
    console.error('[图片探查器] 启动失败', e);
  }
})();
