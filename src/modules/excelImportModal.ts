/**
 * Waveform Viewer Pro - Multi-Sheet Excel (.xlsx / .xls) Import Modal Controller
 * Supports Main Open/Drop (Separate Tabs | Merge Tab), Compare Group (direct add),
 * and Batch Multi-File Measure (unified file list + "Apply rules to remaining files").
 * Always releases cached SheetJS workbook objects on close, Esc, or import completion.
 */

import {
  ExcelWorkbookSession,
  ExcelSheetPreview,
  openExcelWorkbookSession,
  recomputeExcelSheetPreview,
  applyExcelRulesToTargetSession,
  syncExcelColumnRuleAcrossSheets,
  parseExcelSheetToChannels,
  releaseExcelWorkbookSession,
} from '../parsers/excelParser';
import { WaveformChannel, SamplingMetadata } from '../types/models';
import { formatEng } from '../engine/canvasRenderer';
import { escapeHtml } from '../utils/html';
import type { ExcelMergeTimeMode } from './excelTimeAlignment';

export type ExcelImportMode = 'main' | 'compare' | 'batch';

export interface ExcelImportedSheetPayload {
  file: File;
  fileName: string;
  fileSizeBytes: number;
  fingerprint: string;
  sheetIndex: number;
  sheetName: string;
  channels: Record<string, WaveformChannel>;
  drawOrder: string[];
  quality: SamplingMetadata;
  skippedEmptyColumns: string[];
  timeOriginSec: number | null;
  timeOriginKind: 'absolute-date' | 'clock-of-day' | 'numeric' | 'synthetic';
}

export interface ExcelModalConfirmResult {
  mode: ExcelImportMode;
  tabDisposition: 'separate' | 'merge';
  timeAlignment: ExcelMergeTimeMode;
  resample: boolean;
  items: ExcelImportedSheetPayload[];
}

export interface OpenExcelModalOptions {
  mode: ExcelImportMode;
  files: File[];
  colors: string[];
  onConfirm: (result: ExcelModalConfirmResult) => Promise<void> | void;
  onCancel?: () => void;
  onNotify?: (message: string, type: 'info' | 'warn' | 'error') => void;
}

class ExcelImportModalController {
  private sessions: ExcelWorkbookSession[] = [];
  private activeSessionIndex: number = 0;
  private mode: ExcelImportMode = 'main';
  private tabDisposition: 'separate' | 'merge' = 'separate';
  private timeAlignment: ExcelMergeTimeMode = 'auto-best';
  private colors: string[] = ['#facc15', '#22d3ee', '#f472b6', '#4ade80'];
  private onConfirmCb: ((res: ExcelModalConfirmResult) => Promise<void> | void) | null = null;
  private onCancelCb: (() => void) | null = null;
  private onNotifyCb: ((msg: string, type: 'info' | 'warn' | 'error') => void) | null = null;
  private listenersBound: boolean = false;

  public async open(opts: OpenExcelModalOptions): Promise<void> {
    this.releaseAllSessions();

    this.mode = opts.mode;
    this.tabDisposition = opts.files.length > 1 ? 'merge' : 'separate';
    this.timeAlignment = 'auto-best';
    this.colors = opts.colors.length > 0 ? opts.colors : ['#facc15', '#22d3ee', '#f472b6', '#4ade80'];
    this.onConfirmCb = opts.onConfirm;
    this.onCancelCb = opts.onCancel || null;
    this.onNotifyCb = opts.onNotify || null;

    const modal = document.getElementById('excelImportModal');
    if (!modal) return;

    try {
      const opened: ExcelWorkbookSession[] = [];
      for (const file of opts.files) {
        const s = await openExcelWorkbookSession(file);
        opened.push(s);
      }
      if (opened.length === 0) {
        opts.onCancel?.();
        return;
      }
      this.sessions = opened;
      this.activeSessionIndex = 0;

      this.bindStaticEvents();
      modal.style.display = 'flex';
      this.render();
    } catch (err: any) {
      this.releaseAllSessions();
      opts.onNotify?.(`Excel 解析失败：${err?.message || err}`, 'error');
      opts.onCancel?.();
    }
  }

