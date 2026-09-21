import type React from 'react';
import { useUiLanguage } from '../../contexts/UiLanguageContext';

/** 后端当前支持的第三方登录提供方。 */
export type OAuthProviderName = 'google' | 'facebook';

/** Google 四色 "G" 品牌图标（inline SVG，跟随官方 18px 网格）。 */
export const GoogleIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 18 18" aria-hidden="true" focusable="false">
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18Z"
    />
    <path
      fill="#FBBC05"
      d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34Z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.42 0 9 0A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58Z"
    />
  </svg>
);

/** Facebook 品牌 "f" 图标（inline SVG）。 */
export const FacebookIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      fill="#1877F2"
      d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.09 24 18.1 24 12.07Z"
    />
  </svg>
);

type OAuthButtonsProps = {
  /** Providers reported by /api/v1/auth/status (already filtered by backend config). */
  providers: string[];
};

/**
 * 第三方登录按钮组：点按即整页跳转到后端 authorize 端点（后端再 302 到服务商），
 * 回调成功后由 /oauth/callback 页面接管。
 */
export const OAuthButtons: React.FC<OAuthButtonsProps> = ({ providers }) => {
  const { t } = useUiLanguage();
  if (!providers.length) {
    return null;
  }

  const items: Array<{ provider: OAuthProviderName; label: string; icon: React.ReactNode }> = [];
  if (providers.includes('google')) {
    items.push({
      provider: 'google',
      label: t('auth.continueWithGoogle'),
      icon: <GoogleIcon className="h-[18px] w-[18px]" />,
    });
  }
  if (providers.includes('facebook')) {
    items.push({
      provider: 'facebook',
      label: t('auth.continueWithFacebook'),
      icon: <FacebookIcon className="h-[18px] w-[18px]" />,
    });
  }

  return (
    <div className="space-y-3">
      {items.map(({ provider, label, icon }) => (
        <a
          key={provider}
          href={`/api/v1/auth/oauth/${provider}/authorize`}
          className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-[var(--login-border-card)] bg-[var(--login-bg-card)]/70 px-4 text-sm font-medium text-[var(--login-text-primary)] transition-colors hover:bg-[var(--login-accent-soft)] hover:text-[var(--login-text-primary)]"
        >
          {icon}
          <span>{label}</span>
        </a>
      ))}
    </div>
  );
};

/** 登录方式分隔线（「或」）。 */
export const OAuthDivider: React.FC = () => {
  const { t } = useUiLanguage();
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={t('auth.orDivider')}>
      <span className="keyline-gradient h-px flex-1 opacity-40" />
      <span className="text-xs font-medium uppercase tracking-wider text-[var(--login-text-muted)]">
        {t('auth.orDivider')}
      </span>
      <span className="keyline-gradient h-px flex-1 opacity-40" />
    </div>
  );
};
