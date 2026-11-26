/**
 * 从 DataTransfer 中递归收集所有文件（含子文件夹内文件）。
 * 优先使用 webkitGetAsEntry（Chromium / Edge），回退到 dataTransfer.files（仅顶层）。
 */
export async function collectFromDataTransfer(dt: DataTransfer): Promise<File[]> {
  if (dt.items && 'webkitGetAsEntry' in DataTransferItem.prototype) {
    const entries: any[] = [];
    for (let i = 0; i < dt.items.length; i++) {
      const it = dt.items[i] as any;
      const entry = it.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    if (entries.length > 0) {
      const collected: File[] = [];
      await Promise.all(entries.map((e) => walkEntry(e, '', collected)));
      return collected;
    }
  }
  // Fallback
  return Array.from(dt.files || []);
}

function walkEntry(entry: any, path: string, out: File[]): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file: File) => {
        // File.name does NOT include folder path; attach a relative path for display
        try {
          Object.defineProperty(file, 'relativePath', {
            value: path + file.name,
            configurable: true,
          });
        } catch {
          // ignore
        }
        out.push(file);
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all: any[] = [];
      const readBatch = () => {
        reader.readEntries(async (batch: any[]) => {
          if (!batch || batch.length === 0) {
            await Promise.all(
              all.map((sub) => walkEntry(sub, path + entry.name + '/', out))
            );
            resolve();
          } else {
            all.push(...batch);
            readBatch();
          }
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

export function totalSize(files: File[]): number {
  return files.reduce((acc, f) => acc + (f.size || 0), 0);
}
