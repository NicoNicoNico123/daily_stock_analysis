import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskPanel } from '../TaskPanel';
import type { TaskInfo } from '../../../types/analysis';

const baseTask: TaskInfo = {
  taskId: 'task-1',
  stockCode: '600519',
  stockName: '貴州茅臺',
  status: 'processing',
  progress: 40,
  message: '正在抓取最新行情',
  reportType: 'detailed',
  createdAt: '2026-03-21T08:00:00Z',
};

describe('TaskPanel', () => {
  it('renders requested analysis phase badges for active tasks', () => {
    render(
      <TaskPanel
        tasks={[
          {
            ...baseTask,
            analysisPhase: 'intraday',
          },
          {
            ...baseTask,
            taskId: 'task-2',
            stockCode: 'AAPL',
            stockName: 'Apple',
            status: 'pending',
            analysisPhase: 'auto',
          },
        ]}
      />,
    );

    expect(screen.getByLabelText('請求階段: 盤中')).toBeInTheDocument();
    expect(screen.getByLabelText('請求階段: 自動階段')).toBeInTheDocument();
  });

  it('renders active tasks with preserved dashboard panel styling', () => {
    const { container } = render(
      <TaskPanel
        tasks={[
          {
            ...baseTask,
            traceId: 'trace-task-1',
          },
          {
            ...baseTask,
            taskId: 'task-2',
            stockCode: 'AAPL',
            stockName: 'Apple',
            status: 'pending',
            message: '等待分析隊列',
          },
        ]}
      />,
    );

    expect(screen.getByText('分析任務')).toBeInTheDocument();
    expect(screen.getByText('1 進行中')).toBeInTheDocument();
    expect(screen.getByText('1 等待中')).toBeInTheDocument();
    expect(screen.getByText('貴州茅臺')).toBeInTheDocument();
    expect(screen.getByText('AAPL')).toBeInTheDocument();
    expect(screen.getByLabelText('任務狀態：分析中')).toBeInTheDocument();
    expect(screen.getByText('運行診斷')).toBeInTheDocument();
    expect(screen.getAllByText('trace-task-1')).toHaveLength(2);
    expect(screen.queryByText(/请求阶段:/)).not.toBeInTheDocument();
    expect(container.querySelector('.home-panel-card')).toBeTruthy();
    expect(container.querySelector('.home-subpanel')).toBeTruthy();
  });

  it('collapses into a one-line summary and expands back with aria state', () => {
    render(
      <TaskPanel
        tasks={[
          {
            ...baseTask,
            progress: 40,
          },
          {
            ...baseTask,
            taskId: 'task-2',
            stockCode: 'AAPL',
            stockName: 'Apple',
            status: 'pending',
            progress: 0,
          },
        ]}
      />,
    );

    const collapseButton = screen.getByRole('button', { name: '摺疊任務面板' });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(collapseButton);

    const expandButton = screen.getByRole('button', { name: '展開任務面板' });
    expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('task-panel-collapsed-summary')).toHaveTextContent('1 進行中');
    expect(screen.getByTestId('task-panel-collapsed-summary')).toHaveTextContent('1 等待中');
    expect(screen.getByTestId('task-panel-collapsed-summary')).toHaveTextContent('平均進度 40%');
    expect(screen.queryByTestId('task-panel-item')).not.toBeInTheDocument();

    fireEvent.click(expandButton);

    expect(screen.getByRole('button', { name: '摺疊任務面板' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('task-panel-item')).toHaveLength(2);
  });

  it('keeps narrow sidebar task metadata in rows instead of squeezing diagnostics vertically', () => {
    render(
      <TaskPanel
        tasks={[
          {
            ...baseTask,
            stockCode: '601869.SH',
            stockName: '長飛光纖',
            progress: 32,
            message: '長飛光纖: 請求階段: 自動階段',
            analysisPhase: 'auto',
            traceId: 'c5b9665a64e3b9f42ad9f',
          },
        ]}
        onOpenRunFlow={vi.fn()}
      />,
    );

    const item = screen.getByTestId('task-panel-item');
    expect(item).toHaveClass('grid');
    expect(item).not.toHaveClass('flex');
    expect(screen.getByText('長飛光纖')).toHaveClass('truncate');
    expect(screen.getByText('601869.SH')).toHaveClass('shrink-0');
    expect(screen.getByText('32%')).toBeInTheDocument();

    const diagnosticsSummary = screen.getByTestId('task-panel-diagnostics-summary');
    expect(diagnosticsSummary).toHaveClass('grid-cols-[auto_minmax(0,1fr)_auto]');
    expect(screen.getByText('運行診斷')).toHaveClass('whitespace-nowrap');
    expect(screen.getByText('c5b9665a64...')).toHaveClass('truncate');
    expect(screen.getByRole('button', { name: '查看 長飛光纖 運行流' })).toBeInTheDocument();
  });

  it('opens the run-flow view from an active task icon button', () => {
    const onOpenRunFlow = vi.fn();
    render(
      <TaskPanel
        tasks={[baseTask]}
        onOpenRunFlow={onOpenRunFlow}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '查看 貴州茅臺 運行流' }));

    expect(onOpenRunFlow).toHaveBeenCalledWith(baseTask);
  });

  it('keeps cancel-requested tasks visible without rendering them as failed', () => {
    render(
      <TaskPanel
        tasks={[
          {
            ...baseTask,
            status: 'cancel_requested',
            message: '正在請求取消',
          },
        ]}
      />,
    );

    expect(screen.getByText('貴州茅臺')).toBeInTheDocument();
    expect(screen.getByLabelText('任務狀態：請求取消')).toBeInTheDocument();
    expect(screen.queryByText('失敗')).not.toBeInTheDocument();
  });

  it('does not keep cancelled terminal tasks in the active task panel', () => {
    const { container } = render(
      <TaskPanel
        tasks={[
          {
            ...baseTask,
            status: 'cancelled',
          },
        ]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('does not render when there are no active tasks', () => {
    const { container } = render(
      <TaskPanel
        tasks={[
          {
            ...baseTask,
            status: 'completed',
          },
        ]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
