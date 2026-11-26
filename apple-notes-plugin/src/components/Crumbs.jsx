import React from 'react';
import { displayTitle } from '../lib/utils.js';

export default function Crumbs({ path, onSelect }) {
  return (
    <>
      {path.map((item, index) => (
        <React.Fragment key={item.id}>
          {index > 0 ? <span>/</span> : null}
          <button
            type="button"
            className="rounded-[4px] px-0.5 transition-colors hover:text-ink"
            onClick={() => onSelect(item.id)}
          >
            {displayTitle(item)}
          </button>
        </React.Fragment>
      ))}
    </>
  );
}
