export type ToastKind = 'info' | 'success' | 'error';

export interface ToastPayload {
  message: string;
  kind?: ToastKind;
}

/** 全局轻提示：通过 window 事件派发，任何组件都可调用 */
export function showToast(message: string, kind: ToastKind = 'info') {
  window.dispatchEvent(new CustomEvent<ToastPayload>('ft:toast', { detail: { message, kind } }));
}
