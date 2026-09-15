import { useEffect, useState } from 'react';
import { historyApi } from '../api/history';
import type { ReportTranslation } from '../types/analysis';
import { useUiLanguage } from '../contexts/UiLanguageContext';

type TranslationCache = {
  /** 请求键（语言 + 记录 ID）；与当前键不匹配的结果视为过期 */
  key: string;
  value: ReportTranslation | null;
};

const NO_TRANSLATION: TranslationCache = { key: '', value: null };

/**
 * 会话级共享缓存：同一（记录 + 语言）只请求一次。
 * 多个组件（报告概览 / 大盘复盘视图 / 完整报告抽屉）可安全共用。
 * 失败结果不缓存，下一次挂载会重试。
 */
const sharedTranslations = new Map<string, Promise<ReportTranslation | null>>();
const SHARED_TRANSLATIONS_LIMIT = 50;

const requestTranslation = (recordId: number, language: 'en'): Promise<ReportTranslation | null> => {
  const key = `${language}:${recordId}`;
  const cached = sharedTranslations.get(key);
  if (cached) {
    return cached;
  }

  const pending = Promise.resolve()
    .then(() => historyApi.getTranslation(recordId, language))
    .catch(() => {
      // 翻译不可用时静默回退原始报告内容，并允许后续重试
      sharedTranslations.delete(key);
      return null;
    });

  if (sharedTranslations.size >= SHARED_TRANSLATIONS_LIMIT) {
    sharedTranslations.clear();
  }
  sharedTranslations.set(key, pending);
  return pending;
};

/**
 * 英文界面下按需获取报告翻译（后端 LLM 翻译并持久化缓存）。
 *
 * - 仅英文界面会发起请求；中文界面完全不请求（行为不变）。
 * - 首屏先渲染原始内容，翻译返回后无缝替换；失败/加载中不阻塞、不展示错误提示。
 * - 记录或界面语言变化时，渲染期直接丢弃过期结果（不经过 effect setState）。
 */
export function useReportTranslation(recordId?: number | null): ReportTranslation | null {
  const { language } = useUiLanguage();
  const [cache, setCache] = useState<TranslationCache>(NO_TRANSLATION);

  // 只有英文界面 + 存在记录 ID 时才需要翻译
  const requestKey = language === 'en' && recordId ? `${language}:${recordId}` : null;
  const translation = cache.key === requestKey ? cache.value : null;

  useEffect(() => {
    if (!requestKey) {
      return undefined;
    }

    const recordIdText = requestKey.slice('en:'.length);
    const activeRecordId = Number(recordIdText);
    let active = true;

    requestTranslation(activeRecordId, 'en').then((payload) => {
      if (active) {
        setCache({ key: requestKey, value: payload });
      }
    });

    return () => {
      active = false;
    };
  }, [requestKey]);

  return translation;
}
