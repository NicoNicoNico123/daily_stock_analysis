export type ChannelProtocol = 'openai' | 'deepseek' | 'gemini' | 'anthropic' | 'vertex_ai' | 'ollama';
export type LLMProviderCapability =
  | 'openai-compatible'
  | 'aggregator'
  | 'official-api'
  | 'model-discovery'
  | 'vision'
  | 'local-runtime';

export interface LLMProviderTemplate {
  channelId: string;
  label: string;
  protocol: ChannelProtocol;
  baseUrl: string;
  placeholderModels: string;
  capabilities: LLMProviderCapability[];
  configHint?: string;
  officialSources: Array<{
    label: string;
    url: string;
  }>;
}

export const LLM_PROVIDER_CAPABILITY_LABELS: Record<LLMProviderCapability, { label: string; hint: string }> = {
  'openai-compatible': {
    label: 'OpenAI 兼容',
    hint: '按 OpenAI-compatible endpoint 配置 Base URL，不額外拼接 /chat/completions。',
  },
  aggregator: {
    label: '聚合平臺',
    hint: '模型可見性、路由和價格可能隨帳號權限與平臺策略變化。',
  },
  'official-api': {
    label: '官方 API',
    hint: '使用服務商官方協議或官方兼容入口。',
  },
  'model-discovery': {
    label: '可獲取模型',
    hint: '支持嘗試通過 /models 獲取模型列表；實際結果仍取決於帳號權限和 API Key。',
  },
  vision: {
    label: 'Vision 提示',
    hint: '模板提示該 provider 常用於 Vision 場景；具體模型能力仍以帳號和模型列表爲準。',
  },
  'local-runtime': {
    label: '本地運行',
    hint: '需要當前運行環境能訪問對應本地服務。',
  },
};

