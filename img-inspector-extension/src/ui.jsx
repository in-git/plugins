import React, { useSyncExternalStore, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Rnd } from 'react-rnd';
import Cropper from 'cropperjs';
import cropperCss from 'cropperjs/dist/cropper.css';

const controller = () => window.__IMG_INSPECTOR_CONTROLLER__;

const ICON_PATHS = {
  refresh: <><path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6" /><path d="M16.5 3.5v4h-4" /></>,
  close: <><path d="M5 5l10 10M15 5L5 15" /></>,
  filter: <><path d="M3 5h14M6 10h8M8.5 15h3" /></>,
  check: <><path d="M4.5 10.5l3.5 3.5 7.5-8" /></>,
  crop: <><path d="M6 2.5v11.5a1.5 1.5 0 0 0 1.5 1.5H19" /><path d="M2.5 6H14a1.5 1.5 0 0 1 1.5 1.5V19" /></>,
  download: <><path d="M10 3v9" /><path d="M6.5 8.5L10 12l3.5-3.5" /><path d="M4 16h12" /></>,
  bili: <><rect x="2.6" y="4.8" width="14.8" height="11.4" rx="3.2" /><path d="M6.6 4.6L5.1 3" /><path d="M13.4 4.6L14.9 3" /><path d="M7.4 9.6v1.5" /><path d="M12.6 9.6v1.5" /></>
};

function Icon({ name, size = 14, strokeWidth = 1.5 }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg viewBox="0 0 48 48" width="46" height="46" fill="none" stroke="currentColor"
      strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="10" width="34" height="28" rx="3" />
      <circle cx="17" cy="20" r="3" />
      <path d="M7 33l10-9 7 6 7-8 10 11" />
    </svg>
  );
}

const FORMATS = [['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP'], ['gif', 'GIF'], ['svg', 'SVG'], ['other', '其他']];
const SOURCES = [['img', 'img 标签'], ['background', '背景图'], ['other', '其他来源']];
// 形状容差：允许图片宽高比与控制器宽高比存在一定偏差
const TOLERANCES = [
  { value: 0.1, label: '严格 ±10%' },
  { value: 0.2, label: '适中 ±20%' },
  { value: 0.35, label: '宽松 ±35%' }
];

const DEFAULT_STAGE = 200;
const MAX_BOX = 400;
// 控制器全局状态：关闭筛选器再打开、切换页面时都保留大小与坐标，不再自动居中
const boxState = { w: 0, h: 0, x: null, y: null };
const EDGE = 'rgba(0, 122, 255, .55)';

// 四角拖拽点尺寸（含可点击热区）
const CORNER = 18;

// 四条边 + 四个角都可拖拽
const HANDLE_STYLES = {
  top: { height: 8, width: '100%', top: -4, left: 0, background: EDGE, borderRadius: 4, cursor: 'ns-resize' },
  bottom: { height: 8, width: '100%', bottom: -4, left: 0, background: EDGE, borderRadius: 4, cursor: 'ns-resize' },
  left: { width: 8, height: '100%', left: -4, top: 0, background: EDGE, borderRadius: 4, cursor: 'ew-resize' },
  right: { width: 8, height: '100%', right: -4, top: 0, background: EDGE, borderRadius: 4, cursor: 'ew-resize' },
  topLeft: { width: CORNER, height: CORNER, left: -CORNER / 2, top: -CORNER / 2, cursor: 'nwse-resize' },
  topRight: { width: CORNER, height: CORNER, right: -CORNER / 2, top: -CORNER / 2, cursor: 'nesw-resize' },
  bottomLeft: { width: CORNER, height: CORNER, left: -CORNER / 2, bottom: -CORNER / 2, cursor: 'nesw-resize' },
  bottomRight: { width: CORNER, height: CORNER, right: -CORNER / 2, bottom: -CORNER / 2, cursor: 'nwse-resize' }
};

