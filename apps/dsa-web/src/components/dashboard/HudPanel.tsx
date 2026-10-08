import type React from 'react';
import { cn } from '../../utils/cn';

interface HudPanelProps {
  /** Short index such as "01". Shown as a mono stamp, not a sequence claim. */
  index?: string;
  label: string;
  actions?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

/**
 * Hard-edged control panel: ink rule, mono label, paper or ink fill.
 */
export const HudPanel: React.FC<HudPanelProps> = ({
  index,
  label,
  actions,
  className = '',
  bodyClassName = '',
  children,
}) => (
  <section className={cn('control-panel flex min-h-0 flex-col overflow-hidden', className)}>
    <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b-2 border-current px-3">
      <span className="flex min-w-0 items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em]">
        {index ? <span className="control-index">{index}</span> : null}
        <span className="truncate">{label}</span>
      </span>
      {actions}
    </header>
    <div className={cn('min-h-0 flex-1 overflow-y-auto', bodyClassName)}>{children}</div>
  </section>
);

export default HudPanel;
