import type React from 'react';
import { useMemo } from 'react';
import { Radio } from 'lucide-react';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { cn } from '../../utils/cn';

export interface TickerTapeItem {
  key: string;
  name: string;
  tag?: string | null;
  score?: number | null;
  hint?: string | null;
}

interface MarketTickerTapeProps {
  items: TickerTapeItem[];
  className?: string;
}

const scoreTone = (score?: number | null): string => {
  if (score == null || !Number.isFinite(Number(score))) {
    return 'text-secondary-text';
  }
  const value = Number(score);
  if (value >= 60) {
    return 'text-[hsl(var(--home-price-up))]';
  }
  if (value < 40) {
    return 'text-[hsl(var(--home-price-down))]';
  }
  return 'text-warning';
};

/**
 * 終端跑馬燈：以無縫滾動帶呈現自選/最近標的的情緒信號。
 * 純展示層——懸浮暫停，prefers-reduced-motion 下降級為靜態橫向列表。
 */
export const MarketTickerTape: React.FC<MarketTickerTapeProps> = ({ items, className = '' }) => {
  const { t } = useUiLanguage();
  const doubled = useMemo(() => (items.length > 0 ? [...items, ...items] : []), [items]);

  return (
    <div
      className={cn(
        'ticker-tape relative flex h-7 w-full shrink-0 items-center overflow-hidden border-b border-border/60 bg-elevated/70',
        className,
      )}
      role="marquee"
      aria-label={t('home.tickerLabel')}
    >
      <span className="z-10 flex h-full shrink-0 items-center gap-1.5 border-r border-border/60 bg-elevated px-3 text-[10px] font-bold uppercase tracking-[0.2em] text-cyan">
        <Radio className="h-3 w-3 animate-pulse" aria-hidden="true" />
        DSA Live
      </span>
      {doubled.length === 0 ? (
        <span className="px-3 text-[11px] text-muted-text">{t('home.tickerEmpty')}</span>
      ) : (
        <div className="ticker-tape-track flex w-max items-center">
          {doubled.map((item, index) => (
            <span
              key={`${item.key}-${index}`}
              aria-hidden={index >= items.length}
              className="ticker-chip inline-flex items-center gap-1.5 whitespace-nowrap px-3 text-[11px]"
            >
              <span className="font-semibold text-foreground">{item.name}</span>
              {item.tag ? (
                <span className="rounded border border-border/60 px-1 text-[9px] uppercase tracking-wider text-secondary-text">
                  {item.tag}
                </span>
              ) : null}
              {item.score != null ? (
                <span className={cn('num font-bold', scoreTone(item.score))}>
                  {Number(item.score).toFixed(0)}
                </span>
              ) : null}
              {item.hint ? <span className="text-muted-text">· {item.hint}</span> : null}
              <span className="ml-1 text-border">│</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export default MarketTickerTape;
