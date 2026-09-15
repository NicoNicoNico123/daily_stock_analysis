import type React from 'react';
import { useCallback, useState } from 'react';
import { Drawer } from '../common/Drawer';
import { ReportMarkdownPanel } from './ReportMarkdownPanel';

export interface ReportMarkdownProps {
  recordId: number;
  stockName: string;
  stockCode: string;
  onClose: () => void;
}

/**
 * Compatibility wrapper for direct ReportMarkdown usage.
 * HomePage uses ReportMarkdownDrawer to lazy-load the panel.
 */
export const ReportMarkdown: React.FC<ReportMarkdownProps> = ({
  recordId,
  stockName,
  stockCode,
  onClose,
}) => {
  const [isOpen, setIsOpen] = useState(true);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  return (
    <Drawer
      isOpen={isOpen}
      onClose={handleClose}
      width="max-w-3xl"
      zIndex={100}
      backdropClassName="bg-background/56 backdrop-blur-[2px]"
    >
      <ReportMarkdownPanel
        recordId={recordId}
        stockName={stockName}
        stockCode={stockCode}
        onRequestClose={handleClose}
      />
    </Drawer>
  );
};
