(() => {
  'use strict';

  if (window.__videoInspectorLoaded) return;
  window.__videoInspectorLoaded = true;

  const MAX_DEPTH = 12;
  const EXT_VERSION = '1.11.0';
  const FEEDBACK_URL = 'https://space.bilibili.com/3706965849016893?spm_id_from=333.1007.0.0';
  const PREVIEW_LIMIT = 60;
  const DOWNLOAD_STALL_TIMEOUT = 90000;
  const DOWNLOAD_MAX_DURATION = 30 * 60 * 1000;
  const DL_REQUEST = '__video_inspector_download_request__';
  const DL_RESPONSE = '__video_inspector_download_response__';
  const DL_PROGRESS = '__video_inspector_download_progress__';
  const DL_CANCEL = '__video_inspector_download_cancel__';
  const DL_RESUME_QUERY = '__video_inspector_resume_query__';
  const DL_RESUME_LIST = '__video_inspector_resume_list__';
  const GET_RESOURCES = '__video_inspector_get_resources__';
  const RESOURCES = '__video_inspector_resources__';
  const DOWNLOAD_RESOURCE = '__video_inspector_download_resource__';
  const PROBE_SIZE = '__video_inspector_probe_size__';
  const PROBE_SIZE_RESPONSE = '__video_inspector_probe_size_response__';
  const GET_QUALITIES = '__video_inspector_get_qualities__';
  const QUALITIES = '__video_inspector_qualities__';
  const SCAN_RESOURCES = '__video_inspector_scan_resources__';
  const SCAN_RESULT = '__video_inspector_scan_result__';
  const FFMPEG_WORKER_URL = '__video_inspector_ffmpeg_worker_url__';

  try {
    document.dispatchEvent(new CustomEvent(FFMPEG_WORKER_URL, {
      detail: JSON.stringify({ url: chrome.runtime.getURL('ffmpeg-worker.js') })
    }));
  } catch (_) {}

  const I18N = {
    "extName": "视频下载工具-吴文龙",
    "extDescription": "选中页面元素，以大气网格模态框展示其下所有视频。",
    "actionTitle": "视频下载工具-吴文龙",
    "contextMenuTitle": "下载页面视频",
    "badgeIdle": "探查",
    "badgeInspecting": "探查中：移动查看 · 单击选择视频区域 · Esc 退出",
    "badgeArea": "框选模式：按住鼠标左键拖拽框选视频区域 · Esc 退出",
    "areaFound": "框选区域内发现 $count$ 个视频",
    "areaEmpty": "框选区域内没有视频，请重新框选",
    "shortcutHint": "快捷键 Alt+S：像审查元素一样移动高亮、单击选择视频区域 · Esc 退出",
    "inspectEmpty": "这里没有找到视频，换个位置再点一次",
    "badgeFound": "已探查到 $count$ 个视频",
    "badgeActiveShort": "探查中",
    "dialogTitle": "视频探查结果",
    "kicker": "视频下载工具-吴文龙",
    "countUnit": "个视频",
    "copyAll": "复制全部地址",
    "refresh": "扫描",
    "search": "搜索",
    "searchMode": "搜索方式",
    "normalSearch": "普通搜索",
    "deepScan": "深度扫描",
    "deepScanning": "深度扫描中...",
    "deepView": "深度视图 · 发现的资源",
    "deepEmpty": "没有发现可下载的资源，试试普通搜索。",
    "quality": "画质",
    "qualityAuto": "自动（最高）",
    "qualityLoading": "解析中...",
    "feedback": "反馈",
    "play": "播放",
    "locate": "定位",
    "copyAddress": "复制地址",
    "copied": "已复制",
    "close": "关闭",
    "previewUnavailable": "预览不可用",
    "resourcePreview": "视频资源",
    "noDirectSrc": "没有可直接播放的 src",
    "noSrc": "（无 src）",
    "playing": "播放中",
    "metaDuration": "时长",
    "metaResolution": "尺寸",
    "metaSize": "大小",
    "source": "来源",
    "durationNone": "-",
    "emptyTitle": "该元素下没有发现视频",
    "emptyDesc": "<video> 元素、Shadow DOM 与同源 iframe 都会被扫描。",
    "noMatchTitle": "没有匹配的视频",
    "noMatchDesc": "换个关键词试试。",
    "hoverVideoCount": "视频 $count$ 个",
    "hoverVideoIndex": "video #$index$",
    "download": "下载",
    "downloadAll": "下载全部",
    "downloading": "下载中...",
    "downloadDone": "已下载",
    "completed": "已完成",
    "downloadFailed": "下载失败",
    "queuedText": "排队中",
    "resumeText": "继续 $percent$%",
    "dlStats": "已完成 $done$/$total$ · 下载中 $active$ · 排队 $queued$ · 失败 $failed$",
    "pausedCount": "已暂停 $count$",
    "pauseAll": "暂停全部",
    "retryFailed": "重试失败",
    "clearDone": "清理已完成",
    "noDownloadableSrc": "无可下载源",
    "customTitle": "自定义标题",
    "customTitlePlaceholder": "输入下载时的标题",
    "selectAll": "全选",
    "format": "格式",
    "phaseResolving": "解析资源...",
    "phaseDownloading": "下载中...",
    "phaseVerifying": "校验完整性...",
    "phaseMerging": "ffmpeg 合并中...",
    "errorIncomplete": "文件不完整",
    "errorDurationMismatch": "时长不匹配",
    "errorSeparated": "音视频分离，无法直接合并",
    "errorNoSource": "未找到可下载的完整资源",
  };
  function t(key, values) {
    let text = I18N[key] || key;
    const names = values ? Object.keys(values) : [];
    names.forEach((name) => {
      text = text.replace(new RegExp('\\$' + name + '\\$', 'g'), String(values[name]));
    });
    return text;
  }
  let cache = new WeakMap();
  let active = false;
  let rafId = 0;
  let mouse = { x: 0, y: 0 };
  let hovered = null;
  let picked = null;
  let scanMode = 'normal';
  let deepScanTimer = 0;
  let capturePollTimer = 0;
  let currentItems = [];
  let suppressClick = false;
  let downloadSeq = 0;
  let sizeSeq = 0;
  let scanSeq = 0;
  let integratingScanId = '';
  let scanLoading = false;
  function itemKey(item) {
    return String(item && item.index) + ':' + ((item && item.src) || 'no-src');
  }
  const sizeCache = new Map();
  const capturedResources = new Map();
  const capturedByUrl = new Map();
  const downloadTasks = new Map();

  const host = document.createElement('div');
  host.id = '__video_inspector_host__';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
  [hidden] { display: none !important; }
  :host {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", sans-serif;
    font-weight: 400;
    color: #1d1d1f;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  * { box-sizing: border-box; }

  .vi-tip {
    position: absolute;
    display: none;
    max-width: 420px;
    padding: 9px 14px;
    border-radius: 12px;
    background: rgba(255, 255, 255, .86);
    border: 1px solid rgba(0, 0, 0, .06);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    box-shadow: 0 4px 16px rgba(0, 0, 0, .06);
    font: 12px/1.6 ui-monospace, Consolas, monospace;
    color: #1d1d1f;
    white-space: nowrap;
  }

  .vi-boxes { position: absolute; inset: 0; overflow: hidden; }
  .vi-box { position: absolute; }
  .vi-box.element { border: 1.5px solid #007aff; background: rgba(0, 122, 255, .06); }
  .vi-box.video { border: 1.5px dashed rgba(0, 122, 255, .72); background: rgba(0, 122, 255, .04); }
  .vi-box-label {
    position: absolute;
    left: 0;
    top: -22px;
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 3px 9px;
    border-radius: 7px;
    background: #007aff;
    color: #fff;
    font: 11px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  }
  .vi-box.video .vi-box-label { top: auto; bottom: -22px; background: rgba(0, 122, 255, .85); }

  .vi-area-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    cursor: crosshair;
    background: rgba(0, 0, 0, .12);
    touch-action: none;
    pointer-events: auto;
  }
  .vi-area-rect {
    position: absolute;
    border: 2px solid #007aff;
    border-radius: 8px;
    background: rgba(0, 122, 255, .12);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, .5) inset;
    pointer-events: none;
  }
  .vi-area-tip {
    position: fixed;
    z-index: 2147483647;
    left: 50%;
    top: 20px;
    transform: translateX(-50%);
    padding: 11px 20px;
    border-radius: 12px;
    background: rgba(29, 29, 31, .9);
    color: #fff;
    font-size: 13px;
    font-weight: 500;
    box-shadow: 0 6px 24px rgba(0, 0, 0, .2);
    pointer-events: none;
    white-space: nowrap;
  }
  .vi-area-toast {
    position: fixed;
    z-index: 2147483647;
    left: 50%;
    top: 76px;
    transform: translateX(-50%);
    padding: 9px 16px;
    border-radius: 10px;
    background: rgba(255, 255, 255, .95);
    border: 1px solid rgba(0, 0, 0, .06);
    color: #1d1d1f;
    font-size: 12px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .1);
    pointer-events: none;
  }

  .vi-modal {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 40px;
    pointer-events: auto;
    background: rgba(246, 246, 247, .78);
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
  }
  .vi-dialog {
    position: relative;
    width: min(1160px, 100%);
    height: 70vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 18px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, .06);
    box-shadow: 0 18px 54px rgba(0, 0, 0, .07), 0 2px 8px rgba(0, 0, 0, .03);
    animation: vi-in .24s ease-out;
  }
  @keyframes vi-in {
    from { opacity: 0; transform: translateY(6px) scale(.995); }
    to { opacity: 1; transform: none; }
  }

  .vi-head {
    display: flex;
    align-items: center;
    gap: 32px;
    padding: 32px 40px 26px;
    background: #fff;
    border-bottom: 1px solid #f5f5f7;
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }
  .vi-head.dragging { cursor: grabbing; }
  .vi-title-wrap { flex: 1; min-width: 0; }
  .vi-kicker {
    margin-bottom: 9px;
    font: 600 10px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
    letter-spacing: 2px;
    color: #86868b;
    text-transform: uppercase;
  }
  .vi-head h2 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -.3px; color: #1d1d1f; }
  .vi-version {
    display: inline-block; margin-left: 10px; padding: 2px 8px;
    border-radius: 6px; background: #f6f6f7; color: #86868b;
    font: 11px/1.5 ui-monospace, Consolas, monospace; vertical-align: middle;
  }
  .vi-count {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 9px 16px;
    border-radius: 12px;
    background: #f6f6f7;
  }
  .vi-count .num { font-size: 28px; font-weight: 600; line-height: 1; color: #1d1d1f; }
  .vi-count .unit { font-size: 12px; color: #86868b; }
  .vi-x {
    flex: none;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 50%;
    background: #f6f6f7;
    color: #86868b;
    font-size: 19px;
    font-weight: 300;
    cursor: pointer;
    transition: .18s;
  }
  .vi-x:hover { background: #ebebeb; color: #1d1d1f; }

  .vi-toolbar {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
    padding: 14px 40px;
    background: #fff;
    border-bottom: 1px solid #f5f5f7;
  }
  .vi-dlbar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 40px;
    background: #f8f9fb;
    border-bottom: 1px solid #eef0f3;
  }
  .vi-dlbar[hidden] { display: none; }
  .vi-dlbar-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; }
  .vi-dlbar-progress { flex: 0 0 160px; height: 6px; border-radius: 3px; background: #e6e8ec; overflow: hidden; }
  .vi-dlbar-fill { display: block; height: 100%; width: 0; background: #007aff; transition: width .25s; }
  .vi-dlbar-text { font-size: 12px; color: #6e6e73; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .vi-dlbar-actions { display: flex; gap: 8px; margin-left: auto; }
  .vi-search-group, .vi-download-group { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .vi-download-group { margin-left: auto; }
  .vi-scan-mode {
    display: inline-flex;
    align-items: center;
    padding: 3px;
    gap: 2px;
    border-radius: 9px;
    background: #f6f6f7;
  }
  .vi-scan-mode label {
    position: relative;
    display: inline-flex;
    border-radius: 7px;
    font-size: 12px;
    color: #86868b;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .vi-scan-mode input { position: absolute; opacity: 0; width: 0; height: 0; }
  .vi-scan-mode span { padding: 6px 12px; border-radius: 7px; }
  .vi-scan-mode input:checked + span {
    background: #fff;
    color: #007aff;
    font-weight: 500;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .08);
  }
  .vi-mode-note {
    height: 30px;
    padding: 6px 10px;
    border-radius: 8px;
    background: rgba(0, 122, 255, .1);
    color: #007aff;
    font-size: 11px;
    line-height: 18px;
    white-space: nowrap;
  }
  .vi-btn {
    height: 34px;
    padding: 0 16px;
    border-radius: 10px;
    border: 1px solid rgba(0, 0, 0, .08);
    background: #fff;
    color: #1d1d1f;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: .18s;
    white-space: nowrap;
  }
  .vi-btn:hover { background: #f6f6f7; }
  .vi-btn.primary { background: #007aff; border-color: #007aff; color: #fff; }
  .vi-btn.primary:hover { background: #0071eb; border-color: #0071eb; }
  .vi-btn.danger { border-color: rgba(223, 0, 21, .18); color: #d70015; }
  .vi-btn.danger:hover { background: rgba(223, 0, 21, .05); }
  .vi-btn.small { height: 28px; padding: 0 12px; font-size: 12px; border-radius: 8px; }
  .vi-btn.vi-loading { display: inline-flex; align-items: center; gap: 6px; }
  .vi-btn:disabled { cursor: not-allowed; opacity: .4; }
  .vi-spinner {
    display: inline-block;
    width: 12px; height: 12px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: vi-spin .7s linear infinite;
    flex: none;
  }
  @keyframes vi-spin { to { transform: rotate(360deg); } }

  .vi-grid {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    grid-auto-rows: max-content;
    align-content: start;
    align-items: start;
    gap: 24px;
    padding: 32px 40px 40px;
    background: #f6f6f7;
    scrollbar-width: thin;
    scrollbar-color: rgba(0, 0, 0, .18) transparent;
  }
  .vi-grid::-webkit-scrollbar { width: 8px; }
  .vi-grid::-webkit-scrollbar-track { background: transparent; }
  .vi-grid::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, .14); border-radius: 8px; border: 2px solid #f6f6f7; }
  .vi-card {
    position: relative;
    height: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 16px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, .05);
    box-shadow: 0 2px 12px rgba(0, 0, 0, .035);
    transition: transform .22s, box-shadow .22s;
  }
  .vi-card:hover { transform: translateY(-2px); box-shadow: 0 10px 28px rgba(0, 0, 0, .07); }

  /* 深度扫描列表视图：单列、无封面、信息完整度优先 */
  .vi-grid.vi-list-mode { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .vi-list-header,
  .vi-list-row {
    display: grid;
    grid-template-columns: 18px 40px minmax(160px, 1fr) 88px 112px 96px 92px 88px;
    align-items: center;
    gap: 12px;
  }
  .vi-list-header {
    padding: 0 16px 8px;
    border-bottom: 1px solid #e8e8ed;
    color: #86868b;
    font-size: 11px;
    font-weight: 500;
  }
  .vi-list-row {
    padding: 12px 16px;
    border-radius: 12px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, .05);
    box-shadow: 0 2px 12px rgba(0, 0, 0, .035);
  }
  .vi-list-row.vi-row-complete { border-left: 3px solid #007aff; padding-left: 13px; }
  .vi-list-check { width: 18px; height: 18px; accent-color: #007aff; cursor: pointer; }
  .vi-list-index { color: #aeaeb2; font-size: 12px; font-variant-numeric: tabular-nums; }
  .vi-list-title-cell { min-width: 0; }
  .vi-list-title-input {
    box-sizing: border-box;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    color: #1d1d1f;
    font-size: 13px;
    font-weight: 500;
    border: 1px solid transparent;
    border-radius: 8px;
    background: #f6f6f7;
    color: #1d1d1f;
    font-size: 12px;
    outline: none;
  }
  .vi-list-title-input:focus { background: #fff; border-color: #007aff; box-shadow: 0 0 0 3px rgba(0, 122, 255, .12); }
  .vi-list-title-input::placeholder { color: #aeaeb2; }
  .vi-list-cell {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: #86868b;
  }
  .vi-list-cell.strong { color: #007aff; font-weight: 500; }
  .vi-list-cell.done { color: #248a3d; font-weight: 500; }
  .vi-list-actions { display: flex; justify-content: flex-end; }

  .vi-media { position: relative; background: #f6f6f7; height: 150px; overflow: hidden; flex: none; }
  .vi-thumb { display: block; width: 100%; height: 150px; object-fit: cover; background: #f6f6f7; }
  .vi-ph {
    width: 100%;
    height: 150px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: #86868b;
    font-size: 12px;
    background: #f6f6f7;
  }
  .vi-ph .vi-ph-icon { font-size: 26px; opacity: .42; }
  .vi-index {
    position: absolute;
    top: 12px;
    left: 12px;
    padding: 3px 9px;
    border-radius: 8px;
    background: rgba(255, 255, 255, .84);
    border: 1px solid rgba(0, 0, 0, .05);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    color: #86868b;
    font: 11px/1.5 ui-monospace, Consolas, monospace;
  }
  .vi-live {
    position: absolute;
    top: 12px;
    right: 12px;
    padding: 3px 9px;
    border-radius: 8px;
    background: #ff3b30;
    color: #fff;
    font-size: 10px;
  }
  .vi-info {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 2;
    padding: 30px 12px 10px;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, .78));
    color: #fff;
    pointer-events: none;
  }
  .vi-info-title {
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.5;
    color: #fff;
    word-break: break-all;
    text-shadow: 0 1px 2px rgba(0, 0, 0, .35);
  }
  .vi-body { padding: 18px 18px 20px; }
  .vi-card-row { display: flex; align-items: flex-end; gap: 10px; }
  .vi-card-row .vi-title-field { flex: 1; min-width: 0; margin-bottom: 0; }
  .vi-title-label {
    display: block;
    margin-bottom: 6px;
    font-size: 11px;
    color: #86868b;
  }
  .vi-title-input {
    width: 100%;
    height: 34px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: #f6f6f7;
    color: #1d1d1f;
    font-size: 13px;
    outline: none;
    transition: background .18s, border-color .18s, box-shadow .18s;
  }
  .vi-title-input:focus { background: #fff; border-color: #007aff; box-shadow: 0 0 0 3px rgba(0, 122, 255, .12); }
  .vi-title-input::placeholder { color: #aeaeb2; }
  .vi-meta { display: flex; flex-wrap: wrap; gap: 6px; }
  .vi-chip {
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, .18);
    color: #fff;
    font-size: 11px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .vi-chip.done { background: rgba(52, 199, 89, .9); color: #fff; }
  .vi-card-actions { display: flex; flex: none; align-items: center; }
  .vi-card-actions .vi-card-download { min-width: 84px; }
  .vi-check-all {
    display: flex; align-items: center; gap: 9px;
    font-size: 13px; color: #1d1d1f; cursor: pointer; white-space: nowrap;
  }
  .vi-check-all input, .vi-card-check input { width: 15px; height: 15px; accent-color: #007aff; cursor: pointer; margin: 0; }
  .vi-format-wrap { display: flex; align-items: center; gap: 9px; white-space: nowrap; }
  .vi-format-label { font-size: 12px; color: #86868b; }
  .vi-format {
    height: 34px; min-width: 100px; padding: 0 12px; border: 1px solid rgba(0, 0, 0, .08); border-radius: 10px;
    background: #fff; color: #1d1d1f; font-size: 13px; outline: none; cursor: pointer;
    transition: border-color .18s, box-shadow .18s;
  }
  .vi-format:focus { border-color: #007aff; box-shadow: 0 0 0 3px rgba(0, 122, 255, .12); }
  .vi-card-check {
    position: absolute; top: 12px; right: 12px; z-index: 2;
    display: flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 7px;
    background: rgba(255, 255, 255, .88); border: 1px solid rgba(0, 0, 0, .05);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  .vi-empty {
    grid-column: 1 / -1;
    padding: 96px 24px;
    text-align: center;
    color: #86868b;
    font-size: 13px;
    line-height: 1.6;
  }
  .vi-empty::before {
    content: '';
    display: block;
    width: 52px;
    height: 52px;
    margin: 0 auto 22px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 52 52' fill='none' stroke='%2386868b' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='9' y='12' width='34' height='28' rx='7'/%3E%3Cpath d='M22 21l9 5-9 5z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: center;
    background-size: contain;
    opacity: .55;
  }
  .vi-empty strong { display: block; margin-bottom: 8px; font-size: 17px; font-weight: 600; color: #1d1d1f; }

  .vi-footer {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    padding: 14px 40px;
    background: #fff;
    border-top: 1px solid #f5f5f7;
  }
  .vi-shortcut-hint {
    color: #86868b;
    font-size: 11px;
    white-space: nowrap;
  }
  .vi-btn.feedback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    height: 34px;
    padding: 0 14px;
    border-color: transparent;
    background: transparent;
    color: #007aff;
    font-weight: 500;
  }
  .vi-btn.feedback:hover { background: rgba(0, 122, 255, .06); border-color: transparent; color: #007aff; }
  .vi-feedback-icon { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }

</style>

<div class="vi-tip"></div>
<div class="vi-boxes"></div>
<div class="vi-area-overlay" hidden>
  <div class="vi-area-rect" hidden></div>
</div>
<div class="vi-area-tip" hidden></div>
<div class="vi-area-toast" hidden></div>

<div class="vi-modal" hidden>
  <div class="vi-dialog" role="dialog" aria-modal="true" aria-labelledby="vi-title">
    <header class="vi-head">
      <div class="vi-title-wrap">
        <div class="vi-kicker">${t('kicker')}</div>
        <h2 id="vi-title">${t('dialogTitle')} <span class="vi-version">v${EXT_VERSION}</span></h2>
      </div>
      <div class="vi-count"><span class="num">0</span><span class="unit">${t('countUnit')}</span></div>
      <button class="vi-x" type="button" data-action="close" aria-label="${t('close')}">×</button>
    </header>

    <div class="vi-toolbar">
      <div class="vi-search-group">
        <label class="vi-check-all"><input type="checkbox" class="vi-select-all" checked /> ${t('selectAll')}</label>
        <div class="vi-scan-mode">
          <label><input type="radio" name="vi-scan-mode" value="normal" checked /><span>${t('normalSearch')}</span></label>
          <label><input type="radio" name="vi-scan-mode" value="deep" /><span>${t('deepScan')}</span></label>
        </div>
        <button class="vi-btn" type="button" data-action="search">${t('search')}</button>
        <button class="vi-btn" type="button" data-action="refresh">${t('refresh')}</button>
        <span class="vi-mode-note" hidden>${t('deepView')}</span>
      </div>
      <div class="vi-download-group">
        <label class="vi-format-wrap">
          <span class="vi-format-label">${t('format')}</span>
          <select class="vi-format">
            <option value="mp4" selected>MP4</option>
            <option value="video">video</option>
            <option value="webm">WebM</option>
          </select>
        </label>
        <label class="vi-format-wrap">
          <span class="vi-format-label">${t('quality')}</span>
          <select class="vi-format vi-quality"><option value="">${t('qualityAuto')}</option></select>
        </label>
        <button class="vi-btn primary" type="button" data-action="download-all">${t('downloadAll')}</button>
      </div>
    </div>

    <div class="vi-dlbar" hidden>
      <div class="vi-dlbar-main">
        <div class="vi-dlbar-progress"><span class="vi-dlbar-fill"></span></div>
        <div class="vi-dlbar-text"></div>
      </div>
      <div class="vi-dlbar-actions">
        <button class="vi-btn" type="button" data-action="dl-pause">${t('pauseAll')}</button>
        <button class="vi-btn" type="button" data-action="dl-retry">${t('retryFailed')}</button>
        <button class="vi-btn" type="button" data-action="dl-clear">${t('clearDone')}</button>
      </div>
    </div>

    <div class="vi-grid"></div>

    <footer class="vi-footer">
      <span class="vi-shortcut-hint">${t('shortcutHint')}</span>
      <button class="vi-btn feedback" type="button" data-action="feedback" title="可在B站私信反馈问题：${FEEDBACK_URL}">
        <svg class="vi-feedback-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v10h16V6H4z"/></svg>
        <span>${t('feedback')}</span>
      </button>
    </footer>

  </div>
</div>
`;

  const q = (selector) => shadow.querySelector(selector);
  const tip = q('.vi-tip');
  const boxes = q('.vi-boxes');
  const areaOverlay = q('.vi-area-overlay');
  const areaRect = q('.vi-area-rect');
  const areaTip = q('.vi-area-tip');
  const areaToast = q('.vi-area-toast');
  const modal = q('.vi-modal');
  const dialog = q('.vi-dialog');
  const head = q('.vi-head');
  const numEl = q('.vi-count .num');
  const grid = q('.vi-grid');
  const selectAll = q('.vi-select-all');
  const formatSelect = q('.vi-format');
  const qualitySelect = q('.vi-quality');
  const scanModeInputs = Array.from(shadow.querySelectorAll('.vi-scan-mode input'));
  const modeNote = q('.vi-mode-note');
  let dialogOffset = { x: 0, y: 0 };
  let dragState = null;
  let qualitySeq = 0;
  let areaMode = false;
  let areaStart = null;
  let areaToastTimer = null;
  let resumeSeq = 0;

  // 断点续传：把页面里的未完成任务同步到卡片按钮上
  document.addEventListener(DL_RESUME_LIST, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    resumeJobs.clear();
    (data && data.jobs || []).forEach((job) => {
      if (!job) return;
      const key = job.jobKey || String(job.filename || '').replace(/\.[^.]+$/, '');
      if (key) resumeJobs.set(key, job);
    });
    refreshDownloadButtons();
  }, true);

  function requestResumeState() {
    try {
      document.dispatchEvent(new CustomEvent(DL_RESUME_QUERY, {
        detail: JSON.stringify({ id: 'vi-resume-' + (++resumeSeq), pageUrl: location.href })
      }));
    } catch (_) {}
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('click', onPageClick, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);

  shadow.addEventListener('click', onShadowClick);
  scanModeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      scanMode = input.value || 'normal';
      updateScanModeUi();
      if (!modal.hidden) runSearch();
    });
  });

  function applyDialogOffset() {
    if (!dialog) return;
    dialog.style.transform = (dialogOffset.x || dialogOffset.y)
      ? 'translate(' + dialogOffset.x + 'px, ' + dialogOffset.y + 'px)'
      : '';
  }

  function clampDialogOffset(x, y) {
    const w = dialog ? dialog.offsetWidth || 1 : 1;
    const h = dialog ? dialog.offsetHeight || 1 : 1;
    const baseLeft = (window.innerWidth - w) / 2;
    const baseTop = (window.innerHeight - h) / 2;
    const clamp = (value, min, max) => min > max ? 0 : Math.max(min, Math.min(value, max));
    return {
      x: clamp(x, 60 - w - baseLeft, window.innerWidth - 60 - baseLeft),
      y: clamp(y, 40 - h - baseTop, window.innerHeight - 40 - baseTop)
    };
  }

  function resetDialogPosition() {
    dialogOffset = { x: 0, y: 0 };
    dragState = null;
    if (!dialog) return;
    dialog.style.animation = '';
    applyDialogOffset();
  }

  if (head && dialog) {
    head.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('button, input, select, a')) return;
      dialog.style.animation = 'none';
      dragState = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: dialogOffset.x,
        offsetY: dialogOffset.y
      };
      try { head.setPointerCapture(event.pointerId); } catch (_) {}
      head.classList.add('dragging');
      event.preventDefault();
    });
    head.addEventListener('pointermove', (event) => {
      if (!dragState || event.pointerId !== dragState.id) return;
      dialogOffset = clampDialogOffset(
        dragState.offsetX + event.clientX - dragState.startX,
        dragState.offsetY + event.clientY - dragState.startY
      );
      applyDialogOffset();
    });
    const stopDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.id) return;
      dragState = null;
      head.classList.remove('dragging');
      try { head.releasePointerCapture(event.pointerId); } catch (_) {}
    };
    head.addEventListener('pointerup', stopDrag);
    head.addEventListener('pointercancel', stopDrag);
  }

  if (selectAll) {
    selectAll.addEventListener('change', () => {
      currentItems.forEach((item) => { item.selected = selectAll.checked; });
      grid.querySelectorAll('.vi-card-check input').forEach((box) => {
        box.checked = selectAll.checked;
      });
    });
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.type) return;
      if (window.top !== window.self) return;
      if (message.type === 'vi-toggle') {
        stopInspect();
        openAllVideos();
      } else if (message.type === 'vi-open-last') {
        stopInspect();
        openModal(picked && picked.isConnected ? picked : document.body || document.documentElement);
      }
    });
  } catch (_) {}

  document.addEventListener(RESOURCES, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || !Array.isArray(data.items)) return;
    applyCapturedResources(data.items);
  });

  document.addEventListener(SCAN_RESULT, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || !Array.isArray(data.items)) return;
    if (!integratingScanId || data.id !== integratingScanId) return;
    integratingScanId = '';
    integrateResources(data.items);
  });

  function openAllVideos() {
    scanMode = 'normal';
    updateScanModeUi();
    openModal(document.body || document.documentElement);
  }

  function startInspect() {
    active = true;
    picked = null;
    scanMode = 'normal';
    updateScanModeUi();
    // 进入探查后立即按最后鼠标位置给出高亮，和“审查元素”手感一致
    computeHover();
    showAreaToast(t('badgeInspecting'));
  }

  function stopInspect() {
    active = false;
    hovered = null;
    boxes.replaceChildren();
    tip.style.display = 'none';
  }

  function showAreaToast(text) {
    if (!areaToast) return;
    areaToast.textContent = text;
    areaToast.hidden = false;
    if (areaToastTimer) clearTimeout(areaToastTimer);
    areaToastTimer = setTimeout(() => { areaToast.hidden = true; }, 2600);
  }

  function startAreaMode() {
    if (!modal.hidden) closeModal();
    stopInspect();
    areaMode = true;
    areaStart = null;
    areaOverlay.hidden = false;
    areaTip.textContent = t('badgeArea');
    areaTip.hidden = false;
    areaRect.hidden = true;
  }

  function stopAreaMode() {
    areaMode = false;
    areaStart = null;
    areaOverlay.hidden = true;
    areaTip.hidden = true;
    areaRect.hidden = true;
  }

  function updateAreaRect(event) {
    if (!areaRect || !areaStart) return;
    const left = Math.min(areaStart.x, event.clientX);
    const top = Math.min(areaStart.y, event.clientY);
    const width = Math.abs(event.clientX - areaStart.x);
    const height = Math.abs(event.clientY - areaStart.y);
    areaRect.style.left = left + 'px';
    areaRect.style.top = top + 'px';
    areaRect.style.width = width + 'px';
    areaRect.style.height = height + 'px';
    areaRect.hidden = width < 2 || height < 2;
    if (width >= 2 && height >= 2) {
      const count = countVideosInRect({ left, top, width, height });
      areaTip.textContent = t('areaFound', { count });
    }
  }

  function countVideosInRect(rect) {
    const videos = collectVideos(document.body || document.documentElement, 0, 0, 0, [], new Set(), MAX_DEPTH);
    return videos.filter((item) => {
      const box = item.el.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      return !(box.right < rect.left || box.left > rect.left + rect.width ||
        box.bottom < rect.top || box.top > rect.top + rect.height);
    }).length;
  }

  function finishAreaSelection() {
    if (!areaRect || areaRect.hidden || !areaStart) return;
    const rect = {
      left: parseFloat(areaRect.style.left) || 0,
      top: parseFloat(areaRect.style.top) || 0,
      width: parseFloat(areaRect.style.width) || 0,
      height: parseFloat(areaRect.style.height) || 0
    };
    stopAreaMode();
    if (rect.width < 8 || rect.height < 8) return;

    const videos = collectVideos(document.body || document.documentElement, 0, 0, 0, [], new Set(), MAX_DEPTH).filter((item) => {
      const box = item.el.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      const visibleLeft = Math.max(box.left, rect.left);
      const visibleTop = Math.max(box.top, rect.top);
      const visibleRight = Math.min(box.right, rect.left + rect.width);
      const visibleBottom = Math.min(box.bottom, rect.top + rect.height);
      if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return false;
      const visibleArea = (visibleRight - visibleLeft) * (visibleBottom - visibleTop);
      return visibleArea >= Math.min(box.width * box.height * 0.25, 2500);
    });

    if (!videos.length) {
      showAreaToast(t('areaEmpty'));
      return;
    }
    showAreaToast(t('areaFound', { count: videos.length }));
    cache = new WeakMap();
    picked = document.body || document.documentElement;
    openAreaModal(videos);
  }

  function openAreaModal(videos) {
    modal.hidden = false;
    resetDialogPosition();
    if (numEl) numEl.textContent = '0';
    if (selectAll) selectAll.checked = true;
    scanMode = 'normal';
    updateScanModeUi();
    currentItems = videos.map((item, index) => buildItem(item, index));
    currentItems.forEach((item) => {
      const videoTask = downloadTasks.get(itemKey(item));
      if (videoTask) videoTask.item = item;
    });
    if (numEl) numEl.textContent = String(videos.length);
    try {
      renderGrid();
      refreshDownloadButtons();
    } catch (error) {
      console.error('[VideoInspector] area render failed:', error);
      grid.replaceChildren();
    }
    loadSizes();
    requestCapturedResources();
    requestQualities();
  }

  function schedule() {
    if (!active || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      computeHover();
    });
  }

  function onMouseMove(event) {
    if (areaMode) {
      if (areaStart) updateAreaRect(event);
      return;
    }
    if (!active || isOwnEvent(event)) return;
    mouse = { x: event.clientX, y: event.clientY };
    schedule();
  }

  function onMouseDown(event) {
    if (areaMode) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      areaStart = { x: event.clientX, y: event.clientY };
      areaRect.hidden = true;
      return;
    }
    if (!active || event.button !== 0 || isOwnEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);

    const hit = hitTest(document, event.clientX, event.clientY);
    if (!hit) return;
    // 命中元素内确实有视频才打开模态框；没有就留在探查模式继续点
    const lookup = (node) => {
      let list = cache.get(node);
      if (!list) {
        list = collectVideos(node, 0, 0, 0);
        cache.set(node, list);
      }
      return list;
    };
    let target = hit.el;
    let videos = lookup(target);
    // 点到封面/浮层等子元素时，最多向上找 4 层，找到含视频的容器为止
    for (let i = 0; !videos.length && i < 4 && target.parentElement; i++) {
      target = target.parentElement;
      videos = lookup(target);
    }
    if (!videos.length) {
      mouse = { x: event.clientX, y: event.clientY };
      hovered = { ...hit, videos, label: describe(hit.el) };
      renderHover();
      showAreaToast(t('inspectEmpty'));
      return;
    }
    picked = target;
    stopInspect();
    openModal(picked);
  }

  function onMouseUp(event) {
    if (!areaMode || !areaStart) return;
    event.preventDefault();
    event.stopPropagation();
    finishAreaSelection();
  }

  function onPageClick(event) {
    if (areaMode) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (suppressClick && !isOwnEvent(event)) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (active && !isOwnEvent(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onContextMenu(event) {
    if (isOwnEvent(event)) return;
    const node = deepestElement(event);
    if (node) picked = node;
  }

  function onKeyDown(event) {
    if (event.altKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      event.stopPropagation();
      if (areaMode) stopAreaMode();
      if (active) {
        stopInspect();
        return;
      }
      if (!modal.hidden) closeModal();
      startInspect();
      return;
    }
    if (areaMode) {
      if (event.key === 'Escape') {
        event.preventDefault();
        stopAreaMode();
      }
      return;
    }
    if (!modal.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
      }
      return;
    }
    if (event.key === 'Escape' && active) {
      event.preventDefault();
      stopInspect();
      return;
    }
  }

  function computeHover() {
    if (!active) return;
    const hit = hitTest(document, mouse.x, mouse.y);
    if (!hit) {
      hovered = null;
      renderHover();
      return;
    }
    let videos = cache.get(hit.el);
    if (!videos) {
      videos = collectVideos(hit.el, 0, 0, 0);
      cache.set(hit.el, videos);
    }
    hovered = { ...hit, videos, label: describe(hit.el) };
    renderHover();
  }

  function renderHover() {
    boxes.replaceChildren();
    if (!hovered) {
      tip.style.display = 'none';
      return;
    }
    addBox(hovered.rect, 'element', hovered.label);
    hovered.videos.slice(0, PREVIEW_LIMIT).forEach((item, index) => {
      const rect = item.el.getBoundingClientRect();
      addBox({
        left: rect.left + item.ox,
        top: rect.top + item.oy,
        width: rect.width,
        height: rect.height
      }, 'video', t('hoverVideoIndex', { index: index + 1 }));
    });
    tip.textContent = hovered.label + '  |  ' + t('hoverVideoCount', { count: hovered.videos.length });
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(mouse.x + 16, window.innerWidth - tw - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(mouse.y + 16, window.innerHeight - th - 8)) + 'px';
  }

  function addBox(rect, type, label) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const box = document.createElement('div');
    box.className = 'vi-box ' + type;
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    const tag = document.createElement('span');
    tag.className = 'vi-box-label';
    tag.textContent = label;
    box.appendChild(tag);
    boxes.appendChild(box);
  }

  function openModal(root) {
    if (!root || !root.isConnected) root = document.body || document.documentElement;
    cache = new WeakMap();
    picked = root;
    modal.hidden = false;
    resetDialogPosition();
    if (numEl) numEl.textContent = '0';
    if (selectAll) selectAll.checked = true;
    updateScanModeUi();

    if (scanMode === 'deep') {
      startDeepView();
    } else {
      openNormalView(root);
    }

    requestCapturedResources();
    requestQualities();
    requestResumeState();
    if (deepScanTimer) clearTimeout(deepScanTimer);
    if (capturePollTimer) clearInterval(capturePollTimer);
    deepScanTimer = setTimeout(requestCapturedResources, 2500);
    capturePollTimer = setInterval(requestCapturedResources, 5000);
  }

  function updateScanModeUi() {
    scanModeInputs.forEach((input) => { input.checked = input.value === scanMode; });
    if (modeNote) modeNote.hidden = scanMode !== 'deep';
  }

  function runSearch() {
    if (modal.hidden) return;
    if (scanMode === 'deep') {
      startDeepView();
    } else {
      integratingScanId = '';
      scanLoading = false;
      openNormalView(picked);
    }
  }

  // 普通搜索：完全沿用原来的 DOM 视频扫描逻辑。
  function openNormalView(root) {
    const videos = collectVideos(root, 0, 0, 0, [], new Set(), MAX_DEPTH);
    currentItems = videos.map((item, index) => buildItem(item, index));

    currentItems.forEach((item) => {
      const videoTask = downloadTasks.get(itemKey(item));
      if (videoTask) videoTask.item = item;
    });

    if (numEl) numEl.textContent = String(videos.length);
    try {
      renderGrid();
      refreshDownloadButtons();
    } catch (error) {
      console.error('[VideoInspector] renderGrid failed:', error);
      grid.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'vi-empty';
      empty.textContent = '渲染视频列表时出错，请查看控制台。';
      grid.appendChild(empty);
    }
    loadSizes();
  }

  // 深度扫描：三层资源模型独占视图，不再追加到普通结果里。
  function startDeepView() {
    integratingScanId = '';
    scanLoading = true;
    currentItems = [];
    if (numEl) numEl.textContent = '0';
    grid.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'vi-empty';
    loading.textContent = t('deepScanning');
    grid.appendChild(loading);
    requestResourceScan();
  }

  function requestCapturedResources() {
    try {
      document.dispatchEvent(new CustomEvent(GET_RESOURCES, { detail: JSON.stringify({}) }));
    } catch (_) {}
  }

  function requestResourceScan() {
    const id = 'scan-' + (++scanSeq);
    integratingScanId = id;
    try {
      document.dispatchEvent(new CustomEvent(SCAN_RESOURCES, {
        detail: JSON.stringify({ id, pageUrl: location.href })
      }));
    } catch (_) {
      integratingScanId = '';
    }
    setTimeout(() => {
      if (integratingScanId !== id) return;
      integratingScanId = '';
      if (scanLoading && scanMode === 'deep' && !modal.hidden) integrateResources([]);
    }, 8000);
  }

  const SIGNATURE_PARAM = /^(bti|bt|ft|a|sign|signature|token|t|expires|expire|ts|nonce|stamp|timestamp|x-amz-[^=]*|x-goog-[^=]*|se|sv|sp|sig|_signature)$/i;
  const ID_PARAM = /^(id|vid|video_id|aweme_id|bvid|cid|item_id|itemId)$/i;

  function resourceFingerprint(url) {
    if (!url || typeof url !== 'string') return '';
    if (/^blob:|^data:|^mse:/i.test(url)) return '';
    let u;
    try { u = new URL(url, location.href); } catch (_) { return ''; }
    const host = u.hostname.replace(/^www\./i, '');
    const path = u.pathname.replace(/\/+$/, '');
    if (/bilibili/i.test(host)) {
      const bv = (path.match(/(BV[0-9A-Za-z]{10})/) || [])[1];
      if (bv) return 'bilibili:' + bv;
    }
    if (/(tiktok|douyin|aweme)/i.test(host + path)) {
      const id = (path.match(/\/([0-9]{12,}|[A-Za-z0-9_-]{18,})\/?$/) || [])[1];
      if (id) return host + ':' + id;
    }
    const ids = [];
    u.searchParams.forEach((value, key) => {
      if (ID_PARAM.test(key) && value) ids.push(key + '=' + value);
    });
    if (ids.length) return host + path + '?' + ids.sort().join('&');
    const kept = [];
    u.searchParams.forEach((value, key) => {
      if (!SIGNATURE_PARAM.test(key)) kept.push(key + '=' + value);
    });
    return host + path + (kept.length ? '?' + kept.sort().join('&') : '');
  }

  function mergeResource(prev, next) {
    const merged = Object.assign({}, prev);
    ['size', 'width', 'height', 'duration', 'score'].forEach((key) => {
      if ((Number(next[key]) || 0) > (Number(merged[key]) || 0)) merged[key] = next[key];
    });
    ['audioUrl', 'videoUrl', 'poster', 'title', 'kind'].forEach((key) => {
      if (!merged[key] && next[key]) merged[key] = next[key];
    });
    const sources = Array.from(new Set([
      ...(Array.isArray(prev.sources) ? prev.sources : [prev.source]),
      next.source
    ].filter(Boolean)));
    merged.sources = sources;
    merged.source = sources.join('+');
    return merged;
  }

  // 深度视图：按指纹全量重建逻辑视频集合，不再追加。
  function integrateResources(resources) {
    scanLoading = false;
    if (!modal || modal.hidden || scanMode !== 'deep') return;
    const grouped = new Map();
    (Array.isArray(resources) ? resources : []).forEach((res) => {
      if (!res || !res.url) return;
      const key = resourceFingerprint(res.url) || resourceFingerprint(res.videoUrl);
      if (!key) return;
      const prev = grouped.get(key);
      grouped.set(key, prev ? mergeResource(prev, res) : Object.assign({ sources: [res.source].filter(Boolean) }, res));
    });
    const completeness = (r) => {
      let value = 0;
      if ((Number(r.size) || 0) > 0) value += 4;
      if ((Number(r.width) || 0) > 0 && (Number(r.height) || 0) > 0) value += 4;
      if ((Number(r.duration) || 0) > 0) value += 1;
      if (r.audioUrl) value += 1;
      if (r.title) value += 1;
      return value;
    };
    const merged = Array.from(grouped.values()).sort((a, b) => {
      const completeDiff = completeness(b) - completeness(a);
      if (completeDiff) return completeDiff;
      if ((Number(b.size) || 0) !== (Number(a.size) || 0)) return (Number(b.size) || 0) - (Number(a.size) || 0);
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    }).slice(0, 120);
    currentItems = merged.map((res, index) => buildResourceItem(res, index));
    currentItems.forEach((item) => {
      const videoTask = downloadTasks.get(itemKey(item));
      if (videoTask) videoTask.item = item;
    });
    if (numEl) numEl.textContent = String(currentItems.length);
    if (!currentItems.length) {
      grid.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'vi-empty';
      empty.textContent = t('deepEmpty');
      grid.appendChild(empty);
      return;
    }
    try {
      renderGrid();
      refreshDownloadButtons();
    } catch (error) {
      console.error('[VideoInspector] deep render failed:', error);
      grid.replaceChildren();
    }
    loadSizes();
  }

  function buildResourceItem(res, index) {
    const size = Number(res.size) || 0;
    return {
      index,
      el: null,
      ox: 0,
      oy: 0,
      label: res.title || resourceDisplayName(res.url),
      customTitle: '',
      selected: (Number(res.score) || 0) >= 80,
      src: res.url,
      poster: res.poster || '',
      duration: res.duration ? formatDuration(res.duration) : '-',
      resolution: res.width && res.height ? res.width + '×' + res.height : '-',
      sizeText: formatSize(size),
      hasSize: size > 0,
      hasResolution: !!(res.width && res.height),
      hasDuration: !!(res.duration && Number(res.duration) > 0),
      paused: true,
      currentTime: 0,
      isResource: true,
      discovered: true,
      discoverySource: res.source || 'scan',
      discoveredScore: Number(res.score) || 0,
      videoUrl: res.videoUrl || '',
      audioUrl: res.audioUrl || '',
      resourceKind: res.kind || 'direct',
      resourceId: '',
      resourceType: '',
      resourceSize: size
    };
  }

  function resourceDisplayName(url) {
    try {
      const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop());
      return name ? '资源 · ' + name.slice(0, 40) : '视频资源';
    } catch (_) {
      return '视频资源';
    }
  }

  function requestQualities() {
    if (!qualitySelect) return;
    const id = 'q-' + (++qualitySeq);
    qualitySelect.replaceChildren();
    const loading = document.createElement('option');
    loading.value = '';
    loading.textContent = t('qualityLoading');
    qualitySelect.appendChild(loading);
    qualitySelect.disabled = true;

    let settled = false;
    const finish = (list) => {
      if (settled) return;
      settled = true;
      document.removeEventListener(QUALITIES, onResponse, true);
      clearTimeout(timer);
      qualitySelect.disabled = false;
      qualitySelect.replaceChildren();
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = t('qualityAuto');
      qualitySelect.appendChild(auto);
      (list || []).forEach((item) => {
        if (!item || item.id === undefined || item.id === null) return;
        const option = document.createElement('option');
        option.value = String(item.id);
        let label = item.label || String(item.id);
        if (item.width && item.height) label += ' · ' + item.width + '×' + item.height;
        option.textContent = label;
        qualitySelect.appendChild(option);
      });
    };
    const onResponse = (event) => {
      let data;
      try { data = JSON.parse(event.detail); } catch (_) { return; }
      if (!data || data.id !== id) return;
      finish(data.qualities || []);
    };
    const timer = setTimeout(() => finish([]), 10000);
    document.addEventListener(QUALITIES, onResponse, true);
    try {
      document.dispatchEvent(new CustomEvent(GET_QUALITIES, { detail: JSON.stringify({ id, pageUrl: location.href }) }));
    } catch (_) {
      finish([]);
    }
  }

  function closeModal() {
    modal.hidden = true;
    integratingScanId = '';
    scanLoading = false;
    if (deepScanTimer) clearTimeout(deepScanTimer);
    if (capturePollTimer) clearInterval(capturePollTimer);
    grid.querySelectorAll('.vi-thumb, video').forEach((el) => {
      try { el.pause && el.pause(); } catch (_) {}
    });
    currentItems = [];
    boxes.replaceChildren();
    tip.style.display = 'none';
  }

  function buildItem(item, index) {
    const video = item.el;
    const src = item.src || videoSrc(video);
    const size = item.resourceSize || sizeCache.get(src) || 0;
    return {
      index,
      el: video,
      ox: item.ox,
      oy: item.oy,
      label: item.label || (video ? describe(video) : '视频资源'),
      customTitle: '',
      selected: true,
      src,
      poster: video ? (video.poster || '') : (item.poster || ''),
      duration: video ? formatDuration(video.duration) : '-',
      resolution: video && video.videoWidth && video.videoHeight ? video.videoWidth + '×' + video.videoHeight : '-',
      sizeText: formatSize(size),
      paused: video ? video.paused : true,
      currentTime: video ? (video.currentTime || 0) : 0,
      isResource: !video,
      resourceId: item.resourceId || '',
      resourceType: item.resourceType || '',
      resourceSize: item.resourceSize || 0
    };
  }

  function renderGrid() {
    grid.replaceChildren();
    grid.classList.toggle('vi-list-mode', scanMode === 'deep');

    if (!currentItems.length) {
      const empty = document.createElement('div');
      empty.className = 'vi-empty';
      const title = document.createElement('strong');
      title.textContent = t('emptyTitle');
      const desc = document.createElement('div');
      desc.textContent = t('emptyDesc');
      empty.append(title, desc);
      grid.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    if (scanMode === 'deep') {
      const header = document.createElement('div');
      header.className = 'vi-list-header';
      ['', '#', t('customTitle'), t('metaDuration'), t('metaResolution'), t('metaSize'), t('source'), t('download')].forEach((label) => {
        const cell = document.createElement('span');
        cell.textContent = label;
        header.appendChild(cell);
      });
      frag.appendChild(header);
    }
    currentItems.forEach((item) => frag.appendChild(scanMode === 'deep' ? createListRow(item) : createCard(item)));
    grid.appendChild(frag);
  }

  function listCell(className, text, strong) {
    const cell = document.createElement('div');
    cell.className = 'vi-list-cell' + (strong ? ' strong' : '') + (className ? ' ' + className : '');
    cell.textContent = text;
    cell.title = text;
    return cell;
  }

  function createListRow(item) {
    const row = document.createElement('article');
    row.className = 'vi-list-row';
    if (item.hasSize && item.hasResolution) row.classList.add('vi-row-complete');
    row.setAttribute('data-index', String(item.index));
    const key = itemKey(item);
    const task = downloadTasks.get(key);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'vi-list-check';
    check.checked = !!item.selected;
    check.title = t('selectAll');
    check.addEventListener('change', () => {
      item.selected = check.checked;
      if (selectAll) selectAll.checked = currentItems.length > 0 && currentItems.every((i) => i.selected);
    });
    row.appendChild(check);

    const index = document.createElement('span');
    index.className = 'vi-list-index';
    index.textContent = '#' + (item.index + 1);
    row.appendChild(index);

    const titleCell = document.createElement('div');
    titleCell.className = 'vi-list-title-cell';
    const titleText = item.label || (item.isResource ? t('resourcePreview') : 'video');
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'vi-list-title-input';
    titleInput.placeholder = t('customTitlePlaceholder');
    titleInput.value = item.customTitle || titleText;
    titleInput.title = titleText;
    titleInput.setAttribute('data-index', String(item.index));
    titleInput.addEventListener('input', () => { item.customTitle = titleInput.value; });
    titleCell.appendChild(titleInput);
    row.appendChild(titleCell);

    row.appendChild(listCell('', item.duration, item.hasDuration));
    row.appendChild(listCell('', item.resolution, item.hasResolution));
    row.appendChild(listCell('', item.sizeText, item.hasSize));
    row.appendChild(listCell('', '发现 · ' + (item.discoverySource || 'scan'), false));

    const actions = document.createElement('div');
    actions.className = 'vi-list-actions';
    const downloadBtn = makeButton(t('download'), 'download', item.index, 'primary');
    if (task && task.phase === 'downloading') {
      setButtonLoading(downloadBtn, true, t('downloading'));
    } else if (task && task.phase === 'done') {
      downloadBtn.textContent = t('downloadDone');
    } else if (task && (task.phase === 'failed' || task.phase === 'cancelled')) {
      downloadBtn.textContent = t('downloadFailed');
      downloadBtn.title = task.lastError || '';
    }
    actions.appendChild(downloadBtn);
    row.appendChild(actions);

    return row;
  }

  function createCard(item) {
    const card = document.createElement('article');
    card.className = 'vi-card';
    card.setAttribute('data-index', String(item.index));
    const key = itemKey(item);
    const task = downloadTasks.get(key);

    const media = document.createElement('div');
    media.className = 'vi-media';
    const preview = createPreview(item);
    media.appendChild(preview);

    const index = document.createElement('span');
    index.className = 'vi-index';
    index.textContent = '#' + (item.index + 1);
    media.appendChild(index);

    const check = document.createElement('label');
    check.className = 'vi-card-check';
    const checkBox = document.createElement('input');
    checkBox.type = 'checkbox';
    checkBox.checked = !!item.selected;
    checkBox.addEventListener('change', () => {
      item.selected = checkBox.checked;
      const all = currentItems.length > 0 && currentItems.every((i) => i.selected);
      selectAll.checked = all;
    });
    check.appendChild(checkBox);
    media.appendChild(check);

    const info = document.createElement('div');
    info.className = 'vi-info';
    const infoTitle = document.createElement('div');
    infoTitle.className = 'vi-info-title';
    infoTitle.textContent = item.label || (item.isResource ? t('resourcePreview') : 'video');
    infoTitle.title = infoTitle.textContent;
    info.appendChild(infoTitle);

    const meta = document.createElement('div');
    meta.className = 'vi-meta';
    [
      t('metaDuration') + ' ' + item.duration,
      t('metaResolution') + ' ' + item.resolution,
      t('metaSize') + ' ' + item.sizeText
    ].forEach((text, metaIndex) => {
      const chip = document.createElement('span');
      chip.className = 'vi-chip' + (metaIndex === 2 ? ' vi-size' : '');
      chip.textContent = text;
      meta.appendChild(chip);
    });
    if (item.discovered) {
      const sourceChip = document.createElement('span');
      sourceChip.className = 'vi-chip';
      sourceChip.textContent = '发现 · ' + (item.discoverySource || 'scan');
      meta.appendChild(sourceChip);
    }
    if (task && task.phase === 'done') {
      const doneChip = document.createElement('span');
      doneChip.className = 'vi-chip done';
      doneChip.textContent = '✓ ' + t('completed');
      meta.appendChild(doneChip);
    }
    info.appendChild(meta);
    media.appendChild(info);

    const body = document.createElement('div');
    body.className = 'vi-body';

    const titleRow = document.createElement('label');
    titleRow.className = 'vi-title-field';
    const titleLabel = document.createElement('span');
    titleLabel.className = 'vi-title-label';
    titleLabel.textContent = t('customTitle');
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'vi-title-input';
    titleInput.placeholder = t('customTitlePlaceholder');
    titleInput.value = item.customTitle || '';
    titleInput.setAttribute('data-index', String(item.index));
    titleInput.addEventListener('input', () => {
      item.customTitle = titleInput.value;
    });
    titleRow.append(titleLabel, titleInput);

    const actions = document.createElement('div');
    actions.className = 'vi-card-actions';
    const downloadBtn = makeButton(t('download'), 'download', item.index, 'primary vi-card-download');
    if (task && task.phase === 'downloading') {
      setButtonLoading(downloadBtn, true, t('downloading'));
    } else if (task && task.phase === 'done') {
      downloadBtn.textContent = t('downloadDone');
    } else if (task && (task.phase === 'failed' || task.phase === 'cancelled')) {
      downloadBtn.textContent = t('downloadFailed');
      downloadBtn.title = task.lastError || '';
    }
    actions.appendChild(downloadBtn);

    const row = document.createElement('div');
    row.className = 'vi-card-row';
    row.append(titleRow, actions);
    body.appendChild(row);

    card.append(media, body);
    return card;
  }

  function makeButton(text, action, index, extra) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vi-btn ' + (extra || '');
    button.textContent = text;
    button.setAttribute('data-action', action);
    button.setAttribute('data-index', String(index));
    return button;
  }

  function makePlaceholder(text) {
    const placeholder = document.createElement('div');
    placeholder.className = 'vi-ph';
    const icon = document.createElement('span');
    icon.className = 'vi-ph-icon';
    icon.textContent = '▶';
    const label = document.createElement('span');
    label.textContent = text;
    placeholder.append(icon, label);
    return placeholder;
  }

  function frameFromVideo(video) {
    try {
      if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 480 / video.videoWidth);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch (_) {
      return null;
    }
  }

  function createPreview(item) {
    const frame = frameFromVideo(item.el) || item.poster;
    if (frame) {
      const image = document.createElement('img');
      image.className = 'vi-thumb';
      image.src = frame;
      image.alt = item.label;
      return image;
    }
    const placeholder = makePlaceholder(item.isResource ? (t('resourcePreview') || item.label.slice(0, 20)) : t('previewUnavailable'));
    if (item.label && /音频|audio/i.test(item.label)) {
      const icon = placeholder.querySelector('.vi-ph-icon');
      if (icon) icon.textContent = '♫';
    }
    return placeholder;
  }

  function candidateUrls(item) {
    const video = item.el;
    const candidates = [];
    const add = (value) => {
      if (value && !candidates.includes(value)) candidates.push(value);
    };

    // 只取「当前这个 video 元素」自身对应的地址，避免多视频页面串台。
    if (video) {
      add(video.currentSrc);
      add(video.src);
      try {
        Array.from(video.querySelectorAll('source')).forEach((source) => {
          add(source.src || source.getAttribute('src'));
        });
      } catch (_) {}
    }
    add(item.src);

    // 只有当整页仅有一个视频时，才用资源记录里的地址补全。
    // 多视频页面（如 TikTok 信息流）里资源记录无法可靠对应到具体 video，
    // 盲目取第一个会导致一直下载同一个视频，因此这种情况下不使用，改由录制兜底。
    try {
      const root = document.body || document.documentElement;
      const videoCount = (root.querySelectorAll ? root.querySelectorAll('video').length : 0)
        + (root.shadowRoot ? root.shadowRoot.querySelectorAll('video').length : 0);
      if (videoCount <= 1) {
        const isVideoFile = /(\.mp4|\.webm|\.m4v)(\?|$)|(\/video\/tos\/)|(\/video\/mp4\/)|(v\d+-webapp[^/]*\/video\/)/i;
        const entries = performance.getEntriesByType('resource') || [];
        entries.forEach((entry) => {
          const url = entry.name || '';
          if (/^https?:\/\//i.test(url) && isVideoFile.test(url)) add(url);
        });
      }
    } catch (_) {}

    return candidates;
  }

  function fileName(item, forceExt) {
    const raw = (item.customTitle || '').trim();
    const base = String(raw).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
    if (forceExt) return base + '.' + forceExt;
    const format = formatSelect ? formatSelect.value : 'mp4';
    let ext;
    if (format === 'mp4') ext = 'mp4';
    else if (format === 'webm') ext = 'webm';
    else {
      const first = candidateUrls(item)[0] || '';
      const match = first.split('?')[0].match(/\.(mp4|webm|ogv|mov|m4v|mkv|avi|flv)$/i);
      ext = match ? match[1].toLowerCase() : (/webm/i.test(first) ? 'webm' : 'mp4');
    }
    return base + '.' + ext;
  }

  // 断点续传的稳定标识：只用 origin+pathname，避免签名参数变化导致对不上任务
  function jobKeyOf(item) {
    const raw = (item && (item.src || (item.el && item.el.currentSrc))) || '';
    try {
      const u = new URL(raw, location.href);
      if (/^https?:$/.test(u.protocol)) return u.origin + u.pathname;
    } catch (_) {}
    return '';
  }

  function resumeKeyOf(item) {
    return jobKeyOf(item) || String(fileName(item)).replace(/\.[^.]+$/, '');
  }

  function requestDownload(url, filename, onProgress, task, options) {
    const id = 'vi-' + (++downloadSeq);
    if (task) task.id = id;
    options = options || {};
    return new Promise((resolve) => {
      if (task && task.cancelled) {
        resolve({ ok: false, error: 'cancelled' });
        return;
      }
      let settled = false;
      let stallTimer = 0;
      let maxTimer = 0;
      const cancelRequest = () => {
        try {
          document.dispatchEvent(new CustomEvent(DL_CANCEL, { detail: JSON.stringify({ id }) }));
        } catch (_) {}
      };
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        clearTimeout(maxTimer);
        document.removeEventListener(DL_RESPONSE, onResponse, true);
        document.removeEventListener(DL_PROGRESS, onProgressEvent, true);
        resolve(value);
      };
      const resetStallTimer = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          cancelRequest();
          finish({ ok: false, error: 'stalled' });
        }, DOWNLOAD_STALL_TIMEOUT);
      };
      const onResponse = (event) => {
        let data;
        try { data = JSON.parse(event.detail); } catch (_) { return; }
        if (data && data.id === id) finish(data);
      };
      const onProgressEvent = (event) => {
        let data;
        try { data = JSON.parse(event.detail); } catch (_) { return; }
        if (!data || data.id !== id) return;
        if (onProgress && typeof data.percent === 'number') onProgress(data.percent, data.phase, data);
        if (data.phase === 'verifying') clearTimeout(stallTimer);
        else resetStallTimer();
      };
      document.addEventListener(DL_RESPONSE, onResponse, true);
      document.addEventListener(DL_PROGRESS, onProgressEvent, true);
      resetStallTimer();
      maxTimer = setTimeout(() => {
        cancelRequest();
        finish({ ok: false, error: 'timeout' });
      }, DOWNLOAD_MAX_DURATION);
      try {
        const detail = { id, url, filename };
        if (options.duration) detail.expectedDuration = options.duration;
        if (options.size) detail.expectedSize = options.size;
        if (options.kind) detail.forceKind = options.kind;
        if (options.videoUrl) detail.videoUrl = options.videoUrl;
        if (options.audioUrl) detail.audioUrl = options.audioUrl;
        if (options.pageUrl) detail.pageUrl = options.pageUrl;
        if (options.jobKey) detail.jobKey = options.jobKey;
        if (qualitySelect && qualitySelect.value) detail.qualityId = qualitySelect.value;
        document.dispatchEvent(new CustomEvent(DL_REQUEST, { detail: JSON.stringify(detail) }));
      } catch (_) {
        finish({ ok: false, error: 'dispatch failed' });
      }
    });
  }

  // ===== 下载队列：最多 2 个并发，其余排队，批量下载有整体状态 =====
  const MAX_CONCURRENT_DOWNLOADS = 2;
  const downloadQueue = [];
  const resumeJobs = new Map();
  let refreshTimer = 0;

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = 0;
      refreshDownloadButtons();
    }, 200);
  }

  function activeDownloadCount() {
    let count = 0;
    downloadTasks.forEach((t) => { if (t.phase === 'downloading') count++; });
    return count;
  }

  function runTask(task) {
    if (!task || task.cancelled) return;
    task.phase = 'downloading';
    refreshDownloadButtons();
    downloadItem(task.item, (percent, phase, data) => {
      if (typeof percent === 'number') task.percent = percent;
      if (data) {
        if (typeof data.loaded === 'number') task.loaded = data.loaded;
        if (typeof data.total === 'number' && data.total > 0) task.total = data.total;
      }
      if (phase && task.phaseText !== phase) task.phaseText = phase;
      scheduleRefresh();
    }, task).then((ok) => {
      task.phase = ok ? 'done' : (task.cancelled ? 'paused' : 'failed');
      task.phaseText = '';
      if (task.phase === 'done') {
        task.percent = 100;
        resumeJobs.delete(resumeKeyOf(task.item));
      }
      refreshDownloadButtons();
      pumpQueue();
    }).catch(() => {
      task.phase = 'failed';
      task.phaseText = '';
      refreshDownloadButtons();
      pumpQueue();
    });
  }

  function pumpQueue() {
    while (downloadQueue.length && activeDownloadCount() < MAX_CONCURRENT_DOWNLOADS) {
      const next = downloadQueue.shift();
      if (!next || next.cancelled) continue;
      runTask(next);
    }
  }

  function startDownload(item) {
    if (!item) return null;
    const key = itemKey(item);
    const prev = downloadTasks.get(key);
    if (prev && (prev.phase === 'downloading' || prev.phase === 'queued')) return prev;

    const baseName = String(fileName(item)).replace(/\.[^.]+$/, '');
    const job = resumeJobs.get(jobKeyOf(item) || baseName);
    const startPercent = (prev && prev.phase === 'paused' && prev.percent) || (job ? job.percent : 0);
    const task = {
      cancelled: false,
      id: null,
      phase: 'queued',
      item,
      phaseText: '',
      lastError: '',
      percent: startPercent,
      loaded: (prev && prev.phase === 'paused' && prev.loaded) || (job ? job.size || 0 : 0),
      total: (prev && prev.phase === 'paused' && prev.total) || 0
    };
    downloadTasks.set(key, task);
    downloadQueue.push(task);
    refreshDownloadButtons();
    pumpQueue();
    return task;
  }

  function pauseAllDownloads() {
    downloadTasks.forEach((task) => {
      if (task.phase === 'downloading') {
        task.cancelled = true;
        task.phase = 'paused';
        if (task.id) {
          try { document.dispatchEvent(new CustomEvent(DL_CANCEL, { detail: JSON.stringify({ id: task.id }) })); } catch (_) {}
        }
      } else if (task.phase === 'queued') {
        task.cancelled = true;
        task.phase = 'paused';
      }
    });
    pumpQueue();
    refreshDownloadButtons();
  }

  function retryFailedDownloads() {
    const retry = [];
    downloadTasks.forEach((task) => {
      if (task.phase === 'failed') retry.push(task);
    });
    retry.forEach((task) => {
      task.cancelled = false;
      task.phase = 'queued';
      task.lastError = '';
      task.phaseText = '';
      downloadQueue.push(task);
    });
    pumpQueue();
    refreshDownloadButtons();
  }

  function clearFinishedDownloads() {
    downloadTasks.forEach((task, key) => {
      if (task.phase === 'done') downloadTasks.delete(key);
    });
    refreshDownloadButtons();
  }

  function renderDownloadSummary() {
    const bar = shadow.querySelector('.vi-dlbar');
    if (!bar) return;
    const tasks = Array.from(downloadTasks.values());
    if (!tasks.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const counts = { done: 0, failed: 0, active: 0, queued: 0, paused: 0 };
    let loaded = 0;
    let total = 0;
    tasks.forEach((task) => {
      if (task.phase === 'done') counts.done++;
      else if (task.phase === 'failed') counts.failed++;
      else if (task.phase === 'queued') counts.queued++;
      else if (task.phase === 'paused') counts.paused++;
      else counts.active++;
      loaded += task.loaded || 0;
      total += task.total || 0;
    });
    // 暂停中的任务也计入“未完成”，进度条按字节优先、否则按完成条数
    const percent = total > 0
      ? Math.round((loaded / total) * 100)
      : Math.round((counts.done / tasks.length) * 100);
    const fill = bar.querySelector('.vi-dlbar-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
    const text = bar.querySelector('.vi-dlbar-text');
    if (text) {
      text.textContent = t('dlStats', {
        done: counts.done,
        total: tasks.length,
        active: counts.active,
        queued: counts.queued,
        failed: counts.failed
      }) + (counts.paused ? ' · ' + t('pausedCount', { count: counts.paused }) : '');
    }
  }

  function refreshDownloadButtons() {
    if (!currentItems || !currentItems.length) {
      renderDownloadSummary();
      return;
    }
    currentItems.forEach((item) => {
      const task = downloadTasks.get(itemKey(item));
      const card = shadow.querySelector('.vi-card[data-index="' + item.index + '"]');
      if (!card) return;
      const button = card.querySelector('[data-action="download"]');
      if (button) {
        if (task && task.phase === 'downloading') {
          const phaseKey = task.phaseText === 'merging' ? 'phaseMerging'
            : task.phaseText === 'verifying' ? 'phaseVerifying'
            : task.phaseText === 'resolving' ? 'phaseResolving' : null;
          const label = phaseKey
            ? t(phaseKey)
            : t('downloading') + (task.percent ? ' ' + task.percent + '%' : '');
          setButtonLoading(button, true, label);
        } else {
          setButtonLoading(button, false);
          if (task && task.phase === 'done') button.textContent = t('downloadDone');
          else if (task && task.phase === 'queued') button.textContent = t('queuedText');
          else if (task && task.phase === 'paused') {
            button.textContent = t('resumeText', { percent: task.percent || 0 });
          } else if (task && task.phase === 'failed') {
            button.textContent = t('downloadFailed');
            button.title = task.lastError || '';
          } else if (!task) {
            const job = resumeJobs.get(resumeKeyOf(item));
            button.textContent = job ? t('resumeText', { percent: job.percent }) : t('download');
          }
        }
      }
      syncDoneBadge(card, !!(task && task.phase === 'done'));
    });
    const allButton = shadow.querySelector('[data-action="download-all"]');
    if (allButton) {
      let active = 0;
      downloadTasks.forEach((t) => { if (t.phase === 'downloading') active++; });
      if (active > 0) setButtonLoading(allButton, true, t('downloading'));
      else setButtonLoading(allButton, false);
    }
    renderDownloadSummary();
  }

  function downloadCapturedResource(item, task, forceExt) {
    return new Promise((resolve) => {
      const id = 'vi-res-' + (++downloadSeq);
      if (task) task.id = id;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener(DL_RESPONSE, onResponse, true);
        clearTimeout(timer);
        resolve(value);
      };
      const onResponse = (event) => {
        let data;
        try { data = JSON.parse(event.detail); } catch (_) { return; }
        if (data && data.id === id) finish(data);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), 120000);
      document.addEventListener(DL_RESPONSE, onResponse, true);
      try {
        document.dispatchEvent(new CustomEvent(DOWNLOAD_RESOURCE, {
          detail: JSON.stringify({
            id: item.resourceId,
            requestId: id,
            filename: fileName(item, forceExt),
            expectedDuration: item.el && Number.isFinite(item.el.duration) ? item.el.duration : 0
          })
        }));
      } catch (_) {
        finish({ ok: false, error: 'dispatch failed' });
      }
    });
  }

  function buildCandidates(item) {
    const candidates = [];
    const seen = new Set();
    const add = (candidate) => {
      if (!candidate) return;
      const key = candidate.kind && candidate.url ? candidate.kind + ':' + candidate.url : (candidate.url || candidate.resourceId);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    };

    if (item && item.discovered) {
      // 发现的资源：按其自身类型下载，不用当前页面 URL 做平台解析（会串台）。
      if (item.audioUrl && item.videoUrl) {
        add({ kind: 'streams', url: item.videoUrl, videoUrl: item.videoUrl, audioUrl: item.audioUrl });
      } else if (item.resourceKind === 'hls') {
        add({ kind: 'hls', url: item.src });
      } else if (item.resourceKind === 'dash') {
        add({ kind: 'dash', url: item.src });
      } else if (item.resourceKind === 'platform') {
        add({ kind: 'platform', url: item.src, pageUrl: item.src });
      } else if (item.src) {
        add({ url: item.src });
      }
      return candidates;
    }

    // 0. 平台解析（B站/抖音主动调接口），最高优先级。
    add({ kind: 'platform', url: (item && item.src) || location.href });

    // 1. B站/通用 DASH 双流（playurl 解析）——完整音视频，优先下载。
    (capturedResources ? Array.from(capturedResources.values()) : []).forEach((res) => {
      if (!res) return;
      if (res.kind === 'streams' && res.videoUrl) {
        add({ kind: 'streams', url: res.url, videoUrl: res.videoUrl, audioUrl: res.audioUrl || '' });
      }
    });

    // 2. 嗅探到的 m3u8/mpd 清单。
    (capturedResources ? Array.from(capturedResources.values()) : []).forEach((res) => {
      if (!res || !res.url) return;
      if (/\.m3u8(\?|#|$)/i.test(res.url)) add({ kind: 'hls', url: res.url });
      else if (/\.mpd(\?|#|$)/i.test(res.url)) add({ kind: 'dash', url: res.url });
    });

    // 2. video 元素自身的可下载源。
    candidateUrls(item).forEach((url) => {
      if (/^blob:/i.test(url) || /^mse:/i.test(url)) return;
      add({ url });
    });

    // 3. 捕获到的真实网络资源（由引擎校验完整性后才保存）。
    if (item.resourceId) add({ resourceId: item.resourceId });

    return candidates;
  }

  async function downloadItem(item, onProgress, task) {
    if (task && task.cancelled) return false;
    const filename = fileName(item);
    const video = item.el;
    const duration = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const candidates = buildCandidates(item);
    const errors = [];

    for (const candidate of candidates) {
      if (task && task.cancelled) return false;

      let result;
      if (candidate.resourceId) {
        result = await downloadCapturedResource(item, task);
      } else {
        result = await requestDownload(candidate.url, filename, onProgress, task, {
          duration,
          kind: candidate.kind || '',
          videoUrl: candidate.videoUrl || '',
          audioUrl: candidate.audioUrl || '',
          pageUrl: candidate.pageUrl || location.href,
          jobKey: jobKeyOf(item)
        });
      }
      if (task && task.cancelled) return false;
      if (result && result.ok) {
        if (result.size) applyDownloadedSize(item, result.size);
        return true;
      }
      if (result && result.error && result.error) errors.push(result.error);
    }

    if (task) task.lastError = errors[errors.length - 1] || t('errorNoSource');
    return false;
  }

  function onShadowClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target === modal) {
      closeModal();
      return;
    }

    const actionEl = target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.getAttribute('data-action');
    const index = Number(actionEl.getAttribute('data-index'));

    if (action === 'close') closeModal();
    else if (action === 'feedback') window.open(FEEDBACK_URL, '_blank', 'noopener,noreferrer');
    else if (action === 'refresh' || action === 'search') runSearch();
    else if (action === 'download-all') {
      currentItems.filter((item) => item.selected).forEach((item) => startDownload(item));
    } else if (action === 'dl-pause') {
      pauseAllDownloads();
    } else if (action === 'dl-retry') {
      retryFailedDownloads();
    } else if (action === 'dl-clear') {
      clearFinishedDownloads();
    } else if (action === 'download') {
      const item = currentItems[index];
      if (item) startDownload(item);
    } else if (action === 'copy-all') {
      copyText(currentItems.filter((item) => item.selected).map((item) => item.src).filter(Boolean).join('\n'));
      flashButton(actionEl, t('copied'));
    } else if (action === 'copy') {
      const item = currentItems[index];
      if (item) copyText(item.src);
      flashButton(actionEl, t('copied'));
    }
  }

  function setButtonLoading(button, loading, loadingText) {
    if (!button || !button.isConnected) return;
    if (button.dataset.viOriginalText === undefined) button.dataset.viOriginalText = button.textContent;
    if (loading) {
      button.classList.add('vi-loading');
      button.disabled = true;
      button.replaceChildren();
      const spinner = document.createElement('span');
      spinner.className = 'vi-spinner';
      const label = document.createElement('span');
      label.textContent = loadingText || t('downloading');
      button.append(spinner, label);
    } else {
      button.classList.remove('vi-loading');
      button.disabled = false;
      const original = button.dataset.viOriginalText;
      delete button.dataset.viOriginalText;
      button.textContent = original !== undefined ? original : t('download');
    }
  }

  function flashButton(button, text) {
    const old = button.textContent;
    button.textContent = text;
    setTimeout(() => {
      if (button.isConnected) button.textContent = old;
    }, 1200);
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    shadow.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (_) {}
    area.remove();
  }

  function hitTest(doc, x, y, offsetX = 0, offsetY = 0, depth = 0) {
    if (depth > MAX_DEPTH || !doc || !isReadable(doc)) return null;
    let el;
    try { el = doc.elementFromPoint(x, y); } catch (_) { return null; }
    if (!el) return null;

    if (el.tagName === 'IFRAME') {
      let inner = null;
      try { inner = el.contentDocument; } catch (_) {}
      if (inner && isReadable(inner)) {
        const rect = el.getBoundingClientRect();
        const nx = x - rect.left;
        const ny = y - rect.top;
        if (nx >= 0 && ny >= 0 && nx <= rect.width && ny <= rect.height) {
          const found = hitTest(inner, nx, ny, offsetX + rect.left, offsetY + rect.top, depth + 1);
          if (found) return found;
        }
      }
    }

    if (el.shadowRoot) {
      let shadowEl = null;
      try { shadowEl = el.shadowRoot.elementFromPoint(x, y); } catch (_) {}
      if (shadowEl && shadowEl !== el) return makeHit(shadowEl, doc, offsetX, offsetY);
    }

    return makeHit(el, doc, offsetX, offsetY);
  }

  function makeHit(el, doc, offsetX, offsetY) {
    const rect = el.getBoundingClientRect();
    return {
      el,
      doc,
      rect: {
        left: rect.left + offsetX,
        top: rect.top + offsetY,
        width: rect.width,
        height: rect.height
      }
    };
  }

  function collectVideos(node, offsetX, offsetY, depth, out = [], seen = new Set(), maxDepth = MAX_DEPTH) {
    if (!node || depth > maxDepth || seen.has(node)) return out;
    seen.add(node);

    if (node.nodeType === 1) {
      if (node.tagName === 'VIDEO') {
        if (videoHasSource(node)) out.push({ el: node, ox: offsetX, oy: offsetY });
        return out;
      }
      if (node.tagName === 'IFRAME') {
        let doc = null;
        try { doc = node.contentDocument; } catch (_) {}
        if (doc && doc.documentElement) {
          const rect = node.getBoundingClientRect();
          collectVideos(doc.documentElement, offsetX + rect.left, offsetY + rect.top, depth + 1, out, seen, maxDepth);
        }
        return out;
      }
      if (node.shadowRoot) {
        collectVideos(node.shadowRoot, offsetX, offsetY, depth + 1, out, seen, maxDepth);
      }
    }

    let children = [];
    try { children = node.querySelectorAll ? Array.from(node.querySelectorAll('*')) : []; } catch (_) {}
    for (const child of children) {
      if (seen.has(child)) continue;
      if (child.tagName === 'VIDEO') {
        if (videoHasSource(child)) out.push({ el: child, ox: offsetX, oy: offsetY });
        continue;
      }
      if (child.shadowRoot) {
        collectVideos(child.shadowRoot, offsetX, offsetY, depth + 1, out, seen, maxDepth);
      }
      if (child.tagName === 'IFRAME') {
        let doc = null;
        try { doc = child.contentDocument; } catch (_) {}
        if (doc && doc.documentElement) {
          const rect = child.getBoundingClientRect();
          collectVideos(doc.documentElement, offsetX + rect.left, offsetY + rect.top, depth + 1, out, seen, maxDepth);
        }
      }
    }
    return out;
  }

  function isMediaResourceUrl(url) {
    if (!/^https?:\/\//i.test(url)) return false;
    const videoRe = /(\.mp4|\.webm|\.m4v|\.ogv|\.mov|\.mkv|\.avi|\.flv|\.m3u8|\.mpd)(\?|#|$)/i;
    return videoRe.test(url)
      || /\/video\/|\/videos\/|videoplayback|v\d+-webapp[^/]*\/video\/|bilivideo|upos-sz|upos-hz/i.test(url);
  }

  function scanVideoResources(existing) {
    const out = [];
    const seen = new Set(existing.filter(Boolean));
    const LIMIT = 300;

    const add = (raw) => {
      if (out.length >= LIMIT || !raw) return;
      let url = String(raw).trim().replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
      if (url.startsWith('//')) url = location.protocol + url;
      else if (url.startsWith('/')) url = location.origin + url;
      else if (!/^https?:\/\//i.test(url)) {
        try { url = new URL(url, location.href).href; } catch (_) { return; }
      }
      try { url = new URL(url, location.href).href; } catch (_) { return; }
      if (seen.has(url) || !isMediaResourceUrl(url)) return;
      seen.add(url);
      let name;
      try { name = decodeURIComponent(url.split('?')[0].split('/').pop()) || '媒体资源'; } catch (_) { name = '媒体资源'; }
      out.push({ src: url, label: '资源 · ' + name.slice(0, 40) });
    };

    try {
      (performance.getEntriesByType('resource') || []).forEach((entry) => add(entry.name));
    } catch (_) {}

    try {
      const docs = [document];
      document.querySelectorAll('iframe').forEach((frame) => {
        try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch (_) {}
      });
      docs.forEach((doc) => {
        (doc.querySelectorAll('*') || []).forEach((el) => {
          ['src', 'data-src', 'data-url', 'data-video', 'poster', 'srcset', 'content'].forEach((attr) => {
            const value = el.getAttribute && el.getAttribute(attr);
            if (!value) return;
            if (attr === 'srcset') {
              value.split(',').forEach((part) => add(part.trim().split(/\s+/)[0]));
            } else {
              add(value);
            }
          });
        });
        (doc.querySelectorAll('script:not([src])') || []).forEach((script) => {
          const text = script.textContent || '';
          const matches = text.match(/https?:\\?\/\\?\/[^\s"'<>`]+/g) || [];
          matches.forEach((match) => add(match.replace(/\\\//g, '/')));
        });
      });
    } catch (_) {}

    return out;
  }

  function applyCapturedResources(items) {
    if (!Array.isArray(items) || !items.length) return;
    if (!modal || modal.hidden) return;

    items.forEach((res) => {
      if (!res || !res.id) return;
      capturedResources.set(res.id, res);
      const keys = [res.matchUrl, res.url].filter((key) => typeof key === 'string' && key);
      keys.forEach((key) => {
        const prev = capturedByUrl.get(key);
        if (!prev || (Number(res.size) || 0) > (Number(prev.size) || 0)) capturedByUrl.set(key, res);
      });
    });

    currentItems.forEach((item) => {
      const src = item.src;
      if (!src) return;
      const res = capturedByUrl.get(src);
      if (!res || item.resourceId === res.id) return;
      item.resourceId = res.id;
      item.resourceType = res.type || '';
      item.resourceSize = Number(res.size) || 0;
      item.sizeText = formatSize(item.resourceSize);
      const card = shadow.querySelector('.vi-card[data-index="' + item.index + '"]');
      if (card) {
        const chip = card.querySelector('.vi-size');
        if (chip) chip.textContent = t('metaSize') + ' ' + item.sizeText;
      }
    });

    // 只为页面上真实存在的 video 补充资源信息，不再凭空生成嗅探卡片。
    // 之前这里会不断追加无对应元素的 blob/MSE，表现为“空白视频越来越多”。
  }

  function applyDownloadedSize(item, size) {
    if (!item || !Number.isFinite(size) || size <= 0) return;
    item.resourceSize = size;
    item.sizeText = formatSize(size);
    const card = shadow.querySelector('.vi-card[data-index="' + item.index + '"]');
    if (!card) return;
    const chip = card.querySelector('.vi-size');
    if (chip) chip.textContent = t('metaSize') + ' ' + item.sizeText;
  }

  function videoHasSource(video) {
    if (!video) return false;
    try {
      if (video.currentSrc || video.src) return true;
      return Array.from(video.querySelectorAll('source')).some((source) => source.src || source.getAttribute('src'));
    } catch (_) {
      return false;
    }
  }

  function videoSrc(video) {
    if (video.currentSrc) return video.currentSrc;
    if (video.src) return video.src;
    const sources = Array.from(video.querySelectorAll('source'))
      .map((source) => source.src || source.getAttribute('src'))
      .filter(Boolean);
    return sources.length ? sources.join(', ') : '';
  }

  function formatDuration(value) {
    if (!Number.isFinite(value) || value <= 0) return '-';
    const m = Math.floor(value / 60);
    const s = Math.floor(value % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '-';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
    return bytes + ' B';
  }

  function requestSize(url) {
    if (sizeCache.has(url)) return Promise.resolve(sizeCache.get(url));
    const id = 'vi-size-' + (++sizeSeq);
    return new Promise((resolve) => {
      let timer = 0;
      const finish = (size) => {
        clearTimeout(timer);
        document.removeEventListener(PROBE_SIZE_RESPONSE, onResponse, true);
        sizeCache.set(url, size);
        resolve(size);
      };
      const onResponse = (event) => {
        let data;
        try { data = JSON.parse(event.detail); } catch (_) { return; }
        if (data && data.id === id) finish(Number(data.size) || 0);
      };
      document.addEventListener(PROBE_SIZE_RESPONSE, onResponse, true);
      timer = setTimeout(() => finish(0), 12000);
      try {
        document.dispatchEvent(new CustomEvent(PROBE_SIZE, { detail: JSON.stringify({ id, url }) }));
      } catch (_) {
        finish(0);
      }
    });
  }

  function loadSizes() {
    currentItems.forEach((item) => {
      if (item.sizeText && item.sizeText !== '-') return;
      const url = item.src;
      if (!url || !/^https?:\/\//i.test(url)) return;
      requestSize(url).then((size) => {
        if (!size && item.sizeText && item.sizeText !== '-') return;
        item.sizeText = formatSize(size);
        const card = shadow.querySelector('.vi-card[data-index="' + item.index + '"]');
        if (!card) return;
        const chip = card.querySelector('.vi-size');
        if (chip) chip.textContent = t('metaSize') + ' ' + item.sizeText;
      });
    });
  }

  function syncDoneBadge(card, done) {
    if (!card) return;
    const meta = card.querySelector('.vi-meta');
    if (!meta) return;
    let chip = meta.querySelector('.vi-chip.done');
    if (done) {
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'vi-chip done';
        chip.textContent = '✓ ' + t('completed');
        meta.appendChild(chip);
      }
    } else if (chip) {
      chip.remove();
    }
  }

  function describe(el) {
    if (!el) return '';
    const tag = (el.tagName || el.nodeName || '').toLowerCase();
    const id = el.id ? '#' + el.id : '';
    let cls = '';
    if (typeof el.className === 'string' && el.className.trim()) {
      cls = '.' + el.className.trim().split(/\s+/).join('.');
    }
    return tag + id + cls;
  }

  function isReadable(doc) {
    try { return Boolean(doc && doc.body); } catch (_) { return false; }
  }

  function isOwnEvent(event) {
    try {
      return Boolean(host && typeof event.composedPath === 'function' && event.composedPath().includes(host));
    } catch (_) {
      return event.target === host;
    }
  }

  function deepestElement(event) {
    try {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const found = path.find((node) => node && node.nodeType === 1);
      if (found) return found;
    } catch (_) {}
    return event.target && event.target.nodeType === 1 ? event.target : null;
  }

  function isTyping(node) {
    if (!node) return false;
    const tag = (node.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' ||
      node.isContentEditable === true || node.getAttribute('contenteditable') === 'true';
  }
})();
