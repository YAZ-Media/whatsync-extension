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
  const HUBSPOT_CONNECTION_KEY = 'whatsync.hubspotConnectionUpdated';

  let sessionSyncRunning = false;
  let hadPageSession = false;
  const tokenExpiry = token => {
    try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp || 0; } catch { return 0; }
  };
  async function syncSessionToExtension() {
    if (sessionSyncRunning) return;
    sessionSyncRunning = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        if (hadPageSession) {
          hadPageSession = false;
          await chrome.storage.local.set({userId:null,userLoggedIn:false,accessToken:null,refreshToken:null,external_auth_session:null});
        }
        return;
      }
      hadPageSession = true;
      const page = JSON.parse(raw);
      const userId = page?.user?.id;
      const pageSession = page.session || page;
      if (!userId || !pageSession.access_token || !pageSession.refresh_token) return;
      const stored = await chrome.storage.local.get(['userId','accessToken','refreshToken','external_auth_session']);
      const extensionSession = stored.external_auth_session?.session || stored.external_auth_session || {};
      const extensionToken = stored.accessToken || extensionSession.access_token;
      const extensionRefresh = stored.refreshToken || extensionSession.refresh_token;
      // Adopt a worker rotation for this same account before attempting another rotation.
      if (stored.userId === userId && extensionToken && extensionRefresh && extensionToken !== pageSession.access_token && tokenExpiry(extensionToken) >= tokenExpiry(pageSession.access_token)) {
        if (localStorage.getItem(STORAGE_KEY) !== raw) return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({...page,session:{access_token:extensionToken,refresh_token:extensionRefresh}}));
        window.dispatchEvent(new Event('whatsync-session-updated'));
        return;
      }
      if (stored.userId === userId && extensionToken === pageSession.access_token) return;
      if (localStorage.getItem(STORAGE_KEY) !== raw) return;
      await chrome.storage.local.set({userId,userLoggedIn:true,accessToken:pageSession.access_token,refreshToken:pageSession.refresh_token,external_auth_session:page});
    } catch (e) {
      console.warn('[Dashboard Bridge] Session synchronization unavailable.');
    } finally { sessionSyncRunning = false; }
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

  let lastHubSpotConnectionSignal = null;
  async function syncHubSpotConnectionSignal() {
    try {
      const value = localStorage.getItem(HUBSPOT_CONNECTION_KEY);
      if (!value || value === lastHubSpotConnectionSignal) return;
      lastHubSpotConnectionSignal = value;
      await chrome.runtime.sendMessage({ action: 'refreshHubSpotIntegration' });
    } catch (e) {
      console.warn('[Dashboard Bridge] Could not refresh HubSpot connection status:', e);
    }
  }

  let lastPrivacy = null;
  function syncPrivacy() {
    const raw = localStorage.getItem('whatsync.privacySettings');
    if (!raw || raw === lastPrivacy) return;
    try { chrome.storage.local.set({'whatsync.privacySettings': JSON.parse(raw)}); lastPrivacy = raw; } catch { /* retry on next tick */ }
  }
  function syncAll() {
    syncPrivacy();
    syncSessionToExtension();
    syncIntegrationSettingsToExtension();
    syncSidebarFieldsSignal();
    syncHubSpotConnectionSignal();
  }

  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'WHATSYNC_STATUS_REQUEST') return;
    try {
      const stored = await chrome.storage.local.get(['userId','userLoggedIn','accessToken']);
      window.postMessage({type:'WHATSYNC_STATUS_RESPONSE',requestId:event.data.requestId,version:chrome.runtime.getManifest().version,userId:stored.userLoggedIn && stored.accessToken ? stored.userId : null},location.origin);
    } catch { /* Reloaded extension is reported as unavailable by the page. */ }
  });
  syncAll();

  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) syncSessionToExtension();
    if (e.key === SYNC_SETTINGS_KEY && e.newValue) syncIntegrationSettingsToExtension();
    if (e.key === SIDEBAR_FIELDS_KEY && e.newValue) syncSidebarFieldsSignal();
    if (e.key === HUBSPOT_CONNECTION_KEY && e.newValue) syncHubSpotConnectionSignal();
  });

  window.addEventListener('whatsync-session-updated', syncSessionToExtension);
  const interval = setInterval(syncAll, 1000);
  window.addEventListener('pagehide', () => clearInterval(interval), {once:true});
})();
