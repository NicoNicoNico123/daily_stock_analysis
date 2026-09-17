import React, { useMemo } from 'react';
import type { AnalysisResult, AnalysisReport } from '../../types/analysis';
import { ReportOverview } from './ReportOverview';
import { ReportStrategy } from './ReportStrategy';
import { PriceChartPanel } from './PriceChartPanel';
import { ReportNews } from './ReportNews';
import { ReportDetails } from './ReportDetails';
import { ReportDiagnostics } from './ReportDiagnostics';
import { AnalysisContextSummary } from './AnalysisContextSummary';
import { MarketReviewReportView } from './MarketReviewReportView';
import { getReportText } from '../../utils/reportLanguage';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { useReportTranslation } from '../../hooks/useReportTranslation';

interface ReportSummaryProps {
  data: AnalysisResult | AnalysisReport;
  isHistory?: boolean;
  /** 自选相关 */
  watchlist?: {
    isInWatchlist: (code: string) => boolean;
    onToggle: (code: string) => void;
    isActioning: boolean;
    actionMessage: string | null;
  };
  onOpenRunFlow?: (recordId: number) => void;
}

/**
 * 完整报告展示组件
 * 按主体内容优先、透明度信息后置的顺序展示报告。
 */
export const ReportSummary: React.FC<ReportSummaryProps> = ({
  data,
  isHistory = false,
  watchlist,
  onOpenRunFlow,
}) => {
  // 兼容 AnalysisResult 和 AnalysisReport 两种数据格式
  const report: AnalysisReport = 'report' in data ? data.report : data;
  // 使用 report id，因为 queryId 在批量分析时可能重复，且历史报告详情接口需要 recordId 来获取关联资讯和详情数据
  const recordId = report.meta.id;
  const diagnosticSummary = 'diagnosticSummary' in data ? data.diagnosticSummary : undefined;

  const { meta, summary, strategy, details } = report;
  // 区块标签统一跟随界面语言；报告正文内容仍由后端按报告语言生成。
  const { language: uiLanguage } = useUiLanguage();
  const text = getReportText(uiLanguage);
  const modelUsed = (meta.modelUsed || '').trim();
  const shouldShowModel = Boolean(
    modelUsed && !['unknown', 'error', 'none', 'null', 'n/a'].includes(modelUsed.toLowerCase()),
  );

  // 英文界面下，报告正文（结论/建议/趋势/点位）优先使用后端 LLM 翻译结果；
  // 翻译未就绪或失败时回退原文，不阻塞首屏渲染。
  const translated = useReportTranslation(recordId);
  const localizedSummary = useMemo(() => {
    const translatedSummary = translated?.summary;
    if (!translatedSummary) {
      return summary;
    }
    return {
      ...summary,
      analysisSummary: translatedSummary.analysisSummary || summary.analysisSummary,
      operationAdvice: translatedSummary.operationAdvice || summary.operationAdvice,
      trendPrediction: translatedSummary.trendPrediction || summary.trendPrediction,
    };
  }, [translated, summary]);
  const localizedStrategy = useMemo(() => {
    const translatedStrategy = translated?.strategy;
    if (!translatedStrategy) {
      return strategy;
    }
    const hasTranslation = Boolean(
      translatedStrategy.idealBuy
        || translatedStrategy.secondaryBuy
        || translatedStrategy.stopLoss
        || translatedStrategy.takeProfit,
    );
    if (!hasTranslation) {
      return strategy;
    }
    return {
      ...strategy,
      idealBuy: translatedStrategy.idealBuy || strategy?.idealBuy,
      secondaryBuy: translatedStrategy.secondaryBuy || strategy?.secondaryBuy,
      stopLoss: translatedStrategy.stopLoss || strategy?.stopLoss,
      takeProfit: translatedStrategy.takeProfit || strategy?.takeProfit,
    };
  }, [translated, strategy]);

  if (meta.reportType === 'market_review') {
    return (
      <MarketReviewReportView
        report={report}
        recordId={recordId}
        onOpenRunFlow={onOpenRunFlow}
      />
    );
  }

  return (
    <div className="space-y-5 pb-8 animate-fade-in">
      {/* 概覽區（首屏） */}
      <ReportOverview
        meta={meta}
        summary={localizedSummary}
        details={details}
        isHistory={isHistory}
        watchlist={watchlist}
      />

      {/* 策略點位區 */}
      <ReportStrategy strategy={localizedStrategy} />

      {/* K 線圖區（策略点位 + 走勢預測示意）；levels 传入报告详情的原始策略字段 */}
      <PriceChartPanel
        code={meta.stockCode}
        levels={localizedStrategy}
        trendPrediction={localizedSummary?.trendPrediction}
      />

      {/* 資訊區 */}
      <ReportNews recordId={recordId} limit={8} />

      {/* 輸入數據塊低敏摘要 */}
      <AnalysisContextSummary
        overview={details?.analysisContextPackOverview}
      />

      {/* 運行診斷摘要 */}
      <ReportDiagnostics
        recordId={recordId}
        summary={diagnosticSummary}
        onOpenRunFlow={onOpenRunFlow}
      />

      {/* 透明度與追溯區 */}
      <ReportDetails details={details} recordId={recordId} />

      {/* 分析模型標記（Issue #528）— 報告末尾 */}
      {shouldShowModel && (
        <p className="px-1 text-xs text-muted-text">
          {text.analysisModel}: {modelUsed}
        </p>
      )}
    </div>
  );
};
