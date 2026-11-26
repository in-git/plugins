import React, { useEffect } from 'react';
import { Icon } from './icons.jsx';

export default function ContextMenu({ menu, onClose, onAction, canPaste }) {
  useEffect(() => {
    if (!menu) return undefined;

    const onDown = () => onClose();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onDown);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const node = menu.node;
  const items = [];
  if (node) {
    items.push({ id: 'copy', label: '复制', icon: 'copy' });
    items.push({ id: 'cut', label: '剪切', icon: 'scissors' });
  }
  if (canPaste) items.push({ id: 'paste', label: '粘贴', icon: 'clipboard' });
  if (node || canPaste) items.push({ id: 'sep-new', sep: true });
  items.push({ id: 'newDoc', label: '新建文档', icon: 'docPlus' });
  items.push({ id: 'newFolder', label: '新建目录', icon: 'folderPlus' });
  if (node) {
    items.push({ id: 'sep-edit', sep: true });
    items.push({ id: 'rename', label: '重命名', icon: 'pencil' });
    items.push({ id: 'delete', label: '删除', icon: 'trash', danger: true });
  }

  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 200));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 340));

  return (
    <div
      className="fixed z-[80]"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="menu-panel">
        {items.map((item) =>
          item.sep ? (
            <div key={item.id} className="menu-sep" />
          ) : (
            <button
              key={item.id}
              type="button"
              className={'menu-item' + (item.danger ? ' is-danger' : '')}
              onClick={() => {
                onClose();
                onAction(item.id, node);
              }}
            >
              <span className="shrink-0">
                <Icon name={item.icon} size={15} />
              </span>
              <span className="flex-1">{item.label}</span>
            </button>
          )
        )}
      </div>
    </div>
  );
}
