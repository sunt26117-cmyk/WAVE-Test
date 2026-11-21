/**
 * Waveform Viewer Pro - Side-by-Side Non-Overlapping Tool Drawer Manager
 * Intercepts `.modal-overlay.tool-dockable` panels and docks them cleanly into
 * `#toolDrawerContainer` between the oscilloscope canvas bay and right control panel.
 * Supports multiple open tools with tabs, Split-2 stacked view, and left-edge resizing.
 */

const TOOL_TAB_LABELS: Record<string, string> = {
  measureModal: 'Measure',
  compareModal: 'Compare',
  mathModal: 'Math fx',
  bldcModal: 'BLDC Diag',
  phaseModal: 'ΔΦ Phase',
  anomalyModal: 'Scan',
  waveformEditModal: 'Edit / Ref',
  cropExportModal: 'Crop',
  triggerModal: 'Trigger',
  transformModal: '3-Ph / Power',
  motorModal: 'Motor / RPM',
  batchModal: 'Batch',
  presetModal: 'Presets',
  testSuiteModal: 'Self-Test',
  shortcutsModal: 'Shortcuts',
};

class ToolDrawerController {
  private container: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private splitBtn: HTMLButtonElement | null = null;
  private closeAllBtn: HTMLButtonElement | null = null;
  private resizeHandle: HTMLElement | null = null;

  private openIds: string[] = [];
  private activeId: string | null = null;
  private secondaryId: string | null = null;
  private splitMode: boolean = false;
  private drawerWidthPx: number = 440;
  private isSyncing: boolean = false;
  private onLayoutChange?: () => void;

  public init(onLayoutChange?: () => void): void {
    this.onLayoutChange = onLayoutChange;
    this.container = document.getElementById('toolDrawerContainer');
    this.bodyEl = document.getElementById('toolDrawerBody');
    this.stageEl = document.getElementById('toolDrawerInactiveStage');
    this.tabsEl = document.getElementById('toolDrawerTabs');
    this.splitBtn = document.getElementById('toolDrawerSplitBtn') as HTMLButtonElement | null;
    this.closeAllBtn = document.getElementById('toolDrawerCloseAllBtn') as HTMLButtonElement | null;
    this.resizeHandle = document.getElementById('toolDrawerResizeHandle');

    if (!this.container || !this.bodyEl || !this.stageEl || !this.tabsEl) return;

    this.container.style.width = `${this.drawerWidthPx}px`;

    this.splitBtn?.addEventListener('click', () => {
      this.splitMode = !this.splitMode;
      this.syncLayout();
    });

    this.closeAllBtn?.addEventListener('click', () => {
      this.closeAll();
    });

    this.bindResizeHandle();
    this.observeDockables();
  }

  private bindResizeHandle(): void {
    if (!this.resizeHandle || !this.container) return;
    this.resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0 || !this.container) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = this.container.getBoundingClientRect().width || this.drawerWidthPx;

