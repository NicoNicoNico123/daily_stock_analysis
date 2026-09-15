import apiClient from './index';
import { isAxiosApiError } from './error';
import { toCamelCase } from './utils';

export type UserRole = 'admin' | 'user';

export interface AdminUser {
  id: number;
  username: string;
  role: UserRole;
  isActive: boolean;
  /** ISO 时间字符串；账号缺少创建时间时为 null。 */
  createdAt: string | null;
}

export interface AdminUserListResponse {
  users: AdminUser[];
}

export interface AdminCreateUserPayload {
  username: string;
  password: string;
  role: UserRole;
}

export interface AdminUpdateUserPayload {
  role?: UserRole;
  isActive?: boolean;
}

/** GET /api/v1/auth/status 的多用户扩展字段（旧后端可能不返回这些字段）。 */
export interface AuthIdentityStatus {
  authEnabled: boolean;
  loggedIn: boolean;
  multiUser?: boolean;
  username?: string;
  role?: UserRole;
}

/**
 * 提取后端返回的业务错误码（如 last_admin / quota_exceeded / username_taken），
 * 供页面按错误码映射文案。
 */
export function getAdminErrorCode(error: unknown): string | null {
  if (!isAxiosApiError(error)) {
    return null;
  }
  const data = (error as { response?: { data?: unknown } }).response?.data;
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  return null;
}

function toUpdatePayload(payload: AdminUpdateUserPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (payload.role !== undefined) body.role = payload.role;
  if (payload.isActive !== undefined) body.isActive = payload.isActive;
  return body;
}

export const adminUsersApi = {
  async listUsers(): Promise<AdminUserListResponse> {
    const response = await apiClient.get<Record<string, unknown>>('/api/v1/admin/users');
    return toCamelCase<AdminUserListResponse>(response.data);
  },

  async createUser(payload: AdminCreateUserPayload): Promise<AdminUser> {
    const response = await apiClient.post<Record<string, unknown>>('/api/v1/admin/users', payload);
    const data = toCamelCase<{ user: AdminUser | null }>(response.data);
    if (!data.user) {
      throw new Error('create user returned no user payload');
    }
    return data.user;
  },

  /** 返回更新后的用户；目标账号已被删除时后端可能返回 null。 */
  async updateUser(userId: number, payload: AdminUpdateUserPayload): Promise<AdminUser | null> {
    const response = await apiClient.patch<Record<string, unknown>>(
      `/api/v1/admin/users/${userId}`,
      toUpdatePayload(payload),
    );
    const data = toCamelCase<{ user: AdminUser | null }>(response.data);
    return data.user;
  },

  async resetUserPassword(userId: number, newPassword: string): Promise<void> {
    await apiClient.post(`/api/v1/admin/users/${userId}/reset-password`, { newPassword });
  },
};

/**
 * 读取当前登录身份（username / role / multiUser）。
 * 会话状态本身仍以 AuthContext 为准；这里只补充多用户身份字段，
 * 因此放在本模块而不是复用 authApi 的窄类型。
 */
export async function fetchAuthIdentity(): Promise<AuthIdentityStatus> {
  const response = await apiClient.get<Record<string, unknown>>('/api/v1/auth/status');
  return toCamelCase<AuthIdentityStatus>(response.data);
}
