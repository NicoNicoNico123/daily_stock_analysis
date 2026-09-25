import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Palette } from 'lucide-react';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { cn } from '../../utils/cn';
import {
  ACCENTS,
  ACCENT_STORAGE_KEY,
  applyStoredAccent,
  readStoredAccent,
  type UiAccent,
} from '../../utils/accentPreference';

const writeAccent = (accent: UiAccent): void => {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    // 持久化為 best-effort
  }
  document.documentElement.dataset.accent = accent;
};

/**
 * 主題色切換（Aurora / Obsidian / Amber）：
 * 以 data-accent 屬性驅動 CSS 變量覆蓋層，與明暗模式正交組合。
 */
export const AccentToggle: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { t } = useUiLanguage();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [accent, setAccent] = useState<UiAccent>(() => readStoredAccent());
  const [position, setPosition] = useState({ top: 0, right: 0 });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    const top = rect.bottom + 8 + panelRect.height > window.innerHeight - margin
      ? Math.max(margin, rect.top - panelRect.height - 8)
      : rect.bottom + 8;
    setPosition({
      top,
      right: Math.max(margin, window.innerWidth - rect.right),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    // 與 index.html 開機腳本雙保險：掛載時確保 data-accent 與存儲一致
    applyStoredAccent();
  }, []);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      // 焦點返還觸發按鈕，避免關閉後焦點落空
      if (triggerRef.current && document.activeElement && !triggerRef.current.contains(document.activeElement)) {
        triggerRef.current.focus();
      }
    };
  }, [open, updatePosition]);

  const handleSelect = (next: UiAccent) => {
    setAccent(next);
    writeAccent(next);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('theme.accentLabel')}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'inline-flex h-10 w-10 items-center justify-center rounded-xl border text-secondary-text transition-colors hover:bg-hover hover:text-foreground',
          open ? 'border-cyan/50 text-cyan' : 'border-border/70 bg-card/70',
          className,
        )}
      >
        <Palette className="h-5 w-5" aria-hidden="true" />
      </button>

      {typeof document !== 'undefined' && open
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label={t('theme.accentLabel')}
              style={{ position: 'fixed', top: position.top, right: position.right }}
              className="z-[120] w-56 overflow-hidden rounded-xl border border-border/80 bg-elevated/97 p-2 shadow-[0_24px_64px_rgba(3,8,20,0.28)] backdrop-blur-xl"
            >
              <p className="px-2 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-secondary-text">
                {t('theme.accentLabel')}
              </p>
              {ACCENTS.map(({ id, labelKey, swatch }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleSelect(id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors',
                    accent === id ? 'bg-hover text-foreground' : 'text-secondary-text hover:bg-hover/60 hover:text-foreground',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="h-4 w-8 shrink-0 rounded-full border border-white/20"
                    style={{ background: swatch }}
                  />
                  <span className="flex-1 text-left font-medium">{t(labelKey)}</span>
                  {accent === id ? <Check className="h-4 w-4 text-cyan" aria-hidden="true" /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};

export default AccentToggle;
