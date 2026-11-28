import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THEME_PRESETS,
  getSavedThemeId,
  resolveChannelTextColor,
} from './themeManager';

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(parseHexRgb(hexA));
  const l2 = relativeLuminance(parseHexRgb(hexB));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

test('default theme is light-gray engineering daylight preset', () => {
  assert.equal(getSavedThemeId(), 'daylight');
  assert.equal(THEME_PRESETS.daylight.isLight, true);
  assert.equal(THEME_PRESETS.obsidian.isLight, false);
  assert.equal(THEME_PRESETS.midnight.isLight, false);
});

test('resolveChannelTextColor enforces WCAG AA contrast (>= 4.5:1) on light theme for bright traces', () => {
  const brightChannels = ['#facc15', '#38bdf8', '#4ade80', '#f8fafc', '#22d3ee'];
  for (const chColor of brightChannels) {
    const resolved = resolveChannelTextColor(chColor, true);
    const ratio = contrastRatio(resolved, '#ffffff');
    assert.ok(
      ratio >= 4.5,
      `Expected light-theme contrast >= 4.5 for ${chColor} -> ${resolved}, got ${ratio.toFixed(2)}`
    );
  }
});

test('resolveChannelTextColor enforces WCAG AA contrast (>= 4.5:1) on dark theme for dark traces', () => {
  const darkChannels = ['#1e3a8a', '#064e3b', '#4c1d95', '#111827', '#7c2d12'];
  for (const chColor of darkChannels) {
    const resolved = resolveChannelTextColor(chColor, false);
    const ratio = contrastRatio(resolved, '#111722');
    assert.ok(
      ratio >= 4.5,
      `Expected dark-theme contrast >= 4.5 for ${chColor} -> ${resolved}, got ${ratio.toFixed(2)}`
    );
  }
});

test('resolveChannelTextColor preserves already high-contrast engineering colors', () => {
  assert.equal(resolveChannelTextColor('#0369a1', true).toLowerCase(), '#0369a1');
  assert.equal(resolveChannelTextColor('#facc15', false).toLowerCase(), '#facc15');
});