  public isOpen(): boolean {
    const modal = document.getElementById('excelImportModal');
    return !!modal && modal.style.display === 'flex';
  }

  public closeAndRelease(invokeCancel: boolean = true): void {
    const modal = document.getElementById('excelImportModal');
    if (modal) modal.style.display = 'none';
    this.releaseAllSessions();
    const cancel = this.onCancelCb;
    this.onConfirmCb = null;
    this.onCancelCb = null;
    if (invokeCancel) cancel?.();
  }

  private releaseAllSessions(): void {
    for (const s of this.sessions) {
      releaseExcelWorkbookSession(s);
    }
    this.sessions = [];
    this.activeSessionIndex = 0;
  }

  private getActiveSession(): ExcelWorkbookSession | null {
    return this.sessions[this.activeSessionIndex] || null;
  }

  private getActiveSheet(): ExcelSheetPreview | null {
    const s = this.getActiveSession();
    if (!s) return null;
    return s.sheets[s.activeSheetIndex] || s.sheets[0] || null;
  }

  private bindStaticEvents(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;

    document.getElementById('xlsCloseTopBtn')?.addEventListener('click', () => this.closeAndRelease(true));
    document.getElementById('xlsCancelBtn')?.addEventListener('click', () => this.closeAndRelease(true));

    document.getElementById('xlsSheetsAllBtn')?.addEventListener('click', () => {
      const s = this.getActiveSession();
      if (!s) return;
      s.sheets.forEach((sh) => {
        if (sh.totalRows > 0 && sh.totalCols > 0) sh.selected = true;
      });
      this.render();
    });

    document.getElementById('xlsSheetsNumericBtn')?.addEventListener('click', () => {
      const s = this.getActiveSession();
      if (!s) return;
      s.sheets.forEach((sh) => {
        sh.selected = sh.hasNumericData && sh.columnMappings.some((m) => m.role === 'channel');
      });
      this.render();
    });

    document.getElementById('xlsSheetsNoneBtn')?.addEventListener('click', () => {
      const s = this.getActiveSession();
      if (!s) return;
      s.sheets.forEach((sh) => {
        sh.selected = false;
      });
      this.render();
    });

    document.getElementById('xlsApplyRulesBatchBtn')?.addEventListener('click', () => {
      const src = this.getActiveSession();
      if (!src || this.sessions.length <= 1) return;
      let updated = 0;
      this.sessions.forEach((tgt, idx) => {
        if (idx === this.activeSessionIndex) return;
        applyExcelRulesToTargetSession(src, tgt);
        updated++;
      });
      this.render();
      this.onNotifyCb?.(`已将当前 Sheet 与表头规则应用到其余 ${updated} 个 Excel 文件。`, 'info');
    });

    document.getElementById('xlsSyncAllColsNowBtn')?.addEventListener('click', () => {
      const s = this.getActiveSession();
      const sh = this.getActiveSheet();
      if (!s || !sh) return;
      const count = syncExcelColumnRuleAcrossSheets(
        this.sessions,
        this.activeSessionIndex,
        sh.sheetIndex,
        { checkedOnly: true }
      );
      this.render();
      this.onNotifyCb?.(
        count > 0
          ? `已将 [${sh.sheetName}] 的列规则同步到其余 ${count} 个已选 Sheet。`
          : '没有其他需要更新的已选 Sheet。',
        'info'
      );
    });

    document.getElementById('xlsTabSeparateBtn')?.addEventListener('click', () => {
      this.tabDisposition = 'separate';
      this.renderModeFooter();
    });

    document.getElementById('xlsTabMergeBtn')?.addEventListener('click', () => {
      this.tabDisposition = 'merge';
      this.renderModeFooter();
    });

    document.getElementById('xlsMergeTimeModeSelect')?.addEventListener('change', (e: any) => {
      const value = String(e.target?.value || 'auto-best');
      this.timeAlignment =
        value === 'align-start' ? 'align-start' : value === 'preserve' ? 'preserve' : 'auto-best';
      this.renderModeFooter();
    });

    document.getElementById('xlsHeaderNoneChk')?.addEventListener('change', (e: any) => {
      const s = this.getActiveSession();
      const sh = this.getActiveSheet();
      if (!s || !sh) return;
      const isNone = !!e.target.checked;
      const nextHdr = isNone ? null : Math.max(0, sh.firstDataRow - 1);
      recomputeExcelSheetPreview(s, sh.sheetIndex, { headerRow: nextHdr });
      this.render();
    });

    document.getElementById('xlsHeaderRowInput')?.addEventListener('change', (e: any) => {
      const s = this.getActiveSession();
      const sh = this.getActiveSheet();
      if (!s || !sh) return;
      const oneBased = parseInt(e.target.value, 10);
      const nextHdr = isFinite(oneBased) && oneBased >= 1 ? oneBased - 1 : null;
      const nextData =
        nextHdr !== null && sh.firstDataRow <= nextHdr ? Math.min(Math.max(0, sh.totalRows - 1), nextHdr + 1) : sh.firstDataRow;
      recomputeExcelSheetPreview(s, sh.sheetIndex, {
        headerRow: nextHdr,
        firstDataRow: nextData,
      });
      this.render();
    });

    document.getElementById('xlsFirstDataRowInput')?.addEventListener('change', (e: any) => {
      const s = this.getActiveSession();
      const sh = this.getActiveSheet();
      if (!s || !sh) return;
      const oneBased = Math.max(1, parseInt(e.target.value, 10) || 1);
      const nextData = oneBased - 1;
      const nextHdr = nextData === 0 ? null : Math.max(0, nextData - 1);
      recomputeExcelSheetPreview(s, sh.sheetIndex, {
        headerRow: nextHdr,
        firstDataRow: nextData,
      });
      this.render();
    });

    document.getElementById('xlsTimeUnitSelect')?.addEventListener('change', (e: any) => {
      const s = this.getActiveSession();
      const sh = this.getActiveSheet();
      if (!s || !sh) return;
      const unit = (e.target.value as 's' | 'ms' | 'us' | 'ns' | 'ps') || 's';
      recomputeExcelSheetPreview(s, sh.sheetIndex, {
        timeColIndex: sh.timeColIndex,
        timeUnit: unit,
        preserveColumnRoles: true,
      });
      this.render();
    });

    document.getElementById('xlsSampleRateSelect')?.addEventListener('change', (e: any) => {
      const s = this.getActiveSession();
      const sh = this.getActiveSheet();
      if (!s || !sh) return;
      const val = e.target.value;
      const customInp = document.getElementById('xlsCustomRateInput') as HTMLInputElement;
      let overrideFs: number | null = null;
      if (val === 'auto') {
        overrideFs = null;
        customInp?.classList.add('hidden');
      } else if (val === 'custom') {
        customInp?.classList.remove('hidden');
        const cur = parseFloat(customInp?.value || '10000');
        overrideFs = isFinite(cur) && cur > 0 ? cur : 10000;
        if (customInp) customInp.value = String(overrideFs);
      } else {
        overrideFs = Number(val);
        customInp?.classList.add('hidden');
      }
      recomputeExcelSheetPreview(s, sh.sheetIndex, {
        timeColIndex: sh.timeColIndex,
        timeUnit: sh.timeUnit,
        sampleRateOverrideHz: overrideFs,
        preserveColumnRoles: true,
      });
      this.render();
    });

    document.getElementById('xlsCustomRateInput')?.addEventListener('change', (e: any) => {
      const s = this.getActiveSession();
      const sh = this.getActiveSheet();
      if (!s || !sh) return;
      const val = parseFloat(e.target.value);
      const overrideFs = isFinite(val) && val > 0 ? val : null;
      recomputeExcelSheetPreview(s, sh.sheetIndex, {
        timeColIndex: sh.timeColIndex,
        timeUnit: sh.timeUnit,
        sampleRateOverrideHz: overrideFs,
        preserveColumnRoles: true,
      });
      this.render();
    });

    document.getElementById('xlsLoadOriginalBtn')?.addEventListener('click', () => {
      void this.confirmImport(false);
    });
    document.getElementById('xlsPrimaryConfirmBtn')?.addEventListener('click', () => {
      void this.confirmImport(this.mode === 'main');
    });
  }

