import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MarketStructureContext } from '../../../types/analysis';
import { UiLanguageProvider } from '../../../contexts/UiLanguageContext';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import { MarketStructureCard } from '../MarketStructureCard';

const renderWithUiLanguage = (ui: ReactNode, language: 'zh' | 'en') => {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  return render(<UiLanguageProvider>{ui}</UiLanguageProvider>);
};

const context: MarketStructureContext = {
  schemaVersion: 'market-structure-v1',
  status: 'partial',
  market: 'cn',
  tradeDate: '2026-07-04',
  marketThemeContext: {
    schemaVersion: 'market-theme-v1',
    status: 'partial',
    market: 'cn',
    activeThemes: [
      { name: '機器人概念', changePct: 4.2, rank: 1, source: 'concept', phase: 'accelerating' },
    ],
    leadingConcepts: [
      { name: '機器人概念', changePct: 4.2, rank: 1, source: 'concept' },
    ],
    leadingIndustries: [
      { name: '通用設備', changePct: 2.1, rank: 2, source: 'industry' },
    ],
    laggingThemes: [],
    themeBreadth: {
      activeCount: 1,
      leadingConceptCount: 1,
      leadingIndustryCount: 1,
      laggingCount: 0,
    },
    dataQuality: {
      status: 'partial',
      missingFields: ['industry_rankings'],
      sources: [],
      errors: [],
    },
  },
  stockMarketPosition: {
    schemaVersion: 'stock-market-position-v1',
    status: 'partial',
    stockCode: '300024',
    stockName: '機器人',
    market: 'cn',
    primaryTheme: {
      name: '機器人概念',
      source: 'concept',
      phase: 'accelerating',
      rank: 1,
      changePct: 4.2,
    },
    relatedBoards: [
      { name: '機器人概念', type: '概念', source: 'concept', rank: 1, changePct: 4.2 },
    ],
    stockRole: 'follower',
    themePhase: 'accelerating',
    riskTags: [
      { code: 'theme_data_partial', message: '題材主線數據不完整' },
      { code: 'stock_theme_evidence_partial', message: '個股板塊未匹配到市場題材榜單，個股位置按降級證據處理' },
    ],
    missingFields: ['hotspot_constituents', 'leader_stocks'],
  },
};

describe('MarketStructureCard', () => {
  it('renders market layer and stock layer with the chinese interface', () => {
    renderWithUiLanguage(<MarketStructureCard context={context} />, 'zh');

    expect(screen.getByRole('region', { name: '題材主線與個股位置' })).toBeInTheDocument();
    expect(screen.getByText('大盤題材層')).toBeVisible();
    expect(screen.getByText('個股位置層')).toBeVisible();
    expect(screen.getAllByText('部分可用')).toHaveLength(3);
    expect(screen.getAllByText(/機器人概念/)).toHaveLength(3);
    expect(screen.getByText('加速')).toBeVisible();
    expect(screen.getByText('跟隨')).toBeVisible();
    expect(screen.getByText('題材主線數據不完整')).toBeVisible();
    expect(screen.getByText('leader_stocks')).toBeVisible();
  });

  it('renders English labels', () => {
    renderWithUiLanguage(<MarketStructureCard context={context} />, 'en');

    expect(screen.getByRole('region', { name: 'Themes and Stock Position' })).toBeInTheDocument();
    expect(screen.getByText('Market Theme Layer')).toBeVisible();
    expect(screen.getByText('Stock Position Layer')).toBeVisible();
    expect(screen.getByText('Accelerating')).toBeVisible();
    expect(screen.getByText('Follower')).toBeVisible();
    expect(screen.getByText('Missing Evidence')).toBeVisible();
    expect(screen.getByText('Market theme data is incomplete')).toBeVisible();
    expect(screen.getByText('Stock board did not match theme rankings')).toBeVisible();
    expect(screen.queryByText('題材主線數據不完整')).not.toBeInTheDocument();
  });

  it('keeps backend risk-tag messages verbatim when no frontend label exists', () => {
    const backendMessageContext: MarketStructureContext = {
      ...context,
      stockMarketPosition: {
        ...context.stockMarketPosition,
        riskTags: [
          { code: 'brand_new_internal_code', message: '題材榜單暫不可用' },
        ],
      },
    };

    renderWithUiLanguage(<MarketStructureCard context={backendMessageContext} />, 'en');

    expect(screen.getByText('題材榜單暫不可用')).toBeVisible();
  });

  it('does not render unsupported or invalid context', () => {
    const unsupported = {
      ...context,
      status: 'not_supported',
    } satisfies MarketStructureContext;

    const { container, rerender } = render(<MarketStructureCard context={unsupported} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<MarketStructureCard context={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
