const pad = (value: number, size = 2): string => String(value).padStart(size, '0');

// Pure: YYYYMMDD-HHMM in local time, for file names.
export function fileStamp(now: Date): string {
  return `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function saveFile(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