  private async confirmImport(resample: boolean): Promise<void> {
    if (this.sessions.length === 0) return;

    const items: ExcelImportedSheetPayload[] = [];
    const errors: string[] = [];

    for (const session of this.sessions) {
      const checkedSheets = session.sheets.filter((sh) => sh.selected);
      for (const sh of checkedSheets) {
        try {
          const parsed = parseExcelSheetToChannels(session, sh.sheetIndex, {
            resample,
            colors: this.colors,
            idPrefix: `xls_${session.id}_s${sh.sheetIndex}`,
          });
          items.push({
            file: session.file!,
            fileName: session.fileName,
            fileSizeBytes: session.fileSizeBytes,
            fingerprint: session.fingerprint,
            sheetIndex: sh.sheetIndex,
            sheetName: parsed.sheetName,
            channels: parsed.channels,
            drawOrder: parsed.drawOrder,
            quality: parsed.quality,
            skippedEmptyColumns: parsed.skippedEmptyColumns,
            timeOriginSec: parsed.timeOriginSec,
            timeOriginKind: parsed.timeOriginKind,
          });
        } catch (err: any) {
          errors.push(`${session.fileName} [${sh.sheetName}]: ${err?.message || err}`);
        }
      }
    }

    if (items.length === 0) {
      this.onNotifyCb?.(
        errors[0] || '请至少勾选一个包含有效数值通道的工作表 (Sheet)。',
        'warn'
      );
      return;
    }

    if (errors.length > 0) {
      this.onNotifyCb?.(`部分工作表已跳过：${errors[0]}`, 'warn');
    }

    const cb = this.onConfirmCb;
    const result: ExcelModalConfirmResult = {
      mode: this.mode,
      tabDisposition: this.tabDisposition,
      timeAlignment: this.timeAlignment,
      resample,
      items,
    };

    // Immediately hide modal and release all cached SheetJS workbooks to free RAM
    const modal = document.getElementById('excelImportModal');
    if (modal) modal.style.display = 'none';
    this.releaseAllSessions();
    this.onConfirmCb = null;
    this.onCancelCb = null;

    if (cb) {
      await cb(result);
    }
  }