const HANDLE_CLASSES = {
  top: 'ii-handle ii-handle-top',
  right: 'ii-handle ii-handle-right',
  bottom: 'ii-handle ii-handle-bottom',
  left: 'ii-handle ii-handle-left',
  topLeft: 'ii-handle ii-handle-corner ii-handle-top-left',
  topRight: 'ii-handle ii-handle-corner ii-handle-top-right',
  bottomLeft: 'ii-handle ii-handle-corner ii-handle-bottom-left',
  bottomRight: 'ii-handle ii-handle-corner ii-handle-bottom-right'
};

const RESIZE_ENABLED = {
  top: true, right: true, bottom: true, left: true,
  topLeft: true, topRight: true, bottomLeft: true, bottomRight: true
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 文件大小展示：B / KB / MB
function fmtBytes(n) {
  if (!n || n < 1) return '';
  if (n < 1024) return Math.round(n) + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 按舞台尺寸收敛方框：始终保留已有坐标，只有首次出现（还没有坐标）时居中一次
function fitBox(state, stage) {
  const w = clamp(Math.round(state.w || 100), 10, Math.min(stage, MAX_BOX));
  const h = clamp(Math.round(state.h || 100), 10, Math.min(stage, MAX_BOX));
  const x = Number.isFinite(state.x) ? state.x : (stage - w) / 2;
  const y = Number.isFinite(state.y) ? state.y : (stage - h) / 2;
  return {
    w,
    h,
    x: clamp(Math.round(x), 0, stage - w),
    y: clamp(Math.round(y), 0, stage - h)
  };
}

function Thumb({ url, height, children }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={'ii-media' + (broken ? ' is-broken' : '')} style={{ height }}>
      {!broken && (
        <img className="ii-img" src={url} alt="" loading="lazy" decoding="async"
          onLoad={(e) => e.currentTarget.classList.add('is-loaded')}
          onError={() => setBroken(true)} />
      )}
      {children}
    </div>
  );
}

function Card({ item, chosen, actions, onCrop, notify }) {
  const img = item.img;
  const [busy, setBusy] = useState(false);
  const download = async (e) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const res = await actions.downloadOne(item.index);
      if (res && res.fail) notify('下载失败，请重试');
      else notify('已开始下载' + (img.width ? ' ' + img.width + ' × ' + img.height : ''));
    } catch (err) {
      notify('下载失败：' + (err.message || err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={'ii-card' + (chosen ? ' is-selected' : '')}
      style={{ left: item.left, top: item.top, width: item.width, height: item.height }}
      onClick={() => actions.toggleSelect(item.index)}>
      <Thumb url={img.url} height={item.imgH}>
        {img.width && img.height ? (
          <span className="ii-res">{img.width} × {img.height}</span>
        ) : null}
        <button type="button" title="选择这张图片"
          className={'ii-pick' + (chosen ? ' is-on' : '')}
          onClick={(e) => { e.stopPropagation(); actions.toggleSelect(item.index); }}>
          <Icon name="check" size={13} strokeWidth={1.8} />
        </button>
        <div className="ii-meta">
          <span className="ii-size">{fmtBytes(img.bytes)}</span>
          <button type="button" className="ii-icon-btn" title="裁剪后下载"
            onClick={(e) => { e.stopPropagation(); onCrop(img); }}>
            <Icon name="crop" size={15} />
          </button>
          <button type="button" className={'ii-icon-btn' + (busy ? ' is-busy' : '')}
            title={busy ? '下载中…' : '下载原图'} disabled={busy} onClick={download}>
            {busy ? <span className="ii-spinner" /> : <Icon name="download" size={15} />}
          </button>
        </div>
      </Thumb>
    </div>
  );
}

function Chips({ items, active, onToggle }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(([value, label]) => (
        <button key={value} type="button"
          className={'ii-chip' + (active.indexOf(value) >= 0 ? ' is-on' : '')}
          onClick={() => onToggle(value)}>{label}</button>
      ))}
    </div>
  );
}

