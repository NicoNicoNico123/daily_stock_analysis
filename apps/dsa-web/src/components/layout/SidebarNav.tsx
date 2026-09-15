import React, { useEffect, useRef, useState } from 'react';
import { Activity, BarChart3, Bell, BriefcaseBusiness, CircleUser, Gauge, Home, KeyRound, LogOut, MessageSquareQuote, Search, Settings2, UserCog } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { fetchAuthIdentity } from '../../api/adminUsers';
import type { AuthIdentityStatus } from '../../api/adminUsers';
import { SCREENING_CONFIG_CHANGED_EVENT, SYSTEM_CONFIG_CHANGED_EVENT, screeningApi } from '../../api/screening';
import { useAuth } from '../../contexts/AuthContext';
import { useAgentChatStore } from '../../stores/agentChatStore';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import type { UiTextKey } from '../../i18n/uiText';
import { cn } from '../../utils/cn';
import { Badge } from '../common/Badge';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { StatusDot } from '../common/StatusDot';
import { UiLanguageToggle } from '../i18n/UiLanguageToggle';
import { ThemeToggle } from '../theme/ThemeToggle';

type SidebarNavProps = {
  collapsed?: boolean;
  onNavigate?: () => void;
  variant?: 'default' | 'rail';
};

type NavItem = {
  key: string;
  labelKey: UiTextKey;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
  badge?: 'completion';
};

const NAV_ITEMS: NavItem[] = [
  { key: 'home', labelKey: 'layout.nav.home', to: '/', icon: Home, exact: true },
  { key: 'chat', labelKey: 'layout.nav.chat', to: '/chat', icon: MessageSquareQuote, badge: 'completion' },
  { key: 'screening', labelKey: 'layout.nav.screening', to: '/screening', icon: Search },
  { key: 'portfolio', labelKey: 'layout.nav.portfolio', to: '/portfolio', icon: BriefcaseBusiness },
  { key: 'decision-signals', labelKey: 'layout.nav.decisionSignals', to: '/decision-signals', icon: Activity },
  { key: 'backtest', labelKey: 'layout.nav.backtest', to: '/backtest', icon: BarChart3 },
  { key: 'alerts', labelKey: 'layout.nav.alerts', to: '/alerts', icon: Bell },
  { key: 'usage', labelKey: 'layout.nav.usage', to: '/usage', icon: Gauge },
  { key: 'settings', labelKey: 'layout.nav.settings', to: '/settings', icon: Settings2 },
];

const USERS_NAV_ITEM: NavItem = { key: 'users', labelKey: 'layout.nav.users', to: '/users', icon: UserCog };

const USER_MENU_ITEM_CLASS = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-secondary-text transition-colors hover:bg-hover hover:text-foreground';

