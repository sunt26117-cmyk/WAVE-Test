/**
 * Waveform Viewer Pro - Side-by-Side Non-Overlapping Tool Drawer Manager
 * - Docks lightweight `.modal-overlay.tool-dockable` panels cleanly into `#toolDrawerContainer`
 * - Supports bidirectional Dock <-> Float switching with wide centered workbenches
 * - Protects oscilloscope viewport width by temporarily collapsing `#rightControlPanel` on <1520px screens
 * - Supports multiple open tabs, Split-2 vertical stacking, and smooth left-edge resizing
 */

import { escapeHtml } from '../utils/html';

const TOOL_TAB_LABELS: Record<string, string> = {
  measureModal: '测量设置',
  compareModal: '多波对比',
  filterModal: '波形滤波',
  thermalModal: 'MOS 热仿真',
  mathModal: '数学通道',
  bldcModal: 'BLDC 诊断',
  phaseModal: '相角差 ΔΦ',
  anomalyModal: '异常扫描',
  waveformEditModal: '编辑与参考',
  cropExportModal: '切片导出',
  transformModal: '三相/功率',
  motorModal: '电机转速',
  batchModal: '批量测量',
  presetModal: '分析预设',
  testSuiteModal: '算法自检',
  shortcutsModal: '快捷键',
};

const DEFAULT_DRAWER_WIDTH = 420;
const MAX_DRAWER_TABS = 3;
const WIDE_WORKBENCH_IDS = new Set(['compareModal', 'bldcModal', 'batchModal', 'thermalModal']);
const PREFERRED_TOOL_WIDTHS: Record<string, number> = {
  measureModal: 420,
  filterModal: 440,
  waveformEditModal: 440,
  anomalyModal: 440,
  compareModal: 520,
  bldcModal: 520,
  batchModal: 540,
  thermalModal: 600,
};

const COMPACT_RIGHT_PANEL_BREAKPOINT_PX = 1680;
const DOCK_CHANNEL_BELOW_BREAKPOINT_PX = 1366;

class ToolDrawerController {
  private container: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private tabsEl: HTMLElement | null = null;
  private splitBtn: HTMLButtonElement | null = null;
  private floatBtn: HTMLButtonElement | null = null;
  private closeAllBtn: HTMLButtonElement | null = null;
  private resizeHandle: HTMLElement | null = null;

  private openIds: string[] = [];
  private activeId: string | null = null;
  private secondaryId: string | null = null;
  private splitMode: boolean = false;
  private drawerWidthPx: number = DEFAULT_DRAWER_WIDTH;
  private panelWidthsPx: Record<string, number> = {};
  private isSyncing: boolean = false;
  private autoCollapsedRightPanel: boolean = false;
  private relocatedChannelInspector: boolean = false;
  private observedIds = new Set<string>();
  private onLayoutChange?: () => void;

  private getTargetWidthForPanel(id: string | null): number {
    const minW = 340;
    const maxW = Math.min(760, Math.max(380, Math.round(window.innerWidth * 0.42)));
    if (!id) return Math.min(maxW, Math.max(minW, DEFAULT_DRAWER_WIDTH));
    const preferred = this.panelWidthsPx[id] ?? PREFERRED_TOOL_WIDTHS[id] ?? DEFAULT_DRAWER_WIDTH;
    return Math.min(maxW, Math.max(minW, preferred));
  }

