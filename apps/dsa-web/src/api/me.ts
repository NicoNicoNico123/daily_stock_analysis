import apiClient from './index';

/** 多用户模式下的个人设置（排程 / 通知渠道 / 今日配额）。 */

export const ME_SCHEDULE_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const ME_SCHEDULE_MAX_TIMES = 5;
/** 服务端掩码占位：回传该值表示保留已存密钥。 */
export const ME_CHANNEL_MASK = '******';

export type MeQuotaUsage = {
  used: number;
  limit: number;
};

export type MeQuotaResponse = {
  dailyAnalysis: MeQuotaUsage;
  dailyChat: MeQuotaUsage;
  watchlist: MeQuotaUsage;
};

export type MeScheduleSettings = {
  enabled: boolean;
  times: string[];
};

/** key 为服务端白名单配置键（snake_case），值为掩码占位或空字符串。 */
export type MeNotificationChannels = Record<string, string>;

export type MeSettingsResponse = {
  schedule: MeScheduleSettings;
  notificationChannels: MeNotificationChannels;
  quota: MeQuotaResponse;
};

export type MeSettingsUpdateRequest = {
  schedule?: MeScheduleSettings;
  notificationChannels?: MeNotificationChannels;
};

export type MeChannelTestResult = {
  success: boolean;
  statusCode?: number;
  error?: string;
};

export type MeIdentityRole = 'admin' | 'user';

export type MeIdentity = {
  multiUser: boolean;
  role?: MeIdentityRole;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeQuotaUsage(value: unknown): MeQuotaUsage {
  const record = asRecord(value);
  return {
    used: asNumber(record.used),
    limit: asNumber(record.limit),
  };
}

function normalizeSchedule(value: unknown): MeScheduleSettings {
  const record = asRecord(value);
  const rawTimes = Array.isArray(record.times) ? record.times : [];
  return {
    enabled: Boolean(record.enabled),
    times: rawTimes.map((time) => String(time ?? '').trim()).filter(Boolean),
  };
}

/**
 * 通知渠道映射按原样保留键名（snake_case 配置键），不能做 camelCase 深转换，
 * 否则回传时会改写键导致服务端白名单丢弃该渠道。
 */
function normalizeChannels(value: unknown): MeNotificationChannels {
  const record = asRecord(value);
  const channels: MeNotificationChannels = {};
  for (const [key, channelValue] of Object.entries(record)) {
    if (typeof channelValue !== 'string') {
      continue;
    }
    channels[key] = channelValue;
  }
  return channels;
}

function normalizeMeSettings(data: unknown): MeSettingsResponse {
  const record = asRecord(data);
  const quota = asRecord(record.quota);
  return {
    schedule: normalizeSchedule(record.schedule),
    notificationChannels: normalizeChannels(record.notificationChannels),
    quota: {
      dailyAnalysis: normalizeQuotaUsage(quota.dailyAnalysis ?? quota.daily_analysis),
      dailyChat: normalizeQuotaUsage(quota.dailyChat ?? quota.daily_chat),
      watchlist: normalizeQuotaUsage(quota.watchlist),
    },
  };
}

export function isMultiUserDisabledError(error: unknown): boolean {
  const response = (error as { response?: { data?: unknown } } | undefined)?.response;
  const data = asRecord(response?.data);
  return data.error === 'multi_user_disabled';
}

/**
 * 读取 FastAPI 错误响应中的机器可读错误码。
 * 兼容两种载荷：`{error: code}` 与 `{detail: {error: code}}`（HTTPException(detail={...})）。
 */
export function extractResponseErrorCode(data: unknown): string | null {
  const record = asRecord(data);
  if (typeof record.error === 'string' && record.error.trim()) {
    return record.error.trim();
  }
  const detail = asRecord(record.detail);
  return typeof detail.error === 'string' && detail.error.trim() ? detail.error.trim() : null;
}

export const meApi = {
  /** 获取当前用户排程、通知渠道（掩码）与今日配额。 */
  async getMySettings(): Promise<MeSettingsResponse> {
    const { data } = await apiClient.get<unknown>('/api/v1/me');
    return normalizeMeSettings(data);
  },

  /**
   * 更新当前用户排程 / 通知渠道，返回保存后的最新状态。
   * 渠道值传 ME_CHANNEL_MASK 表示保留已存密钥，传空字符串表示删除该渠道。
   */
  async updateMySettings(request: MeSettingsUpdateRequest): Promise<MeSettingsResponse> {
    const { data } = await apiClient.put<unknown>('/api/v1/me', request);
    return normalizeMeSettings(data);
  },

  /** 对用户提供的公网 https webhook 地址发送探测请求（不落盘）。 */
  async testNotificationChannel(url: string): Promise<MeChannelTestResult> {
    const { data } = await apiClient.post<unknown>('/api/v1/me/notification-channels/test', {
      payload: { url },
    });
    const record = asRecord(data);
    return {
      success: Boolean(record.success),
      statusCode: typeof record.status_code === 'number' ? record.status_code : undefined,
      error: typeof record.error === 'string' ? record.error : undefined,
    };
  },

  /** 读取 /api/v1/auth/status 中的多用户身份信息（multiUser / role）。 */
  async getIdentity(): Promise<MeIdentity> {
    const { data } = await apiClient.get<unknown>('/api/v1/auth/status');
    const record = asRecord(data);
    const role = record.role;
    return {
      multiUser: Boolean(record.multiUser),
      role: role === 'admin' || role === 'user' ? role : undefined,
    };
  },
};
