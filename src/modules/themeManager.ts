/**
 * Waveform Viewer Pro - Theme Registry & Surface Contrast Manager
 * Provides 3 calibrated engineering themes with explicit luminance separation
 * between Graticule Canvas, Chassis, Sidebars, and Elevated Tool Drawers/Dialogs.
 */

import { ThemeId } from '../types/models';
import { RenderTheme } from '../engine/canvasRenderer';

export interface ThemePreset {
  id: ThemeId;
  name: string;
  shortName: string;
  isLight: boolean;
  description: string;
  canvas: RenderTheme;
  rawPalette: string[];
  computedPalette: string[];
  cssVars: Record<string, string>;
}

const THEME_STORAGE_KEY = 'wvp_active_theme_v1';

export const THEME_PRESETS: Record<ThemeId, ThemePreset> = {
  obsidian: {
    id: 'obsidian',
    name: 'Obsidian Scope',
    shortName: 'Obsidian',
    isLight: false,
    description: 'Deep studio dark graticule with elevated slate tool drawer',
    canvas: {
      bg: '#07090e',
      grid: '#1b2330',
      gridSub: '#2b3749',
      frame: '#334155',
      axisText: '#94a3b8',
      cursor: '#38bdf8',
      cursorY: '#a78bfa',
      cursorFill: 'rgba(56, 189, 248, 0.09)',
      trigger: '#fb923c',
      harmonic: '#f87171',
      peak: '#4ade80',
      text: '#f1f5f9',
      hudBg: 'rgba(15, 21, 32, 0.92)',
      hudBorder: '#334155',
      chassisBg: '#0c1016',
      headerBg: '#121822',
      isLight: false,
    },
    rawPalette: [
      '#facc15', // CH1 Yellow
      '#22d3ee', // CH2 Cyan
      '#f472b6', // CH3 Magenta
      '#4ade80', // CH4 Green
      '#fb923c', // CH5 Orange
      '#38bdf8', // CH6 Sky
      '#f87171', // CH7 Coral
      '#a3e635', // CH8 Lime
    ],
    computedPalette: [
      '#c4b5fd', // Soft Lavender
      '#5eead4', // Muted Teal
      '#fda4af', // Soft Rose
      '#fcd34d', // Soft Gold
      '#93c5fd', // Soft Periwinkle
      '#d8b4fe', // Orchid
    ],
    cssVars: {
      '--bg-chassis': '#0c1016',
      '--bg-panel': '#111722',
      '--bg-elevated': '#1b2433',
      '--bg-well': '#080b10',
      '--bg-hover': '#243044',
      '--border-subtle': '#232d3d',
      '--border-strong': '#394860',
      '--text-primary': '#f1f5f9',
      '--text-secondary': '#cbd5e1',
      '--text-muted': '#8a99ad',
      '--accent': '#06b6d4',
      '--accent-hover': '#22d3ee',
      '--accent-fg': '#041318',
      '--accent-soft': 'rgba(6, 182, 212, 0.14)',
      '--canvas-stage': '#07090e',
    },
  },
  midnight: {
    id: 'midnight',
    name: 'Midnight Slate',
    shortName: 'Midnight',
    isLight: false,
    description: 'High-contrast blueprint navy with crisp elevated tool panels',
    canvas: {
      bg: '#080e1c',
      grid: '#182542',
      gridSub: '#2b406e',
      frame: '#475569',
      axisText: '#cbd5e1',
      cursor: '#38bdf8',
      cursorY: '#c084fc',
      cursorFill: 'rgba(56, 189, 248, 0.12)',
      trigger: '#fb923c',
      harmonic: '#fb7185',
      peak: '#34d399',
      text: '#f8fafc',
      hudBg: 'rgba(20, 30, 51, 0.94)',
      hudBorder: '#475569',
      chassisBg: '#0d1526',
      headerBg: '#141f36',
      isLight: false,
    },
    rawPalette: [
      '#fde047', // CH1 Vivid Gold
      '#38bdf8', // CH2 Sky Cyan
      '#fb7185', // CH3 Coral Pink
      '#34d399', // CH4 Emerald
      '#fb923c', // CH5 Amber
      '#60a5fa', // CH6 Cobalt
      '#f472b6', // CH7 Rose
      '#a3e635', // CH8 Chartreuse
    ],
    computedPalette: [
      '#c4b5fd', // Soft Violet
      '#67e8f9', // Ice Cyan
      '#fda4af', // Pastel Rose
      '#fde68a', // Soft Cream
      '#a5b4fc', // Periwinkle
      '#6ee7b7', // Seafoam
    ],
    cssVars: {
      '--bg-chassis': '#0d1526',
      '--bg-panel': '#131d33',
      '--bg-elevated': '#1e2c48',
      '--bg-well': '#090f1d',
      '--bg-hover': '#293b5f',
      '--border-subtle': '#273858',
      '--border-strong': '#475d85',
      '--text-primary': '#f8fafc',
      '--text-secondary': '#e2e8f0',
      '--text-muted': '#94a3b8',
      '--accent': '#38bdf8',
      '--accent-hover': '#7dd3fc',
      '--accent-fg': '#041423',
      '--accent-soft': 'rgba(56, 189, 248, 0.16)',
      '--canvas-stage': '#080e1c',
    },
  },
  daylight: {
    id: 'daylight',
    name: 'Daylight Lab',
    shortName: 'Daylight',
    isLight: true,
    description: 'Clean paper-white lab canvas for daytime clarity & reports',
    canvas: {
      bg: '#ffffff',
      grid: '#e2e8f0',
      gridSub: '#cbd5e1',
      frame: '#94a3b8',
      axisText: '#475569',
      cursor: '#0284c7',
      cursorY: '#7c3aed',
      cursorFill: 'rgba(2, 132, 199, 0.08)',
      trigger: '#ea580c',
      harmonic: '#dc2626',
      peak: '#059669',
      text: '#0f172a',
      hudBg: 'rgba(255, 255, 255, 0.94)',
      hudBorder: '#cbd5e1',
      chassisBg: '#edf1f6',
      headerBg: '#f8fafc',
      isLight: true,
    },
    rawPalette: [
      '#0284c7', // CH1 Deep Cobalt
      '#d97706', // CH2 Burnt Amber
      '#be185d', // CH3 Crimson Rose
      '#059669', // CH4 Forest Emerald
      '#4f46e5', // CH5 Indigo
      '#dc2626', // CH6 Signal Red
      '#0f766e', // CH7 Deep Teal
      '#9333ea', // CH8 Vivid Purple
    ],
    computedPalette: [
      '#6d28d9', // Muted Violet
      '#0d9488', // Muted Jade
      '#9f1239', // Muted Burgundy
      '#b45309', // Muted Ochre
      '#1d4ed8', // Muted Royal
      '#475569', // Slate Ink
    ],
    cssVars: {
      '--bg-chassis': '#eaeff5',
      '--bg-panel': '#f6f8fb',
      '--bg-elevated': '#ffffff',
      '--bg-well': '#eef2f6',
      '--bg-hover': '#e2e8f0',
      '--border-subtle': '#d3dce6',
      '--border-strong': '#94a3b8',
      '--text-primary': '#0f172a',
      '--text-secondary': '#334155',
      '--text-muted': '#64748b',
      '--accent': '#0284c7',
      '--accent-hover': '#0369a1',
      '--accent-fg': '#ffffff',
      '--accent-soft': 'rgba(2, 132, 199, 0.12)',
      '--canvas-stage': '#ffffff',
    },
  },
};