  public init(onLayoutChange?: () => void): void {
    this.onLayoutChange = onLayoutChange;
    this.container = document.getElementById('toolDrawerContainer');
    this.bodyEl = document.getElementById('toolDrawerBody');
    this.stageEl = document.getElementById('toolDrawerInactiveStage');
    this.tabsEl = document.getElementById('toolDrawerTabs');
    this.splitBtn = document.getElementById('toolDrawerSplitBtn') as HTMLButtonElement | null;
    this.floatBtn = document.getElementById('toolDrawerFloatBtn') as HTMLButtonElement | null;
    this.closeAllBtn = document.getElementById('toolDrawerCloseAllBtn') as HTMLButtonElement | null;
    this.resizeHandle = document.getElementById('toolDrawerResizeHandle');

    if (!this.container || !this.bodyEl || !this.stageEl || !this.tabsEl) return;

    this.container.style.width = `${this.drawerWidthPx}px`;

    this.splitBtn?.addEventListener('click', () => {
      this.splitMode = !this.splitMode;
      this.syncLayout();
    });

    this.floatBtn?.addEventListener('click', () => {
      if (this.activeId) {
        this.undockPanel(this.activeId);
      }
    });

    this.closeAllBtn?.addEventListener('click', () => {
      this.closeAll();
    });

    window.addEventListener('resize', () => {
      if (this.openIds.length > 0) {
        this.syncRightPanelAutoCollapse(true);
        const nextW = this.getTargetWidthForPanel(this.activeId);
        if (this.container) this.container.style.width = `${nextW}px`;
        this.onLayoutChange?.();
      } else if (this.relocatedChannelInspector) {
        this.restoreChannelInspectorToRightPanel();
      }
    });

    this.bindResizeHandle();
    this.observeAllManagedModals();
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
        const delta = startX - me.clientX;
        const maxAllowed = Math.min(820, Math.max(400, window.innerWidth - 360));
        const nextW = Math.max(340, Math.min(maxAllowed, Math.round(startW + delta)));
        this.drawerWidthPx = nextW;
        if (this.activeId) this.panelWidthsPx[this.activeId] = nextW;
        this.container.style.width = `${nextW}px`;
        this.onLayoutChange?.();
        window.dispatchEvent(new CustomEvent('wvp-drawer-resized', { detail: { id: this.activeId, width: nextW } }));
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        this.onLayoutChange?.();
        window.dispatchEvent(new CustomEvent('wvp-drawer-resized', { detail: { id: this.activeId, width: this.drawerWidthPx } }));
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  private observeElement(el: HTMLElement): void {
    const id = el.id;
    if (!id || this.observedIds.has(id)) return;
    this.observedIds.add(id);

    const observer = new MutationObserver(() => {
      if (this.isSyncing) return;
      if (!el.classList.contains('tool-dockable')) return;
      const styleDisplay = el.style.display;
      if (styleDisplay === 'flex' || styleDisplay === 'block') {
        this.handleExternalOpen(id);
      } else if (styleDisplay === 'none') {
        this.handleExternalClose(id);
      }
    });

    observer.observe(el, { attributes: true, attributeFilter: ['style'] });
  }

  private observeAllManagedModals(): void {
    const modals = Array.from(document.querySelectorAll('.modal-overlay.tool-dockable, .modal-overlay.tool-wide-modal')) as HTMLElement[];
    modals.forEach((el) => this.observeElement(el));
  }

  private handleExternalOpen(id: string): void {
    if (!this.openIds.includes(id)) {
      if (this.openIds.length >= MAX_DRAWER_TABS) {
        const evictId = this.openIds.find((item) => item !== this.activeId) || this.openIds[0];
        if (evictId) {
          const evictEl = document.getElementById(evictId) as HTMLElement | null;
          if (evictEl) {
            this.isSyncing = true;
            evictEl.style.display = 'none';
            if (this.stageEl && evictEl.parentElement !== this.stageEl) {
              this.stageEl.appendChild(evictEl);
            }
            this.isSyncing = false;
          }
          this.removeOpenId(evictId);
          const evictLabel = TOOL_TAB_LABELS[evictId] || evictId.replace(/Modal$/, '');
          window.dispatchEvent(
            new CustomEvent('wvp-drawer-notify', {
              detail: { message: `工具抽屉最多同时保留 ${MAX_DRAWER_TABS} 个标签，已自动收起「${evictLabel}」。`, level: 'info' },
            })
          );
        }
      }
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
    if (el && el.classList.contains('tool-dockable') && this.stageEl && el.parentElement !== this.stageEl) {
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

  private restoreChannelInspectorToRightPanel(): void {
    const rightPanel = document.getElementById('rightControlPanel');
    const chSec = document.getElementById('channelInspectorSection');
    if (rightPanel && chSec && chSec.parentElement !== rightPanel) {
      rightPanel.insertBefore(chSec, rightPanel.firstChild);
    }
    this.relocatedChannelInspector = false;
  }

  private syncRightPanelAutoCollapse(drawerOpen: boolean): void {
    const rightPanel = document.getElementById('rightControlPanel');
    const toggleBtn = document.getElementById('togglePanelBtn');
    const chSec = document.getElementById('channelInspectorSection');
    const compactSlot = document.getElementById('compactChannelDockSlot');
    if (!rightPanel) return;

    if (drawerOpen) {
      const vw = window.innerWidth;
      if (vw < DOCK_CHANNEL_BELOW_BREAKPOINT_PX) {
        // <1366px: Relocate live channel inspector (same DOM node, all IDs/listeners intact) under softkeys
        rightPanel.classList.remove('is-compact-channel-only');
        if (chSec && compactSlot && chSec.parentElement !== compactSlot) {
          compactSlot.appendChild(chSec);
          this.relocatedChannelInspector = true;
        }
        if (!rightPanel.classList.contains('hidden')) {
          rightPanel.classList.add('hidden');
          this.autoCollapsedRightPanel = true;
          if (toggleBtn) toggleBtn.innerText = '展开面板';
        }
      } else if (vw < COMPACT_RIGHT_PANEL_BREAKPOINT_PX) {
        // 1366..1679px: Keep right panel visible in compact channel-only mode (preserves V/div, Offset, Δt)
        this.restoreChannelInspectorToRightPanel();
        if (this.autoCollapsedRightPanel) {
          rightPanel.classList.remove('hidden');
          this.autoCollapsedRightPanel = false;
          if (toggleBtn) toggleBtn.innerText = '收起面板';
        }
        rightPanel.classList.add('is-compact-channel-only');
      } else {
        // >=1680px: Full right panel + drawer side by side
        this.restoreChannelInspectorToRightPanel();
        rightPanel.classList.remove('is-compact-channel-only');
        if (this.autoCollapsedRightPanel) {
          rightPanel.classList.remove('hidden');
          this.autoCollapsedRightPanel = false;
          if (toggleBtn) toggleBtn.innerText = '收起面板';
        }
      }
    } else {
      this.restoreChannelInspectorToRightPanel();
      rightPanel.classList.remove('is-compact-channel-only');
      if (this.autoCollapsedRightPanel) {
        rightPanel.classList.remove('hidden');
        this.autoCollapsedRightPanel = false;
        if (toggleBtn) toggleBtn.innerText = '收起面板';
      }
    }
  }

  public dockPanel(id: string): void {
    const el = document.getElementById(id) as HTMLElement | null;
    if (!el) return;
    if (WIDE_WORKBENCH_IDS.has(id) && window.innerWidth < COMPACT_RIGHT_PANEL_BREAKPOINT_PX) {
      window.dispatchEvent(
        new CustomEvent('wvp-drawer-notify', {
          detail: { message: '当前屏幕宽度小于 1680px，宽屏工作台保持悬浮以避免挤压示波器画布。', level: 'warn' },
        })
      );
      return;
    }
    this.observeElement(el);
    this.isSyncing = true;
    el.classList.remove('is-canvas-maximized');
    el.classList.add('tool-dockable');
    el.dataset.canDockToggle = '1';
    const dialog = el.firstElementChild as HTMLElement | null;
    if (dialog) dialog.style.transform = '';
    el.classList.remove('hidden');
    el.style.display = 'flex';
    this.isSyncing = false;
    this.handleExternalOpen(id);
  }

  public undockPanel(id: string): void {
    const el = document.getElementById(id) as HTMLElement | null;
    if (!el) return;
    this.isSyncing = true;
    el.classList.remove('tool-dockable');
    el.dataset.canDockToggle = '1';
    if (el.parentElement !== document.body) {
      document.body.appendChild(el);
    }
    el.classList.remove('hidden');
    el.style.display = 'flex';
    el.style.zIndex = 'var(--z-floating, 75)';
    this.isSyncing = false;

    this.removeOpenId(id);
    this.syncLayout();
    window.dispatchEvent(new CustomEvent('wvp-modal-floated', { detail: { id } }));
    window.dispatchEvent(new CustomEvent('wvp-drawer-panel-shown', { detail: { id } }));
  }

  public hasOpenTabs(): boolean {
    return this.openIds.length > 0;
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
      if (el.classList.contains('tool-dockable') && this.stageEl && el.parentElement !== this.stageEl) {
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
      this.container.classList.remove('flex');
      this.tabsEl.innerHTML = '';
      this.syncRightPanelAutoCollapse(false);
      this.isSyncing = false;
      this.onLayoutChange?.();
      return;
    }

    this.syncRightPanelAutoCollapse(true);
    this.container.classList.remove('hidden');
    this.container.classList.add('flex');

    if (!this.activeId || !this.openIds.includes(this.activeId)) {
      this.activeId = this.openIds[this.openIds.length - 1];
    }

    if (this.openIds.length < 2) {
      this.splitMode = false;
    }

    const nextW = this.getTargetWidthForPanel(this.activeId);
    this.drawerWidthPx = nextW;
    this.container.style.width = `${nextW}px`;

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
          ? '打开 2 个及以上工具时可上下分屏显示'
          : this.splitMode
          ? '切换回单工具标签显示'
          : '上下分屏同时显示 2 个工具';
    }

    // Evacuate ANY child currently in bodyEl that is not in visibleIds
    Array.from(this.bodyEl.children).forEach((child) => {
      if (!visibleIds.includes(child.id)) {
        if (!this.openIds.includes(child.id)) {
          (child as HTMLElement).style.display = 'none';
        }
        this.stageEl!.appendChild(child);
      }
    });

    // Keep non-visible open tools in stageEl and visible ones in bodyEl
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
      const label = escapeHtml(TOOL_TAB_LABELS[id] || id.replace(/Modal$/, ''));
      tabBtn.innerHTML = `
        <button type="button" class="tool-drawer-tab-btn" title="${label}">${label}</button>
        <button type="button" class="tool-drawer-tab-close" title="关闭 ${label}">×</button>
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

export function hasOpenToolDrawer(): boolean {
  return drawerController.hasOpenTabs();
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

export function dockToolPanel(id: string): void {
  drawerController.dockPanel(id);
}

export function undockToolPanel(id: string): void {
  drawerController.undockPanel(id);
}