  private render(): void {
    const session = this.getActiveSession();
    const sheet = this.getActiveSheet();
    if (!session) return;

    const subtitleEl = document.getElementById('xlsModalSubtitle');
    if (subtitleEl) {
      const modeTag =
        this.mode === 'compare'
          ? '波形对比模式 · 选择要加入队列的工作表'
          : this.mode === 'batch'
          ? `批量测量模式 · 共 ${this.sessions.length} 个工作簿`
          : '自动识别表头 · 前 100 行预览 · 支持多工作表导入';
      subtitleEl.innerText = `${session.fileName} · ${modeTag}`;
    }

    // Batch / Multi-file workbook bar
    const multiBar = document.getElementById('xlsMultiFileBar');
    const filePills = document.getElementById('xlsFilePillsWrap');
    const applyRulesBtn = document.getElementById('xlsApplyRulesBatchBtn');
    if (multiBar && filePills) {
      if (this.sessions.length > 1) {
        multiBar.classList.remove('hidden');
        multiBar.classList.add('flex');
        if (applyRulesBtn) {
          applyRulesBtn.classList.toggle('hidden', false);
        }
        filePills.innerHTML = '';
        this.sessions.forEach((s, idx) => {
          const selCount = s.sheets.filter((sh) => sh.selected).length;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className =
            idx === this.activeSessionIndex
              ? 'wvp-btn-primary px-2 py-1 text-[11px] font-mono whitespace-nowrap'
              : 'wvp-btn px-2 py-1 text-[11px] font-mono whitespace-nowrap';
          btn.innerText = `${s.fileName} (${selCount}/${s.sheets.length})`;
          btn.addEventListener('click', () => {
            this.activeSessionIndex = idx;
            this.render();
          });
          filePills.appendChild(btn);
        });
      } else {
        multiBar.classList.add('hidden');
        multiBar.classList.remove('flex');
      }
    }

    // Left: Sheet Checklist
    const sheetListEl = document.getElementById('xlsSheetsList');
    const checkedBadge = document.getElementById('xlsCheckedCountBadge');
    const totalSelectedAllFiles = this.sessions.reduce(
      (acc, s) => acc + s.sheets.filter((sh) => sh.selected).length,
      0
    );
    if (checkedBadge) {
      checkedBadge.innerText = `已选 ${totalSelectedAllFiles} 个`;
    }

    if (sheetListEl) {
      sheetListEl.innerHTML = '';
      session.sheets.forEach((sh) => {
        const isActive = sh.sheetIndex === session.activeSheetIndex;
        const chCount = sh.columnMappings.filter((m) => m.role === 'channel').length;
        const item = document.createElement('div');
        item.className = `p-2 rounded-xs border cursor-pointer transition text-xs ${
          isActive
            ? 'bg-accent/15 border-accent/70'
            : 'bg-well border-line hover:border-line-strong'
        }`;
        const hdrStr = sh.headerRow !== null ? `表头 R${sh.headerRow + 1}` : '无表头 (Col A..)';
        const statusMeta = sh.hasNumericData
          ? `${sh.totalRows.toLocaleString()}行 × ${chCount}通道 · ${hdrStr} · 数据 R${sh.firstDataRow + 1}`
          : `${sh.totalRows}行 · 无数值/空表`;

        item.innerHTML = `
          <div class="flex items-center justify-between gap-1.5">
            <label class="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
              <input type="checkbox" class="xls-sheet-chk accent-cyan-400 cursor-pointer shrink-0" ${sh.selected ? 'checked' : ''} />
              <span class="font-mono font-semibold truncate ${sh.hasNumericData ? 'text-fg' : 'text-fg-muted'}" title="${escapeHtml(sh.sheetName)}">${escapeHtml(sh.sheetName)}</span>
            </label>
            ${sh.timeSourceKind === 'excel-date' ? '<span class="px-1 py-0.2 wvp-alert-warn border font-mono text-[10px] rounded-xs shrink-0">日期</span>' : ''}
          </div>
          <div class="text-[10px] font-mono mt-1 pl-5 truncate ${sh.hasNumericData ? 'text-fg-secondary' : 'text-fg-muted'}">${escapeHtml(statusMeta)}</div>
        `;

        const chk = item.querySelector('.xls-sheet-chk') as HTMLInputElement;
        chk?.addEventListener('click', (e) => e.stopPropagation());
        chk?.addEventListener('change', () => {
          sh.selected = chk.checked;
          this.render();
        });
        item.addEventListener('click', () => {
          session.activeSheetIndex = sh.sheetIndex;
          this.render();
        });
        sheetListEl.appendChild(item);
      });
    }

    // Right: Active Sheet Controls & Preview Table
    if (sheet) {
      this.renderSheetInspector(session, sheet);
    }

    this.renderModeFooter();
  }

