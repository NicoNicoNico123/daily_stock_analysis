import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSettingsCard } from '../AuthSettingsCard';

const { refreshStatus, updateSettings, useAuthMock } = vi.hoisted(() => ({
  refreshStatus: vi.fn(),
  updateSettings: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock('../../../hooks', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('../../../api/auth', () => ({
  authApi: {
    updateSettings,
  },
}));

describe('AuthSettingsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthMock.mockReturnValue({
      authEnabled: false,
      setupState: 'no_password',
      refreshStatus,
    });
  });

  it('enables auth with a new password and refreshes status', async () => {
    updateSettings.mockResolvedValue(undefined);
    refreshStatus.mockResolvedValue(undefined);

    render(<AuthSettingsCard />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('設置管理員密碼'), { target: { value: 'passwd6' } });
    fireEvent.change(screen.getByLabelText('確認新密碼'), { target: { value: 'passwd6' } });
    fireEvent.click(screen.getByRole('button', { name: '打開認證' }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(true, 'passwd6', 'passwd6', undefined);
    });
    expect(refreshStatus).toHaveBeenCalled();
    expect(await screen.findByText('認證設置已更新')).toBeInTheDocument();
  });

  it('blocks disabling auth when the current admin password is missing (Issue #1970)', async () => {
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupState: 'enabled',
      refreshStatus,
    });
    updateSettings.mockResolvedValue(undefined);
    refreshStatus.mockResolvedValue(undefined);

    render(<AuthSettingsCard />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '關閉認證' }));

    expect(await screen.findByText('關閉認證前必須輸入當前管理員密碼')).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('disables auth when the current admin password is provided (Issue #1970)', async () => {
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupState: 'enabled',
      refreshStatus,
    });
    updateSettings.mockResolvedValue(undefined);
    refreshStatus.mockResolvedValue(undefined);

    render(<AuthSettingsCard />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('當前管理員密碼'), { target: { value: 'passwd6' } });
    fireEvent.click(screen.getByRole('button', { name: '關閉認證' }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(false, undefined, undefined, 'passwd6');
    });
    expect(refreshStatus).toHaveBeenCalled();
    expect(await screen.findByText('認證已關閉')).toBeInTheDocument();
  });

  it('shows only current password when re-enabling with a retained password', () => {
    useAuthMock.mockReturnValue({
      authEnabled: false,
      setupState: 'password_retained',
      refreshStatus,
    });

    render(<AuthSettingsCard />);

    fireEvent.click(screen.getByRole('checkbox'));

    expect(screen.getByLabelText('當前管理員密碼')).toBeInTheDocument();
    expect(screen.queryByLabelText('設置管理員密碼')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('確認新密碼')).not.toBeInTheDocument();
  });

  it('does not show new password fields while auth is already enabled', () => {
    useAuthMock.mockReturnValue({
      authEnabled: true,
      setupState: 'enabled',
      refreshStatus,
    });

    render(<AuthSettingsCard />);

    expect(screen.queryByLabelText('設置管理員密碼')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('確認新密碼')).not.toBeInTheDocument();
  });

  it('blocks initial enable when the new password is missing', async () => {
    render(<AuthSettingsCard />);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '打開認證' }));

    expect(await screen.findByText('設置新密碼是必填項')).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
