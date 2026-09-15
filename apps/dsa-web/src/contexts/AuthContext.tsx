import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { createParsedApiError, getParsedApiError, type ParsedApiError } from '../api/error';
import { authApi } from '../api/auth';
import { useStockPoolStore } from '../stores';
import { clearSessionScopedState } from '../utils/sessionCleanup';
import { useUiLanguage } from './UiLanguageContext';
import type { UiTextKey } from '../i18n/uiText';

type AuthRole = 'admin' | 'user';

type AuthContextValue = {
  authEnabled: boolean;
  loggedIn: boolean;
  passwordSet: boolean;
  passwordChangeable: boolean;
  setupState: 'enabled' | 'password_retained' | 'no_password';
  /** Multi-user mode is active; undefined/false means legacy single-user mode. */
  multiUser: boolean;
  /** Self-service registration is open (only meaningful when multiUser). */
  registrationEnabled: boolean;
  /** Current session username (multi-user mode only, otherwise null). */
  username: string | null;
  /** Current session role (multi-user mode only, otherwise null). */
  role: AuthRole | null;
  isLoading: boolean;
  loadError: ParsedApiError | null;
  login: (
    password: string,
    passwordConfirm?: string,
    username?: string
  ) => Promise<{ success: boolean; error?: ParsedApiError }>;
  register: (username: string, password: string) => Promise<{ success: boolean; error?: ParsedApiError }>;
  changePassword: (
    currentPassword: string,
    newPassword: string,
    newPasswordConfirm: string
  ) => Promise<{ success: boolean; error?: ParsedApiError }>;
  logout: () => Promise<void>;
  refreshStatus: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function extractLoginError(err: unknown, translate: (key: UiTextKey) => string): ParsedApiError {
  const parsed = getParsedApiError(err);
  if (parsed.status === 429) {
    return createParsedApiError({
      title: translate('errors.rateLimitedTitle'),
      message: translate('errors.rateLimited'),
      rawMessage: parsed.rawMessage,
      status: parsed.status,
      category: parsed.category,
    });
  }
  return parsed;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { t } = useUiLanguage();
  const [authEnabled, setAuthEnabled] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [passwordSet, setPasswordSet] = useState(false);
  const [passwordChangeable, setPasswordChangeable] = useState(false);
  const [setupState, setSetupState] = useState<'enabled' | 'password_retained' | 'no_password'>('no_password');
  const [multiUser, setMultiUser] = useState(false);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [role, setRole] = useState<AuthRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<ParsedApiError | null>(null);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const status = await authApi.getStatus();
      setAuthEnabled(status.authEnabled);
      setLoggedIn(status.loggedIn);
      setPasswordSet(status.passwordSet ?? false);
      setPasswordChangeable(status.passwordChangeable ?? false);
      setSetupState(status.setupState);
      setMultiUser(status.multiUser ?? false);
      setRegistrationEnabled(status.registrationEnabled ?? false);
      setUsername(status.username ?? null);
      setRole(status.role ?? null);
      if (status.authEnabled && !status.loggedIn) {
        useStockPoolStore.getState().resetDashboardState();
      }
    } catch (err) {
      setLoadError(getParsedApiError(err));
      setAuthEnabled(false);
      setLoggedIn(false);
      setPasswordSet(false);
      setPasswordChangeable(false);
      setSetupState('no_password');
      setMultiUser(false);
      setRegistrationEnabled(false);
      setUsername(null);
      setRole(null);
      useStockPoolStore.getState().resetDashboardState();
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const login = useCallback(
    async (
      password: string,
      passwordConfirm?: string,
      username?: string
    ): Promise<{ success: boolean; error?: ParsedApiError }> => {
      try {
        await authApi.login({
          password,
          // 用户名只在多用户模式下提交，单用户模式保持原请求体不变
          username: multiUser ? username : undefined,
          passwordConfirm,
        });
        await fetchStatus();
        return { success: true };
      } catch (err: unknown) {
        return { success: false, error: extractLoginError(err, t) }
      }
    },
    [fetchStatus, multiUser, t]
  );

  const register = useCallback(
    async (username: string, password: string): Promise<{ success: boolean; error?: ParsedApiError }> => {
      try {
        await authApi.register(username, password);
        // 注册成功即建立会话，重新拉取状态以同步 username / role / loggedIn
        await fetchStatus();
        return { success: true };
      } catch (err: unknown) {
        return { success: false, error: getParsedApiError(err) };
      }
    },
    [fetchStatus]
  );

  const changePassword = useCallback(
    async (
      currentPassword: string,
      newPassword: string,
      newPasswordConfirm: string
    ): Promise<{ success: boolean; error?: ParsedApiError }> => {
      try {
        await authApi.changePassword(currentPassword, newPassword, newPasswordConfirm);
        return { success: true };
      } catch (err: unknown) {
        return { success: false, error: getParsedApiError(err) };
      }
    },
    []
  );

  const logout = useCallback(async () => {
    let logoutError: unknown = null;
    try {
      await authApi.logout();
    } catch (err) {
      logoutError = err;
    } finally {
      // 无论登出请求是否成功，都清掉绑定当前会话的本地状态
      clearSessionScopedState();
      await fetchStatus();
    }

    if (logoutError && getParsedApiError(logoutError).status !== 401) {
      throw logoutError;
    }
  }, [fetchStatus]);

  return (
    <AuthContext.Provider
      value={{
        authEnabled,
        loggedIn,
        passwordSet,
        passwordChangeable,
        setupState,
        multiUser,
        registrationEnabled,
        username,
        role,
        isLoading,
        loadError,
        login,
        register,
        changePassword,
        logout,
        refreshStatus: fetchStatus,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- useAuth is a hook, co-located for context access
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
