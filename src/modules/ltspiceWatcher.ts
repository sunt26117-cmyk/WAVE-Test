/**
 * Waveform Viewer Pro - LTspice Live File Watch & Auto-Reload Manager
 * Uses browser File System Access API (showOpenFilePicker) when available
 * to watch an LTspice `.raw` / `.txt` / `.csv` output file and hot-reload
 * waveform buffers whenever LTspice completes a new simulation run.
 */

export interface WatchedFileEntry {
  tabId: string;
  fileName: string;
  handle: any; // FileSystemFileHandle
  lastModified: number;
  lastSize: number;
  autoReload: boolean;
}

export class LtspiceFileWatcher {
  private watchedByTab = new Map<string, WatchedFileEntry>();
  private timerId: number | null = null;
  private onReloadCallback: (tabId: string, file: File) => Promise<void>;
  private onStatusChangeCallback: () => void;

  constructor(
    onReload: (tabId: string, file: File) => Promise<void>,
    onStatusChange: () => void
  ) {
    this.onReloadCallback = onReload;
    this.onStatusChangeCallback = onStatusChange;
  }

  public static isSupported(): boolean {
    return typeof (window as any).showOpenFilePicker === 'function';
  }

  public async pickAndWatch(tabIdResolver: (file: File) => Promise<string | null>): Promise<{ ok: boolean; reason?: string }> {
    if (!LtspiceFileWatcher.isSupported()) {
      return {
        ok: false,
        reason: 'Live file watch requires File System Access API (Chrome/Edge desktop outside restricted sandbox).',
      };
    }

    try {
      const handles = await (window as any).showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: 'LTspice & Waveform Files (.raw, .txt, .csv)',
            accept: {
              'application/octet-stream': ['.raw'],
              'text/plain': ['.txt', '.csv'],
            },
          },
        ],
      });
      const handle = handles?.[0];
      if (!handle) return { ok: false };

      const file: File = await handle.getFile();
      const tabId = await tabIdResolver(file);
      if (!tabId) return { ok: false };

      this.watchedByTab.set(tabId, {
        tabId,
        fileName: file.name,
        handle,
        lastModified: file.lastModified,
        lastSize: file.size,
        autoReload: true,
      });

      this.ensurePolling();
      this.onStatusChangeCallback();
      return { ok: true };
    } catch (err: any) {
      if (err?.name === 'AbortError') return { ok: false };
      return { ok: false, reason: err?.message || 'Unable to access file handle.' };
    }
  }

  public getEntry(tabId: string | null): WatchedFileEntry | null {
    if (!tabId) return null;
    return this.watchedByTab.get(tabId) || null;
  }

  public toggleAutoReload(tabId: string): boolean {
    const entry = this.watchedByTab.get(tabId);
    if (!entry) return false;
    entry.autoReload = !entry.autoReload;
    this.ensurePolling();
    this.onStatusChangeCallback();
    return entry.autoReload;
  }

  public stopWatching(tabId: string): void {
    this.watchedByTab.delete(tabId);
    if (this.watchedByTab.size === 0 && this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.onStatusChangeCallback();
  }

  public async forceReload(tabId: string): Promise<boolean> {
    const entry = this.watchedByTab.get(tabId);
    if (!entry) return false;
    try {
      const file: File = await entry.handle.getFile();
      entry.lastModified = file.lastModified;
      entry.lastSize = file.size;
      await this.onReloadCallback(tabId, file);
      return true;
    } catch {
      return false;
    }
  }

  private ensurePolling(): void {
    const anyAuto = Array.from(this.watchedByTab.values()).some((e) => e.autoReload);
    if (!anyAuto) {
      if (this.timerId !== null) {
        window.clearInterval(this.timerId);
        this.timerId = null;
      }
      return;
    }
    if (this.timerId !== null) return;

    this.timerId = window.setInterval(async () => {
      for (const entry of this.watchedByTab.values()) {
        if (!entry.autoReload) continue;
        try {
          const file: File = await entry.handle.getFile();
          if (file.lastModified !== entry.lastModified || file.size !== entry.lastSize) {
            entry.lastModified = file.lastModified;
            entry.lastSize = file.size;
            await this.onReloadCallback(entry.tabId, file);
          }
        } catch {
          // Ignore transient lock while LTspice is writing
        }
      }
    }, 1500);
  }
}
