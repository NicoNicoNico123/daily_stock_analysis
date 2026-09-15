import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import type { DecisionSignalItem } from '../../../types/decisionSignals';
import { DecisionSignalCard, DecisionSignalDetails, PortfolioSignalSummary } from '../DecisionSignalDisplay';

const signal: DecisionSignalItem = {
  id: 7,
  stockCode: '600519',
  stockName: '貴州茅臺',
  market: 'cn',
  sourceType: 'analysis',
  sourceReportId: 3001,
  decisionProfile: 'aggressive',
  marketPhase: 'intraday',
  triggerSource: 'web',
  action: 'hold',
  actionLabel: null,
  confidence: 0.72,
  score: 82,
  horizon: '3d',
  entryLow: 1600,
  entryHigh: 1620,
  stopLoss: 1550,
  targetPrice: 1700,
  invalidation: '跌破 1550',
  watchConditions: '觀察成交量',
  reason: '趨勢保持',
  riskSummary: '放量下跌風險',
  catalystSummary: '業績窗口',
  evidence: { technical: 'ma' },
  dataQualitySummary: { freshness: 'ok' },
  planQuality: 'complete',
  status: 'active',
  expiresAt: '2026-06-18T09:30:00',
  createdAt: '2026-06-17T09:30:00',
  updatedAt: '2026-06-17T09:30:00',
  metadata: { source: 'test', decision_profile: 'balanced' },
};

function renderCard(onSelect?: (item: DecisionSignalItem) => void) {
  window.localStorage.setItem('dsa.uiLanguage', 'zh');
  render(
    <UiLanguageProvider>
      <DecisionSignalCard item={signal} onSelect={onSelect} />
    </UiLanguageProvider>,
  );
}

describe('DecisionSignalCard', () => {
  it('uses a dedicated details button for interactive cards', () => {
    const onSelect = vi.fn();
    renderCard(onSelect);

    expect(screen.getByText('貴州茅臺').closest('button')).toBeNull();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText('風格: 進取')).toBeInTheDocument();
    expect(screen.getByText('1600 - 1620')).toBeInTheDocument();
    expect(screen.getByText('業績窗口')).toBeInTheDocument();
    expect(screen.getByText('跌破 1550')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看 貴州茅臺 AI 建議詳情' }));

    expect(onSelect).toHaveBeenCalledWith(signal);
    expect(screen.getByText('3 日')).toBeInTheDocument();
    expect(screen.getByText('計劃質量: 完整')).toBeInTheDocument();
    expect(screen.getByText('階段: 盤中')).toBeInTheDocument();
    expect(screen.queryByText('3d')).not.toBeInTheDocument();
    expect(screen.queryByText('complete')).not.toBeInTheDocument();
    expect(screen.queryByText('intraday')).not.toBeInTheDocument();
  });

  it('renders non-interactive cards without a details button', () => {
    renderCard();

    expect(screen.getByText('貴州茅臺')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看 貴州茅臺 AI 建議詳情' })).not.toBeInTheDocument();
  });

  it('hides missing optional plan text for sparse legacy signals', () => {
    window.localStorage.setItem('dsa.uiLanguage', 'zh');
    render(
      <UiLanguageProvider>
        <DecisionSignalCard
          item={{
            ...signal,
            score: null,
            confidence: null,
            horizon: null,
            entryLow: null,
            entryHigh: null,
            stopLoss: null,
            targetPrice: null,
            invalidation: null,
            watchConditions: null,
            catalystSummary: null,
          }}
        />
      </UiLanguageProvider>,
    );

    expect(screen.getByText('評分')).toBeInTheDocument();
    expect(screen.getByText('置信度')).toBeInTheDocument();
    expect(screen.getByText('週期')).toBeInTheDocument();
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('入場區間')).not.toBeInTheDocument();
    expect(screen.queryByText('止損')).not.toBeInTheDocument();
    expect(screen.queryByText('目標價')).not.toBeInTheDocument();
    expect(screen.queryByText('催化')).not.toBeInTheDocument();
    expect(screen.queryByText('失效條件')).not.toBeInTheDocument();
  });
});