  private renderSheetInspector(session: ExcelWorkbookSession, sh: ExcelSheetPreview): void {
    const hdrChk = document.getElementById('xlsHeaderNoneChk') as HTMLInputElement;
    const hdrInp = document.getElementById('xlsHeaderRowInput') as HTMLInputElement;
    const dataInp = document.getElementById('xlsFirstDataRowInput') as HTMLInputElement;
    const unitSel = document.getElementById('xlsTimeUnitSelect') as HTMLSelectElement;
    const rateSel = document.getElementById('xlsSampleRateSelect') as HTMLSelectElement;
    const customRateInp = document.getElementById('xlsCustomRateInput') as HTMLInputElement;

    if (hdrChk) hdrChk.checked = sh.headerRow === null;
    if (hdrInp) {
      hdrInp.disabled = sh.headerRow === null;
      hdrInp.value = sh.headerRow !== null ? String(sh.headerRow + 1) : '';
    }
    if (dataInp) {
      dataInp.value = String(sh.firstDataRow + 1);
      dataInp.max = String(Math.max(1, sh.totalRows));
    }
    if (unitSel) {
      unitSel.value = sh.timeUnit;
      unitSel.disabled = sh.timeSourceKind === 'excel-date' || sh.timeSourceKind === 'clock-string';
    }
    if (rateSel && customRateInp) {
      if (!sh.sampleRateOverrideHz) {
        rateSel.value = 'auto';
        customRateInp.classList.add('hidden');
      } else {
        const match = Array.from(rateSel.options).find(
          (o) => o.value !== 'auto' && o.value !== 'custom' && Math.abs(Number(o.value) - sh.sampleRateOverrideHz!) < 1e-3
        );
        if (match) {
          rateSel.value = match.value;
          customRateInp.classList.add('hidden');
        } else {
          rateSel.value = 'custom';
          customRateInp.classList.remove('hidden');
          if (document.activeElement !== customRateInp) {
            customRateInp.value = String(sh.sampleRateOverrideHz);
          }
        }
      }
    }

    const auditEl = document.getElementById('xlsAuditBanner');
    if (auditEl) {
      const chActive = sh.columnMappings.filter((m) => m.role === 'channel').length;
      const textSkipped = sh.columnMappings.filter((m) => m.isTextColumn).length;
      const timeBadge =
        sh.timeSourceKind === 'excel-date'
          ? '<span style="color:var(--warn)">时间: Excel 日期 → 相对秒 (t₀=0)</span>'
          : sh.timeSourceKind === 'clock-string'
          ? '<span style="color:var(--warn)">时间: 时间字符串 → 相对秒 (t₀=0)</span>'
          : sh.timeColIndex >= 0
          ? `<span class="text-accent">时间: 列 ${sh.columnMappings[sh.timeColIndex]?.colLetter || ''} (${sh.timeUnit})${sh.sampleRateOverrideHz ? ` · 按目标间隔抽取原始行 ${formatEng(sh.sampleRateOverrideHz, 'Sa/s', 2)}` : ' · 全量原始时间'}</span>`
          : '<span class="text-fg-muted">时间: 索引 / 手动采样率</span>';

      const measuredRateStr = sh.quality?.sampleRate ? formatEng(sh.quality.sampleRate, 'Sa/s', 2) : 'N/A';
      const rateStr = sh.sampleRateOverrideHz && sh.timeColIndex >= 0
        ? `${measuredRateStr} (目标 ${formatEng(sh.sampleRateOverrideHz, 'Sa/s', 2)}${sh.quality?.decimationCountEstimated ? ', 预览估算' : ''})`
        : measuredRateStr;
      const durStr =
        sh.quality && isFinite(sh.quality.originalTimeEnd - sh.quality.originalTimeStart)
          ? formatEng(sh.quality.originalTimeEnd - sh.quality.originalTimeStart, 's', 3)
          : '--';
      const previewNotice =
        sh.totalRows > sh.previewRowCount
          ? `预览前 ${sh.previewRowCount} / 共 ${sh.totalRows.toLocaleString()} 行`
          : `共 ${sh.totalRows} 行`;

      auditEl.innerHTML = `
        <span>${timeBadge}</span>
        <span>采样率: <strong class="text-fg">${rateStr}</strong></span>
        <span>时长: <strong class="text-fg">${durStr}</strong></span>
        <span>通道: <strong style="color:var(--ok)">${chActive}</strong>${textSkipped > 0 ? ` <span class="text-fg-muted">(${textSkipped} 文本列已跳过)</span>` : ''}</span>
        <span class="text-fg-muted ml-auto">${previewNotice}</span>
      `;
    }

    const wrap = document.getElementById('xlsPreviewTableWrap');
    if (!wrap) return;

    if (sh.totalCols === 0 || sh.previewRowCount === 0) {
      wrap.innerHTML = '<div class="p-6 text-center text-xs font-mono text-fg-muted">当前工作表为空。</div>';
      return;
    }

    let html = '<table class="min-w-full text-[11px] font-mono border-collapse tabular-nums">';
    html += '<thead class="bg-elevated text-fg sticky top-0 z-10"><tr>';
    html += '<th class="px-2 py-1.5 border border-line text-fg-muted text-center w-12">行</th>';

    sh.columnMappings.forEach((col, cIdx) => {
      const isTime = col.role === 'time';
      const isIgn = col.role === 'ignore';
      const thCls = isTime
        ? 'wvp-alert-warn'
        : isIgn
        ? 'text-fg-muted bg-well'
        : 'text-accent';
      const textBadge = col.isTextColumn
        ? '<span class="ml-1 px-1 bg-well border border-line text-fg-muted text-[10px] rounded-xs">文本</span>'
        : '';
      html += `<th class="p-1.5 border border-line text-left align-top min-w-[132px] ${thCls}">
        <div class="flex items-center justify-between gap-1 mb-1">
          <span class="truncate max-w-[110px]" title="${escapeHtml(col.header)}">${escapeHtml(col.colLetter)}: ${escapeHtml(col.header)}</span>${textBadge}
        </div>
        <div class="flex items-center gap-1">
          <select class="xls-col-role-sel flex-1 min-w-0 text-[10px] bg-input border border-line rounded-xs px-1 py-0.5 text-fg cursor-pointer" data-col="${cIdx}">
            <option value="time" ${col.role === 'time' ? 'selected' : ''}>时间</option>
            <option value="channel" ${col.role === 'channel' ? 'selected' : ''}>通道</option>
            <option value="ignore" ${col.role === 'ignore' ? 'selected' : ''}>忽略</option>
          </select>
          <button type="button" class="xls-col-ignore-all wvp-btn-danger-ghost px-1.5 py-0.5 text-[10px] border border-line shrink-0" data-col="${cIdx}" title="在所有已选工作表中忽略此列">⊘全表</button>
        </div>
      </th>`;
    });
    html += '</tr></thead><tbody>';

    const maxRenderRows = Math.min(sh.previewRowCount, 100);
    for (let r = 0; r < maxRenderRows; r++) {
      const rowCells = sh.previewRows[r] || [];
      const isHeader = sh.headerRow !== null && r === sh.headerRow;
      const isUnit = sh.hasUnitRow && r === sh.firstDataRow - 1;
      const isPreamble = r < sh.firstDataRow && !isHeader && !isUnit;

      let rowCls = 'border-b border-line hover:bg-hover/60';
      let rowTag = `${r + 1}`;
      if (isHeader) {
        rowCls = 'border-b border-accent/50 bg-accent/15 text-accent font-semibold';
        rowTag = `${r + 1} H`;
      } else if (isUnit) {
        rowCls = 'border-b border-line wvp-alert-warn';
        rowTag = `${r + 1} U`;
      } else if (isPreamble) {
        rowCls = 'border-b border-line text-fg-muted opacity-75';
      }

      html += `<tr class="${rowCls}">`;
      html += `<td class="px-2 py-1 border-r border-line text-center text-[10px] text-fg-muted select-none whitespace-nowrap">${rowTag}</td>`;
      for (let c = 0; c < sh.totalCols; c++) {
        const val = escapeHtml(rowCells[c] ?? '');
        const isIgnoredCol = sh.columnMappings[c]?.role === 'ignore';
        html += `<td class="px-2 py-1 border-r border-line/60 whitespace-nowrap max-w-[200px] truncate ${isIgnoredCol && !isHeader ? 'text-fg-muted' : ''}" title="${val}">${val}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('.xls-col-role-sel').forEach((sel) => {
      sel.addEventListener('change', (e: any) => {
        const colIdx = parseInt(e.target.dataset.col, 10);
        const role = e.target.value as 'time' | 'channel' | 'ignore';
        if (role === 'time') {
          sh.timeColIndex = colIdx;
          sh.columnMappings.forEach((m, idx) => {
            if (idx === colIdx) {
              m.role = 'time';
              m.selected = false;
            } else if (m.role === 'time') {
              m.role = m.isTextColumn ? 'ignore' : 'channel';
              m.selected = m.role === 'channel';
            }
          });
          recomputeExcelSheetPreview(session, sh.sheetIndex, {
            timeColIndex: colIdx,
            timeUnit: sh.timeUnit,
            sampleRateOverrideHz: sh.sampleRateOverrideHz,
            preserveColumnRoles: true,
          });
        } else {
          sh.columnMappings[colIdx].role = role;
          sh.columnMappings[colIdx].selected = role === 'channel';
          if (colIdx === sh.timeColIndex) {
            sh.timeColIndex = -1;
            recomputeExcelSheetPreview(session, sh.sheetIndex, {
              timeColIndex: -1,
              timeUnit: sh.timeUnit,
              sampleRateOverrideHz: sh.sampleRateOverrideHz,
              preserveColumnRoles: true,
            });
          }
        }
        const autoSync = (document.getElementById('xlsSyncColsAllSheetsChk') as HTMLInputElement | null)?.checked;
        if (autoSync) {
          syncExcelColumnRuleAcrossSheets(this.sessions, this.activeSessionIndex, sh.sheetIndex, {
            columnIndex: colIdx,
            checkedOnly: true,
          });
        }
        this.render();
      });
    });

    wrap.querySelectorAll('.xls-col-ignore-all').forEach((btn) => {
      btn.addEventListener('click', (e: any) => {
        const colIdx = parseInt(e.currentTarget.dataset.col, 10);
        const col = sh.columnMappings[colIdx];
        if (!col) return;
        col.role = 'ignore';
        col.selected = false;
        if (colIdx === sh.timeColIndex) {
          sh.timeColIndex = -1;
          recomputeExcelSheetPreview(session, sh.sheetIndex, {
            timeColIndex: -1,
            timeUnit: sh.timeUnit,
            sampleRateOverrideHz: sh.sampleRateOverrideHz,
            preserveColumnRoles: true,
          });
        }
        const count = syncExcelColumnRuleAcrossSheets(
          this.sessions,
          this.activeSessionIndex,
          sh.sheetIndex,
          { columnIndex: colIdx, checkedOnly: true }
        );
        this.render();
        this.onNotifyCb?.(
          `已将列 "${col.header}" (${col.colLetter}) 在本表及 ${count} 个已选工作表中设为忽略。`,
          'info'
        );
      });
    });
  }

  private renderModeFooter(): void {
    const toggleWrap = document.getElementById('xlsTabModeToggleWrap');
    const sepBtn = document.getElementById('xlsTabSeparateBtn');
    const mergeBtn = document.getElementById('xlsTabMergeBtn');
    const hintEl = document.getElementById('xlsFooterContextHint');
    const origBtn = document.getElementById('xlsLoadOriginalBtn');
    const primaryBtn = document.getElementById('xlsPrimaryConfirmBtn');
    const timeModeWrap = document.getElementById('xlsMergeTimeModeWrap');
    const timeModeSelect = document.getElementById('xlsMergeTimeModeSelect') as HTMLSelectElement | null;

    if (this.mode === 'main') {
      toggleWrap?.classList.remove('hidden');
      origBtn?.classList.remove('hidden');
      if (primaryBtn) primaryBtn.innerText = '加载并重采样';
      timeModeWrap?.classList.toggle('hidden', this.tabDisposition !== 'merge');
      if (timeModeSelect) timeModeSelect.value = this.timeAlignment;
      if (hintEl) {
        hintEl.innerText =
          this.tabDisposition === 'separate'
            ? '每个勾选的工作表将打开为独立标签页'
            : this.timeAlignment === 'align-start'
            ? '合并到同屏不同通道；按最长轴展开，首样本平移到 t=0'
            : this.timeAlignment === 'auto-best'
            ? '合并到同屏不同通道；按最长波形建立时间轴，时间自动对应（支持面板调节 Δt）'
            : '合并到同屏不同通道；保留原始时间坐标，不强制重采样';
      }
      if (sepBtn && mergeBtn) {
        sepBtn.setAttribute('aria-pressed', this.tabDisposition === 'separate' ? 'true' : 'false');
        mergeBtn.setAttribute('aria-pressed', this.tabDisposition === 'merge' ? 'true' : 'false');
      }
    } else if (this.mode === 'compare') {
      timeModeWrap?.classList.add('hidden');
      toggleWrap?.classList.add('hidden');
      origBtn?.classList.add('hidden');
      if (primaryBtn) primaryBtn.innerText = '加入对比队列';
      if (hintEl) hintEl.innerText = '所选工作表通道将直接加入当前对比组队列';
    } else {
      timeModeWrap?.classList.add('hidden');
      toggleWrap?.classList.add('hidden');
      origBtn?.classList.add('hidden');
      if (primaryBtn) primaryBtn.innerText = '确认并开始批量测量';
      if (hintEl) hintEl.innerText = '所有已勾选的 Excel 工作表将统一纳入批量测量';
    }
  }
}

export const excelImportModal = new ExcelImportModalController();
