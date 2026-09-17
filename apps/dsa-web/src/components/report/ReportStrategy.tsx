import type React from 'react';
import type { ReportStrategy as ReportStrategyType } from '../../types/analysis';
import { Card } from '../common';
import { DashboardPanelHeader } from '../dashboard';
import { getReportText } from '../../utils/reportLanguage';
import { useUiLanguage } from '../../contexts/UiLanguageContext';

interface ReportStrategyProps {
  strategy?: ReportStrategyType;
}

interface StrategyItemProps {
  label: string;
  value?: string;
  tone: string;
  className?: string;
}

const StrategyItem: React.FC<StrategyItemProps> = ({
  label,
  value,
  tone,
  className = '',
}) => (
  <div
    className={`home-subpanel home-strategy-card p-3 ${className}`.trim()}
    style={{ ['--home-strategy-tone' as string]: `var(${tone})` }}
  >
    <div className="flex flex-col">
      <span className="home-strategy-label mb-1 inline-flex items-center gap-1.5 text-xs">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: `var(${tone})`, boxShadow: `0 0 8px var(${tone})` }}
        />
        {label}
      </span>
      <span
        className={`home-strategy-value text-lg font-bold font-mono ${value ? '' : 'home-strategy-value-empty'}`}
        style={!value ? { color: 'var(--text-muted-text)' } : undefined}
      >
        {value || '—'}
      </span>
    </div>
    <div
      className="absolute bottom-0 left-0 right-0 h-0.5"
      style={{ background: `linear-gradient(90deg, transparent, var(${tone}), transparent)` }}
    />
  </div>
);

/**
 * 策略点位区组件 - 终端风格
 */
export const ReportStrategy: React.FC<ReportStrategyProps> = ({ strategy }) => {
  // 区块标签跟随界面语言，而不是报告内容语言。
  const { language: uiLanguage } = useUiLanguage();
  if (!strategy) {
    return null;
  }

  const text = getReportText(uiLanguage);

  const strategyItems = [
    {
      label: text.idealBuy,
      value: strategy.idealBuy,
      tone: '--home-strategy-buy',
    },
    {
      label: text.secondaryBuy,
      value: strategy.secondaryBuy,
      tone: '--home-strategy-secondary',
    },
    {
      label: text.stopLoss,
      value: strategy.stopLoss,
      tone: '--home-strategy-stop',
    },
    {
      label: text.takeProfit,
      value: strategy.takeProfit,
      tone: '--home-strategy-take',
    },
  ];

  return (
    <Card variant="bordered" padding="md" className="home-panel-card">
      <DashboardPanelHeader
        eyebrow={text.strategyPoints}
        title={text.sniperLevels}
        className="mb-3"
      />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {strategyItems.map((item, index) => (
          <div
            key={item.label}
            className="h-full animate-float-in"
            style={{ animationDelay: `${index * 50}ms`, animationFillMode: 'both' }}
          >
            <StrategyItem className="h-full" {...item} />
          </div>
        ))}
      </div>
    </Card>
  );
};
