/**
 * Waveform Viewer Pro - Theme Registry & Surface Contrast Manager
 * Provides 3 calibrated engineering themes with explicit luminance separation
 * between Graticule Canvas, Chassis, Sidebars, and Elevated Tool Drawers/Dialogs,
 * plus WCAG AA contrast-guaranteed channel text color resolution.
 */

import type { ThemeId } from '../types/models';
import type { RenderTheme } from '../engine/canvasRenderer';

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

const THEME_STORAGE_KEY = 'wvp_active_theme_v2';

export const THEME_PRESETS: Record<ThemeId, ThemePreset> = {
  daylight: {
    id: 'daylight',
    name: '现代浅灰工程',
    shortName: '现代浅灰',
    isLight: true,
    description: '清爽现代浅灰工程风，洁净白底画布与高对比度曲线，日间实验室与报告截图首选',
    canvas: {
      bg: '#ffffff',
      grid: '#e5ebf2',
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
      hudBg: 'rgba(255, 255, 255, 0.96)',
      hudBorder: '#cbd5e1',
      chassisBg: '#eef2f6',
      headerBg: '#f8fafc',
      isLight: true,
    },
    rawPalette: [
      '#0284c7', // CH1 Deep Cobalt Blue
      '#d97706', // CH2 Calibrated Amber
      '#be185d', // CH3 Crimson Magenta
      '#059669', // CH4 Lab Emerald
      '#4f46e5', // CH5 Precision Indigo
      '#dc2626', // CH6 Signal Red
      '#0f766e', // CH7 Deep Teal
      '#7c3aed', // CH8 Lab Violet
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
      '--bg-chassis': '#eef2f6',
      '--bg-panel': '#f8fafc',
      '--bg-elevated': '#ffffff',
      '--bg-well': '#edf1f6',
      '--bg-hover': '#e2e8f0',
      '--bg-segment-active': '#ffffff',
      '--border-subtle': '#d8e0ea',
      '--border-strong': '#b8c4d4',
      '--text-primary': '#0f172a',
      '--text-secondary': '#334155',
      '--text-muted': '#64748b',
      '--accent': '#0284c7',
      '--accent-hover': '#0369a1',
      '--accent-fg': '#ffffff',
      '--accent-soft': 'rgba(2, 132, 199, 0.11)',
      '--canvas-stage': '#ffffff',
      '--shadow-modal': '0 20px 50px rgba(15, 23, 42, 0.16), 0 0 0 1px rgba(148, 163, 184, 0.35)',
    },
  },
  obsidian: {
    id: 'obsidian',
    name: '精密深灰仪器',
    shortName: '精密深灰',
    isLight: false,
    description: '深灰实验室示波器暗色模式，低眩光高对比度荧光曲线',
    canvas: {
      bg: '#090c11',
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
      hudBg: 'rgba(17, 23, 34, 0.94)',
      hudBorder: '#334155',
      chassisBg: '#0d1117',
      headerBg: '#141922',
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
      '--bg-chassis': '#0d1117',
      '--bg-panel': '#141922',
      '--bg-elevated': '#1c2432',
      '--bg-well': '#0a0d12',
      '--bg-hover': '#253042',
      '--bg-segment-active': '#263244',
      '--border-subtle': '#242e3d',
      '--border-strong': '#39485e',
      '--text-primary': '#f1f5f9',
      '--text-secondary': '#cbd5e1',
      '--text-muted': '#8b9ab0',
      '--accent': '#06b6d4',
      '--accent-hover': '#22d3ee',
      '--accent-fg': '#041318',
      '--accent-soft': 'rgba(6, 182, 212, 0.14)',
      '--canvas-stage': '#090c11',
      '--shadow-modal': '0 24px 60px rgba(0, 0, 0, 0.56), 0 0 0 1px rgba(57, 72, 94, 0.9)',
    },
  },
  midnight: {
    id: 'midnight',
    name: '深海蓝实验室',
    shortName: '深海蓝',
    isLight: false,
    description: '高对比度深蓝实验室风格，适合长时间多通道对比分析',
    canvas: {
      bg: '#070c17',
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
      hudBg: 'rgba(17, 27, 46, 0.94)',
      hudBorder: '#475569',
      chassisBg: '#0b1220',
      headerBg: '#111b2e',
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
      '--bg-chassis': '#0b1220',
      '--bg-panel': '#111b2e',
      '--bg-elevated': '#1b2944',
      '--bg-well': '#080e1a',
      '--bg-hover': '#26385c',
      '--bg-segment-active': '#243556',
      '--border-subtle': '#243554',
      '--border-strong': '#415780',
      '--text-primary': '#f8fafc',
      '--text-secondary': '#e2e8f0',
      '--text-muted': '#94a3b8',
      '--accent': '#38bdf8',
      '--accent-hover': '#7dd3fc',
      '--accent-fg': '#041423',
      '--accent-soft': 'rgba(56, 189, 248, 0.16)',
      '--canvas-stage': '#070c17',
      '--shadow-modal': '0 24px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(65, 87, 128, 0.9)',
    },
  },
};