function FilterPopover({ s, actions }) {
  const cfg = s.cfg;
  const stageRef = useRef(null);
  // 舞台实际尺寸（左侧占 2/3，宽度随 popover 变化）
  const [stage, setStage] = useState(DEFAULT_STAGE);
  // 草稿镜像全局 boxState：拖拽/缩放立即写回全局，关闭再打开不丢坐标
  const [box, setBox] = useState(() => {
    if (!boxState.w || !boxState.h) {
      boxState.w = cfg.boxW;
      boxState.h = cfg.boxH;
    }
    return fitBox(boxState, DEFAULT_STAGE);
  });
  const maxBox = Math.min(stage, MAX_BOX);
  const cfgSize = useRef({ w: cfg.boxW, h: cfg.boxH });

  // 写入全局状态并同步本地镜像
  const writeBox = (next) => {
    const b = fitBox(next, stage);
    boxState.w = b.w;
    boxState.h = b.h;
    boxState.x = b.x;
    boxState.y = b.y;
    setBox(b);
  };

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const sync = () => setStage(Math.max(120, Math.round(el.clientWidth || DEFAULT_STAGE)));
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 舞台尺寸变化：保留当前坐标，只收敛到边界内
  useEffect(() => {
    setBox((d) => {
      const b = fitBox({ w: d.w, h: d.h, x: boxState.x, y: boxState.y }, stage);
      boxState.w = b.w;
      boxState.h = b.h;
      boxState.x = b.x;
      boxState.y = b.y;
      return b;
    });
  }, [stage]);

  // 外部尺寸变化（应用尺寸 / 重置 / 恢复配置）后保持当前位置，不再重新居中
  useEffect(() => {
    if (cfg.boxW === cfgSize.current.w && cfg.boxH === cfgSize.current.h) return;
    cfgSize.current = { w: cfg.boxW, h: cfg.boxH };
    boxState.w = cfg.boxW;
    boxState.h = cfg.boxH;
    setBox(fitBox(boxState, stage));
  }, [cfg.boxW, cfg.boxH]);

  // 拖拽/缩放：写入全局坐标
  const dragBox = (x, y) => writeBox({ w: box.w, h: box.h, x, y });
  const sizeBox = (w, h, x, y) => writeBox({ w, h, x, y });

  const setDim = (key, raw) => {
    const n = clamp(Math.round(Number(raw) || 10), 10, maxBox);
    writeBox({ w: key === 'w' ? n : box.w, h: key === 'h' ? n : box.h, x: box.x, y: box.y });
  };

  const applied = cfg.enabled && box.w === cfg.boxW && box.h === cfg.boxH;
  const sizeMode = cfg.sizeMode === 'gte' || cfg.sizeMode === 'lte' ? cfg.sizeMode : 'any';
  const tolerance = Number.isFinite(cfg.tolerance) ? cfg.tolerance : 0.2;

  // 背景图跟随控制器形状；大小条件决定它比控制器大或小
  const bgScale = sizeMode === 'lte' ? 1.32 : 0.76;
  const bgW = Math.max(24, Math.min(stage, Math.round(box.w * bgScale)));
  const bgH = Math.max(24, Math.min(stage, Math.round(box.h * bgScale)));
  const bgLeft = clamp(Math.round(box.x + box.w / 2 - bgW / 2), 0, stage - bgW);
  const bgTop = clamp(Math.round(box.y + box.h / 2 - bgH / 2), 0, stage - bgH);

  return (
    <div className="ii-pop" onClick={(e) => e.stopPropagation()}>
      <div className="flex gap-6">
        <div className="w-2/3 shrink-0">
          <div className="mb-2 flex items-center justify-between">
            <span className="ii-label">尺寸控制器</span>
            <button type="button" title={cfg.enabled ? '停用筛选' : '启用筛选'}
              className={'ii-switch' + (cfg.enabled ? ' is-on' : '')}
              onClick={() => actions.toggleEnabled()} />
          </div>
          <div className="ii-stage" ref={stageRef}>
            <div className="ii-stage-bg" style={{ left: bgLeft, top: bgTop, width: bgW, height: bgH }}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
                <defs>
                  <linearGradient id="ii-sky" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#b9dcff" />
                    <stop offset="100%" stopColor="#eef7ff" />
                  </linearGradient>
                </defs>
                <rect width="100" height="100" fill="url(#ii-sky)" />
                <circle cx="73" cy="24" r="8" fill="#ffd166" />
                <path d="M0 72 L24 42 L44 68 L62 50 L100 84 L100 100 L0 100 Z" fill="#a8cbe6" />
                <path d="M0 84 L20 62 L40 82 L60 58 L84 84 L100 70 L100 100 L0 100 Z" fill="#5f8fb2" />
                <rect y="88" width="100" height="12" fill="#3c688a" />
              </svg>
            </div>
            <Rnd
              className="ii-box"
              size={{ width: box.w, height: box.h }}
              position={{ x: box.x, y: box.y }}
              bounds="parent"
              minWidth={10} minHeight={10} maxWidth={maxBox} maxHeight={maxBox}
              enableResizing={RESIZE_ENABLED}
              resizeHandleStyles={HANDLE_STYLES}
              resizeHandleClasses={HANDLE_CLASSES}
              onDrag={(e, data) => dragBox(data.x, data.y)}
              onDragStop={(e, data) => dragBox(data.x, data.y)}
              onResize={(e, dir, ref, delta, pos) => sizeBox(ref.offsetWidth, ref.offsetHeight, pos.x, pos.y)}
              onResizeStop={(e, dir, ref, delta, pos) => sizeBox(ref.offsetWidth, ref.offsetHeight, pos.x, pos.y)}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="ii-label mr-1">形状容差</span>
            {TOLERANCES.map((t) => (
              <button key={t.label} type="button"
                className={'ii-chip' + (Math.abs(tolerance - t.value) < 0.001 ? ' is-on' : '')}
                onClick={() => actions.setCfg('tolerance', t.value)}>{t.label}</button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="ii-label">大小</span>
            <label className="ii-radio">
              <input type="radio" name="ii-size" checked={sizeMode === 'any'}
                onChange={() => actions.setCfg('sizeMode', 'any')} />
              <span>不限</span>
            </label>
            <label className="ii-radio">
              <input type="radio" name="ii-size" checked={sizeMode === 'gte'}
                onChange={() => actions.setCfg('sizeMode', 'gte')} />
              <span>大于控制器</span>
            </label>
            <label className="ii-radio">
              <input type="radio" name="ii-size" checked={sizeMode === 'lte'}
                onChange={() => actions.setCfg('sizeMode', 'lte')} />
              <span>小于控制器</span>
            </label>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <span className="ii-label">比例 1 :</span>
            <input type="number" min="0.1" max="10" step="0.1" className="ii-field w-[64px]"
              value={cfg.scale} title="1px 控制器对应的图片像素"
              onChange={(e) => actions.setCfg('scale', Number(e.target.value))} />
          </div>
          <button type="button" className="ii-btn-primary mt-2 h-8 w-full px-3 text-[13px]"
            disabled={applied} onClick={() => actions.setBoxSize(box.w, box.h)}>
            {applied ? '已应用' : '应用'}
          </button>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="ii-label w-[46px] shrink-0">方块</span>
              <input type="number" min="10" max={maxBox} className="ii-field w-[54px]"
                value={box.w} title="方块宽度"
                onChange={(e) => setDim('w', e.target.value)} />
              <span className="text-[13px] text-subtle">×</span>
              <input type="number" min="10" max={maxBox} className="ii-field w-[54px]"
                value={box.h} title="方块高度"
                onChange={(e) => setDim('h', e.target.value)} />
            </div>
          </div>

          <div className="ii-label mb-2 mt-4">属性</div>
          <Chips items={FORMATS} active={cfg.formats} onToggle={actions.chipFormat} />
          <div className="mt-1.5">
            <Chips items={SOURCES} active={cfg.sources} onToggle={actions.chipSource} />
          </div>

          <div className="mt-4 border-t border-black/[0.05] pt-3">
            <span className="block text-[13px] text-subtle">匹配 {s.matched} / {s.total} 张
              {s.unknownCount ? ' · ' + s.unknownCount + ' 张尺寸未知' : ''}</span>
            <button type="button" className="ii-btn mt-2 h-7 w-full px-2.5 text-[13px]"
              onClick={actions.resetFilter}>重置</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ s, actions }) {
  const byFilter = s.total > 0 && s.matched === 0;
  return (
    <div className="ii-empty">
      <div className="mb-6 text-[#d2d2d7]"><EmptyIcon /></div>
      <div className="text-[14px] font-medium text-ink">
        {byFilter ? '没有符合筛选条件的图片' : '没有找到图片'}
      </div>
      <div className="mt-3 max-w-[420px] text-[11px] leading-[1.9] text-subtle">
        {byFilter
          ? '调整筛选条件后重试。'
          : '滚动页面后点「重扫」。'}
      </div>
      <button type="button" className="ii-btn-primary mt-7 gap-1.5"
        onClick={byFilter ? actions.toggleFilter : actions.rescan}>
        <Icon name={byFilter ? 'filter' : 'refresh'} />
        {byFilter ? '打开筛选器' : '重新扫描'}
      </button>
    </div>
  );
}

const CROP_RATIOS = [
  { key: 'free', label: '自由裁剪', value: NaN },
  { key: '1:1', label: '1 : 1', value: 1 },
  { key: '16:9', label: '16 : 9', value: 16 / 9 },
  { key: '9:19', label: '9 : 19', value: 9 / 19 }
];

const CROP_FORMATS = [
  { key: 'png', label: 'PNG', mime: 'image/png', ext: 'png', lossy: false },
  { key: 'jpg', label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', lossy: true },
  { key: 'webp', label: 'WebP', mime: 'image/webp', ext: 'webp', lossy: true }
];

function cropFileName(image, ext) {
  let host = 'image';
  try { host = new URL(image.url).hostname || 'image'; } catch (e) { /* data URL */ }
  const size = image.width && image.height ? '-' + image.width + 'x' + image.height : '';
  return host + size + '-crop.' + ext;
}

function CropDialog({ image, actions, onClose, notify }) {
  const imgRef = useRef(null);
  const cropperRef = useRef(null);
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [ratio, setRatio] = useState('free');
  // 已应用到裁剪框的比例：只有点「应用」后才真正生效，避免点一下比例就自动改裁剪区域
  const [appliedRatio, setAppliedRatio] = useState('free');
  const [format, setFormat] = useState('png');
  const [quality, setQuality] = useState(0.85);

  // 先在后台抓取图片字节，转成 data URL，避免跨域导致画布被污染
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await actions.fetchImage(image.url);
        if (!alive) return;
        if (res && res.dataUrl) setSrc(res.dataUrl);
        else setError((res && res.error) || '图片读取失败');
      } catch (err) {
        if (alive) setError('图片读取失败：' + (err.message || err));
      }
    })();
    return () => { alive = false; };
  }, [image.url]);

  useEffect(() => {
    if (!src || !imgRef.current) return;
    const cropper = new Cropper(imgRef.current, {
      viewMode: 1, autoCropArea: 0.82, background: false, responsive: true,
      movable: true, zoomable: true, rotatable: false, highlight: false,
      aspectRatio: NaN
    });
    cropperRef.current = cropper;
    return () => { cropper.destroy(); cropperRef.current = null; };
  }, [src]);

  const current = CROP_FORMATS.find((f) => f.key === format) || CROP_FORMATS[0];
  const applied = appliedRatio === ratio;

  const applyRatio = () => {
    const cropper = cropperRef.current;
    if (!cropper) return;
    const preset = CROP_RATIOS.find((r) => r.key === ratio);
    cropper.setAspectRatio(preset ? preset.value : NaN);
    setAppliedRatio(ratio);
  };

  const save = async () => {
    const cropper = cropperRef.current;
    if (!cropper || !applied) return;
    setSaving(true);
    setError('');
    try {
      const canvas = cropper.getCroppedCanvas({ maxWidth: 8192, maxHeight: 8192, imageSmoothingQuality: 'high' });
      if (!canvas) throw new Error('裁剪区域为空');
      const dataUrl = current.lossy
        ? canvas.toDataURL(current.mime, quality)
        : canvas.toDataURL(current.mime);
      const res = await actions.saveCropped(dataUrl, cropFileName(image, current.ext));
      if (!res || !res.ok) throw new Error((res && res.error) || '保存失败');
      if (notify) notify('裁剪完成，已开始下载');
      onClose();
    } catch (err) {
      setError('导出失败：' + (err.message || err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ii-crop-mask">
      <div className="ii-crop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-medium text-ink">裁剪图片</span>
          <button type="button" title="关闭" className="ii-close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <span className="ii-label shrink-0">格式</span>
          <select className="ii-field w-[96px] shrink-0" value={format}
            onChange={(e) => setFormat(e.target.value)}>
            {CROP_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <span className="ii-label ml-2 shrink-0">WebP 压缩</span>
          <input type="range" className="ii-range min-w-0 flex-1" min="0.3" max="1" step="0.05"
            value={quality} disabled={!current.lossy} title="压缩质量"
            onChange={(e) => setQuality(Number(e.target.value))} />
          <span className="w-[42px] shrink-0 text-right text-[13px] text-subtle">
            {current.lossy ? Math.round(quality * 100) + '%' : '—'}
          </span>
        </div>

        <div className="ii-crop-body">
          <div className="ii-crop-stage">
            {!src && !error && <span className="ii-spinner ii-spinner-dark" />}
            {error && <div className="ii-crop-error">{error}</div>}
            {src && <img ref={imgRef} className="ii-crop-img" src={src} alt="" />}
          </div>
          <div className="ii-crop-side">
            <div className="ii-label mb-2">裁剪比例</div>
            {CROP_RATIOS.map((r) => (
              <button key={r.key} type="button"
                className={'ii-ratio' + (ratio === r.key ? ' is-on' : '')}
                onClick={() => setRatio(r.key)}>{r.label}</button>
            ))}
            <button type="button" className="ii-btn mt-3 h-7 w-full px-2 text-[13px]"
              disabled={applied} onClick={applyRatio}>
              {applied ? '已应用' : '应用'}
            </button>
            <div className="mt-4 text-[12px] leading-[1.7] text-[#b0b0b5]">
              选择比例后点「应用」才会生效；自由裁剪可拖动边角调整。
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <button type="button" className="ii-btn h-8 px-4 text-[13px]" onClick={onClose}>取消</button>
          <button type="button" className="ii-btn-primary h-8 px-4 text-[13px]"
            disabled={!src || saving || !applied}
            title={applied ? '' : '请先点击「应用」'}
            onClick={save}>
            {saving ? '正在导出…' : '裁剪并下载'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Panel() {
  const c = controller();
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const scrollerRef = useRef(null);
  const canvasRef = useRef(null);
  const panelRef = useRef(null);
  const actions = c.actions;
  const [cropTarget, setCropTarget] = useState(null);
  const [packing, setPacking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const notify = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // React 挂载后按真实视口高度锁定 80%（CSS 的 80vh 作为兜底）
  useEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    const h = Math.round(window.innerHeight * 0.8);
    p.style.height = h + 'px';
    p.style.minHeight = h + 'px';
    p.style.maxHeight = h + 'px';
  }, []);

  useEffect(() => {
    if (scrollerRef.current) {
      actions.onScroll(
        scrollerRef.current.scrollTop,
        scrollerRef.current.clientHeight,
        canvasRef.current ? canvasRef.current.clientWidth : 0
      );
    }
  }, [s.layout]);

  // 画布宽度变化（窗口缩放、出现滚动条）时重新排版，避免瀑布流只铺在左侧
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      actions.onScroll(scroller.scrollTop, scroller.clientHeight, canvas.clientWidth);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (cropTarget) { setCropTarget(null); e.stopPropagation(); return; }
      if (s.filterOpen) { actions.toggleFilter(); e.stopPropagation(); return; }
      actions.close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [s.filterOpen, cropTarget]);

  const onOverlayClick = (e) => {
    if (s.filterOpen && !e.target.closest('.ii-pop') && !e.target.closest('[data-filter-btn]')) {
      actions.toggleFilter();
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-canvas/70 backdrop-blur-[3px]"
      onClick={onOverlayClick}>
      <div ref={panelRef} className="ii-panel relative flex flex-col overflow-hidden rounded-modal bg-white font-sans text-ink antialiased shadow-[0_24px_80px_-16px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.03)]">
        <header className="flex shrink-0 items-center justify-between px-9 pb-5 pt-7">
          <div className="flex items-baseline gap-3">
            <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">图片下载器-吴文龙</h1>
            <span className="max-w-[260px] truncate text-[11px] text-[#b8b8bd]" title={s.title}>{s.site}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-canvas px-3 py-1 text-[11px] tracking-wide text-subtle">
              {s.matched} 张 · 已选 {s.selectedCount}
            </span>
            <button type="button" title="关闭 (Esc)" className="ii-close" onClick={actions.close}>
              <Icon name="close" strokeWidth={1.4} />
            </button>
          </div>
        </header>


        <div className="relative flex shrink-0 flex-wrap items-center gap-2 px-9 pb-7">
          <button type="button" data-filter-btn className="ii-btn gap-1.5" title="可视化筛选"
            onClick={(e) => { e.stopPropagation(); actions.toggleFilter(); }}>
            <Icon name="filter" />可视化筛选
          </button>
          <button type="button" className="ii-btn gap-1.5" title="重新扫描当前页面" onClick={actions.rescan}>
            <Icon name="refresh" />重新扫描
          </button>
          <button type="button" className="ii-btn" title="滚动网页触发懒加载后重新扫描" onClick={actions.loadMore}>
            加载更多
          </button>
          <span className="flex-1" />
          <a className="ii-btn" target="_blank" rel="noreferrer"
            href="https://space.bilibili.com/3706965849016893"
            title="B站主页 / 反馈"
            onClick={(e) => e.stopPropagation()}><Icon name="bili" strokeWidth={1.6} />反馈</a>
          <button type="button" className="ii-btn" onClick={actions.selectAll}>{s.allSelected ? '取消全选' : '全选'}</button>
          <button type="button" className="ii-btn" disabled={!s.selectedCount || downloading || packing}
            title={s.selectedCount ? '' : '请先选择图片'}
            onClick={async () => {
              if (downloading || !s.selectedCount) return;
              setDownloading(true);
              try {
                const res = await actions.downloadSelected();
                if (res && res.ok) notify('已下载 ' + res.ok + ' 张' + (res.fail ? '，' + res.fail + ' 张失败' : ''));
                else notify('下载失败，请重试');
              } catch (e) {
                notify('下载失败，请重试');
              } finally {
                setDownloading(false);
              }
            }}>
            {downloading ? <><span className="ii-spinner" />下载中…</> : '下载选中'}
          </button>
          <button type="button" className="ii-btn-primary" disabled={packing || downloading}
            onClick={async () => {
              if (packing) return;
              setPacking(true);
              try { await actions.downloadAll(); } finally { setPacking(false); }
            }}>
            {packing ? <><span className="ii-spinner" />打包中…</> : '下载全部'}
          </button>
          {s.filterOpen && <FilterPopover s={s} actions={actions} />}
        </div>

        <main ref={scrollerRef} className="ii-scroll min-h-0 flex-1 overflow-y-auto px-9 pb-8"
          onScroll={(e) => actions.onScroll(e.currentTarget.scrollTop, e.currentTarget.clientHeight,
            canvasRef.current ? canvasRef.current.clientWidth : 0)}>
          <div ref={canvasRef} className="relative w-full" style={{ height: s.matched ? s.canvasHeight : 'auto' }}>
            {s.matched === 0
              ? <EmptyState s={s} actions={actions} />
              : s.visible.map((idx) => {
                const item = s.layout[idx];
                if (!item) return null;
                return <Card key={item.img.url} item={item} chosen={s.selected.has(item.img.url)}
                  actions={actions} onCrop={setCropTarget} notify={notify} />;
              })}
          </div>
        </main>

        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-black/[0.05] px-9 py-4 text-[11px] text-subtle">
          <span className={s.statusKind === 'error' ? 'truncate text-[#b06a62]'
            : s.statusKind === 'success' ? 'truncate text-[#4b8b6a]' : 'truncate'} title={s.status}>
            {s.status}
          </span>
          <span className="shrink-0 text-[#b8b8bd]">点击卡片选择 · 每张可单独下载 · Esc 关闭</span>
        </footer>
        {toast && <div className="ii-toast">{toast}</div>}
        {cropTarget && (
          <CropDialog image={cropTarget} actions={actions} notify={notify}
            onClose={() => setCropTarget(null)} />
        )}
      </div>
    </div>
  );
}

// ---------- Shadow DOM 挂载 ----------

// 每次点击图标都会重新注入 ui.js。挂载状态必须放在全局，
// 否则重复注入会创建第二棵 React 树、页面上出现两个面板。
const state = globalThis.__IMG_INSPECTOR_UI_STATE__ || (globalThis.__IMG_INSPECTOR_UI_STATE__ = {
  host: null, shadow: null, reactRoot: null, savedOverflow: null
});

function ensureHost() {
  if (state.host) return;
  const host = document.createElement('div');
  host.id = '__img_inspector_host__';
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;display:none;';
  const shadow = host.attachShadow({ mode: 'closed' });

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(globalThis.__IMG_INSPECTOR_CSS__ || '');
    shadow.adoptedStyleSheets = [sheet];
  } catch (err) {
    const style = document.createElement('style');
    style.textContent = globalThis.__IMG_INSPECTOR_CSS__ || '';
    shadow.appendChild(style);
  }
  // 裁剪库样式必须注入到 shadow root 内部才生效
  const cropStyle = document.createElement('style');
  cropStyle.textContent = cropperCss;
  shadow.appendChild(cropStyle);
  state.host = host;
  state.shadow = shadow;
  state.reactRoot = createRoot(shadow);
  state.reactRoot.render(<Panel />);
}

function applyPanelSize() {
  const panel = state.shadow && state.shadow.querySelector('.ii-panel');
  if (!panel) return;
  const h = Math.round(window.innerHeight * 0.8);
  panel.style.height = h + 'px';
  panel.style.minHeight = h + 'px';
  panel.style.maxHeight = h + 'px';
}

const onResize = () => {
  if (state.host && state.host.style.display !== 'none') applyPanelSize();
};

globalThis.__IMG_INSPECTOR_UI__ = {
  open() {
    ensureHost();
    const host = state.host;
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    if (host.style.display === 'none' && state.savedOverflow === null) {
      state.savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
    }
    host.style.display = 'block';
    applyPanelSize();
    window.addEventListener('resize', onResize);
    controller().actions.rescan();
  },
  close() {
    const host = state.host;
    if (!host || host.style.display === 'none') return;
    host.style.display = 'none';
    if (state.savedOverflow !== null) {
      document.documentElement.style.overflow = state.savedOverflow;
      state.savedOverflow = null;
    }
    window.removeEventListener('resize', onResize);
    controller().actions.closePopover();
  },
  isOpen() {
    return !!state.host && state.host.style.display !== 'none';
  },
  dispose() {
    try { if (state.reactRoot) state.reactRoot.unmount(); } catch (e) { /* 忽略 */ }
    window.removeEventListener('resize', onResize);
    if (state.host && state.host.parentNode) state.host.remove();
    if (state.savedOverflow !== null) {
      try { document.documentElement.style.overflow = state.savedOverflow; } catch (e) { /* 忽略 */ }
    }
    state.host = null; state.shadow = null; state.reactRoot = null; state.savedOverflow = null;
  }
};
