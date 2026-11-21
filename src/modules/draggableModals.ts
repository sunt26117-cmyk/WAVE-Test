/**
 * Waveform Viewer Pro - Draggable & Viewport-Clamped Floating Tool Windows
 * - Allows dragging any `.modal-overlay` window by its title/header bar within the main viewport
 * - Automatically resets window position to its default centered layout every time it opens
 * - Brings active/clicked floating windows to top z-index cleanly
 */

export function setupDraggableModals(): void {
  const overlays = Array.from(document.querySelectorAll('.modal-overlay')) as HTMLElement[];
  let topZ = 60;

  const bringToFront = (overlay: HTMLElement) => {
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
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 8;

      if (!baseRect) {
        const prev = dialog.style.transform;
        dialog.style.transform = '';
        baseRect = dialog.getBoundingClientRect();
        dialog.style.transform = prev;
      }

      // Clamp so the dialog stays cleanly inside the current viewport
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

    // Bring window to top when clicking anywhere inside it
    dialog.addEventListener('mousedown', () => {
      bringToFront(overlay);
    });

    // Identify top header bar / title element as drag handle
    const firstChild = dialog.firstElementChild as HTMLElement | null;
    let handle: HTMLElement | null = null;
    if (firstChild) {
      if (firstChild.tagName === 'H2' || firstChild.querySelector('h2')) {
        handle = firstChild;
      }
    }
    if (!handle) {
      const h2 = dialog.querySelector('h2') as HTMLElement | null;
      handle = h2?.parentElement || h2;
    }

    if (handle) {
      handle.classList.add('modal-drag-handle');
      if (!handle.title) {
        handle.title = 'Drag to move · Double-click to reset center';
      }

      // Inject a subtle grip icon into the h2 if not already present
      const h2 = (handle.tagName === 'H2' ? handle : handle.querySelector('h2')) as HTMLElement | null;
      if (h2 && !h2.querySelector('.modal-drag-grip')) {
        const grip = document.createElement('span');
        grip.className = 'modal-drag-grip inline-block text-slate-500 mr-1.5 font-mono tracking-tighter select-none';
        grip.textContent = '⋮⋮';
        h2.prepend(grip);
      }

      handle.addEventListener('dblclick', (e) => {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('button, input, select, a, label')) return;
        resetPosition();
      });

      handle.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement | null;
        // Don't start drag when clicking close buttons, inputs, or selects in header
        if (target && target.closest('button, input, select, textarea, a, label')) return;

        e.preventDefault();
        bringToFront(overlay);

        // Compute centered baseline rect (without current translation) for exact viewport clamping
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

    // Reset to default centered position every time the modal transitions to visible
    let wasHidden = getComputedStyle(overlay).display === 'none';
    const observer = new MutationObserver(() => {
      const isHidden = overlay.style.display === 'none' || getComputedStyle(overlay).display === 'none';
      if (wasHidden && !isHidden) {
        baseRect = null;
        resetPosition();
        bringToFront(overlay);
      }
      wasHidden = isHidden;
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['style', 'class'] });

    // Re-clamp on browser window resize if open
    window.addEventListener('resize', () => {
      if (getComputedStyle(overlay).display !== 'none' && (dragX !== 0 || dragY !== 0)) {
        baseRect = null;
        applyClampedTransform(dragX, dragY);
      }
    });
  });
}
