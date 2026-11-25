import React from 'react';

const PATHS = {
  chevron: <path d="M8 5.5 12.5 10 8 14.5" />,
  folder: <path d="M3.5 6.6c0-.7.5-1.2 1.2-1.2h2.6l1.4 1.6h5.1c.7 0 1.2.5 1.2 1.2v5.6c0 .8-.6 1.4-1.4 1.4H4.9c-.8 0-1.4-.6-1.4-1.4V6.6z" />,
  doc: (
    <>
      <path d="M5 3.8h6.2L15 7.6v8.6c0 .8-.6 1.4-1.4 1.4H5c-.8 0-1.4-.6-1.4-1.4V5.2c0-.8.6-1.4 1.4-1.4z" />
      <path d="M11.1 3.9v3.8h3.8" />
      <path d="M7 10.2h5.6M7 13h4" />
    </>
  ),
  docPlus: (
    <>
      <path d="M11.5 3.5H6.4c-.8 0-1.4.6-1.4 1.4v10.2c0 .8.6 1.4 1.4 1.4h7.2c.8 0 1.4-.6 1.4-1.4V7.1l-3.5-3.6z" />
      <path d="M11.5 3.6v3.5h3.4" />
      <path d="M10 9.6v4M8 11.6h4" />
    </>
  ),
  folderPlus: (
    <>
      <path d="M3.5 6.6c0-.7.5-1.2 1.2-1.2h2.6l1.4 1.6h5.1c.7 0 1.2.5 1.2 1.2v5.6c0 .8-.6 1.4-1.4 1.4H4.9c-.8 0-1.4-.6-1.4-1.4V6.6z" />
      <path d="M10 9.4v3.6M8.2 11.2h3.6" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.4 15.6l.7-3.1 7.5-7.5a1.4 1.4 0 0 1 2 2l-7.5 7.5-2.7.9z" />
      <path d="M11.2 5.9l2.9 2.9" />
    </>
  ),
  trash: (
    <>
      <path d="M4.8 5.8h10.4" />
      <path d="M8 5.8V4.6c0-.5.4-.8.8-.8h2.4c.4 0 .8.3.8.8v1.2" />
      <path d="M6.4 5.8l.5 8.6c0 .8.6 1.4 1.4 1.4h3.4c.8 0 1.4-.6 1.4-1.4l.5-8.6" />
    </>
  ),
  sun: (
    <>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2.8v1.5M10 15.7v1.5M2.8 10h1.5M15.7 10h1.5M4.9 4.9l1 1M14.1 14.1l1 1M15.1 4.9l-1 1M5.9 14.1l-1 1" />
    </>
  ),
  moon: <path d="M15.6 12.2A6.2 6.2 0 0 1 7.8 4.4 6.6 6.6 0 1 0 15.6 12.2z" />,
  plus: <path d="M10 4.6v10.8M4.6 10h10.8" />,
  search: (
    <>
      <circle cx="8.9" cy="8.9" r="4.7" />
      <path d="M12.4 12.4l3.3 3.3" />
    </>
  ),
  expandAll: (
    <>
      <path d="M5.6 4.8 10 8.9l4.4-4.1" />
      <path d="M5.6 10.6 10 14.7l4.4-4.1" />
    </>
  ),
  collapseAll: (
    <>
      <path d="M5.6 9.2 10 5.1l4.4 4.1" />
      <path d="M5.6 15 10 10.9l4.4 4.1" />
    </>
  ),
  close: <path d="M6 6l8 8M14 6l-8 8" />
};

export function Icon({ name, size = 16, stroke = 1.4, className = '' }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {PATHS[name] || null}
    </svg>
  );
}
