import { watch, type FSWatcher } from 'node:fs';

export type WatchTarget = { dir: string; match: (filename: string) => boolean };

export function watchTargets(targets: WatchTarget[], onChange: () => void, debounceMs = 200, retryMs = 1000): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const retries = new Set<ReturnType<typeof setTimeout>>();
  const watchers = new Set<FSWatcher>();
  const fire = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };
  const retry = (target: WatchTarget) => {
    if (stopped) return;
    const handle = setTimeout(() => {
      retries.delete(handle);
      arm(target);
    }, retryMs);
    retries.add(handle);
  };
  const arm = (target: WatchTarget) => {
    if (stopped) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(target.dir, (_event, filename) => {
        if (filename && target.match(String(filename))) fire();
      });
    } catch {
      retry(target);
      return;
    }
    watchers.add(watcher);
    watcher.on('error', () => {
      watchers.delete(watcher);
      watcher.close();
      retry(target);
    });
  };
  for (const target of targets) arm(target);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const handle of retries) clearTimeout(handle);
    retries.clear();
    for (const watcher of watchers) watcher.close();
    watchers.clear();
  };
}

export function configTargets(officeHome: string, profilesDir: string): WatchTarget[] {
  return [
    { dir: officeHome, match: (name) => name === 'config.json' || name.startsWith('config.json.') },
    { dir: profilesDir, match: (name) => name.endsWith('.json') },
  ];
}
