// Background service worker for handling API calls

// Supabase Functions Edge Function URL for HubSpot token
const HUBSPOT_TOKEN_ENDPOINT = 'https://ogsvchujqpayuckxuwdf.supabase.co/functions/v1/hubspot';
// Supabase Functions Edge Function URL for HubSpot OAuth operations (connection status, etc.)
const HUBSPOT_OAUTH_ENDPOINT = 'https://ogsvchujqpayuckxuwdf.supabase.co/functions/v1/hubspot-oauth';
const HUBSPOT_CONFIG = {
  apiUrl: 'https://api.hubapi.com'
};

// External Supabase — auth + database (user_profiles, hubspot_contact_logs, etc.)
const SUPABASE_URL = 'https://ogsvchujqpayuckxuwdf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nc3ZjaHVqcXBheXVja3h1d2RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzU3MzIsImV4cCI6MjA5NTk1MTczMn0.naUOzsjvZk5BT6kUM-eV1g4JxPhBogkBu8gb1Rg0Z8M';
// Edge functions live on the same (ogsvc) project — use its anon key for apikey.
const EDGE_FUNCTIONS_URL = SUPABASE_URL;
const EDGE_FUNCTIONS_ANON_KEY = SUPABASE_ANON_KEY;

// Session Configuration.
// Persistent session: no wall-clock logout. The background proactively refreshes
// the access token before it expires and only signs out if the refresh token is
// rejected (session genuinely revoked).
const SESSION_CONFIG = {
  // Refresh the access token this long before it expires.
  refreshLeewayMs: 10 * 60 * 1000, // 10 minutes
  // How often the background checks whether a refresh is due.
  checkIntervalMs: 30 * 60 * 1000 // 30 minutes
};

// HubSpot connection status cache (avoid hammering getConnectionStatus API)
const HUBSPOT_CONNECTION_CACHE_MS = 5 * 60 * 1000; // 5 minutes
// Durable fallback valid for 24 h — survives service-worker restarts
const HUBSPOT_CONNECTION_STORAGE_KEY = 'hubspotConnectionStatus';
const HUBSPOT_CONNECTION_STORAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let hubspotConnectionCache = null; // { userId, status, portal_id, cachedAt }

// Privacy settings (from settings edge function)
const SETTINGS_EDGE_URL = `${EDGE_FUNCTIONS_URL}/functions/v1/settings`;
const PRIVACY_CACHE_MS = 5 * 60 * 1000; // 5 minutes
let privacySettingsCache = null; // { userId, privacy, cachedAt }

const SYNC_FAILURE_REPORT_MS = 15 * 60 * 1000; // throttle failure emails
let lastSyncFailureReportAt = 0;

async function reportSyncFailure(userId, context, message) {
  if (!userId) return;
  const now = Date.now();
  if (now - lastSyncFailureReportAt < SYNC_FAILURE_REPORT_MS) return;
  lastSyncFailureReportAt = now;
  try {
    // The settings function authenticates the caller; without the bearer token
    // this report is rejected with 401 and silently dropped.
    const accessToken = await getStoredAccessToken();
    if (!accessToken) return;
    await fetchWithTimeout(SETTINGS_EDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: EDGE_FUNCTIONS_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        action: 'reportSyncFailure',
        data: { userId, context, message: String(message || 'Unknown error').slice(0, 500) },
      }),
    });
  } catch (e) {
    console.warn('[Background] reportSyncFailure failed:', e);
  }
}

// HubSpot sync settings (from hubspot-oauth getSyncSettings)
const SYNC_SETTINGS_STORAGE_KEY = 'whatsync.syncSettings';
const SYNC_SETTINGS_CACHE_MS = 5 * 60 * 1000; // 5 minutes
let syncSettingsCache = null; // { userId, settings, cachedAt }

// Note: HubSpot access token is stored securely in the edge function (Deno.env)
// All HubSpot API calls are routed through the edge function - no token in extension code

// Function to call HubSpot via edge function
function readAccessTokenFromSession(sessionValue) {
  if (!sessionValue) return null;
  try {
    const parsed = typeof sessionValue === 'string' ? JSON.parse(sessionValue) : sessionValue;
    return (
      parsed?.access_token ||
      parsed?.accessToken ||
      parsed?.session?.access_token ||
      null
    );
  } catch {
    return null;
  }
}

async function getStoredRefreshToken() {
  const storageData = await chrome.storage.local.get(['refreshToken', 'external_auth_session']);
  if (storageData.refreshToken) return storageData.refreshToken;
  // Sessions stored before refreshToken was persisted separately keep it inline
  const session = storageData.external_auth_session;
  return session?.refresh_token || session?.session?.refresh_token || null;
}

async function getStoredAccessToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['accessToken', 'external_auth_session', 'userLoggedIn'], (storageData) => {
      if (!storageData.userLoggedIn) {
        resolve(null);
        return;
      }
      const token =
        storageData.accessToken ||
        readAccessTokenFromSession(storageData.external_auth_session);
      resolve(token || null);
    });
  });
}

function edgeRequestRequiresAuth(data) {
  return !!(data?.userId || data?.user_id);
}

const EDGE_FUNCTION_TIMEOUT_MS = 30 * 1000;