export const LLM_PROVIDER_TEMPLATES: LLMProviderTemplate[] = [
  {
    channelId: 'aihubmix',
    label: 'AIHubmix（聚合平臺）',
    protocol: 'openai',
    baseUrl: 'https://aihubmix.com/v1',
    placeholderModels: 'gpt-5.5,claude-sonnet-4-6,gemini-3.1-pro-preview',
    capabilities: ['openai-compatible', 'aggregator'],
    officialSources: [{ label: 'AIHubmix', url: 'https://inferera.com/?aff=CfMq' }],
  },
  {
    channelId: 'anspire',
    label: 'Anspire Open（一站式模型+搜索）',
    protocol: 'openai',
    baseUrl: 'https://open-gateway.anspire.cn/v6',
    placeholderModels: 'Doubao-Seed-2.0-lite,Doubao-Seed-2.0-pro,qwen3.5-flash,MiniMax-M2.7',
    capabilities: ['openai-compatible'],
    configHint:
      '同一 ANSPIRE_API_KEYS 可複用到搜索與 LLM 渠道。以下模型與網關爲配置示例，實際可用性請以帳號權限和控制檯爲準；建議先點“測試連接”確認。',
    officialSources: [
      { label: 'Anspire Open', url: 'https://open.anspire.cn/?share_code=QFBC0FYC' },
      {
        label: 'LiteLLM OpenAI-compatible',
        url: 'https://docs.litellm.ai/docs/providers/openai_compatible',
      },
    ],
  },
  {
    channelId: 'deepseek',
    label: 'DeepSeek 官方',
    protocol: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    placeholderModels: 'deepseek-v4-flash,deepseek-v4-pro',
    capabilities: ['official-api', 'openai-compatible'],
    officialSources: [{ label: 'DeepSeek API Docs', url: 'https://api-docs.deepseek.com/' }],
  },
  {
    channelId: 'dashscope',
    label: '通義千問（Dashscope）',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    placeholderModels: 'qwen3.6-plus,qwen3.6-flash',
    capabilities: ['openai-compatible', 'model-discovery'],
    officialSources: [
      { label: 'DashScope Text Generation', url: 'https://help.aliyun.com/zh/model-studio/text-generation-model/' },
    ],
  },
  {
    channelId: 'zhipu',
    label: '智譜 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    placeholderModels: 'glm-5.1,glm-4.7-flash',
    capabilities: ['openai-compatible'],
    officialSources: [{ label: 'Zhipu Model Overview', url: 'https://docs.bigmodel.cn/cn/guide/start/model-overview' }],
  },
  {
    channelId: 'moonshot',
    label: 'Moonshot（月之暗面）',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    placeholderModels: 'kimi-k2.6,kimi-k2.5',
    capabilities: ['openai-compatible'],
    officialSources: [{ label: 'Kimi Platform Docs', url: 'https://platform.kimi.com/docs/models' }],
  },
  {
    channelId: 'minimax',
    label: 'MiniMax 官方',
    protocol: 'openai',
    baseUrl: 'https://api.minimax.io/v1',
    placeholderModels: 'MiniMax-M3,MiniMax-M2.7,MiniMax-M2.7-highspeed',
    capabilities: ['openai-compatible'],
    officialSources: [
      { label: 'MiniMax OpenAI API', url: 'https://platform.minimax.io/docs/api-reference/text-chat' },
      { label: 'MiniMax Models', url: 'https://platform.minimax.io/docs/api-reference/models/openai/list-models' },
    ],
  },
  {
    channelId: 'volcengine',
    label: '火山方舟（豆包）',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    placeholderModels: 'doubao-seed-1-6-251015,doubao-seed-1-6-thinking-251015',
    capabilities: ['openai-compatible'],
    configHint: '確認在線推理 endpoint / region 與 Coding Plan 專用入口不要混用。',
    officialSources: [
      { label: 'Volcengine Ark Inference', url: 'https://www.volcengine.com/docs/82379/2121998' },
      { label: 'Volcengine Ark Models', url: 'https://www.volcengine.com/docs/82379/1949118' },
    ],
  },
  {
    channelId: 'siliconflow',
    label: '硅基流動（SiliconFlow）',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    placeholderModels: 'deepseek-ai/DeepSeek-V3.2,Qwen/Qwen3-235B-A22B-Thinking-2507',
    capabilities: ['openai-compatible', 'model-discovery'],
    configHint: '模型列表和模型可見性依賴帳號權限與 API Key。',
    officialSources: [{ label: 'SiliconFlow Models', url: 'https://docs.siliconflow.cn/quickstart/models' }],
  },
  {
    channelId: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    placeholderModels: '~anthropic/claude-sonnet-latest,~openai/gpt-latest',
    capabilities: ['openai-compatible', 'aggregator', 'model-discovery'],
    configHint: '模型列表和模型可見性依賴帳號權限與 API Key。',
    officialSources: [
      { label: 'OpenRouter Models API', url: 'https://openrouter.ai/docs/api/api-reference/models/get-models' },
    ],
  },
  {
    channelId: 'gemini',
    label: 'Gemini 官方',
    protocol: 'gemini',
    baseUrl: '',
    placeholderModels: 'gemini-3.1-pro-preview,gemini-3-flash-preview',
    capabilities: ['official-api', 'vision'],
    officialSources: [{ label: 'Gemini Models', url: 'https://ai.google.dev/gemini-api/docs/models' }],
  },
  {
    channelId: 'anthropic',
    label: 'Anthropic 官方',
    protocol: 'anthropic',
    baseUrl: '',
    placeholderModels: 'claude-sonnet-4-6,claude-opus-4-7',
    capabilities: ['official-api'],
    officialSources: [
      { label: 'Anthropic Models', url: 'https://docs.anthropic.com/en/docs/about-claude/models/all-models' },
    ],
  },
  {
    channelId: 'openai',
    label: 'OpenAI 官方',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    placeholderModels: 'gpt-5.5,gpt-5.4-mini',
    capabilities: ['official-api', 'openai-compatible', 'model-discovery'],
    officialSources: [{ label: 'OpenAI Models', url: 'https://platform.openai.com/docs/models' }],
  },
  {
    channelId: 'ollama',
    label: 'Ollama（本地）',
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    placeholderModels: 'llama3.2,qwen2.5',
    capabilities: ['local-runtime'],
    configHint: '需要本機、Docker 或 self-hosted runner 能訪問 Ollama 服務。',
    officialSources: [{ label: 'Ollama API', url: 'https://github.com/ollama/ollama/blob/main/docs/api.md' }],
  },
  {
    channelId: 'custom',
    label: '自定義渠道',
    protocol: 'openai',
    baseUrl: '',
    placeholderModels: 'model-name-1,model-name-2',
    capabilities: [],
    officialSources: [],
  },
];

export const LLM_PROVIDER_TEMPLATE_BY_ID: Record<string, LLMProviderTemplate> = Object.fromEntries(
  LLM_PROVIDER_TEMPLATES.map((template) => [template.channelId, template]),
);

export function getProviderTemplate(channelId: string): LLMProviderTemplate | undefined {
  if (!Object.prototype.hasOwnProperty.call(LLM_PROVIDER_TEMPLATE_BY_ID, channelId)) {
    return undefined;
  }
  return LLM_PROVIDER_TEMPLATE_BY_ID[channelId];
}

export function isKnownProviderTemplate(channelId: string): boolean {
  return channelId !== 'custom' && Boolean(getProviderTemplate(channelId));
}

export const MODEL_PLACEHOLDERS_BY_PROTOCOL: Record<ChannelProtocol, string> = {
  openai: 'gpt-5.5,qwen3.6-plus',
  deepseek: 'deepseek-v4-flash,deepseek-v4-pro',
  gemini: 'gemini-3.1-pro-preview,gemini-3-flash-preview',
  anthropic: 'claude-sonnet-4-6,claude-opus-4-7',
  vertex_ai: 'gemini-3.1-pro-preview',
  ollama: 'llama3.2,qwen2.5',
};
