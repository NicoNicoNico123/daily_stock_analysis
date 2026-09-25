import type { UiTextKey } from '../i18n/uiText';

export type UiAccent = 'aurora' | 'obsidian' | 'amber';

export const ACCENT_STORAGE_KEY = 'dsa.accent';

export const ACCENTS: Array<{ id: UiAccent; labelKey: UiTextKey; swatch: string }> = [
  { id: 'aurora', labelKey: 'theme.accentAurora', swatch: 'linear-gradient(120deg, hsl(263 90% 70%), hsl(172 66% 52%))' },
  { id: 'obsidian', labelKey: 'theme.accentObsidian', swatch: 'linear-gradient(120deg, hsl(190 100% 50%), hsl(247 84% 72%))' },
  { id: 'amber', labelKey: 'theme.accentAmber', swatch: 'linear-gradient(120deg, hsl(40 96% 62%), hsl(18 85% 60%))' },
];

export const readStoredAccent = (): UiAccent => {
  if (typeof window === 'undefined') {
    return 'aurora';
  }
  try {
    const raw = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    return raw === 'obsidian' || raw === 'amber' ? raw : 'aurora';
  } catch {
    return 'aurora';
  }
};

export const applyStoredAccent = (): void => {
  if (typeof document === 'undefined') {
    return;
  }
  document.documentElement.dataset.accent = readStoredAccent();
};
