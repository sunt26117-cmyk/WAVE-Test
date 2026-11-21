/**
 * Waveform Viewer Pro - Workbench Analysis Presets / Test Templates Manager
 * Saves and reapplies Math channel formulas, Measurement selections, Render/Decimation settings,
 * Layout mode (Overlap/Separate), and Trigger polarity/position rules.
 */

import { TabState, WorkbenchPreset } from '../types/models';
import { evaluateMathExpression } from './mathParser';
import { fitChannelTo125 } from './oscilloscopeScale';

const STORAGE_KEY = 'wvp_workbench_presets_v1';

export function loadPresets(): WorkbenchPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savePresetToStorage(preset: WorkbenchPreset): WorkbenchPreset[] {
  const list = loadPresets().filter((p) => p.id !== preset.id && p.name !== preset.name);
  list.unshift(preset);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore storage quota errors
  }
  return list;
}

export function deletePresetFromStorage(id: string): WorkbenchPreset[] {
  const list = loadPresets().filter((p) => p.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
  return list;
}

export function capturePresetFromTab(tab: TabState, name: string): WorkbenchPreset {
  const chIndexMap = new Map<string, number>();
  tab.drawOrder.forEach((id, idx) => chIndexMap.set(id, idx));

  const mathDefs = tab.drawOrder
    .map((id) => tab.channels[id])
    .filter((ch) => ch && ch.isMath && ch.mathExpression && !ch.mathExpression.startsWith('Clarke'))
    .map((ch) => ({
      name: ch.name,
      expr: ch.mathExpression || '',
      color: ch.color,
    }));

  const selectedMetricsByIndex = (tab.selectedMeasurements || [])
    .map((m) => ({
      chIdx: chIndexMap.get(m.channelId) ?? 0,
      metric: m.metric,
    }));

  const trigIdx = chIndexMap.get(tab.triggerConfig.channelId);

  return {
    id: `preset_${Date.now()}`,
    name: name.trim() || `Preset ${new Date().toLocaleTimeString()}`,
    createdAt: new Date().toISOString(),
    separateView: !!tab.separateView,
    renderMode: tab.renderMode || 'vector',
    decimationMode: tab.decimationMode || 'minmax',
    measurementGate: tab.measurementGate || 'view',
    mathDefs,
    selectedMetricsByIndex,
    triggerRule:
      trigIdx !== undefined
        ? {
            chIdx: trigIdx,
            type: tab.triggerConfig.type,
            positionPercent: tab.triggerConfig.positionPercent,
          }
        : undefined,
  };
}

export function applyPresetToTab(
  tab: TabState,
  preset: WorkbenchPreset
): { mathCreated: number; metricsApplied: number } {
  tab.separateView = preset.separateView;
  tab.renderMode = preset.renderMode;
  tab.decimationMode = preset.decimationMode;
  tab.measurementGate = preset.measurementGate;

  let mathCreated = 0;
  for (const def of preset.mathDefs || []) {
    if (!def.expr) continue;
    // Skip if identical formula already exists
    const exists = tab.drawOrder.some((id) => tab.channels[id]?.mathExpression === def.expr);
    if (exists) continue;
    try {
      const mathId = `math_${Date.now()}_${mathCreated}`;
      const mathCh = evaluateMathExpression(def.expr, tab.channels, tab.drawOrder, mathId, def.name);
      mathCh.color = def.color || mathCh.color;
      fitChannelTo125(mathCh);
      tab.channels[mathId] = mathCh;
      tab.drawOrder.push(mathId);
      mathCreated++;
    } catch {
      // Skip formulas referencing missing channels
    }
  }

  const nextSelected = [] as NonNullable<TabState['selectedMeasurements']>;
  const seen = new Set<string>();
  for (const item of preset.selectedMetricsByIndex || []) {
    const chId = tab.drawOrder[Math.min(Math.max(0, item.chIdx), tab.drawOrder.length - 1)];
    if (!chId) continue;
    const id = `${chId}::${item.metric}`;
    if (!seen.has(id)) {
      seen.add(id);
      nextSelected.push({ id, channelId: chId, metric: item.metric });
    }
  }
  tab.selectedMeasurements = nextSelected;

  if (preset.triggerRule && tab.drawOrder.length > 0) {
    const tId = tab.drawOrder[Math.min(Math.max(0, preset.triggerRule.chIdx), tab.drawOrder.length - 1)];
    if (tId) {
      tab.triggerConfig.channelId = tId;
      tab.triggerConfig.type = preset.triggerRule.type;
      tab.triggerConfig.positionPercent = preset.triggerRule.positionPercent;
    }
  }

  return { mathCreated, metricsApplied: nextSelected.length };
}
