import type React from 'react';
import { useEffect, useState } from 'react';
import { Activity, Clock3, Database, Eye } from 'lucide-react';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { readStoredAccent } from '../../utils/accentPreference';
import type { UiTextKey } from '../../i18n/uiText';

const ACCENT_LABEL_KEYS: Record<string, UiTextKey> = {
  aurora: 'theme.accentAurora',
  obsidian: 'theme.accentObsidian',
  amber: 'theme.accentAmber',
};

interface TerminalStatusBarProps {
  taskCount: number;
  stockCount: number;
  className?: string;
}

/**
 * 終端狀態列：上海時鐘 / 運行任務數 / 覆蓋標的數 / 當前主題色，
 * 全部為客戶端真實狀態，等寬字體大寫微字排版。
 */
export const TerminalStatusBar: React.FC<TerminalStatusBarProps> = ({
  taskCount,
  stockCount,
  className,
}) => {
  const { t } = useUiLanguage();
  const [clock, setClock] = useState('--:--:--');
  const [accent, setAccent] = useState<string>('aurora');

  useEffect(() => {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const tick = () => setClock(formatter.format(new Date()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const sync = () => setAccent(readStoredAccent());
    sync();
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  const stat = (Icon: React.ComponentType<{ className?: string }>, label: string, value: React.ReactNode) => (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="h-3 w-3 text-muted-text" aria-hidden="true" />
      <span className="text-muted-text">{label}</span>
      <span className="num text-foreground">{value}</span>
    </span>
  );

  return (
    <footer
      className={className ?? 'flex min-h-7 w-full shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border/60 bg-elevated/70 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-secondary-text'}
      role="contentinfo"
      aria-label={t('home.statusBarLabel')}
    >
      <div className="flex min-w-0 items-center gap-4">
        {stat(Activity, t('home.statusTasks'), taskCount)}
        {stat(Eye, t('home.statusWatchlist'), stockCount)}
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {stat(Database, t('home.statusAccent'), t(ACCENT_LABEL_KEYS[accent] ?? 'theme.accentAurora'))}
        {stat(Clock3, 'SHA', <span className="tabular-nums">{clock}</span>)}
      </div>
    </footer>
  );
};

export default TerminalStatusBar;
