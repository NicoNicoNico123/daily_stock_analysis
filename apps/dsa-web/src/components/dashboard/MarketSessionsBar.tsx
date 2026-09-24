import type React from 'react';
import { useEffect, useState } from 'react';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { cn } from '../../utils/cn';
import type { UiTextKey } from '../../i18n/uiText';

interface MarketSessionDef {
  id: string;
  labelKey: UiTextKey;
  timeZone: string;
  /** 交易時段（分鐘數，當地時間）。僅按常規時段與週末判斷，不含交易所節假日休市。 */
  sessions: Array<[number, number]>;
}

const MARKET_SESSIONS: MarketSessionDef[] = [
  {
    id: 'cn',
    labelKey: 'home.marketSessionCn',
    timeZone: 'Asia/Shanghai',
    sessions: [
      [9 * 60 + 30, 11 * 60 + 30],
      [13 * 60, 15 * 60],
    ],
  },
  {
    id: 'hk',
    labelKey: 'home.marketSessionHk',
    timeZone: 'Asia/Hong_Kong',
    sessions: [
      [9 * 60 + 30, 12 * 60],
      [13 * 60, 16 * 60],
    ],
  },
  {
    id: 'us',
    labelKey: 'home.marketSessionUs',
    timeZone: 'America/New_York',
    sessions: [[9 * 60 + 30, 16 * 60]],
  },
];

interface SessionSnapshot {
  minutes: number;
  weekday: number; // 0=週日
  isOpen: boolean;
}

const readSessionSnapshot = (timeZone: string): SessionSnapshot => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  const weekdayText = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const minutes = (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0);
  const weekday = weekdayMap[weekdayText] ?? 0;
  return { minutes, weekday, isOpen: false };
};

const withOpenState = (snapshot: SessionSnapshot, def: MarketSessionDef): SessionSnapshot => {
  const isWeekend = snapshot.weekday === 0 || snapshot.weekday === 6;
  const isOpen = !isWeekend && def.sessions.some(([start, end]) => snapshot.minutes >= start && snapshot.minutes < end);
  return { ...snapshot, isOpen };
};

/**
 * 終端式全球市場交易時段條：A股 / 港股 / 美股 當地時鐘與開休市狀態。
 * 純客戶端計算（Intl 時區，自動處理夏令時），不引入後端依賴。
 */
export const MarketSessionsBar: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { t } = useUiLanguage();
  const [snapshots, setSnapshots] = useState<Record<string, SessionSnapshot>>(() =>
    Object.fromEntries(MARKET_SESSIONS.map((def) => [def.id, readSessionSnapshot(def.timeZone)])),
  );

  useEffect(() => {
    const tick = () => {
      setSnapshots(
        Object.fromEntries(MARKET_SESSIONS.map((def) => [def.id, readSessionSnapshot(def.timeZone)])),
      );
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className={cn('items-center gap-1.5 rounded-xl border border-border/60 bg-card/70 px-2 py-1.5', className)}
      role="group"
      aria-label={t('home.marketSessionGroup')}
    >
      {MARKET_SESSIONS.map((def) => {
        const snapshot = withOpenState(snapshots[def.id] ?? readSessionSnapshot(def.timeZone), def);
        const clock = `${String(Math.floor(snapshot.minutes / 60)).padStart(2, '0')}:${String(snapshot.minutes % 60).padStart(2, '0')}`;
        return (
          <span
            key={def.id}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-[11px] leading-5"
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                snapshot.isOpen ? 'bg-success market-session-dot-open' : 'bg-secondary-text/40',
              )}
              aria-hidden="true"
            />
            <span className="font-semibold text-secondary-text">{t(def.labelKey)}</span>
            <span className="num text-foreground/90">{clock}</span>
            <span className={cn('font-medium', snapshot.isOpen ? 'text-success' : 'text-secondary-text/70')}>
              {snapshot.isOpen ? t('home.marketSessionOpen') : t('home.marketSessionClosed')}
            </span>
          </span>
        );
      })}
    </div>
  );
};

export default MarketSessionsBar;
