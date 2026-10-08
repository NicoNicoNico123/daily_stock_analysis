import type React from 'react';
import { useEffect, useState } from 'react';
import { Menu } from 'lucide-react';
import { Outlet } from 'react-router-dom';
import { Drawer } from '../common/Drawer';
import { SidebarNav } from './SidebarNav';
import { DesktopUpdateIndicator } from './DesktopUpdateIndicator';
import { ThemeToggle } from '../theme/ThemeToggle';
import { UiLanguageToggle } from '../i18n/UiLanguageToggle';
import { useUiLanguage } from '../../contexts/UiLanguageContext';

type ShellProps = {
  children?: React.ReactNode;
};

export const Shell: React.FC<ShellProps> = ({ children }) => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const collapsed = false;
  const { t } = useUiLanguage();

  useEffect(() => {
    if (!mobileOpen) {
      return undefined;
    }

    const handleResize = () => {
      if (window.innerWidth >= 1024) {
        setMobileOpen(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [mobileOpen]);

  return (
    <div className="control-app min-h-screen text-foreground">
      <div className="control-mobile-bar flex items-center justify-between gap-3 px-3 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="inline-flex h-10 w-10 items-center justify-center border-2 border-[#d6ff3c] text-[#f6f3ea]"
          aria-label={t('layout.openNav')}
        >
          <Menu className="h-5 w-5" />
        </button>
        <p className="control-brand-mark">DSA</p>
        <div className="flex items-center gap-2">
          <DesktopUpdateIndicator />
          <UiLanguageToggle />
          <ThemeToggle />
        </div>
      </div>

      <div className="flex min-h-screen w-full">
        <aside
          className="control-rail sticky top-0 z-40 hidden h-screen w-[232px] shrink-0 flex-col overflow-y-auto p-3 lg:flex"
          aria-label={t('layout.desktopSidebar')}
        >
          <SidebarNav collapsed={collapsed} onNavigate={() => setMobileOpen(false)} />
        </aside>

        <main className="min-h-0 min-w-0 flex-1 touch-pan-y">
          <div className="hidden justify-end px-4 pt-3 lg:flex">
            <DesktopUpdateIndicator />
          </div>
          {children ?? <Outlet />}
        </main>
      </div>

      <Drawer
        isOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        title={t('layout.navMenu')}
        width="max-w-xs"
        zIndex={90}
        side="left"
      >
        <div className="control-rail min-h-[70vh] p-3">
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </div>
      </Drawer>
    </div>
  );
};
