/**
 * Waveform Viewer Pro - Draggable & Viewport-Clamped Floating Tool Windows
 * - Supports all centered wide workbenches and dynamically undocked tool panels
 * - Allows dragging by header bar within viewport bounds and double-click to recenter
 * - Injects a subtle "停靠右侧" toggle button on dock-capable floating windows
 * - Brings active floating windows to top z-index and notifies internal preview canvases on open
 */

import { dockToolPanel } from './toolDrawer';

const DOCK_TOGGLE_IDS = new Set([
  'thermalModal',
  'compareModal',
  'bldcModal',
  'batchModal',
  'measureModal',
  'mathModal',
  'filterModal',
  'phaseModal',
  'waveformEditModal',
  'anomalyModal',
  'transformModal',
  'motorModal',
  'cropExportModal',
]);

const WIDE_MAXIMIZABLE_IDS = new Set(['thermalModal', 'compareModal', 'bldcModal', 'batchModal']);

export function setupDraggableModals(): void {
  const overlays = Array.from(document.querySelectorAll('.modal-overlay')) as HTMLElement[];
  let topZ = 60;

  const bringToFront = (overlay: HTMLElement) => {
    if (overlay.classList.contains('tool-dockable')) return;
    topZ += 1;
    overlay.style.zIndex = String(topZ);
  };

  overlays.forEach((overlay) => {
    const dialog = overlay.firstElementChild as HTMLElement | null;
    if (!dialog) return;

    let dragX = 0;
    let dragY = 0;
    let baseRect: DOMRect | null = null;

    const resetPosition = () => {
      dragX = 0;
      dragY = 0;
      dialog.style.transform = '';
      dialog.dataset.dragX = '0';
      dialog.dataset.dragY = '0';
    };

    const applyClampedTransform = (nextX: number, nextY: number) => {
      if (overlay.classList.contains('tool-dockable') || overlay.classList.contains('is-canvas-maximized')) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;

      if (!baseRect) {
        const prev = dialog.style.transform;
        dialog.style.transform = '';
        baseRect = dialog.getBoundingClientRect();
        dialog.style.transform = prev;
      }

      const minDx = pad - baseRect.left;
      const maxDx = vw - pad - baseRect.right;
      const minDy = pad - baseRect.top;
      const maxDy = vh - pad - baseRect.bottom;

      const clampedX = minDx <= maxDx ? Math.max(minDx, Math.min(maxDx, nextX)) : 0;
      const clampedY = minDy <= maxDy ? Math.max(minDy, Math.min(maxDy, nextY)) : 0;

      dragX = clampedX;
      dragY = clampedY;
      dialog.style.transform = `translate3d(${Math.round(dragX)}px, ${Math.round(dragY)}px, 0)`;
      dialog.dataset.dragX = String(dragX);
      dialog.dataset.dragY = String(dragY);
    };

    dialog.addEventListener('mousedown', () => {
      bringToFront(overlay);
    });

    // Identify top header bar / title element as drag handle
    const firstChild = dialog.firstElementChild as HTMLElement | null;
    let handle: HTMLElement | null = null;
    if (firstChild && (firstChild.tagName === 'H2' || firstChild.querySelector('h2, h3'))) {
      handle = firstChild;
    }
    if (!handle) {
      const heading = dialog.querySelector('h2, h3') as HTMLElement | null;
      handle = heading?.parentElement || heading;
    }

    const closeBtn = handle
      ? Array.from(handle.querySelectorAll('button')).find(
          (b) => b.textContent?.trim() === '✕' || b.id.toLowerCase().includes('closetop') || b.id === 'mathModalCloseBtn'
        )
      : undefined;

    // Inject "画布全屏" maximize toggle on wide workbench modals (preserves top header)
    let maxBtn: HTMLButtonElement | null = null;
    if (handle && closeBtn && closeBtn.parentElement && overlay.id && WIDE_MAXIMIZABLE_IDS.has(overlay.id)) {
      const existingMax = handle.querySelector('.wvp-maximize-canvas-btn') as HTMLButtonElement | null;
      if (!existingMax) {
        maxBtn = document.createElement('button');
        maxBtn.type = 'button';
        maxBtn.className = 'wvp-maximize-canvas-btn modal-window-action-btn';
        maxBtn.title = '最大化到示波器工作区（保留顶栏）';
        maxBtn.textContent = '⤢ 全屏';
        maxBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const nextMax = !overlay.classList.toggle('is-canvas-maximized');
          resetPosition();
          if (maxBtn) {
            maxBtn.textContent = nextMax ? '⤢ 全屏' : '⤡ 还原';
            maxBtn.title = nextMax ? '最大化到示波器工作区（保留顶栏）' : '还原为居中宽窗';
          }
          window.dispatchEvent(new CustomEvent('wvp-drawer-panel-shown', { detail: { id: overlay.id } }));
        });
        closeBtn.parentElement.insertBefore(maxBtn, closeBtn);
        if (closeBtn.parentElement === handle) {
          maxBtn.style.marginLeft = 'auto';
          maxBtn.style.marginRight = '6px';
        }
      } else {
        maxBtn = existingMax;
      }
    }

    // Inject subtle "停靠右侧" action button on floating wide/undockable windows
    let dockBtn: HTMLButtonElement | null = null;
    if (handle && closeBtn && closeBtn.parentElement && overlay.id && DOCK_TOGGLE_IDS.has(overlay.id)) {
      const existing = handle.querySelector('.wvp-dock-right-btn') as HTMLButtonElement | null;
      if (!existing) {
        dockBtn = document.createElement('button');
        dockBtn.type = 'button';
        dockBtn.className = 'wvp-dock-right-btn modal-window-action-btn';
        dockBtn.title = '停靠到右侧工具抽屉';
        dockBtn.textContent = '⇥ 停靠';
        dockBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          resetPosition();
          dockToolPanel(overlay.id);
        });
        closeBtn.parentElement.insertBefore(dockBtn, closeBtn);
        if (closeBtn.parentElement === handle) {
          if (!maxBtn) dockBtn.style.marginLeft = 'auto';
          dockBtn.style.marginRight = '8px';
        }
      } else {
        dockBtn = existing;
      }
    }

    const syncWindowButtonsVisibility = () => {
      const isDocked = overlay.classList.contains('tool-dockable');
      const isMax = overlay.classList.contains('is-canvas-maximized');
      if (dockBtn) {
        const wideBlocked = WIDE_MAXIMIZABLE_IDS.has(overlay.id) && window.innerWidth < 1680;
        dockBtn.style.display = isDocked || wideBlocked ? 'none' : 'inline-flex';
      }
      if (maxBtn) {
        maxBtn.style.display = isDocked ? 'none' : 'inline-flex';
        maxBtn.textContent = isMax ? '⤡ 还原' : '⤢ 全屏';
      }
    };
    syncWindowButtonsVisibility();

    if (handle) {
      handle.classList.add('modal-drag-handle');
      if (!handle.title) {
        handle.title = '拖动标题栏移动窗口 · 双击居中复位';
      }

      handle.addEventListener('dblclick', (e) => {
        if (overlay.classList.contains('tool-dockable') || overlay.classList.contains('is-canvas-maximized')) return;
        const target = e.target as HTMLElement | null;
        if (target && target.closest('button, input, select, a, label')) return;
        resetPosition();
      });

      handle.addEventListener('mousedown', (e: MouseEvent) => {
        if (overlay.classList.contains('tool-dockable') || overlay.classList.contains('is-canvas-maximized')) return;
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        if (target && target.closest('button, input, select, textarea, a, label')) return;

        e.preventDefault();
        bringToFront(overlay);

        const currentRect = dialog.getBoundingClientRect();
        baseRect = new DOMRect(
          currentRect.left - dragX,
          currentRect.top - dragY,
          currentRect.width,
          currentRect.height
        );

        const startMouseX = e.clientX;
        const startMouseY = e.clientY;
        const startDragX = dragX;
        const startDragY = dragY;

        const onMouseMove = (moveEvt: MouseEvent) => {
          const dx = startDragX + (moveEvt.clientX - startMouseX);
          const dy = startDragY + (moveEvt.clientY - startMouseY);
          applyClampedTransform(dx, dy);
        };

        const onMouseUp = () => {
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    }

    let wasHidden = getComputedStyle(overlay).display === 'none';
    const observer = new MutationObserver(() => {
      syncWindowButtonsVisibility();
      if (overlay.classList.contains('tool-dockable')) {
        wasHidden = overlay.style.display === 'none';
        return;
      }
      const isHidden = overlay.style.display === 'none' || getComputedStyle(overlay).display === 'none';
      if (wasHidden && !isHidden) {
        baseRect = null;
        resetPosition();
        bringToFront(overlay);
        if (overlay.id) {
          requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent('wvp-drawer-panel-shown', { detail: { id: overlay.id } }));
          });
        }
      }
      wasHidden = isHidden;
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['style', 'class'] });

    window.addEventListener('wvp-modal-floated', (ev: Event) => {
      const detail = (ev as CustomEvent<{ id: string }>).detail;
      if (detail?.id === overlay.id) {
        syncWindowButtonsVisibility();
        baseRect = null;
        resetPosition();
        bringToFront(overlay);
      }
    });

    window.addEventListener('resize', () => {
      syncWindowButtonsVisibility();
      if (!overlay.classList.contains('tool-dockable') && getComputedStyle(overlay).display !== 'none' && (dragX !== 0 || dragY !== 0)) {
        baseRect = null;
        applyClampedTransform(dragX, dragY);
      }
    });
  });
}
