import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunFlowNode } from '../../../types/runFlow';
import { RunFlowNodeDetails } from '../RunFlowNodeDetails';

describe('RunFlowNodeDetails', () => {
  it('hides provider metrics that do not apply to queue nodes', () => {
    const node: RunFlowNode = {
      id: 'task_queue',
      lane: 'entry',
      kind: 'queue',
      label: '任務隊列',
      status: 'success',
      startedAt: '2026-06-08T22:14:25',
      message: '任務進入運行隊列',
    };

    render(<RunFlowNodeDetails node={node} />);

    expect(screen.getByText('任務隊列')).toBeInTheDocument();
    expect(screen.getByText('類型')).toBeInTheDocument();
    expect(screen.getByText('隊列')).toBeInTheDocument();
    expect(screen.getByText('開始時間')).toBeInTheDocument();
    expect(screen.queryByText('提供方')).not.toBeInTheDocument();
    expect(screen.queryByText('耗時')).not.toBeInTheDocument();
    expect(screen.queryByText('嘗試次數')).not.toBeInTheDocument();
    expect(screen.queryByText('記錄數')).not.toBeInTheDocument();
  });

  it('renders ContextPack quality metadata as structured details instead of raw JSON', () => {
    const node: RunFlowNode = {
      id: 'context_pack',
      lane: 'analysis',
      kind: 'analysis',
      label: 'ContextPack',
      status: 'degraded',
      metadata: {
        topologyGroup: 'context_pack',
        packVersion: '1.0',
        counts: {
          available: 4,
          missing: 1,
          partial: 1,
          fallback: 0,
        },
        dataQuality: {
          overallScore: 91,
          level: 'good',
          blockScores: {
            quote: 100,
            dailyBars: 100,
            technical: 100,
            news: 35,
          },
        },
        context_status_counts: {
          success: 4,
          degraded: 1,
          skipped: 1,
        },
      },
    };

    render(<RunFlowNodeDetails node={node} />);

    expect(screen.getByText('上下文質量')).toBeInTheDocument();
    expect(screen.getByText('綜合評分')).toBeInTheDocument();
    expect(screen.getByText('91')).toBeInTheDocument();
    expect(screen.getByText('數據塊評分')).toBeInTheDocument();
    expect(screen.getByText('news')).toBeInTheDocument();
    expect(screen.getByText('35')).toBeInTheDocument();
    expect(screen.getByText('版本')).toBeInTheDocument();
    expect(screen.getByText('1.0')).toBeInTheDocument();
    expect(screen.queryByText('提供方')).not.toBeInTheDocument();
    expect(screen.queryByText('耗時')).not.toBeInTheDocument();
    expect(screen.queryByText('嘗試次數')).not.toBeInTheDocument();
    expect(screen.queryByText('記錄數')).not.toBeInTheDocument();
    expect(screen.queryByText('counts')).not.toBeInTheDocument();
    expect(screen.queryByText('dataQuality')).not.toBeInTheDocument();
    expect(screen.queryByText('context_status_counts')).not.toBeInTheDocument();
    expect(screen.queryByText(/overallScore/)).not.toBeInTheDocument();
  });

  it('keeps provider metrics visible for data source nodes', () => {
    const node: RunFlowNode = {
      id: 'topology_data_realtime_quote',
      lane: 'data_source',
      kind: 'data_source',
      label: '實時行情',
      provider: 'TushareFetcher -> AkshareFetcher',
      status: 'fallback',
      durationMs: 750,
      attempts: 2,
      recordCount: 39,
    };

    render(<RunFlowNodeDetails node={node} />);

    expect(screen.getByText('提供方')).toBeInTheDocument();
    expect(screen.getByText('TushareFetcher -> AkshareFetcher')).toBeInTheDocument();
    expect(screen.getByText('耗時')).toBeInTheDocument();
    expect(screen.getByText('750 ms')).toBeInTheDocument();
    expect(screen.getByText('嘗試次數')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('記錄數')).toBeInTheDocument();
    expect(screen.getByText('39')).toBeInTheDocument();
  });
});