// fetch with a hard timeout so a hung edge function can never stall the
// service worker (and the user's action) indefinitely
async function fetchWithTimeout(url, options = {}, timeoutMs = EDGE_FUNCTION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callHubSpotEdgeFunction(action, data = {}) {
  const requestBody = { action, data };
  const needsAuth = edgeRequestRequiresAuth(data);
  let accessToken = await getStoredAccessToken();

  if (needsAuth && !accessToken) {
    throw new Error('Not authenticated');
  }

  const doRequest = async (token) => {
    const headers = {
      'Content-Type': 'application/json',
      apikey: EDGE_FUNCTIONS_ANON_KEY,
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetchWithTimeout(HUBSPOT_TOKEN_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
  };

  try {
    let response = await doRequest(accessToken);

    // Expired session: refresh the token once and retry transparently
    if (response.status === 401 && accessToken) {
      const refreshToken = await getStoredRefreshToken();
      const refreshed = refreshToken ? await refreshAccessToken(refreshToken) : null;
      if (refreshed && refreshed !== accessToken) {
        accessToken = refreshed;
        response = await doRequest(accessToken);
      }
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errorBody = await response.json();
        message = errorBody.error || errorBody.message || message;
      } catch {
        // ignore parse errors
      }
      throw new Error(message);
    }

    let body = await response.json();

    // The hubspot edge function reports auth failures as HTTP 200 with
    // { error, status: 401 } in the body — the transport-level 401 retry above
    // never sees those. Refresh the session once and retry, otherwise an
    // expired access token silently breaks every call (stage labels, activity
    // timeline, ...) until something else happens to refresh it.
    if (body && body.status === 401 && typeof body.error === 'string' && accessToken) {
      const refreshToken = await getStoredRefreshToken();
      const refreshed = refreshToken ? await refreshAccessToken(refreshToken) : null;
      if (refreshed && refreshed !== accessToken) {
        accessToken = refreshed;
        const retryResponse = await doRequest(accessToken);
        if (retryResponse.ok) {
          body = await retryResponse.json();
        }
      }
    }

    // The hubspot edge function wraps failures as HTTP 200 with an
    // { error, status, notConnected } body (so the API gateway doesn't swallow
    // the detail). Surface those as thrown errors so callers never mistake an
    // error payload for a successful result (this caused create-contact to
    // report success while nothing was saved).
    if (body && typeof body === 'object' && typeof body.error === 'string' && body.error) {
      const err = new Error(body.error);
      err.status = body.status;
      err.notConnected = body.notConnected === true;
      throw err;
    }
    return body;
  } catch (error) {
    const message = error?.message || 'Edge function call failed';
    if (message !== 'Not authenticated') {
      console.warn(`[Background] ${action} failed:`, message);
      try {
        const userId = data?.userId || data?.user_id;
        if (userId) {
          reportSyncFailure(userId, action, message);
        }
      } catch (_) { /* noop */ }
    }
    throw error;
  }
}

// Listen for messages from content script
// Helper function to get current tab ID
async function getCurrentTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      return tabs[0].id;
    }
  } catch (error) {
    console.error('[Background] Error getting current tab ID:', error);
  }
  return null;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle getCurrentTabId request
  if (request.action === 'getCurrentTabId') {
    getCurrentTabId().then(tabId => {
      sendResponse({ tabId });
    }).catch(error => {
      sendResponse({ tabId: null, error: error.message });
    });
    return true; // Keep channel open for async response
  }
  
  // Handle executeScript request (for injecting code into page context)
  if (request.action === 'executeScript') {
    (async () => {
      try {
        const tabId = request.tabId || (await getCurrentTabId());
        if (!tabId) {
          sendResponse({ success: false, error: 'Could not get tab ID' });
          return;
        }
        
        // Functions can't be serialized, so we receive funcString and reconstruct it
        let funcToExecute;
        if (request.funcString) {
          // Reconstruct function from string using Function constructor
          funcToExecute = new Function('return ' + request.funcString)();
        } else if (typeof request.func === 'function') {
          funcToExecute = request.func;
        } else {
          sendResponse({ success: false, error: 'No function provided' });
          return;
        }
        
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: funcToExecute,
          args: request.args || [],
          world: request.world || 'MAIN'
        });
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Keep channel open for async response
  }
  if (request.action === 'fetchContactNotes') {
    
    // Get userId and session from storage
    chrome.storage.local.get(['userId', 'accessToken', 'userLoggedIn', 'external_auth_session'], async (storageData) => {
      const userId = storageData.userId || null;
      const contactId = request.contactId || null;
      
      // Try to get Supabase session token from external_auth_session
      let supabaseAccessToken = null;
      if (storageData.external_auth_session) {
        try {
          const session = typeof storageData.external_auth_session === 'string' 
            ? JSON.parse(storageData.external_auth_session) 
            : storageData.external_auth_session;
          supabaseAccessToken = session?.access_token || session?.accessToken || null;
        } catch (e) {
          // Silent fail
        }
      }
      
      // Fallback to accessToken if no Supabase token found
      if (!supabaseAccessToken) {
        supabaseAccessToken = storageData.accessToken || null;
      }
      
      if (!userId) {
        sendResponse({ success: false, error: 'User not authenticated' });
        return;
      }
      
      if (!contactId) {
        sendResponse({ success: false, error: 'Contact ID is required' });
        return;
      }
      
      try {
        // Route notes fetching through edge function (bypasses RLS/JWT issues)
        const result = await callHubSpotEdgeFunction('getContactNotes', { 
          userId: userId,
          hubspotContactId: contactId ? String(contactId) : null
        });
        const notes = result?.results || [];
        sendResponse({ success: true, data: notes });
      } catch (error) {
        console.error('[Background] Error fetching notes:', error);
        // Return empty array instead of error to prevent UI breakage
        sendResponse({ success: true, data: [] });
      }
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'clearHubSpotCache') {
    hubspotConnectionCache = null;
    chrome.storage.local.remove(HUBSPOT_CONNECTION_STORAGE_KEY);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'checkHubSpotIntegration') {
    (async () => {
      try {
        const storageData = await chrome.storage.local.get(['userId', 'userLoggedIn']);
        const userId = storageData.userId || null;

        if (!userId || !storageData.userLoggedIn) {
          hubspotConnectionCache = null;
          sendResponse({ success: true, data: { status: 'disconnected' } });
          return;
        }

        const result = await checkHubSpotIntegrationStatusViaEdgeFunction(userId);
        sendResponse({ success: true, data: result });
      } catch {
        // checkHubSpotIntegrationStatusViaEdgeFunction already tried the durable
        // storage fallback before throwing, so if we reach here there is genuinely
        // no usable record. Return disconnected as a last resort.
        sendResponse({ success: true, data: { status: 'disconnected' } });
      }
    })();

    return true;
  }

  if (request.action === 'getPrivacySettings') {
    chrome.storage.local.get(['userId', 'userLoggedIn'], async (storageData) => {
      const defaultPrivacy = { mask_phone: true, mask_media: false, allowed_properties: ['firstname_lastname', 'phone', 'email', 'company'] };
      const userId = storageData.userId || null;
      if (!userId || !storageData.userLoggedIn || !(await getStoredAccessToken())) {
        sendResponse({ success: true, privacy: defaultPrivacy });
        return;
      }
      try {
        const privacy = await getPrivacySettingsViaEdgeFunction(userId);
        sendResponse({ success: true, privacy });
      } catch {
        sendResponse({ success: true, privacy: defaultPrivacy });
      }
    });
    return true;
  }

  if (request.action === 'getSyncSettings') {
    chrome.storage.local.get(['userId', 'userLoggedIn'], async (storageData) => {
      const defaultSettings = {
        contact_owner_assignment: 'round_robin',
        default_pipeline_id: null,
        default_stage_id: null,
      };
      const userId = storageData.userId || null;
      if (!userId || !storageData.userLoggedIn || !(await getStoredAccessToken())) {
        sendResponse({ success: true, settings: defaultSettings });
        return;
      }
      try {
        const settings = await getSyncSettingsForUser(userId);
        sendResponse({ success: true, settings });
      } catch {
        sendResponse({ success: true, settings: defaultSettings });
      }
    });
    return true;
  }

  if (request.action === 'getSidebarFields') {
    chrome.storage.local.get(['userId', 'userLoggedIn'], async (storageData) => {
      // The authenticated user in storage is authoritative; never trust a
      // userId supplied in the message payload.
      const userId = storageData.userId || null;
      const emptyFields = { contactFields: [], actionFields: [] };

      if (!userId || !storageData.userLoggedIn) {
        sendResponse({ success: true, data: emptyFields });
        return;
      }

      const token = await getStoredAccessToken();
      if (!token) {
        sendResponse({ success: true, data: emptyFields });
        return;
      }

      try {
        const data = await callHubSpotEdgeFunction('getSidebarFields', { userId });
        sendResponse({ success: true, data });
      } catch (error) {
        const message = error?.message || 'Failed to load sidebar fields';
        if (message === 'Not authenticated') {
          sendResponse({ success: true, data: emptyFields });
          return;
        }
        sendResponse({ success: false, error: message, data: emptyFields });
      }
    });
    return true;
  }
  
  if (request.action === 'checkHubSpotContact') {
    console.log('[Background] Received HubSpot search request for phone:', request.phoneNumber);
    
    // Route HubSpot API call through edge function (more secure - token stays on server)
    checkHubSpotContactViaEdgeFunction(request.phoneNumber)
      .then(result => {
        console.log('[Background] HubSpot API call completed. Result:', result);
        sendResponse({ success: true, data: result });
      })
      .catch(error => {
        console.error('[Background] HubSpot API call failed:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'createHubSpotContact') {
    console.log('[Background] Received HubSpot create contact request:', request.contactData);
    
    // Get userId and accessToken from storage
    chrome.storage.local.get(['userId', 'accessToken', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      const accessToken = storageData.accessToken || null;
      const userLoggedIn = storageData.userLoggedIn || false;
      
      console.log('[Background] ===== STORAGE DATA =====');
      console.log('[Background] User Logged In:', userLoggedIn);
      console.log('[Background] User ID:', userId);
      console.log('[Background] Access Token:', accessToken ? 'present' : 'missing');
      console.log('[Background] ========================');
      
      // Route create contact through edge function
      createHubSpotContactViaEdgeFunction(request.contactData, userId, accessToken)
        .then(result => {
          console.log('[Background] HubSpot contact created. Result:', result);
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          console.error('[Background] HubSpot create contact failed:', error);
          sendResponse({ success: false, error: error.message });
        });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'getHubSpotTickets') {
    console.log('[Background] Received get HubSpot tickets request');
    console.log('[Background] Contact ID:', request.contactId);
    console.log('[Background] Fetch All:', request.fetchAll);
    
    // Get userId from storage (required for edge function to query external database)
    chrome.storage.local.get(['userId', 'accessToken', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      const accessToken = storageData.accessToken || null;
      const userLoggedIn = storageData.userLoggedIn || false;
      
      console.log('[Background] User Logged In:', userLoggedIn);
      console.log('[Background] User ID:', userId);
      console.log('[Background] Access Token:', accessToken ? 'present' : 'missing');
      
      if (!userId) {
        sendResponse({ success: false, error: 'Not authenticated - userId required' });
        return;
      }
      
      // If fetchAll is true, we want all tickets (not filtered by contact)
      // Pass null as contactId to the edge function
      const contactIdToUse = request.fetchAll ? null : request.contactId;
      
      // Route ticket fetching through edge function with userId
      getHubSpotTicketsViaEdgeFunction(contactIdToUse, userId)
        .then(result => {
          console.log('[Background] ✅ HubSpot tickets fetched successfully!');
          console.log('[Background] Result count:', result ? result.length : 0);
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          console.error('[Background] ❌ HubSpot get tickets failed!');
          console.error('[Background] Error message:', error.message);
          sendResponse({ success: false, error: error.message });
        });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'searchHubSpotTickets') {
    console.log('[Background] Received search HubSpot tickets request');
    console.log('[Background] Search term:', request.searchTerm);
    console.log('[Background] Contact ID:', request.contactId);
    
    // Get userId from storage (required for edge function to query external database)
    chrome.storage.local.get(['userId', 'accessToken', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      const accessToken = storageData.accessToken || null;
      const userLoggedIn = storageData.userLoggedIn || false;
      
      console.log('[Background] User Logged In:', userLoggedIn);
      console.log('[Background] User ID:', userId);
      console.log('[Background] Access Token:', accessToken ? 'present' : 'missing');
      
      if (!userId) {
        sendResponse({ success: false, error: 'Not authenticated - userId required' });
        return;
      }
      
      // Route ticket search through edge function with userId
      searchHubSpotTicketsViaEdgeFunction(request.searchTerm, request.contactId, userId)
        .then(result => {
          console.log('[Background] ✅ HubSpot ticket search completed!');
          console.log('[Background] Result:', JSON.stringify(result, null, 2));
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          console.error('[Background] ❌ HubSpot ticket search failed!');
          console.error('[Background] Error message:', error.message);
          sendResponse({ success: false, error: error.message });
        });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'createHubSpotTicket') {
    console.log('[Background] ===== CREATE TICKET REQUEST RECEIVED =====');

    // Get userId and accessToken from storage for logging
    chrome.storage.local.get(['userId', 'accessToken', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      const accessToken = storageData.accessToken || null;
      const userLoggedIn = storageData.userLoggedIn || false;
      
      console.log('[Background] ===== STORAGE DATA FOR TICKET LOGGING =====');
      console.log('[Background] User Logged In:', userLoggedIn);
      console.log('[Background] User ID:', userId);
      console.log('[Background] Access Token:', accessToken ? 'present' : 'missing');
      console.log('[Background] ===========================================');
      
      // Route ticket creation through edge function
      createHubSpotTicketViaEdgeFunction(request.ticketData, userId, accessToken, request.contactId)
        .then(result => {
          console.log('[Background] ✅ HubSpot ticket created successfully!');
          console.log('[Background] Result:', JSON.stringify(result, null, 2));
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          console.error('[Background] ❌ HubSpot create ticket failed!');
          console.error('[Background] Error message:', error.message);
          console.error('[Background] Error stack:', error.stack);
          sendResponse({ success: false, error: error.message });
        });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'createHubSpotNote') {
    console.log('[Background] ===== CREATE NOTE REQUEST RECEIVED =====');
    console.log('[Background] Contact ID:', request.data?.contactId);
    console.log('[Background] Note text length:', request.data?.noteText?.length || 0);
    console.log('[Background] Has timestamp:', !!request.data?.timestamp);
    console.log('[Background] Create todo:', request.data?.createTodo || false);
    console.log('[Background] ===========================================');
    
    // Get userId and accessToken from storage for logging
    chrome.storage.local.get(['userId', 'accessToken', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      const accessToken = storageData.accessToken || null;
      const userLoggedIn = storageData.userLoggedIn || false;
      
      console.log('[Background] ===== STORAGE DATA FOR NOTE LOGGING =====');
      console.log('[Background] User Logged In:', userLoggedIn);
      console.log('[Background] User ID:', userId);
      console.log('[Background] Access Token:', accessToken ? 'present' : 'missing');
      console.log('[Background] ===========================================');
      
      // Route note creation through edge function
      createHubSpotNoteViaEdgeFunction(request.data, userId, accessToken)
        .then(result => {
          console.log('[Background] ✅ HubSpot note created successfully!');
          console.log('[Background] Result:', JSON.stringify(result, null, 2));
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          console.error('[Background] ❌ HubSpot create note failed!');
          console.error('[Background] Error message:', error.message);
          console.error('[Background] Error stack:', error.stack);
          sendResponse({ success: false, error: error.message });
        });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'getHubSpotDeals') {
    const contactId = request.contactId || null;
    console.log('[Background] getHubSpotDeals request for contact:', contactId);
    
    // Get userId and accessToken from storage
    chrome.storage.local.get(['userId', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      // Session token may live in external_auth_session rather than accessToken.
      const accessToken = await getStoredAccessToken();

      if (!userId || !accessToken) {
        sendResponse({ success: false, error: 'Not authenticated' });
        return;
      }

      try {
        getHubSpotDealsViaEdgeFunction(contactId, userId, accessToken)
          .then(data => {
            sendResponse({ success: true, data });
          })
          .catch(error => {
            console.error('[Background] Error in getHubSpotDeals:', error);
            sendResponse({ success: false, error: error.message });
          });
      } catch (error) {
        console.error('[Background] Error handling getHubSpotDeals:', error);
        sendResponse({ success: false, error: error.message });
      }
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'getHubSpotOwners') {
    console.log('[Background] getHubSpotOwners request');
    
    // Get userId and accessToken from storage
    chrome.storage.local.get(['userId', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      // Session token may live in external_auth_session rather than accessToken.
      const accessToken = await getStoredAccessToken();

      if (!userId || !accessToken) {
        sendResponse({ success: false, error: 'Not authenticated' });
        return;
      }

      try {
        getHubSpotOwnersViaEdgeFunction(userId, accessToken)
          .then(data => {
            sendResponse({ success: true, data });
          })
          .catch(error => {
            console.error('[Background] Error in getHubSpotOwners:', error);
            sendResponse({ success: false, error: error.message });
          });
      } catch (error) {
        console.error('[Background] Error handling getHubSpotOwners:', error);
        sendResponse({ success: false, error: error.message });
      }
    });
    
    return true; // Keep channel open for async response
  }

  // Log a WhatsApp conversation as HubSpot's native WhatsApp communication
  // (the edge function falls back to a note when the portal refuses).
  if (request.action === 'logHubSpotWhatsAppMessage') {
    (async () => {
      try {
        const { contactId, body, createTodo, followUpType, followUpDate } = request.data || {};
        const result = await callHubSpotEdgeFunction('logWhatsAppMessage', {
          contactId, body, createTodo, followUpType, followUpDate,
        });
        sendResponse({ success: true, loggedAs: result?.loggedAs || 'whatsapp', data: result?.data });
      } catch (error) {
        console.error('[Background] logWhatsAppMessage failed:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Keep channel open for async response
  }

  // Fetch enumeration options for a single property of any object type
  // (contacts/lifecyclestage, contacts/hs_lead_status, deals/dealstage, ...).
  if (request.action === 'getContactPropertyOptions' || request.action === 'getPropertyOptions') {
    const property = request.property || request.data?.property || null;
    const objectType = request.objectType || request.data?.objectType || 'contacts';
    (async () => {
      try {
        if (!property) {
          sendResponse({ success: false, error: 'Missing property', options: [] });
          return;
        }
        const result = await callHubSpotEdgeFunction('getPropertyOptions', { property, objectType });
        sendResponse({ success: true, options: result?.options || [] });
      } catch (error) {
        console.error('[Background] getPropertyOptions failed:', error);
        sendResponse({ success: false, error: error.message, options: [] });
      }
    })();
    return true; // Keep channel open for async response
  }

  // Patch a contact's properties (inline edits from the sidebar, e.g. lifecycle/lead status).
  if (request.action === 'updateContact') {
    const contactId = request.contactId || request.data?.contactId || null;
    const properties = request.properties || request.data?.properties || null;
    (async () => {
      try {
        if (!contactId || !properties) {
          sendResponse({ success: false, error: 'Missing contactId or properties' });
          return;
        }
        const result = await callHubSpotEdgeFunction('updateContact', { contactId, properties });
        sendResponse({ success: true, data: result });
      } catch (error) {
        console.error('[Background] updateContact failed:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Keep channel open for async response
  }

  // Recent activity timeline (notes/tickets/tasks/deals logged through the extension).
  if (request.action === 'getRecentActivities') {
    const contactId = request.contactId || request.data?.contactId || null;
    const limit = request.limit || request.data?.limit || 15;
    (async () => {
      try {
        const result = await callHubSpotEdgeFunction('getRecentActivities', { contactId, limit });
        sendResponse({ success: true, activities: result?.activities || [] });
      } catch (error) {
        console.error('[Background] getRecentActivities failed:', error);
        sendResponse({ success: false, error: error.message, activities: [] });
      }
    })();
    return true; // Keep channel open for async response
  }

  // Resolve a single HubSpot owner's name by id (for owners missing from the active list).
  if (request.action === 'getOwnerById') {
    const ownerId = request.ownerId || request.data?.ownerId || null;
    (async () => {
      try {
        if (!ownerId) { sendResponse({ success: false, owner: null }); return; }
        const result = await callHubSpotEdgeFunction('getOwnerById', { ownerId });
        sendResponse({ success: true, owner: result?.owner || null });
      } catch (error) {
        console.error('[Background] getOwnerById failed:', error);
        sendResponse({ success: false, error: error.message, owner: null });
      }
    })();
    return true;
  }

  // Open the extension popup (sign-in UI) from the sidebar's "Sign in" button.
  if (request.action === 'openPopup') {
    try {
      if (chrome.action && typeof chrome.action.openPopup === 'function') {
        chrome.action.openPopup().catch(() => {});
      }
    } catch (e) {
      console.warn('[Background] openPopup not available:', e);
    }
    sendResponse({ success: true });
    return true;
  }

  // Real HubSpot engagement timeline for a contact (notes/calls/emails/meetings/tasks).
  if (request.action === 'getContactActivities') {
    const contactId = request.contactId || request.data?.contactId || null;
    const limit = request.limit || request.data?.limit || 20;
    (async () => {
      try {
        if (!contactId) {
          sendResponse({ success: true, activities: [] });
          return;
        }
        const result = await callHubSpotEdgeFunction('getContactActivities', { contactId, limit });
        sendResponse({ success: true, activities: result?.activities || [] });
      } catch (error) {
        console.error('[Background] getContactActivities failed:', error);
        sendResponse({ success: false, error: error.message, activities: [] });
      }
    })();
    return true; // Keep channel open for async response
  }

  if (request.action === 'getDealPipelines') {
    chrome.storage.local.get(['userId'], async (storageData) => {
      const userId = storageData.userId || null;
      if (!userId) {
        sendResponse({ success: false, error: 'Not authenticated', pipelines: [] });
        return;
      }
      try {
        const result = await callHubSpotOAuthEdgeFunction('getDealPipelines', { userId });
        sendResponse({
          success: true,
          pipelines: result?.pipelines || [],
          warning: result?.warning,
        });
      } catch (error) {
        console.error('[Background] getDealPipelines failed:', error);
        // Fallback: the hubspot edge function can also serve pipelines directly.
        try {
          const result = await callHubSpotEdgeFunction('getPipelines', { objectType: 'deals' });
          sendResponse({ success: true, pipelines: result?.pipelines || [] });
        } catch (fallbackError) {
          sendResponse({ success: false, error: fallbackError.message, pipelines: [] });
        }
      }
    });
    return true;
  }

  // Ticket pipelines + stages, so the create-ticket form shows the portal's real
  // pipelines instead of hard-coded guesses.
  if (request.action === 'getTicketPipelines') {
    (async () => {
      try {
        const result = await callHubSpotEdgeFunction('getPipelines', { objectType: 'tickets' });
        sendResponse({ success: true, pipelines: result?.pipelines || [] });
      } catch (error) {
        console.error('[Background] getTicketPipelines failed:', error);
        sendResponse({ success: false, error: error.message, pipelines: [] });
      }
    })();
    return true;
  }

  // Create a deal (routed through the authenticated edge call — a raw fetch from
  // the content script used to go out with no auth headers and always failed).
  if (request.action === 'createHubSpotDeal') {
    (async () => {
      try {
        const result = await callHubSpotEdgeFunction('createDeal', request.data || {});
        sendResponse({ success: true, data: result });
      } catch (error) {
        console.error('[Background] createHubSpotDeal failed:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'associateDealsWithContact' || request.action === 'disassociateDealsFromContact') {
    (async () => {
      try {
        const edgeAction = request.action === 'associateDealsWithContact' ? 'associateDeals' : 'disassociateDeals';
        const result = await callHubSpotEdgeFunction(edgeAction, {
          contactId: request.contactId,
          dealIds: request.dealIds,
        });
        sendResponse({ success: true, data: result });
      } catch (error) {
        console.error(`[Background] ${request.action} failed:`, error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  
  if (request.action === 'getHubSpotTasks') {
    const contactId = request.contactId || null;
    console.log('[Background] getHubSpotTasks request for contact:', contactId);
    
    // Get userId and accessToken from storage
    chrome.storage.local.get(['userId', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      // Session token may live in external_auth_session rather than accessToken.
      const accessToken = await getStoredAccessToken();

      if (!userId || !accessToken) {
        sendResponse({ success: false, error: 'Not authenticated' });
        return;
      }

      try {
        getHubSpotTasksViaEdgeFunction(contactId, userId, accessToken)
          .then(data => {
            sendResponse({ success: true, data });
          })
          .catch(error => {
            console.error('[Background] Error in getHubSpotTasks:', error);
            sendResponse({ success: false, error: error.message });
          });
      } catch (error) {
        console.error('[Background] Error handling getHubSpotTasks:', error);
        sendResponse({ success: false, error: error.message });
      }
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'createHubSpotTask') {
    console.log('[Background] ===== CREATE TASK REQUEST RECEIVED =====');

    // Get userId and accessToken from storage for logging (if needed)
    chrome.storage.local.get(['userId', 'accessToken', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      const accessToken = storageData.accessToken || null;
      const userLoggedIn = storageData.userLoggedIn || false;
      
      console.log('[Background] ===== STORAGE DATA FOR TASK LOGGING =====');
      console.log('[Background] User Logged In:', userLoggedIn);
      console.log('[Background] User ID:', userId);
      console.log('[Background] Access Token:', accessToken ? 'present' : 'missing');
      console.log('[Background] ===========================================');
      
      // Route task creation through edge function
      createHubSpotTaskViaEdgeFunction(request.data, userId, accessToken)
        .then(result => {
          console.log('[Background] ✅ HubSpot task created successfully!');
          console.log('[Background] Result:', JSON.stringify(result, null, 2));
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          console.error('[Background] ❌ HubSpot create task failed!');
          console.error('[Background] Error message:', error.message);
          console.error('[Background] Error stack:', error.stack);
          sendResponse({ success: false, error: error.message });
        });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'logDealCreation') {
    console.log('[Background] ===== LOG DEAL CREATION REQUEST RECEIVED =====');

    // Get userId and accessToken from storage
    chrome.storage.local.get(['userId', 'accessToken', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      const accessToken = storageData.accessToken || null;

      console.log('[Background] User ID:', userId);
      console.log('[Background] Access Token:', accessToken ? 'present' : 'missing');
      
      if (!userId) {
        console.warn('[Background] No userId found, cannot log deal creation');
        sendResponse({ success: false, error: 'No userId found' });
        return;
      }
      
      // Log deal creation to Supabase
      logDealCreationToSupabase(userId, accessToken, request.data)
        .then(result => {
          console.log('[Background] ✅ Deal creation logged successfully!');
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          console.error('[Background] ❌ Failed to log deal creation:', error);
          sendResponse({ success: false, error: error.message });
        });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'getAllHubSpotTickets') {
    console.log('[Background] Received get all HubSpot tickets request');
    console.log('[Background] Contact ID:', request.contactId);
    
    // Get userId from storage (required for edge function to query external database)
    chrome.storage.local.get(['userId', 'accessToken', 'userLoggedIn'], async (storageData) => {
      const userId = storageData.userId || null;
      const accessToken = storageData.accessToken || null;
      const userLoggedIn = storageData.userLoggedIn || false;
      
      console.log('[Background] User Logged In:', userLoggedIn);
      console.log('[Background] User ID:', userId);
      console.log('[Background] Access Token:', accessToken ? 'present' : 'missing');
      
      if (!userId) {
        sendResponse({ success: false, error: 'Not authenticated - userId required' });
        return;
      }
      
      // Route ticket fetching through edge function (get all tickets, not just associated) with userId
      getAllHubSpotTicketsViaEdgeFunction(request.contactId, userId)
        .then(result => {
          console.log('[Background] ✅ All HubSpot tickets fetched successfully!');
          console.log('[Background] Result:', JSON.stringify(result, null, 2));
          sendResponse({ success: true, data: result });
        })
        .catch(error => {
          console.error('[Background] ❌ HubSpot get all tickets failed!');
          console.error('[Background] Error message:', error.message);
          sendResponse({ success: false, error: error.message });
        });
    });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'associateTicketsWithContact') {
    console.log('[Background] Received associate tickets request');
    console.log('[Background] Contact ID:', request.contactId);
    console.log('[Background] Ticket IDs:', request.ticketIds);
    
    // Route ticket association through edge function
    associateTicketsWithContactViaEdgeFunction(request.contactId, request.ticketIds)
      .then(result => {
        console.log('[Background] ✅ Tickets associated successfully!');
        sendResponse({ success: true, data: result });
      })
      .catch(error => {
        console.error('[Background] ❌ Ticket association failed!');
        console.error('[Background] Error message:', error.message);
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'disassociateTicketsFromContact') {
    console.log('[Background] Received disassociate tickets request');
    console.log('[Background] Contact ID:', request.contactId);
    console.log('[Background] Ticket IDs:', request.ticketIds);
    
    // Route ticket disassociation through edge function
    disassociateTicketsFromContactViaEdgeFunction(request.contactId, request.ticketIds)
      .then(result => {
        console.log('[Background] ✅ Tickets disassociated successfully!');
        sendResponse({ success: true, data: result });
      })
      .catch(error => {
        console.error('[Background] ❌ Ticket disassociation failed!');
        console.error('[Background] Error message:', error.message);
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep channel open for async response
  }
});

// Function to get tickets from HubSpot via edge function
async function getHubSpotTicketsViaEdgeFunction(contactId, userId) {
  console.log('[Background] ===== GET TICKETS VIA EDGE FUNCTION =====');
  console.log('[Background] Contact ID:', contactId, '(null means fetch ALL tickets)');
  console.log('[Background] User ID:', userId);
  
  if (!userId) {
    console.error('[Background] ❌ userId is required for getTickets');
    throw new Error('userId is required to query external database for logged tickets');
  }
  
  try {
    // Call edge function to get tickets
    // Edge function should have getTickets action that fetches tickets
    // If contactId is null, the edge function should return ALL tickets
    const params = contactId === null || contactId === undefined 
      ? { fetchAll: true, userId: userId } // Don't pass contactId when we want all tickets, but include userId
      : { contactId: contactId, userId: userId };
    
    console.log('[Background] Calling edge function with params:', params);
    const result = await callHubSpotEdgeFunction('getTickets', params);
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result type:', typeof result);
    console.log('[Background] Result keys:', result ? Object.keys(result) : 'null/undefined');
    
    // Extract tickets from response
    // HubSpot CRM v3 API returns { results: [...] }
    const tickets = result?.results || result?.data || (Array.isArray(result) ? result : []);
    console.log('[Background] Extracted tickets:', tickets.length);
    return tickets;
  } catch (error) {
    console.error('[Background] ❌ Error in getHubSpotTicketsViaEdgeFunction');
    console.error('[Background] Error message:', error.message);
    // Return empty array on error instead of throwing
    return [];
  }
}

// Function to search tickets in HubSpot via edge function
async function searchHubSpotTicketsViaEdgeFunction(searchTerm, contactId, userId) {
  console.log('[Background] ===== SEARCH TICKETS VIA EDGE FUNCTION =====');
  console.log('[Background] Search term:', searchTerm);
  console.log('[Background] Contact ID:', contactId, '(null means search ALL tickets)');
  console.log('[Background] User ID:', userId);
  
  if (!userId) {
    console.error('[Background] ❌ userId is required for searchTickets');
    throw new Error('userId is required to query external database for logged tickets');
  }
  
  try {
    // Call edge function to search tickets
    // Edge function should have searchTickets action that searches tickets by subject/content
    // If contactId is null and searchTerm is empty, we want ALL tickets
    const result = await callHubSpotEdgeFunction('searchTickets', { 
      searchTerm: searchTerm,
      contactId: contactId,
      userId: userId,
      fetchAll: (contactId === null || contactId === undefined) && (!searchTerm || searchTerm.trim() === '')
    });
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result:', JSON.stringify(result, null, 2));
    
    // Extract tickets from response
    // HubSpot CRM v3 API returns { results: [...] }
    const tickets = result?.results || result?.data || (Array.isArray(result) ? result : []);
    console.log('[Background] Extracted tickets:', tickets.length);
    return tickets;
  } catch (error) {
    console.error('[Background] ❌ Error in searchHubSpotTicketsViaEdgeFunction');
    console.error('[Background] Error message:', error.message);
    // Return empty array on error instead of throwing
    return [];
  }
}

// Function to create ticket in HubSpot via edge function
async function createHubSpotTicketViaEdgeFunction(ticketData, userId, accessToken, contactId) {
  console.log('[Background] ===== CREATE TICKET VIA EDGE FUNCTION =====');
  console.log('[Background] Input ticketData:', JSON.stringify(ticketData, null, 2));
  
  try {
    // Call edge function to create ticket. contactId must ride along in the
    // payload — the edge function uses it to associate the ticket with the
    // contact (it used to be dropped here, leaving every ticket unassociated).
    const payload = contactId ? { ...ticketData, contactId: String(contactId) } : ticketData;
    const result = await callHubSpotEdgeFunction('createTicket', payload);
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result type:', typeof result);
    console.log('[Background] Result keys:', result ? Object.keys(result) : 'null/undefined');
    console.log('[Background] Result:', JSON.stringify(result, null, 2));
    
    // Log to Supabase if userId and accessToken are provided
    if (userId && accessToken) {
      await logTicketCreationToSupabase(userId, accessToken, ticketData, result, contactId);
    } else {
      console.warn('[Background] Missing userId or accessToken, skipping Supabase log for ticket');
      console.warn('[Background] userId:', userId, 'accessToken:', accessToken ? 'present' : 'missing');
    }
    
    return result;
  } catch (error) {
    console.error('[Background] ❌ Error in createHubSpotTicketViaEdgeFunction');
    console.error('[Background] Error type:', error.constructor.name);
    console.error('[Background] Error message:', error.message);
    console.error('[Background] Error stack:', error.stack);
    if (error.response) {
      console.error('[Background] Error response:', error.response);
    }
    throw error;
  }
}

// Function to get all tickets from HubSpot via edge function (not just associated ones)
async function getAllHubSpotTicketsViaEdgeFunction(contactId, userId) {
  console.log('[Background] ===== GET ALL TICKETS VIA EDGE FUNCTION =====');
  console.log('[Background] Contact ID:', contactId, '(null means fetch ALL tickets)');
  console.log('[Background] User ID:', userId);
  
  if (!userId) {
    console.error('[Background] ❌ userId is required for getAllTickets/getTickets');
    throw new Error('userId is required to query external database for logged tickets');
  }
  
  try {
    // Use the same getTickets action but with fetchAll flag
    // If getAllTickets doesn't exist, fall back to getTickets with fetchAll
    const params = contactId === null || contactId === undefined 
      ? { fetchAll: true, userId: userId } // Don't pass contactId when we want all tickets, but include userId
      : { contactId: contactId, fetchAll: true, userId: userId };
    
    console.log('[Background] Calling edge function with params:', params);
    
    // Try getAllTickets first, fallback to getTickets
    let result;
    try {
      result = await callHubSpotEdgeFunction('getAllTickets', params);
    } catch (error) {
      console.log('[Background] getAllTickets not available, using getTickets with fetchAll');
      result = await callHubSpotEdgeFunction('getTickets', params);
    }
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result type:', typeof result);
    
    // Extract tickets from response
    const tickets = result?.results || result?.data || (Array.isArray(result) ? result : []);
    console.log('[Background] Extracted tickets:', tickets.length);
    return tickets;
  } catch (error) {
    console.error('[Background] ❌ Error in getAllHubSpotTicketsViaEdgeFunction');
    console.error('[Background] Error message:', error.message);
    // Return empty array on error instead of throwing
    return [];
  }
}

// Function to associate tickets with contact via edge function
async function associateTicketsWithContactViaEdgeFunction(contactId, ticketIds) {
  console.log('[Background] ===== ASSOCIATE TICKETS VIA EDGE FUNCTION =====');
  console.log('[Background] Contact ID:', contactId);
  console.log('[Background] Ticket IDs:', ticketIds);
  
  try {
    // Call edge function to associate tickets
    const result = await callHubSpotEdgeFunction('associateTickets', {
      contactId: contactId,
      ticketIds: ticketIds
    });
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result:', JSON.stringify(result, null, 2));
    
    return result;
  } catch (error) {
    console.error('[Background] ❌ Error in associateTicketsWithContactViaEdgeFunction');
    console.error('[Background] Error message:', error.message);
    throw error;
  }
}

// Function to disassociate tickets from contact via edge function
async function disassociateTicketsFromContactViaEdgeFunction(contactId, ticketIds) {
  console.log('[Background] ===== DISASSOCIATE TICKETS VIA EDGE FUNCTION =====');
  console.log('[Background] Contact ID:', contactId);
  console.log('[Background] Ticket IDs:', ticketIds);
  
  try {
    // Call edge function to disassociate tickets
    const result = await callHubSpotEdgeFunction('disassociateTickets', {
      contactId: contactId,
      ticketIds: ticketIds
    });
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result:', JSON.stringify(result, null, 2));
    
    return result;
  } catch (error) {
    console.error('[Background] ❌ Error in disassociateTicketsFromContactViaEdgeFunction');
    console.error('[Background] Error message:', error.message);
    throw error;
  }
}

// Function to get tasks from Supabase via edge function
// Function to get deals from HubSpot via edge function
async function getHubSpotDealsViaEdgeFunction(contactId, userId, accessToken) {
  console.log('[Background] ===== GET DEALS VIA EDGE FUNCTION =====');
  console.log('[Background] Contact ID:', contactId, '(type:', typeof contactId, ')');
  console.log('[Background] User ID:', userId);
  
  if (!contactId) {
    console.warn('[Background] No contact ID provided, returning empty array');
    return [];
  }
  
  try {
    // Ensure contactId is a string for consistency
    const contactIdStr = String(contactId);
    console.log('[Background] Calling edge function with contactId:', contactIdStr);
    
    // Call edge function to get deals associated with this contact
    // The edge function should filter deals by contact association
    const result = await callHubSpotEdgeFunction('getDeals', { 
      contactId: contactIdStr 
    });
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result type:', typeof result);
    console.log('[Background] Result keys:', result ? Object.keys(result) : 'null/undefined');
    
    // Extract deals from response
    let deals = result?.results || result?.data || (Array.isArray(result) ? result : []);
    console.log('[Background] Result count:', deals.length);
    
    // The edge function returns deals already scoped to this contact (via the
    // contact -> deals association lookup), so trust them. Only apply a secondary
    // association check when the deals actually carry association data; otherwise we
    // would wrongly drop every deal, since batch-read deals don't include reverse
    // contact associations. (That over-filtering was the cause of deals showing 0.)
    if (Array.isArray(deals) && deals.length > 0) {
      const dealsWithAssoc = deals.filter(
        (d) => d?.associations?.contacts?.results || d?.associations?.contact?.results
      );
      if (dealsWithAssoc.length > 0) {
        const filteredDeals = deals.filter((deal) => {
          const contactAssociations =
            deal?.associations?.contacts?.results || deal?.associations?.contact?.results || [];
          return contactAssociations.some(
            (assoc) => String(assoc?.id || assoc?.toObjectId || '') === contactIdStr
          );
        });
        // Only narrow if it didn't nuke everything the server already scoped.
        if (filteredDeals.length > 0) {
          deals = filteredDeals;
        }
      }
      console.log('[Background] Deals belonging to contact', contactIdStr, ':', deals.length);
    }
    
    console.log('[Background] Extracted deals:', deals.length);
    return deals;
  } catch (error) {
    console.error('[Background] ❌ Error in getHubSpotDealsViaEdgeFunction');
    console.error('[Background] Error message:', error.message);
    console.error('[Background] Error stack:', error.stack);
    // Return empty array on error instead of throwing
    return [];
  }
}

async function getHubSpotTasksViaEdgeFunction(contactId, userId, accessToken) {
  console.log('[Background] ===== GET TASKS VIA EDGE FUNCTION =====');
  console.log('[Background] Contact ID:', contactId);
  console.log('[Background] User ID:', userId);
  
  try {
    // Call edge function to get tasks from Supabase
    // Action: 'getContactTasks' with { userId, hubspotContactId }
    const result = await callHubSpotEdgeFunction('getContactTasks', {
      userId: userId,
      hubspotContactId: contactId ? String(contactId) : null
    });
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result count:', result ? result.length : 0);
    
    return result || [];
  } catch (error) {
    console.error('[Background] ❌ Error in getHubSpotTasksViaEdgeFunction');
    console.error('[Background] Error message:', error.message);
    throw error;
  }
}

async function getHubSpotOwnersViaEdgeFunction(userId, accessToken) {
  console.log('[Background] ===== GET OWNERS VIA EDGE FUNCTION =====');
  console.log('[Background] User ID:', userId);
  
  try {
    // Call edge function to get owners from HubSpot
    // Action: 'getOwners' 
    const result = await callHubSpotEdgeFunction('getOwners', {});
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result type:', typeof result);
    console.log('[Background] Result keys:', result ? Object.keys(result) : 'null/undefined');
    
    // Extract owners from response
    let owners = result?.results || result?.data || (Array.isArray(result) ? result : []);
    console.log('[Background] Owners count:', owners.length);
    
    if (owners.length > 0) {
      console.log('[Background] Sample owner data:', owners.slice(0, 2).map(o => ({
        id: o.id,
        email: o.email,
        firstName: o.firstName,
        lastName: o.lastName
      })));
    }
    
    return owners;
  } catch (error) {
    console.error('[Background] ❌ Error in getHubSpotOwnersViaEdgeFunction');
    console.error('[Background] Error message:', error.message);
    console.error('[Background] Error stack:', error.stack);
    // Return empty array on error instead of throwing
    return [];
  }
}

// Function to create task in HubSpot via edge function
async function createHubSpotTaskViaEdgeFunction(taskData, userId, accessToken) {
  console.log('[Background] ===== CREATE TASK VIA EDGE FUNCTION =====');
  console.log('[Background] Input taskData:', JSON.stringify(taskData, null, 2));
  
  try {
    // Call edge function to create task
    // The edge function should handle both CRM v3 properties format and simple flat format
    const result = await callHubSpotEdgeFunction('createTask', taskData);
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result type:', typeof result);
    console.log('[Background] Result keys:', result ? Object.keys(result) : 'null/undefined');
    console.log('[Background] Result:', JSON.stringify(result, null, 2));
    
    // Log to Supabase if userId and accessToken are provided (optional, similar to tickets)
    if (userId && accessToken) {
      // Extract contactId from taskData if available
      // It can be in taskData.contactId (from content.js) or in associations
      const contactId = taskData?.contactId || 
                       taskData?.associations?.contact?.results?.[0]?.id ||
                       taskData?.associations?.contacts?.results?.[0]?.id ||
                       null;
      await logTaskCreationToSupabase(userId, accessToken, taskData, result, contactId);
    } else {
      console.warn('[Background] Missing userId or accessToken, skipping Supabase log for task');
      console.warn('[Background] userId:', userId, 'accessToken:', accessToken ? 'present' : 'missing');
    }
    
    return result;
  } catch (error) {
    console.error('[Background] ❌ Error in createHubSpotTaskViaEdgeFunction');
    console.error('[Background] Error type:', error.constructor.name);
    console.error('[Background] Error message:', error.message);
    console.error('[Background] Error stack:', error.stack);
    if (error.response) {
      console.error('[Background] Error response:', error.response);
    }
    throw error;
  }
}

// Function to create note in HubSpot via edge function
async function createHubSpotNoteViaEdgeFunction(noteData, userId, accessToken) {
  console.log('[Background] ===== CREATE NOTE VIA EDGE FUNCTION =====');
  console.log('[Background] Input noteData:', JSON.stringify(noteData, null, 2));
  
  const { contactId, noteText, noteHtml, createTodo, followUpType, followUpDate } = noteData;
  
  console.log('[Background] Extracted values:');
  console.log('[Background]   - contactId:', contactId, '(Type:', typeof contactId + ')');
  console.log('[Background]   - noteText:', noteText ? `"${noteText.substring(0, 50)}${noteText.length > 50 ? '...' : ''}" (${noteText.length} chars)` : 'undefined');
  console.log('[Background]   - noteHtml:', noteHtml ? `"${noteHtml.substring(0, 50)}${noteHtml.length > 50 ? '...' : ''}" (${noteHtml.length} chars)` : 'undefined');
  console.log('[Background]   - createTodo:', createTodo);
  
  // Validate required fields with detailed error messages
  if (!contactId) {
    console.error('[Background] ❌ Validation failed: Contact ID is missing');
    throw new Error('Contact ID is required');
  }
  
  if (contactId === 0 || contactId === '0') {
    console.error('[Background] ❌ Validation failed: Contact ID is zero');
    throw new Error('Contact ID cannot be zero');
  }
  
  if (!noteText || !noteText.trim()) {
    console.error('[Background] ❌ Validation failed: Note text is missing or empty');
    console.error('[Background]   - noteText value:', noteText);
    console.error('[Background]   - noteText length:', noteText?.length || 0);
    throw new Error('Note text is required and cannot be empty');
  }
  
  // Validate timestamp will be generated, but log if provided
  if (noteData.timestamp) {
    console.log('[Background]   - timestamp provided:', noteData.timestamp);
  }
  
  console.log('[Background] ✅ Validation passed');
  
  try {
    // Prepare note data for HubSpot API using engagements API format
    // Based on working example: /engagements/v1/engagements
    // 
    // IMPORTANT: The edge function MUST format this data as:
    // {
    //   engagement: { 
    //     active: true, 
    //     type: "NOTE", 
    //     timestamp: timestamp (milliseconds)
    //   },
    //   associations: { 
    //     contactIds: [contactId]  // Array with numeric contact ID
    //   },
    //   metadata: { 
    //     body: note  // The note text
    //   }
    // }
    // 
    // Endpoint: POST https://api.hubapi.com/engagements/v1/engagements
    // Headers: Authorization: Bearer {token}, Content-Type: application/json
    
    const timestamp = Date.now();
    
    // Ensure contactId is a number (HubSpot requires numeric ID, not string)
    const numericContactId = typeof contactId === 'string' ? parseInt(contactId, 10) : Number(contactId);
    
    if (isNaN(numericContactId) || numericContactId <= 0) {
      console.error('[Background] ❌ Invalid contact ID format:', contactId, 'Parsed as:', numericContactId);
      throw new Error(`Invalid contact ID: must be a positive numeric value, got: ${contactId}`);
    }
    
    // Send data with multiple field name options for compatibility
    // Edge function might expect: 'note', 'noteBody', 'hs_note_body', or 'body'
    const trimmedNote = noteText.trim();
    
    const requestData = {
      contactId: numericContactId, // HubSpot numeric contact ID (as number, not string)
      // Primary field name
      note: trimmedNote, // Note body text (used in metadata.body or properties.hs_note_body)
      // Alternative field names for edge function compatibility
      noteBody: trimmedNote, // Alternative name some edge functions expect
      body: trimmedNote, // Another common alternative
      // Timestamp
      timestamp: timestamp, // Timestamp in milliseconds (used in engagement.timestamp or properties.hs_timestamp)
      // Optional follow-up task (the note modal's "Create a ... task to follow up")
      createTodo: createTodo || false,
      followUpType: followUpType || null,   // 'To-do' | 'Call' | 'Email'
      followUpDate: followUpDate || null    // ISO date string for the task due date
    };
    
    console.log('[Background] Contact ID validation:');
    console.log('[Background]   - Original:', contactId, 'Type:', typeof contactId);
    console.log('[Background]   - Parsed:', numericContactId, 'Type:', typeof numericContactId);
    console.log('[Background]   - Is valid number:', !isNaN(numericContactId) && numericContactId > 0);
    
    console.log('[Background] Preparing request data for edge function...');
    console.log('[Background] ===== REQUEST DATA FOR EDGE FUNCTION =====');
    console.log('[Background] Contact ID:', requestData.contactId, '(Type:', typeof requestData.contactId + ')');
    console.log('[Background] Note text (note):', requestData.note);
    console.log('[Background] Note text (noteBody):', requestData.noteBody);
    console.log('[Background] Note text (body):', requestData.body);
    console.log('[Background] Note length:', requestData.note.length);
    console.log('[Background] Timestamp:', requestData.timestamp, '(Date:', new Date(requestData.timestamp).toISOString() + ')');
    console.log('[Background] Create todo:', requestData.createTodo);
    console.log('[Background] ===========================================');
    console.log('[Background]');
    console.log('[Background] 📋 FIELD NAME OPTIONS SENT (for edge function compatibility):');
    console.log('[Background]   - contactId:', requestData.contactId);
    console.log('[Background]   - note:', requestData.note, '(primary)');
    console.log('[Background]   - noteBody:', requestData.noteBody, '(alternative)');
    console.log('[Background]   - body:', requestData.body, '(alternative)');
    console.log('[Background]   - timestamp:', requestData.timestamp);
    console.log('[Background]');
    console.log('[Background]');
    console.log('[Background] ⚠️ EDGE FUNCTION MUST FORMAT AS:');
    console.log('[Background] ===========================================');
    console.log('[Background] ENDPOINT: POST https://api.hubapi.com/engagements/v1/engagements');
    console.log('[Background] HEADERS: Authorization: Bearer {HUBSPOT_TOKEN}');
    console.log('[Background]          Content-Type: application/json');
    console.log('[Background] ===========================================');
    console.log('[Background] REQUEST BODY:');
    console.log(JSON.stringify({
      engagement: {
        active: true,
        type: "NOTE",
        timestamp: requestData.timestamp
      },
      associations: {
        contactIds: [requestData.contactId]
      },
      metadata: {
        body: requestData.note
      }
    }, null, 2));
    console.log('[Background] ===========================================');
    console.log('[Background]');
    console.log('[Background] ⚠️ REQUIRED PROPERTIES CHECKLIST:');
    console.log('[Background]   ✅ engagement.active = true');
    console.log('[Background]   ✅ engagement.type = "NOTE" (must be exact string)');
    console.log('[Background]   ✅ engagement.timestamp =', requestData.timestamp, '(milliseconds)');
    console.log('[Background]   ✅ associations.contactIds = [' + requestData.contactId + '] (must be array)');

    console.log('[Background] Calling edge function: createNote...');
    console.log('[Background] Edge function endpoint:', HUBSPOT_TOKEN_ENDPOINT);
    console.log('[Background] Action:', 'createNote');
    
    const result = await callHubSpotEdgeFunction('createNote', requestData);
    
    console.log('[Background] ✅ Edge function call successful!');
    console.log('[Background] Result type:', typeof result);
    console.log('[Background] Result keys:', result ? Object.keys(result) : 'null/undefined');
    console.log('[Background] Result:', JSON.stringify(result, null, 2));
    
    // Log to Supabase - try to get userId and accessToken from storage if not provided
    let finalUserId = userId;
    let finalAccessToken = accessToken;
    
    if (!finalUserId || !finalAccessToken) {
      console.log('[Background] userId or accessToken not provided, attempting to get from storage...');
      try {
        const storageData = await new Promise((resolve) => {
          chrome.storage.local.get(['userId', 'accessToken'], resolve);
        });
        finalUserId = finalUserId || storageData.userId || null;
        finalAccessToken = finalAccessToken || storageData.accessToken || null;
        console.log('[Background] Retrieved from storage - userId:', finalUserId ? 'present' : 'missing', 'accessToken:', finalAccessToken ? 'present' : 'missing');
      } catch (error) {
        console.error('[Background] Error getting userId/accessToken from storage:', error);
      }
    }
    
    // Log to Supabase if userId and accessToken are available
    if (finalUserId && finalAccessToken) {
      console.log('[Background] Attempting to log note creation to Supabase...');
      try {
        await logNoteCreationToSupabase(finalUserId, finalAccessToken, noteData, requestData, result);
        console.log('[Background] ✅ Supabase logging completed');
      } catch (error) {
        console.error('[Background] ❌ Error during Supabase logging (non-fatal):', error);
        // Don't throw - logging failure shouldn't break the note creation
      }
    } else {
      console.warn('[Background] ⚠️ Missing userId or accessToken, skipping Supabase log for note');
      console.warn('[Background] userId:', finalUserId, 'accessToken:', finalAccessToken ? 'present' : 'missing');
      console.warn('[Background] Note: This is a warning, not an error. Note was still created in HubSpot.');
    }
    
    return result;
  } catch (error) {
    console.error('[Background] ❌ Error in createHubSpotNoteViaEdgeFunction');
    console.error('[Background] Error type:', error.constructor.name);
    console.error('[Background] Error message:', error.message);
    console.error('[Background] Error stack:', error.stack);
    if (error.response) {
      console.error('[Background] Error response:', error.response);
    }
    throw error;
  } finally {
    console.log('[Background] ===========================================');
  }
}

// Function to log note creation to Supabase via edge function
async function logNoteCreationToSupabase(userId, accessToken, noteData, requestData, hubspotNote) {
  if (!userId) {
    console.warn('[Background] No userId provided, skipping note log');
    return;
  }
  
  try {
    // Get contact ID from request data
    const contactId = requestData.contactId || noteData.contactId;
    
    // Initialize contact details with default values
    let firstName = null;
    let lastName = null;
    let contactPhone = null;
    let email = null;
    let company = null;
    let jobTitle = null;
    let contactName = 'Contact';
    
    // Fetch contact details to populate all columns
    try {
      if (contactId) {
        const contactData = {
          contactId: contactId,
          properties: ['firstname', 'lastname', 'phone', 'email', 'company', 'jobtitle']
        };
        const contactResult = await callHubSpotEdgeFunction('getContact', contactData);
        const contact = contactResult?.results?.[0] || contactResult?.data || contactResult;
        const properties = contact?.properties || {};
        
        firstName = properties.firstname || properties.first_name || null;
        lastName = properties.lastname || properties.last_name || null;
        contactPhone = properties.phone || null;
        email = properties.email || null;
        company = properties.company || null;
        jobTitle = properties.jobtitle || properties.job_title || null;
        
        // Build contact name for description
        const fullName = `${firstName || ''} ${lastName || ''}`.trim();
        contactName = fullName || 'Contact';
      }
    } catch (error) {
      console.warn('[Background] Could not fetch contact details for note log:', error);
      // Continue with default values
    }
    
    // Build description: "Note added to John Doe • +971xxxx"
    const descriptionParts = [`Note added to ${contactName}`];
    if (contactPhone) {
      // Format phone for display (e.g., "+971-50-569-7410" -> "+971xxxx")
      // Extract country code and mask the rest
      let phoneDisplay = contactPhone;
      const phoneMatch = contactPhone.match(/^(\+\d{1,4})/);
      if (phoneMatch) {
        // Show country code + xxxx (e.g., "+971xxxx")
        phoneDisplay = phoneMatch[1] + 'xxxx';
      } else {
        // Fallback: mask last 4 digits
        phoneDisplay = contactPhone.length > 4 
          ? contactPhone.substring(0, contactPhone.length - 4) + 'xxxx'
          : contactPhone;
      }
      descriptionParts.push(phoneDisplay);
    }
    const description = descriptionParts.join(' • ');
    
    // Extract note text and HTML
    const noteText = requestData.note || requestData.body || noteData.noteText || '';
    const noteHtml = noteData.noteHtml || null;
    
    // Extract note ID from HubSpot response (check data.id first as per user's format: noteResponse.data.id)
    const noteId = hubspotNote?.data?.id ||
                   hubspotNote?.engagement?.id || 
                   hubspotNote?.id || 
                   hubspotNote?.data?.engagement?.id ||
                   null;
    
    console.log('[Background] ===== LOGGING NOTE TO SUPABASE VIA EDGE FUNCTION =====');
    console.log('[Background] Edge function URL:', HUBSPOT_TOKEN_ENDPOINT);
    console.log('[Background] User ID:', userId);
    console.log('[Background] Contact ID:', contactId);
    console.log('[Background] Note ID:', noteId);
    
    // Route through callHubSpotEdgeFunction so the request carries the same
    // auth headers (apikey + JWT), timeout, and refresh-retry as every other
    // edge call. A raw fetch here used to go out unauthenticated.
    await callHubSpotEdgeFunction('logNoteCreation', {
      userId: userId,
      hubspotContactId: contactId ? String(contactId) : null,
      phoneNumber: contactPhone,
      firstName: firstName,
      lastName: lastName,
      email: email,
      company: company,
      jobTitle: jobTitle,
      noteId: noteId,
      noteText: noteText,
      noteHtml: noteHtml,
      associations: { contactIds: [contactId] },
      rawNoteResponse: hubspotNote,
      rawNoteData: noteData
    });
    console.log('[Background] ✅ Note creation logged to Supabase successfully via edge function');
  } catch (error) {
    console.error('[Background] ❌ Failed to log note to Supabase (non-fatal — note was still created in HubSpot):', error.message);
    // Don't throw - logging failure shouldn't break the note creation
  }
}

// Function to log contact creation to external activity table (via hubspot edge function)
async function logContactCreationToSupabase(userId, accessToken, contactData, hubspotContact, syncSettings = null) {
  if (!userId) {
    console.warn('[Background] No userId provided, skipping log');
    return;
  }

  try {
    const settings = syncSettings || await getSyncSettingsForUser(userId);
    const shouldMaskPhone = settings?.mask_phone_numbers !== false;

    const hubspotContactId = hubspotContact?.id || hubspotContact?.properties?.id || hubspotContact?.objectId || null;
    const properties = hubspotContact?.properties || contactData?.properties || {};

    const firstName = properties.firstname || properties.first_name || null;
    const lastName = properties.lastname || properties.last_name || null;
    const fullName = `${firstName || ''} ${lastName || ''}`.trim() || 'Unknown Contact';
    const email = properties.email || null;
    let phone = properties.phone || properties.mobilephone || contactData?.properties?.phone || null;
    const company = properties.company || null;
    const jobTitle = properties.jobtitle || properties.job_title || null;

    const phoneForLog = shouldMaskPhone && phone ? maskPhoneForActivityLog(phone) : phone;

    const descriptionParts = [];
    if (fullName !== 'Unknown Contact') descriptionParts.push(fullName);
    if (email) descriptionParts.push(email);
    if (phoneForLog) descriptionParts.push(phoneForLog);
    const description = descriptionParts.length > 0
      ? descriptionParts.join(' • ')
      : 'Contact created in HubSpot';

    const logData = {
      userId,
      hubspotContactId: hubspotContactId ? String(hubspotContactId) : null,
      phoneNumber: phoneForLog,
      firstName,
      lastName,
      email,
      company,
      jobTitle,
      title: 'Contact created',
      description,
      metadata: {
        phone_number: phoneForLog,
        first_name: firstName,
        last_name: lastName,
        email,
        company,
        job_title: jobTitle,
        raw_contact: hubspotContact || null,
        raw_contact_data: contactData || null,
        phone_masked: shouldMaskPhone,
      },
    };

    console.log('[Background] Logging contact creation via edge function:', logData);
    const result = await callHubSpotEdgeFunction('logContactCreation', logData);
    console.log('[Background] ✅ Contact creation logged successfully via edge function:', result);
    return result;
  } catch (error) {
    console.error('[Background] Error logging contact creation:', error);
  }
}

// Helper function to refresh access token using refresh token
let refreshInFlight = null;

async function refreshAccessToken(refreshToken) {
  // Collapse concurrent refreshes into a single in-flight request. Supabase
  // rotates refresh tokens, so two parallel refreshes reusing the same token
  // make the second fail with "refresh_token_already_used". Single-flight (plus
  // re-reading the freshest token below) prevents that race between the startup
  // check, the periodic alarm, and on-demand 401 retries.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshAccessToken(refreshToken).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function doRefreshAccessToken(refreshTokenArg) {
  try {
    // Always refresh with the freshest stored token; the caller may have
    // captured an older one before another path rotated it.
    const latest = await getStoredRefreshToken();
    const refreshToken = latest || refreshTokenArg;
    if (!refreshToken) return null;

    console.log('[Background] Attempting to refresh access token...');
    const response = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        refresh_token: refreshToken
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      // The refresh token was already rotated (commonly by the dashboard tab or
      // another worker wake-up). If storage already holds a still-valid access
      // token, adopt it instead of failing — avoids a needless sign-out.
      if (response.status === 400 && /already.used|invalid.refresh.token/i.test(errorText)) {
        const { accessToken: stored } = await chrome.storage.local.get(['accessToken']);
        const expMs = stored ? getJwtExpMs(stored) : 0;
        if (stored && expMs && expMs - Date.now() > SESSION_CONFIG.refreshLeewayMs) {
          console.log('[Background] Refresh token already rotated; using current valid token from storage.');
          return stored;
        }
      }
      console.error('[Background] Failed to refresh token:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    const newAccessToken = data.access_token;
    const newRefreshToken = data.refresh_token || refreshToken; // Use new refresh token if provided

    // Update storage with new tokens. The content script reads its token from
    // external_auth_session, so that copy must be refreshed too.
    const { external_auth_session: existingSession } =
      await chrome.storage.local.get(['external_auth_session']);
    const updates = {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    };
    if (existingSession && typeof existingSession === 'object') {
      updates.external_auth_session = {
        ...existingSession,
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
        ...(existingSession.session && typeof existingSession.session === 'object'
          ? {
              session: {
                ...existingSession.session,
                access_token: newAccessToken,
                refresh_token: newRefreshToken,
              },
            }
          : {}),
      };
    }
    await chrome.storage.local.set(updates);

    console.log('[Background] ✅ Access token refreshed successfully');
    return newAccessToken;
  } catch (error) {
    console.error('[Background] Error refreshing access token:', error);
    return null;
  }
}

// Helper function to get fresh access token from storage or refresh if needed
async function getFreshAccessToken(userId, currentAccessToken) {
  try {
    // First, try to get the latest token from storage (in case it was refreshed)
    const storageData = await chrome.storage.local.get(['accessToken']);
    const storedToken = storageData.accessToken;
    const refreshToken = await getStoredRefreshToken();
    
    if (storedToken && storedToken !== currentAccessToken) {
      console.log('[Background] Found updated access token in storage');
      return storedToken;
    }
    
    // If we have a refresh token, try to refresh the access token
    if (refreshToken) {
      const refreshedToken = await refreshAccessToken(refreshToken);
      if (refreshedToken) {
        return refreshedToken;
      }
    }
    
    // Fallback to current token or stored token
    return currentAccessToken || storedToken;
  } catch (error) {
    console.warn('[Background] Error getting fresh token:', error);
    return currentAccessToken;
  }
}

// Function to log ticket creation to Supabase via edge function
async function logTicketCreationToSupabase(userId, accessToken, ticketData, hubspotTicket, contactId) {
  if (!userId) {
    console.warn('[Background] No userId provided, skipping ticket log');
    return;
  }
  
  try {
    // Extract ticket ID from HubSpot response
    // HubSpot CRM v3 API returns object with id
    const hubspotTicketId = hubspotTicket?.id || 
                           hubspotTicket?.results?.[0]?.id ||
                           hubspotTicket?.data?.id ||
                           hubspotTicket?.data?.results?.[0]?.id ||
                           null;
    
    // Get ticket subject/name
    const ticketSubject = hubspotTicket?.properties?.subject || 
                         ticketData?.properties?.subject || 
                         'Ticket created';
    
    // Initialize contact details with default values
    let firstName = null;
    let lastName = null;
    let contactPhone = null;
    let email = null;
    let company = null;
    let jobTitle = null;
    let contactName = 'Contact';
    
    // Fetch contact details to populate all columns
    try {
      if (contactId) {
        const contactData = {
          contactId: contactId,
          properties: ['firstname', 'lastname', 'phone', 'email', 'company', 'jobtitle']
        };
        const contactResult = await callHubSpotEdgeFunction('getContact', contactData);
        const contact = contactResult?.results?.[0] || contactResult?.data || contactResult;
        const properties = contact?.properties || {};
        
        firstName = properties.firstname || properties.first_name || null;
        lastName = properties.lastname || properties.last_name || null;
        contactPhone = properties.phone || null;
        email = properties.email || null;
        company = properties.company || null;
        jobTitle = properties.jobtitle || properties.job_title || null;
        
        // Build contact name for description
        const fullName = `${firstName || ''} ${lastName || ''}`.trim();
        contactName = fullName || 'Contact';
      }
    } catch (error) {
      console.warn('[Background] Could not fetch contact details for ticket log:', error);
      // Continue with default values
    }
    
    // Prepare data for edge function logTicketCreation action
    const logData = {
      userId: userId,
      hubspotContactId: contactId ? String(contactId) : null,
      phoneNumber: contactPhone,
      firstName: firstName,
      lastName: lastName,
      email: email,
      company: company,
      jobTitle: jobTitle,
      ticketId: hubspotTicketId ? String(hubspotTicketId) : null,
      ticketSubject: ticketSubject,
      ticketContent: ticketData?.properties?.content || null,
      ticketPriority: ticketData?.properties?.hs_ticket_priority || null,
      ticketStage: ticketData?.properties?.hs_pipeline_stage || null
    };
    
    console.log('[Background] Logging ticket creation via edge function:', logData);
    
    // Call edge function to log ticket creation (bypasses JWT auth)
    const result = await callHubSpotEdgeFunction('logTicketCreation', logData);
    
    console.log('[Background] ✅ Ticket creation logged to Supabase successfully via edge function');
    console.log('[Background] Log result:', result);
  } catch (error) {
    console.error('[Background] Error logging ticket to Supabase via edge function:', error);
    // Don't throw - logging failure shouldn't break the ticket creation
  }
}

// Function to log task creation to Supabase
async function logTaskCreationToSupabase(userId, accessToken, taskData, hubspotTask, contactId) {
  if (!userId) {
    console.warn('[Background] No userId provided, skipping task log');
    return;
  }
  
  try {
    // Extract task ID from HubSpot response
    // HubSpot CRM v3 API returns object with id
    const hubspotTaskId = hubspotTask?.id || 
                         hubspotTask?.results?.[0]?.id ||
                         hubspotTask?.data?.id ||
                         hubspotTask?.data?.results?.[0]?.id ||
                         null;
    
    // Get task subject/name
    const taskSubject = hubspotTask?.properties?.hs_task_subject || 
                       taskData?.properties?.hs_task_subject ||
                       taskData?.subject ||
                       taskData?.name ||
                       'Task created';
    
    // Get task body/notes
    const taskBody = hubspotTask?.properties?.hs_task_body ||
                    taskData?.properties?.hs_task_body ||
                    taskData?.notes ||
                    taskData?.body ||
                    null;
    
    // Get task due date
    const taskDueDate = hubspotTask?.properties?.hs_timestamp ||
                       taskData?.properties?.hs_timestamp ||
                       taskData?.dueDate ||
                       null;
    
    // Get task priority
    const taskPriority = hubspotTask?.properties?.hs_task_priority ||
                        taskData?.properties?.hs_task_priority ||
                        taskData?.priority ||
                        null;
    
    // Get task type
    const taskType = hubspotTask?.properties?.hs_task_type ||
                    taskData?.properties?.hs_task_type ||
                    taskData?.type ||
                    null;
    
    // Get assigned to
    const assignedTo = hubspotTask?.properties?.hubspot_owner_id ||
                      taskData?.properties?.hubspot_owner_id ||
                      taskData?.assignedTo ||
                      null;
    
    // Initialize contact details with default values
    let firstName = null;
    let lastName = null;
    let contactPhone = null;
    let email = null;
    let company = null;
    let jobTitle = null;
    let contactName = 'Contact';
    
    // Fetch contact details to populate all columns
    try {
      if (contactId) {
        const contactData = {
          contactId: contactId,
          properties: ['firstname', 'lastname', 'phone', 'email', 'company', 'jobtitle']
        };
        const contactResult = await callHubSpotEdgeFunction('getContact', contactData);
        const contact = contactResult?.results?.[0] || contactResult?.data || contactResult;
        const properties = contact?.properties || {};
        
        firstName = properties.firstname || properties.first_name || null;
        lastName = properties.lastname || properties.last_name || null;
        contactPhone = properties.phone || null;
        email = properties.email || null;
        company = properties.company || null;
        jobTitle = properties.jobtitle || properties.job_title || null;
        
        // Build contact name for description
        const fullName = `${firstName || ''} ${lastName || ''}`.trim();
        contactName = fullName || 'Contact';
      }
    } catch (error) {
      console.warn('[Background] Could not fetch contact details for task log:', error);
      // Continue with default values
    }
    
    // Prepare data for edge function logTaskCreation action
    const logData = {
      userId: userId,
      hubspotContactId: contactId ? String(contactId) : null,
      phoneNumber: contactPhone,
      firstName: firstName,
      lastName: lastName,
      email: email,
      company: company,
      jobTitle: jobTitle,
      taskId: hubspotTaskId ? String(hubspotTaskId) : null,
      taskSubject: taskSubject,
      taskBody: taskBody,
      taskDueDate: taskDueDate,
      taskPriority: taskPriority,
      taskType: taskType,
      assignedTo: assignedTo
    };
    
    console.log('[Background] Logging task creation via edge function:', logData);
    
    // Call edge function to log task creation (bypasses JWT auth)
    const result = await callHubSpotEdgeFunction('logTaskCreation', logData);
    
    console.log('[Background] ✅ Task creation logged to Supabase successfully via edge function');
    console.log('[Background] Log result:', result);
  } catch (error) {
    console.error('[Background] Error logging task to Supabase via edge function:', error);
    // Don't throw - logging failure shouldn't break the task creation
  }
}

// Function to log deal creation to Supabase
async function logDealCreationToSupabase(userId, accessToken, dealLogData) {
  if (!userId) {
    console.warn('[Background] No userId provided, skipping deal log');
    return;
  }
  
  try {
    // Extract deal ID
    const dealId = dealLogData?.dealId || null;
    
    // Get deal name
    const dealName = dealLogData?.dealName || 'Deal created';
    
    // Initialize contact details with default values
    let firstName = null;
    let lastName = null;
    let contactPhone = null;
    let email = null;
    let company = null;
    let jobTitle = null;
    let contactName = 'Contact';
    
    // Fetch contact details to populate all columns
    try {
      if (dealLogData?.hubspotContactId) {
        const contactData = {
          contactId: dealLogData.hubspotContactId,
          properties: ['firstname', 'lastname', 'phone', 'email', 'company', 'jobtitle']
        };
        const contactResult = await callHubSpotEdgeFunction('getContact', contactData);
        const contact = contactResult?.results?.[0] || contactResult?.data || contactResult;
        const properties = contact?.properties || {};
        
        firstName = properties.firstname || properties.first_name || null;
        lastName = properties.lastname || properties.last_name || null;
        contactPhone = properties.phone || null;
        email = properties.email || null;
        company = properties.company || null;
        jobTitle = properties.jobtitle || properties.job_title || null;
        
        // Build contact name for description
        const fullName = `${firstName || ''} ${lastName || ''}`.trim();
        contactName = fullName || 'Contact';
      }
    } catch (error) {
      console.warn('[Background] Could not fetch contact details for deal log:', error);
      // Continue with default values
    }
    
    // Build description: "Deal created: Deal Name • $5000 • Appointment Scheduled"
    const descriptionParts = [`Deal created: ${dealName}`];
    if (dealLogData?.dealAmount) {
      descriptionParts.push(`$${dealLogData.dealAmount}`);
    }
    if (dealLogData?.dealStage) {
      const stageLabel = dealLogData.dealStage.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      descriptionParts.push(stageLabel);
    }
    const description = descriptionParts.join(' • ');
    
    // Prepare data for edge function logDealCreation action
    const logData = {
      userId: userId,
      hubspotContactId: dealLogData?.hubspotContactId ? String(dealLogData.hubspotContactId) : null,
      phoneNumber: contactPhone,
      firstName: firstName,
      lastName: lastName,
      email: email,
      company: company,
      jobTitle: jobTitle,
      dealId: dealId ? String(dealId) : null,
      dealName: dealName,
      dealAmount: dealLogData?.dealAmount || null,
      dealStage: dealLogData?.dealStage || null,
      dealCloseDate: dealLogData?.dealCloseDate || null,
      dealType: dealLogData?.dealType || null,
      dealPriority: dealLogData?.dealPriority || null
    };
    
    console.log('[Background] Logging deal creation via edge function:', logData);
    
    // Call edge function to log deal creation (bypasses JWT auth)
    const result = await callHubSpotEdgeFunction('logDealCreation', logData);
    
    console.log('[Background] ✅ Deal creation logged to Supabase successfully via edge function');
    console.log('[Background] Log result:', result);
    return result;
  } catch (error) {
    console.error('[Background] Error logging deal to Supabase via edge function:', error);
    // Don't throw - logging failure shouldn't break the deal creation
    throw error;
  }
}

// Function to create HubSpot contact via edge function
async function findExistingHubSpotContactByPhone(phone) {
  if (!phone) return null;
  try {
    const hits = await searchHubSpotContactsByPhone(getPhoneVariations(phone));
    return hits[0] || null;
  } catch (error) {
    console.warn('[Background] Contact search failed:', error?.message);
    return null;
  }
}

async function maybeCreateCompanyForContact(createdContact, payload, syncSettings) {
  if (!syncSettings?.auto_create_companies) return;
  const companyName = payload?.properties?.company || payload?.sourceData?.company;
  if (!companyName || !String(companyName).trim()) return;
  try {
    await callHubSpotEdgeFunction('createCompany', {
      properties: { name: String(companyName).trim() },
    });
    console.log('[Background] auto_create_companies: company record created for', companyName);
  } catch (error) {
    console.warn('[Background] auto_create_companies failed:', error);
  }
}

async function createHubSpotContactViaEdgeFunction(contactData, userId, accessToken) {
  console.log('[Background] Creating HubSpot contact via edge function:', contactData);
  
  try {
    let payload = contactData;
    if (userId) {
      const syncSettings = await getSyncSettingsForUser(userId);
      const sourceData = contactData?.sourceData || {};
      const mappedProperties = applyFieldMappings(
        sourceData,
        syncSettings.field_mappings,
        contactData?.properties || {}
      );
      payload = {
        ...contactData,
        properties: mappedProperties,
      };
      payload = await applyContactOwnerAssignment(payload, userId);

      if (syncSettings.enrich_before_create !== false) {
        const phone = payload.sourceData?.phone || payload.properties?.phone;
        const existing = await findExistingHubSpotContactByPhone(phone);
        if (existing) {
          console.log('[Background] enrich_before_create: using existing contact', existing.id);
          if (userId && accessToken) {
            await logContactCreationToSupabase(userId, accessToken, payload, existing, syncSettings);
          }
          return existing;
        }
      }
    }

    // Call edge function to create contact
    const result = await callHubSpotEdgeFunction('createContact', payload);
    
    console.log('[Background] Edge function response:', result);
    
    // Handle different response formats from edge function
    const createdContact = result.results?.[0] || result.data?.[0] || result.data || result;

    // A real HubSpot contact always has an id. Guard against error-shaped or
    // empty payloads being treated as a successful creation.
    if (!createdContact || createdContact.error || !createdContact.id) {
      throw new Error(createdContact?.error || result?.error || 'HubSpot did not return a created contact');
    }

    if (createdContact) {
      console.log('[Background] ✅ Contact created successfully');
      console.log('[Background] Created contact details:', createdContact);
      
      // Log to Supabase if userId and accessToken are provided
      if (userId && accessToken) {
        const syncSettings = await getSyncSettingsForUser(userId);
        await logContactCreationToSupabase(userId, accessToken, payload, createdContact, syncSettings);
        await maybeCreateCompanyForContact(createdContact, payload, syncSettings);
      } else {
        console.warn('[Background] Missing userId or accessToken, skipping Supabase log');
        console.warn('[Background] userId:', userId, 'accessToken:', accessToken ? 'present' : 'missing');
      }
      
      return createdContact;
    } else {
      throw new Error('Failed to create contact - no contact data returned');
    }
  } catch (error) {
    console.error('[Background] Error creating HubSpot contact:', error);
    throw error;
  }
}

// Function to call HubSpot OAuth edge function (for connection status, OAuth operations)
async function callHubSpotOAuthEdgeFunction(action, data) {
  const requestBody = { action, data };

  console.log('[Background] Calling hubspot-oauth edge function:', action);

  let accessToken = await getStoredAccessToken();
  const doRequest = (token) => {
    const headers = {
      'Content-Type': 'application/json',
      apikey: EDGE_FUNCTIONS_ANON_KEY,
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetchWithTimeout(HUBSPOT_OAUTH_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });
  };

  try {
    let response = await doRequest(accessToken);

    // hubspot-oauth requires a valid session on every action — refresh the
    // token once and retry so an expired session doesn't silently degrade
    // pipelines/sync-settings/owner lookups.
    if (response.status === 401 && accessToken) {
      const refreshToken = await getStoredRefreshToken();
      const refreshed = refreshToken ? await refreshAccessToken(refreshToken) : null;
      if (refreshed && refreshed !== accessToken) {
        accessToken = refreshed;
        response = await doRequest(accessToken);
      }
    }

    if (!response.ok) {
      let error;
      try {
        error = JSON.parse(await response.text());
      } catch (e) {
        error = { error: `HTTP ${response.status}: ${response.statusText}` };
      }
      throw new Error(error.error || error.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('[Background] ❌ hubspot-oauth edge function call failed:', action, '-', error.message);
    throw error;
  }
}

// Function to check HubSpot integration status via edge function (with 5-min cache)
async function checkHubSpotIntegrationStatusViaEdgeFunction(userId) {
  if (!userId) {
    throw new Error('User ID is required to check HubSpot integration status');
  }

  const now = Date.now();
  if (hubspotConnectionCache && hubspotConnectionCache.userId === userId && (now - hubspotConnectionCache.cachedAt) < HUBSPOT_CONNECTION_CACHE_MS) {
    console.log('[Background] HubSpot connection status (cached):', hubspotConnectionCache.status);
    return {
      status: hubspotConnectionCache.status,
      portalId: hubspotConnectionCache.portalId,
      portal_id: hubspotConnectionCache.portal_id,
      connectedAt: hubspotConnectionCache.connectedAt,
      connected_at: hubspotConnectionCache.connected_at
    };
  }

  console.log('[Background] Checking HubSpot integration status via hubspot-oauth edge function');
  console.log('[Background] User ID:', userId);

  try {
    const result = await callHubSpotOAuthEdgeFunction('getConnectionStatus', { userId: userId });
    console.log('[Background] Edge function response:', result);

    const portalId = result.portalId ?? result.portal_id;
    const connectedAt = result.connectedAt ?? result.connected_at;
    hubspotConnectionCache = {
      userId,
      status: result.status,
      portalId,
      portal_id: portalId,
      connectedAt,
      connected_at: connectedAt,
      cachedAt: Date.now()
    };

    // Persist last-known-good status so it survives service-worker restarts.
    // Only persist when genuinely connected so a stale record never masks a real
    // disconnect that happened on the server side (24-h TTL is a safety net).
    if (result.status === 'active' || result.status === 'connected') {
      chrome.storage.local.set({
        [HUBSPOT_CONNECTION_STORAGE_KEY]: {
          userId,
          status: result.status,
          portalId,
          portal_id: portalId,
          connectedAt,
          connected_at: connectedAt,
          savedAt: Date.now(),
        }
      });
    } else {
      // Server says disconnected — clear the durable record so we don't lie.
      chrome.storage.local.remove(HUBSPOT_CONNECTION_STORAGE_KEY);
    }

    return result;
  } catch (error) {
    console.error('[Background] Error checking HubSpot integration status:', error);

    // Network / transient error — return the last persisted status rather than
    // flipping the user to "disconnected" every time the service worker restarts.
    try {
      const stored = await chrome.storage.local.get(HUBSPOT_CONNECTION_STORAGE_KEY);
      const saved = stored[HUBSPOT_CONNECTION_STORAGE_KEY];
      if (saved && saved.userId === userId && (Date.now() - saved.savedAt) < HUBSPOT_CONNECTION_STORAGE_TTL_MS) {
        console.log('[Background] HubSpot status from durable fallback:', saved.status);
        // Warm the in-memory cache from storage so the next call is instant.
        hubspotConnectionCache = { ...saved, cachedAt: Date.now() };
        return saved;
      }
    } catch { /* ignore storage errors */ }

    throw error;
  }
}

// HubSpot calculated/read-only contact properties. Sending any of these in a
// create/update payload makes HubSpot reject the entire request (READ_ONLY_VALUE).
const READ_ONLY_HUBSPOT_PROPERTIES = new Set([
  'notes_last_contacted',
  'notes_last_updated',
  'notes_next_activity_date',
  'num_contacted_notes',
  'num_notes',
  'hs_last_sales_activity_timestamp',
  'lastmodifieddate',
  'hs_lastmodifieddate',
  'createdate',
  'hs_object_id',
  'hubspot_owner_assigneddate',
  'first_conversion_date',
  'recent_conversion_date',
]);

const DEFAULT_SYNC_SETTINGS = {
  auto_sync_contacts: false,
  auto_create_companies: false,
  enrich_before_create: true,
  attach_message_history: false,
  contact_owner_assignment: 'round_robin',
  default_pipeline_id: null,
  default_stage_id: null,
  mask_phone_numbers: true,
  redact_media_files: true,
  data_retention_days: 90,
  field_mappings: [
    { source: 'phone', target: 'phone', enabled: true },
    { source: 'contact_name', target: 'firstname', enabled: true, splitName: true },
    { source: 'last_message_date', target: 'notes_last_contacted', enabled: false },
    { source: 'email', target: 'email', enabled: true },
    { source: 'company', target: 'company', enabled: true },
    { source: 'job_title', target: 'jobtitle', enabled: true },
  ],
};

function normalizeFieldMappings(raw) {
  const defaults = DEFAULT_SYNC_SETTINGS.field_mappings;
  if (!Array.isArray(raw) || raw.length === 0) {
    return defaults.map((m) => ({ ...m }));
  }

  const allowedSources = new Set(defaults.map((m) => m.source));
  const bySource = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = String(item.source || '');
    const target = String(item.target || '').trim();
    if (!allowedSources.has(source) || !target) continue;
    bySource.set(source, item);
  }

  return defaults.map((fallback) => {
    const existing = bySource.get(fallback.source);
    return existing
      ? {
          source: fallback.source,
          target: String(existing.target || fallback.target),
          enabled: existing.enabled !== false,
          ...(fallback.source === 'contact_name'
            ? { splitName: existing.splitName !== false }
            : {}),
        }
      : { ...fallback };
  });
}

function splitContactName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { first: '', last: '' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function applyFieldMappings(sourceData, mappings, extraProperties = {}) {
  const properties = { ...extraProperties };
  const normalizedMappings = normalizeFieldMappings(mappings);

  for (const mapping of normalizedMappings) {
    if (!mapping.enabled) continue;
    const value = sourceData[mapping.source];
    if (value == null || value === '') continue;

    if (mapping.source === 'contact_name' && mapping.splitName !== false) {
      const { first, last } = splitContactName(value);
      if (mapping.target === 'firstname' || mapping.target === 'lastname') {
        // Don't clobber names sent explicitly in properties (the create form
        // provides firstname/lastname directly, which are authoritative).
        if (first && !properties.firstname) properties.firstname = first;
        if (last && !properties.lastname) properties.lastname = last;
      } else if (!properties[mapping.target]) {
        properties[mapping.target] = String(value);
      }
      continue;
    }

    if (mapping.source === 'last_message_date') {
      const timestamp = typeof value === 'number'
        ? value
        : new Date(value).getTime();
      if (!Number.isNaN(timestamp)) {
        properties[mapping.target] = String(timestamp);
      }
      continue;
    }

    properties[mapping.target] = String(value);
  }

  // HubSpot rejects the whole create/update if any read-only (calculated)
  // property is included. Strip them defensively so a stale or user-edited
  // field mapping (e.g. last_message_date → notes_last_contacted) can't break
  // contact creation.
  for (const key of Object.keys(properties)) {
    if (READ_ONLY_HUBSPOT_PROPERTIES.has(key)) delete properties[key];
  }

  return properties;
}

function maskPhoneForActivityLog(phone) {
  if (!phone || typeof phone !== 'string') return phone;
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return phone;
  const last4 = digits.slice(-4);
  const prefix = phone.trim().startsWith('+') ? '+' : '';
  return `${prefix}*** *** ${last4}`;
}

async function getCreatorEmailFromStorage() {
  try {
    const storage = await chrome.storage.local.get(['external_auth_session']);
    const session = storage.external_auth_session;
    const email = session?.user?.email || session?.email || null;
    return typeof email === 'string' && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}

async function getSyncSettingsViaEdgeFunction(userId) {
  const result = await callHubSpotOAuthEdgeFunction('getSyncSettings', { userId });
  if (!result?.settings) {
    return { ...DEFAULT_SYNC_SETTINGS, field_mappings: normalizeFieldMappings(DEFAULT_SYNC_SETTINGS.field_mappings) };
  }
  return {
    ...DEFAULT_SYNC_SETTINGS,
    ...result.settings,
    field_mappings: normalizeFieldMappings(result.settings.field_mappings),
  };
}

async function getSyncSettingsForUser(userId) {
  const now = Date.now();
  if (syncSettingsCache && syncSettingsCache.userId === userId && (now - syncSettingsCache.cachedAt) < SYNC_SETTINGS_CACHE_MS) {
    return syncSettingsCache.settings;
  }

  try {
    const settings = await getSyncSettingsViaEdgeFunction(userId);
    syncSettingsCache = { userId, settings, cachedAt: now };
    privacySettingsCache = null;
    try {
      await chrome.storage.local.set({ [SYNC_SETTINGS_STORAGE_KEY]: settings });
    } catch { /* ignore */ }
    return settings;
  } catch (error) {
    console.warn('[Background] getSyncSettings API failed, using storage fallback:', error);
    try {
      const stored = await chrome.storage.local.get(SYNC_SETTINGS_STORAGE_KEY);
      const fromStorage = stored[SYNC_SETTINGS_STORAGE_KEY];
      if (fromStorage && typeof fromStorage === 'object') {
        const settings = { ...DEFAULT_SYNC_SETTINGS, ...fromStorage };
        syncSettingsCache = { userId, settings, cachedAt: now };
        return settings;
      }
    } catch { /* ignore */ }
    return { ...DEFAULT_SYNC_SETTINGS };
  }
}

/**
 * Applies Integrations → Contact Owner Assignment when hubspot_owner_id is not set manually.
 * Resolution runs on the server (hubspot-oauth resolveContactOwner) for a single source of truth.
 */
async function applyContactOwnerAssignment(contactData, userId) {
  const properties = { ...(contactData?.properties || {}) };
  const manualOwner = properties.hubspot_owner_id;
  if (manualOwner != null && String(manualOwner).trim() !== '') {
    return contactData;
  }

  const creatorEmail = await getCreatorEmailFromStorage();
  const result = await callHubSpotOAuthEdgeFunction('resolveContactOwner', { userId, creatorEmail });
  if (result?.warning) {
    console.warn('[Background] Contact owner resolution:', result.warning);
  }

  if (result?.ownerId) {
    properties.hubspot_owner_id = String(result.ownerId);
  } else {
    delete properties.hubspot_owner_id;
  }

  return { ...contactData, properties };
}

// Fetch privacy settings from settings edge function + HubSpot integration settings
async function getPrivacySettingsViaEdgeFunction(userId) {
  const now = Date.now();
  if (privacySettingsCache && privacySettingsCache.userId === userId && (now - privacySettingsCache.cachedAt) < PRIVACY_CACHE_MS) {
    return privacySettingsCache.privacy;
  }

  let workspacePrivacy = { mask_phone: true, mask_media: false, allowed_properties: [] };
  try {
    // Authenticated call — without the bearer token the settings function
    // returns 401 and the extension silently falls back to defaults forever.
    const accessToken = await getStoredAccessToken();
    const authHeaders = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    const res = await fetchWithTimeout(SETTINGS_EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EDGE_FUNCTIONS_ANON_KEY, ...authHeaders },
      body: JSON.stringify({ action: 'getPrivacySettings', data: { userId } })
    });
    if (res.ok) {
      const data = await res.json();
      workspacePrivacy = data.privacy || workspacePrivacy;
    }
  } catch (error) {
    console.warn('[Background] workspace privacy fetch failed, using defaults:', error);
  }

  let syncSettings = { ...DEFAULT_SYNC_SETTINGS };
  try {
    syncSettings = await getSyncSettingsForUser(userId);
  } catch (error) {
    console.warn('[Background] sync settings fetch failed for privacy merge:', error);
  }

  const privacy = {
    mask_phone: syncSettings.mask_phone_numbers ?? workspacePrivacy.mask_phone ?? true,
    mask_media: syncSettings.redact_media_files ?? workspacePrivacy.mask_media ?? false,
    allowed_properties: Array.isArray(workspacePrivacy.allowed_properties)
      ? workspacePrivacy.allowed_properties
      : [],
    data_retention_days: syncSettings.data_retention_days ?? 90,
  };

  privacySettingsCache = { userId, privacy, cachedAt: now };
  return privacy;
}

// Function to normalize phone number (remove spaces, dashes, keep only digits and +)
function normalizePhoneNumber(phone) {
  if (!phone) return phone;
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  // International "00" prefix (e.g. 00971…) is equivalent to "+"
  if (cleaned.startsWith('00')) cleaned = cleaned.slice(2);
  return '+' + cleaned;
}

// Function to generate phone number variations for lookup. Country-agnostic:
// HubSpot normalizes phone properties for search, so E.164 plus the raw and
// digits-only forms cover stored formatting differences without guessing how
// a particular country groups its digits.
function getPhoneVariations(phone) {
  if (!phone) return [];
  const normalized = normalizePhoneNumber(phone); // +<digits>
  const variations = [
    phone,                       // Original as seen in WhatsApp
    normalized,                  // E.164
    normalized.replace('+', ''), // Digits only
  ];
  return [...new Set(variations.filter(Boolean))];
}

// Function to check HubSpot CRM for phone number match via edge function
const CONTACT_LOOKUP_PROPERTIES = ['firstname', 'lastname', 'email', 'phone', 'mobilephone', 'company', 'associatedcompanyname', 'associatedcompanyid', 'jobtitle', 'lifecyclestage', 'hs_lead_status', 'hubspot_owner_id', 'createdate'];

// Primary lookup: HubSpot's normalized, searchable calculated phone index.
//
// A WhatsApp number can be stored in HubSpot's `phone` OR `mobilephone` field,
// in any format the user typed (+971…, 00971…, with spaces/dashes). An exact
// EQ on `phone`/`mobilephone` therefore misses almost everything. HubSpot
// maintains hidden, normalized copies — hs_searchable_calculated_phone_number
// and hs_searchable_calculated_mobile_number — that index the bare
// international digits. CONTAINS_TOKEN against those, with a +-stripped,
// digits-only value, is the only reliable phone match (verified against the
// live portal: a number stored as "00971568577794" in mobilephone is found by
// CONTAINS_TOKEN "971568577794", but by none of the phone/mobilephone EQ forms).
async function searchHubSpotContactsByPhone(phoneVariations) {
  // Derive the bare international digit string from any of the variations.
  const raw = phoneVariations.find(Boolean) || '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 7) return [];

  const result = await callHubSpotEdgeFunction('searchContacts', {
    searchRequest: {
      // Separate filterGroups are OR'ed: match the number in any phone field.
      filterGroups: [
        // HubSpot's normalized/calculated copies (used when the portal populates them).
        { filters: [{ propertyName: 'hs_searchable_calculated_phone_number', operator: 'CONTAINS_TOKEN', value: digits }] },
        { filters: [{ propertyName: 'hs_searchable_calculated_mobile_number', operator: 'CONTAINS_TOKEN', value: digits }] },
        // Raw phone fields — required because the calculated copies are empty in this portal
        // (verified live: a number lives in `phone`/`mobilephone` but the calculated fields are blank).
        { filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: digits }] },
        { filters: [{ propertyName: 'mobilephone', operator: 'CONTAINS_TOKEN', value: digits }] },
        { filters: [{ propertyName: 'hs_whatsapp_phone_number', operator: 'CONTAINS_TOKEN', value: digits }] },
      ],
      properties: CONTACT_LOOKUP_PROPERTIES,
      limit: 10,
    },
  });
  const hits = result?.results || result?.data?.results || [];
  return Array.isArray(hits) ? hits : [];
}

// Legacy fallback: scan the first page of contacts and fuzzy-match in memory.
// Only used when the server-side search is unavailable or errors.
async function scanHubSpotContactsByPhone(phoneVariations) {
  const requestData = {
    limit: 100,
    properties: CONTACT_LOOKUP_PROPERTIES,
    associations: ['company']
  };
  const result = await callHubSpotEdgeFunction('getContacts', requestData);

  // Handle different response formats from edge function
  let contacts = result.results || result.data?.results || result.data || result;
  if (!Array.isArray(contacts)) {
    if (contacts && typeof contacts === 'object') {
      contacts = contacts.results || contacts.contacts || [];
    } else {
      contacts = [];
    }
  }

  return contacts.filter(contact => {
    const contactPhone = contact.properties?.phone || contact.properties?.mobilephone || contact.phone || '';
    if (!contactPhone) return false;

    const normalizedContactPhone = normalizePhoneNumber(contactPhone);

    return phoneVariations.some(variant => {
      const normalizedVariant = normalizePhoneNumber(variant);
      return contactPhone === variant ||
             contactPhone.includes(variant) ||
             variant.includes(contactPhone) ||
             normalizedContactPhone === normalizedVariant ||
             normalizedContactPhone.includes(normalizedVariant.replace('+', '')) ||
             normalizedVariant.includes(normalizedContactPhone.replace('+', ''));
    });
  });
}

async function checkHubSpotContactViaEdgeFunction(phoneNumber) {
  if (!phoneNumber) {
    console.log('[Background] No phone number provided');
    return null;
  }

  const phoneVariations = getPhoneVariations(phoneNumber);

  try {
    let matchingContacts = [];
    try {
      matchingContacts = await searchHubSpotContactsByPhone(phoneVariations);
    } catch (searchError) {
      console.warn('[Background] Server-side contact search failed, falling back to scan:', searchError?.message);
      matchingContacts = await scanHubSpotContactsByPhone(phoneVariations);
    }

    if (matchingContacts.length > 0) {
      console.log('[Background] ✅ Found', matchingContacts.length, 'matching contact(s)');

      // Enrich contacts with company names and missing properties
      const enrichedContacts = await Promise.all(
        matchingContacts.map(async (contact) => {
          const props = contact.properties || {};
          const contactId = contact.id || contact.hs_object_id || props.hs_object_id;
          
          // Check if associations are present in the response
          if (contact.associations && contact.associations.company) {
            console.log('[Background] Found company associations:', contact.associations.company);
            const companyAssociations = contact.associations.company.results || contact.associations.company || [];
            if (companyAssociations.length > 0) {
              const companyId = companyAssociations[0].id || companyAssociations[0];
              console.log('[Background] Found associated company ID from associations:', companyId);
              if (!props.associatedcompanyid) {
                if (!contact.properties) {
                  contact.properties = {};
                }
                contact.properties.associatedcompanyid = companyId;
              }
            }
          }
          
          // Check if we're missing properties that were requested
          const missingProps = [];
          if (!props.company && !props.associatedcompanyname) missingProps.push('company', 'associatedcompanyname');
          if (!props.associatedcompanyid) missingProps.push('associatedcompanyid');
          if (!props.jobtitle) missingProps.push('jobtitle');
          if (!props.lifecyclestage && !props.hs_lifecyclestage) missingProps.push('lifecyclestage');
          if (!props.hs_lead_status && !props.lead_status) missingProps.push('hs_lead_status');
          if (!props.createdate && !props.hs_createdate) missingProps.push('createdate');
          
          // If we have a contact ID and missing properties, try to fetch the full contact
          if (contactId && missingProps.length > 0) {
            try {
              console.log('[Background] Missing properties for contact', contactId, ':', missingProps);
              console.log('[Background] Attempting to fetch full contact details...');
              
              // Try to get the full contact with all properties
              const fullContactData = {
                contactId: contactId,
                properties: ['firstname', 'lastname', 'email', 'phone', 'company', 'associatedcompanyname', 'associatedcompanyid', 'jobtitle', 'lifecyclestage', 'hs_lead_status', 'createdate']
              };
              
              const fullContactResult = await callHubSpotEdgeFunction('getContact', fullContactData);
              const fullContact = fullContactResult?.results?.[0] || fullContactResult?.data || fullContactResult;
              
              if (fullContact && fullContact.properties) {
                console.log('[Background] Full contact properties:', Object.keys(fullContact.properties));
                
                // Merge missing properties into the contact
                if (!contact.properties) {
                  contact.properties = {};
                }
                
                // Update missing properties
                if (fullContact.properties.company && !props.company) {
                  contact.properties.company = fullContact.properties.company;
                }
                if (fullContact.properties.associatedcompanyname && !props.associatedcompanyname) {
                  contact.properties.associatedcompanyname = fullContact.properties.associatedcompanyname;
                }
                if (fullContact.properties.associatedcompanyid && !props.associatedcompanyid) {
                  contact.properties.associatedcompanyid = fullContact.properties.associatedcompanyid;
                }
                if (fullContact.properties.jobtitle && !props.jobtitle) {
                  contact.properties.jobtitle = fullContact.properties.jobtitle;
                }
                if (fullContact.properties.lifecyclestage && !props.lifecyclestage) {
                  contact.properties.lifecyclestage = fullContact.properties.lifecyclestage;
                }
                if (fullContact.properties.hs_lifecyclestage && !props.hs_lifecyclestage) {
                  contact.properties.hs_lifecyclestage = fullContact.properties.hs_lifecyclestage;
                }
                if (fullContact.properties.hs_lead_status && !props.hs_lead_status) {
                  contact.properties.hs_lead_status = fullContact.properties.hs_lead_status;
                }
                if (fullContact.properties.createdate && !props.createdate) {
                  contact.properties.createdate = fullContact.properties.createdate;
                }
                
                console.log('[Background] ✅ Enriched contact with missing properties');
              }
            } catch (error) {
              console.warn('[Background] Failed to fetch full contact:', error);
            }
          }
          
          // If we still have an associated company ID but no company name, fetch it
          const associatedCompanyId = props.associatedcompanyid;
          const hasCompanyName = props.associatedcompanyname || (props.company && props.company.trim() !== '');
          
          if (associatedCompanyId && !hasCompanyName) {
            try {
              console.log('[Background] Fetching company name for company ID:', associatedCompanyId);
              const companyData = await callHubSpotEdgeFunction('getCompany', { companyId: associatedCompanyId });
              const companyName = companyData?.properties?.name || companyData?.name || null;
              
              if (companyName) {
                // Add company name to contact properties
                if (!contact.properties) {
                  contact.properties = {};
                }
                contact.properties.associatedcompanyname = companyName;
                contact.properties.company = companyName; // Also set company property for consistency
                console.log('[Background] ✅ Fetched company name:', companyName);
              }
            } catch (error) {
              console.warn('[Background] Failed to fetch company name:', error);
              // Continue without company name
            }
          }
          
          return contact;
        })
      );
      
      return enrichedContacts;
    } else {
      console.log('[Background] ⚠️ No matching contacts found');
      return null;
    }
  } catch (error) {
    console.error('[Background] Error searching HubSpot contacts:', error);
    throw error;
  }
}

// Decode a JWT's exp claim (ms since epoch). Returns 0 if unparseable.
function getJwtExpMs(token) {
  try {
    const payload = JSON.parse(
      atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    );
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// Sign the user out everywhere. Only called when the refresh token itself is
// rejected (truly revoked/expired) or the user logs out — never on a timer.
async function signOutEverywhere() {
  await chrome.storage.local.set({
    userLoggedIn: false,
    userId: null,
    accessToken: null,
    refreshToken: null,
    loginTimestamp: null,
    external_auth_session: null,
  });
  try {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { action: 'userLoggedOut' }).catch(() => {});
    });
  } catch (error) {
    console.error('[Background] Error notifying content script:', error);
  }
  chrome.alarms.clear('sessionCheck');
}

// Keep the session alive: proactively refresh the access token before it expires.
// The session is persistent — we NEVER log out on elapsed time. We only sign out
// if the refresh token is rejected (session genuinely revoked), which is the only
// case where the user must log in again.
async function maybeRefreshSession() {
  try {
    const { userLoggedIn, accessToken } = await chrome.storage.local.get([
      'userLoggedIn',
      'accessToken',
    ]);
    if (!userLoggedIn) {
      chrome.alarms.clear('sessionCheck');
      return;
    }

    const expMs = accessToken ? getJwtExpMs(accessToken) : 0;
    const needsRefresh = !expMs || expMs - Date.now() < SESSION_CONFIG.refreshLeewayMs;
    if (!needsRefresh) return;

    const refreshToken = await getStoredRefreshToken();
    if (!refreshToken) return; // can't refresh proactively; on-demand 401 path handles it

    const newToken = await refreshAccessToken(refreshToken);
    if (!newToken && expMs && expMs < Date.now()) {
      // Access token already dead AND refresh was rejected -> session is truly
      // over. Now (and only now) it is correct to require a fresh login.
      console.log('[Background] Refresh token rejected; signing out.');
      await signOutEverywhere();
    }
  } catch (error) {
    console.warn('[Background] Session refresh check failed:', error?.message);
  }
}

// Function to schedule the periodic token-refresh check
function scheduleSessionCheck() {
  // Clear any existing alarm first
  chrome.alarms.clear('sessionCheck');

  // Periodic alarm survives service-worker restarts; a one-shot chain breaks
  // if the worker dies between the alarm firing and rescheduling.
  const intervalMinutes = SESSION_CONFIG.checkIntervalMs / (60 * 1000);
  chrome.alarms.create('sessionCheck', {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes
  });
}

// Listen for alarm events
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sessionCheck') {
    maybeRefreshSession();
  }
});

// Listen for storage changes to start/stop session checking
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes[SYNC_SETTINGS_STORAGE_KEY]) {
      syncSettingsCache = null;
    }
    if (changes.userLoggedIn) {
      const isLoggedIn = changes.userLoggedIn.newValue === true;
      if (isLoggedIn) {
        // User logged in — start the periodic token-refresh check
        console.log('[Background] User logged in, starting token-refresh checks');
        scheduleSessionCheck();
        maybeRefreshSession();
      } else {
        // User logged out — stop checks
        console.log('[Background] User logged out, stopping token-refresh checks');
        chrome.alarms.clear('sessionCheck');
      }
    }
  }
});

// On service-worker startup, re-arm the refresh alarm (if logged in) and refresh
// if the token is due. The alarm is periodic so it normally survives restarts.
chrome.storage.local.get(['userLoggedIn'], ({ userLoggedIn }) => {
  if (userLoggedIn) scheduleSessionCheck();
  maybeRefreshSession();
});

// After install/update, refresh open WhatsApp tabs so content scripts reconnect
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install' && details.reason !== 'update') return;

  try {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'extensionUpdated' });
      } catch {
        // Stale content script cannot receive messages — reload to inject fresh code
        await chrome.tabs.reload(tab.id);
      }
    }
  } catch (error) {
    console.warn('[Background] Could not refresh WhatsApp tabs after extension update:', error);
  }
});
