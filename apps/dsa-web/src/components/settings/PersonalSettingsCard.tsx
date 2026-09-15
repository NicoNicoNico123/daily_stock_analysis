import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clock, Plus, Trash2 } from 'lucide-react';
import {
  ME_SCHEDULE_MAX_TIMES,
  ME_SCHEDULE_TIME_PATTERN,
  isMultiUserDisabledError,
  meApi,
  type MeNotificationChannels,
  type MeQuotaUsage,
  type MeSettingsResponse,
} from '../../api/me';
import { getParsedApiError, type ParsedApiError } from '../../api/error';
import { useUiLanguage } from '../../contexts/UiLanguageContext';
import type { UiTextKey } from '../../i18n/uiText';
import { Button, Checkbox, Input } from '../common';
import { SettingsAlert } from './SettingsAlert';
import { SettingsSectionCard } from './SettingsSectionCard';

/** 用户可自助配置的通知渠道（与服务端 USER_CHANNEL_KEYS 白名单保持一致）。 */
const ME_CHANNEL_GROUPS: Array<{ id: string; label: string; keys: string[] }> = [
  { id: 'telegram', label: 'Telegram', keys: ['telegram_bot_token', 'telegram_chat_id'] },
  { id: 'email', label: 'Email', keys: ['email_sender', 'email_password', 'email_receivers'] },
  { id: 'wechat', label: 'WeChat Work', keys: ['wechat_webhook_url'] },
  { id: 'dingtalk', label: 'DingTalk', keys: ['dingtalk_webhook_url', 'dingtalk_secret'] },
  { id: 'feishu', label: 'Feishu', keys: ['feishu_webhook_url', 'feishu_webhook_secret', 'feishu_webhook_keyword'] },
  { id: 'discord', label: 'Discord', keys: ['discord_webhook_url'] },
  { id: 'slack', label: 'Slack', keys: ['slack_webhook_url'] },
  { id: 'custom', label: 'Custom Webhook', keys: ['custom_webhook_urls'] },
  { id: 'ntfy', label: 'Ntfy', keys: ['ntfy_url'] },
  { id: 'gotify', label: 'Gotify', keys: ['gotify_url', 'gotify_token'] },
  { id: 'pushover', label: 'Pushover', keys: ['pushover_user_key', 'pushover_api_token'] },
  { id: 'pushplus', label: 'PushPlus', keys: ['pushplus_token'] },
  { id: 'serverchan', label: 'ServerChan', keys: ['serverchan3_sendkey'] },
];

const ME_CHANNEL_FIELD_LABELS: Record<string, string> = {
  telegram_bot_token: 'Bot Token',
  telegram_chat_id: 'Chat ID',
  email_sender: 'Sender',
  email_password: 'Password / Auth Code',
  email_receivers: 'Receivers',
  wechat_webhook_url: 'Webhook URL',
  dingtalk_webhook_url: 'Webhook URL',
  dingtalk_secret: 'Secret',
  feishu_webhook_url: 'Webhook URL',
  feishu_webhook_secret: 'Sign Secret',
  feishu_webhook_keyword: 'Keyword',
  discord_webhook_url: 'Webhook URL',
  slack_webhook_url: 'Webhook URL',
  custom_webhook_urls: 'URLs',
  ntfy_url: 'Server URL',
  gotify_url: 'Server URL',
  gotify_token: 'App Token',
  pushover_user_key: 'User Key',
  pushover_api_token: 'API Token',
  pushplus_token: 'Token',
  serverchan3_sendkey: 'SendKey',
};

const SCHEDULE_DEFAULT_TIME = '18:00';
const SAVED_STATE_VISIBLE_MS = 4000;
/** 全部白名单渠道键（用于脏检查，保证只回传有改动的键）。 */
const ME_CHANNEL_KEYS = ME_CHANNEL_GROUPS.flatMap((group) => group.keys);

