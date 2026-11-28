// 事件名、阈值等全局常量
export const MAX_DEPTH = 12;
export const EXT_VERSION = (() => {
  try { return chrome.runtime.getManifest().version; } catch (_) { return '0.0.0'; }
})();
export const FEEDBACK_URL = 'https://space.bilibili.com/3706965849016893?spm_id_from=333.1007.0.0';
export const PREVIEW_LIMIT = 60;
export const DOWNLOAD_STALL_TIMEOUT = 90000;
export const DOWNLOAD_MAX_DURATION = 30 * 60 * 1000;
export const DL_REQUEST = '__video_inspector_download_request__';
export const DL_RESPONSE = '__video_inspector_download_response__';
export const DL_PROGRESS = '__video_inspector_download_progress__';
export const DL_CANCEL = '__video_inspector_download_cancel__';
export const DL_RESUME_QUERY = '__video_inspector_resume_query__';
export const DL_RESUME_LIST = '__video_inspector_resume_list__';
export const GET_RESOURCES = '__video_inspector_get_resources__';
export const RESOURCES = '__video_inspector_resources__';
export const DOWNLOAD_RESOURCE = '__video_inspector_download_resource__';
export const PROBE_SIZE = '__video_inspector_probe_size__';
export const PROBE_SIZE_RESPONSE = '__video_inspector_probe_size_response__';
export const GET_QUALITIES = '__video_inspector_get_qualities__';
export const QUALITIES = '__video_inspector_qualities__';
export const SCAN_RESOURCES = '__video_inspector_scan_resources__';
export const SCAN_RESULT = '__video_inspector_scan_result__';
export const MUX_REQUEST = '__video_inspector_mux_request__';
export const MUX_RESPONSE = '__video_inspector_mux_response__';
export const MSE_DIRECT_REQUEST = '__video_inspector_mse_direct_request__';
export const MSE_DIRECT_RESPONSE = '__video_inspector_mse_direct_response__';
export const MANIFEST_FOUND = '__video_inspector_manifest_found__';
export const MSE_DIRECT_PROGRESS = '__video_inspector_mse_direct_progress__';
export const CHUNK_BYTES = 512 * 1024;
export const MAX_CONCURRENT_DOWNLOADS = 1;
