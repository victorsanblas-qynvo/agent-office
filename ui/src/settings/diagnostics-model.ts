export function bytesText(bytes: number | null, decimal: (value: number) => string): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${decimal(bytes)} B`;
  if (bytes < 1024 * 1024) return `${decimal(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${decimal(bytes / 1024 / 1024)} MB`;
  return `${decimal(bytes / 1024 / 1024 / 1024)} GB`;
}

export function msText(ms: number | null, decimal: (value: number) => string): string {
  return ms === null ? '—' : `${decimal(ms)} ms`;
}

export function uptimeText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return `${Math.floor(Math.max(0, ms) / 1000)} s`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days} d ${hours} h`;
  return hours > 0 ? `${hours} h ${rest} min` : `${rest} min`;
}