function normalizeScheduleTimes(times: string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of times) {
    const value = raw.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function quotaLabelKey(kind: 'analysis' | 'chat' | 'watchlist'): UiTextKey {
  if (kind === 'analysis') return 'personalSettings.quotaAnalysis';
  if (kind === 'chat') return 'personalSettings.quotaChat';
  return 'personalSettings.quotaWatchlist';
}

function formatQuotaValue(usage: MeQuotaUsage | undefined, unlimitedText: string) {
  if (!usage) {
    return '-';
  }
  if (usage.limit <= 0) {
    return unlimitedText;
  }
  return `${usage.used}/${usage.limit}`;
}

type ChannelTestState = {
  kind: 'success' | 'error';
  detail: string;
} | null;

export const PersonalSettingsCard: React.FC = () => {
  const { language, t } = useUiLanguage();
  const [settings, setSettings] = useState<MeSettingsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<ParsedApiError | null>(null);
  const [isMultiUserDisabled, setIsMultiUserDisabled] = useState(false);

  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleTimes, setScheduleTimes] = useState<string[]>([SCHEDULE_DEFAULT_TIME]);
  const [channelDraft, setChannelDraft] = useState<MeNotificationChannels>({});

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<ParsedApiError | string | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const savedTimerRef = useRef<number | null>(null);

  const [testUrl, setTestUrl] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [testState, setTestState] = useState<ChannelTestState>(null);

  useEffect(() => () => {
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
    }
  }, []);

  const applyServerState = useCallback((payload: MeSettingsResponse) => {
    setSettings(payload);
    setScheduleEnabled(payload.schedule.enabled);
    setScheduleTimes(
      payload.schedule.times.length
        ? payload.schedule.times
        : [],
    );
    setChannelDraft({ ...payload.notificationChannels });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setLoadError(null);
      setIsMultiUserDisabled(false);
      try {
        const payload = await meApi.getMySettings();
        if (cancelled) {
          return;
        }
        applyServerState(payload);
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        if (isMultiUserDisabledError(error)) {
          setIsMultiUserDisabled(true);
        } else {
          setLoadError(getParsedApiError(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [applyServerState]);

  const serverSchedule = settings?.schedule;
  const serverChannels = useMemo(
    () => settings?.notificationChannels ?? {},
    [settings],
  );

  const normalizedTimes = useMemo(() => normalizeScheduleTimes(scheduleTimes), [scheduleTimes]);
  const scheduleDirty = Boolean(
    serverSchedule
    && (serverSchedule.enabled !== scheduleEnabled
      || normalizeScheduleTimes(serverSchedule.times).join(',') !== normalizedTimes.join(',')),
  );
  const changedChannelKeys = useMemo(
    () => ME_CHANNEL_KEYS
      .filter((key) => (channelDraft[key] ?? '') !== (serverChannels[key] ?? '')),
    [channelDraft, serverChannels],
  );
  const isDirty = scheduleDirty || changedChannelKeys.length > 0;
  const canAddTime = normalizedTimes.length < ME_SCHEDULE_MAX_TIMES;

  const updateScheduleTime = (index: number, value: string) => {
    setScheduleTimes((current) => current.map((time, currentIndex) => (
      currentIndex === index ? value : time
    )));
  };

  const addScheduleTime = () => {
    setScheduleTimes((current) => {
      const normalized = normalizeScheduleTimes(current);
      if (normalized.length >= ME_SCHEDULE_MAX_TIMES) {
        return current;
      }
      return [...normalized, SCHEDULE_DEFAULT_TIME];
    });
  };

  const removeScheduleTime = (index: number) => {
    setScheduleTimes((current) => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const handleSave = async () => {
    setSaveError(null);
    setIsSaved(false);

    if (scheduleEnabled && normalizedTimes.length === 0) {
      setSaveError(language === 'en'
        ? 'Add at least one run time (HH:MM) before enabling the schedule.'
        : '啓用排程前請至少填寫一個執行時間（HH:MM）。');
      return;
    }

    setIsSaving(true);
    try {
      // 仅在渠道确实有改动时携带 notificationChannels：服务端按整对象覆盖存储，
      // 传空对象会清空全部已配置渠道。
      const payload = changedChannelKeys.length
        ? {
          schedule: { enabled: scheduleEnabled, times: normalizedTimes },
          notificationChannels: Object.fromEntries(
            changedChannelKeys.map((key) => [key, (channelDraft[key] ?? '').trim()]),
          ),
        }
        : { schedule: { enabled: scheduleEnabled, times: normalizedTimes } };
      const next = await meApi.updateMySettings(payload);
      applyServerState(next);
      setIsSaved(true);
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = window.setTimeout(() => setIsSaved(false), SAVED_STATE_VISIBLE_MS);
    } catch (error: unknown) {
      setSaveError(getParsedApiError(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestChannel = async () => {
    const url = testUrl.trim();
    setTestState(null);
    if (!url) {
      return;
    }

    setIsTesting(true);
    try {
      const result = await meApi.testNotificationChannel(url);
      if (result.success) {
        setTestState({
          kind: 'success',
          detail: result.statusCode ? `HTTP ${result.statusCode}` : '',
        });
      } else {
        setTestState({
          kind: 'error',
          detail: result.error ?? '',
        });
      }
    } catch (error: unknown) {
      const parsed = getParsedApiError(error);
      setTestState({
        kind: 'error',
        detail: parsed.status === 429 ? t('errors.rateLimited') : parsed.message,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const quotaItems: Array<{ kind: 'analysis' | 'chat' | 'watchlist'; usage?: MeQuotaUsage }> = [
    { kind: 'analysis', usage: settings?.quota.dailyAnalysis },
    { kind: 'chat', usage: settings?.quota.dailyChat },
    { kind: 'watchlist', usage: settings?.quota.watchlist },
  ];

  return (
    <SettingsSectionCard
      title={t('personalSettings.title')}
      description={t('personalSettings.channelsDescription')}
    >
      {isMultiUserDisabled ? (
        <SettingsAlert
          title={t('personalSettings.title')}
          message={t('personalSettings.multiUserDisabled')}
          variant="warning"
        />
      ) : null}
      {!isMultiUserDisabled && loadError ? (
        <SettingsAlert title={loadError.title} message={loadError.message} variant="error" />
      ) : null}
      {isLoading && !settings ? (
        <p className="text-sm text-muted-text">{t('common.loading')}</p>
      ) : null}

      {settings && !isMultiUserDisabled ? (
        <div data-testid="personal-settings-card" className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {quotaItems.map((item) => (
              <div
                key={item.kind}
                className="rounded-2xl border settings-border bg-background/40 px-4 py-3"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-text">
                  {t(quotaLabelKey(item.kind))}
                </p>
                <p className="mt-2 text-sm font-semibold text-foreground">
                  {formatQuotaValue(item.usage, t('personalSettings.quotaUnlimited'))}
                </p>
              </div>
            ))}
          </div>

          <div className="space-y-4 rounded-2xl border settings-border bg-background/35 px-4 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">{t('personalSettings.scheduleTitle')}</p>
                <p className="text-xs leading-6 text-muted-text">{t('personalSettings.scheduleEnabled')}</p>
              </div>
              <Checkbox
                data-testid="personal-schedule-enabled-checkbox"
                checked={scheduleEnabled}
                disabled={isSaving}
                onChange={(event) => {
                  const nextEnabled = event.target.checked;
                  setScheduleEnabled(nextEnabled);
                  // 开启排程但还没有任何时间时，给一个默认时间，避免直接落到服务端校验报错。
                  if (nextEnabled && normalizeScheduleTimes(scheduleTimes).length === 0) {
                    setScheduleTimes([SCHEDULE_DEFAULT_TIME]);
                  }
                }}
                label={scheduleEnabled ? t('common.enabled') : t('common.disabled')}
                containerClassName="shrink-0 rounded-full border settings-border bg-background/60 px-4 py-2"
              />
            </div>

            {scheduleEnabled ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Clock className="h-4 w-4" aria-hidden="true" />
                  {t('personalSettings.scheduleTimes')}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {scheduleTimes.map((time, index) => (
                    <div
                      key={index}
                      className="inline-flex h-11 shrink-0 items-center gap-1 rounded-xl border settings-border bg-card/90 p-1"
                    >
                      <input
                        data-testid={`personal-schedule-time-input-${index}`}
                        type="time"
                        value={ME_SCHEDULE_TIME_PATTERN.test(time) ? time : ''}
                        aria-label={`${t('personalSettings.scheduleTimes')} ${index + 1}`}
                        className="h-9 w-[8.75rem] rounded-lg border-none bg-transparent px-2 text-sm font-medium text-foreground outline-none transition focus:bg-background/60 focus:ring-2 focus:ring-cyan/20"
                        disabled={isSaving}
                        onChange={(event) => updateScheduleTime(index, event.target.value)}
                      />
                      <Button
                        type="button"
                        variant="settings-secondary"
                        size="sm"
                        className="h-8 w-8 rounded-lg px-0"
                        aria-label={t('common.delete')}
                        title={t('common.delete')}
                        disabled={isSaving || scheduleTimes.length <= 1}
                        onClick={() => removeScheduleTime(index)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="settings-secondary"
                    size="sm"
                    className="h-11 shrink-0"
                    data-testid="personal-schedule-add-time-button"
                    disabled={isSaving || !canAddTime}
                    onClick={addScheduleTime}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t('personalSettings.scheduleAddTime')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-3 rounded-2xl border settings-border bg-background/35 px-4 py-4">
            <p className="text-sm font-semibold text-foreground">{t('personalSettings.channelsTitle')}</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {ME_CHANNEL_GROUPS.map((group) => (
                <div
                  key={group.id}
                  className="space-y-3 rounded-xl border settings-border bg-card/60 px-3 py-3"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-text">{group.label}</p>
                  <div className="space-y-3">
                    {group.keys.map((key) => (
                      <Input
                        key={key}
                        name={key}
                        type="password"
                        allowTogglePassword
                        iconType="password"
                        label={ME_CHANNEL_FIELD_LABELS[key] ?? key}
                        placeholder={key}
                        value={channelDraft[key] ?? ''}
                        autoComplete="off"
                        disabled={isSaving || isLoading}
                        onChange={(event) => {
                          const value = event.target.value;
                          setChannelDraft((current) => ({ ...current, [key]: value }));
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-2xl border settings-border bg-background/35 px-4 py-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
              <Input
                name="me-channel-test-url"
                type="url"
                label={t('personalSettings.testUrl')}
                placeholder="https://example.com/webhook"
                value={testUrl}
                autoComplete="off"
                disabled={isTesting}
                onChange={(event) => setTestUrl(event.target.value)}
              />
              <Button
                type="button"
                variant="settings-secondary"
                data-testid="personal-channel-test-button"
                disabled={!testUrl.trim() || isTesting}
                isLoading={isTesting}
                loadingText={t('common.loading')}
                onClick={() => void handleTestChannel()}
              >
                {t('personalSettings.testChannel')}
              </Button>
            </div>
            {testState ? (
              testState.kind === 'success' ? (
                <SettingsAlert
                  title={t('personalSettings.testSuccess')}
                  message={testState.detail}
                  variant="success"
                />
              ) : (
                <SettingsAlert
                  title={t('personalSettings.testFailed')}
                  message={testState.detail}
                  variant="error"
                />
              )
            ) : null}
          </div>

          {saveError ? (
            typeof saveError === 'string'
              ? <SettingsAlert title={t('personalSettings.save')} message={saveError} variant="error" />
              : <SettingsAlert title={saveError.title} message={saveError.message} variant="error" />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="settings-primary"
              data-testid="personal-settings-save-button"
              disabled={!isDirty || isSaving}
              isLoading={isSaving}
              loadingText={t('personalSettings.saving')}
              onClick={() => void handleSave()}
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {isSaving ? t('personalSettings.saving') : t('personalSettings.save')}
            </Button>
            {!saveError && isSaved ? (
              <span className="inline-flex items-center gap-1 text-sm font-medium text-success">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                {t('personalSettings.saved')}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </SettingsSectionCard>
  );
};
