import { t } from '../core/i18n.js';
import { EXT_VERSION, FEEDBACK_URL } from '../core/constants.js';

export const TEMPLATE = `
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
  padding: 18px 40px 16px;
  background: #fff;
  border-bottom: 1px solid #f5f5f7;
  user-select: none;
  -webkit-user-select: none;
}
.vi-title-wrap { flex: 1; min-width: 0; }
/* 小标题作为副标题：去掉主标题后只保留这一行 */
.vi-head h2 { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: .2px; color: #1d1d1f; }
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
/* 下载队列：模态框底部按钮 + 点击展开任务面板 */
.vi-queue-fab {
  position: absolute;
  right: 24px;
  bottom: 12px;
  z-index: 7;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 14px;
  border: 1px solid #e3e5ea;
  border-radius: 14px;
  background: #fff;
  color: #1d1d1f;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background .15s, border-color .15s, color .15s;
}
.vi-queue-fab[hidden] { display: none; }
.vi-queue-fab:hover { border-color: #c9ccd3; }
.vi-queue-fab.active { background: #f2f7ff; border-color: #b9d6ff; color: #007aff; }
.vi-queue-fab-icon { font-size: 13px; line-height: 1; }
.vi-queue-fab-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #f0f1f4;
  color: #6e6e73;
  font-size: 11px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.vi-queue-fab.active .vi-queue-fab-count { background: #007aff; color: #fff; }
.vi-queue-panel {
  position: absolute;
  right: 24px;
  bottom: 64px;
  z-index: 8;
  width: 340px;
  max-width: calc(100% - 48px);
  max-height: 52vh;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: #fff;
  box-shadow: 0 16px 48px rgba(0, 0, 0, .24);
  overflow: hidden;
  font-size: 13px;
  color: #1d1d1f;
}
.vi-queue-panel[hidden] { display: none; }
.vi-queue-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #f0f1f4;
}
.vi-queue-head strong { font-size: 13px; }
.vi-queue-stats { flex: 1; min-width: 0; font-size: 12px; color: #6e6e73; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vi-queue-close {
  flex: none;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #86868b;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.vi-queue-close:hover { background: #f2f2f5; color: #1d1d1f; }
.vi-queue-progress { height: 3px; background: #eceef2; }
.vi-queue-fill { display: block; height: 100%; width: 0; background: #007aff; transition: width .25s; }
.vi-queue-list { flex: 1; overflow: auto; padding: 6px 0; }
.vi-queue-empty { padding: 24px 0; text-align: center; color: #86868b; font-size: 12px; }
.vi-queue-item { padding: 8px 14px; }
.vi-queue-item + .vi-queue-item { border-top: 1px solid #f5f6f8; }
.vi-queue-item-top { display: flex; align-items: center; gap: 10px; }
.vi-queue-name { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vi-queue-state { flex: none; font-size: 11px; color: #6e6e73; }
.vi-queue-state.is-done { color: #1a9c52; }
.vi-queue-state.is-failed { color: #d70015; }
.vi-queue-state.is-active { color: #007aff; }
.vi-queue-cancel {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: #86868b;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.vi-queue-cancel:hover { background: #f0f1f4; color: #d70015; }
.vi-queue-item-bar { margin-top: 6px; height: 4px; border-radius: 2px; background: #eef0f3; overflow: hidden; }
.vi-queue-item-bar i { display: block; height: 100%; width: 0; background: #007aff; transition: width .25s; }
.vi-queue-actions { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid #f0f1f4; }
.vi-queue-actions .vi-btn { flex: 1; padding: 6px 0; font-size: 12px; }
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
  margin-left: auto;
  color: #86868b;
  font-size: 11px;
  white-space: nowrap;
}
/* 队列按钮浮在右下角时，给快捷键提示留出避让空间 */
.vi-footer:has(.vi-queue-fab:not([hidden])) .vi-shortcut-hint { margin-right: 132px; }
.vi-author {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-left: 8px;
  flex: none;
}
.vi-author img { width: 20px; height: 20px; border-radius: 5px; display: block; }
.vi-author-tip {
  position: absolute;
  bottom: calc(100% + 7px);
  left: 50%;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(32, 32, 34, .94);
  color: #fff;
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  opacity: 0;
  transform: translate(-50%, 2px);
  pointer-events: none;
  transition: opacity 140ms ease-out, transform 140ms ease-out;
}
.vi-author-tip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  width: 6px;
  height: 6px;
  background: rgba(32, 32, 34, .94);
  transform: translate(-50%, -3px) rotate(45deg);
  border-radius: 1px;
}
.vi-author:hover .vi-author-tip { opacity: 1; transform: translate(-50%, 0); }
.vi-ver { margin-left: 6px; color: #86868b; font-size: 11px; white-space: nowrap; }

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
      <h2 id="vi-title">${t('kicker')}</h2>
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





  <div class="vi-grid"></div>

  <footer class="vi-footer">
    <a class="vi-author" href="${FEEDBACK_URL}" target="_blank" rel="noopener noreferrer" aria-label="联系作者：吴文龙">
      <img src="${chrome.runtime.getURL('bilibili.png')}" alt="B站" />
      <span class="vi-author-tip">联系作者：吴文龙</span>
    </a>
    <span class="vi-ver">v${EXT_VERSION}</span>
    <span class="vi-shortcut-hint">${t('shortcutHint')}</span>
    <button class="vi-queue-fab" type="button" data-action="queue-toggle" hidden aria-label="${t('queueTitle')}">
      <span class="vi-queue-fab-icon">↓</span>
      <span>${t('queueTitle')}</span>
      <span class="vi-queue-fab-count">0</span>
    </button>
  </footer>

  <div class="vi-queue-panel" hidden>
    <div class="vi-queue-head">
      <strong>${t('queueTitle')}</strong>
      <span class="vi-queue-stats"></span>
      <button class="vi-queue-close" type="button" data-action="queue-close" aria-label="${t('close')}">×</button>
    </div>
    <div class="vi-queue-progress"><span class="vi-queue-fill"></span></div>
    <div class="vi-queue-list"></div>
    <div class="vi-queue-actions">
      <button class="vi-btn" type="button" data-action="dl-pause">${t('pauseAll')}</button>
      <button class="vi-btn" type="button" data-action="dl-retry">${t('retryFailed')}</button>
      <button class="vi-btn" type="button" data-action="dl-clear">${t('clearDone')}</button>
    </div>
  </div>

</div>
</div>
`;