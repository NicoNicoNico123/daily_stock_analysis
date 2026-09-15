import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { UiLanguageProvider, useUiLanguage } from '../../../contexts/UiLanguageContext';
import { getFieldDescriptionZh, getFieldTitleZh } from '../../../utils/systemConfigI18n';
import { UI_LANGUAGE_STORAGE_KEY } from '../../../utils/uiLanguage';
import { SettingsField } from '../SettingsField';

describe('SettingsField', () => {
  it('prefers localized Chinese field titles over backend schema titles', () => {
    render(
      <SettingsField
        item={{
          key: 'STOCK_LIST',
          value: '600519',
          rawValueExists: true,
          isMasked: false,
          schema: {
            key: 'STOCK_LIST',
            title: 'Stock List',
            category: 'base',
            dataType: 'string',
            uiControl: 'text',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [],
            validation: {},
            displayOrder: 1,
          },
        }}
        value="600519"
        onChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText('自選股列表')).toBeInTheDocument();
    expect(screen.queryByLabelText('Stock List')).not.toBeInTheDocument();
  });

  it('localizes TickFlow field descriptions instead of falling back to backend English schema', () => {
    render(
      <SettingsField
        item={{
          key: 'TICKFLOW_PRIORITY',
          value: '2',
          rawValueExists: false,
          isMasked: false,
          schema: {
            key: 'TICKFLOW_PRIORITY',
            title: 'TickFlow Priority',
            description: 'Priority for TickFlow daily K-line fetcher. Lower numbers are tried earlier.',
            category: 'data_source',
            dataType: 'integer',
            uiControl: 'number',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [],
            validation: { min: 0, max: 99 },
            displayOrder: 16,
            helpKey: 'settings.data_source.TICKFLOW_PRIORITY',
          },
        }}
        value="2"
        onChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText('TickFlow 日 K 優先級')).toBeInTheDocument();
    expect(screen.getByText('控制 TickFlow 在普通 A 股日 K 數據源回退鏈中的位置。')).toBeInTheDocument();
    expect(screen.queryByText(/Priority for TickFlow daily K-line fetcher/)).not.toBeInTheDocument();
  });
  it('uses schema key for TickFlow localization when the runtime item key differs', () => {
    render(
      <SettingsField
        item={{
          key: 'runtime.tickflow.priority',
          value: '2',
          rawValueExists: false,
          isMasked: false,
          schema: {
            key: 'TICKFLOW_PRIORITY',
            title: 'TickFlow Priority',
            description: 'Priority for TickFlow daily K-line fetcher. Lower numbers are tried earlier.',
            category: 'data_source',
            dataType: 'integer',
            uiControl: 'number',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [],
            validation: { min: 0, max: 99 },
            displayOrder: 16,
            helpKey: 'settings.data_source.TICKFLOW_PRIORITY',
          },
        }}
        value="2"
        onChange={vi.fn()}
      />
    );

    expect(screen.getByLabelText(getFieldTitleZh('TICKFLOW_PRIORITY', ''))).toBeInTheDocument();
    expect(screen.getByText(getFieldDescriptionZh('TICKFLOW_PRIORITY', ''))).toBeInTheDocument();
    expect(screen.queryByLabelText('TickFlow Priority')).not.toBeInTheDocument();
    expect(screen.queryByText(/Priority for TickFlow daily K-line fetcher/)).not.toBeInTheDocument();
  });
  it('renders sensitive field metadata and validation errors', () => {
    const onChange = vi.fn();

    render(
      <SettingsField
        item={{
          key: 'OPENAI_API_KEY',
          value: 'secret',
          rawValueExists: true,
          isMasked: false,
          schema: {
            key: 'OPENAI_API_KEY',
            category: 'ai_model',
            dataType: 'string',
            uiControl: 'password',
            isSensitive: true,
            isRequired: true,
            isEditable: true,
            options: [],
            validation: {},
            displayOrder: 1,
          },
        }}
        value="secret"
        onChange={onChange}
        issues={[
          {
            key: 'OPENAI_API_KEY',
            code: 'required',
            message: 'API Key 必填',
            severity: 'error',
          },
        ]}
      />
    );

    expect(screen.getByText('敏感')).toBeInTheDocument();
    expect(screen.getByText('API Key 必填')).toBeInTheDocument();

    const input = screen.getByLabelText('OpenAI API Key');
    fireEvent.focus(input);
    fireEvent.change(input, {
      target: { value: 'updated-secret' },
    });

    expect(onChange).toHaveBeenCalledWith('OPENAI_API_KEY', 'updated-secret');
  });

  it('renders multi-value sensitive fields with external delete actions', () => {
    const onChange = vi.fn();

    render(
      <SettingsField
        item={{
          key: 'OPENAI_API_KEYS',
          value: 'secret-a,secret-b',
          rawValueExists: true,
          isMasked: false,
          schema: {
            key: 'OPENAI_API_KEYS',
            category: 'ai_model',
            dataType: 'string',
            uiControl: 'password',
            isSensitive: true,
            isRequired: false,
            isEditable: true,
            options: [],
            validation: { multiValue: true },
            displayOrder: 1,
          },
        }}
        value="secret-a,secret-b"
        onChange={onChange}
      />
    );

    expect(screen.getAllByRole('button', { name: '顯示內容' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '刪除' })).toHaveLength(2);
  });

  it('allows optional select fields to be cleared when schema provides an empty option', () => {
    const onChange = vi.fn();

    render(
      <SettingsField
        item={{
          key: 'NOTIFICATION_MIN_SEVERITY',
          value: 'warning',
          rawValueExists: true,
          isMasked: false,
          schema: {
            key: 'NOTIFICATION_MIN_SEVERITY',
            title: 'Notification Minimum Severity',
            category: 'notification',
            dataType: 'string',
            uiControl: 'select',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [
              { label: 'Not set', value: '' },
              { label: 'info', value: 'info' },
              { label: 'warning', value: 'warning' },
              { label: 'error', value: 'error' },
              { label: 'critical', value: 'critical' },
            ],
            validation: { enum: ['', 'info', 'warning', 'error', 'critical'] },
            displayOrder: 69,
          },
        }}
        value="warning"
        onChange={onChange}
      />
    );

    const select = screen.getByLabelText('最小通知級別');
    expect(screen.getByRole('option', { name: '未設置' })).not.toBeDisabled();
    expect(screen.queryByRole('option', { name: '請選擇' })).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith('NOTIFICATION_MIN_SEVERITY', '');
  });

  it('shows the schema default for select fields when no explicit env value exists', () => {
    const onChange = vi.fn();

    render(
      <SettingsField
        item={{
          key: 'GENERATION_BACKEND',
          value: '',
          rawValueExists: false,
          isMasked: false,
          schema: {
            key: 'GENERATION_BACKEND',
            title: 'Generation Backend',
            category: 'ai_model',
            dataType: 'string',
            uiControl: 'select',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            defaultValue: 'litellm',
            options: [{ label: 'Default model settings', value: 'litellm' }],
            validation: { enum: ['litellm'] },
            displayOrder: 1,
          },
        }}
        value=""
        onChange={onChange}
      />
    );

    expect(screen.getByLabelText('分析生成方式')).toHaveValue('litellm');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders localized labels for real system config select options', () => {
    const selectCases = [
      {
        key: 'NEWS_STRATEGY_PROFILE',
        category: 'data_source',
        options: ['ultra_short', 'short', 'medium', 'long'],
        expectedLabels: ['超短線（1天）', '短期（3天）', '中期（7天）', '長期（30天）'],
      },
      {
        key: 'REPORT_TYPE',
        category: 'notification',
        options: ['simple', 'full', 'brief'],
        expectedLabels: ['簡潔', '完整', '演示文稿'],
      },
      {
        key: 'LOG_LEVEL',
        category: 'system',
        options: ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'],
        expectedLabels: ['調試', '信息', '警告', '錯誤', '嚴重'],
      },
    ] as const;

    selectCases.forEach(({ key, category, options, expectedLabels }) => {
      const { unmount } = render(
        <SettingsField
          item={{
            key,
            value: options[0],
            rawValueExists: true,
            isMasked: false,
            schema: {
              key,
              title: key,
              category,
              dataType: 'string',
              uiControl: 'select',
              isSensitive: false,
              isRequired: false,
              isEditable: true,
              options: [...options],
              validation: {},
              displayOrder: 1,
            },
          }}
          value={options[0]}
          onChange={() => undefined}
        />
      );

      expectedLabels.forEach((label) => {
        expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
      });

      options.forEach((rawOption) => {
        expect(screen.queryByRole('option', { name: rawOption })).not.toBeInTheDocument();
      });

      unmount();
    });
  });

  it('renders MARKET_REVIEW_REGION as free-text field with comma-separated defaults', () => {
    const onChange = vi.fn();

    render(
      <SettingsField
        item={{
          key: 'MARKET_REVIEW_REGION',
          value: 'cn,jp',
          rawValueExists: true,
          isMasked: false,
          schema: {
            key: 'MARKET_REVIEW_REGION',
            category: 'system',
            dataType: 'string',
            uiControl: 'text',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [],
            validation: {},
            displayOrder: 1,
          },
        }}
        value="cn,jp"
        onChange={onChange}
      />
    );

    const input = screen.getByLabelText('大盤覆盤市場') as HTMLInputElement;
    expect(input).toHaveValue('cn,jp');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    fireEvent.change(input, {
      target: { value: 'cn,jp,kr' },
    });

    expect(onChange).toHaveBeenCalledWith('MARKET_REVIEW_REGION', 'cn,jp,kr');
  });

  it('renders context compression profile options with Chinese labels', () => {
    const onChange = vi.fn();

    render(
      <SettingsField
        item={{
          key: 'AGENT_CONTEXT_COMPRESSION_PROFILE',
          value: 'balanced',
          rawValueExists: true,
          isMasked: false,
          schema: {
            key: 'AGENT_CONTEXT_COMPRESSION_PROFILE',
            category: 'agent',
            dataType: 'string',
            uiControl: 'select',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [
              { label: '成本優先', value: 'cost' },
              { label: '均衡推薦', value: 'balanced' },
              { label: '長上下文原文優先', value: 'long_context_raw_first' },
            ],
            validation: {
              enum: ['cost', 'balanced', 'long_context_raw_first'],
            },
            displayOrder: 72,
          },
        }}
        value="balanced"
        onChange={onChange}
      />
    );

    expect(screen.getByLabelText('上下文壓縮策略')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '成本優先' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '均衡推薦' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '長上下文原文優先' })).toBeInTheDocument();
  });

  it('renders blank-value preset guidance for context compression numeric fields', () => {
    const onChange = vi.fn();

    render(
      <>
        <SettingsField
          item={{
            key: 'AGENT_CONTEXT_COMPRESSION_TRIGGER_TOKENS',
            value: '',
            rawValueExists: false,
            isMasked: false,
            schema: {
              key: 'AGENT_CONTEXT_COMPRESSION_TRIGGER_TOKENS',
              category: 'agent',
              dataType: 'integer',
              uiControl: 'number',
              isSensitive: false,
              isRequired: false,
              isEditable: true,
              options: [],
              validation: { min: 1000 },
              displayOrder: 73,
            },
          }}
          value=""
          onChange={onChange}
        />
        <SettingsField
          item={{
            key: 'AGENT_CONTEXT_PROTECTED_TURNS',
            value: '',
            rawValueExists: false,
            isMasked: false,
            schema: {
              key: 'AGENT_CONTEXT_PROTECTED_TURNS',
              category: 'agent',
              dataType: 'integer',
              uiControl: 'number',
              isSensitive: false,
              isRequired: false,
              isEditable: true,
              options: [],
              validation: { min: 1 },
              displayOrder: 74,
            },
          }}
          value=""
          onChange={onChange}
        />
      </>
    );

    expect(screen.getByLabelText('壓縮觸發閾值（tokens）')).toBeInTheDocument();
    expect(screen.getByLabelText('原文保護輪次')).toBeInTheDocument();
    expect(screen.getByText(/估算曆史 token 超過該值時觸發摘要/)).toHaveTextContent('留空則跟隨當前上下文壓縮策略 profile 默認值');
    expect(screen.getByText(/壓縮時最近 N 個用戶輪次及其後的回覆保持原文/)).toHaveTextContent('留空則跟隨當前上下文壓縮策略 profile 默認值');
  });

  it('renders localized custom webhook body template guidance', () => {
    const onChange = vi.fn();

    render(
      <SettingsField
        item={{
          key: 'CUSTOM_WEBHOOK_BODY_TEMPLATE',
          value: '',
          rawValueExists: false,
          isMasked: false,
          schema: {
            key: 'CUSTOM_WEBHOOK_BODY_TEMPLATE',
            category: 'notification',
            dataType: 'string',
            uiControl: 'textarea',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [],
            validation: {},
            displayOrder: 52,
          },
        }}
        value=""
        onChange={onChange}
      />
    );

    expect(screen.getByLabelText('自定義 Webhook Body 模板')).toBeInTheDocument();
    expect(screen.getByText(/會先於 Bark、Slack、Discord 等自動 payload 生效/)).toBeInTheDocument();
    expect(screen.getByText(/裸 \$content \/ \$title 不做 JSON 轉義/)).toBeInTheDocument();
  });

  it('opens detailed field help when help metadata is available', () => {
    render(
      <SettingsField
        item={{
          key: 'STOCK_LIST',
          value: '600519,300750',
          rawValueExists: true,
          isMasked: false,
          schema: {
            key: 'STOCK_LIST',
            category: 'base',
            dataType: 'array',
            uiControl: 'textarea',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [],
            validation: {},
            displayOrder: 1,
            helpKey: 'settings.base.STOCK_LIST',
            examples: ['STOCK_LIST=600519,300750,002594'],
            docs: [
              {
                label: '完整指南',
                href: 'https://example.com/full-guide',
              },
            ],
            warningCodes: [],
          },
        }}
        value="600519,300750"
        onChange={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '查看 自選股列表 配置說明' }));

    expect(screen.getByRole('dialog', { name: '自選股列表' })).toBeInTheDocument();
    expect(screen.getByText('STOCK_LIST=600519,300750,002594')).toBeInTheDocument();
    const docLink = screen.getByRole('link', { name: /完整指南/ });
    expect(docLink).toHaveAttribute('href', 'https://example.com/full-guide');

    const closeButtons = screen.getAllByRole('button', { name: '關閉配置說明' });
    expect(closeButtons[0].tabIndex).toBe(-1);
    const closeButton = closeButtons.find((button) => button.tabIndex !== -1);
    expect(closeButton).toBeDefined();

    closeButton?.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(docLink).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '自選股列表' })).not.toBeInTheDocument();
  });

  it('keeps generation channel help user-facing without env key or examples', () => {
    render(
      <SettingsField
        item={{
          key: 'GENERATION_BACKEND',
          value: 'litellm',
          rawValueExists: true,
          isMasked: false,
          schema: {
            key: 'GENERATION_BACKEND',
            title: 'Generation Backend',
            category: 'ai_model',
            dataType: 'string',
            uiControl: 'select',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [{ label: 'Default model settings', value: 'litellm' }],
            validation: { enum: ['litellm'] },
            displayOrder: 1,
            helpKey: 'settings.ai_model.GENERATION_BACKEND',
            examples: ['GENERATION_BACKEND=litellm'],
            warningCodes: [],
          },
        }}
        value="litellm"
        onChange={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '查看 分析生成方式 配置說明' }));

    const dialog = screen.getByRole('dialog', { name: '分析生成方式' });
    expect(dialog).toHaveTextContent('決定系統用哪種方式生成');
    expect(dialog).not.toHaveTextContent('GENERATION_BACKEND');
    expect(dialog).not.toHaveTextContent('配置樣例');
    expect(dialog).not.toHaveTextContent('Phase 1');
    expect(dialog).toHaveTextContent('本機已安裝並登錄對應 CLI');
    expect(dialog).toHaveTextContent('缺省模型配置會繼續使用現有 API Key');
    expect(dialog).not.toHaveTextContent('高端說明');
    expect(dialog).not.toHaveTextContent('LiteLLM');
  });

  it('describes agent auto generation without exposing implementation labels as the primary UI copy', () => {
    render(
      <SettingsField
        item={{
          key: 'AGENT_GENERATION_BACKEND',
          value: 'auto',
          rawValueExists: true,
          isMasked: false,
          schema: {
            key: 'AGENT_GENERATION_BACKEND',
            title: 'Agent Generation Backend',
            category: 'agent',
            dataType: 'string',
            uiControl: 'select',
            isSensitive: false,
            isRequired: false,
            isEditable: true,
            options: [
              { label: 'Auto', value: 'auto' },
              { label: 'Default model settings', value: 'litellm' },
            ],
            validation: { enum: ['auto', 'litellm'] },
            displayOrder: 1,
            helpKey: 'settings.agent.AGENT_GENERATION_BACKEND',
            examples: [],
            warningCodes: [],
          },
        }}
        value="auto"
        onChange={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '查看 問股生成方式 配置說明' }));

    const dialog = screen.getByRole('dialog', { name: '問股生成方式' });
    expect(dialog).toHaveTextContent('系統會選擇當前可用的方式');
    expect(dialog).toHaveTextContent('如果不確定，選擇“自動”即可');
    expect(dialog).toHaveTextContent('這項設置隻影響問股助手');
    expect(dialog).not.toHaveTextContent('高端說明');
    expect(dialog).not.toHaveTextContent('LiteLLM');
    expect(dialog).not.toHaveTextContent('優先選擇當前可用');
  });

  it('uses per-field schema titles even when helpKey is shared by multiple fields', () => {
    const restoreLanguage = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'en');

    try {
      const SchemaTitleSwitcher = ({ children }: { children: ReactNode }) => {
        const { setLanguage } = useUiLanguage();
        return (
          <div>
            <button type="button" onClick={() => setLanguage('en')}>
              switch-en
            </button>
            {children}
          </div>
        );
      };

      render(
        <UiLanguageProvider>
          <SchemaTitleSwitcher>
            <SettingsField
              item={{
                key: 'OPENAI_MODEL',
                value: 'gemini/gemini-3.1-pro-preview',
                rawValueExists: true,
                isMasked: false,
                schema: {
                  key: 'OPENAI_MODEL',
                  category: 'ai_model',
                  dataType: 'string',
                  uiControl: 'text',
                  isSensitive: false,
                  isRequired: false,
                  isEditable: true,
                  options: [],
                  validation: {},
                  displayOrder: 10,
                  title: 'Primary model',
                  helpKey: 'settings.llm_channel.primary_model',
                  description: 'Primary model description',
                },
              }}
              value="gemini/gemini-3.1-pro-preview"
              onChange={vi.fn()}
            />
            <SettingsField
              item={{
                key: 'OPENAI_VISION_MODEL',
                value: 'gemini/gemini-2.0-flash',
                rawValueExists: true,
                isMasked: false,
                schema: {
                  key: 'OPENAI_VISION_MODEL',
                  category: 'ai_model',
                  dataType: 'string',
                  uiControl: 'text',
                  isSensitive: false,
                  isRequired: false,
                  isEditable: true,
                  options: [],
                  validation: {},
                  displayOrder: 11,
                  title: 'Vision model',
                  helpKey: 'settings.llm_channel.primary_model',
                  description: 'Vision model description',
                },
              }}
              value="gemini/gemini-2.0-flash"
              onChange={vi.fn()}
            />
          </SchemaTitleSwitcher>
        </UiLanguageProvider>
      );

      fireEvent.click(screen.getByRole('button', { name: 'switch-en' }));

      expect(screen.getByLabelText('Primary model')).toBeInTheDocument();
      expect(screen.getByLabelText('Vision model')).toBeInTheDocument();
    } finally {
      if (restoreLanguage) {
        localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, restoreLanguage);
      } else {
        localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY);
      }
    }
  });
});