      const onMove = (me: MouseEvent) => {
        if (!this.container) return;
        const delta = startX - me.clientX; // dragging left increases drawer width
        const maxAllowed = Math.min(720, Math.max(360, window.innerWidth - 420));
        const nextW = Math.max(340, Math.min(maxAllowed, Math.round(startW + delta)));
        this.drawerWidthPx = nextW;
        this.container.style.width = `${nextW}px`;
        this.onLayoutChange?.();
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        this.onLayoutChange?.();
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  private observeDockables(): void {
    const dockables = Array.from(document.querySelectorAll('.modal-overlay.tool-dockable')) as HTMLElement[];

    dockables.forEach((el) => {
      const id = el.id;
      if (!id) return;

      const observer = new MutationObserver(() => {
        if (this.isSyncing) return;
        const styleDisplay = el.style.display;

        if (styleDisplay === 'flex' || styleDisplay === 'block') {
          this.handleExternalOpen(id);
        } else if (styleDisplay === 'none') {
          this.handleExternalClose(id);
        }
      });

      observer.observe(el, { attributes: true, attributeFilter: ['style'] });
    });
  }

  private handleExternalOpen(id: string): void {
    if (!this.openIds.includes(id)) {
      this.openIds.push(id);
    }
    if (this.activeId && this.activeId !== id) {
      this.secondaryId = this.activeId;
    }
    this.activeId = id;
    this.syncLayout();
  }

  private handleExternalClose(id: string): void {
    const el = document.getElementById(id) as HTMLElement | null;
    if (el && this.stageEl && el.parentElement !== this.stageEl) {
      this.isSyncing = true;
      this.stageEl.appendChild(el);
      this.isSyncing = false;
    }
    if (!this.openIds.includes(id)) return;
    this.removeOpenId(id);
    this.syncLayout();
  }

  private removeOpenId(id: string): void {
    this.openIds = this.openIds.filter((item) => item !== id);
    if (this.activeId === id) {
      if (this.secondaryId && this.openIds.includes(this.secondaryId)) {
        this.activeId = this.secondaryId;
      } else {
        this.activeId = this.openIds.length > 0 ? this.openIds[this.openIds.length - 1] : null;
      }
    }
    if (this.secondaryId === id || this.secondaryId === this.activeId) {
      this.secondaryId = this.openIds.find((item) => item !== this.activeId) || null;
    }
    if (this.openIds.length < 2) {
      this.splitMode = false;
    }
  }

  public openPanel(id: string): void {
    const el = document.getElementById(id) as HTMLElement | null;
    if (!el) return;
    el.classList.remove('hidden');
    el.style.display = 'flex';
  }

  public closePanel(id: string): void {
    const el = document.getElementById(id) as HTMLElement | null;
    if (el) {
      this.isSyncing = true;
      el.style.display = 'none';
      if (this.stageEl && el.parentElement !== this.stageEl) {
        this.stageEl.appendChild(el);
      }
      this.isSyncing = false;
    }
    this.removeOpenId(id);
    this.syncLayout();
  }

  public closeActive(): boolean {
    if (this.activeId) {
      this.closePanel(this.activeId);
      return true;
    }
    return false;
  }

  public closeAll(): void {
    const copy = [...this.openIds];
    this.isSyncing = true;
    copy.forEach((id) => {
      const el = document.getElementById(id) as HTMLElement | null;
      if (el) {
        el.style.display = 'none';
        if (this.stageEl && el.parentElement !== this.stageEl) {
          this.stageEl.appendChild(el);
        }
      }
    });
    if (this.bodyEl && this.stageEl) {
      Array.from(this.bodyEl.children).forEach((child) => {
        (child as HTMLElement).style.display = 'none';
        this.stageEl!.appendChild(child);
      });
    }
    this.openIds = [];
    this.activeId = null;
    this.secondaryId = null;
    this.splitMode = false;
    this.isSyncing = false;
    this.syncLayout();
  }

  public activateTab(id: string): void {
    if (!this.openIds.includes(id)) return;
    if (this.activeId && this.activeId !== id) {
      this.secondaryId = this.activeId;
    }
    this.activeId = id;
    this.syncLayout();
  }

  private syncLayout(): void {
    if (!this.container || !this.bodyEl || !this.stageEl || !this.tabsEl) return;

    this.isSyncing = true;

    if (this.openIds.length === 0) {
      Array.from(this.bodyEl.children).forEach((child) => {
        (child as HTMLElement).style.display = 'none';
        this.stageEl!.appendChild(child);
      });
      this.container.classList.add('hidden');
      this.tabsEl.innerHTML = '';
      this.isSyncing = false;
      this.onLayoutChange?.();
      return;
    }

    this.container.classList.remove('hidden');

    if (!this.activeId || !this.openIds.includes(this.activeId)) {
      this.activeId = this.openIds[this.openIds.length - 1];
    }

    if (this.openIds.length < 2) {
      this.splitMode = false;
    }

    const visibleIds: string[] = [this.activeId];
    if (this.splitMode && this.openIds.length >= 2) {
      const second =
        this.secondaryId && this.secondaryId !== this.activeId && this.openIds.includes(this.secondaryId)
          ? this.secondaryId
          : this.openIds.find((item) => item !== this.activeId);
      if (second) visibleIds.push(second);
    }

    // Update Split 2 button appearance
    if (this.splitBtn) {
      this.splitBtn.classList.toggle('is-active', this.splitMode);
      this.splitBtn.disabled = this.openIds.length < 2;
      this.splitBtn.title =
        this.openIds.length < 2
          ? 'Open 2 or more tools to stack side-by-side'
          : this.splitMode
          ? 'Switch to single active tool tab'
          : 'Show 2 open tools stacked without overlapping';
    }

    // Evacuate ANY child currently in bodyEl that is not in visibleIds (prevents stale/closed panels)
    Array.from(this.bodyEl.children).forEach((child) => {
      if (!visibleIds.includes(child.id)) {
        if (!this.openIds.includes(child.id)) {
          (child as HTMLElement).style.display = 'none';
        }
        this.stageEl!.appendChild(child);
      }
    });

    // Ensure non-visible open tools stay in stageEl and visible ones are appended in order to bodyEl
    this.openIds.forEach((id) => {
      const el = document.getElementById(id) as HTMLElement | null;
      if (!el) return;
      el.classList.remove('hidden');
      el.style.display = 'flex';
      if (!visibleIds.includes(id)) {
        if (el.parentElement !== this.stageEl) {
          this.stageEl!.appendChild(el);
        }
      }
    });

    visibleIds.forEach((id) => {
      const el = document.getElementById(id) as HTMLElement | null;
      if (!el) return;
      el.classList.remove('hidden');
      el.style.display = 'flex';
      this.bodyEl!.appendChild(el);
    });

    // Render Drawer Tabs
    this.tabsEl.innerHTML = '';
    this.openIds.forEach((id) => {
      const isPrimary = id === this.activeId;
      const isSecondary = visibleIds.includes(id) && !isPrimary;
      const tabBtn = document.createElement('div');
      tabBtn.className = `tool-drawer-tab ${isPrimary ? 'is-active' : isSecondary ? 'is-secondary' : ''}`;
      const label = TOOL_TAB_LABELS[id] || id.replace(/Modal$/, '');
      tabBtn.innerHTML = `
        <button type="button" class="tool-drawer-tab-btn" title="${label}">${label}</button>
        <button type="button" class="tool-drawer-tab-close" title="Close ${label}">×</button>
      `;

      tabBtn.querySelector('.tool-drawer-tab-btn')?.addEventListener('click', () => {
        this.activateTab(id);
      });

      tabBtn.querySelector('.tool-drawer-tab-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closePanel(id);
      });

      this.tabsEl!.appendChild(tabBtn);
    });

    this.isSyncing = false;
    this.onLayoutChange?.();

    visibleIds.forEach((id) => {
      window.dispatchEvent(new CustomEvent('wvp-drawer-panel-shown', { detail: { id } }));
    });
  }
}

const drawerController = new ToolDrawerController();

export function setupToolDrawer(onLayoutChange?: () => void): void {
  drawerController.init(onLayoutChange);
}

export function closeActiveToolDrawerItem(): boolean {
  return drawerController.closeActive();
}

export function closeAllToolDrawerItems(): void {
  drawerController.closeAll();
}

export function openToolDrawerPanel(id: string): void {
  drawerController.openPanel(id);
}
