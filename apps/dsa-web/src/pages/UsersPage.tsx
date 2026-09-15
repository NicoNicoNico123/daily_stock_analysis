import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldOff, Users } from 'lucide-react';
import {
  adminUsersApi,
  fetchAuthIdentity,
  getAdminErrorCode,
} from '../api/adminUsers';
import type { AdminUser, AuthIdentityStatus, UserRole } from '../api/adminUsers';
import {
  createParsedApiError,
  getParsedApiError,
  toApiErrorMessage,
  type ParsedApiError,
} from '../api/error';
import {
  ApiErrorAlert,
  AppPage,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  Loading,
  PageHeader,
  Select,
} from '../components/common';
import { useUiLanguage } from '../contexts/UiLanguageContext';
import { formatDate } from '../utils/format';

/** 按后端业务错误码映射成本地文案；未命中时回退到通用 API 错误解析。 */
function translateUserError(error: unknown, codeMessages: Record<string, string>): ParsedApiError {
  const parsed = getParsedApiError(error);
  const code = getAdminErrorCode(error);
  const mapped = code ? codeMessages[code] : undefined;
  if (!mapped) {
    return parsed;
  }
  return createParsedApiError({
    title: parsed.title,
    message: mapped,
    rawMessage: parsed.rawMessage,
    status: parsed.status,
    category: parsed.category,
  });
}

function isSelfUser(user: AdminUser, selfUsername: string | null): boolean {
  return selfUsername !== null && user.username === selfUsername;
}

type CreateUserCardProps = {
  onCreated: (user: AdminUser) => void | Promise<void>;
};

