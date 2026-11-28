// 共享可变状态。
// 约定：读取直接 import（ESM live binding），写入统一走 setXxx；
// 集合类（Map/Set/数组）只做原地修改，不整体赋值。

export let cache = new WeakMap();
export let active = false;
export let rafId = 0;
export let mouse = { x: 0, y: 0 };
export let lastContextTarget = null;
export let hovered = null;
export let picked = null;
export let scanMode = 'normal';
export let deepScanTimer = 0;
export let capturePollTimer = 0;
export let currentItems = [];
export let suppressClick = false;
export let integratingScanId = '';
export let scanLoading = false;
export let areaMode = false;
export let areaStart = null;
export let areaToastTimer = null;
export let refreshTimer = 0;

export const sizeCache = new Map();
export const capturedResources = new Map();
export const capturedByUrl = new Map();
export const downloadTasks = new Map();
export const downloadQueue = [];
export const resumeJobs = new Map();
export const pendingMux = new Set();
export const counters = { download: 0, size: 0, scan: 0, quality: 0, resume: 0 };

export function setCache(value) { cache = value; }
export function setActive(value) { active = value; }
export function setRafId(value) { rafId = value; }
export function setMouse(value) { mouse = value; }
export function setLastContextTarget(value) { lastContextTarget = value; }
export function setHovered(value) { hovered = value; }
export function setPicked(value) { picked = value; }
export function setScanMode(value) { scanMode = value; }
export function setDeepScanTimer(value) { deepScanTimer = value; }
export function setCapturePollTimer(value) { capturePollTimer = value; }
export function setCurrentItems(value) { currentItems = value; }
export function setSuppressClick(value) { suppressClick = value; }
export function setIntegratingScanId(value) { integratingScanId = value; }
export function setScanLoading(value) { scanLoading = value; }
export function setAreaMode(value) { areaMode = value; }
export function setAreaStart(value) { areaStart = value; }
export function setAreaToastTimer(value) { areaToastTimer = value; }
export function setRefreshTimer(value) { refreshTimer = value; }
