import { uid } from './utils.js';

// 首次运行写入的示例数据
export default function buildSeed() {
  const now = Date.now();
  const folderId = uid();
  const subId = uid();
  const welcomeId = uid();
  const todoId = uid();

  const nodes = [
    { id: folderId, parentId: null, type: 'folder', title: '我的笔记', order: now, createdAt: now, updatedAt: now },
    {
      id: welcomeId,
      parentId: folderId,
      type: 'doc',
      title: '欢迎使用',
      order: now + 1,
      createdAt: now,
      updatedAt: now,
      html:
        '<h1>欢迎使用笔记</h1>' +
        '<p>左侧是无限层级的目录树，右侧是 AiEditor 富文本编辑器，内容与图片全部保存在本地数据库。</p>' +
        '<ul>' +
        '<li>右键目录或文档：复制、剪切、粘贴、重命名、删除</li>' +
        '<li>点击目录前的小箭头展开子级，支持无限嵌套</li>' +
        '<li>工具栏可直接上传图片，图片会写入 IndexedDB</li>' +
        '</ul>' +
        '<blockquote>数据只保存在当前设备，不会上传到任何服务器。</blockquote>'
    },
    { id: subId, parentId: folderId, type: 'folder', title: '工作', order: now + 2, createdAt: now, updatedAt: now },
    {
      id: todoId,
      parentId: subId,
      type: 'doc',
      title: '待办',
      order: now + 3,
      createdAt: now,
      updatedAt: now,
      html: '<ul><li>整理本周笔记</li><li>给目录补齐标签</li></ul>'
    }
  ];

  return { nodes, selectedId: welcomeId, expanded: new Set([folderId, subId]) };
}
