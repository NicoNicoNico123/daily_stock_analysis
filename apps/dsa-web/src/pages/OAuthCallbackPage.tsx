import type React from 'react';
import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../hooks';
import { useUiLanguage } from '../contexts/UiLanguageContext';
import { SettingsAlert } from '../components/settings';
import type { UiTextKey } from '../i18n/uiText';

// 与后端 oauth.py 的错误码保持一致；未知码回退通用文案
const OAUTH_ERROR_KEYS = [
  'oauth_disabled',
  'not_configured',
  'state_unavailable',
  'state_invalid',
  'code_missing',
  'token_exchange_failed',
  'provider_error',
  'email_missing',
  'registration_disabled',
  'quota_exceeded',
  'storage_error',
  'user_inactive',
  'session_failed',
] as const;

/**
 * OAuth 回调落地页：后端在回调里已设置会话 cookie 并 302 到 /oauth/callback?status=ok。
 * 本页面负责重新拉取登录状态并跳转首页；失败时后端直接 302 到 /login?oauthError=<code>，
 * 仅在用户手工访问本页且缺少 status 时展示错误提示。
 */
const OAuthCallbackPage: React.FC = () => {
  const { refreshStatus } = useAuth();
  const { t } = useUiLanguage();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const oauthError = searchParams.get('oauthError') ?? '';
  const status = searchParams.get('status') ?? '';
  // 渲染期直接推导错误文案（错误码由后端写入 URL，属纯派生值）
  const errorText = oauthError
    ? OAUTH_ERROR_KEYS.includes(oauthError as (typeof OAUTH_ERROR_KEYS)[number])
      ? t(`auth.oauthError.${oauthError}` as UiTextKey)
      : t('auth.oauthFailed')
    : '';

  useEffect(() => {
    if (status === 'ok' && !oauthError) {
      void refreshStatus().then(() => navigate('/', { replace: true }));
    }
  }, [status, oauthError, refreshStatus, navigate]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-[var(--login-bg-main)] px-4">
      {errorText ? (
        <div className="w-full max-w-md space-y-4">
          <SettingsAlert
            title={t('auth.oauthFailed')}
            message={errorText}
            variant="error"
            className="!border-[var(--login-error-border)] !bg-[var(--login-error-bg)] !text-[var(--login-error-text)]"
          />
          <p className="text-center text-sm text-[var(--login-text-muted)]">
            <Link
              to="/login"
              className="font-medium text-[var(--login-accent-text)] transition-colors hover:underline"
            >
              {t('auth.oauthBackToLogin')}
            </Link>
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-sm font-medium text-[var(--login-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t('auth.oauthProcessing')}</span>
        </div>
      )}
    </div>
  );
};

export default OAuthCallbackPage;
