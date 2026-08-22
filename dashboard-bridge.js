/**
 * Dashboard bridge: runs on whatsync.io dashboard.
 * Syncs userId (and session) from the page into chrome.storage.local
 * so the extension can use them for getConnectionStatus, getPrivacySettings, etc.
 * Privacy is always fetched from the backend via the extension background script.
 */
(function () {
  const STORAGE_KEY = 'external_auth_session';
  const SYNC_SETTINGS_KEY = 'whatsync.syncSettings';
  const SIDEBAR_FIELDS_KEY = 'whatsync.sidebarFieldsUpdated';

  function syncSessionToExtension() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;

      const session = JSON.parse(raw);
      const userId = session?.user?.id || session?.id || null;
      if (!userId) return;

      chrome.storage.local.set({
        userId,
        userLoggedIn: true,
        external_auth_session: session
      });
      console.log('[Dashboard Bridge] Synced userId to extension storage');
    } catch (e) {
      console.warn('[Dashboard Bridge] Could not sync session:', e);
    }
  }

  function syncIntegrationSettingsToExtension() {
    try {
      const raw = localStorage.getItem(SYNC_SETTINGS_KEY);
      if (!raw) return;

      const settings = JSON.parse(raw);
      if (!settings || typeof settings !== 'object') return;

      chrome.storage.local.set({ [SYNC_SETTINGS_KEY]: settings });
      console.log('[Dashboard Bridge] Synced HubSpot integration settings to extension');
    } catch (e) {
      console.warn('[Dashboard Bridge] Could not sync integration settings:', e);
    }
  }

  // Forward the Sidebar Designer's "saved" signal into chrome.storage so the
  // WhatsApp content script refreshes instantly. (A plain window 'storage'
  // listener on web.whatsapp.com can never see whatsync.io's localStorage —
  // storage events are same-origin — so this bridge is the only working path.)
  function syncSidebarFieldsSignal() {
    try {
      const value = localStorage.getItem(SIDEBAR_FIELDS_KEY);
      if (!value) return;
      chrome.storage.local.set({ [SIDEBAR_FIELDS_KEY]: value });
    } catch (e) {
      console.warn('[Dashboard Bridge] Could not sync sidebar signal:', e);
    }
  }

  function syncAll() {
    syncSessionToExtension();
    syncIntegrationSettingsToExtension();
    syncSidebarFieldsSignal();
  }

  syncAll();

  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) syncSessionToExtension();
    if (e.key === SYNC_SETTINGS_KEY && e.newValue) syncIntegrationSettingsToExtension();
    if (e.key === SIDEBAR_FIELDS_KEY && e.newValue) syncSidebarFieldsSignal();
  });

  const interval = setInterval(syncAll, 5000);
  setTimeout(() => clearInterval(interval), 60000);
})();