describe('DecisionSignalDetails', () => {
  it('renders secondary-only entry_high as a valid entry range', () => {
    window.localStorage.setItem('dsa.uiLanguage', 'zh');
    render(
      <UiLanguageProvider>
        <DecisionSignalDetails item={{ ...signal, entryLow: null, entryHigh: 1680 }} />
      </UiLanguageProvider>,
    );

    const entryRange = screen.getByText('入場區間').closest('div');
    expect(entryRange).not.toBeNull();
    expect(entryRange as HTMLElement).toHaveTextContent('1680');
    expect(screen.getByText('3 日')).toBeInTheDocument();
    expect(screen.getByText('完整')).toBeInTheDocument();
    expect(screen.getByText('盤中')).toBeInTheDocument();
    expect(screen.getByText('風格')).toBeInTheDocument();
    expect(screen.getAllByText('進取').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('3d')).not.toBeInTheDocument();
  });

  it('renders explicit null profile as unknown on card and details', () => {
    window.localStorage.setItem('dsa.uiLanguage', 'zh');
    render(
      <UiLanguageProvider>
        <>
          <DecisionSignalCard item={{ ...signal, decisionProfile: null, metadata: { decision_profile: 'balanced' } }} />
          <DecisionSignalDetails item={{ ...signal, decisionProfile: null, metadata: { decision_profile: 'balanced' } }} />
        </>
      </UiLanguageProvider>,
    );

    expect(screen.getAllByText('風格: 未知').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('風格').closest('div')).toHaveTextContent('未知');
    expect(screen.queryByText('均衡')).not.toBeInTheDocument();
  });

  it('renders opaque JSON fields without creating html nodes from their string values', () => {
    window.localStorage.setItem('dsa.uiLanguage', 'zh');
    const { container } = render(
      <UiLanguageProvider>
        <DecisionSignalDetails
          item={{
            ...signal,
            evidence: { headline: '<img src=x onerror="window.__signalEvidenceXss = true">' },
            dataQualitySummary: { note: '<script>window.__signalQualityXss = true</script>' },
            metadata: { raw: '<svg onload="window.__signalMetadataXss = true"></svg>' },
          }}
        />
      </UiLanguageProvider>,
    );

    expect(container.textContent).toContain('<img src=x onerror=\\"window.__signalEvidenceXss = true\\">');
    expect(container.textContent).toContain('<script>window.__signalQualityXss = true</script>');
    expect(container.textContent).toContain('<svg onload=\\"window.__signalMetadataXss = true\\"></svg>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('[onload]')).toBeNull();
  });

  it('renders outcome results and feedback controls', () => {
    const onFeedbackSubmit = vi.fn();
    window.localStorage.setItem('dsa.uiLanguage', 'zh');
    render(
      <UiLanguageProvider>
        <DecisionSignalDetails
          item={signal}
          outcomes={[
            {
              id: 31,
              signalId: 7,
              horizon: '3d',
              engineVersion: 'decision-signal-v1',
              evalStatus: 'completed',
              outcome: 'hit',
              directionExpected: 'not_down',
              directionCorrect: true,
              anchorDate: '2024-01-02',
              evalWindowDays: 3,
              startPrice: 100,
              endClose: 105,
              stockReturnPct: 5,
              action: 'hold',
              market: 'cn',
              planQuality: 'complete',
              dataQualityLevel: 'good',
              holdingState: 'holding',
            },
          ]}
          feedback={{
            signalId: 7,
            feedbackValue: 'useful',
            reasonCode: null,
            note: null,
            source: 'web',
          }}
          onFeedbackSubmit={onFeedbackSubmit}
        />
      </UiLanguageProvider>,
    );

    expect(screen.getByText('後驗結果')).toBeInTheDocument();
    expect(screen.getAllByText('3 日').length).toBeGreaterThan(1);
    expect(screen.getByText('命中')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('催化')).toBeInTheDocument();
    expect(screen.getByText('業績窗口')).toBeInTheDocument();
    expect(screen.getByText('失效條件')).toBeInTheDocument();
    expect(screen.getByText('跌破 1550')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '無用' }));
    expect(onFeedbackSubmit).toHaveBeenCalledWith('not_useful');
  });

  it('renders portfolio signal horizon using the current UI language', () => {
    window.localStorage.setItem('dsa.uiLanguage', 'en');
    render(
      <UiLanguageProvider>
        <PortfolioSignalSummary item={{ ...signal, horizon: '10d', action: 'sell', actionLabel: null }} />
      </UiLanguageProvider>,
    );

    expect(screen.getByText('10 days')).toBeInTheDocument();
    expect(screen.queryByText('10d')).not.toBeInTheDocument();
  });
});