export function getSavedThemeId(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null;
    if (raw && THEME_PRESETS[raw]) return raw;
  } catch {
    // ignore storage errors
  }
  return 'obsidian';
}

export function applyThemeToDocument(themeId: ThemeId): ThemePreset {
  const preset = THEME_PRESETS[themeId] || THEME_PRESETS.obsidian;
  const root = document.documentElement;
  root.setAttribute('data-theme', preset.id);
  if (preset.isLight) {
    root.classList.remove('dark');
  } else {
    root.classList.add('dark');
  }

  Object.entries(preset.cssVars).forEach(([key, val]) => {
    root.style.setProperty(key, val);
  });

  try {
    localStorage.setItem(THEME_STORAGE_KEY, preset.id);
  } catch {
    // ignore
  }
  return preset;
}

export function getComputedPaletteColor(themeId: ThemeId, mathIdx: number): string {
  const preset = THEME_PRESETS[themeId] || THEME_PRESETS.obsidian;
  return preset.computedPalette[mathIdx % preset.computedPalette.length];
}

export function getRawPaletteColor(themeId: ThemeId, chIdx: number): string {
  const preset = THEME_PRESETS[themeId] || THEME_PRESETS.obsidian;
  return preset.rawPalette[chIdx % preset.rawPalette.length];
}
