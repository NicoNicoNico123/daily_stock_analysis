import apiClient from './index';

export type AuthStatusResponse = {
  authEnabled: boolean;
  loggedIn: boolean;
  passwordSet?: boolean;
  passwordChangeable?: boolean;
  setupState: 'enabled' | 'password_retained' | 'no_password';
  /** Multi-user mode is active (absent on single-user deployments). */
  multiUser?: boolean;
  /** Self-service registration is open (multi-user mode only). */
  registrationEnabled?: boolean;
  /** Current session username (multi-user mode only). */
  username?: string;
  /** Current session role (multi-user mode only). */
  role?: 'admin' | 'user';
};

export type LoginRequest = {
  password: string;
  /** Required when the backend runs in multi-user mode. */
  username?: string;
  passwordConfirm?: string;
};

export type AuthSessionResponse = {
  ok?: boolean;
  username?: string;
  role?: 'admin' | 'user';
};

export const authApi = {
  async getStatus(): Promise<AuthStatusResponse> {
    const { data } = await apiClient.get<AuthStatusResponse>('/api/v1/auth/status');
    return data;
  },

  async updateSettings(
    authEnabled: boolean,
    password?: string,
    passwordConfirm?: string,
    currentPassword?: string
  ): Promise<AuthStatusResponse> {
    const body: {
      authEnabled: boolean;
      password?: string;
      passwordConfirm?: string;
      currentPassword?: string;
    } = { authEnabled };
    if (password !== undefined) {
      body.password = password;
    }
    if (passwordConfirm !== undefined) {
      body.passwordConfirm = passwordConfirm;
    }
    if (currentPassword !== undefined) {
      body.currentPassword = currentPassword;
    }
    const { data } = await apiClient.post<AuthStatusResponse>('/api/v1/auth/settings', body);
    return data;
  },

  async login(request: LoginRequest): Promise<void> {
    const body: LoginRequest = { password: request.password };
    if (request.username !== undefined) {
      body.username = request.username;
    }
    if (request.passwordConfirm !== undefined) {
      body.passwordConfirm = request.passwordConfirm;
    }
    await apiClient.post('/api/v1/auth/login', body);
  },

  /** Multi-user self-service registration; the backend establishes the session on success. */
  async register(username: string, password: string): Promise<AuthSessionResponse> {
    const { data } = await apiClient.post<AuthSessionResponse>('/api/v1/auth/register', {
      username,
      password,
    });
    return data;
  },

  async changePassword(
    currentPassword: string,
    newPassword: string,
    newPasswordConfirm: string
  ): Promise<void> {
    await apiClient.post('/api/v1/auth/change-password', {
      currentPassword,
      newPassword,
      newPasswordConfirm,
    });
  },

  async logout(): Promise<void> {
    await apiClient.post('/api/v1/auth/logout');
  },
};
