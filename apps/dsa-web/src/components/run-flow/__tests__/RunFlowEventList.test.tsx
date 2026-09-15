import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RunFlowEvent } from '../../../types/runFlow';
import { RunFlowEventList } from '../RunFlowEventList';

const events: RunFlowEvent[] = [
  {
    id: 'evt-1',
    timestamp: '2026-06-08T08:00:01Z',
    severity: 'info',
    type: 'task_created',
    nodeId: 'request',
    title: '任務創建',
  },
  {
    id: 'evt-2',
    timestamp: '2026-06-08T08:00:02Z',
    severity: 'warning',
    type: 'provider_fallback',
    nodeId: 'daily_data',
    title: '日線降級',
    message: 'Tushare 失敗後切換 AkShare',
  },
  {
    id: 'evt-3',
    timestamp: '2026-06-08T08:00:03Z',
    severity: 'danger',
    type: 'task_cancelled',
    nodeId: 'queue',
    title: '任務取消',
  },
];

describe('RunFlowEventList', () => {
  it('filters fallback and cancellation events with visible text labels', () => {
    render(<RunFlowEventList events={events} />);

    expect(screen.getByText('任務創建')).toBeInTheDocument();
    expect(screen.getByText('日線降級')).toBeInTheDocument();
    expect(screen.getByText('任務取消')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '降級回退/重試' }));

    expect(screen.getByText('日線降級')).toBeInTheDocument();
    expect(screen.queryByText('任務創建')).not.toBeInTheDocument();
    expect(screen.queryByText('任務取消')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.getByText('任務取消')).toBeInTheDocument();
    expect(screen.queryByText('日線降級')).not.toBeInTheDocument();
    expect(screen.getByText('危險')).toBeInTheDocument();
  });

  it('selects the event node when an event row is clicked', () => {
    const onSelectNode = vi.fn();
    render(<RunFlowEventList events={events} onSelectNode={onSelectNode} />);

    fireEvent.click(screen.getByRole('button', { name: '查看事件 日線降級 關聯節點' }));

    expect(onSelectNode).toHaveBeenCalledWith('daily_data');
  });
});