function parseHexRgb(color: string): [number, number, number] | null {
  const s = (color || '').trim();
  if (!s.startsWith('#')) return null;
  const hex = s.slice(1);
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? [r, g, b] : null;
  }
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? [r, g, b] : null;
  }
  return null;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(lum1: number, lum2: number): number {
  const hi = Math.max(lum1, lum2);
  const lo = Math.min(lum1, lum2);
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}

/**
 * Resolves a channel trace color into a WCAG AA contrast-safe text color for the active theme.
 * Preserves hue identity while preventing bright yellow/cyan traces from becoming unreadable on light cards
 * or overly dark traces from disappearing on dark cards.
 */
export function resolveChannelTextColor(channelColor: string, isLight: boolean): string {
  const rgb = parseHexRgb(channelColor);
  if (!rgb) return channelColor || (isLight ? '#0f172a' : '#f1f5f9');

  const bgLum = isLight ? 0.96 : 0.025; // white/light-gray card vs dark card
  let [r, g, b] = rgb;
  const targetRatio = 4.6;

  if (contrastRatio(relativeLuminance(r, g, b), bgLum) >= targetRatio) {
    return rgbToHex(r, g, b);
  }

  if (isLight) {
    // Darken proportionally toward deep ink while keeping hue vivid
    for (let i = 0; i < 16; i++) {
      r *= 0.86;
      g *= 0.86;
      b *= 0.86;
      if (contrastRatio(relativeLuminance(r, g, b), bgLum) >= targetRatio) {
        return rgbToHex(r, g, b);
      }
    }
    return rgbToHex(r, g, b);
  } else {
    // Lift dark colors toward pastel light on dark surfaces
    for (let i = 0; i < 16; i++) {
      r = r + (255 - r) * 0.22;
      g = g + (255 - g) * 0.22;
      b = b + (255 - b) * 0.22;
      if (contrastRatio(relativeLuminance(r, g, b), bgLum) >= targetRatio) {
        return rgbToHex(r, g, b);
      }
    }
    return rgbToHex(r, g, b);
  }
}

export function getSavedThemeId(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null;
    if (raw && THEME_PRESETS[raw]) return raw;
  } catch {
    // ignore storage errors
  }
  return 'daylight';
}

export function applyThemeToDocument(themeId: ThemeId): ThemePreset {
  const preset = THEME_PRESETS[themeId] || THEME_PRESETS.daylight;
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
  const preset = THEME_PRESETS[themeId] || THEME_PRESETS.daylight;
  return preset.computedPalette[mathIdx % preset.computedPalette.length];
}

export function getRawPaletteColor(themeId: ThemeId, chIdx: number): string {
  const preset = THEME_PRESETS[themeId] || THEME_PRESETS.daylight;
  return preset.rawPalette[chIdx % preset.rawPalette.length];
}