export const SidebarNav: React.FC<SidebarNavProps> = ({ collapsed = false, onNavigate, variant = 'default' }) => {
  const { authEnabled, loggedIn, logout } = useAuth();
  const { t } = useUiLanguage();
  const navigate = useNavigate();
  const completionBadge = useAgentChatStore((state) => state.completionBadge);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showScreeningNav, setShowScreeningNav] = useState(false);
  const [identity, setIdentity] = useState<AuthIdentityStatus | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;

    const refreshScreeningStatus = async () => {
      try {
        const status = await screeningApi.getStatus();
        if (active) {
          setShowScreeningNav(status.enabled);
        }
      } catch {
        if (active) {
          setShowScreeningNav(false);
        }
      }
    };

    void refreshScreeningStatus();
    window.addEventListener(SCREENING_CONFIG_CHANGED_EVENT, refreshScreeningStatus);
    window.addEventListener(SYSTEM_CONFIG_CHANGED_EVENT, refreshScreeningStatus);

    return () => {
      active = false;
      window.removeEventListener(SCREENING_CONFIG_CHANGED_EVENT, refreshScreeningStatus);
      window.removeEventListener(SYSTEM_CONFIG_CHANGED_EVENT, refreshScreeningStatus);
    };
  }, []);

  // 多用户身份字段不在 AuthContext 里，这里单独读取一次；多用户关闭时保持原退出按钮。
  useEffect(() => {
    if (!authEnabled || !loggedIn) {
      return;
    }
    let active = true;
    fetchAuthIdentity()
      .then((status) => {
        if (active) {
          setIdentity(status);
        }
      })
      .catch(() => {
        if (active) {
          setIdentity(null);
        }
      });
    return () => {
      active = false;
    };
  }, [authEnabled, loggedIn]);

  // 未登录时直接派生为 null，避免在 effect 里同步清空状态。
  const identityStatus = authEnabled && loggedIn ? identity : null;
  const multiUserEnabled = Boolean(identityStatus?.multiUser);
  const identityRole = identityStatus?.role;
  const showUsersNav = multiUserEnabled && identityRole === 'admin';

  useEffect(() => {
    if (!showUserMenu) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const node = userMenuRef.current;
      if (node && event.target instanceof Node && !node.contains(event.target)) {
        setShowUserMenu(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showUserMenu]);

  const navItems = (showScreeningNav ? NAV_ITEMS : NAV_ITEMS.filter((item) => item.key !== 'screening'))
    .flatMap((item) => (item.key === 'settings' && showUsersNav ? [USERS_NAV_ITEM, item] : [item]));
  const isRail = variant === 'rail';
  const itemBaseClass = cn(
    'group relative flex h-[var(--nav-item-height)] w-full items-center overflow-hidden rounded-2xl border border-transparent text-sm leading-none text-secondary-text transition-all',
    isRail
      ? 'justify-center gap-2.5 px-2'
      : collapsed
        ? 'justify-center px-0'
        : 'gap-3 px-[var(--nav-item-padding-x)]'
  );
  const itemInteractiveClass = cn(
    itemBaseClass,
    'hover:bg-[var(--nav-hover-bg)] hover:text-foreground'
  );
  const itemActiveClass = 'border-[var(--nav-active-border)] bg-[var(--nav-active-bg)] font-medium text-[hsl(var(--primary))]';
  const itemIconClass = cn(isRail ? 'h-[18px] w-[18px]' : 'h-5 w-5', 'shrink-0');
  const itemLabelClass = cn('truncate', isRail ? 'text-center' : '');

  const closeUserMenu = () => setShowUserMenu(false);

  const handleChangePassword = () => {
    closeUserMenu();
    onNavigate?.();
    // 修改密码卡片位于「设置 -> 系统」分区，带 category 参数直接定位。
    navigate('/settings?category=system');
  };

  const beginLogout = () => {
    closeUserMenu();
    setShowLogoutConfirm(true);
  };

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          'flex items-center',
          isRail ? 'mb-5 justify-center gap-2 pt-1' : 'mb-4 gap-2 px-1',
          collapsed || isRail ? 'justify-center' : ''
        )}
      >
        <div
          className={cn(
            'flex items-center justify-center bg-primary-gradient text-[hsl(var(--primary-foreground))] shadow-[0_12px_28px_var(--nav-brand-shadow)]',
            isRail ? 'h-9 w-9 rounded-[1rem]' : 'h-10 w-10 rounded-2xl'
          )}
        >
          <BarChart3 className={cn(isRail ? 'h-[19px] w-[19px]' : 'h-5 w-5')} />
        </div>
        {!collapsed ? (
          <p className={cn('min-w-0 truncate font-semibold text-foreground', isRail ? 'text-[0.95rem] leading-none' : 'text-sm')}>DSA</p>
        ) : null}
      </div>

      <nav className={cn('flex flex-col gap-1.5', isRail ? '' : 'flex-1')} aria-label={t('layout.mainNav')}>
        {navItems.map(({ key, labelKey, to, icon: Icon, exact, badge }) => {
          const label = t(labelKey);
          return (
          <NavLink
            key={key}
            to={to}
            end={exact}
            onClick={onNavigate}
            aria-label={label}
            className={({ isActive }) =>
              cn(
                itemInteractiveClass,
                isActive ? itemActiveClass : ''
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={cn(itemIconClass, isActive ? 'text-[var(--nav-icon-active)]' : 'text-current')} />
                {!collapsed ? <span className={itemLabelClass}>{label}</span> : null}
                {badge === 'completion' && completionBadge ? (
                  <StatusDot
                    tone="info"
                    data-testid="chat-completion-badge"
                    className={cn(
                      'absolute right-3 border-2 border-background shadow-[0_0_10px_var(--nav-indicator-shadow)]',
                      collapsed ? 'right-2 top-2' : ''
                    )}
                    aria-label={t('layout.newChatMessage')}
                  />
                ) : null}
              </>
            )}
          </NavLink>
        );
        })}

        <ThemeToggle
          variant={isRail ? 'rail' : 'nav'}
          collapsed={collapsed}
          wrapperClassName="w-full"
          triggerClassName={itemInteractiveClass}
          triggerActiveClassName={itemActiveClass}
          iconClassName={itemIconClass}
          labelClassName={itemLabelClass}
        />
        <UiLanguageToggle
          variant={isRail ? 'rail' : 'nav'}
          collapsed={collapsed}
          wrapperClassName="w-full"
          triggerClassName={itemInteractiveClass}
          triggerActiveClassName={itemActiveClass}
          iconClassName={itemIconClass}
          labelClassName={itemLabelClass}
        />
      </nav>

      {authEnabled && multiUserEnabled ? (
        <div ref={userMenuRef} className={cn('relative w-full', isRail ? 'mt-1.5' : 'mt-5')}>
          <button
            type="button"
            onClick={() => setShowUserMenu((current) => !current)}
            aria-haspopup="menu"
            aria-expanded={showUserMenu}
            className={cn(itemInteractiveClass, showUserMenu ? itemActiveClass : '')}
          >
            <CircleUser className={itemIconClass} />
            {!collapsed ? (
              <span className={cn(itemLabelClass, 'text-left')}>{identityStatus?.username || t('layout.userMenu.user')}</span>
            ) : null}
          </button>

          {showUserMenu ? (
            <div
              role="menu"
              className="absolute bottom-full left-0 z-50 mb-2 w-44 overflow-hidden rounded-xl border border-border/70 bg-card/95 p-1.5 shadow-2xl backdrop-blur-md"
            >
              <div className="px-2.5 py-1.5">
                <p className="truncate text-sm font-medium text-foreground">
                  {identityStatus?.username || t('layout.userMenu.user')}
                </p>
                <Badge variant={identityRole === 'admin' ? 'info' : 'default'} className="mt-1">
                  {identityRole === 'admin' ? t('layout.userMenu.admin') : t('layout.userMenu.user')}
                </Badge>
              </div>
              <div className="my-1 h-px bg-border/60" />
              <button type="button" role="menuitem" className={USER_MENU_ITEM_CLASS} onClick={handleChangePassword}>
                <KeyRound className="h-4 w-4 shrink-0" />
                {t('layout.userMenu.changePassword')}
              </button>
              <button type="button" role="menuitem" className={USER_MENU_ITEM_CLASS} onClick={beginLogout}>
                <LogOut className="h-4 w-4 shrink-0" />
                {t('layout.userMenu.logout')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {authEnabled && !multiUserEnabled ? (
        <button
          type="button"
          onClick={() => setShowLogoutConfirm(true)}
          className={cn(
            itemInteractiveClass,
            isRail ? 'mt-1.5' : 'mt-5'
          )}
        >
          <LogOut className={itemIconClass} />
          {!collapsed ? <span className={itemLabelClass}>{t('layout.logout')}</span> : null}
        </button>
      ) : null}

      <ConfirmDialog
        isOpen={showLogoutConfirm}
        title={t('layout.logoutTitle')}
        message={multiUserEnabled ? t('layout.userMenu.logoutConfirm') : t('layout.logoutMessage')}
        confirmText={t('layout.logoutConfirm')}
        cancelText={t('common.cancel')}
        isDanger
        onConfirm={() => {
          setShowLogoutConfirm(false);
          onNavigate?.();
          void logout();
        }}
        onCancel={() => setShowLogoutConfirm(false)}
      />
    </div>
  );
};
