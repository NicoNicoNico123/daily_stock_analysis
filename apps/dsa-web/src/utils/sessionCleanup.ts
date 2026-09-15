/**
 * 会话级（而非用户级）浏览器缓存的 key 清单。
 *
 * 这些状态与"当前登录会话"绑定：多用户模式下切换账号或会话失效时，
 * 必须清掉，避免把上一个账号的会话/随机种子泄露给下一个账号。
 * `dsa.uiLanguage` 属于浏览器级偏好，刻意不在这里清理。
 */
const SESSION_SCOPED_LOCAL_STORAGE_KEYS = [
  'dsa_chat_session_id',
  // 与 src/api/screening.ts 中 SCREENING_VARIANT_SEED_KEY 保持一致
  'dsa.screening.variantSeed.v1',
] as const;

const SESSION_SCOPED_SESSION_STORAGE_KEYS = [
  'dsa.home.taskPanelCollapsed',
  'dsa.screening.activeScreenTask.v1',
] as const;

function removeItem(storage: Storage | null, key: string): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(key);
  } catch {
    // 隐私模式 / 存储被禁用时静默跳过，不影响登录流程
  }
}

/** 清理绑定到当前会话的本地状态，用于登出、会话失效或切换账号时。 */
export function clearSessionScopedState(): void {
  if (typeof window === 'undefined') {
    return;
  }
  let localStorageRef: Storage | null = null;
  let sessionStorageRef: Storage | null = null;
  try {
    localStorageRef = window.localStorage;
  } catch {
    localStorageRef = null;
  }
  try {
    sessionStorageRef = window.sessionStorage;
  } catch {
    sessionStorageRef = null;
  }
  for (const key of SESSION_SCOPED_LOCAL_STORAGE_KEYS) {
    removeItem(localStorageRef, key);
  }
  for (const key of SESSION_SCOPED_SESSION_STORAGE_KEYS) {
    removeItem(sessionStorageRef, key);
  }
}