const CreateUserCard: React.FC<CreateUserCardProps> = ({ onCreated }) => {
  const { t } = useUiLanguage();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState<ParsedApiError | null>(null);

  const resetForm = () => {
    setUsername('');
    setPassword('');
    setRole('user');
    setCreateError(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedUsername = username.trim();
    if (isSubmitting || !normalizedUsername || !password) {
      return;
    }
    setIsSubmitting(true);
    setCreateError(null);
    try {
      const created = await adminUsersApi.createUser({
        username: normalizedUsername,
        password,
        role,
      });
      resetForm();
      await onCreated(created);
    } catch (error) {
      setCreateError(translateUserError(error, {
        username_taken: t('users.usernameTaken'),
        quota_exceeded: t('users.quotaExceeded'),
        invalid_username: t('register.usernameInvalid'),
        invalid_password: t('register.passwordInvalid'),
      }));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card title={t('users.createUser')}>
      <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            name="new-username"
            label={t('users.newUsername')}
            value={username}
            autoComplete="off"
            disabled={isSubmitting}
            onChange={(event) => setUsername(event.target.value)}
          />
          <Input
            name="new-password"
            type="password"
            label={t('users.newPassword')}
            value={password}
            autoComplete="new-password"
            allowTogglePassword
            disabled={isSubmitting}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <Select
          label={t('users.columnRole')}
          value={role}
          disabled={isSubmitting}
          onChange={(value) => setRole(value === 'admin' ? 'admin' : 'user')}
          options={[
            { value: 'user', label: t('layout.userMenu.user') },
            { value: 'admin', label: t('layout.userMenu.admin') },
          ]}
        />
        {createError ? (
          <ApiErrorAlert error={createError} onDismiss={() => setCreateError(null)} />
        ) : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={resetForm}
            disabled={isSubmitting}
          >
            {t('users.createCancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            isLoading={isSubmitting}
            disabled={!username.trim() || !password}
          >
            {t('users.createSubmit')}
          </Button>
        </div>
      </form>
    </Card>
  );
};

type ResetPasswordDialogProps = {
  user: AdminUser | null;
  onClose: () => void;
  onSuccess: (user: AdminUser) => void;
};

const ResetPasswordDialog: React.FC<ResetPasswordDialogProps> = ({ user, onClose, onSuccess }) => {
  const { t } = useUiLanguage();
  const [newPassword, setNewPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      setNewPassword('');
      setErrorMessage(null);
      setIsSubmitting(false);
    }
  }, [user]);

  if (!user) {
    return null;
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting || !newPassword) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await adminUsersApi.resetUserPassword(user.id, newPassword);
      onSuccess(user);
      onClose();
    } catch (error) {
      setErrorMessage(toApiErrorMessage(
        translateUserError(error, {
          invalid_password: t('register.passwordInvalid'),
        }),
      ));
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm transition-all"
      onClick={onClose}
    >
      <form
        className="mx-4 w-full max-w-sm rounded-xl border border-border/70 bg-elevated p-6 shadow-2xl animate-in fade-in zoom-in duration-200"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void handleSubmit(event)}
      >
        <h3 className="mb-2 text-lg font-medium text-foreground">{t('users.resetPasswordTitle')}</h3>
        <p className="mb-5 text-sm leading-relaxed text-secondary-text">{user.username}</p>
        <Input
          name="reset-password"
          type="password"
          label={t('users.resetPasswordNew')}
          value={newPassword}
          autoComplete="new-password"
          allowTogglePassword
          disabled={isSubmitting}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        {errorMessage ? (
          <p role="alert" className="mt-2 text-xs text-danger">{errorMessage}</p>
        ) : null}
        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" isLoading={isSubmitting} disabled={!newPassword}>
            {t('users.resetPasswordSubmit')}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
};

const UsersPage: React.FC = () => {
  const { t } = useUiLanguage();
  const [identity, setIdentity] = useState<AuthIdentityStatus | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [usersError, setUsersError] = useState<ParsedApiError | null>(null);
  const [actionError, setActionError] = useState<ParsedApiError | null>(null);
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);

  useEffect(() => {
    document.title = t('users.pageTitle');
  }, [t]);

  useEffect(() => {
    let active = true;
    fetchAuthIdentity()
      .then((status) => {
        if (active) {
          setIdentity(status);
          setIdentityLoaded(true);
        }
      })
      .catch(() => {
        if (active) {
          setIdentityLoaded(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const canManageUsers = Boolean(identity?.multiUser && identity?.role === 'admin');
  const selfUsername = identity?.username ?? null;

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const response = await adminUsersApi.listUsers();
      setUsers(response.users);
      setUsersError(null);
      setUsersLoaded(true);
    } catch (error) {
      setUsersError(getParsedApiError(error));
    } finally {
      setUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canManageUsers) {
      return;
    }
    void loadUsers();
  }, [canManageUsers, loadUsers]);

  // 只有一个可用管理员时，前端先拦一层，后端仍以 last_admin 兜底。
  const lastActiveAdminId = useMemo(() => {
    const activeAdmins = users.filter((user) => user.role === 'admin' && user.isActive);
    return activeAdmins.length === 1 ? activeAdmins[0].id : null;
  }, [users]);

  const isLastActiveAdmin = useCallback(
    (user: AdminUser) => lastActiveAdminId !== null && user.id === lastActiveAdminId,
    [lastActiveAdminId],
  );

  const handleToggleActive = async (user: AdminUser) => {
    setBusyUserId(user.id);
    setActionError(null);
    try {
      await adminUsersApi.updateUser(user.id, { isActive: !user.isActive });
      await loadUsers();
    } catch (error) {
      setActionError(translateUserError(error, {
        last_admin: t('users.lastAdminWarning'),
        user_not_found: t('users.empty'),
      }));
    } finally {
      setBusyUserId(null);
      setDisableTarget(null);
    }
  };

  const handleUpdateRole = async (user: AdminUser) => {
    const nextRole: UserRole = user.role === 'admin' ? 'user' : 'admin';
    setBusyUserId(user.id);
    setActionError(null);
    try {
      await adminUsersApi.updateUser(user.id, { role: nextRole });
      await loadUsers();
    } catch (error) {
      setActionError(translateUserError(error, {
        last_admin: t('users.lastAdminWarning'),
        user_not_found: t('users.empty'),
      }));
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <AppPage className="space-y-5">
      <PageHeader
        eyebrow="Admin"
        title={t('users.title')}
        description={t('users.description')}
      />

      {!identityLoaded ? (
        <Card>
          <Loading label={t('common.loading')} />
        </Card>
      ) : null}

      {identityLoaded && !canManageUsers ? (
        <EmptyState
          icon={<ShieldOff className="h-6 w-6" />}
          title={t('users.title')}
          description={identity?.multiUser ? t('users.description') : t('personalSettings.multiUserDisabled')}
        />
      ) : null}

      {canManageUsers ? (
        <>
          {usersError ? <ApiErrorAlert error={usersError} onDismiss={() => setUsersError(null)} /> : null}
          {actionError ? <ApiErrorAlert error={actionError} onDismiss={() => setActionError(null)} /> : null}

          <CreateUserCard onCreated={() => loadUsers()} />

          <Card>
            {usersLoading && !usersLoaded ? <Loading label={t('common.loading')} /> : null}
            {!usersLoading && usersLoaded && users.length === 0 ? (
              <EmptyState
                icon={<Users className="h-6 w-6" />}
                title={t('users.empty')}
              />
            ) : null}
            {usersLoaded && users.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-b border-border/60 text-xs uppercase text-muted-text">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('users.columnUsername')}</th>
                      <th className="px-3 py-2 font-medium">{t('users.columnRole')}</th>
                      <th className="px-3 py-2 font-medium">{t('users.columnStatus')}</th>
                      <th className="px-3 py-2 font-medium">{t('users.columnCreated')}</th>
                      <th className="px-3 py-2 text-right font-medium">
                        <span className="sr-only">{t('users.title')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {users.map((user) => {
                      const isBusy = busyUserId === user.id;
                      const lastAdmin = isLastActiveAdmin(user);
                      const isSelf = isSelfUser(user, selfUsername);
                      return (
                        <tr key={user.id}>
                          <td className="px-3 py-3 font-medium text-foreground">
                            <span className="inline-flex flex-wrap items-center gap-2">
                              {user.username}
                              {isSelf ? (
                                <span className="text-xs font-normal text-muted-text">{t('users.you')}</span>
                              ) : null}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <Badge variant={user.role === 'admin' ? 'info' : 'default'}>
                              {user.role === 'admin' ? t('layout.userMenu.admin') : t('layout.userMenu.user')}
                            </Badge>
                          </td>
                          <td className="px-3 py-3">
                            <Badge variant={user.isActive ? 'success' : 'warning'}>
                              {user.isActive ? t('users.statusActive') : t('users.statusDisabled')}
                            </Badge>
                          </td>
                          <td className="px-3 py-3 text-secondary-text">
                            {user.createdAt ? formatDate(user.createdAt) : '—'}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex flex-wrap items-center justify-end gap-1.5">
                              <Button
                                type="button"
                                variant="ghost"
                                size="xsm"
                                disabled={isBusy || (user.isActive && lastAdmin)}
                                onClick={() => {
                                  setActionError(null);
                                  if (user.isActive) {
                                    setDisableTarget(user);
                                    return;
                                  }
                                  void handleToggleActive(user);
                                }}
                              >
                                {user.isActive ? t('users.actionDisable') : t('users.actionEnable')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xsm"
                                disabled={isBusy || isSelf || (user.role === 'admin' && lastAdmin)}
                                onClick={() => void handleUpdateRole(user)}
                              >
                                {user.role === 'admin' ? t('users.actionMakeUser') : t('users.actionMakeAdmin')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xsm"
                                disabled={isBusy}
                                onClick={() => {
                                  setActionError(null);
                                  setResetTarget(user);
                                }}
                              >
                                {t('users.actionResetPassword')}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </Card>
        </>
      ) : null}

      <ConfirmDialog
        isOpen={disableTarget !== null}
        title={t('users.actionDisable')}
        message={disableTarget ? `${disableTarget.username}：${t('users.disableConfirm')}` : ''}
        confirmText={t('users.actionDisable')}
        cancelText={t('common.cancel')}
        isDanger
        confirmDisabled={busyUserId !== null}
        onConfirm={() => {
          if (disableTarget) {
            void handleToggleActive(disableTarget);
          }
        }}
        onCancel={() => setDisableTarget(null)}
      />

      <ResetPasswordDialog
        user={resetTarget}
        onClose={() => setResetTarget(null)}
        onSuccess={() => setActionError(null)}
      />
    </AppPage>
  );
};

export default UsersPage;
