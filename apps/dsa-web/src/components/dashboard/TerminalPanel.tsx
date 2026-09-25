import type React from 'react';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import { cn } from '../../utils/cn';

interface TerminalPanelProps {
  label: string;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

/**
 * 終端面板骨架： uppercase 微標籤標頭 + 髮絲邊框玻璃卡身，
 * 供儀表板多面板網格中的側欄卡片使用。
 */
export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  label,
  actions,
  className = '',
  bodyClassName = '',
  children,
}) => {
  const { t } = useUiLanguage();
  return (
    <section className={cn('terminal-panel flex min-h-0 flex-col overflow-hidden', className)}>
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-secondary-text">{label}</span>
        {actions}
      </header>
      <div className={cn('min-h-0 flex-1 overflow-y-auto', bodyClassName)}>
        {children ?? <span className="sr-only">{t('common.noData')}</span>}
      </div>
    </section>
  );
};

export default TerminalPanel;
