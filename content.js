// Content script that runs only on web.whatsapp.com

// ==================== Extension runtime guards ====================

let extensionContextInvalidated = false;
let sidebarFieldsPollingInterval = null;
let extensionListenersRegistered = false;

function isExtensionRuntimeAvailable() {
  try {
    return !!(
      typeof chrome !== 'undefined' &&
      chrome?.runtime?.id &&
      chrome?.storage?.local
    );
  } catch {
    return false;
  }
}

function isExtensionContextInvalidated(error) {
  const msg = error?.message || String(error || '');
  return (
    msg.includes('Extension context invalidated') ||
    msg.includes('Receiving end does not exist') ||
    msg.includes('Could not establish connection') ||
    msg.includes('message channel closed') ||
    msg.includes('asynchronous response') ||
    msg.includes("reading 'local'") ||
    msg.includes("reading 'onMessage'")
  );
}

async function extensionStorageGet(keys) {
  if (!isExtensionRuntimeAvailable()) {
    markExtensionContextInvalidated();
    return {};
  }
  try {
    return await chrome.storage.local.get(keys);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      markExtensionContextInvalidated();
    }
    return {};
  }
}

function showExtensionReloadBanner() {
  if (document.getElementById('whatsync-reload-banner')) return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', showExtensionReloadBanner, { once: true });
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'whatsync-reload-banner';
  banner.setAttribute('role', 'alert');
  banner.innerHTML = `
    <span>WhatSync was updated. Refresh this page (F5) to reconnect the extension.</span>
    <button type="button" id="whatsync-reload-btn">Refresh now</button>
  `;
  Object.assign(banner.style, {
    position: 'fixed',
    top: '56px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '1000000',
    background: '#fef3c7',
    color: '#92400e',
    border: '1px solid #f59e0b',
    borderRadius: '8px',
    padding: '10px 14px',
    fontSize: '13px',
    fontFamily: 'system-ui, sans-serif',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  });

  const btn = banner.querySelector('#whatsync-reload-btn');
  Object.assign(btn.style, {
    border: 'none',
    background: '#f59e0b',
    color: '#fff',
    borderRadius: '6px',
    padding: '6px 10px',
    cursor: 'pointer',
    fontWeight: '600',
  });
  btn.addEventListener('click', () => window.location.reload());

  document.body.appendChild(banner);
}

function markExtensionContextInvalidated() {
  if (extensionContextInvalidated) return;
  extensionContextInvalidated = true;
  showExtensionReloadBanner();
  if (sidebarFieldsPollingInterval) {
    clearInterval(sidebarFieldsPollingInterval);
    sidebarFieldsPollingInterval = null;
  }
}

async function sendExtensionMessage(message) {
  if (extensionContextInvalidated) {
    return null;
  }

  try {
    if (!chrome?.runtime?.id) {
      markExtensionContextInvalidated();
      return null;
    }
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      markExtensionContextInvalidated();
    }
    return null;
  }
}

// ==================== Supabase / Edge function auth ====================

const HUBSPOT_EDGE_FUNCTION_URL =
  typeof EDGE_FUNCTIONS_CONFIG !== 'undefined'
    ? `${EDGE_FUNCTIONS_CONFIG.url}/functions/v1/hubspot`
    : 'https://ogsvchujqpayuckxuwdf.supabase.co/functions/v1/hubspot';
const HUBSPOT_ANON_KEY =
  typeof EDGE_FUNCTIONS_CONFIG !== 'undefined'
    ? EDGE_FUNCTIONS_CONFIG.anonKey
    : 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nc3ZjaHVqcXBheXVja3h1d2RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzU3MzIsImV4cCI6MjA5NTk1MTczMn0.naUOzsjvZk5BT6kUM-eV1g4JxPhBogkBu8gb1Rg0Z8M';

async function getExtensionSession() {
  const result = await extensionStorageGet('external_auth_session');
  return result.external_auth_session || null;
}

async function getExtensionAuthHeaders() {
  const session = await getExtensionSession();
  const token = session?.session?.access_token || session?.access_token || null;
  const headers = {
    'Content-Type': 'application/json',
    apikey: HUBSPOT_ANON_KEY,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function callHubSpotEdgeFromContent(action, data) {
  const headers = await getExtensionAuthHeaders();
  const response = await fetch(HUBSPOT_EDGE_FUNCTION_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, data }),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
}

// ==================== Automation Manager ====================

const AUTOMATION_SUPABASE_URL = typeof EDGE_FUNCTIONS_CONFIG !== 'undefined'
  ? EDGE_FUNCTIONS_CONFIG.url
  : 'https://ogsvchujqpayuckxuwdf.supabase.co';

async function getExtensionUserId() {
  const result = await extensionStorageGet(['external_auth_session', 'userId', 'userLoggedIn']);
  if (!result.userLoggedIn) return null;
  return result.external_auth_session?.user?.id || result.userId || null;
}

async function hasExtensionAuthToken() {
  try {
    const result = await extensionStorageGet(['userLoggedIn', 'accessToken', 'external_auth_session']);
    if (!result.userLoggedIn) return false;
    const session = result.external_auth_session;
    const token =
      result.accessToken ||
      session?.access_token ||
      session?.accessToken ||
      session?.session?.access_token ||
      null;
    return !!token;
  } catch {
    return false;
  }
}

class AutomationManager {
  async getUserId() {
    return getExtensionUserId();
  }

  async trigger(triggerType, context) {
    const userId = await this.getUserId();
    if (!userId) {
      console.warn('[Automations] No user session - skipping automation');
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const { ok, status, json: result } = await callHubSpotEdgeFromContent('evaluateAutomations', {
        userId,
        triggerType,
        context,
      });

      if (!ok) {
        console.error(`[Automations] Error response: ${status}`);
        return { success: false, error: `HTTP ${status}` };
      }
      return result;
    } catch (error) {
      console.error('[Automations] Error:', error);
      return { success: false, error: error.message };
    }
  }

  // Convenience methods
  async contactCreated(contact) {
    return this.trigger('contact_created', {
      contactId: contact.id,
      phone: contact.properties?.phone || contact.phone || null,
      email: contact.properties?.email || contact.email || null,
      firstname: contact.properties?.firstname || contact.firstname || '',
      lastname: contact.properties?.lastname || contact.lastname || '',
      tags: contact.tags || [],
      createdAt: new Date().toISOString()
    });
  }

  async messageSent(message) {
    return this.trigger('message_sent', {
      messageText: message.text,
      contactPhone: message.phone,
      contactName: message.contactName || '',
      timestamp: new Date().toISOString()
    });
  }

  async messageReceived(message) {
    return this.trigger('message_received', {
      messageText: message.text,
      contactPhone: message.phone,
      contactName: message.contactName || '',
      timestamp: new Date().toISOString()
    });
  }

  async ticketCreated(ticket) {
    return this.trigger('ticket_created', {
      ticketId: ticket.id,
      subject: ticket.subject || ticket.ticketName,
      description: ticket.description || ticket.content || '',
      priority: ticket.priority || 'normal',
      contactPhone: ticket.contactPhone,
      contactId: ticket.contactId
    });
  }

  async dealUpdated(deal) {
    return this.trigger('deal_updated', {
      dealId: deal.id,
      stage: deal.stage,
      amount: deal.amount
    });
  }
}

// Create singleton instance
const automations = new AutomationManager();

// ==================== Helper Functions for Automations ====================

/**
 * Get current contact phone number from WhatsApp chat
 */
/**
 * Validate phone number and identify country code
 * @param {string} phoneNumber - The phone number to validate
 * @returns {Object} - Object with isValid, countryCode, formattedNumber, and countryName
 */
function validatePhoneNumberAndCountryCode(phoneNumber) {
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return {
      isValid: false,
      countryCode: null,
      formattedNumber: null,
      countryName: null,
      rawNumber: phoneNumber
    };
  }
  
  // Remove all non-digit characters except +
  const cleaned = phoneNumber.replace(/[^\d+]/g, '');
  
  // Common country codes mapping
  const countryCodes = {
    '1': 'US/Canada',
    '971': 'UAE',
    '91': 'India',
    '44': 'UK',
    '33': 'France',
    '49': 'Germany',
    '86': 'China',
    '81': 'Japan',
    '7': 'Russia',
    '61': 'Australia',
    '55': 'Brazil',
    '52': 'Mexico',
    '34': 'Spain',
    '39': 'Italy',
    '82': 'South Korea',
    '65': 'Singapore',
    '60': 'Malaysia',
    '66': 'Thailand',
    '62': 'Indonesia',
    '84': 'Vietnam',
    '27': 'South Africa',
    '20': 'Egypt',
    '966': 'Saudi Arabia',
    '974': 'Qatar',
    '973': 'Bahrain',
    '968': 'Oman',
    '965': 'Kuwait'
  };
  
  let countryCode = null;
  let countryName = null;
  let formattedNumber = cleaned;
  let isValid = false;
  
  // Check if it starts with +
  if (cleaned.startsWith('+')) {
    // Try to match country codes (1-3 digits after +)
    for (let i = 3; i >= 1; i--) {
      const code = cleaned.substring(1, 1 + i);
      if (countryCodes[code]) {
        countryCode = code;
        countryName = countryCodes[code];
        formattedNumber = `+${code}${cleaned.substring(1 + i)}`;
        isValid = cleaned.length > (1 + i) && cleaned.substring(1 + i).length >= 7; // At least 7 digits after country code
        break;
      }
    }
  } else {
    // No + prefix, try to identify country code from start
    for (let i = 3; i >= 1; i--) {
      const code = cleaned.substring(0, i);
      if (countryCodes[code]) {
        countryCode = code;
        countryName = countryCodes[code];
        formattedNumber = `+${code}${cleaned.substring(i)}`;
        isValid = cleaned.length > i && cleaned.substring(i).length >= 7;
        break;
      }
    }
    
    // If no country code found but number looks valid (10+ digits), assume it's a local number
    if (!countryCode && /^\d{10,}$/.test(cleaned)) {
      isValid = true;
      formattedNumber = cleaned;
    }
  }
  
  return {
    isValid,
    countryCode,
    formattedNumber,
    countryName,
    rawNumber: phoneNumber
  };
}

function looksLikePhoneNumber(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!/^\+?[\d\s\-().]+$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7;
}

function parsePhoneFromWhatsAppDataId(dataId) {
  if (!dataId || typeof dataId !== 'string') return null;

  // Message / chat JIDs: false_971501234567@c.us_ABC or true_971501234567@c.us_ABC
  const jidMatch = dataId.match(/^(?:true|false)_(\d+)@(?:c\.us|s\.whatsapp\.net)/);
  if (jidMatch) {
    const digits = jidMatch[1];
    if (digits.length >= 7) return `+${digits}`;
  }

  // Generic @c.us anywhere in data-id
  const genericJid = dataId.match(/(\d{7,})@(?:c\.us|s\.whatsapp\.net)/);
  if (genericJid) {
    return `+${genericJid[1]}`;
  }

  if (!dataId.startsWith('false_') && !dataId.startsWith('true_')) return null;

  const parts = dataId.split('_');
  if (parts.length < 2) return null;

  const phoneNumber = parts[1];
  const validation = validatePhoneNumberAndCountryCode(phoneNumber);
  if (validation.isValid && validation.formattedNumber) {
    return validation.formattedNumber;
  }

  const digits = phoneNumber.replace(/\D/g, '');
  if (digits.length >= 7) {
    return phoneNumber.startsWith('+') ? phoneNumber : `+${digits}`;
  }

  return null;
}

function extractPhoneFromDataIdOnElement(el) {
  if (!el) return null;
  let node = el;
  for (let depth = 0; node && depth < 8; depth++) {
    const dataId = node.getAttribute?.('data-id');
    if (dataId) {
      const phone = parsePhoneFromWhatsAppDataId(dataId);
      if (phone) return phone;
    }
    node = node.parentElement;
  }
  return null;
}

function getActiveChatPanel() {
  return (
    document.querySelector('div#main') ||
    document.querySelector('[data-testid="conversation-panel-wrapper"]') ||
    document.querySelector('[data-testid="conversation-panel-body"]')?.parentElement ||
    null
  );
}

function getChatListContainer() {
  return (
    document.querySelector('[aria-label="Chat list"]') ||
    document.querySelector('#pane-side') ||
    null
  );
}

function findSelectedChatListRow(chatList) {
  if (!chatList) return null;

  const selectedEl = chatList.querySelector('[aria-selected="true"]');
  if (selectedEl) {
    return (
      selectedEl.closest('[role="listitem"]') ||
      selectedEl.closest('[role="row"]') ||
      selectedEl.closest('[role="gridcell"]') ||
      selectedEl
    );
  }

  const byAria =
    chatList.querySelector('[role="gridcell"][aria-selected="true"]') ||
    chatList.querySelector('[role="row"][aria-selected="true"]');
  if (byAria) return byAria;

  const focusedRow = chatList.querySelector(
    '[role="listitem"]:focus-within, [role="row"]:focus-within, [data-testid="cell-frame-container"]:focus-within'
  );
  if (focusedRow) {
    return (
      focusedRow.closest('[role="listitem"]') ||
      focusedRow.closest('[role="row"]') ||
      focusedRow
    );
  }

  return null;
}

function extractPhoneFromElementAttributes(root) {
  if (!root) return null;

  const attrs = ['data-id', 'data-chat-id', 'data-jid', 'data-peer', 'id', 'aria-label', 'title'];
  const nodes = [root, ...root.querySelectorAll('*')];

  for (const node of nodes) {
    for (const attr of attrs) {
      const val = node.getAttribute?.(attr);
      if (!val) continue;
      if (looksLikePhoneNumber(val)) return val.trim();
      const fromId = parsePhoneFromWhatsAppDataId(val);
      if (fromId) return fromId;
    }
  }

  return null;
}

function extractPhoneFromConversationHeader(root) {
  if (!root) return null;

  const header =
    root.querySelector('[data-testid="conversation-header"]') ||
    root.querySelector('header');
  if (!header) return null;

  const candidates = [];
  header.querySelectorAll('[title]').forEach((el) => {
    candidates.push(el.getAttribute('title'));
  });
  header.querySelectorAll('span[dir="auto"]').forEach((el) => {
    candidates.push(el.textContent);
  });

  for (const value of candidates) {
    const trimmed = (value || '').trim();
    if (looksLikePhoneNumber(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

function extractPhoneFromMessageComposer(root) {
  if (!root) return null;

  const messageInput = root.querySelector('div[contenteditable="true"][role="textbox"]');
  if (!messageInput) return null;

  const ariaLabel = messageInput.getAttribute('aria-label') || '';
  const match = ariaLabel.match(/Type (?:a message )?to (.+)/i);
  if (!match || !match[1]) return null;

  const trimmed = match[1].trim();
  return looksLikePhoneNumber(trimmed) ? trimmed : null;
}

function extractPhoneFromSelectedChatListRow() {
  const chatList = getChatListContainer();
  if (!chatList) return null;

  const selected = findSelectedChatListRow(chatList);
  if (!selected) return null;

  const fromAttrs = extractPhoneFromElementAttributes(selected);
  if (fromAttrs) return fromAttrs;

  const fromDataId = extractPhoneFromDataIdOnElement(selected);
  if (fromDataId) return fromDataId;

  const candidates = [];
  selected.querySelectorAll('[title], span[dir="auto"]').forEach((el) => {
    candidates.push(el.getAttribute('title'), el.textContent);
  });

  for (const value of candidates) {
    const trimmed = (value || '').trim();
    if (looksLikePhoneNumber(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

function extractPhoneFromOpenContactDrawer() {
  const drawer =
    document.querySelector('[data-testid="contact-info-drawer"]') ||
    document.querySelector('[data-testid="drawer-right"]') ||
    document.querySelector('section[data-animate-drawer-title]');

  if (!drawer) return null;
  return extractPhoneFromElementAttributes(drawer);
}

/** Close WhatsApp's contact-info drawer so it does not fight the HubSpot sidebar for width. */
function closeWhatsAppContactDrawer() {
  const drawer =
    document.querySelector('[data-testid="contact-info-drawer"]') ||
    document.querySelector('[data-testid="drawer-right"]');
  if (!drawer) return;

  const backBtn =
    drawer.querySelector('[data-testid="back"]') ||
    drawer.querySelector('[data-icon="back"]')?.closest('button, div[role="button"]') ||
    document.querySelector('[data-testid="back"]');
  backBtn?.click();
}

/** Match chat list row by saved contact name and read JID from data-id (no drawer click). */
function extractPhoneFromChatListByName() {
  const contactName = getCurrentContactName()?.trim();
  if (!contactName) return null;

  const chatList = getChatListContainer();
  if (!chatList) return null;

  const rows = chatList.querySelectorAll('[role="listitem"], [role="row"], [role="gridcell"]');
  for (const row of rows) {
    const titles = [];
    row.querySelectorAll('[title], span[dir="auto"]').forEach((el) => {
      titles.push(el.getAttribute('title'), el.textContent);
    });

    const matchesName = titles.some((t) => (t || '').trim() === contactName);
    if (!matchesName) continue;

    const phone = extractPhoneFromElementAttributes(row);
    if (phone) {
      console.log('[Phone Extraction] ✅ Found phone from chat list row by name:', phone);
      return phone;
    }
  }

  return null;
}

function extractPhoneFromDataIdInPanel(root) {
  if (!root) return null;

  const seen = new Set();
  const elements = root.querySelectorAll('[data-id]');
  for (const el of elements) {
    const dataId = el.getAttribute('data-id');
    if (!dataId || seen.has(dataId)) continue;
    if (!dataId.includes('@c.us') && !dataId.startsWith('false_') && !dataId.startsWith('true_')) {
      continue;
    }
    seen.add(dataId);

    const phone = parsePhoneFromWhatsAppDataId(dataId);
    if (phone) return phone;
  }

  return null;
}

function getCurrentContactPhone() {
  try {
    const maindiv = getActiveChatPanel();

    // 1. Open conversation header — visible phone (saved contact) or data-id JID (unsaved)
    if (maindiv) {
      const header =
        maindiv.querySelector('[data-testid="conversation-header"]') ||
        maindiv.querySelector('header');
      if (header) {
        const fromHeaderJid = extractPhoneFromDataIdOnElement(header);
        if (fromHeaderJid) {
          console.log('[Phone Extraction] ✅ Found phone from header data-id:', fromHeaderJid);
          return fromHeaderJid;
        }
      }

      const fromHeader = extractPhoneFromConversationHeader(maindiv);
      if (fromHeader) {
        console.log('[Phone Extraction] ✅ Found phone from conversation header:', fromHeader);
        return fromHeader;
      }
    }

    // 2. Message composer label (scoped to active chat panel)
    if (maindiv) {
      const fromComposer = extractPhoneFromMessageComposer(maindiv);
      if (fromComposer) {
        console.log('[Phone Extraction] ✅ Found phone from message composer:', fromComposer);
        return fromComposer;
      }
    }

    // 3. URL query param
    const urlPhone = new URLSearchParams(window.location.search).get('phone');
    if (urlPhone && looksLikePhoneNumber(urlPhone)) {
      console.log('[Phone Extraction] ✅ Found phone from URL:', urlPhone);
      return urlPhone;
    }

    // 4. Selected chat list row (data-id JID for unsaved contacts, or visible phone)
    const fromSelectedRow = extractPhoneFromSelectedChatListRow();
    if (fromSelectedRow) {
      console.log('[Phone Extraction] ✅ Found phone from selected chat list row:', fromSelectedRow);
      return fromSelectedRow;
    }

    // 5. data-id on message bubbles inside active chat panel
    if (maindiv) {
      const fromDataId = extractPhoneFromDataIdInPanel(maindiv);
      if (fromDataId) {
        console.log('[Phone Extraction] ✅ Found phone from data-id in main panel:', fromDataId);
        return fromDataId;
      }
    }

    // 6. Message panel (alternate WhatsApp layout)
    const messagePanel =
      document.querySelector('[data-testid="conversation-panel-messages"]') ||
      document.querySelector('[data-testid="conversation-panel-body"]');
    if (messagePanel) {
      const fromMessages = extractPhoneFromDataIdInPanel(messagePanel);
      if (fromMessages) {
        console.log('[Phone Extraction] ✅ Found phone from message panel data-id:', fromMessages);
        return fromMessages;
      }
    }

    // 7. Chat list row matched by saved contact name (header shows name, not phone)
    const fromNameMatch = extractPhoneFromChatListByName();
    if (fromNameMatch) {
      return fromNameMatch;
    }

    // 8. Contact drawer only if user already opened it (never auto-click — breaks layout)
    const fromDrawer = extractPhoneFromOpenContactDrawer();
    if (fromDrawer) {
      console.log('[Phone Extraction] ✅ Found phone from open contact drawer:', fromDrawer);
      return fromDrawer;
    }

    console.log('[Phone Extraction] ❌ No phone number found using any method');
    return null;
  } catch (error) {
    console.error('[Phone Extraction] ❌ Error getting contact phone:', error);
    return null;
  }
}

const INVALID_CONTACT_NAME_PATTERNS = [
  /click/i,
  /contact info/i,
  /tap here/i,
  /add to contacts/i,
  /view contact/i,
  /business account/i,
  /here for/i,
];

const JUNK_CONTACT_NAME_WORDS = new Set([
  'click', 'here', 'for', 'contact', 'info', 'tap', 'add', 'to', 'view', 'the', 'a', 'an',
]);

function isValidContactName(name) {
  const trimmed = (name || '').trim();
  if (trimmed.length < 2) return false;
  if (looksLikePhoneNumber(trimmed)) return false;
  if (INVALID_CONTACT_NAME_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;

  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.every((word) => JUNK_CONTACT_NAME_WORDS.has(word))) {
    return false;
  }

  return true;
}

function parseContactNameParts(contactName) {
  const name = (contactName || '').trim();
  if (!isValidContactName(name)) {
    return { firstName: '', lastName: '' };
  }

  const parts = name.split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : '',
  };
}

function readContactNameFromHeaderElement(el) {
  if (!el || el.closest('a, button, [role="button"]')) return '';

  const fromTitle = el.getAttribute('title')?.trim();
  if (fromTitle && isValidContactName(fromTitle)) return fromTitle;

  const fromText = el.textContent?.trim();
  if (fromText && isValidContactName(fromText)) return fromText;

  return '';
}

/**
 * Get current contact name from WhatsApp chat
 */
function getCurrentContactName() {
  try {
    const header =
      document.querySelector('[data-testid="conversation-header"]') ||
      document.querySelector('div#main header');
    if (!header) return '';

    const infoHeader = header.querySelector('[data-testid="conversation-info-header"]');
    if (infoHeader) {
      const titleEl =
        infoHeader.querySelector('span[title]') ||
        infoHeader.querySelector('span[dir="auto"]');
      const fromInfo = readContactNameFromHeaderElement(titleEl);
      if (fromInfo) return fromInfo;
    }

    const candidates = [];
    header.querySelectorAll('span[title], span[dir="auto"]').forEach((el) => {
      const name = readContactNameFromHeaderElement(el);
      if (name) candidates.push(name);
    });

    if (candidates.length === 0) return '';

    // Prefer the longest valid label (avoids short UI fragments).
    return candidates.sort((a, b) => b.length - a.length)[0];
  } catch (error) {
    console.error('[Automations] Error getting contact name:', error);
    return '';
  }
}

// ==================== Message Observers ====================

let messageObserver = null;
let lastProcessedMessages = new Set();

/**
 * Initialize message observers for WhatsApp
 */
function initializeMessageObservers() {
  
  // Find the chat container
  const chatContainer = document.querySelector('[data-testid="conversation-panel-messages"]') ||
                        document.querySelector('[data-testid="msg-container"]')?.parentElement ||
                        document.querySelector('div[role="log"]');
  
  if (!chatContainer) {
    // Retry after a delay
    setTimeout(initializeMessageObservers, 2000);
    return;
  }
  
  
  // Observer for sent messages
  messageObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processMessageNode(node);
        }
      });
    });
  });
  
  messageObserver.observe(chatContainer, { 
    childList: true, 
    subtree: true 
  });
  
}

/**
 * Process a message node to detect sent/received messages
 */
function processMessageNode(node) {
  try {
    // Check if it's a message container
    const messageContainer = node.querySelector('[data-testid="msg-container"]') || 
                            (node.hasAttribute('data-testid') && node.getAttribute('data-testid').includes('msg') ? node : null);
    
    if (!messageContainer) return;
    
    // Get message text
    const messageTextElement = messageContainer.querySelector('.selectable-text') ||
                              messageContainer.querySelector('[data-testid="conversation-turn"]')?.querySelector('span');
    const messageText = messageTextElement?.textContent?.trim() || '';
    
    if (!messageText) return;
    
    // Create a unique ID for this message to avoid duplicate processing
    const messageId = `${messageText.substring(0, 50)}-${Date.now()}`;
    if (lastProcessedMessages.has(messageId)) return;
    
    // Check if it's an outgoing message (has checkmarks)
    const isOutgoing = messageContainer.querySelector('[data-testid="msg-check"]') ||
                      messageContainer.querySelector('[data-icon="double-check"]') ||
                      messageContainer.querySelector('[data-icon="check"]');
    
    const contactPhone = getCurrentContactPhone();
    const contactName = getCurrentContactName();
    
    if (isOutgoing) {
      // Message sent
      lastProcessedMessages.add(messageId);
      
      automations.messageSent({
        text: messageText,
        phone: contactPhone,
        contactName: contactName
      }).catch(err => {
        console.error('[Automations] Error triggering message_sent:', err);
      });
    } else {
      // Message received
      lastProcessedMessages.add(messageId);
      
      automations.messageReceived({
        text: messageText,
        phone: contactPhone,
        contactName: contactName
      }).catch(err => {
        console.error('[Automations] Error triggering message_received:', err);
      });
    }
    
    // Clean up old message IDs (keep last 100)
    if (lastProcessedMessages.size > 100) {
      const entries = Array.from(lastProcessedMessages);
      lastProcessedMessages = new Set(entries.slice(-50));
    }
  } catch (error) {
    console.error('[Automations] Error processing message node:', error);
  }
}

// Initialize message observers when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeMessageObservers);
} else {
  // DOM already loaded
  setTimeout(initializeMessageObservers, 1000);
}

// ==================== End Automation Helpers ====================

// ==================== WhatsApp Theme Detection ====================

/**
 * Detects WhatsApp's current theme (dark or light) by checking the background color
 * of WhatsApp's main chat container or other UI elements
 */
function detectWhatsAppTheme() {
  try {
    // Method 1: Check WhatsApp's main chat container background
    const mainContainer = document.querySelector('#app > div > div > div[data-testid="conversation-panel-wrapper"]') ||
                         document.querySelector('#app > div > div > div[role="main"]') ||
                         document.querySelector('div[data-testid="chatlist"]') ||
                         document.querySelector('#main');
    
    if (mainContainer) {
      const computedStyle = window.getComputedStyle(mainContainer);
      const bgColor = computedStyle.backgroundColor;
      
      // Convert RGB to hex and check if it's dark
      const rgb = bgColor.match(/\d+/g);
      if (rgb && rgb.length >= 3) {
        const r = parseInt(rgb[0]);
        const g = parseInt(rgb[1]);
        const b = parseInt(rgb[2]);
        // Calculate luminance (perceived brightness)
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        // If luminance is less than 0.5, it's dark mode
        if (luminance < 0.5) {
          return 'dark';
        }
      }
    }
    
    // Method 2: Check body or html background color
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const htmlBg = window.getComputedStyle(document.documentElement).backgroundColor;
    
    const checkIfDark = (color) => {
      const rgb = color.match(/\d+/g);
      if (rgb && rgb.length >= 3) {
        const r = parseInt(rgb[0]);
        const g = parseInt(rgb[1]);
        const b = parseInt(rgb[2]);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return luminance < 0.5;
      }
      return false;
    };
    
    if (checkIfDark(bodyBg) || checkIfDark(htmlBg)) {
      return 'dark';
    }
    
    // Method 3: Check for data attributes or classes that indicate theme
    if (document.body.hasAttribute('data-dark') || 
        document.body.classList.contains('dark') ||
        document.documentElement.hasAttribute('data-dark') ||
        document.documentElement.classList.contains('dark')) {
      return 'dark';
    }
    
    // Default to light mode if we can't determine
    return 'light';
  } catch (error) {
    console.error('[Theme Detection] Error detecting theme:', error);
    return 'light'; // Default to light
  }
}

/**
 * Applies the detected WhatsApp theme to navbar and sidebar
 */
function applyThemeToNavbarAndSidebar(theme) {
  const navbar = document.getElementById('hubspot-navbar');
  const sidebar = document.getElementById('hubspot-sidebar');
  
  if (!navbar && !sidebar) {
    return; // Elements not yet created
  }
  
  // Remove existing theme classes
  if (navbar) {
    navbar.classList.remove('theme-light', 'theme-dark');
    navbar.classList.add(`theme-${theme}`);
  }
  
  if (sidebar) {
    sidebar.classList.remove('theme-light', 'theme-dark');
    sidebar.classList.add(`theme-${theme}`);
  }
  
  // Also add to body for CSS variable access
  document.body.classList.remove('whatsapp-theme-light', 'whatsapp-theme-dark');
  document.body.classList.add(`whatsapp-theme-${theme}`);
  
  console.log(`[Theme] Applied ${theme} theme to navbar and sidebar`);
}

/**
 * Initializes theme detection and applies theme
 * Also sets up a listener for theme changes
 */
let themeObserver = null;
let themeCheckInterval = null;

function teardownThemeDetection() {
  if (themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
  if (themeCheckInterval) {
    clearInterval(themeCheckInterval);
    themeCheckInterval = null;
  }
}

function initializeThemeDetection() {
  // Tear down any previous observer/interval so re-injection never stacks them
  teardownThemeDetection();

  // Detect and apply theme immediately
  const theme = detectWhatsAppTheme();
  applyThemeToNavbarAndSidebar(theme);

  // Set up observer to watch for theme changes
  themeObserver = new MutationObserver(() => {
    const newTheme = detectWhatsAppTheme();
    const currentTheme = document.body.classList.contains('whatsapp-theme-dark') ? 'dark' : 'light';
    
    if (newTheme !== currentTheme) {
      applyThemeToNavbarAndSidebar(newTheme);
    }
  });
  
  // Observe changes to body, html, and main containers
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-dark'],
    childList: false,
    subtree: false
  });
  
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-dark'],
    childList: false,
    subtree: false
  });
  
  // Also observe the main app container for background changes
  const appContainer = document.getElementById('app');
  if (appContainer) {
    themeObserver.observe(appContainer, {
      attributes: true,
      attributeFilter: ['class', 'style'],
      childList: true,
      subtree: true
    });
  }
  
  // Periodic check as fallback (every 5 seconds; observers handle the fast path)
  themeCheckInterval = setInterval(() => {
    const currentTheme = detectWhatsAppTheme();
    const appliedTheme = document.body.classList.contains('whatsapp-theme-dark') ? 'dark' : 'light';

    if (currentTheme !== appliedTheme) {
      applyThemeToNavbarAndSidebar(currentTheme);
    }
  }, 5000);
  
  console.log('[Theme] Theme detection initialized');
}

// ==================== End Theme Detection ====================

// Function to inject navbar
function injectNavbar() {
  // Check if navbar already exists
  const existingNavbar = document.getElementById("hubspot-navbar");
  if (existingNavbar) {
    return; // Navbar already exists
  }

  // Find app root
  const appRoot = document.getElementById("app") || document.querySelector("#app");
  
  if (appRoot) {
    // CSS is now loaded via content.css in manifest.json
    // Create navbar
    const navbar = document.createElement("div");
    navbar.id = "hubspot-navbar";
    navbar.innerHTML = `
      <div class="nav-wrapper">
        <div class="nav-right">
          <button id="checkOpenchat" class="nav-primary-btn" title="HubSpot" aria-label="Open HubSpot">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.867-.272 0-.372.149-.372.297 0 .384.593.445.816.594.223.149.297.298.297.594 0 .297-.298.446-.594.446-.297 0-.743-.15-1.041-.446-.149-.15-.446-.446-.743-.892-.297-.446-.594-.892-.743-1.19-.149-.297-.594-.892-1.338-.892-.446 0-.892.149-1.338.594-.297.298-.594.743-.743 1.19-.149.446-.149.892-.149 1.338 0 .446 0 .892.149 1.338.149.446.446.892.743 1.19.446.445.892.594 1.338.594.744 0 1.189-.595 1.338-.892.149-.297.594-.893.743-1.19.149-.297.297-.446.446-.595.149-.149.297-.298.445-.446.298-.149.595-.446.892-.595.297-.149.595-.446.892-.446.297 0 .595.148.595.446 0 .297-.298.446-.595.446zm-8.07-5.508c-.148 0-.297.15-.297.297v1.485c0 .297.149.446.297.446h.445c.297 0 .446-.149.446-.446V9.171c0-.297-.149-.297-.446-.297h-.445zm5.659 0c-.297 0-.446.149-.446.297v1.485c0 .297.149.446.297.446h.446c.297 0 .446-.149.446-.446V9.171c0-.297-.149-.297-.446-.297h-.297zm3.715.446c0-.892-.297-1.485-.892-1.78-.297-.15-.743-.15-1.338-.15H7.95c-.595 0-1.041 0-1.338.15-.595.295-.892.888-.892 1.78 0 .594.149 1.04.297 1.485.149.446.297.743.446.892.149.15.446.446.892.446.297 0 .446-.148.595-.446.149-.149.297-.446.297-.595 0-.148-.149-.446-.446-.446-.297 0-.595.297-.743.595-.149.297-.149.743-.149 1.04v2.377c0 .595.149.892.446 1.19.297.297.744.595 1.338.595.892 0 1.487-.298 1.78-.892.149-.298.149-.744.149-1.19 0-.446 0-.892-.149-1.338-.149-.297-.446-.743-.892-.892-.297-.15-.594-.446-1.041-.446-.446 0-.743.297-.892.446-.15.149-.15.446-.15.743 0 .148.15.297.297.297.297 0 .446-.149.595-.446.149-.297.446-.595.744-.595.297 0 .595.298.744.595.149.297.149.743.149 1.04v2.377c0 .297-.149.595-.446.892-.298.297-.595.446-1.041.446-.446 0-.743-.149-1.041-.446-.298-.297-.446-.595-.446-.892v-2.377c0-.297.149-.743.149-1.04 0-.297-.149-.743-.297-1.04-.15-.297-.446-.595-.744-.595-.446 0-.743.298-.892.595-.15.297-.15.743-.15 1.04v2.377c0 .595.15.892.447 1.19.297.297.744.595 1.338.595h8.248c.595 0 1.041-.298 1.338-.595.595-.298.892-.892.892-1.485v-4.161z" fill="currentColor"/>
            </svg>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(navbar);
    // Add body class to enable layout adjustments CSS
    document.body.classList.add('hubspot-navbar-active');
    console.log('Navbar injected successfully');
    
    // Inject sidebar (closed initially)
    injectSidebar();
    
    // Initialize theme detection and apply theme
    setTimeout(() => {
      initializeThemeDetection();
    }, 300);
    
    // Add click handler for checkOpenchat after navbar is injected
    setTimeout(() => {
      setupSidebarToggle();
    }, 200);
  }
}

// Function to get phone number (placeholder - implement as needed)
async function getPhoneFastAndInvisible() {
  // Add your phone extraction logic here
  return null;
}

// Function to convert a phone number to E.164 for HubSpot (+<countrycode><number>).
// E.164 is country-agnostic and what HubSpot's phone normalization expects;
// all lookup paths normalize to digits, so stored and searched values stay consistent.
function formatPhoneForHubSpot(phone) {
  if (!phone) return phone;

  const digits = phone.replace(/[^\d]/g, '');
  // E.164 numbers are 7-15 digits including the country code
  if (digits.length < 7 || digits.length > 15) return phone;

  return `+${digits}`;
}

// Resolved-phone cache, keyed by saved-contact name, so we open the WhatsApp
// contact-info panel at most once per contact instead of on every sidebar
// refresh. Bounded to avoid unbounded growth on long sessions.
const contactPanelPhoneCache = new Map();
const CONTACT_PANEL_CACHE_MAX = 200;

function cacheContactPanelPhone(name, phone) {
  if (!name) return;
  if (contactPanelPhoneCache.size >= CONTACT_PANEL_CACHE_MAX) {
    const firstKey = contactPanelPhoneCache.keys().next().value;
    contactPanelPhoneCache.delete(firstKey);
  }
  contactPanelPhoneCache.set(name, phone);
}

/**
 * Collect E.164-style phone numbers that are visible in the WhatsApp
 * contact-info panel. The panel is a separate pane to the right of #main, so we
 * scan the whole document while EXCLUDING the chat list (#pane-side), the
 * conversation/messages pane (#main — message text can contain numbers), and
 * our own sidebar. Returns distinct numbers in DOM order.
 */
function collectContactPanelPhones() {
  const phoneRe = /\+\d[\d\s\-().]{6,}\d/;
  const found = new Map(); // normalized "+digits" -> display order preserved
  const elements = document.querySelectorAll('span, h1, h2, div');

  for (const el of elements) {
    if (el.closest('#pane-side') || el.closest('[aria-label="Chat list"]')) continue;
    if (el.closest('#main')) continue;            // conversation + message bubbles
    if (el.closest('#hubspot-sidebar')) continue; // our own UI
    if (el.querySelector('span, div, h1, h2')) continue; // leaf nodes only

    const text = (el.textContent || '').trim();
    if (text.length < 8 || text.length > 26) continue;
    if (!phoneRe.test(text)) continue;

    const digits = text.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) continue;

    const normalized = `+${digits}`;
    if (!found.has(normalized)) found.set(normalized, true);
  }

  return [...found.keys()];
}

function dispatchEscapeKey() {
  document.body.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
  }));
}

/**
 * Saved-contact fallback. Modern WhatsApp no longer embeds the phone JID in any
 * data-id, so for a saved contact (header shows a name, not a number) the only
 * reliable source is the contact-info panel. We open it, read the number, and
 * close it again. Groups (3+ numbers in the panel) are treated as ambiguous and
 * skipped, so we never attribute a random participant's number to the chat.
 */
async function extractPhoneFromContactPanel() {
  const contactName = getCurrentContactName()?.trim();

  if (contactName && contactPanelPhoneCache.has(contactName)) {
    return contactPanelPhoneCache.get(contactName) || null;
  }

  // If a panel is already open and shows exactly one number, read it with no
  // visual disruption at all.
  let phones = collectContactPanelPhones();
  if (phones.length >= 1 && phones.length <= 2) {
    const phone = phones[0];
    cacheContactPanelPhone(contactName, phone);
    return phone;
  }
  if (phones.length >= 3) {
    cacheContactPanelPhone(contactName, null); // looks like a group
    return null;
  }

  // Otherwise open the contact-info panel via the conversation header.
  const header = getActiveChatPanel()?.querySelector('header');
  const openTarget = header?.querySelector('div[role="button"]') || header;
  if (!openTarget) return null;

  const panelWasOpen = phones.length > 0;
  openTarget.click();

  let resolved = null;
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 70));
    phones = collectContactPanelPhones();
    if (phones.length >= 3) { resolved = null; break; }      // group — don't guess
    if (phones.length >= 1) { resolved = phones[0]; break; } // contact number
  }

  // Close the panel we opened so it doesn't fight the HubSpot sidebar for width.
  // Single Escape only — a second Escape can deselect the chat in WhatsApp.
  if (!panelWasOpen) {
    dispatchEscapeKey();
  }

  cacheContactPanelPhone(contactName, resolved);
  return resolved;
}

async function extractPhoneFromChat() {
  console.log('[Phone Extraction] Starting phone extraction from chat...');

  let phone = getCurrentContactPhone();
  if (phone) {
    console.log('[Phone Extraction] ✅ Extracted phone (direct)');
    return phone;
  }

  // Fallback: legacy header span (older WhatsApp builds that still show a number)
  const maindiv = getActiveChatPanel();
  const header = maindiv?.querySelector('header');
  const span = header?.children[1]?.querySelector('span[dir="auto"]');
  const content = span?.textContent?.trim();
  if (content && looksLikePhoneNumber(content)) {
    console.log('[Phone Extraction] ✅ Extracted phone (header span)');
    return content;
  }

  // Saved-contact fallback: read the number from the contact-info panel.
  // This is the path that handles contacts shown by name (e.g. saved contacts),
  // which modern WhatsApp no longer exposes via data-id.
  const fromPanel = await extractPhoneFromContactPanel();
  if (fromPanel) {
    console.log('[Phone Extraction] ✅ Extracted phone (contact panel)');
    return fromPanel;
  }

  console.log('[Phone Extraction] ❌ No phone number found');
  return null;
}

const HUBSPOT_SIDEBAR_WIDTH_PX = 420;

// Adjust the WhatsApp layout based on sidebar state. Rather than resizing only the
// conversation pane (#main) — which left the panel overlapping the chat — we toggle a
// body class that shrinks WhatsApp's whole app wrapper by the sidebar width (see CSS),
// so the entire UI reflows beside the docked panel instead of behind it.
function widthSetting() {
  const sidebar = document.getElementById("hubspot-sidebar");
  const isOpen = !!(sidebar && sidebar.classList.contains('open'));
  document.body.classList.toggle('hubspot-sidebar-open', isOpen);

  // Clear any legacy inline width set by older builds so it can't fight the CSS.
  const maindiv = document.querySelector("div#main");
  if (maindiv) {
    maindiv.style.width = '';
    maindiv.style.maxWidth = '';
  }
}

// Function to create HubSpot contact via background script
async function createHubSpotContact(contactData) {
  console.log('[Content] Sending create contact request:', contactData);
  
  try {
    const response = await sendExtensionMessage({
      action: 'createHubSpotContact',
      contactData: contactData
    });
    
    console.log('[Content] Received response from background:', response);
    
    if (response) {
      if (response.success) {
        console.log('[Content] ✅ HubSpot Contact Created:', response.data);
        
        // Trigger automation after successful contact creation
        if (response.data && response.data.id) {
          automations.contactCreated(response.data).catch(err => {
            console.error('[Content] Automation trigger failed:', err);
          });
        }
        
        return response.data;
      } else if (response.error) {
        console.error('[Content] ❌ HubSpot Create Contact Error:', response.error);
        throw new Error(response.error);
      }
    }
    
    throw new Error('No response from background script');
  } catch (error) {
    console.error('[Content] Error creating HubSpot contact:', error);
    throw error;
  }
}

// Fetch deal pipelines from HubSpot (via background → hubspot-oauth)
async function fetchHubSpotDealPipelines() {
  try {
    const response = await sendExtensionMessage({ action: 'getDealPipelines' });
    if (response?.success && Array.isArray(response.pipelines)) {
      return response.pipelines;
    }
    console.error('[Content] Failed to fetch deal pipelines:', response?.error);
    return [];
  } catch (error) {
    console.error('[Content] Error fetching deal pipelines:', error);
    return [];
  }
}

/**
 * Populates a deal/ticket/task owner <select> from real HubSpot owners.
 * Defaults to "Unassigned" rather than hard-coding any specific person.
 */
async function populateDealOwnerSelect(modal, selectId = '#deal-owner') {
  const ownerSelect = modal.querySelector(selectId);
  if (!ownerSelect) return;
  const owners = await fetchHubSpotOwners();
  ownerSelect.innerHTML = '<option value="unassigned" selected>Unassigned</option>';
  (owners || []).forEach((owner) => {
    const option = document.createElement('option');
    option.value = owner.id;
    const name = [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim();
    option.textContent = name || owner.email || owner.fullName || String(owner.id);
    ownerSelect.appendChild(option);
  });
}

/**
 * Populates deal modal pipeline/stage dropdowns from HubSpot and applies dashboard defaults.
 */
async function setupDealPipelineForm(modal) {
  const pipelineSelect = modal.querySelector('#deal-pipeline');
  const stageSelect = modal.querySelector('#deal-stage');
  if (!pipelineSelect || !stageSelect) return;

  // Populate the deal-owner dropdown from real HubSpot owners (never hard-code a name).
  populateDealOwnerSelect(modal).catch((err) =>
    console.warn('[Deal Modal] Could not load owners:', err)
  );

  const [pipelines, syncSettings] = await Promise.all([
    fetchHubSpotDealPipelines(),
    getSyncSettings(),
  ]);

  const defaultPipelineId = syncSettings?.default_pipeline_id || null;
  const defaultStageId = syncSettings?.default_stage_id || null;

  const renderStages = (pipelineId) => {
    const pipeline = pipelines.find((p) => p.id === pipelineId);
    stageSelect.innerHTML = '';
    if (!pipeline?.stages?.length) {
      stageSelect.innerHTML = '<option value="">No stages available</option>';
      return;
    }
    pipeline.stages.forEach((stage) => {
      const option = document.createElement('option');
      option.value = stage.id;
      option.textContent = stage.label;
      stageSelect.appendChild(option);
    });
  };

  pipelineSelect.innerHTML = '';
  if (!pipelines.length) {
    pipelineSelect.innerHTML = '<option value="">No pipelines available</option>';
    stageSelect.innerHTML = '<option value="">—</option>';
    return;
  }

  pipelines.forEach((pipeline) => {
    const option = document.createElement('option');
    option.value = pipeline.id;
    option.textContent = pipeline.label;
    pipelineSelect.appendChild(option);
  });

  const initialPipeline =
    defaultPipelineId && pipelines.some((p) => p.id === defaultPipelineId)
      ? defaultPipelineId
      : pipelines[0].id;

  pipelineSelect.value = initialPipeline;
  renderStages(initialPipeline);

  if (defaultStageId && Array.from(stageSelect.options).some((o) => o.value === defaultStageId)) {
    stageSelect.value = defaultStageId;
  }

  pipelineSelect.addEventListener('change', () => {
    renderStages(pipelineSelect.value);
  });
}

// Function to fetch HubSpot owners
async function fetchHubSpotOwners() {
  try {
    console.log('[Content] Fetching HubSpot owners...');
    
    const response = await sendExtensionMessage({
      action: 'getHubSpotOwners'
    });

    if (!response) return [];

    if (response?.success && response.data) {
      return response.data;
    }
    return [];
  } catch {
    return [];
  }
}

// ==================== Template Fetching ====================

/**
 * Fetches user templates from the backend
 * @returns {Promise<{templates: Array}>} Object containing templates array
 */
async function fetchUserTemplates() {
  console.log('[Templates] ===== STARTING TEMPLATE FETCH =====');
  
  try {
    // Get userId from chrome.storage.local
    console.log('[Templates] Checking chrome.storage.local for external_auth_session...');
    const storageResult = await extensionStorageGet('external_auth_session');
    const session = storageResult.external_auth_session;
    
    if (!session) {
      console.warn('[Templates] ❌ No session found in chrome.storage.local');
      return { templates: [] };
    }
    
    console.log('[Templates] ✅ Session found in chrome.storage.local');
    const userId = session?.user?.id;
    
    if (!userId) {
      console.warn('[Templates] ❌ No userId found in session. Session data:', session);
      return { templates: [] };
    }
    
    console.log('[Templates] ✅ UserId extracted:', userId);
    console.log('[Templates] Preparing API request...');
    console.log('[Templates] URL:', HUBSPOT_EDGE_FUNCTION_URL);
    
    const requestBody = {
      action: 'getTemplates',
      data: { userId }
    };
    console.log('[Templates] Request body:', JSON.stringify(requestBody, null, 2));
    
    // Call edge function to get templates
    console.log('[Templates] Sending POST request to edge function...');
    const { ok, status, json: apiResult } = await callHubSpotEdgeFromContent('getTemplates', { userId });

    console.log('[Templates] Response received');
    console.log('[Templates] Status:', status);

    if (!ok) {
      console.error('[Templates] ❌ Failed to fetch templates');
      console.error('[Templates] Status:', status);
      return { templates: [] };
    }

    console.log('[Templates] ✅ Response parsed successfully');
    console.log('[Templates] Response data:', apiResult);
    
    const templates = apiResult.templates || [];
    console.log('[Templates] Number of templates found:', templates.length);
    
    if (templates.length > 0) {
      console.log('[Templates] Template names:', templates.map(t => t.name || 'Untitled'));
      templates.forEach((template, index) => {
        console.log(`[Templates] Template ${index + 1}:`, {
          id: template.id,
          name: template.name,
          category: template.category,
          hasContent: !!template.content,
          variables: template.variables
        });
      });
    } else {
      console.log('[Templates] No templates found for this user');
    }
    
    console.log('[Templates] ===== TEMPLATE FETCH COMPLETED =====');
    return apiResult; // { templates: [...] }
  } catch (error) {
    console.error('[Templates] ===== TEMPLATE FETCH ERROR =====');
    console.error('[Templates] Error type:', error.constructor.name);
    console.error('[Templates] Error message:', error.message);
    console.error('[Templates] Error stack:', error.stack);
    console.error('[Templates] ===== END ERROR =====');
    return { templates: [] };
  }
}

/**
 * Renders template items in the dropdown
 * @param {Array} templates - Array of template objects with { id, name, content, category, variables }
 */
function renderTemplatesInDropdown(templates) {
  console.log('[Templates] ===== RENDERING TEMPLATES IN DROPDOWN =====');
  console.log('[Templates] Number of templates to render:', templates.length);
  
  const dropdown = document.getElementById('more-actions-dropdown');
  if (!dropdown) {
    console.error('[Templates] ❌ Dropdown element not found');
    return;
  }
  
  console.log('[Templates] ✅ Dropdown element found');
  
  // Remove existing template items (keep "Log a WhatsApp message")
  const existingTemplateItems = dropdown.querySelectorAll('.template-option');
  const removedCount = existingTemplateItems.length;
  if (removedCount > 0) {
    console.log(`[Templates] Removing ${removedCount} existing template items`);
  }
  existingTemplateItems.forEach(item => item.remove());
  
    // Add template items
  console.log('[Templates] Creating template items...');
  templates.forEach((template, index) => {
    console.log(`[Templates] Creating template item ${index + 1}/${templates.length}:`, template.name || 'Untitled');
    const templateOption = document.createElement('div');
    templateOption.className = 'more-actions-option template-option';
    templateOption.dataset.templateId = template.id;
    // Store the full template object for access in click handler
    templateOption.dataset.templateContent = template.content || '';
    templateOption.innerHTML = `
      <div class="more-actions-option-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
        </svg>
      </div>
      <span>${template.name || 'Untitled Template'}</span>
    `;
    
    // Add click handler for template
    templateOption.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      console.log('[Templates] ===== TEMPLATE SELECTED =====');
      console.log('[Templates] Template ID:', template.id);
      console.log('[Templates] Template Name:', template.name);
      console.log('[Templates] Template Content:', template.content);
      console.log('[Templates] Template Data:', template);
      
      // Close the dropdown
      dropdown.style.display = 'none';
      console.log('[Templates] Dropdown closed');
      
      // Get template content
      const templateContent = template.content || '';
      
      if (!templateContent) {
        console.warn('[Templates] ⚠️ Template has no content');
        alert('This template has no content.');
        return;
      }
      
      // Insert template content into WhatsApp message input
      const success = insertTemplateContentIntoWhatsAppInput(templateContent);
      
      if (!success) {
        console.error('[Templates] ❌ Failed to insert template content');
        alert('Failed to insert template content. Please try clicking on the message box first.');
      }
    });
    
    // Insert after the last action field (or after "Log a WhatsApp message" if no action fields)
    const logWhatsAppOption = document.getElementById('log-whatsapp-message-option');
    const actionFields = dropdown.querySelectorAll('.action-field-option');
    const lastActionField = actionFields.length > 0 ? actionFields[actionFields.length - 1] : null;
    
    if (lastActionField && lastActionField.parentNode) {
      // Insert after the last action field
      lastActionField.parentNode.insertBefore(templateOption, lastActionField.nextSibling);
      console.log(`[Templates] ✅ Template "${template.name}" inserted after last action field`);
    } else if (logWhatsAppOption && logWhatsAppOption.parentNode) {
      // Fallback: insert after "Log a WhatsApp message" if no action fields
      logWhatsAppOption.parentNode.insertBefore(templateOption, logWhatsAppOption.nextSibling);
      console.log(`[Templates] ✅ Template "${template.name}" inserted after "Log a WhatsApp message"`);
    } else {
      dropdown.appendChild(templateOption);
      console.log(`[Templates] ✅ Template "${template.name}" appended to dropdown`);
    }
  });
  
  console.log(`[Templates] ✅ Successfully rendered ${templates.length} template(s) in dropdown`);
  console.log('[Templates] ===== RENDERING COMPLETED =====');
}

/**
 * Renders action field items in the dropdown
 * @param {Array} actionFields - Array of action field objects
 */
function renderActionFieldsInDropdown(actionFields) {
  console.log('[Action Fields] ===== RENDERING ACTION FIELDS IN DROPDOWN =====');
  console.log('[Action Fields] Number of action fields to render:', actionFields.length);
  
  const dropdown = document.getElementById('more-actions-dropdown');
  if (!dropdown) {
    console.error('[Action Fields] ❌ Dropdown element not found');
    return;
  }
  
  console.log('[Action Fields] ✅ Dropdown element found');
  
  // Get reference to "Log a WhatsApp message" option
  const logWhatsAppOption = document.getElementById('log-whatsapp-message-option');
  
  // Add action field items
  console.log('[Action Fields] Creating action field items...');
  actionFields.forEach((actionField, index) => {
    console.log(`[Action Fields] Creating action field item ${index + 1}/${actionFields.length}:`, actionField.field_label || actionField.column_name || 'Untitled');
    
    const actionOption = document.createElement('div');
    actionOption.className = 'more-actions-option action-field-option';
    actionOption.dataset.actionFieldId = actionField.id || '';
    actionOption.dataset.hubspotProperty = actionField.hubspot_property || '';
    actionOption.dataset.fieldLabel = actionField.field_label || '';
    
    // Use field_label if available, otherwise use column_name, otherwise use hubspot_property
    const displayLabel = actionField.field_label || actionField.column_name || actionField.hubspot_property || 'Action';
    
    actionOption.innerHTML = `
      <div class="more-actions-option-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      </div>
      <span>${displayLabel}</span>
    `;
    
    // Add click handler for action field
    actionOption.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      console.log('[Action Fields] ===== ACTION FIELD SELECTED =====');
      console.log('[Action Fields] Action Field ID:', actionField.id);
      console.log('[Action Fields] Field Label:', actionField.field_label);
      console.log('[Action Fields] HubSpot Property:', actionField.hubspot_property);
      console.log('[Action Fields] Full Action Field Data:', actionField);
      
      // Close the dropdown
      dropdown.style.display = 'none';
      console.log('[Action Fields] Dropdown closed');
      
      // Get contact information from sidebar
      const sidebar = document.getElementById('hubspot-sidebar');
      const contactId = sidebar?.querySelector('.notes-section')?.getAttribute('data-contact-id') || '';
      const contactNameElement = sidebar?.querySelector('.contact-name-section h3');
      const contactName = contactNameElement?.textContent?.trim() || 'Contact';
      const contactEmail = sidebar?.querySelector('.email-value')?.textContent?.trim() || '';
      
      console.log('[Action Fields] Contact info:', { contactName, contactEmail, contactId });
      
      // Handle specific action fields
      const fieldLabel = (actionField.field_label || actionField.column_name || '').toLowerCase();
      
      if (fieldLabel.includes('create ticket') || fieldLabel.includes('ticket')) {
        console.log('[Action Fields] Opening Create Ticket modal...');
        showTicketModal(contactName, contactEmail, contactId);
      } else if (fieldLabel.includes('create deal') || fieldLabel.includes('deal')) {
        console.log('[Action Fields] Opening Create Deal modal...');
        showDealModal(contactName, contactEmail, contactId);
      } else if (fieldLabel.includes('create task') || fieldLabel.includes('task')) {
        console.log('[Action Fields] Opening Create Task modal...');
        showTaskModal(contactName, contactEmail, contactId);
      } else if (fieldLabel.includes('add note') || fieldLabel.includes('note')) {
        console.log('[Action Fields] Opening Add Note modal...');
        showNoteModal(contactName, contactEmail, contactId);
      } else {
        console.log('[Action Fields] Action field clicked:', displayLabel);
        // Handle other action fields here if needed
      }
    });
    
    // Insert after "Log a WhatsApp message" option
    if (logWhatsAppOption && logWhatsAppOption.parentNode) {
      logWhatsAppOption.parentNode.insertBefore(actionOption, logWhatsAppOption.nextSibling);
      console.log(`[Action Fields] ✅ Action field "${displayLabel}" inserted after "Log a WhatsApp message"`);
    } else {
      dropdown.appendChild(actionOption);
      console.log(`[Action Fields] ✅ Action field "${displayLabel}" appended to dropdown`);
    }
  });
  
  console.log(`[Action Fields] ✅ Successfully rendered ${actionFields.length} action field(s) in dropdown`);
  console.log('[Action Fields] ===== RENDERING COMPLETED =====');
}

/**
 * Inserts template content into WhatsApp message input field
 * @param {string} content - The template content to insert
 */
function insertTemplateContentIntoWhatsAppInput(content) {
  console.log('[Templates] ===== INSERTING TEMPLATE CONTENT =====');
  console.log('[Templates] Content to insert:', content);
  
  try {
    // Find the parent div#main
    const mainDiv = document.getElementById('main');
    if (!mainDiv) {
      console.error('[Templates] ❌ div#main not found');
      alert('Could not find the main container. Please refresh the page.');
      return false;
    }
    
    console.log('[Templates] ✅ Found div#main');
    
    // Find the message input div inside div#main with multiple fallback selectors
    let messageInput = null;
    
    // Try multiple selectors in order of specificity
    const selectors = [
      'div[contenteditable="true"][role="textbox"][aria-label*="Type to"][data-lexical-editor="true"]',
      'div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]',
      'div[contenteditable="true"][role="textbox"][aria-placeholder="Type a message"]',
      'div[contenteditable="true"][role="textbox"][aria-label*="Type to"]',
      'div[contenteditable="true"][data-lexical-editor="true"]'
    ];
    
    for (const selector of selectors) {
      messageInput = mainDiv.querySelector(selector);
      if (messageInput) {
        console.log('[Templates] ✅ Found message input div using selector:', selector);
        break;
      }
    }
    
    // If still not found, try searching all contenteditable divs in main
    if (!messageInput) {
      console.log('[Templates] Trying fallback: searching all contenteditable divs in main...');
      const allContentEditable = mainDiv.querySelectorAll('div[contenteditable="true"][role="textbox"]');
      console.log('[Templates] Found', allContentEditable.length, 'contenteditable textboxes in main');
      
      if (allContentEditable.length > 0) {
        // Try to find the one that's likely the message input
        messageInput = Array.from(allContentEditable).find(el => 
          el.getAttribute('aria-label')?.includes('Type to') ||
          el.getAttribute('aria-placeholder')?.includes('Type a message') ||
          el.hasAttribute('data-lexical-editor')
        ) || allContentEditable[allContentEditable.length - 1];
        
        if (messageInput) {
          console.log('[Templates] ✅ Found message input div using fallback method');
        }
      }
    }
    
    // If still not found in main, try searching the entire document
    if (!messageInput) {
      console.log('[Templates] Trying fallback: searching entire document...');
      for (const selector of selectors) {
        messageInput = document.querySelector(selector);
        if (messageInput) {
          console.log('[Templates] ✅ Found message input div in document using selector:', selector);
          break;
        }
      }
    }
    
    if (!messageInput) {
      console.error('[Templates] ❌ Message input div not found');
      console.error('[Templates] Debug: mainDiv:', mainDiv);
      console.error('[Templates] Debug: Contenteditable divs in main:', mainDiv.querySelectorAll('div[contenteditable="true"]').length);
      console.error('[Templates] Debug: All contenteditable textboxes in document:', document.querySelectorAll('div[contenteditable="true"][role="textbox"]').length);
      alert('Could not find the message input field. Please click on the message box first.');
      return false;
    }
    
    // Find the p tag inside the message input
    const pTag = messageInput.querySelector('p._aupe.copyable-text.x15bjb6t.x1n2onr6');
    
    if (!pTag) {
      console.error('[Templates] ❌ p tag not found inside message input');
      alert('Could not find the message input structure. Please refresh the page.');
      return false;
    }
    
    console.log('[Templates] ✅ Found p tag');
    
    // Update p tag attributes and style
    pTag.setAttribute('dir', 'ltr');
    pTag.style.cssText = 'text-indent: 0px; margin-top: 0px; margin-bottom: 0px;';
    console.log('[Templates] ✅ Updated p tag attributes and style');
    
    // Clear the p tag completely first (removes <br> and any other content)
    console.log('[Templates] Clearing p tag content...');
    const originalInnerHTML = pTag.innerHTML;
    console.log('[Templates] Original p tag innerHTML:', originalInnerHTML);
    pTag.innerHTML = '';
    
    // Create the span element
    const spanTag = document.createElement('span');
    spanTag.className = '_aupe copyable-text xkrh14z';
    spanTag.setAttribute('data-lexical-text', 'true');
    // Set innerHTML of span to include template content (in case content has HTML)
    spanTag.innerHTML = content;
    
    // Append the span to the p tag
    pTag.appendChild(spanTag);
    console.log('[Templates] ✅ Replaced <br> tag with span containing template content');
    console.log('[Templates] ✅ Template content inserted into span');
    
    // Verify the change immediately
    const verifySpan = pTag.querySelector('span._aupe.copyable-text.xkrh14z');
    if (verifySpan) {
      console.log('[Templates] ✅ Verified: span exists in p tag');
      console.log('[Templates] Span content:', verifySpan.innerHTML);
      console.log('[Templates] Current p tag innerHTML:', pTag.innerHTML);
    } else {
      console.error('[Templates] ❌ Verification failed: span not found in p tag');
      console.error('[Templates] Current p tag innerHTML:', pTag.innerHTML);
    }
    
    // Use setTimeout to ensure DOM changes are applied before triggering events
    setTimeout(() => {
      // Trigger multiple events to notify WhatsApp/Lexical of the change
      const inputEvent = new Event('input', { bubbles: true, cancelable: true });
      messageInput.dispatchEvent(inputEvent);
      
      const changeEvent = new Event('change', { bubbles: true, cancelable: true });
      messageInput.dispatchEvent(changeEvent);
      
      // Also trigger beforeinput and composition events that Lexical might listen to
      const beforeInputEvent = new InputEvent('beforeinput', { 
        bubbles: true, 
        cancelable: true,
        inputType: 'insertText',
        data: content
      });
      messageInput.dispatchEvent(beforeInputEvent);
      
      // Focus the input field
      messageInput.focus();
      
      // Verify again after events
      const finalVerify = pTag.querySelector('span._aupe.copyable-text.xkrh14z');
      if (finalVerify) {
        console.log('[Templates] ✅ Final verification: span still exists after events');
      } else {
        console.error('[Templates] ❌ Final verification failed: span was removed');
        // Try to re-insert if it was removed
        pTag.innerHTML = '';
        const newSpan = document.createElement('span');
        newSpan.className = '_aupe copyable-text xkrh14z';
        newSpan.setAttribute('data-lexical-text', 'true');
        newSpan.innerHTML = content;
        pTag.appendChild(newSpan);
        console.log('[Templates] ✅ Re-inserted span after removal');
      }
    }, 10);
    
    console.log('[Templates] ✅ Template content successfully inserted');
    console.log('[Templates] ===== INSERTION COMPLETED =====');
    return true;
  } catch (error) {
    console.error('[Templates] ❌ Error inserting template content:', error);
    console.error('[Templates] Error details:', error.message, error.stack);
    return false;
  }
}

// ==================== End Template Fetching ====================

// Function to setup custom tooltips for action buttons (hide native tooltip, show custom one immediately)
// Function to setup more actions dropdown
function setupMoreActionsDropdown() {
  const moreBtn = document.getElementById('more-actions-btn');
  const dropdown = document.getElementById('more-actions-dropdown');
  const logWhatsAppOption = document.getElementById('log-whatsapp-message-option');
  
  if (!moreBtn || !dropdown) return;
  
  // Toggle dropdown on button click
  moreBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isVisible = dropdown.style.display !== 'none';
    
    if (!isVisible) {
      // Dropdown is opening - fetch action fields and templates
      console.log('[More Actions] ===== DROPDOWN OPENED =====');
      console.log('[More Actions] More button clicked, opening dropdown...');
      dropdown.style.display = 'block';
      console.log('[More Actions] ✅ Dropdown displayed');
      
      // Get userId
      const storageResult = await extensionStorageGet('external_auth_session');
      const session = storageResult.external_auth_session;
      const userId = session?.user?.id || null;
      
      if (!userId) {
        console.warn('[More Actions] ❌ No userId found, cannot fetch action fields');
        return;
      }
      
      // Show loading state
      console.log('[More Actions] Showing loading indicator...');
      let loadingEl = dropdown.querySelector('.actions-loading');
      if (!loadingEl) {
        const loading = document.createElement('div');
        loading.className = 'actions-loading';
        loading.style.cssText = 'padding: 8px; text-align: center; color: var(--navbar-text, #6b7280); font-size: 12px;';
        loading.textContent = 'Loading actions...';
        if (logWhatsAppOption && logWhatsAppOption.parentNode) {
          logWhatsAppOption.parentNode.insertBefore(loading, logWhatsAppOption.nextSibling);
        }
        loadingEl = loading;
        console.log('[More Actions] ✅ Loading indicator added');
      }
      
      // Remove existing action field items (keep "Log a WhatsApp message")
      const existingActionItems = dropdown.querySelectorAll('.action-field-option');
      existingActionItems.forEach(item => item.remove());
      
      // Remove existing template items
      const existingTemplateItems = dropdown.querySelectorAll('.template-option');
      existingTemplateItems.forEach(item => item.remove());
      
      // Fetch enabled action fields
      console.log('[More Actions] Fetching enabled action fields...');
      const enabledActions = await getEnabledActionFields(userId);
      console.log('[More Actions] Fetched', enabledActions.length, 'enabled action fields');
      
      // Check if "Send Template" action field exists (enabled)
      const sendTemplateAction = enabledActions.find(
        action => {
          const fieldLabel = (action.field_label || '').toLowerCase();
          const columnName = (action.column_name || '').toLowerCase();
          const hubspotProperty = (action.hubspot_property || '').toLowerCase();
          return fieldLabel.includes('send template') || 
                 fieldLabel.includes('template') ||
                 columnName.includes('send template') ||
                 columnName.includes('template') ||
                 hubspotProperty.includes('send_template') ||
                 hubspotProperty.includes('template');
        }
      );
      
      // Filter out "Send Template" from action fields (we'll show templates instead)
      // Check multiple fields to ensure we catch all variations
      const actionFieldsToRender = enabledActions.filter(
        action => {
          const fieldLabel = (action.field_label || '').toLowerCase();
          const columnName = (action.column_name || '').toLowerCase();
          const hubspotProperty = (action.hubspot_property || '').toLowerCase();
          const isTemplateField = fieldLabel.includes('send template') || 
                                  fieldLabel.includes('template') ||
                                  columnName.includes('send template') ||
                                  columnName.includes('template') ||
                                  hubspotProperty.includes('send_template') ||
                                  hubspotProperty.includes('template');
          return !isTemplateField;
        }
      );
      
      // Render action fields (excluding "Send Template")
      if (actionFieldsToRender && actionFieldsToRender.length > 0) {
        console.log('[More Actions] Rendering action fields in dropdown...');
        renderActionFieldsInDropdown(actionFieldsToRender);
      }
      
      // Always fetch and render templates if "Send Template" action field is enabled
      if (sendTemplateAction) {
        console.log('[More Actions] "Send Template" action field found, fetching templates...');
        const { templates } = await fetchUserTemplates();
        console.log('[More Actions] Template fetch completed, received:', templates?.length || 0, 'template(s)');
        
        if (templates && templates.length > 0) {
          console.log('[More Actions] Rendering templates in dropdown...');
          renderTemplatesInDropdown(templates);
        } else {
          console.log('[More Actions] No templates available to render');
        }
      } else {
        console.log('[More Actions] "Send Template" action field not found, skipping template fetch');
      }
      
      // Remove loading indicator
      if (loadingEl) {
        loadingEl.remove();
        console.log('[More Actions] Loading indicator removed');
      }
      
      console.log('[More Actions] ===== DROPDOWN SETUP COMPLETED =====');
    } else {
      console.log('[More Actions] Dropdown closing...');
      dropdown.style.display = 'none';
      console.log('[More Actions] ✅ Dropdown closed');
    }
  });
  
  // Close dropdown when clicking outside
  const closeDropdownHandler = (e) => {
    if (dropdown && moreBtn && !moreBtn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  };
  document.addEventListener('click', closeDropdownHandler);
  
  // Handle "Log a WhatsApp message" option click (hidden dropdown anchor, kept for
  // backwards compatibility / insertion logic).
  if (logWhatsAppOption) {
    logWhatsAppOption.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Enable message selection mode
      enableMessageSelectionMode();

      dropdown.style.display = 'none';
    });
  }

  // Primary "Log WhatsApp" action button (now promoted above Ticket).
  const logWhatsAppBtn = document.getElementById('log-whatsapp-message-btn');
  if (logWhatsAppBtn) {
    logWhatsAppBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      enableMessageSelectionMode();
      dropdown.style.display = 'none';
    });
  }

  // "Create Ticket" now lives in the More menu (moved off the crowded primary row).
  const ticketOption = document.getElementById('more-create-ticket-option');
  if (ticketOption) {
    ticketOption.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const contactName = ticketOption.getAttribute('data-name') || getCurrentContactName() || 'Contact';
      const contactEmail = ticketOption.getAttribute('data-email') || '';
      const contactId = ticketOption.getAttribute('data-contact-id') || '';
      dropdown.style.display = 'none';
      showTicketModal(contactName, contactEmail, contactId);
    });
  }

}

/**
 * Refresh the dropdown with updated action fields (called when realtime detects changes)
 */
async function refreshActionFieldsDropdown() {
  const dropdown = document.getElementById('more-actions-dropdown');
  if (!dropdown) return;
  
  // Only refresh if dropdown is currently open
  if (dropdown.style.display === 'none') {
    console.log('[Action Fields Realtime] Dropdown is closed, skipping refresh');
    return;
  }
  
  console.log('[Action Fields Realtime] 🔄 Refreshing dropdown with updated action fields...');
  
  // Get userId
  const storageResult = await extensionStorageGet('external_auth_session');
  const session = storageResult.external_auth_session;
  const userId = session?.user?.id || null;
  
  if (!userId) {
    console.warn('[Action Fields Realtime] ❌ No userId found');
    return;
  }
  
  // Remove existing action field items (keep "Log a WhatsApp message")
  const existingActionItems = dropdown.querySelectorAll('.action-field-option');
  existingActionItems.forEach(item => item.remove());
  
  // Remove existing template items
  const existingTemplateItems = dropdown.querySelectorAll('.template-option');
  existingTemplateItems.forEach(item => item.remove());
  
  // Fetch fresh enabled action fields
  const enabledActions = await getEnabledActionFields(userId);
  console.log('[Action Fields Realtime] Fetched', enabledActions.length, 'enabled action fields');
  
  // Check if "Send Template" action field exists (enabled)
  const sendTemplateAction = enabledActions.find(
    action => {
      const fieldLabel = (action.field_label || '').toLowerCase();
      const columnName = (action.column_name || '').toLowerCase();
      const hubspotProperty = (action.hubspot_property || '').toLowerCase();
      return fieldLabel.includes('send template') || 
             fieldLabel.includes('template') ||
             columnName.includes('send template') ||
             columnName.includes('template') ||
             hubspotProperty.includes('send_template') ||
             hubspotProperty.includes('template');
    }
  );
  
  // Filter out "Send Template" from action fields (we'll show templates instead)
  // Check multiple fields to ensure we catch all variations
  const actionFieldsToRender = enabledActions.filter(
    action => {
      const fieldLabel = (action.field_label || '').toLowerCase();
      const columnName = (action.column_name || '').toLowerCase();
      const hubspotProperty = (action.hubspot_property || '').toLowerCase();
      const isTemplateField = fieldLabel.includes('send template') || 
                              fieldLabel.includes('template') ||
                              columnName.includes('send template') ||
                              columnName.includes('template') ||
                              hubspotProperty.includes('send_template') ||
                              hubspotProperty.includes('template');
      return !isTemplateField;
    }
  );
  
  // Render action fields (excluding "Send Template")
  if (actionFieldsToRender && actionFieldsToRender.length > 0) {
    console.log('[Action Fields Realtime] Rendering updated action fields...');
    renderActionFieldsInDropdown(actionFieldsToRender);
  }
  
  // Always fetch and render templates if "Send Template" action field is enabled
  if (sendTemplateAction) {
    console.log('[Action Fields Realtime] "Send Template" action field found, fetching templates...');
    const { templates } = await fetchUserTemplates();
    console.log('[Action Fields Realtime] Template fetch completed, received:', templates?.length || 0, 'template(s)');
    
    if (templates && templates.length > 0) {
      console.log('[Action Fields Realtime] Rendering templates...');
      renderTemplatesInDropdown(templates);
    }
  }
  
  console.log('[Action Fields Realtime] ✅ Dropdown refreshed successfully');
}

// Global variable to track message selection mode
let isMessageSelectionMode = false;
let selectedMessages = new Set();

// A WhatsApp message row is a [data-id] element whose id encodes direction:
// ids beginning "true_" are outgoing (sent by the user), "false_" are incoming.
// This anchor is far more stable than WhatsApp's frequently-rotating bubble classes.
const WA_MESSAGE_ID_RE = /^(true|false)_/;
function getWhatsAppMessageRow(el) {
  const row = el && el.closest ? el.closest('[data-id]') : null;
  if (!row) return null;
  const id = row.getAttribute('data-id') || '';
  // Preferred: ids encode direction ("true_"/"false_"). But to be resilient to WhatsApp
  // markup changes, also accept ANY [data-id] inside the conversation pane (#main),
  // since those are message rows.
  if (WA_MESSAGE_ID_RE.test(id)) return row;
  const main = document.querySelector('#main');
  if (main && main.contains(row)) return row;
  return null;
}
function isOutgoingMessageRow(row) {
  const id = row?.getAttribute('data-id') || '';
  if (id.startsWith('true_')) return true;
  if (id.startsWith('false_')) return false;
  // Fallback: WhatsApp marks outgoing bubbles with a "message-out" class.
  return !!(row?.querySelector?.('.message-out') || row?.classList?.contains('message-out'));
}

// Function to enable message selection mode
function enableMessageSelectionMode() {
  isMessageSelectionMode = true;
  selectedMessages.clear();

  // Add selection mode class to body — this triggers the "focus mode" CSS that dims and
  // blurs everything except the conversation pane (see content.css).
  document.body.classList.add('whatsapp-message-selection-mode');

  // Create selection toolbar
  createSelectionToolbar();

  // Add click handlers to all messages
  setupMessageSelectionHandlers();

  // Show instruction overlay
  showSelectionInstruction();
}

// Function to create selection toolbar
function createSelectionToolbar() {
  // Remove existing toolbar if any
  const existingToolbar = document.getElementById('message-selection-toolbar');
  if (existingToolbar) {
    existingToolbar.remove();
  }
  
  const toolbar = document.createElement('div');
  toolbar.id = 'message-selection-toolbar';
  toolbar.className = 'message-selection-toolbar';
  toolbar.innerHTML = `
    <div class="selection-toolbar-content">
      <span class="selection-count">0 messages selected</span>
      <div class="selection-toolbar-actions">
        <button class="selection-btn selection-btn-cancel" id="cancel-selection-btn">Cancel</button>
        <button class="selection-btn selection-btn-done" id="done-selection-btn" disabled>Done</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(toolbar);
  
  // Setup toolbar button handlers
  const cancelBtn = document.getElementById('cancel-selection-btn');
  const doneBtn = document.getElementById('done-selection-btn');
  
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      disableMessageSelectionMode();
    });
  }
  
  if (doneBtn) {
    doneBtn.addEventListener('click', () => {
      if (selectedMessages.size > 0) {
        finishMessageSelection();
      }
    });
  }
}

// Function to setup message selection handlers
function setupMessageSelectionHandlers() {
  // Delegate on the document (capture phase) so clicks on any message row are caught
  // regardless of WhatsApp's frequently-changing inner DOM. We identify rows by their
  // stable [data-id] message ids rather than brittle bubble classes.
  document.addEventListener('click', handleMessageClickDelegated, true);

  // Make message rows visually clickable (any [data-id] row inside the conversation pane).
  const main = document.querySelector('#main');
  (main || document).querySelectorAll('[data-id]').forEach((row) => {
    row.style.cursor = 'pointer';
  });
}

// Delegated event handler for message clicks
function handleMessageClickDelegated(e) {
  if (!isMessageSelectionMode) return;

  // Ignore clicks on our own selection UI (toolbar / instruction overlay).
  if (e.target.closest && e.target.closest('#message-selection-toolbar, #message-selection-instruction')) {
    return;
  }

  // Find the message row by its stable data-id.
  const messageRow = getWhatsAppMessageRow(e.target);
  if (!messageRow) return;

  const messageId = messageRow.getAttribute('data-id');
  if (!messageId) return;

  e.preventDefault();
  e.stopPropagation();

  // Toggle selection
  if (selectedMessages.has(messageId)) {
    selectedMessages.delete(messageId);
    messageRow.classList.remove('message-selected', 'message-container-selected');
  } else {
    selectedMessages.add(messageId);
    messageRow.classList.add('message-selected', 'message-container-selected');
  }

  // Update toolbar
  updateSelectionToolbar();
}


// Function to update selection toolbar
function updateSelectionToolbar() {
  const countSpan = document.querySelector('.selection-count');
  const doneBtn = document.getElementById('done-selection-btn');
  
  if (countSpan) {
    countSpan.textContent = `${selectedMessages.size} message${selectedMessages.size !== 1 ? 's' : ''} selected`;
  }
  
  if (doneBtn) {
    doneBtn.disabled = selectedMessages.size === 0;
  }
}

// Function to finish message selection and open note modal
function finishMessageSelection() {
  const selectedMessageData = [];
  
  selectedMessages.forEach(messageId => {
    const row = document.querySelector(`[data-id="${CSS.escape(messageId)}"]`);
    if (row) {
      const messageText = extractMessageText(row);
      const isOutgoing = isOutgoingMessageRow(row);
      const timestamp = extractMessageTimestamp(row);

      console.log('[Message Selection] Message found:', {
        id: messageId,
        isOutgoing: isOutgoing,
        text: messageText.substring(0, 50),
        timestamp: timestamp
      });

      selectedMessageData.push({
        id: messageId,
        text: messageText,
        isOutgoing: isOutgoing,
        timestamp: timestamp
      });
    }
  });
  
  // Sort by timestamp if available
  selectedMessageData.sort((a, b) => {
    if (a.timestamp && b.timestamp) {
      return new Date(a.timestamp) - new Date(b.timestamp);
    }
    return 0;
  });
  
  // Get contact info first (needed for formatting)
  const sidebar = document.getElementById('hubspot-sidebar');
  const contactId = sidebar?.querySelector('.notes-section')?.getAttribute('data-contact-id') || '';
  const contactNameElement = sidebar?.querySelector('.contact-name-section h3');
  const contactName = contactNameElement?.textContent?.trim() || 'Contact';
  const contactEmail = sidebar?.querySelector('.email-value')?.textContent?.trim() || '';
  
  console.log('[Message Selection] Contact name found:', contactName);
  
  // Format messages for note (pass contact name)
  const formattedMessages = formatSelectedMessages(selectedMessageData, contactName);
  
  console.log('[Message Selection] Formatted messages:', formattedMessages);
  
  // Disable selection mode
  disableMessageSelectionMode();
  
  // Open note modal with pre-filled content
  showNoteModal(contactName, contactEmail, contactId, formattedMessages);
}

// Function to extract message text. Current WhatsApp Web renders message text inside
// span.selectable-text.copyable-text; we fall back progressively so this keeps working
// even as WhatsApp tweaks its markup.
function extractMessageText(messageElement) {
  const textElement =
    messageElement.querySelector('span.selectable-text.copyable-text') ||
    messageElement.querySelector('span.selectable-text') ||
    messageElement.querySelector('.selectable-text') ||
    messageElement.querySelector('[data-testid="selectable-text"]');
  if (textElement) {
    return (textElement.textContent || textElement.innerText || '').trim();
  }

  // Fallback: get all text content
  return (messageElement.textContent || messageElement.innerText || '').trim();
}

// Function to extract message timestamp. WhatsApp stores precise meta in the
// data-pre-plain-text attribute, e.g. "[10:30 am, 6/14/2026] Name: ".
function extractMessageTimestamp(messageElement) {
  const pre = messageElement.querySelector('[data-pre-plain-text]');
  if (pre) {
    const meta = pre.getAttribute('data-pre-plain-text') || '';
    const m = meta.match(/\[([^\]]+)\]/);
    if (m) return m[1].trim();
  }
  return null;
}

function getRecentChatMessageTexts(limit = 10) {
  const rows = Array.from(document.querySelectorAll('#main [data-id], [data-id]'))
    .filter((el) => WA_MESSAGE_ID_RE.test(el.getAttribute('data-id') || ''));
  return rows
    .slice(-limit)
    .map((el) => {
      const text = extractMessageText(el).trim();
      if (!text) return null;
      const direction = isOutgoingMessageRow(el) ? 'You' : 'Contact';
      return `${direction}: ${text}`;
    })
    .filter(Boolean);
}

async function appendMessageHistoryIfEnabled(text) {
  try {
    const syncSettings = await getSyncSettings();
    if (!syncSettings?.attach_message_history) return text || '';
    const lines = getRecentChatMessageTexts(10);
    if (!lines.length) return text || '';
    const block = '\n\n--- Recent WhatsApp messages ---\n' + lines.join('\n');
    return `${text || ''}${block}`;
  } catch (error) {
    console.warn('[Content] appendMessageHistoryIfEnabled failed:', error);
    return text || '';
  }
}

// Function to format selected messages for note
function formatSelectedMessages(messages, contactName = 'Contact') {
  if (messages.length === 0) return '';
  
  console.log('[formatSelectedMessages] Contact name:', contactName);
  console.log('[formatSelectedMessages] Messages count:', messages.length);
  
  let formatted = 'WhatsApp Messages:\n\n';
  
  messages.forEach((msg, index) => {
    // Only include the message text, no sender name or timestamp
    formatted += `${msg.text}\n\n`;
    console.log(`[formatSelectedMessages] Message ${index + 1}: text="${msg.text.substring(0, 50)}"`);
  });
  
  return formatted.trim();
}

// Function to disable message selection mode
function disableMessageSelectionMode() {
  isMessageSelectionMode = false;
  selectedMessages.clear();
  
  // Remove selection mode class (clears the focus-mode CSS)
  document.body.classList.remove('whatsapp-message-selection-mode');

  // Remove selection toolbar
  const toolbar = document.getElementById('message-selection-toolbar');
  if (toolbar) {
    toolbar.remove();
  }
  
  // Remove instruction overlay
  const instruction = document.getElementById('message-selection-instruction');
  if (instruction) {
    instruction.remove();
  }
  
  // Remove event listeners (we now delegate on document in capture phase).
  document.removeEventListener('click', handleMessageClickDelegated, true);
  document.body.removeEventListener('click', handleMessageClickDelegated, true);

  // Remove selection classes and cursor from message rows.
  document.querySelectorAll('[data-id]').forEach((row) => {
    row.classList.remove('message-selected', 'message-container-selected');
    if (row.style && row.style.cursor === 'pointer') row.style.cursor = '';
  });
}

// Function to show selection instruction
function showSelectionInstruction() {
  // Remove existing instruction if any
  const existing = document.getElementById('message-selection-instruction');
  if (existing) {
    existing.remove();
  }
  
  const instruction = document.createElement('div');
  instruction.id = 'message-selection-instruction';
  instruction.className = 'message-selection-instruction';
  instruction.innerHTML = `
    <div class="selection-instruction-content">
      <p>Click on messages to select them. Click "Done" when finished.</p>
    </div>
  `;
  
  document.body.appendChild(instruction);
  
  // Auto-hide after 3 seconds
  setTimeout(() => {
    if (instruction.parentNode) {
      instruction.style.opacity = '0';
      setTimeout(() => {
        if (instruction.parentNode) {
          instruction.remove();
        }
      }, 300);
    }
  }, 3000);
}

function setupActionButtonTooltips() {
  const actionButtons = document.querySelectorAll('.action-btn[title]');
  actionButtons.forEach(btn => {
    const tooltipText = btn.getAttribute('title');
    // Store title in data attribute for custom tooltip
    btn.setAttribute('data-tooltip', tooltipText);
    
    // Remove title to prevent native tooltip, restore on mouseleave for accessibility
    btn.addEventListener('mouseenter', () => {
      btn.removeAttribute('title');
    });
    
    btn.addEventListener('mouseleave', () => {
      btn.setAttribute('title', tooltipText);
    });
  });
}

// Function to setup note creation modal
function setupNoteCreation() {
  const noteBtn = document.getElementById('create-note-btn');
  if (noteBtn) {
    noteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = noteBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = noteBtn.getAttribute('data-email') || '';
      const contactId = noteBtn.getAttribute('data-contact-id') || '';
      
      // Create and show note modal
      showNoteModal(contactName, contactEmail, contactId);
    });
  }
}

// Function to setup ticket creation functionality
function setupTicketCreation() {
  const ticketBtn = document.getElementById('create-ticket-btn');
  if (ticketBtn) {
    ticketBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = ticketBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = ticketBtn.getAttribute('data-email') || '';
      const contactId = ticketBtn.getAttribute('data-contact-id') || '';
      
      // Create and show ticket modal
      showTicketModal(contactName, contactEmail, contactId);
    });
  }
}

// Function to setup task creation functionality
function setupTaskCreation() {
  const taskBtn = document.getElementById('create-task-btn');
  if (taskBtn) {
    taskBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = taskBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = taskBtn.getAttribute('data-email') || '';
      const contactId = taskBtn.getAttribute('data-contact-id') || '';
      
      // Create and show task modal
      showTaskModal(contactName, contactEmail, contactId);
    });
  }
}

// Function to show note creation modal
function showNoteModal(contactName, contactEmail, contactId, preFilledContent = '') {
  // Determine modal title based on whether content is pre-filled (from message selection)
  const modalTitle = preFilledContent && preFilledContent.trim() ? 'Log WhatsApp Message' : 'Note';
  // Remove existing modal if any
  const existingModal = document.getElementById('note-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // Calculate all date options for dropdown
  function calculateBusinessDays(startDate, days) {
    let date = new Date(startDate);
    let businessDays = 0;
    while (businessDays < days) {
      date.setDate(date.getDate() + 1);
      const dayOfWeek = date.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Not Saturday or Sunday
        businessDays++;
      }
    }
    return date;
  }
  
  function formatDate(date, includeWeekday = true) {
    if (includeWeekday) {
      return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }
  
  // Function to get current date and time in the format shown in screenshot
  function getCurrentDateTime() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const year = now.getFullYear();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    const hoursStr = String(hours).padStart(2, '0');
    return `${month}/${day}/${year} ${hoursStr}:${minutes} ${ampm} GMT`;
  }
  
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  const dateOptions = [
    { label: 'Today', value: 'Today', date: today },
    { label: 'Tomorrow', value: 'Tomorrow', date: tomorrow },
    { label: 'In 2 business days', value: 'In 2 business days', date: calculateBusinessDays(today, 2), includeWeekday: true },
    { label: 'In 3 business days', value: 'In 3 business days', date: calculateBusinessDays(today, 3), includeWeekday: true },
    { label: 'In 1 week', value: 'In 1 week', date: new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000), includeWeekday: false },
    { label: 'In 2 weeks', value: 'In 2 weeks', date: new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000), includeWeekday: false },
    { label: 'In 1 month', value: 'In 1 month', date: new Date(today.getFullYear(), today.getMonth() + 1, today.getDate()), includeWeekday: false },
    { label: 'In 3 months', value: 'In 3 months', date: new Date(today.getFullYear(), today.getMonth() + 3, today.getDate()), includeWeekday: false },
    { label: 'In 6 months', value: 'In 6 months', date: new Date(today.getFullYear(), today.getMonth() + 6, today.getDate()), includeWeekday: false },
    { label: 'Custom Date', value: 'Custom Date', date: null }
  ];
  
  // Default to "In 3 business days"
  const defaultDateOption = dateOptions[3];
  const followUpDate = formatDate(defaultDateOption.date, defaultDateOption.includeWeekday);
  
  // Create modal HTML
  const modalHTML = `
    <div id="note-modal" class="note-modal-overlay">
      <div class="note-modal">
        <div class="note-modal-header">
          <div class="note-modal-header-left">
            <svg class="note-chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span class="note-modal-title">${modalTitle}</span>
          </div>
          <div class="note-modal-header-right">
            <button class="note-modal-icon-btn" title="Expand">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
              </svg>
            </button>
            <button class="note-modal-icon-btn note-modal-close" title="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="note-modal-body">
          <div class="note-recipient">
            <div class="note-recipient-left">
              <div class="note-recipient-label">Contacted</div>
              <div class="note-recipient-name">${contactName}</div>
            </div>
            <div class="note-recipient-right">
              <div class="note-recipient-label">Activity date</div>
              <input type="text" class="note-activity-date" id="note-activity-date" value="${getCurrentDateTime()}" readonly>
            </div>
          </div>
          <div class="note-textarea-container">
            <textarea 
              id="note-textarea" 
              class="note-textarea" 
              placeholder="Start typing to leave a note..."
              rows="8"
            ></textarea>
          </div>
          <div class="note-toolbar">
            <button class="note-toolbar-btn" id="note-bold-btn" title="Bold" data-command="bold">
              <strong>B</strong>
            </button>
            <button class="note-toolbar-btn" id="note-italic-btn" title="Italic" data-command="italic">
              <em>I</em>
            </button>
            <button class="note-toolbar-btn" id="note-underline-btn" title="Underline" data-command="underline">
              <u>U</u>
            </button>
            <button class="note-toolbar-btn" id="note-strikethrough-btn" title="Strikethrough" data-command="strikeThrough">
              <span style="text-decoration: line-through;">Tx</span>
            </button>
            <button class="note-toolbar-btn" id="note-link-btn" title="Link">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
              </svg>
            </button>
            <button class="note-toolbar-btn" id="note-code-btn" title="Code">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="16 18 22 12 16 6"></polyline>
                <polyline points="8 6 2 12 8 18"></polyline>
              </svg>
            </button>
            <button class="note-toolbar-btn" id="note-list-btn" title="Bullet List" data-command="insertUnorderedList">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="8" y1="6" x2="21" y2="6"></line>
                <line x1="8" y1="12" x2="21" y2="12"></line>
                <line x1="8" y1="18" x2="21" y2="18"></line>
                <line x1="3" y1="6" x2="3.01" y2="6"></line>
                <line x1="3" y1="12" x2="3.01" y2="12"></line>
                <line x1="3" y1="18" x2="3.01" y2="18"></line>
              </svg>
            </button>
            <button class="note-toolbar-btn" id="note-attachment-btn" title="Attachment">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
              </svg>
            </button>
          </div>
          <div class="note-todo-section">
            <div class="note-todo-checkbox">
              <input type="checkbox" id="note-todo-checkbox">
              <label for="note-todo-checkbox" class="note-todo-label"><span>Create a </span><span class="note-todo-link" id="note-todo-type">To-do<svg class="note-todo-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg><div class="note-todo-dropdown" id="note-todo-dropdown">
                <div class="note-todo-dropdown-item" data-value="Call">Call</div>
                <div class="note-todo-dropdown-item" data-value="Email">Email</div>
                <div class="note-todo-dropdown-item" data-value="To-do">To-do</div>
              </div></span></label>
              <label for="note-todo-checkbox" class="note-todo-label">
                <span> task to follow up </span>
              </label>
              <span class="note-todo-link" id="note-todo-time">In 3 business days (${followUpDate})<svg class="note-todo-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg><div class="note-todo-dropdown" id="note-todo-time-dropdown">
                ${dateOptions.map(option => {
                  if (option.value === 'Custom Date') {
                    return `<div class="note-todo-dropdown-item" data-value="${option.value}">${option.label}</div>`;
                  }
                  if (option.value === 'Today' || option.value === 'Tomorrow') {
                    return `<div class="note-todo-dropdown-item" data-value="${option.value}">${option.label}</div>`;
                  }
                  const formattedDate = formatDate(option.date, option.includeWeekday);
                  return `<div class="note-todo-dropdown-item" data-value="${option.value}" data-date="${formattedDate}">${option.label} (${formattedDate})</div>`;
                }).join('')}
              </div></span>
            </div>
          </div>
          <div class="note-modal-footer">
            <button class="note-create-btn" id="note-create-btn">Create note</button>
          </div>
        </div>
        ${contactId ? `<input type="hidden" id="note-contact-id" value="${contactId}">` : ''}
      </div>
    </div>
  `;
  
  // Append to body
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Setup event listeners
  const modal = document.getElementById('note-modal');
  const closeBtn = modal.querySelector('.note-modal-close');
  const createBtn = document.getElementById('note-create-btn');
  const overlay = modal;
  
  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      modal.remove();
    }
  });
  
  // Close on close button
  closeBtn.addEventListener('click', () => {
    modal.remove();
  });
  
  // Create note button handler will be set up in setupNoteToolbar()
  
  // Setup toolbar functionality
  setupNoteToolbar(preFilledContent);
  
  // Setup todo dropdown functionality
  setupTodoDropdown();
  
  // Setup todo time dropdown functionality
  console.log('[Note Modal] About to setup todo time dropdown...');
  setTimeout(() => {
    setupTodoTimeDropdown();
  }, 100); // Small delay to ensure DOM is ready
  
  // Focus textarea
  setTimeout(() => {
    const editor = document.getElementById('note-editor') || document.getElementById('note-textarea');
    if (editor) editor.focus();
  }, 100);
}

// Function to setup todo dropdown
function setupTodoDropdown() {
  const todoType = document.getElementById('note-todo-type');
  const dropdown = document.getElementById('note-todo-dropdown');
  
  if (!todoType || !dropdown) return;
  
  // Position dropdown relative to todoType
  function positionDropdown() {
    const rect = todoType.getBoundingClientRect();
    const dropdownRect = dropdown.getBoundingClientRect();
    dropdown.style.left = '0';
    dropdown.style.top = 'calc(100% + 4px)';
  }
  
  // Toggle dropdown on click
  todoType.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = dropdown.style.display === 'block';
    dropdown.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) {
      positionDropdown();
    }
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!todoType.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });
  
  // Handle dropdown item selection
  const dropdownItems = dropdown.querySelectorAll('.note-todo-dropdown-item');
  dropdownItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const selectedValue = item.getAttribute('data-value');
      // Update text but keep the chevron
      const chevron = todoType.querySelector('.note-todo-chevron');
      todoType.innerHTML = selectedValue;
      if (chevron) {
        todoType.appendChild(chevron);
      } else {
        // Re-add chevron if it was removed
        const newChevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        newChevron.setAttribute('class', 'note-todo-chevron');
        newChevron.setAttribute('width', '12');
        newChevron.setAttribute('height', '12');
        newChevron.setAttribute('viewBox', '0 0 24 24');
        newChevron.setAttribute('fill', 'none');
        newChevron.setAttribute('stroke', 'currentColor');
        newChevron.setAttribute('stroke-width', '2');
        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.setAttribute('points', '6 9 12 15 18 9');
        newChevron.appendChild(polyline);
        todoType.appendChild(newChevron);
      }
      dropdown.style.display = 'none';
    });
  });
}

// Function to setup todo time dropdown
function setupTodoTimeDropdown() {
  const todoTime = document.getElementById('note-todo-time');
  const dropdown = document.getElementById('note-todo-time-dropdown');
  
  console.log('[Note Modal] Setting up todo time dropdown');
  console.log('[Note Modal] todoTime element:', todoTime);
  console.log('[Note Modal] dropdown element:', dropdown);
  
  if (!todoTime) {
    console.error('[Note Modal] ❌ todoTime element not found!');
    return;
  }
  
  if (!dropdown) {
    console.error('[Note Modal] ❌ dropdown element not found!');
    return;
  }
  
  console.log('[Note Modal] ✅ Both elements found, setting up handlers');
  
  // Position dropdown relative to todoTime (above the element)
  function positionDropdown() {
    console.log('[Note Modal] Positioning dropdown');
    dropdown.style.left = '0';
    dropdown.style.bottom = 'calc(100% + 4px)';
    dropdown.style.top = 'auto';
  }
  
  // Toggle dropdown on click (links are now outside label, so no checkbox interference)
  todoTime.addEventListener('click', (e) => {
    console.log('[Note Modal] todoTime clicked!', e.target);
    e.preventDefault();
    e.stopPropagation();
    const isOpen = dropdown.style.display === 'block';
    console.log('[Note Modal] Dropdown is currently:', isOpen ? 'open' : 'closed');
    dropdown.style.display = isOpen ? 'none' : 'block';
    console.log('[Note Modal] Dropdown display set to:', dropdown.style.display);
    if (!isOpen) {
      positionDropdown();
    }
  });
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const clickedInside = todoTime.contains(e.target) || dropdown.contains(e.target);
    
    // Don't close dropdown if clicking on section headers that should toggle sections
    const sectionHeaders = ['deals-title', 'notes-title', 'tickets-title', 'tasks-title'];
    const clickedOnSectionHeader = sectionHeaders.some(className => {
      return e.target.closest(`.${className}`) || e.target.classList.contains(className);
    });
    
    console.log('[Note Modal] Document click detected, clicked inside todoTime/dropdown:', clickedInside, e.target);
    if (!clickedInside && !clickedOnSectionHeader) {
      console.log('[Note Modal] Closing dropdown (clicked outside)');
      dropdown.style.display = 'none';
    }
  });
  
  // Prevent chevron from triggering checkbox
  const chevron = todoTime.querySelector('.note-todo-chevron');
  if (chevron) {
    chevron.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    });
    chevron.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      // Trigger dropdown toggle
      const isOpen = dropdown.style.display === 'block';
      dropdown.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) {
        positionDropdown();
      }
    });
  }
  
  // Handle dropdown item selection
  const dropdownItems = dropdown.querySelectorAll('.note-todo-dropdown-item');
  console.log('[Note Modal] Found', dropdownItems.length, 'dropdown items in time dropdown');
  dropdownItems.forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    });
    
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const selectedValue = item.getAttribute('data-value');
      const selectedDate = item.getAttribute('data-date');
      
      if (selectedValue === 'Custom Date') {
        // Show date picker
        console.log('[Note Modal] Custom Date selected, creating date picker...');
        dropdown.style.display = 'none';
        
        // Get position relative to viewport
        const todoTimeRect = todoTime.getBoundingClientRect();
        const modal = todoTime.closest('.note-modal');
        
        // Create date picker input
        const datePicker = document.createElement('input');
        datePicker.type = 'date';
        datePicker.id = 'custom-date-picker';
        
        // Position absolutely relative to viewport
        datePicker.style.position = 'fixed';
        datePicker.style.left = todoTimeRect.left + 'px';
        datePicker.style.top = (todoTimeRect.top - 40) + 'px';
        datePicker.style.width = '200px';
        datePicker.style.padding = '8px';
        datePicker.style.borderRadius = '6px';
        datePicker.style.border = '1px solid #e2e8f0';
        datePicker.style.fontSize = '14px';
        datePicker.style.zIndex = '100000';
        datePicker.style.backgroundColor = 'white';
        datePicker.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
        datePicker.style.pointerEvents = 'auto';
        
        // Set minimum date to today
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        datePicker.min = todayStr;
        
        console.log('[Note Modal] Date picker element created:', datePicker);
        console.log('[Note Modal] Position:', { left: todoTimeRect.left, top: todoTimeRect.top - 40 });
        
        // Append to body to avoid positioning issues
        document.body.appendChild(datePicker);
        
        // Try to show the picker
        setTimeout(() => {
          console.log('[Note Modal] Attempting to show date picker...');
          if (datePicker.showPicker) {
            try {
              datePicker.showPicker();
              console.log('[Note Modal] showPicker() called');
            } catch (err) {
              console.error('[Note Modal] showPicker() error:', err);
              // Fallback to click
              datePicker.click();
              console.log('[Note Modal] Fallback: click() called');
            }
          } else {
            // Fallback for browsers that don't support showPicker
            datePicker.click();
            console.log('[Note Modal] showPicker() not supported, using click()');
          }
        }, 50);
        
        // Handle date selection
        datePicker.addEventListener('change', () => {
          const selectedDate = new Date(datePicker.value);
          if (selectedDate && !isNaN(selectedDate.getTime())) {
            // Format date as "Custom Date (Wednesday, January 21)"
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const dayName = days[selectedDate.getDay()];
            const monthName = months[selectedDate.getMonth()];
            const day = selectedDate.getDate();
            const formattedDate = `${dayName}, ${monthName} ${day}`;
            
            // Update todoTime text
            const newText = `Custom Date (${formattedDate})`;
            const firstChild = todoTime.firstChild;
            if (firstChild && firstChild.nodeType === Node.TEXT_NODE) {
              firstChild.textContent = newText;
            } else {
              const textNodes = Array.from(todoTime.childNodes).filter(node => node.nodeType === Node.TEXT_NODE);
              if (textNodes.length > 0) {
                textNodes[0].textContent = newText;
              } else {
                const textNode = document.createTextNode(newText);
                todoTime.insertBefore(textNode, todoTime.firstChild);
              }
            }
            console.log('[Note Modal] Updated text to:', newText);
          }
          
          // Clean up
          if (datePicker.parentNode) {
            datePicker.remove();
          }
          document.removeEventListener('click', removePicker);
          document.removeEventListener('keydown', escHandler);
        });
        
        // Remove date picker if clicked outside or ESC pressed
        const removePicker = (e) => {
          if (!datePicker.contains(e.target) && e.target !== datePicker) {
            datePicker.remove();
            document.removeEventListener('click', removePicker);
            document.removeEventListener('keydown', escHandler);
          }
        };
        
        const escHandler = (e) => {
          if (e.key === 'Escape') {
            datePicker.remove();
            document.removeEventListener('click', removePicker);
            document.removeEventListener('keydown', escHandler);
          }
        };
        
        // Use setTimeout to avoid immediate trigger
        setTimeout(() => {
          document.addEventListener('click', removePicker);
          document.addEventListener('keydown', escHandler);
        }, 100);
        
        return;
      }
      
      // Build the new text content
      let newText = '';
      if (selectedValue === 'Today' || selectedValue === 'Tomorrow') {
        newText = selectedValue;
      } else if (selectedDate) {
        newText = `${selectedValue} (${selectedDate})`;
      } else {
        newText = selectedValue;
      }
      
      // Find and update the text node (first child should be text)
      const firstChild = todoTime.firstChild;
      if (firstChild && firstChild.nodeType === Node.TEXT_NODE) {
        firstChild.textContent = newText;
      } else {
        // If structure is different, update the first text node we find
        const textNodes = Array.from(todoTime.childNodes).filter(node => node.nodeType === Node.TEXT_NODE);
        if (textNodes.length > 0) {
          textNodes[0].textContent = newText;
        } else {
          // Insert text node at the beginning
          const textNode = document.createTextNode(newText);
          todoTime.insertBefore(textNode, todoTime.firstChild);
        }
      }
      
      dropdown.style.display = 'none';
    });
  });
}

// Function to setup note toolbar functionality
function setupNoteToolbar(preFilledContent = '') {
  const textarea = document.getElementById('note-textarea');
  if (!textarea) return;
  
  // Make textarea contentEditable for rich text editing
  // We'll use a div instead for better formatting support
  const textareaContainer = textarea.parentElement;
  const editorDiv = document.createElement('div');
  editorDiv.id = 'note-editor';
  editorDiv.className = 'note-textarea';
  editorDiv.contentEditable = true;
  editorDiv.setAttribute('role', 'textbox');
  editorDiv.setAttribute('aria-multiline', 'true');
  editorDiv.setAttribute('data-placeholder', 'Start typing to leave a note...');
  
  // Replace textarea with contentEditable div
  textarea.style.display = 'none';
  textareaContainer.appendChild(editorDiv);
  
  // Set pre-filled content if provided (after appending to DOM)
  if (preFilledContent && preFilledContent.trim()) {
    console.log('[Note Modal] Setting pre-filled content:', preFilledContent.substring(0, 100));
    // Set content immediately
    editorDiv.textContent = preFilledContent;
    // Force a reflow to ensure content is visible
    editorDiv.offsetHeight;
    console.log('[Note Modal] Content set, editorDiv textContent length:', editorDiv.textContent.length);
  }
  
  // Store selection state
  let savedSelection = null;
  
  // Save selection when user selects text in editor
  editorDiv.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (selection.rangeCount > 0 && selection.anchorNode && editorDiv.contains(selection.anchorNode)) {
      savedSelection = selection.getRangeAt(0).cloneRange();
    }
  });
  
  editorDiv.addEventListener('keyup', () => {
    const selection = window.getSelection();
    if (selection.rangeCount > 0 && selection.anchorNode && editorDiv.contains(selection.anchorNode)) {
      savedSelection = selection.getRangeAt(0).cloneRange();
    }
  });
  
  // Save selection when editor loses focus
  editorDiv.addEventListener('blur', () => {
    const selection = window.getSelection();
    if (selection.rangeCount > 0 && selection.anchorNode && editorDiv.contains(selection.anchorNode)) {
      savedSelection = selection.getRangeAt(0).cloneRange();
    }
  });
  
  // Basic formatting buttons (Bold, Italic, Underline, Strikethrough, List)
  const formatButtons = ['note-bold-btn', 'note-italic-btn', 'note-underline-btn', 'note-strikethrough-btn', 'note-list-btn'];
  formatButtons.forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent losing focus
      });
      
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Restore focus and selection
        editorDiv.focus();
        
        // Restore selection if it was saved
        if (savedSelection) {
          const selection = window.getSelection();
          selection.removeAllRanges();
          try {
            selection.addRange(savedSelection.cloneRange());
          } catch (err) {
            // Selection might be invalid, try to get current selection
            const range = document.createRange();
            range.selectNodeContents(editorDiv);
            range.collapse(false); // Move to end
            selection.addRange(range);
          }
        }
        
        // Execute command immediately after ensuring focus
        const command = btn.getAttribute('data-command');
        if (command) {
          try {
            // Ensure editor is focused and has selection
            if (!editorDiv.contains(document.activeElement)) {
              editorDiv.focus();
            }
            
            // If no selection, select all or create a range at cursor
            const selection = window.getSelection();
            if (!selection.rangeCount || selection.isCollapsed) {
              if (savedSelection) {
                selection.removeAllRanges();
                selection.addRange(savedSelection.cloneRange());
              } else {
                // Create a range at the end if no selection
                const range = document.createRange();
                range.selectNodeContents(editorDiv);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
              }
            }
            
            // Execute the command
            // For Bold and Italic, use manual wrapping as execCommand can be unreliable
            if (command === 'bold' || command === 'italic') {
              const selectedText = selection.toString();
              const range = selection.getRangeAt(0);
              
              if (selectedText && selectedText.trim()) {
                // Apply formatting by wrapping selected text
                const tag = command === 'bold' ? 'strong' : 'em';
                const formattedText = `<${tag}>${selectedText}</${tag}>`;
                
                // Delete selected content and insert formatted version
                range.deleteContents();
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = formattedText;
                
                // Insert the formatted content
                const fragment = document.createDocumentFragment();
                while (tempDiv.firstChild) {
                  fragment.appendChild(tempDiv.firstChild);
                }
                range.insertNode(fragment);
                
                // Move cursor after inserted content
                range.setStartAfter(fragment.lastChild);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
              } else {
                // No selection - try execCommand first, fallback to manual insertion
                try {
                  const success = document.execCommand(command, false, null);
                  if (!success) {
                    // Fallback: insert empty tags
                    const tag = command === 'bold' ? 'strong' : 'em';
                    const emptyTag = `<${tag}></${tag}>`;
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = emptyTag;
                    const node = tempDiv.firstChild;
                    range.insertNode(node);
                    // Move cursor inside the tag
                    range.setStart(node, 0);
                    range.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(range);
                  }
                } catch (err) {
                  // Fallback: insert empty tags
                  const tag = command === 'bold' ? 'strong' : 'em';
                  const emptyTag = `<${tag}></${tag}>`;
                  const tempDiv = document.createElement('div');
                  tempDiv.innerHTML = emptyTag;
                  const node = tempDiv.firstChild;
                  range.insertNode(node);
                  range.setStart(node, 0);
                  range.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(range);
                }
              }
            } else if (command === 'insertUnorderedList') {
              // Handle bullet list manually for better reliability
              const selectedText = selection.toString();
              const range = selection.getRangeAt(0);
              
              if (selectedText && selectedText.trim()) {
                // Split selected text by lines and create list items
                const lines = selectedText.split(/\r?\n/).filter(line => line.trim());
                
                if (lines.length > 0) {
                  // Create ul element
                  const ul = document.createElement('ul');
                  ul.style.margin = '0';
                  ul.style.paddingLeft = '20px';
                  
                  // Create list items
                  lines.forEach(line => {
                    const li = document.createElement('li');
                    li.textContent = line.trim();
                    ul.appendChild(li);
                  });
                  
                  // Replace selected text with list
                  range.deleteContents();
                  range.insertNode(ul);
                  
                  // Move cursor after the list
                  range.setStartAfter(ul);
                  range.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(range);
                }
              } else {
                // No selection - insert empty list
                try {
                  const success = document.execCommand(command, false, null);
                  if (!success) {
                    // Fallback: create empty list manually
                    const ul = document.createElement('ul');
                    ul.style.margin = '0';
                    ul.style.paddingLeft = '20px';
                    const li = document.createElement('li');
                    ul.appendChild(li);
                    range.insertNode(ul);
                    range.setStart(li, 0);
                    range.collapse(true);
                    selection.removeAllRanges();
                    selection.addRange(range);
                  }
                } catch (err) {
                  // Fallback: create empty list manually
                  const ul = document.createElement('ul');
                  ul.style.margin = '0';
                  ul.style.paddingLeft = '20px';
                  const li = document.createElement('li');
                  ul.appendChild(li);
                  range.insertNode(ul);
                  range.setStart(li, 0);
                  range.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(range);
                }
              }
            } else {
              // For other commands (underline, strikethrough), use execCommand
              const success = document.execCommand(command, false, null);
              if (!success) {
                console.warn(`Command ${command} failed`);
              }
            }
            
            updateToolbarState();
            editorDiv.focus(); // Keep focus after command
          } catch (err) {
            console.error('Error executing command:', err);
          }
        }
      });
    }
  });
  
  // Link button
  const linkBtn = document.getElementById('note-link-btn');
  if (linkBtn) {
    linkBtn.addEventListener('click', (e) => {
      e.preventDefault();
      editorDiv.focus();
      const url = prompt('Enter URL:');
      if (url) {
        const text = window.getSelection().toString() || url;
        document.execCommand('createLink', false, url);
      }
    });
  }
  
  // Code button
  const codeBtn = document.getElementById('note-code-btn');
  if (codeBtn) {
    codeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      editorDiv.focus();
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const selectedText = range.toString();
        if (selectedText) {
          const codeText = `<code>${selectedText}</code>`;
          document.execCommand('insertHTML', false, codeText);
        } else {
          document.execCommand('insertHTML', false, '<code></code>');
        }
      }
    });
  }
  
  // Attachment button
  const attachmentBtn = document.getElementById('note-attachment-btn');
  if (attachmentBtn) {
    attachmentBtn.addEventListener('click', (e) => {
      e.preventDefault();
      // Create file input
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', (event) => {
        const files = event.target.files;
        if (files.length > 0) {
          let fileList = '\n[Attachments: ';
          for (let i = 0; i < files.length; i++) {
            fileList += files[i].name;
            if (i < files.length - 1) fileList += ', ';
          }
          fileList += ']';
          document.execCommand('insertText', false, fileList);
        }
        fileInput.remove();
      });
      document.body.appendChild(fileInput);
      fileInput.click();
    });
  }
  
  
  // Update toolbar button states based on selection
  function updateToolbarState() {
    formatButtons.forEach(btnId => {
      const btn = document.getElementById(btnId);
      if (btn) {
        const command = btn.getAttribute('data-command');
        if (command) {
          let isActive = false;
          
          // For bold and italic, check DOM structure
          if (command === 'bold') {
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
              let node = selection.anchorNode;
              if (node.nodeType !== Node.ELEMENT_NODE) {
                node = node.parentElement;
              }
              const strongEl = node.closest('strong') || node.closest('b');
              isActive = !!strongEl;
            } else {
              isActive = document.queryCommandState(command);
            }
          } else if (command === 'italic') {
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
              let node = selection.anchorNode;
              if (node.nodeType !== Node.ELEMENT_NODE) {
                node = node.parentElement;
              }
              const emEl = node.closest('em') || node.closest('i');
              isActive = !!emEl;
            } else {
              isActive = document.queryCommandState(command);
            }
          } else if (command === 'insertUnorderedList') {
            // Check if cursor is inside a list
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
              let node = selection.anchorNode;
              if (node.nodeType !== Node.ELEMENT_NODE) {
                node = node.parentElement;
              }
              const listEl = node.closest('ul') || node.closest('ol');
              isActive = !!listEl;
            } else {
              isActive = document.queryCommandState(command);
            }
          } else {
            // For other commands, use queryCommandState
            isActive = document.queryCommandState(command);
          }
          
          btn.style.backgroundColor = isActive ? '#e2e8f0' : 'transparent';
          btn.style.fontWeight = isActive ? '600' : 'normal';
        }
      }
    });
  }
  
  // Update toolbar state on selection change
  editorDiv.addEventListener('mouseup', updateToolbarState);
  editorDiv.addEventListener('keyup', updateToolbarState);
  
  // Update create button to get content from editor
  const createBtn = document.getElementById('note-create-btn');
  if (createBtn) {
    // Store original onclick if any
    const originalOnClick = createBtn.onclick;
    createBtn.onclick = null;
    
    // Add new handler
    createBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Get HTML content from editor
      const noteContent = editorDiv.innerHTML;
      const noteText = editorDiv.innerText || editorDiv.textContent;
      
      console.log('[Content] Creating note from Log WhatsApp Message popup');
      console.log('[Content] Note text length:', noteText?.length || 0);
      console.log('[Content] Note content preview:', noteText ? noteText.substring(0, 100) : 'empty');
      
      // Validate note content
      if (!noteText || !noteText.trim()) {
        // Show error message
        const errorMsg = document.createElement('div');
        errorMsg.className = 'note-error-message';
        errorMsg.style.cssText = 'color: #e53e3e; background: #fed7d7; padding: 8px 12px; border-radius: 4px; margin-bottom: 10px; font-size: 14px;';
        errorMsg.textContent = 'Please write a note before creating.';
        
        const footer = createBtn.parentElement;
        const existingError = footer.querySelector('.note-error-message');
        if (existingError) {
          existingError.remove();
        }
        footer.insertBefore(errorMsg, createBtn);
        
        // Remove error after 3 seconds
        setTimeout(() => {
          if (errorMsg.parentNode) {
            errorMsg.remove();
          }
        }, 3000);
        return;
      }
      
      // Get HubSpot contact ID from hidden input
      const contactIdInput = document.getElementById('note-contact-id');
      const contactId = contactIdInput ? contactIdInput.value : '';
      
      console.log('[Content] ===== CREATE NOTE BUTTON CLICKED =====');
      console.log('[Content] Note text length:', noteText?.length || 0);
      console.log('[Content] Note HTML length:', noteContent?.length || 0);
      console.log('[Content] Contact ID input element:', contactIdInput);
      console.log('[Content] HubSpot Contact ID:', contactId);
      
      if (!contactId) {
        console.error('[Content] ❌ Contact ID not found');
        alert('Error: Contact ID not found. Cannot create note.');
        return;
      }
      
      const createTodo = document.getElementById('note-todo-checkbox').checked;
      console.log('[Content] Create todo checkbox checked:', createTodo);
      console.log('[Content] Full note data:', {
        contactId: contactId,
        noteText: noteText?.substring(0, 100) + (noteText?.length > 100 ? '...' : ''),
        noteTextLength: noteText?.length,
        noteContentLength: noteContent?.length,
        createTodo: createTodo
      });
      
      // Disable button while creating
      createBtn.disabled = true;
      const originalText = createBtn.textContent;
      createBtn.textContent = 'Creating...';
      console.log('[Content] Button disabled, starting note creation...');
      
      // Create note in HubSpot (using actual HubSpot contact ID)
      createHubSpotNote(contactId, noteText, noteContent, createTodo)
        .then((result) => {
          console.log('[Content] ✅ Note created successfully!');
          console.log('[Content] Create note result:', result);
          
          // Close modal on success
          const modal = document.getElementById('note-modal');
          if (modal) {
            console.log('[Content] Closing modal...');
            modal.remove();
            console.log('[Content] Modal closed');
          } else {
            console.warn('[Content] Modal not found for removal');
          }
          
          // Refresh notes section if it exists
          const notesSection = document.querySelector('.notes-section');
          if (notesSection) {
            const notesContent = notesSection.querySelector('.notes-content');
            const isExpanded = notesContent && notesContent.style.display !== 'none';
            const contactIdAttr = notesSection.getAttribute('data-contact-id');
            
            if (contactIdAttr) {
              if (isExpanded) {
                // Reload full notes list if expanded
                notesSection.dataset.notesLoaded = 'false';
                loadContactNotes(contactIdAttr, notesSection);
              } else {
                // Just update the count if collapsed
                refreshNotesCount(contactIdAttr, notesSection);
              }
            }
          }
        })
        .catch((error) => {
          console.error('[Content] ❌ Error creating note in button handler');
          console.error('[Content] Error details:', {
            message: error.message,
            stack: error.stack,
            name: error.name
          });
          alert(`Error creating note: ${error.message || 'Failed to create note'}`);
          // Re-enable button on error
          createBtn.disabled = false;
          createBtn.textContent = originalText;
          console.log('[Content] Button re-enabled after error');
        })
        .finally(() => {
          console.log('[Content] =========================================');
        });
    }, true); // Use capture phase to ensure it runs first
  }
}

// Function to setup email handler
function setupEmailHandler() {
  const emailBtn = document.getElementById('create-email-btn');
  if (emailBtn) {
    emailBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const email = emailBtn.getAttribute('data-email');
      const name = emailBtn.getAttribute('data-name') || 'Contact';
      
      if (email && email !== '--') {
        // Create mailto link to open default mail app
        const subject = encodeURIComponent(`Re: ${name}`);
        const mailtoLink = `mailto:${email}?subject=${subject}`;
        
        // Open default mail app
        window.location.href = mailtoLink;
      } else {
        // If no email, still open mail app without recipient
        window.location.href = 'mailto:';
      }
    });
  }
}

// Function to setup meeting scheduler
function setupMeetingScheduler() {
  const meetingBtn = document.getElementById('schedule-meeting-btn');
  if (meetingBtn) {
    meetingBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const email = meetingBtn.getAttribute('data-email');
      const name = meetingBtn.getAttribute('data-name') || 'Contact';
      
      if (email && email !== '--') {
        // Create Google Calendar link with meeting details
        const subject = encodeURIComponent(`Meeting with ${name}`);
        const details = encodeURIComponent(`Meeting scheduled with ${name}\nEmail: ${email}`);
        const googleCalendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${subject}&details=${details}&dates=&add=${encodeURIComponent(email)}`;
        
        // Open in new tab
        window.open(googleCalendarUrl, '_blank');
      } else {
        // If no email, still open calendar but without attendee
        const subject = encodeURIComponent(`Meeting with ${name}`);
        const details = encodeURIComponent(`Meeting scheduled with ${name}`);
        const googleCalendarUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${subject}&details=${details}&dates=`;
        
        window.open(googleCalendarUrl, '_blank');
      }
    });
  }
}

// Make the "About this contact" section collapsible, mirroring the notes/tickets/
// tasks/deals header pattern. Safe to call repeatedly (binds once per header).
function setupAboutCollapsible() {
  const aboutSection = document.querySelector('#hubspot-sidebar .about-section');
  if (!aboutSection) return;
  const header = aboutSection.querySelector('.about-header');
  const content = aboutSection.querySelector('.contact-info');
  const chevron = aboutSection.querySelector('.about-header .chevron-icon');
  if (!header || !content) return;
  if (header.dataset.collapsibleBound === 'true') return;
  header.dataset.collapsibleBound = 'true';
  header.style.cursor = 'pointer';

  // Expanded by default — point the chevron up to match the other sections.
  if (chevron) chevron.style.transform = 'rotate(180deg)';

  header.addEventListener('click', (e) => {
    // Ignore clicks on interactive controls inside the header (e.g. editable selects).
    if (e.target.closest('select, button, a, input')) return;
    const isExpanded = content.style.display !== 'none';
    content.style.display = isExpanded ? 'none' : 'block';
    if (chevron) chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(180deg)';
  });
}

// Cache of HubSpot enumeration property options keyed by property name.
const contactPropertyOptionsCache = {};
async function fetchContactPropertyOptions(property) {
  if (contactPropertyOptionsCache[property]) return contactPropertyOptionsCache[property];
  try {
    const resp = await sendExtensionMessage({ action: 'getContactPropertyOptions', property });
    const options = resp?.success ? (resp.options || []) : [];
    if (options.length) contactPropertyOptionsCache[property] = options;
    return options;
  } catch (e) {
    console.warn('[Content] Could not fetch property options for', property, e);
    return [];
  }
}

async function updateHubSpotContact(contactId, properties) {
  return sendExtensionMessage({ action: 'updateContact', contactId, properties });
}

// Turn the lifecycle-stage / lead-status <select>s in the About section into live
// editors: populate their options from HubSpot and PATCH the contact on change.
function setupEditableContactFields() {
  const selects = document.querySelectorAll('#hubspot-sidebar .editable-contact-field');
  selects.forEach((select) => {
    if (select.dataset.editBound === 'true') return;
    select.dataset.editBound = 'true';
    const property = select.getAttribute('data-property');
    const contactId = select.getAttribute('data-contact-id');
    const current = select.getAttribute('data-current') || '';

    // Populate options from HubSpot (re-labels the current value too).
    fetchContactPropertyOptions(property).then((options) => {
      if (options && options.length) {
        select.innerHTML = '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '--';
        select.appendChild(blank);
        options.forEach((opt) => {
          const o = document.createElement('option');
          o.value = opt.value;
          o.textContent = opt.label;
          select.appendChild(o);
        });
        select.value = current;
      }
    });

    // Persist changes to HubSpot.
    select.addEventListener('change', async () => {
      const newValue = select.value;
      const previous = select.getAttribute('data-current') || '';
      if (newValue === previous) return;
      select.disabled = true;
      select.classList.remove('edit-saved', 'edit-error');
      try {
        const resp = await updateHubSpotContact(contactId, { [property]: newValue });
        if (resp && resp.success) {
          select.setAttribute('data-current', newValue);
          select.classList.add('edit-saved');
          setTimeout(() => select.classList.remove('edit-saved'), 1500);
          // Keep cached contact data in sync so a soft refresh shows the new value.
          if (currentContactData && currentContactData.properties) {
            currentContactData.properties[property] = newValue;
          }
        } else {
          throw new Error(resp?.error || 'Update failed');
        }
      } catch (e) {
        console.error('[Content] Failed to update contact property:', e);
        select.value = previous; // revert on failure
        select.classList.add('edit-error');
        setTimeout(() => select.classList.remove('edit-error'), 2000);
      } finally {
        select.disabled = false;
      }
    });
  });
}

// Cache of HubSpot owner id -> display name, built once per session.
let hubspotOwnerNameCache = null;
function ownerDisplayName(o) {
  if (!o) return null;
  const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
  return name || o.email || o.fullName || null;
}
async function getHubspotOwnerNameMap() {
  if (hubspotOwnerNameCache) return hubspotOwnerNameCache;
  const owners = await fetchHubSpotOwners();
  const map = {};
  (owners || []).forEach((o) => {
    map[String(o.id)] = ownerDisplayName(o) || String(o.id);
  });
  hubspotOwnerNameCache = map;
  return map;
}

// Resolve one owner id directly (covers archived owners / portals with >100 owners).
async function resolveOwnerNameById(id) {
  try {
    const resp = await sendExtensionMessage({ action: 'getOwnerById', ownerId: id });
    const name = ownerDisplayName(resp?.owner);
    if (name && hubspotOwnerNameCache) hubspotOwnerNameCache[String(id)] = name;
    return name;
  } catch {
    return null;
  }
}

// Replace any "Loading…" owner placeholders in the About section with the owner's name.
async function setupOwnerNameResolution() {
  const nodes = document.querySelectorAll('#hubspot-sidebar .owner-value[data-owner-id]');
  if (!nodes.length) return;
  let map = {};
  try {
    map = await getHubspotOwnerNameMap();
  } catch (e) {
    console.warn('[Content] Could not load owners list:', e);
  }
  for (const node of nodes) {
    const id = node.getAttribute('data-owner-id') || '';
    if (!id) { node.textContent = 'Unassigned'; continue; }
    if (map[id]) { node.textContent = map[id]; continue; }
    // Not in the active list — resolve this owner individually.
    const name = await resolveOwnerNameById(id);
    node.textContent = name || `Owner #${id}`;
  }
}

// ---- Recent activity timeline (real HubSpot engagements) ----
const ACTIVITY_META = {
  // HubSpot engagement types
  note: { label: 'Note', cls: 'note' },
  call: { label: 'Call', cls: 'call' },
  email: { label: 'Email', cls: 'email' },
  meeting: { label: 'Meeting', cls: 'meeting' },
  task: { label: 'Task', cls: 'task' },
  // Legacy extension-log types (kept for backward compatibility)
  contact_created: { label: 'Contact created', cls: 'contact' },
  note_created: { label: 'Note added', cls: 'note' },
  ticket_created: { label: 'Ticket created', cls: 'ticket' },
  task_created: { label: 'Task created', cls: 'task' },
  deal_created: { label: 'Deal created', cls: 'deal' },
};

function activityRelativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.round(diffMin / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function activityIconSvg(cls) {
  switch (cls) {
    case 'note':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
    case 'call':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>';
    case 'email':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>';
    case 'meeting':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';
    case 'ticket':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 9a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9z"></path><path d="M8 9v6"></path><path d="M16 9v6"></path></svg>';
    case 'task':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>';
    case 'deal':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>';
    case 'contact':
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
    default:
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
  }
}

function renderActivityItem(act, contactId) {
  const type = act.type || act.activity_type;
  const meta = ACTIVITY_META[type] || {
    label: String(type || 'Activity').replace(/_/g, ' '),
    cls: 'default',
  };
  const title = act.title || meta.label;
  const time = activityRelativeTime(act.timestamp || act.created_at);
  // Engagements (calls/emails/meetings/notes/tasks) have no standalone record page in
  // HubSpot — they live on the associated record's timeline. So link to the CONTACT
  // record (where this activity appears) rather than a non-existent engagement page.
  const link = hubSpotOpenLink('contact', contactId, 'Open contact timeline in HubSpot');
  return `
    <div class="activity-item">
      <div class="activity-icon activity-icon-${meta.cls}">${activityIconSvg(meta.cls)}</div>
      <div class="activity-body">
        <div class="activity-title">${escapeHtml(String(title))}</div>
        <div class="activity-meta">${escapeHtml(meta.label)}${time ? ' · ' + time : ''}</div>
      </div>
      ${link}
    </div>`;
}

async function loadRecentActivities(contactId, section) {
  const list = section.querySelector('.activities-list');
  const countEl = section.querySelector('.activities-count');
  if (!list) return;
  // Skeleton while loading
  list.innerHTML =
    '<div class="activity-skeleton"></div>'.repeat(3);
  try {
    // Pull the contact's real HubSpot engagement timeline.
    const resp = await sendExtensionMessage({ action: 'getContactActivities', contactId, limit: 20 });
    const activities = resp?.success ? (resp.activities || []) : [];
    if (countEl) countEl.textContent = String(activities.length);
    list.innerHTML = activities.length
      ? activities.map((a) => renderActivityItem(a, contactId)).join('')
      : '<div class="activities-empty">No recent activity yet.</div>';
  } catch (e) {
    console.warn('[Content] Could not load activities:', e);
    list.innerHTML = '<div class="activities-empty">Could not load activity.</div>';
  }
}

// Set up the Recent activity section: collapsible header + initial load. Expanded by default.
function setupActivitiesSection() {
  const section = document.querySelector('.activities-section');
  if (!section) return;
  const header = section.querySelector('.activities-header');
  const content = section.querySelector('.activities-content');
  const chevron = section.querySelector('.activities-chevron');
  const contactId = section.getAttribute('data-contact-id');

  if (content) content.style.display = 'block';
  if (chevron) chevron.style.transform = 'rotate(180deg)';

  if (header && header.dataset.bound !== 'true') {
    header.dataset.bound = 'true';
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      const expanded = content.style.display !== 'none';
      content.style.display = expanded ? 'none' : 'block';
      if (chevron) chevron.style.transform = expanded ? 'rotate(0deg)' : 'rotate(180deg)';
    });
  }

  loadRecentActivities(contactId, section);
}

// Function to setup notes section
function setupNotesSection() {
  const notesSection = document.querySelector('.notes-section');
  if (!notesSection) return;
  
  const contactId = notesSection.getAttribute('data-contact-id');
  const notesHeader = notesSection.querySelector('.notes-header');
  const notesContent = notesSection.querySelector('.notes-content');
  const notesChevron = notesSection.querySelector('.notes-chevron');
  
  // Toggle expand/collapse on header click
  if (notesHeader) {
    notesHeader.addEventListener('click', (e) => {
      // Don't toggle if clicking on action buttons
      if (e.target.closest('.notes-header-actions')) {
        return;
      }
      
      const isExpanded = notesContent.style.display !== 'none';
      
      if (!isExpanded) {
        // Expanding - load notes if not already loaded
        if (!notesSection.dataset.notesLoaded) {
          loadContactNotes(contactId, notesSection);
        }
        notesContent.style.display = 'block';
        notesChevron.style.transform = 'rotate(180deg)';
      } else {
        // Collapsing
        notesContent.style.display = 'none';
        notesChevron.style.transform = 'rotate(0deg)';
      }
    });
  }
  
  // Setup add note button
  const addBtn = notesSection.querySelector('#notes-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const contactName = addBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = addBtn.getAttribute('data-email') || '';
      const contactId = addBtn.getAttribute('data-contact-id') || '';
      // Open note creation modal
      showNoteModal(contactName, contactEmail, contactId);
    });
  }
}

// Function to refresh notes count only (without loading full list)
async function refreshNotesCount(contactId, notesSection) {
  try {
    // Ensure contactId is a string
    const contactIdStr = contactId ? String(contactId) : null;
    
    if (!contactIdStr) {
      const notesCount = notesSection.querySelector('.notes-count');
      if (notesCount) {
        notesCount.textContent = '0';
      }
      return 0;
    }
    
    const response = await sendExtensionMessage({
      action: 'fetchContactNotes',
      contactId: contactIdStr
    });
    
    if (response && response.success && response.data) {
      const count = response.data.length || 0;
      const notesCount = notesSection.querySelector('.notes-count');
      if (notesCount) {
        notesCount.textContent = count;
      }
      return count;
    } else {
      // Set count to 0 if fetch failed
      const notesCount = notesSection.querySelector('.notes-count');
      if (notesCount) {
        notesCount.textContent = '0';
      }
      return 0;
    }
  } catch (error) {
    console.error('[Content] Error refreshing notes count:', error);
    // Set count to 0 on error
    const notesCount = notesSection.querySelector('.notes-count');
    if (notesCount) {
      notesCount.textContent = '0';
    }
    return 0;
  }
}

// Function to load contact notes
async function loadContactNotes(contactId, notesSection) {
  const notesLoading = notesSection.querySelector('.notes-loading');
  const notesList = notesSection.querySelector('.notes-list');
  const notesEmpty = notesSection.querySelector('.notes-empty');
  const notesCount = notesSection.querySelector('.notes-count');
  
  try {
    // Show loading state
    notesLoading.style.display = 'block';
    notesList.innerHTML = '';
    notesEmpty.style.display = 'none';
    
    // Fetch notes from background script
    const response = await sendExtensionMessage({
      action: 'fetchContactNotes',
      contactId: contactId
    });
    
    notesLoading.style.display = 'none';
    
    if (response && response.success && response.data) {
      const notes = response.data;
      
      // Update count
      if (notesCount) {
        notesCount.textContent = notes.length;
      }
      
      if (notes.length === 0) {
        notesEmpty.style.display = 'block';
        // Setup create note button in empty state
        setupNotesEmptyCreateButton(notesSection);
      } else {
        // Display notes
        notesList.innerHTML = notes.map(note => formatNoteItem(note)).join('');
        
        // Setup collapsible functionality for each note
        setupNoteCollapsibles(notesList);
      }
      
      notesSection.dataset.notesLoaded = 'true';
    } else {
      notesEmpty.style.display = 'block';
      // Show create note button instead of error message
      setupNotesEmptyCreateButton(notesSection);
    }
  } catch (error) {
    console.error('[Content] Error loading notes:', error);
    notesLoading.style.display = 'none';
    notesEmpty.style.display = 'block';
    // Show create note button instead of error message
    setupNotesEmptyCreateButton(notesSection);
  }
}

// Function to setup create note button in empty notes state
function setupNotesEmptyCreateButton(notesSection) {
  const notesEmpty = notesSection.querySelector('.notes-empty');
  if (!notesEmpty) return;
  
  const contactId = notesSection.getAttribute('data-contact-id');
  
  // Get contact details from the sidebar (within the hubspot-sidebar context)
  const sidebar = document.getElementById('hubspot-sidebar');
  const contactHeader = sidebar?.querySelector('.contact-name-section h3');
  const contactEmailElement = sidebar?.querySelector('.email-link');
  const noteBtn = sidebar?.querySelector('#create-note-btn');
  
  // Try to get from note button data attributes first (most reliable)
  let contactName = noteBtn?.getAttribute('data-name') || contactHeader?.textContent?.trim() || 'Contact';
  let contactEmail = noteBtn?.getAttribute('data-email') || contactEmailElement?.textContent?.trim() || '';
  
  // Update or create the empty state content with create button
  notesEmpty.innerHTML = `
    <div class="notes-empty-content">
      <p class="notes-empty-text">No notes found for this contact.</p>
      <button class="notes-create-btn" id="notes-empty-create-btn" data-contact-id="${contactId}" data-name="${contactName}" data-email="${contactEmail}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
        <span>Create Note</span>
      </button>
    </div>
  `;
  
  // Setup click handler for create note button
  const createBtn = notesEmpty.querySelector('#notes-empty-create-btn');
  if (createBtn) {
    createBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = createBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = createBtn.getAttribute('data-email') || '';
      const contactId = createBtn.getAttribute('data-contact-id') || '';
      
      console.log('[Content] Create note button clicked from empty state');
      console.log('[Content] Contact:', contactName, contactEmail, contactId);
      
      // Open note creation modal (same as Note avatar button)
      showNoteModal(contactName, contactEmail, contactId);
    });
  }
}

// Function to format a single note item
function formatNoteItem(note) {
  const metadata = note.metadata || {};
  
  // Check for note content in multiple possible fields (in order of preference)
  // The backend now returns: note.metadata?.note_text (mapped to body), noteContent, and noteHtml
  // Priority: noteHtml > noteContent > body (mapped from metadata.note_text) > metadata.note_text > description
  let noteContent = '';
  
  // First check for HTML content (preferred for rich formatting)
  if (note.noteHtml && note.noteHtml.trim()) {
    noteContent = note.noteHtml;
  }
  // Then check noteContent field
  else if (note.noteContent && note.noteContent.trim()) {
    noteContent = note.noteContent;
  }
  // Then check body (which backend maps from metadata.note_text)
  else if (note.body && note.body.trim()) {
    noteContent = note.body;
  }
  // Then check metadata.note_text directly
  else if (metadata.note_text && metadata.note_text.trim()) {
    noteContent = metadata.note_text;
  }
  // Then check metadata.body
  else if (metadata.body && metadata.body.trim()) {
    noteContent = metadata.body;
  }
  // Then check description
  else if (note.description && note.description.trim()) {
    noteContent = note.description;
  }
  
  // If we still don't have content, check if it's HTML by looking for tags
  if (!noteContent && (note.body || metadata.note_text || note.description)) {
    const potentialContent = note.body || metadata.note_text || note.description || '';
    if (potentialContent.includes('<') && potentialContent.includes('>')) {
      noteContent = potentialContent;
    }
  }
  
  // Trim the content
  noteContent = typeof noteContent === 'string' ? noteContent.trim() : String(noteContent || '').trim();
  
  // Final fallback
  const noteText = noteContent || 'No content';
  
  // Debug logging to help troubleshoot (only log if we couldn't find content)
  if (noteText === 'No content') {
    console.log('[Content] Note has no content:', {
      noteId: note.id,
      hasNoteContent: !!note.noteContent,
      hasNoteHtml: !!note.noteHtml,
      hasBody: !!note.body,
      hasMetadataNoteText: !!metadata.note_text,
      hasMetadataBody: !!metadata.body,
      hasDescription: !!note.description,
      metadataKeys: metadata ? Object.keys(metadata) : [],
      noteKeys: Object.keys(note)
    });
  }
  
  const createdAt = note.created_at || note.createdAt || new Date().toISOString();
  
  // Format date
  let formattedDate = '--';
  try {
    const date = new Date(createdAt);
    if (!isNaN(date.getTime())) {
      formattedDate = date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short'
      });
    }
  } catch (e) {
    console.error('Error formatting date:', e);
  }
  
  // Truncate title if too long
  const title = note.title || 'Note created via WhatsApp';
  const truncatedTitle = title.length > 30 ? title.substring(0, 27) + '...' : title;
  
  return `
    <div class="note-item">
      <div class="note-item-header">
        <div class="note-item-left">
          <svg class="note-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          <svg class="note-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span class="note-title"><strong>Note</strong> ${truncatedTitle}</span>
        </div>
        <div class="note-item-right">
          <span class="note-date">${formattedDate}</span>
          ${hubSpotOpenLink('note', note.id, 'Open note in HubSpot')}
        </div>
      </div>
      <div class="note-item-content" style="display: none;">
        ${noteText}
      </div>
    </div>
  `;
}

// Function to setup collapsible functionality for note items
function setupNoteCollapsibles(notesList) {
  const noteItems = notesList.querySelectorAll('.note-item');
  noteItems.forEach(item => {
    const header = item.querySelector('.note-item-header');
    const content = item.querySelector('.note-item-content');
    const chevron = item.querySelector('.note-chevron');
    
    if (header && content) {
      header.addEventListener('click', () => {
        const isExpanded = content.style.display !== 'none';
        content.style.display = isExpanded ? 'none' : 'block';
        chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
      });
    }
  });
}

// Function to setup collapsible functionality for task items
function setupTaskCollapsibles(tasksList) {
  const taskItems = tasksList.querySelectorAll('.task-item');
  taskItems.forEach(item => {
    const header = item.querySelector('.task-item-header');
    const content = item.querySelector('.task-item-content');
    const chevron = item.querySelector('.task-chevron');
    
    if (header && content) {
      header.addEventListener('click', () => {
        const isExpanded = content.style.display !== 'none';
        content.style.display = isExpanded ? 'none' : 'block';
        chevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(90deg)';
      });
    }
  });
}

// Function to setup collapsible functionality for ticket items
// Function to setup tickets section
function setupTicketsSection() {
  const ticketsSection = document.querySelector('.tickets-section');
  if (!ticketsSection) return;
  
  const contactId = ticketsSection.getAttribute('data-contact-id');
  const ticketsHeader = ticketsSection.querySelector('.tickets-header');
  const ticketsContent = ticketsSection.querySelector('.tickets-content');
  const ticketsChevron = ticketsSection.querySelector('.tickets-chevron');
  
  // Toggle expand/collapse on header click
  if (ticketsHeader) {
    ticketsHeader.addEventListener('click', (e) => {
      // Don't toggle if clicking on action buttons
      if (e.target.closest('.tickets-header-actions')) {
        return;
      }
      
      const isExpanded = ticketsContent.style.display !== 'none';
      
      if (!isExpanded) {
        // Expanding - load tickets if not already loaded
        if (!ticketsSection.dataset.ticketsLoaded) {
          loadContactTickets(contactId, ticketsSection);
        }
        ticketsContent.style.display = 'block';
        ticketsChevron.style.transform = 'rotate(180deg)';
      } else {
        // Collapsing
        ticketsContent.style.display = 'none';
        ticketsChevron.style.transform = 'rotate(0deg)';
      }
    });
  }
  
  // Setup add ticket button
  const addBtn = ticketsSection.querySelector('#tickets-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const contactName = addBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = addBtn.getAttribute('data-email') || '';
      const contactId = addBtn.getAttribute('data-contact-id') || '';
      showTicketModal(contactName, contactEmail, contactId);
    });
  }
  
  // Setup empty state create button
  const emptyCreateBtn = ticketsSection.querySelector('#tickets-empty-create-btn');
  if (emptyCreateBtn) {
    emptyCreateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = emptyCreateBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = emptyCreateBtn.getAttribute('data-email') || '';
      const contactId = emptyCreateBtn.getAttribute('data-contact-id') || '';
      showTicketModal(contactName, contactEmail, contactId);
    });
  }
  
  // Setup "View all associated Tickets" button
  const viewAllBtn = ticketsSection.querySelector('#tickets-view-all-btn');
  if (viewAllBtn) {
    viewAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = viewAllBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = viewAllBtn.getAttribute('data-email') || '';
      const contactId = viewAllBtn.getAttribute('data-contact-id') || '';
      // Open modal with "Add existing" tab active
      showTicketModal(contactName, contactEmail, contactId, 'add-existing');
    });
  }
}

// Function to setup tasks section
function setupTasksSection() {
  const tasksSection = document.querySelector('.tasks-section');
  if (!tasksSection) return;
  
  const contactId = tasksSection.getAttribute('data-contact-id');
  const tasksHeader = tasksSection.querySelector('.tasks-header');
  const tasksContent = tasksSection.querySelector('.tasks-content');
  const tasksChevron = tasksSection.querySelector('.tasks-chevron');
  
  // Toggle expand/collapse on header click
  if (tasksHeader) {
    tasksHeader.addEventListener('click', (e) => {
      // Don't toggle if clicking on action buttons
      if (e.target.closest('.tasks-header-actions')) {
        return;
      }
      
      const isExpanded = tasksContent.style.display !== 'none';
      
      if (!isExpanded) {
        // Expanding - load tasks if not already loaded
        if (!tasksSection.dataset.tasksLoaded) {
          loadContactTasks(contactId, tasksSection);
        }
        tasksContent.style.display = 'block';
        tasksChevron.style.transform = 'rotate(180deg)';
      } else {
        // Collapsing
        tasksContent.style.display = 'none';
        tasksChevron.style.transform = 'rotate(0deg)';
      }
    });
  }
  
  // Setup add task button
  const addBtn = tasksSection.querySelector('#tasks-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const contactName = addBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = addBtn.getAttribute('data-email') || '';
      const contactId = addBtn.getAttribute('data-contact-id') || '';
      // Open task creation modal
      showTaskModal(contactName, contactEmail, contactId);
    });
  }
  
  // Setup empty state create button
  const emptyCreateBtn = tasksSection.querySelector('#tasks-empty-create-btn');
  if (emptyCreateBtn) {
    emptyCreateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = emptyCreateBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = emptyCreateBtn.getAttribute('data-email') || '';
      const contactId = emptyCreateBtn.getAttribute('data-contact-id') || '';
      // Open task creation modal
      showTaskModal(contactName, contactEmail, contactId);
    });
  }
}

// Function to setup deals section
function setupDealsSection() {
  const dealsSection = document.querySelector('.deals-section');
  if (!dealsSection) return;
  
  const contactId = dealsSection.getAttribute('data-contact-id');
  const dealsHeader = dealsSection.querySelector('.deals-header');
  const dealsContent = dealsSection.querySelector('.deals-content');
  const dealsChevron = dealsSection.querySelector('.deals-chevron');
  
  // Toggle expand/collapse on header click
  if (dealsHeader) {
    dealsHeader.addEventListener('click', (e) => {
      // Don't toggle if clicking on action buttons
      if (e.target.closest('.deals-header-actions')) {
        return;
      }
      
      const isExpanded = dealsContent.style.display !== 'none';
      
      if (!isExpanded) {
        // Expanding - load deals if not already loaded
        if (!dealsSection.dataset.dealsLoaded) {
          loadContactDeals(contactId, dealsSection);
        }
        dealsContent.style.display = 'block';
        dealsChevron.style.transform = 'rotate(180deg)';
      } else {
        // Collapsing
        dealsContent.style.display = 'none';
        dealsChevron.style.transform = 'rotate(0deg)';
      }
    });
  }
  
  // Setup add deal button
  const addBtn = dealsSection.querySelector('#deals-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const contactName = addBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = addBtn.getAttribute('data-email') || '';
      const contactId = addBtn.getAttribute('data-contact-id') || '';
      showDealModal(contactName, contactEmail, contactId);
    });
  }
  
  // Setup empty state create button
  const emptyCreateBtn = dealsSection.querySelector('#deals-empty-create-btn');
  if (emptyCreateBtn) {
    emptyCreateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = emptyCreateBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = emptyCreateBtn.getAttribute('data-email') || '';
      const contactId = emptyCreateBtn.getAttribute('data-contact-id') || '';
      showDealModal(contactName, contactEmail, contactId);
    });
  }
  
  // Initial count refresh
  refreshDealsCount(contactId, dealsSection).catch(error => {
    console.error('[Content] Error refreshing deals count on setup:', error);
  });
}

// Function to refresh tasks count only (without loading full list)
async function refreshTasksCount(contactId, tasksSection) {
  try {
    const contactIdStr = contactId ? String(contactId) : null;
    console.log('[Content] Fetching tasks count for contact:', contactIdStr);
    
    if (!contactIdStr) {
      console.warn('[Content] No contact ID provided for tasks count');
      const tasksCount = tasksSection.querySelector('.tasks-count');
      if (tasksCount) {
        tasksCount.textContent = '0';
      }
      return 0;
    }
    
    const tasks = await fetchTasksFromHubSpot(contactIdStr);
    const count = tasks.length || 0;
    const tasksCount = tasksSection.querySelector('.tasks-count');
    if (tasksCount) {
      tasksCount.textContent = count;
    }
    return count;
  } catch (error) {
    console.error('[Content] Error refreshing tasks count:', error);
    const tasksCount = tasksSection.querySelector('.tasks-count');
    if (tasksCount) {
      tasksCount.textContent = '0';
    }
    return 0;
  }
}

// Function to load and display tasks for a contact
async function loadContactTasks(contactId, tasksSection) {
  if (!tasksSection) return;
  
  const tasksList = tasksSection.querySelector('.tasks-list');
  const tasksLoading = tasksSection.querySelector('.tasks-loading');
  const tasksEmpty = tasksSection.querySelector('.tasks-empty');
  
  if (!tasksList || !tasksLoading || !tasksEmpty) return;
  
  // Show loading state
  tasksLoading.style.display = 'flex';
  tasksList.innerHTML = '';
  tasksEmpty.style.display = 'none';
  
  try {
    const tasks = await fetchTasksFromHubSpot(contactId);
    
    console.log('[Content] Loaded tasks:', tasks);
    console.log('[Content] Tasks type:', typeof tasks);
    console.log('[Content] Is array:', Array.isArray(tasks));
    console.log('[Content] Tasks count:', Array.isArray(tasks) ? tasks.length : 'N/A');
    
    // Ensure tasks is an array
    if (!Array.isArray(tasks)) {
      console.error('[Content] Tasks is not an array:', tasks);
      tasksLoading.style.display = 'none';
      tasksEmpty.style.display = 'block';
      tasksSection.dataset.tasksLoaded = 'true';
      return;
    }
    
    if (tasks.length === 0) {
      tasksLoading.style.display = 'none';
      tasksEmpty.style.display = 'block';
      tasksSection.dataset.tasksLoaded = 'true';
      return;
    }
    
    // Filter tasks to only show those associated with this contact
    // Check if task has association with the contact
    const contactIdStr = String(contactId);
    const filteredTasks = tasks.filter(task => {
      // Check various association fields
      const taskContactId = task.contactId || 
                           task.associatedContactId ||
                           task.associations?.contact?.results?.[0]?.id ||
                           task.associations?.contacts?.results?.[0]?.id ||
                           task.properties?.associatedcontactid ||
                           null;
      
      // If no contact association found, include it (might be unassociated)
      // Or if it matches our contact
      return !taskContactId || String(taskContactId) === contactIdStr;
    });
    
    console.log('[Content] Filtered tasks for contact:', filteredTasks.length, 'out of', tasks.length);
    
    if (filteredTasks.length === 0) {
      tasksLoading.style.display = 'none';
      tasksEmpty.style.display = 'block';
      tasksSection.dataset.tasksLoaded = 'true';
      return;
    }
    
    // Sort tasks by due date (most recent first)
    const sortedTasks = filteredTasks.sort((a, b) => {
      const getDate = (task) => {
        const dueDate = task.dueDate || 
                       task.hs_timestamp || 
                       task.properties?.hs_timestamp || 
                       task.properties?.hs_task_due_date ||
                       task.createdAt || 
                       0;
        try {
          // ISO strings first (HubSpot v3 default); only treat purely-numeric values as epoch ms.
          let date = new Date(dueDate);
          if (isNaN(date.getTime()) && /^\d+$/.test(String(dueDate).trim())) {
            date = new Date(parseInt(String(dueDate).trim(), 10));
          }
          return isNaN(date.getTime()) ? new Date(0) : date;
        } catch (e) {
          return new Date(0);
        }
      };
      return getDate(b) - getDate(a); // Most recent first
    });
    
    console.log('[Content] Sorted tasks:', sortedTasks);
    
    // Render tasks directly without month grouping
    let tasksHTML = '';
    sortedTasks.forEach(task => {
      tasksHTML += formatTaskItem(task);
    });
    
    tasksList.innerHTML = tasksHTML;
    // Setup collapsible functionality for task items
    setupTaskCollapsibles(tasksList);
    tasksLoading.style.display = 'none';
    tasksSection.dataset.tasksLoaded = 'true';
  } catch (error) {
    console.error('[Content] Error loading tasks:', error);
    console.error('[Content] Error stack:', error.stack);
    tasksLoading.style.display = 'none';
    tasksEmpty.style.display = 'block';
  }
}

// Function to group tasks by month/year
function groupTasksByMonth(tasks) {
  const grouped = {};
  
  tasks.forEach(task => {
    // Try to get due date from various possible fields
    const dueDate = task.dueDate || 
                   task.hs_timestamp || 
                   task.properties?.hs_timestamp || 
                   task.properties?.hs_task_due_date ||
                   task.createdAt || 
                   Date.now();
    
    let dateObj;
    try {
      // HubSpot CRM v3 returns datetimes as ISO strings; only treat purely-numeric values as epoch ms.
      dateObj = new Date(dueDate);
      if (isNaN(dateObj.getTime()) && /^\d+$/.test(String(dueDate).trim())) {
        dateObj = new Date(parseInt(String(dueDate).trim(), 10));
      }
      if (isNaN(dateObj.getTime())) {
        dateObj = new Date();
      }
    } catch (e) {
      dateObj = new Date();
    }
    
    const monthYear = dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    
    if (!grouped[monthYear]) {
      grouped[monthYear] = [];
    }
    grouped[monthYear].push(task);
  });
  
  // Sort tasks within each month by due date
  Object.keys(grouped).forEach(monthYear => {
    grouped[monthYear].sort((a, b) => {
      const getDate = (task) => {
        const dueDate = task.dueDate || 
                       task.hs_timestamp || 
                       task.properties?.hs_timestamp || 
                       task.properties?.hs_task_due_date ||
                       task.createdAt || 
                       0;
        try {
          // ISO strings first (HubSpot v3 default); only treat purely-numeric values as epoch ms.
          let date = new Date(dueDate);
          if (isNaN(date.getTime()) && /^\d+$/.test(String(dueDate).trim())) {
            date = new Date(parseInt(String(dueDate).trim(), 10));
          }
          return isNaN(date.getTime()) ? new Date(0) : date;
        } catch (e) {
          return new Date(0);
        }
      };
      return getDate(a) - getDate(b);
    });
  });
  
  return grouped;
}

// Function to format a single task item
function formatTaskItem(task) {
  console.log('[Content] Formatting task:', task);
  
  // Handle different date field names from HubSpot
  // Use created date for display (like notes)
  const createdAt = task.createdAt || 
                    task.properties?.createdate || 
                    task.properties?.hs_createdate ||
                    new Date().toISOString();
  
  // Format date (same format as notes)
  let formattedDate = '--';
  try {
    const date = new Date(createdAt);
    if (!isNaN(date.getTime())) {
      formattedDate = date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short'
      });
    }
  } catch (e) {
    console.error('Error formatting date:', e);
  }
  
  // Handle different name/subject field names
  const taskName = task.name || task.subject || task.properties?.hs_task_subject || task.properties?.subject || 'Untitled Task';
  
  // Clean task name - remove HTML tags
  const cleanTaskName = taskName.replace(/<[^>]*>/g, '').trim();
  
  // Truncate title if too long (same as notes)
  const truncatedTitle = cleanTaskName.length > 30 ? cleanTaskName.substring(0, 27) + '...' : cleanTaskName;
  
  // Handle different notes/body field names for collapsible content
  const taskNotes = task.notes || task.body || task.properties?.hs_task_body || task.properties?.notes || task.properties?.description || '';
  
  // Get task ID
  const taskId = task.id || task.hs_object_id || task.properties?.hs_object_id || '';
  
  return `
    <div class="task-item" data-task-id="${taskId}">
      <div class="task-item-header">
        <div class="task-item-left">
          <svg class="task-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
          <svg class="task-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span class="task-title"><strong>Task</strong> ${truncatedTitle}</span>
        </div>
        <div class="task-item-right">
          <span class="task-date">${formattedDate}</span>
          ${hubSpotOpenLink('task', taskId, 'Open task in HubSpot')}
        </div>
      </div>
      <div class="task-item-content" style="display: none;">
        ${taskNotes || 'No description'}
      </div>
    </div>
  `;
}

// Function to fetch tasks from HubSpot
async function fetchTasksFromHubSpot(contactId) {
  try {
    console.log('[Content] Fetching tasks for contact:', contactId);
    
    const response = await sendExtensionMessage({
      action: 'getHubSpotTasks',
      contactId: contactId
    });
    
    if (response && response.success) {
      console.log('[Content] ✅ Tasks fetched successfully');
      console.log('[Content] Response data type:', typeof response.data);
      console.log('[Content] Response data:', response.data);
      
      // Ensure we return an array
      let tasks = response.data || [];
      
      // If it's an object, try to extract an array from common structures
      if (tasks && typeof tasks === 'object' && !Array.isArray(tasks)) {
        // Try common response structures
        tasks = tasks.results || tasks.data || tasks.items || tasks.tasks || [];
        
        // If still not an array, try to convert object values to array
        if (!Array.isArray(tasks)) {
          tasks = Object.values(tasks);
        }
        
        // If still not an array, return empty array
        if (!Array.isArray(tasks)) {
          console.warn('[Content] Could not extract array from response, returning empty array');
          tasks = [];
        }
      }
      
      console.log('[Content] Final tasks array:', tasks);
      console.log('[Content] Tasks array length:', tasks.length);
      
      return Array.isArray(tasks) ? tasks : [];
    } else {
      console.error('[Content] ❌ Failed to fetch tasks:', response?.error);
      return [];
    }
  } catch (error) {
    console.error('[Content] ❌ Error fetching tasks:', error);
    return [];
  }
}

// Function to refresh tickets count only (without loading full list)
async function refreshTicketsCount(contactId, ticketsSection) {
  try {
    const contactIdStr = contactId ? String(contactId) : null;
    console.log('[Content] Fetching tickets count for contact:', contactIdStr);
    
    if (!contactIdStr) {
      console.warn('[Content] No contact ID provided for tickets count');
      const ticketsCount = ticketsSection.querySelector('.tickets-count');
      if (ticketsCount) {
        ticketsCount.textContent = '0';
      }
      return 0;
    }
    
    const tickets = await fetchTicketsFromHubSpot(contactIdStr);
    const count = tickets.length || 0;
    const ticketsCount = ticketsSection.querySelector('.tickets-count');
    if (ticketsCount) {
      ticketsCount.textContent = count;
    }
    return count;
  } catch (error) {
    console.error('[Content] Error refreshing tickets count:', error);
    const ticketsCount = ticketsSection.querySelector('.tickets-count');
    if (ticketsCount) {
      ticketsCount.textContent = '0';
    }
    throw error;
  }
}

// Function to refresh deals count only (without loading full list)
async function refreshDealsCount(contactId, dealsSection) {
  try {
    const contactIdStr = contactId ? String(contactId) : null;
    console.log('[Content] Fetching deals count for contact:', contactIdStr);
    
    if (!contactIdStr) {
      console.warn('[Content] No contact ID provided for deals count');
      const dealsCount = dealsSection.querySelector('.deals-count');
      if (dealsCount) {
        dealsCount.textContent = '0';
      }
      return 0;
    }
    
    const deals = await fetchDealsFromHubSpot(contactIdStr);
    const count = deals.length || 0;
    const dealsCount = dealsSection.querySelector('.deals-count');
    if (dealsCount) {
      dealsCount.textContent = count;
    }
    return count;
  } catch (error) {
    console.error('[Content] Error refreshing deals count:', error);
    const dealsCount = dealsSection.querySelector('.deals-count');
    if (dealsCount) {
      dealsCount.textContent = '0';
    }
    throw error;
  }
}

// Function to load contact deals
async function loadContactDeals(contactId, dealsSection) {
  const dealsLoading = dealsSection.querySelector('.deals-loading');
  const dealsList = dealsSection.querySelector('.deals-list');
  const dealsEmpty = dealsSection.querySelector('.deals-empty');
  const dealsCount = dealsSection.querySelector('.deals-count');
  
  try {
    console.log('[Content] ===== LOADING CONTACT DEALS =====');
    console.log('[Content] Contact ID:', contactId, '(type:', typeof contactId, ')');
    console.log('[Content] Deals Section:', dealsSection);
    
    // Get contactId from section attribute as well (for validation)
    const sectionContactId = dealsSection.getAttribute('data-contact-id');
    console.log('[Content] Section Contact ID:', sectionContactId);
    
    if (contactId !== sectionContactId && String(contactId) !== String(sectionContactId)) {
      console.warn('[Content] ⚠️ Contact ID mismatch! Function param:', contactId, 'vs Section attr:', sectionContactId);
    }
    
    // Show loading state
    dealsLoading.style.display = 'block';
    dealsList.innerHTML = '';
    dealsEmpty.style.display = 'none';
    
    // Fetch deals from HubSpot
    const deals = await fetchDealsFromHubSpot(contactId);
    
    console.log('[Content] Deals received:', deals.length);
    
    dealsLoading.style.display = 'none';
    
    // Update count
    if (dealsCount) {
      dealsCount.textContent = deals.length;
    }
    
    if (deals.length === 0) {
      console.log('[Content] No deals found, showing empty state');
      dealsEmpty.style.display = 'block';
      // Setup create deal button in empty state
      setupDealsEmptyCreateButton(dealsSection);
    } else {
      console.log('[Content] Displaying', deals.length, 'deals');
      // Resolve human stage labels (not raw internal ids) before rendering.
      await ensureDealStageLabels();
      // Display deals
      dealsList.innerHTML = deals.map(deal => formatDealItem(deal)).join('');
      
      // Auto-expand the deals section to show the deals
      const dealsContent = dealsSection.querySelector('.deals-content');
      const dealsChevron = dealsSection.querySelector('.deals-chevron');
      if (dealsContent && dealsChevron) {
        dealsContent.style.display = 'block';
        dealsChevron.style.transform = 'rotate(180deg)';
      }
    }
    
    dealsSection.dataset.dealsLoaded = 'true';
  } catch (error) {
    console.error('[Content] ❌ Error loading deals:', error);
    console.error('[Content] Error stack:', error.stack);
    dealsLoading.style.display = 'none';
    dealsEmpty.style.display = 'block';
    setupDealsEmptyCreateButton(dealsSection);
  }
}

// Function to setup create deal button in empty deals state
function setupDealsEmptyCreateButton(dealsSection) {
  const dealsEmpty = dealsSection.querySelector('.deals-empty');
  if (!dealsEmpty) return;
  
  const contactId = dealsSection.getAttribute('data-contact-id');
  
  const emptyCreateBtn = dealsEmpty.querySelector('#deals-empty-create-btn');
  if (emptyCreateBtn) {
    emptyCreateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = emptyCreateBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = emptyCreateBtn.getAttribute('data-email') || '';
      const contactId = emptyCreateBtn.getAttribute('data-contact-id') || '';
      showDealModal(contactName, contactEmail, contactId);
    });
  }
}

// Function to load contact tickets
async function loadContactTickets(contactId, ticketsSection) {
  const ticketsLoading = ticketsSection.querySelector('.tickets-loading');
  const ticketsList = ticketsSection.querySelector('.tickets-list');
  const ticketsEmpty = ticketsSection.querySelector('.tickets-empty');
  const ticketsCount = ticketsSection.querySelector('.tickets-count');
  
  try {
    // Show loading state
    ticketsLoading.style.display = 'block';
    ticketsList.innerHTML = '';
    ticketsEmpty.style.display = 'none';
    
    // Fetch tickets from HubSpot
    const tickets = await fetchTicketsFromHubSpot(contactId);
    
    ticketsLoading.style.display = 'none';
    
    // Update count
    if (ticketsCount) {
      ticketsCount.textContent = tickets.length;
    }
    
    if (tickets.length === 0) {
      ticketsEmpty.style.display = 'block';
      // Setup create ticket button in empty state
      setupTicketsEmptyCreateButton(ticketsSection);
    } else {
      // Display tickets
      ticketsList.innerHTML = tickets.map(ticket => formatTicketItem(ticket)).join('');
      // Setup association link handlers
      setupTicketAssociationLinks(ticketsSection, contactId);
    }
    
    ticketsSection.dataset.ticketsLoaded = 'true';
  } catch (error) {
    console.error('[Content] Error loading tickets:', error);
    ticketsLoading.style.display = 'none';
    ticketsEmpty.style.display = 'block';
    setupTicketsEmptyCreateButton(ticketsSection);
  }
}

// Function to setup create ticket button in empty tickets state
function setupTicketsEmptyCreateButton(ticketsSection) {
  const ticketsEmpty = ticketsSection.querySelector('.tickets-empty');
  if (!ticketsEmpty) return;
  
  const contactId = ticketsSection.getAttribute('data-contact-id');
  
  // Get contact details from the sidebar
  const sidebar = document.getElementById('hubspot-sidebar');
  const contactHeader = sidebar?.querySelector('.contact-name-section h3');
  const contactEmailElement = sidebar?.querySelector('.email-link');
  const ticketBtn = sidebar?.querySelector('#create-ticket-btn');
  
  let contactName = ticketBtn?.getAttribute('data-name') || contactHeader?.textContent?.trim() || 'Contact';
  let contactEmail = ticketBtn?.getAttribute('data-email') || contactEmailElement?.textContent?.trim() || '';
  
  // Update empty state content with create button
  ticketsEmpty.innerHTML = `
    <div class="tickets-empty-content">
      <p class="tickets-empty-text">No tickets found for this contact.</p>
      <button class="tickets-create-btn" id="tickets-empty-create-btn" data-contact-id="${contactId}" data-name="${contactName}" data-email="${contactEmail}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        <span>Create Ticket</span>
      </button>
    </div>
  `;
  
  // Setup click handler for create ticket button
  const createBtn = ticketsEmpty.querySelector('#tickets-empty-create-btn');
  if (createBtn) {
    createBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const contactName = createBtn.getAttribute('data-name') || 'Contact';
      const contactEmail = createBtn.getAttribute('data-email') || '';
      const contactId = createBtn.getAttribute('data-contact-id') || '';
      showTicketModal(contactName, contactEmail, contactId);
    });
  }
}

// Function to setup ticket association link handlers
function setupTicketAssociationLinks(ticketsSection, contactId) {
  if (!ticketsSection || !contactId) return;
  
  const associationLinks = ticketsSection.querySelectorAll('.ticket-association-link');
  
  associationLinks.forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      
      const ticketId = link.getAttribute('data-ticket-id');
      if (!ticketId) {
        console.error('[Content] No ticket ID found for association link');
        return;
      }
      
      // Check if already processing (prevent multiple clicks)
      if (link.textContent === 'Associating...') {
        return;
      }
      
      // Disable the link temporarily to prevent multiple clicks
      link.style.pointerEvents = 'none';
      link.style.opacity = '0.6';
      const originalText = link.textContent;
      link.textContent = 'Associating...';
      
      try {
        console.log('[Content] Associating ticket:', ticketId, 'with contact:', contactId);
        
        // Associate the ticket with the contact
        await associateTicketsWithContact(contactId, [ticketId]);
        
        // Update the link text to show success
        link.textContent = 'Associated';
        link.style.color = '#25d366';
        link.style.cursor = 'default';
        
        // Refresh the tickets section to update the count
        setTimeout(() => {
          // Refresh tickets count
          refreshTicketsCount(contactId, ticketsSection).catch(error => {
            console.error('[Content] Error refreshing tickets count after association:', error);
          });
          
          // Reload tickets if section is expanded to show updated list
          const ticketsContent = ticketsSection.querySelector('.tickets-content');
          if (ticketsContent && ticketsContent.style.display !== 'none') {
            loadContactTickets(contactId, ticketsSection);
          }
        }, 500);
        
      } catch (error) {
        console.error('[Content] Error associating ticket:', error);
        link.textContent = originalText;
        link.style.color = '#ea580c';
        
        // Show error message
        const errorMsg = error.message || 'Unknown error';
        console.error('[Content] Association error:', errorMsg);
        
        // Re-enable the link after showing error
        setTimeout(() => {
          link.style.pointerEvents = 'auto';
          link.style.opacity = '1';
          link.style.color = '';
          link.textContent = originalText;
        }, 2000);
        
        // Show user-friendly error
        alert(`Failed to associate ticket: ${errorMsg}`);
      }
    });
  });
}

// Function to format a single ticket item
function formatTicketItem(ticket) {
  const ticketId = ticket.id || ticket.hs_object_id || '';
  const ticketName = ticket.properties?.subject || ticket.properties?.hs_ticket_name || 'Untitled Ticket';
  const ticketStatus = ticket.properties?.hs_pipeline_stage || ticket.properties?.hs_ticket_status || 'New';
  const ticketOwner = ticket.properties?.hubspot_owner_id || '--';
  const createdAt = ticket.properties?.createdate || ticket.createdAt || new Date().toISOString();
  
  // Calculate open duration in hours
  let openHours = '--';
  try {
    const createdDate = new Date(createdAt);
    if (!isNaN(createdDate.getTime())) {
      const now = new Date();
      const diffMs = now - createdDate;
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours === 0) {
        const diffMins = Math.floor(diffMs / (1000 * 60));
        openHours = diffMins === 1 ? '1 minute' : `${diffMins} minutes`;
      } else if (diffHours === 1) {
        openHours = '1 hour';
      } else {
        openHours = `${diffHours} hours`;
      }
    }
  } catch (e) {
    console.error('Error calculating open hours:', e);
  }
  
  return `
    <div class="ticket-item" data-ticket-id="${ticketId}">
      <div class="ticket-item-header">
        <div class="ticket-icon-wrapper">
          <svg class="ticket-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
            <circle cx="7" cy="7" r="1.5"></circle>
          </svg>
        </div>
        <div class="ticket-item-title">${ticketName}</div>
        ${hubSpotOpenLink('ticket', ticketId, 'Open ticket in HubSpot')}
      </div>
      <div class="ticket-item-open">Open ${openHours}</div>
      <div class="ticket-item-owner">Ticket owner: ${ticketOwner}</div>
      <div class="ticket-item-status">
        Ticket status: 
        <span class="ticket-status-value">${ticketStatus}</span>
      </div>
    </div>
  `;
}

// Cache of HubSpot deal-stage internal id -> human label, built from the pipelines API.
let dealStageLabelMap = {};
async function ensureDealStageLabels() {
  try {
    if (Object.keys(dealStageLabelMap).length) return; // already loaded this session
    const map = {};

    // Primary source: the dealstage property's enumeration options. This includes every
    // stage id->label across ALL pipelines, so it resolves stages the pipelines API may
    // omit. (e.g. 941294659 -> "Closed won".)
    try {
      const resp = await sendExtensionMessage({
        action: 'getPropertyOptions',
        objectType: 'deals',
        property: 'dealstage',
      });
      (resp?.options || []).forEach((o) => {
        if (o && o.value != null) map[String(o.value)] = o.label || String(o.value);
      });
    } catch (e) {
      console.warn('[Content] dealstage property options unavailable:', e);
    }

    // Fallback / supplement: pipelines API stage labels.
    if (!Object.keys(map).length) {
      const pipelines = await fetchHubSpotDealPipelines();
      (pipelines || []).forEach((p) => {
        (p.stages || []).forEach((s) => {
          if (s && s.id != null) map[String(s.id)] = s.label || String(s.id);
        });
      });
    }

    if (Object.keys(map).length) dealStageLabelMap = map;
  } catch (e) {
    console.warn('[Content] Could not load deal stage labels:', e);
  }
}

// Function to format deal item for display (matching screenshot format)
function formatDealItem(deal) {
  const dealId = deal.id || deal.hs_object_id || '';
  const dealName = deal.properties?.dealname || deal.properties?.name || 'Untitled Deal';
  const dealAmount = deal.properties?.amount || null;
  const currencyCode = deal.properties?.deal_currency_code || deal.properties?.hs_currency_code || null;
  const closeDate = deal.properties?.closedate || deal.properties?.hs_expected_close_date || null;
  const dealStage = deal.properties?.dealstage || '--';

  // Format amount using the deal's real currency — never hard-code a symbol.
  let formattedAmount = '--';
  if (dealAmount) {
    const amount = parseFloat(dealAmount);
    if (!isNaN(amount)) {
      const number = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      formattedAmount = currencyCode ? `${currencyCode} ${number}` : number;
    }
  }

  // Format close date
  let formattedCloseDate = '--';
  if (closeDate) {
    try {
      // HubSpot CRM v3 returns datetimes as ISO strings (e.g. "2026-04-20T06:56:53Z"),
      // not millisecond numbers. Parse the ISO string directly; only fall back to
      // epoch-millis when the value is purely numeric. (parseInt on an ISO string
      // previously yielded "2026" ms -> Jan 1 1970.)
      let date = new Date(closeDate);
      if (isNaN(date.getTime()) && /^\d+$/.test(String(closeDate).trim())) {
        date = new Date(parseInt(String(closeDate).trim(), 10));
      }
      if (!isNaN(date.getTime())) {
        formattedCloseDate = date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
      }
    } catch (e) {
      console.error('Error formatting close date:', e);
    }
  }
  
  // Prefer the server-resolved label (attached by the getDeals edge function), then the
  // client pipeline/property map, then a cleaned fallback — so we never show a raw id.
  const rawStage = String(dealStage);
  const serverStageLabel = deal.properties?.dealstageLabel;
  const formattedStage = serverStageLabel
    || dealStageLabelMap[rawStage]
    || rawStage.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
  
  return `
    <div class="deal-item" data-deal-id="${dealId}">
      <div class="deal-item-header">
        <div class="deal-icon-wrapper">
          <svg class="deal-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <line x1="12" y1="1" x2="12" y2="23" stroke="#1976d2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" stroke="#1976d2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
        </div>
        <div class="deal-item-title">${dealName}</div>
        ${hubSpotOpenLink('deal', dealId, 'Open deal in HubSpot')}
      </div>
      <div class="deal-item-details">
        <div class="deal-item-property">
          <span class="deal-property-label">Amount:</span>
          <span class="deal-property-value">${formattedAmount}</span>
        </div>
        <div class="deal-item-property">
          <span class="deal-property-label">Close Date:</span>
          <span class="deal-property-value">${formattedCloseDate}</span>
        </div>
        <div class="deal-item-property">
          <span class="deal-property-label">Deal Stage:</span>
          <span class="deal-stage-value">
            ${formattedStage}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display: inline-block; margin-left: 4px; vertical-align: middle;">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </span>
        </div>
      </div>
    </div>
  `;
}

// Function to show ticket creation modal
function showTicketModal(contactName, contactEmail, contactId, defaultSegment = 'create-new') {
  // Remove existing modal if any
  const existingModal = document.getElementById('ticket-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // Format contact display name
  // Only show email in parentheses if it exists and is not empty/placeholder
  const hasValidEmail = contactEmail && contactEmail !== '--' && contactEmail.trim() !== '';
  const contactDisplay = contactName && hasValidEmail
    ? `${contactName} (${contactEmail})`
    : contactName || (hasValidEmail ? contactEmail : '') || 'Contact';
  
  // Get today's date in MM/DD/YYYY format
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  });
  
  // Determine which segment should be active
  const isCreateNewActive = defaultSegment === 'create-new';
  const isAddExistingActive = defaultSegment === 'add-existing';
  
  // Determine title based on default segment
  const modalTitle = isAddExistingActive ? 'Add existing Ticket' : 'Create Ticket';
  
  // Create modal HTML
  const modalHTML = `
    <div id="ticket-modal" class="ticket-modal-overlay">
      <div class="ticket-sidebar">
        <div class="ticket-header">
          <div class="ticket-header-title">${modalTitle}</div>
          <button class="ticket-close-btn" title="Close">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        
        <div class="ticket-segments">
          <button class="ticket-segment-btn ${isCreateNewActive ? 'active' : ''}" data-segment="create-new">Create new</button>
          <button class="ticket-segment-btn ${isAddExistingActive ? 'active' : ''}" data-segment="add-existing">Add existing</button>
        </div>
        
        <div class="ticket-form-container">
          <!-- Create new form -->
          <form id="ticket-form" class="ticket-form ticket-form-create" style="display: ${isCreateNewActive ? 'block' : 'none'};">
            <div class="ticket-form-group">
              <label for="ticket-name" class="ticket-label required">Ticket name</label>
              <input type="text" id="ticket-name" name="ticketName" class="ticket-input" required>
            </div>
            
            <div class="ticket-form-group">
              <label for="ticket-pipeline" class="ticket-label required">Pipeline</label>
              <select id="ticket-pipeline" name="pipeline" class="ticket-select" required>
                <option value="support-pipeline" selected>Support Pipeline</option>
                <option value="sales-pipeline">Sales Pipeline</option>
              </select>
            </div>
            
            <div class="ticket-form-group">
              <label for="ticket-status" class="ticket-label required">Ticket status</label>
              <select id="ticket-status" name="status" class="ticket-select" required>
                <option value="new" selected>New</option>
                <option value="open">Open</option>
                <option value="in-progress">In Progress</option>
                <option value="waiting">Waiting</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            
            <div class="ticket-form-group">
              <label for="ticket-description" class="ticket-label">Ticket description</label>
              <textarea id="ticket-description" name="description" class="ticket-textarea" rows="4"></textarea>
            </div>
            
            <div class="ticket-form-group">
              <label for="ticket-source" class="ticket-label">Source</label>
              <select id="ticket-source" name="source" class="ticket-select">
                <option value="">Select source</option>
                <option value="email">Email</option>
                <option value="phone">Phone</option>
                <option value="chat">Chat</option>
                <option value="web">Web</option>
                <option value="social">Social Media</option>
              </select>
            </div>
            
            <div class="ticket-form-group">
              <label for="ticket-owner" class="ticket-label">Ticket owner</label>
              <select id="ticket-owner" name="owner" class="ticket-select">
                <option value="" selected>Loading owners…</option>
              </select>
            </div>
            
            <div class="ticket-form-group">
              <label for="ticket-priority" class="ticket-label">Priority</label>
              <select id="ticket-priority" name="priority" class="ticket-select">
                <option value="">Select priority</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            
            <div class="ticket-form-group">
              <label for="ticket-create-date" class="ticket-label">Create date</label>
              <div class="ticket-date-wrapper">
                <input type="date" id="ticket-create-date" name="createDate" class="ticket-date-input" value="${today.toISOString().split('T')[0]}">
                <span class="ticket-date-display">${formattedDate}</span>
              </div>
            </div>
            
            <div class="ticket-associate-section">
              <div class="ticket-section-title">Associate Ticket with</div>
              
              <div class="ticket-form-group">
                <label class="ticket-label">Contact</label>
                <div class="ticket-contact-tag-wrapper">
                  <div class="ticket-contact-tag" id="ticket-contact-tag">
                    <span>${contactDisplay}</span>
                    <button type="button" class="ticket-tag-remove" id="ticket-contact-remove">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </div>
                  <input type="hidden" id="ticket-contact-id" name="contactId" value="${contactId}">
                  <input type="hidden" id="ticket-contact-name" name="contactName" value="${contactName}">
                  <input type="hidden" id="ticket-contact-email" name="contactEmail" value="${contactEmail}">
                </div>
                <div class="ticket-checkbox-group">
                  <input type="checkbox" id="ticket-add-contact-activity" name="addContactActivity" checked>
                  <label for="ticket-add-contact-activity" class="ticket-checkbox-label">
                    Add timeline activity from ${contactName || 'this contact'} to this Ticket
                    <svg class="ticket-info-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="16" x2="12" y2="12"></line>
                      <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                  </label>
                </div>
              </div>
              
              <div class="ticket-form-group">
                <label class="ticket-label">Company</label>
                <div class="ticket-search-wrapper">
                  <input type="text" id="ticket-company-search" name="companySearch" class="ticket-search-input" placeholder="Search">
                  <svg class="ticket-dropdown-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </div>
                <div class="ticket-checkbox-group">
                  <input type="checkbox" id="ticket-add-company-activity" name="addCompanyActivity">
                  <label for="ticket-add-company-activity" class="ticket-checkbox-label">
                    Add timeline activity from this Company
                    <svg class="ticket-info-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="16" x2="12" y2="12"></line>
                      <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                  </label>
                </div>
              </div>
            </div>
            
            <div class="ticket-form-footer">
              <button type="submit" class="ticket-btn ticket-btn-primary">Create</button>
              <button type="button" class="ticket-btn ticket-btn-secondary" id="ticket-create-another">Create and add another</button>
              <button type="button" class="ticket-btn ticket-btn-cancel" id="ticket-cancel">Cancel</button>
            </div>
          </form>
          
          <!-- Add existing form -->
          <div id="ticket-add-existing-form" class="ticket-form ticket-form-existing" style="display: ${isAddExistingActive ? 'block' : 'none'};">
            <div class="ticket-search-section">
              <div class="ticket-search-wrapper-full">
                <svg class="ticket-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input type="text" id="ticket-search-input" class="ticket-search-input-full" placeholder="Search Tickets">
              </div>
            </div>
            
            <div class="ticket-list-header">
              <div class="ticket-count">
                <span id="ticket-total-count">0</span> <span id="ticket-count-text">Tickets</span>
              </div>
              <select id="ticket-sort-dropdown" class="ticket-sort-select">
                <option value="recently-added" selected>Default (Recently added)</option>
                <option value="oldest-first">Oldest first</option>
                <option value="subject-asc">Subject (A-Z)</option>
                <option value="subject-desc">Subject (Z-A)</option>
                <option value="priority-high">Priority (High to Low)</option>
                <option value="priority-low">Priority (Low to High)</option>
              </select>
            </div>
            
            <div class="ticket-list-container">
              <div id="ticket-list-loading" class="ticket-list-loading" style="display: none;">
                <div class="loading-spinner"></div>
                <p>Loading tickets...</p>
              </div>
              <div id="ticket-list" class="ticket-list">
                <!-- Tickets will be populated here -->
              </div>
              <div id="ticket-list-empty" class="ticket-list-empty" style="display: none;">
                <p>No tickets found. Try adjusting your search.</p>
              </div>
            </div>
            
            <div class="ticket-list-footer">
              <div class="ticket-pagination">
                <span id="ticket-pagination-info">0 items</span>
                <svg class="ticket-pagination-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </div>
            </div>
            
            <div class="ticket-form-footer">
              <button type="button" class="ticket-btn ticket-btn-primary" id="ticket-add-selected-btn" disabled>Save</button>
              <button type="button" class="ticket-btn ticket-btn-cancel" id="ticket-cancel-existing">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Append to body
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Setup handlers
  const modal = document.getElementById('ticket-modal');
  // Populate owner dropdown from real HubSpot owners (never hard-code a name).
  populateDealOwnerSelect(modal, '#ticket-owner').catch((err) =>
    console.warn('[Ticket Modal] Could not load owners:', err)
  );
  const closeBtn = modal.querySelector('.ticket-close-btn');
  const cancelBtn = modal.querySelector('#ticket-cancel');
  const form = modal.querySelector('#ticket-form');
  const createAnotherBtn = modal.querySelector('#ticket-create-another');
  const contactRemoveBtn = modal.querySelector('#ticket-contact-remove');
  const dateInput = modal.querySelector('#ticket-create-date');
  const dateDisplay = modal.querySelector('.ticket-date-display');
  const segmentBtns = modal.querySelectorAll('.ticket-segment-btn');
  const titleElement = modal.querySelector('.ticket-header-title');
  
  // Close modal handlers
  function closeModal() {
    modal.remove();
  }
  
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  
  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });
  
  // Segment button handlers
  const createForm = modal.querySelector('#ticket-form');
  const existingForm = modal.querySelector('#ticket-add-existing-form');
  
  // Setup "Add existing" form handlers first to get load function
  const ticketFormHandlers = setupAddExistingTicketForm(modal, contactId, closeModal);
  
  // If default segment is "add-existing", load tickets immediately
  if (defaultSegment === 'add-existing' && ticketFormHandlers && ticketFormHandlers.loadTickets) {
    ticketFormHandlers.loadTickets(contactId);
  }
  
  segmentBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      segmentBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const segment = btn.getAttribute('data-segment');
      
      // Update title based on segment
      if (titleElement) {
        titleElement.textContent = segment === 'add-existing' ? 'Add existing Ticket' : 'Create Ticket';
      }
      
      // Show/hide forms based on segment
      if (segment === 'create-new') {
        createForm.style.display = 'block';
        existingForm.style.display = 'none';
      } else if (segment === 'add-existing') {
        createForm.style.display = 'none';
        existingForm.style.display = 'block';
        // Load tickets when switching to "Add existing"
        if (ticketFormHandlers && ticketFormHandlers.loadTickets) {
          ticketFormHandlers.loadTickets(contactId);
        }
      }
      
      console.log('Segment changed to:', segment);
    });
  });
  
  // Date input handler
  if (dateInput && dateDisplay) {
    // Make date display clickable to trigger date input
    dateDisplay.addEventListener('click', () => {
      dateInput.click();
    });
    
    dateInput.addEventListener('change', (e) => {
      const selectedDate = new Date(e.target.value);
      const formatted = selectedDate.toLocaleDateString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric'
      });
      dateDisplay.textContent = formatted;
    });
  }
  
  // Contact remove handler
  if (contactRemoveBtn) {
    contactRemoveBtn.addEventListener('click', () => {
      const contactTag = document.getElementById('ticket-contact-tag');
      if (contactTag) {
        contactTag.style.display = 'none';
        document.getElementById('ticket-contact-id').value = '';
        document.getElementById('ticket-contact-name').value = '';
        document.getElementById('ticket-contact-email').value = '';
      }
    });
  }
  
  // Form submit handler
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    
    try {
      // Disable submit button
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';
      
      const formData = new FormData(form);
      const ticketData = Object.fromEntries(formData);
      
      console.log('[Ticket Modal] Form submitted:', ticketData);
      
      // Create ticket in HubSpot
      await createHubSpotTicket(ticketData, contactId);
      
      // Show success
      console.log('[Ticket Modal] ✅ Ticket created successfully!');
      
      // Close modal
      closeModal();
    } catch (error) {
      console.error('[Ticket Modal] ❌ Error creating ticket:', error);
      alert(`Error creating ticket: ${error.message || 'Failed to create ticket'}`);
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });
  
  // Create and add another handler
  createAnotherBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const originalText = createAnotherBtn.textContent;
    
    try {
      // Disable button
      createAnotherBtn.disabled = true;
      createAnotherBtn.textContent = 'Creating...';
      
      const formData = new FormData(form);
      const ticketData = Object.fromEntries(formData);
      
      console.log('[Ticket Modal] Create and add another:', ticketData);
      
      // Create ticket in HubSpot
      await createHubSpotTicket(ticketData, contactId);
      
      console.log('[Ticket Modal] ✅ Ticket created successfully!');
      
      // Reset form but keep contact association
      form.reset();
      dateInput.value = today.toISOString().split('T')[0];
      dateDisplay.textContent = formattedDate;
      
      // Restore contact tag if it was removed
      const contactTag = document.getElementById('ticket-contact-tag');
      if (contactTag && contactTag.style.display === 'none') {
        contactTag.style.display = 'inline-flex';
        document.getElementById('ticket-contact-id').value = contactId;
        document.getElementById('ticket-contact-name').value = contactName;
        document.getElementById('ticket-contact-email').value = contactEmail;
      }
      
      // Re-enable button
      createAnotherBtn.disabled = false;
      createAnotherBtn.textContent = originalText;
    } catch (error) {
      console.error('[Ticket Modal] ❌ Error creating ticket:', error);
      alert(`Error creating ticket: ${error.message || 'Failed to create ticket'}`);
      createAnotherBtn.disabled = false;
      createAnotherBtn.textContent = originalText;
    }
  });
}

// Helper function to calculate business days and return label
function calculateBusinessDaysLabel(days) {
  const today = new Date();
  let businessDays = 0;
  let targetDate = new Date(today);
  while (businessDays < days) {
    targetDate.setDate(targetDate.getDate() + 1);
    const dayOfWeek = targetDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDays++;
    }
  }
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return dayNames[targetDate.getDay()];
}

// Helper function to calculate weeks and return label
function calculateWeekLabel(weeks) {
  const today = new Date();
  const targetDate = new Date(today);
  targetDate.setDate(targetDate.getDate() + (weeks * 7));
  return targetDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
}

// Helper function to calculate months and return label
function calculateMonthLabel(months) {
  const today = new Date();
  const targetDate = new Date(today);
  targetDate.setMonth(targetDate.getMonth() + months);
  return targetDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  });
}

// Helper function to generate time options from 12:00 AM to 11:45 PM in 15-minute intervals
function generateTimeOptions() {
  const times = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute += 15) {
      const hour12 = hour === 0 ? 12 : (hour > 12 ? hour - 12 : hour);
      const ampm = hour < 12 ? 'AM' : 'PM';
      const minuteStr = minute.toString().padStart(2, '0');
      const timeStr = `${hour12}:${minuteStr} ${ampm}`;
      const timeValue = `${hour.toString().padStart(2, '0')}:${minuteStr}`;
      times.push({ display: timeStr, value: timeValue });
    }
  }
  return times.map(time => 
    `<div class="task-time-option" data-time-value="${time.value}">${time.display}</div>`
  ).join('');
}

// Function to show deal creation modal
function showDealModal(contactName, contactEmail, contactId, defaultSegment = 'create-new') {
  // Remove existing modal if any
  const existingModal = document.getElementById('deal-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // Format contact display name
  // Only show email in parentheses if it exists and is not empty/placeholder
  const hasValidEmail = contactEmail && contactEmail !== '--' && contactEmail.trim() !== '';
  const contactDisplay = contactName && hasValidEmail
    ? `${contactName} (${contactEmail})`
    : contactName || (hasValidEmail ? contactEmail : '') || 'Contact';
  
  // Get today's date and default close date (end of month)
  const today = new Date();
  const closeDate = new Date(today.getFullYear(), today.getMonth() + 1, 0); // Last day of next month
  const formattedCloseDate = closeDate.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric'
  });
  
  // Determine which segment should be active
  const isCreateNewActive = defaultSegment === 'create-new';
  const isAddExistingActive = defaultSegment === 'add-existing';
  
  // Determine title based on default segment
  const modalTitle = isAddExistingActive ? 'Add existing Deal' : 'Create Deal';
  
  // Create modal HTML
  const modalHTML = `
    <div id="deal-modal" class="deal-modal-overlay">
      <div class="deal-sidebar">
        <div class="deal-header">
          <div class="deal-header-title">${modalTitle}</div>
          <button class="deal-close-btn" title="Close">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        
        <div class="deal-segments">
          <button class="deal-segment-btn ${isCreateNewActive ? 'active' : ''}" data-segment="create-new">Create new</button>
          <button class="deal-segment-btn ${isAddExistingActive ? 'active' : ''}" data-segment="add-existing">Add existing</button>
        </div>
        
        <div class="deal-form-container">
          <!-- Create new form -->
          <form id="deal-form" class="deal-form deal-form-create" style="display: ${isCreateNewActive ? 'block' : 'none'};">
            <div class="deal-form-group">
              <label for="deal-name" class="deal-label required">Deal name *</label>
              <input type="text" id="deal-name" name="dealName" class="deal-input" required>
            </div>
            
            <div class="deal-form-group">
              <label for="deal-pipeline" class="deal-label required">Pipeline *</label>
              <select id="deal-pipeline" name="pipeline" class="deal-select" required>
                <option value="">Loading pipelines...</option>
              </select>
            </div>
            
            <div class="deal-form-group">
              <label for="deal-stage" class="deal-label required">Deal stage *</label>
              <select id="deal-stage" name="dealStage" class="deal-select" required>
                <option value="">Loading stages...</option>
              </select>
            </div>
            
            <div class="deal-form-group">
              <label for="deal-amount" class="deal-label">Amount</label>
              <input type="number" id="deal-amount" name="amount" class="deal-input" step="0.01" placeholder="0.00">
            </div>
            
            <div class="deal-form-group">
              <label for="deal-close-date" class="deal-label">Close date</label>
              <div class="deal-date-wrapper">
                <input type="date" id="deal-close-date" name="closeDate" class="deal-date-input" value="${closeDate.toISOString().split('T')[0]}">
                <span class="deal-date-display">${formattedCloseDate}</span>
              </div>
            </div>
            
            <div class="deal-form-group">
              <label for="deal-owner" class="deal-label">Deal owner</label>
              <select id="deal-owner" name="owner" class="deal-select">
                <option value="" selected>Loading owners…</option>
              </select>
            </div>
            
            <div class="deal-form-group">
              <label for="deal-type" class="deal-label">Deal type</label>
              <select id="deal-type" name="dealType" class="deal-select">
                <option value="">Select deal type</option>
                <option value="new-business">New Business</option>
                <option value="existing-business">Existing Business</option>
                <option value="renewal">Renewal</option>
                <option value="upsell">Upsell</option>
              </select>
            </div>
            
            <div class="deal-form-group">
              <label for="deal-priority" class="deal-label">Priority</label>
              <select id="deal-priority" name="priority" class="deal-select">
                <option value="">Select priority</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
            
            <div class="deal-associate-section">
              <div class="deal-section-title">Associate Deal with</div>
              
              <div class="deal-form-group">
                <label class="deal-label">Contact</label>
                <div class="deal-contact-tag-wrapper">
                  <div class="deal-contact-tag" id="deal-contact-tag">
                    <span>${contactDisplay}</span>
                    <button type="button" class="deal-tag-remove" id="deal-contact-remove">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </div>
                  <input type="hidden" id="deal-contact-id" name="contactId" value="${contactId}">
                  <input type="hidden" id="deal-contact-name" name="contactName" value="${contactName}">
                  <input type="hidden" id="deal-contact-email" name="contactEmail" value="${contactEmail}">
                </div>
                <div class="deal-checkbox-group">
                  <input type="checkbox" id="deal-add-contact-activity" name="addContactActivity" checked>
                  <label for="deal-add-contact-activity" class="deal-checkbox-label">
                    Add timeline activity from ${contactName || 'this contact'} to this Deal
                    <svg class="deal-info-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="16" x2="12" y2="12"></line>
                      <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                  </label>
                </div>
              </div>
              
              <div class="deal-form-group">
                <label class="deal-label">Company</label>
                <div class="deal-search-wrapper">
                  <input type="text" id="deal-company-search" name="companySearch" class="deal-search-input" placeholder="Search">
                  <svg class="deal-dropdown-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </div>
                <div class="deal-checkbox-group">
                  <input type="checkbox" id="deal-add-company-activity" name="addCompanyActivity">
                  <label for="deal-add-company-activity" class="deal-checkbox-label">
                    Add timeline activity from this Company
                    <svg class="deal-info-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="16" x2="12" y2="12"></line>
                      <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                  </label>
                </div>
              </div>
            </div>
            
            <div class="deal-line-item-section">
              <div class="deal-section-title">Add line item</div>
              <div class="deal-form-group">
                <select id="deal-line-item" name="lineItem" class="deal-select">
                  <option value="">Add a line item</option>
                </select>
              </div>
              <div class="deal-form-group">
                <label for="deal-quantity" class="deal-label">Quantity</label>
                <input type="number" id="deal-quantity" name="quantity" class="deal-input" value="0" min="0">
              </div>
            </div>
            
            <div class="deal-form-footer">
              <button type="submit" class="deal-btn deal-btn-primary">Create</button>
              <button type="button" class="deal-btn deal-btn-cancel" id="deal-cancel">Cancel</button>
            </div>
          </form>
          
          <!-- Add existing form -->
          <div id="deal-add-existing-form" class="deal-form deal-form-existing" style="display: ${isAddExistingActive ? 'block' : 'none'};">
            <div class="deal-search-section">
              <div class="deal-search-wrapper-full">
                <svg class="deal-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input type="text" id="deal-search-input" class="deal-search-input-full" placeholder="Search Deals">
              </div>
            </div>
            
            <div class="deal-list-header">
              <div class="deal-count">
                <span id="deal-total-count">0</span> <span id="deal-count-text">Deals</span>
              </div>
            </div>
            
            <div class="deal-list-container">
              <div id="deal-list-loading" class="deal-list-loading" style="display: none;">
                <div class="loading-spinner"></div>
                <p>Loading deals...</p>
              </div>
              <div id="deal-list" class="deal-list">
                <!-- Deals will be populated here -->
              </div>
              <div id="deal-list-empty" class="deal-list-empty" style="display: none;">
                <p>No deals found. Try adjusting your search.</p>
              </div>
            </div>
            
            <div class="deal-form-footer">
              <button type="button" class="deal-btn deal-btn-primary" id="deal-add-selected-btn" disabled>Save</button>
              <button type="button" class="deal-btn deal-btn-cancel" id="deal-cancel-existing">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Append to body
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Setup handlers
  const modal = document.getElementById('deal-modal');
  const closeBtn = modal.querySelector('.deal-close-btn');
  const cancelBtn = modal.querySelector('#deal-cancel');
  const form = modal.querySelector('#deal-form');
  const contactRemoveBtn = modal.querySelector('#deal-contact-remove');
  const dateInput = modal.querySelector('#deal-close-date');
  const dateDisplay = modal.querySelector('.deal-date-display');
  const segmentBtns = modal.querySelectorAll('.deal-segment-btn');
  const titleElement = modal.querySelector('.deal-header-title');
  
  // Close modal handlers
  function closeModal() {
    modal.remove();
  }
  
  closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  
  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });
  
  // Segment button handlers
  const createForm = modal.querySelector('#deal-form');
  const existingForm = modal.querySelector('#deal-add-existing-form');
  
  segmentBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      segmentBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const segment = btn.getAttribute('data-segment');
      
      // Update title based on segment
      if (titleElement) {
        titleElement.textContent = segment === 'add-existing' ? 'Add existing Deal' : 'Create Deal';
      }
      
      // Show/hide forms based on segment
      if (segment === 'create-new') {
        createForm.style.display = 'block';
        existingForm.style.display = 'none';
      } else if (segment === 'add-existing') {
        createForm.style.display = 'none';
        existingForm.style.display = 'block';
      }
      
      console.log('[Deal Modal] Segment changed to:', segment);
    });
  });
  
  // Date input handler
  if (dateInput && dateDisplay) {
    // Make date display clickable to trigger date input
    dateDisplay.addEventListener('click', () => {
      dateInput.click();
    });
    
    dateInput.addEventListener('change', (e) => {
      const selectedDate = new Date(e.target.value);
      const formatted = selectedDate.toLocaleDateString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric'
      });
      dateDisplay.textContent = formatted;
    });
  }
  
  // Contact remove handler
  if (contactRemoveBtn) {
    contactRemoveBtn.addEventListener('click', () => {
      const contactTag = document.getElementById('deal-contact-tag');
      if (contactTag) {
        contactTag.style.display = 'none';
        document.getElementById('deal-contact-id').value = '';
        document.getElementById('deal-contact-name').value = '';
        document.getElementById('deal-contact-email').value = '';
      }
    });
  }

  setupDealPipelineForm(modal).catch((err) => {
    console.error('[Deal Modal] Failed to load pipelines:', err);
  });
  
  // Form submit handler
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    
    try {
      // Disable submit button
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';
      
      const formData = new FormData(form);
      const dealData = Object.fromEntries(formData);
      
      console.log('[Deal Modal] Form submitted:', dealData);
      
      // Create deal in HubSpot
      await createHubSpotDeal(dealData, contactId);
      
      // Show success
      console.log('[Deal Modal] ✅ Deal created successfully!');
      
      // Close modal
      closeModal();
    } catch (error) {
      console.error('[Deal Modal] ❌ Error creating deal:', error);
      alert(`Error creating deal: ${error.message || 'Failed to create deal'}`);
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });
  
  console.log('[Deal Modal] ✅ Deal modal initialized');
}

// Function to show task creation modal
function showTaskModal(contactName, contactEmail, contactId) {
  // Remove existing modal if any
  const existingModal = document.getElementById('task-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // Format contact display name
  // Only show email in parentheses if it exists and is not empty/placeholder
  const hasValidEmail = contactEmail && contactEmail !== '--' && contactEmail.trim() !== '';
  const contactDisplay = contactName && hasValidEmail
    ? `${contactName} (${contactEmail})`
    : contactName || (hasValidEmail ? contactEmail : '') || 'Contact';
  
  // Calculate "In 3 business days" date
  const today = new Date();
  let businessDays = 0;
  let targetDate = new Date(today);
  while (businessDays < 3) {
    targetDate.setDate(targetDate.getDate() + 1);
    const dayOfWeek = targetDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Not Sunday or Saturday
      businessDays++;
    }
  }
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const targetDayName = dayNames[targetDate.getDay()];
  const formattedTargetDate = targetDate.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric'
  });
  
  // Calculate date option labels
  const twoBusinessDaysLabel = calculateBusinessDaysLabel(2);
  const oneWeekLabel = calculateWeekLabel(1);
  const twoWeeksLabel = calculateWeekLabel(2);
  const oneMonthLabel = calculateMonthLabel(1);
  const threeMonthsLabel = calculateMonthLabel(3);
  const sixMonthsLabel = calculateMonthLabel(6);
  
  // Create modal HTML
  const modalHTML = `
    <div id="task-modal" class="task-modal-overlay">
      <div class="task-sidebar">
        <div class="task-header">
          <div class="task-header-left">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="3" y1="9" x2="21" y2="9"></line>
              <line x1="9" y1="21" x2="9" y2="9"></line>
            </svg>
            <div class="task-header-title">Task</div>
            <svg class="task-header-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </div>
          <button class="task-close-btn" title="Close">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        
        <div class="task-form-container">
          <form id="task-form" class="task-form">
            <!-- Task Name -->
            <div class="task-form-group">
              <input type="text" id="task-name" name="taskName" class="task-name-input" placeholder="Enter your task" required>
            </div>
            
            <!-- Activity Date and Time -->
            <div class="task-activity-row">
              <div class="task-activity-date">
                <span class="task-activity-label">Activity date</span>
                <div class="task-date-time-wrapper">
                  <div class="task-date-display-wrapper">
                    <span class="task-date-display" id="task-date-display">In 3 business days (${targetDayName})</span>
                    <div class="task-date-dropdown" id="task-date-dropdown" style="display: none;">
                      <div class="task-date-option" data-date-option="today">Today</div>
                      <div class="task-date-option" data-date-option="tomorrow">Tomorrow</div>
                      <div class="task-date-option" data-date-option="2-business-days">In 2 business days (${twoBusinessDaysLabel})</div>
                      <div class="task-date-option" data-date-option="3-business-days">In 3 business days (${targetDayName})</div>
                      <div class="task-date-option" data-date-option="1-week">In 1 week (${oneWeekLabel})</div>
                      <div class="task-date-option" data-date-option="2-weeks">In 2 weeks (${twoWeeksLabel})</div>
                      <div class="task-date-option" data-date-option="1-month">In 1 month (${oneMonthLabel})</div>
                      <div class="task-date-option" data-date-option="3-months">In 3 months (${threeMonthsLabel})</div>
                      <div class="task-date-option" data-date-option="6-months">In 6 months (${sixMonthsLabel})</div>
                      <div class="task-date-option" data-date-option="custom">Custom Date</div>
                    </div>
                  </div>
                  <input type="date" id="task-date-input" class="task-date-input" style="display: none;">
                  <div class="task-time-display-wrapper">
                    <span class="task-time-display" id="task-time-display">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                      </svg>
                      8:00 AM
                    </span>
                    <div class="task-time-dropdown" id="task-time-dropdown" style="display: none;">
                      ${generateTimeOptions()}
                    </div>
                  </div>
                  <input type="time" id="task-time-input" class="task-time-input" value="08:00" style="display: none;">
                </div>
              </div>
              <div class="task-reminder">
                <span class="task-activity-label">Send reminder</span>
                <select id="task-reminder" name="reminder" class="task-select">
                  <option value="no-reminder" selected>No reminder</option>
                  <option value="15min">15 minutes before</option>
                  <option value="30min">30 minutes before</option>
                  <option value="1hour">1 hour before</option>
                  <option value="1day">1 day before</option>
                </select>
              </div>
            </div>
            
            <!-- Set to Repeat -->
            <div class="task-form-group">
              <label class="task-checkbox-label">
                <input type="checkbox" id="task-repeat" name="repeat" class="task-checkbox">
                <span>Set to repeat</span>
              </label>
            </div>
            
            <!-- Task Classification Row -->
            <div class="task-classification-row">
              <div class="task-classification-item">
                <label class="task-classification-label">Task Type</label>
                <select id="task-type" name="taskType" class="task-select">
                  <option value="todo" selected>To-do</option>
                  <option value="call">Call</option>
                  <option value="email">Email</option>
                  <option value="meeting">Meeting</option>
                </select>
              </div>
              <div class="task-classification-item">
                <label class="task-classification-label">Priority</label>
                <select id="task-priority" name="priority" class="task-select">
                  <option value="none" selected>None</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div class="task-classification-item">
                <label class="task-classification-label">Activity assigned to</label>
                <select id="task-assigned" name="assigned" class="task-select">
                  <option value="" selected>Loading owners…</option>
                </select>
              </div>
            </div>
            
            <!-- Notes Section -->
            <div class="task-form-group">
              <label class="task-label">Notes...</label>
              <div id="task-notes-editor" class="task-notes-editor" contenteditable="true"></div>
              <input type="file" id="task-image-input" accept="image/*" style="display: none;">
              <div class="task-toolbar">
                <button type="button" class="task-toolbar-btn" data-command="bold" title="Bold">
                  <strong>B</strong>
                </button>
                <button type="button" class="task-toolbar-btn" data-command="italic" title="Italic">
                  <em>I</em>
                </button>
                <button type="button" class="task-toolbar-btn" data-command="underline" title="Underline">
                  <u>U</u>
                </button>
                <button type="button" class="task-toolbar-btn" data-command="strikeThrough" title="Strikethrough">
                  <s>T</s>
                </button>
                <div class="task-toolbar-dropdown-wrapper">
                  <button type="button" class="task-toolbar-btn" data-command="more" id="task-toolbar-more-btn" title="More">
                    More
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                  </button>
                  <div class="task-toolbar-more-dropdown" id="task-toolbar-more-dropdown" style="display: none;">
                    <div class="task-toolbar-more-option" data-command="justifyLeft">Align Left</div>
                    <div class="task-toolbar-more-option" data-command="justifyCenter">Align Center</div>
                    <div class="task-toolbar-more-option" data-command="justifyRight">Align Right</div>
                    <div class="task-toolbar-more-option" data-command="justifyFull">Justify</div>
                    <div class="task-toolbar-more-option" data-command="formatBlock" data-value="h1">Heading 1</div>
                    <div class="task-toolbar-more-option" data-command="formatBlock" data-value="h2">Heading 2</div>
                    <div class="task-toolbar-more-option" data-command="formatBlock" data-value="h3">Heading 3</div>
                    <div class="task-toolbar-more-option" data-command="formatBlock" data-value="p">Paragraph</div>
                    <div class="task-toolbar-more-option" data-command="removeFormat">Remove Formatting</div>
                  </div>
                </div>
                <button type="button" class="task-toolbar-btn" data-command="link" title="Link">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                  </svg>
                </button>
                <button type="button" class="task-toolbar-btn" data-command="image" title="Image">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                  </svg>
                </button>
                <button type="button" class="task-toolbar-btn" data-command="insertOrderedList" title="Numbered List">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="8" y1="6" x2="21" y2="6"></line>
                    <line x1="8" y1="12" x2="21" y2="12"></line>
                    <line x1="8" y1="18" x2="21" y2="18"></line>
                    <line x1="3" y1="6" x2="3.01" y2="6"></line>
                    <line x1="3" y1="12" x2="3.01" y2="12"></line>
                    <line x1="3" y1="18" x2="3.01" y2="18"></line>
                  </svg>
                </button>
                <button type="button" class="task-toolbar-btn" data-command="insertUnorderedList" title="Bullet List">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="1"></circle>
                    <circle cx="12" cy="5" r="1"></circle>
                    <circle cx="12" cy="19" r="1"></circle>
                  </svg>
                </button>
              </div>
            </div>
            
            <!-- Hidden contact fields -->
            <input type="hidden" id="task-contact-id" name="contactId" value="${contactId}">
            <input type="hidden" id="task-contact-name" name="contactName" value="${contactName}">
            <input type="hidden" id="task-contact-email" name="contactEmail" value="${contactEmail}">
          </form>
        </div>
        
        <!-- Footer -->
        <div class="task-footer">
          <button type="button" class="task-create-btn" id="task-create-btn">Create</button>
        </div>
      </div>
    </div>
  `;
  
  // Append to body
  document.body.insertAdjacentHTML('beforeend', modalHTML);
  
  // Setup handlers
  const modal = document.getElementById('task-modal');
  // Populate "assigned to" dropdown from real HubSpot owners (never hard-code a name).
  populateDealOwnerSelect(modal, '#task-assigned').catch((err) =>
    console.warn('[Task Modal] Could not load owners:', err)
  );
  const closeBtn = modal.querySelector('.task-close-btn');
  const form = modal.querySelector('#task-form');
  const createBtn = modal.querySelector('#task-create-btn');
  const dateInput = modal.querySelector('#task-date-input');
  const dateDisplay = modal.querySelector('#task-date-display');
  const timeInput = modal.querySelector('#task-time-input');
  const timeDisplay = modal.querySelector('#task-time-display');
  const notesEditor = modal.querySelector('#task-notes-editor');
  const toolbarBtns = modal.querySelectorAll('.task-toolbar-btn');
  
  // Close modal handlers
  let outsideClickHandler = null;
  let closeMoreHandler = null;
  
  function closeModal() {
    // Remove outside click handlers if they exist
    if (outsideClickHandler) {
      document.removeEventListener('click', outsideClickHandler);
    }
    if (closeMoreHandler) {
      document.removeEventListener('click', closeMoreHandler);
    }
    modal.remove();
  }
  
  closeBtn.addEventListener('click', closeModal);
  
  // Close on overlay click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });
  
  // Date dropdown handler
  const dateDropdown = modal.querySelector('#task-date-dropdown');
  const dateDisplayWrapper = modal.querySelector('.task-date-display-wrapper');
  const timeDropdown = modal.querySelector('#task-time-dropdown');
  const timeDisplayWrapper = modal.querySelector('.task-time-display-wrapper');
  
  // Set up outside click handler for both date and time dropdowns
  if (!outsideClickHandler) {
    outsideClickHandler = function closeDropdownsOnOutsideClick(e) {
      if (dateDropdown && dateDisplayWrapper && !dateDisplayWrapper.contains(e.target)) {
        dateDropdown.style.display = 'none';
      }
      if (timeDropdown && timeDisplayWrapper && !timeDisplayWrapper.contains(e.target)) {
        timeDropdown.style.display = 'none';
      }
    };
    document.addEventListener('click', outsideClickHandler);
  }
  
  if (dateDisplay && dateDropdown) {
    // Toggle dropdown on date display click
    dateDisplay.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = dateDropdown.style.display !== 'none';
      dateDropdown.style.display = isVisible ? 'none' : 'block';
    });
    
    // Handle date option selection
    const dateOptions = dateDropdown.querySelectorAll('.task-date-option');
    dateOptions.forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const optionType = option.getAttribute('data-date-option');
        let selectedDate = new Date();
        let displayText = '';
        
        switch (optionType) {
          case 'today':
            selectedDate = new Date();
            displayText = 'Today';
            break;
          case 'tomorrow':
            selectedDate = new Date();
            selectedDate.setDate(selectedDate.getDate() + 1);
            displayText = 'Tomorrow';
            break;
          case '2-business-days':
            selectedDate = new Date();
            let businessDays2 = 0;
            while (businessDays2 < 2) {
              selectedDate.setDate(selectedDate.getDate() + 1);
              const dayOfWeek = selectedDate.getDay();
              if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                businessDays2++;
              }
            }
            const dayNames2 = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            displayText = `In 2 business days (${dayNames2[selectedDate.getDay()]})`;
            break;
          case '3-business-days':
            selectedDate = new Date();
            let businessDays3 = 0;
            while (businessDays3 < 3) {
              selectedDate.setDate(selectedDate.getDate() + 1);
              const dayOfWeek = selectedDate.getDay();
              if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                businessDays3++;
              }
            }
            const dayNames3 = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            displayText = `In 3 business days (${dayNames3[selectedDate.getDay()]})`;
            break;
          case '1-week':
            selectedDate = new Date();
            selectedDate.setDate(selectedDate.getDate() + 7);
            const week1Label = selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            displayText = `In 1 week (${week1Label})`;
            break;
          case '2-weeks':
            selectedDate = new Date();
            selectedDate.setDate(selectedDate.getDate() + 14);
            const week2Label = selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            displayText = `In 2 weeks (${week2Label})`;
            break;
          case '1-month':
            selectedDate = new Date();
            selectedDate.setMonth(selectedDate.getMonth() + 1);
            const month1Label = selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            displayText = `In 1 month (${month1Label})`;
            break;
          case '3-months':
            selectedDate = new Date();
            selectedDate.setMonth(selectedDate.getMonth() + 3);
            const month3Label = selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            displayText = `In 3 months (${month3Label})`;
            break;
          case '6-months':
            selectedDate = new Date();
            selectedDate.setMonth(selectedDate.getMonth() + 6);
            const month6Label = selectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            displayText = `In 6 months (${month6Label})`;
            break;
          case 'custom':
            // Show native date picker
            if (dateInput) {
              dateInput.showPicker();
              dateInput.addEventListener('change', function onCustomDateChange(e) {
                const customDate = new Date(e.target.value);
                const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const dayName = dayNames[customDate.getDay()];
                const formatted = customDate.toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric'
                });
                dateDisplay.textContent = `${formatted} (${dayName})`;
                dateInput.removeEventListener('change', onCustomDateChange);
              }, { once: true });
            }
            dateDropdown.style.display = 'none';
            return;
        }
        
        // Update date display and hidden input
        dateDisplay.textContent = displayText;
        if (dateInput) {
          const year = selectedDate.getFullYear();
          const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
          const day = String(selectedDate.getDate()).padStart(2, '0');
          dateInput.value = `${year}-${month}-${day}`;
        }
        
        // Close dropdown
        dateDropdown.style.display = 'none';
      });
    });
  }
  
  // Date input handler (for custom date)
  if (dateInput && dateDisplay) {
    dateInput.addEventListener('change', (e) => {
      const selectedDate = new Date(e.target.value);
      const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const dayName = dayNames[selectedDate.getDay()];
      const formatted = selectedDate.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric'
      });
      dateDisplay.textContent = `${formatted} (${dayName})`;
    });
  }
  
  // Time dropdown handler
  if (timeDisplay && timeDropdown) {
    // Toggle dropdown on time display click
    timeDisplay.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = timeDropdown.style.display !== 'none';
      timeDropdown.style.display = isVisible ? 'none' : 'block';
    });
    
    // Handle time option selection
    const timeOptions = timeDropdown.querySelectorAll('.task-time-option');
    timeOptions.forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const timeValue = option.getAttribute('data-time-value');
        const [hours, minutes] = timeValue.split(':');
        const hour12 = parseInt(hours) % 12 || 12;
        const ampm = parseInt(hours) >= 12 ? 'PM' : 'AM';
        const minuteStr = minutes.padStart(2, '0');
        
        // Update time display
        timeDisplay.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          ${hour12}:${minuteStr} ${ampm}
        `;
        
        // Update hidden time input
        if (timeInput) {
          timeInput.value = timeValue;
        }
        
        // Close dropdown
        timeDropdown.style.display = 'none';
      });
    });
  }
  
  // Time input handler (fallback for native picker if needed)
  if (timeInput && timeDisplay) {
    timeInput.addEventListener('change', (e) => {
      const timeValue = e.target.value;
      const [hours, minutes] = timeValue.split(':');
      const hour12 = parseInt(hours) % 12 || 12;
      const ampm = parseInt(hours) >= 12 ? 'PM' : 'AM';
      timeDisplay.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        ${hour12}:${minutes} ${ampm}
      `;
    });
  }
  
  // Rich text editor toolbar handlers
  const moreDropdown = modal.querySelector('#task-toolbar-more-dropdown');
  const moreBtn = modal.querySelector('#task-toolbar-more-btn');
  
  // Store selection state for toolbar commands
  let savedSelection = null;
  
  // Function to save current selection
  function saveSelection() {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      // Check if selection is within the editor
      if (range.commonAncestorContainer && notesEditor.contains(range.commonAncestorContainer)) {
        try {
          savedSelection = range.cloneRange();
        } catch (err) {
          savedSelection = null;
        }
      }
    }
  }
  
  // Function to clean up list numbers that appear as text
  function cleanupListNumbers() {
    const lists = notesEditor.querySelectorAll('ol li');
    lists.forEach(li => {
      // Remove any text nodes that start with numbers followed by period and space
      const walker = document.createTreeWalker(
        li,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      const textNodes = [];
      let node;
      while (node = walker.nextNode()) {
        textNodes.push(node);
      }
      textNodes.forEach(textNode => {
        const text = textNode.textContent;
        // Remove patterns like "1. ", "2. ", "10. " at the start of the first text node
        if (textNode === textNodes[0] && /^\d+\.\s*/.test(text)) {
          const cleaned = text.replace(/^\d+\.\s*/, '');
          textNode.textContent = cleaned;
        }
      });
    });
  }
  
  // Clean up list numbers when content changes using MutationObserver
  const observer = new MutationObserver(() => {
    cleanupListNumbers();
  });
  
  observer.observe(notesEditor, {
    childList: true,
    subtree: true,
    characterData: true
  });
  
  // Also clean up on input events
  notesEditor.addEventListener('input', cleanupListNumbers);
  
  // Save selection when user interacts with editor
  notesEditor.addEventListener('mouseup', saveSelection);
  notesEditor.addEventListener('keyup', saveSelection);
  notesEditor.addEventListener('keydown', saveSelection);
  notesEditor.addEventListener('selectstart', saveSelection);
  
  // Save selection before losing focus
  notesEditor.addEventListener('blur', () => {
    // Don't save on blur if clicking toolbar buttons
    setTimeout(() => {
      if (document.activeElement !== notesEditor) {
        saveSelection();
      }
    }, 0);
  });
  
  // Handle "More" dropdown toggle
  if (moreBtn && moreDropdown) {
    moreBtn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // Prevent losing focus
    });
    
    moreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Restore focus to editor
      notesEditor.focus();
      
      // Restore selection if available
      if (savedSelection) {
        const selection = window.getSelection();
        selection.removeAllRanges();
        try {
          selection.addRange(savedSelection.cloneRange());
        } catch (err) {
          // Selection might be invalid
        }
      }
      
      const isVisible = moreDropdown.style.display !== 'none';
      moreDropdown.style.display = isVisible ? 'none' : 'block';
    });
    
    // Close "More" dropdown when clicking outside
    closeMoreHandler = function closeMoreDropdown(e) {
      if (moreDropdown && moreBtn && !moreBtn.contains(e.target) && !moreDropdown.contains(e.target)) {
        moreDropdown.style.display = 'none';
      }
    };
    document.addEventListener('click', closeMoreHandler);
    
    // Handle "More" dropdown options
    const moreOptions = moreDropdown.querySelectorAll('.task-toolbar-more-option');
    moreOptions.forEach(option => {
      option.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Restore focus and selection
        notesEditor.focus();
        if (savedSelection) {
          const selection = window.getSelection();
          selection.removeAllRanges();
          try {
            selection.addRange(savedSelection.cloneRange());
          } catch (err) {
            // Selection might be invalid
          }
        }
        
        const command = option.getAttribute('data-command');
        const value = option.getAttribute('data-value');
        
        if (command) {
          try {
            document.execCommand(command, false, value || null);
            notesEditor.focus();
          } catch (err) {
            console.error('Error executing command:', command, err);
          }
        }
        
        moreDropdown.style.display = 'none';
      });
    });
  }
  
  // Handle other toolbar buttons
  toolbarBtns.forEach(btn => {
    // Prevent default on mousedown to maintain selection
    btn.addEventListener('mousedown', (e) => {
      // Save selection before it gets lost
      saveSelection();
      e.preventDefault();
    });
    
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const command = btn.getAttribute('data-command');
      
      if (command && command !== 'more') {
        // Restore focus and selection
        notesEditor.focus();
        
        // Restore selection if we have one saved
        const selection = window.getSelection();
        let range = null;
        
        if (savedSelection) {
          try {
            selection.removeAllRanges();
            selection.addRange(savedSelection.cloneRange());
            range = selection.getRangeAt(0);
          } catch (err) {
            // Selection invalid, create collapsed selection at cursor
            range = document.createRange();
            if (notesEditor.childNodes.length > 0) {
              // Try to find last text node
              let walker = document.createTreeWalker(
                notesEditor,
                NodeFilter.SHOW_TEXT,
                null,
                false
              );
              let lastTextNode = null;
              let node;
              while (node = walker.nextNode()) {
                lastTextNode = node;
              }
              if (lastTextNode) {
                range.setStart(lastTextNode, lastTextNode.textContent.length);
                range.collapse(true);
              } else {
                range.selectNodeContents(notesEditor);
                range.collapse(false);
              }
            } else {
              range.setStart(notesEditor, 0);
              range.collapse(true);
            }
            selection.removeAllRanges();
            selection.addRange(range);
          }
        } else if (selection.rangeCount === 0 || selection.isCollapsed) {
          // No saved selection and no current selection, create one at cursor
          range = document.createRange();
          if (notesEditor.childNodes.length > 0) {
            // Find last text node
            let walker = document.createTreeWalker(
              notesEditor,
              NodeFilter.SHOW_TEXT,
              null,
              false
            );
            let lastTextNode = null;
            let node;
            while (node = walker.nextNode()) {
              lastTextNode = node;
            }
            if (lastTextNode) {
              range.setStart(lastTextNode, lastTextNode.textContent.length);
              range.collapse(true);
            } else {
              range.selectNodeContents(notesEditor);
              range.collapse(false);
            }
          } else {
            range.setStart(notesEditor, 0);
            range.collapse(true);
          }
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          range = selection.getRangeAt(0);
        }
        
        try {
          if (command === 'link') {
            // Handle link insertion
            const url = prompt('Enter URL:');
            if (url) {
              document.execCommand('createLink', false, url);
              notesEditor.focus();
            }
          } else if (command === 'image') {
            // Handle image insertion from local file
            const imageInput = modal.querySelector('#task-image-input');
            if (imageInput) {
              imageInput.onchange = function(e) {
                const file = e.target.files[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = function(event) {
                    const img = document.createElement('img');
                    img.src = event.target.result;
                    img.style.maxWidth = '100%';
                    img.style.height = 'auto';
                    
                    // Insert image at current cursor position
                    const selection = window.getSelection();
                    if (selection.rangeCount > 0) {
                      const range = selection.getRangeAt(0);
                      range.deleteContents();
                      range.insertNode(img);
                      // Move cursor after image
                      range.setStartAfter(img);
                      range.collapse(true);
                      selection.removeAllRanges();
                      selection.addRange(range);
                    } else {
                      notesEditor.appendChild(img);
                    }
                    notesEditor.focus();
                  };
                  reader.readAsDataURL(file);
                }
                // Reset input
                imageInput.value = '';
              };
              imageInput.click();
            }
          } else if (command === 'insertUnorderedList') {
            // Handle bullet list
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
              const range = selection.getRangeAt(0);
              
              // Check if we're already in a list
              let listItem = range.commonAncestorContainer;
              while (listItem && listItem.nodeType !== 1) {
                listItem = listItem.parentNode;
              }
              while (listItem && listItem.tagName !== 'UL' && listItem.tagName !== 'LI' && listItem !== notesEditor) {
                listItem = listItem.parentNode;
              }
              
              if (listItem && listItem.tagName === 'UL') {
                // Already in a list, toggle it off
                document.execCommand('insertUnorderedList', false, null);
              } else {
                // Not in a list, create one
                // If there's selected text, wrap it in a list
                if (!selection.isCollapsed && range.toString().trim()) {
                  document.execCommand('insertUnorderedList', false, null);
                } else {
                  // No selection or empty, create a new list item at cursor
                  const ul = document.createElement('ul');
                  const li = document.createElement('li');
                  li.style.color = '#000000'; // Black color
                  li.innerHTML = '&nbsp;'; // Non-breaking space
                  ul.appendChild(li);
                  
                  range.deleteContents();
                  range.insertNode(ul);
                  
                  // Move cursor inside the list item
                  const newRange = document.createRange();
                  newRange.setStart(li.firstChild || li, 0);
                  newRange.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(newRange);
                }
              }
            } else {
              // No selection, create list at end
              const ul = document.createElement('ul');
              const li = document.createElement('li');
              li.style.color = '#000000'; // Black color
              li.innerHTML = '&nbsp;';
              ul.appendChild(li);
              notesEditor.appendChild(ul);
              
              const range = document.createRange();
              range.setStart(li.firstChild || li, 0);
              range.collapse(true);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            }
            notesEditor.focus();
          } else if (command === 'insertOrderedList') {
            // Handle numbered list
            const selection = window.getSelection();
            if (selection.rangeCount > 0) {
              const range = selection.getRangeAt(0);
              
              // Check if we're already in a list
              let listItem = range.commonAncestorContainer;
              while (listItem && listItem.nodeType !== 1) {
                listItem = listItem.parentNode;
              }
              while (listItem && listItem.tagName !== 'OL' && listItem.tagName !== 'UL' && listItem.tagName !== 'LI' && listItem !== notesEditor) {
                listItem = listItem.parentNode;
              }
              
              if (listItem && listItem.tagName === 'OL') {
                // Already in a numbered list, toggle it off
                document.execCommand('insertOrderedList', false, null);
              } else {
                // Not in a numbered list, create one
                // If there's selected text, wrap it in a list
                if (!selection.isCollapsed && range.toString().trim()) {
                  document.execCommand('insertOrderedList', false, null);
                } else {
                  // No selection or empty, create a new list item at cursor
                  const ol = document.createElement('ol');
                  ol.style.listStyleType = 'decimal';
                  ol.style.listStylePosition = 'outside';
                  const li = document.createElement('li');
                  li.style.color = '#000000'; // Black color
                  li.style.display = 'list-item';
                  // Use text node instead of innerHTML to avoid any number insertion
                  const textNode = document.createTextNode('\u00A0'); // Non-breaking space
                  li.appendChild(textNode);
                  ol.appendChild(li);
                  
                  range.deleteContents();
                  range.insertNode(ol);
                  
                  // Move cursor inside the list item
                  const newRange = document.createRange();
                  newRange.setStart(textNode, 1);
                  newRange.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(newRange);
                }
              }
            } else {
              // No selection, create list at end
              const ol = document.createElement('ol');
              ol.style.listStyleType = 'decimal';
              ol.style.listStylePosition = 'outside';
              const li = document.createElement('li');
              li.style.color = '#000000'; // Black color
              li.style.display = 'list-item';
              const textNode = document.createTextNode('\u00A0');
              li.appendChild(textNode);
              ol.appendChild(li);
              notesEditor.appendChild(ol);
              
              const range = document.createRange();
              range.setStart(textNode, 1);
              range.collapse(true);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            }
            
            // Clean up any numbers that might have been inserted as text
            setTimeout(() => {
              const lists = notesEditor.querySelectorAll('ol li');
              lists.forEach(li => {
                // Remove any text nodes that start with numbers followed by period and space (like "1. ", "2. ", etc.)
                const walker = document.createTreeWalker(
                  li,
                  NodeFilter.SHOW_TEXT,
                  null,
                  false
                );
                const textNodes = [];
                let node;
                while (node = walker.nextNode()) {
                  textNodes.push(node);
                }
                textNodes.forEach(textNode => {
                  const text = textNode.textContent;
                  // Remove patterns like "1. ", "2. ", "10. " at the start
                  const cleaned = text.replace(/^\d+\.\s*/, '');
                  if (cleaned !== text) {
                    textNode.textContent = cleaned;
                  }
                });
              });
            }, 0);
            
            notesEditor.focus();
          } else if (command === 'bold' || command === 'italic') {
            // Handle Bold and Italic with manual wrapping for better reliability
            const selection = window.getSelection();
            
            // Ensure we have a valid range
            if (!range) {
              if (selection.rangeCount > 0) {
                range = selection.getRangeAt(0);
              } else {
                // Create a range at cursor
                range = document.createRange();
                if (notesEditor.childNodes.length > 0) {
                  range.selectNodeContents(notesEditor);
                  range.collapse(false);
                } else {
                  range.setStart(notesEditor, 0);
                  range.collapse(true);
                }
                selection.removeAllRanges();
                selection.addRange(range);
              }
            }
            
            // Get selected text
            const selectedText = range.toString();
            
            if (selectedText && selectedText.trim()) {
              // Apply formatting by wrapping selected text
              const tag = command === 'bold' ? 'strong' : 'em';
              
              // Check if selection is already wrapped in the tag
              let parent = range.commonAncestorContainer;
              while (parent && parent.nodeType !== 1) {
                parent = parent.parentNode;
              }
              
              // Check if we're inside a matching tag
              let isAlreadyFormatted = false;
              let formattedParent = null;
              let current = parent;
              while (current && current !== notesEditor) {
                if (current.tagName && current.tagName.toLowerCase() === tag) {
                  isAlreadyFormatted = true;
                  formattedParent = current;
                  break;
                }
                current = current.parentNode;
              }
              
              if (isAlreadyFormatted && formattedParent) {
                // Unwrap: remove the tag but keep the content
                const contents = formattedParent.innerHTML;
                const textNode = document.createTextNode(contents);
                formattedParent.parentNode.replaceChild(textNode, formattedParent);
                
                // Restore selection
                const newRange = document.createRange();
                newRange.selectNodeContents(textNode);
                selection.removeAllRanges();
                selection.addRange(newRange);
              } else {
                // Wrap selected text
                const formattedText = `<${tag}>${selectedText}</${tag}>`;
                
                // Delete selected content and insert formatted version
                range.deleteContents();
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = formattedText;
                
                // Insert the formatted content
                const fragment = document.createDocumentFragment();
                while (tempDiv.firstChild) {
                  fragment.appendChild(tempDiv.firstChild);
                }
                range.insertNode(fragment);
                
                // Move cursor after inserted content
                range.setStartAfter(fragment.lastChild);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
              }
            } else {
              // No selection - toggle formatting state for next typed text
              // Use execCommand which should work for toggling
              try {
                const success = document.execCommand(command, false, null);
                if (!success) {
                  // Fallback: insert empty tags at cursor
                  const tag = command === 'bold' ? 'strong' : 'em';
                  const emptyTag = document.createElement(tag);
                  emptyTag.innerHTML = '\u200B'; // Zero-width space
                  
                  range.insertNode(emptyTag);
                  range.setStart(emptyTag, 1);
                  range.collapse(true);
                  selection.removeAllRanges();
                  selection.addRange(range);
                }
              } catch (err) {
                console.error('Error with execCommand:', err);
              }
            }
            notesEditor.focus();
          } else {
            // Standard formatting commands (underline, strikethrough, etc.)
            // execCommand will toggle formatting or apply to selection
            document.execCommand(command, false, null);
            notesEditor.focus();
          }
        } catch (err) {
          console.error('Error executing command:', command, err);
        }
      }
    });
  });
  
  // Create button handler
  if (createBtn) {
    createBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      
      try {
        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';
        
        const formData = new FormData(form);
        const taskData = Object.fromEntries(formData);
        
        // Get notes content from rich text editor
        taskData.notes = notesEditor.innerHTML;
        
        // Get date and time values
        const dateValue = dateInput ? dateInput.value : null;
        const timeValue = timeInput ? timeInput.value : '08:00';
        
        console.log('[Task Modal] Creating task:', taskData);
        console.log('[Task Modal] Date:', dateValue, 'Time:', timeValue);
        
        // Create task in HubSpot
        await createHubSpotTask(taskData, contactId, dateValue, timeValue);
        
        console.log('[Task Modal] ✅ Task created successfully!');
        
        // Close modal
        closeModal();
        
        // Refresh tasks section
        const tasksSection = document.querySelector('.tasks-section');
        if (tasksSection) {
          const contactIdAttr = tasksSection.getAttribute('data-contact-id');
          if (contactIdAttr) {
            // Refresh tasks count
            refreshTasksCount(contactIdAttr, tasksSection).catch(error => {
              console.error('[Task Modal] Error refreshing tasks count:', error);
            });
            
            // If tasks section is expanded, reload tasks
            const tasksContent = tasksSection.querySelector('.tasks-content');
            if (tasksContent && tasksContent.style.display !== 'none') {
              // Reset loaded flag to force reload
              tasksSection.dataset.tasksLoaded = 'false';
              loadContactTasks(contactIdAttr, tasksSection).catch(error => {
                console.error('[Task Modal] Error reloading tasks:', error);
              });
            }
          }
        }
        
        // Show success message
        alert('Task created successfully!');
        
      } catch (error) {
        console.error('[Task Modal] Error creating task:', error);
        alert(`Error creating task: ${error.message || 'Unknown error'}`);
        createBtn.disabled = false;
        createBtn.textContent = 'Create';
      }
    });
  }
}

// Function to create task in HubSpot
async function createHubSpotTask(taskData, contactId, dateValue, timeValue) {
  console.log('[Content] ===== CREATE TASK REQUEST =====');
  console.log('[Content] Task data:', taskData);
  console.log('[Content] Contact ID:', contactId);
  console.log('[Content] Date:', dateValue, 'Time:', timeValue);
  
  try {
    // Build task data object with flexible format support
    const taskPayload = {
      subject: taskData.taskName || '',
      body: await appendMessageHistoryIfEnabled(taskData.notes || ''),
      
      // Task status - map to HubSpot values
      // HubSpot task statuses: NOT_STARTED, IN_PROGRESS, COMPLETED, WAITING, DEFERRED
      status: 'NOT_STARTED', // Default, can be extended to support other statuses
      
      // Task type - map from form value to HubSpot task types
      // HubSpot task types: TODO, CALL, EMAIL, MEETING, etc.
      type: (taskData.taskType || 'todo').toUpperCase(),
      
      // Priority - map from form value to HubSpot priority values
      // HubSpot priorities: LOW, MEDIUM, HIGH, null for None
      priority: taskData.priority === 'none' || !taskData.priority ? null : taskData.priority.toUpperCase(),
      
      // Due date - combine date and time
      dueDate: null,
      
      // Owner ID — empty / "unassigned" means no owner; otherwise a real HubSpot owner id.
      ownerId: (!taskData.assigned || taskData.assigned === 'unassigned') ? null : taskData.assigned,
    };
    
    // Calculate due date from date and time
    if (dateValue) {
      const [hours, minutes] = timeValue.split(':');
      const dueDate = new Date(dateValue);
      dueDate.setHours(parseInt(hours, 10));
      dueDate.setMinutes(parseInt(minutes, 10));
      dueDate.setSeconds(0);
      dueDate.setMilliseconds(0);
      
      // Convert to ISO string
      taskPayload.dueDate = dueDate.toISOString();
    } else {
      // Default to "In 3 business days" if no date selected
      const today = new Date();
      let businessDays = 0;
      let targetDate = new Date(today);
      while (businessDays < 3) {
        targetDate.setDate(targetDate.getDate() + 1);
        const dayOfWeek = targetDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
          businessDays++;
        }
      }
      const [hours, minutes] = timeValue.split(':');
      targetDate.setHours(parseInt(hours, 10));
      targetDate.setMinutes(parseInt(minutes, 10));
      targetDate.setSeconds(0);
      targetDate.setMilliseconds(0);
      taskPayload.dueDate = targetDate.toISOString();
    }
    
    // Add contact association if contactId is provided
    if (contactId) {
      taskPayload.contactId = contactId;
    }
    
    // Add deal association if provided (can be extended)
    if (taskData.dealId) {
      taskPayload.dealId = taskData.dealId;
    }
    
    // Add company association if provided (can be extended)
    if (taskData.companyId) {
      taskPayload.companyId = taskData.companyId;
    }
    
    // Add ticket association if provided (can be extended)
    if (taskData.ticketId) {
      taskPayload.ticketId = taskData.ticketId;
    }
    
    console.log('[Content] Task payload:', taskPayload);
    
    // Call edge function to create task
    const response = await sendExtensionMessage({
      action: 'createHubSpotTask',
      data: taskPayload
    });
    
    console.log('[Content] Task creation response:', response);
    
    if (response && response.success) {
      console.log('[Content] ✅ Task created successfully!');
      console.log('[Content] Task ID:', response.data?.id || response.data?.hs_object_id);
      return response.data;
    } else {
      const errorMessage = response?.error || response?.message || 'Failed to create task';
      console.error('[Content] ❌ Task creation failed:', errorMessage);
      throw new Error(errorMessage);
    }
  } catch (error) {
    console.error('[Content] ❌ Error in createHubSpotTask');
    console.error('[Content] Error type:', error.constructor.name);
    console.error('[Content] Error message:', error.message);
    if (error.stack) {
      console.error('[Content] Error stack:', error.stack);
    }
    throw error;
  }
}

// Function to create ticket in HubSpot
async function createHubSpotTicket(ticketData, contactId) {
  console.log('[Content] ===== CREATE TICKET REQUEST =====');
  console.log('[Content] Ticket data:', ticketData);
  console.log('[Content] Contact ID:', contactId);
  
  try {
    // Map form fields to HubSpot ticket properties
    const properties = {};
    
    // Required fields
    if (ticketData.ticketName) {
      properties.subject = ticketData.ticketName;
    }
    
    // Description/Content
    if (ticketData.description) {
      properties.content = await appendMessageHistoryIfEnabled(ticketData.description);
    }
    
    // Pipeline stage - map status to HubSpot pipeline stage
    // HubSpot uses hs_pipeline_stage for the stage ID
    // Common values: '1' for new, '2' for open, '3' for in-progress, etc.
    const statusMap = {
      'new': '1',
      'open': '2',
      'in-progress': '3',
      'waiting': '4',
      'closed': '5'
    };
    if (ticketData.status) {
      properties.hs_pipeline_stage = statusMap[ticketData.status] || '1';
    }
    
    // Priority - map to HubSpot priority values
    if (ticketData.priority) {
      const priorityMap = {
        'low': 'LOW',
        'medium': 'MEDIUM',
        'high': 'HIGH',
        'urgent': 'URGENT'
      };
      properties.hs_ticket_priority = priorityMap[ticketData.priority] || null;
    }
    
    // Source
    if (ticketData.source) {
      properties.hs_ticket_source = ticketData.source.toUpperCase();
    }
    
    // Create date (if specified)
    if (ticketData.createDate) {
      properties.createdate = new Date(ticketData.createDate).getTime().toString();
    }
    
    console.log('[Content] Mapped HubSpot properties:', properties);
    
    // Prepare ticket data for edge function
    // Edge function expects: { properties: { ... } }
    const ticketPayload = {
      properties: properties
    };
    
    console.log('[Content] Sending ticket creation request to background...');

    const response = await sendExtensionMessage({
      action: 'createHubSpotTicket',
      ticketData: ticketPayload,
      contactId: contactId // Pass contactId for logging
    });
    
    console.log('[Content] Response received from background script');
    console.log('[Content] Response success:', response?.success);

    if (!response) {
      throw new Error('No response from the extension. Please reload WhatsApp Web and try again.');
    }

    if (response.success) {
      console.log('[Content] ✅ Ticket created successfully!');
      
      // Trigger automation after successful ticket creation
      if (response.data && (response.data.id || response.data.hs_object_id)) {
        const ticketId = response.data.id || response.data.hs_object_id;
        const contactPhone = ticketData.contactPhone || getCurrentContactPhone();
        
        automations.ticketCreated({
          id: ticketId,
          subject: ticketData.ticketName,
          description: ticketData.description,
          priority: ticketData.priority || 'normal',
          contactPhone: contactPhone,
          contactId: contactId
        }).catch(err => {
          console.error('[Content] Automation trigger failed:', err);
        });
      }
      
      return response.data;
    } else {
      const errorMsg = response.error || 'Failed to create ticket';
      console.error('[Content] ❌ Ticket creation failed:', errorMsg);
      throw new Error(errorMsg);
    }
  } catch (error) {
    console.error('[Content] ❌ Error in createHubSpotTicket');
    console.error('[Content] Error type:', error.constructor.name);
    console.error('[Content] Error message:', error.message);
    if (error.stack) {
      console.error('[Content] Error stack:', error.stack);
    }
    throw error;
  }
}

// Function to create deal in HubSpot
async function createHubSpotDeal(dealData, contactId) {
  console.log('[Content] ===== CREATE DEAL REQUEST =====');
  console.log('[Content] Deal data:', dealData);
  console.log('[Content] Contact ID:', contactId);
  
  try {
    const syncSettings = await getSyncSettings();
    const placeholderPipelines = ['sales-pipeline', 'support-pipeline', 'default-pipeline'];
    if ((!dealData.pipeline || placeholderPipelines.includes(dealData.pipeline)) && syncSettings?.default_pipeline_id) {
      dealData.pipeline = syncSettings.default_pipeline_id;
    }
    if (!dealData.dealStage && syncSettings?.default_stage_id) {
      dealData.dealStage = syncSettings.default_stage_id;
    }

    // Map form fields to HubSpot deal properties
    const properties = {};
    
    // Required fields
    if (dealData.dealName) {
      properties.dealname = dealData.dealName;
    }
    
    // Amount
    if (dealData.amount) {
      properties.amount = dealData.amount;
    }
    
    // Deal stage — values are HubSpot stage IDs from the pipelines API
    if (dealData.dealStage) {
      properties.dealstage = dealData.dealStage;
    }
    
    // Close date - convert to timestamp (milliseconds)
    if (dealData.closeDate) {
      const closeDate = new Date(dealData.closeDate);
      properties.closedate = closeDate.getTime().toString();
    }
    
    // Deal type
    if (dealData.dealType) {
      properties.dealtype = dealData.dealType;
    }
    
    // Priority
    if (dealData.priority) {
      properties.hs_priority = dealData.priority.toUpperCase();
    }
    
    // Pipeline
    if (dealData.pipeline) {
      properties.pipeline = dealData.pipeline;
    }
    
    // Deal owner - extract ownerId
    // If owner is "current-user", we might need to get the actual owner ID
    // For now, if it's a numeric value, use it directly; otherwise handle "current-user" case
    let ownerId = null;
    if (dealData.owner) {
      if (dealData.owner === 'current-user') {
        // TODO: Get actual HubSpot owner ID for current user
        // For now, you may need to pass this from the backend or get it from user session
        // If the backend can handle "current-user", we can pass it as is
        ownerId = dealData.owner; // Backend should handle this
      } else if (dealData.owner === 'unassigned') {
        ownerId = null; // No owner
      } else if (!isNaN(dealData.owner)) {
        // If it's a numeric ID, use it directly
        ownerId = dealData.owner;
      } else {
        // If it's already a HubSpot owner ID string, use it
        ownerId = dealData.owner;
      }
    }
    
    // Also check if ownerId is provided directly in properties
    if (dealData.hubspot_owner_id) {
      ownerId = dealData.hubspot_owner_id;
    }
    
    // Set hubspot_owner_id in properties if we have an ownerId
    if (ownerId && ownerId !== 'unassigned') {
      properties.hubspot_owner_id = ownerId;
    }
    
    console.log('[Content] Mapped HubSpot properties:', properties);
    console.log('[Content] Owner ID:', ownerId);
    console.log('[Content] Contact ID:', contactId);
    
    // Prepare deal data for edge function
    // Backend expects: { action: 'createDeal', data: { contactId, ownerId, properties } }
    const dealPayload = {
      properties: properties,
      contactId: contactId || null,  // For association
      ownerId: ownerId || null       // For deal owner
    };
    
    console.log('[Content] Sending deal creation request to edge function...');
    console.log('[Content] Payload:', JSON.stringify(dealPayload, null, 2));
    
    // Call HubSpot edge function
    const response = await fetch(HUBSPOT_EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'createDeal',
        data: dealPayload
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Content] ❌ Deal creation failed:', response.status, errorText);
      throw new Error(`Failed to create deal: ${response.status} ${errorText}`);
    }
    
    const result = await response.json();
    console.log('[Content] Response received from edge function');
    console.log('[Content] Response:', JSON.stringify(result, null, 2));
    
    if (result.error) {
      console.error('[Content] ❌ Deal creation error:', result.error);
      throw new Error(result.error || 'Failed to create deal');
    }
    
    console.log('[Content] ✅ Deal created successfully!');
    console.log('[Content] Deal ID:', result.id || result.hs_object_id);
    
    const dealId = result.id || result.hs_object_id;
    
    // Note: Deal association with contact is now handled by the backend
    // No need for separate associateDealWithContact call
    
    // Log activity to Supabase database
    if (dealId) {
      try {
        console.log('[Content] Logging deal creation activity to Supabase...');
        await logDealActivityToSupabase({
          dealId: dealId,
          dealName: dealData.dealName,
          amount: dealData.amount,
          dealStage: dealData.dealStage,
          closeDate: dealData.closeDate,
          contactId: contactId,
          dealType: dealData.dealType,
          priority: dealData.priority
        });
        console.log('[Content] ✅ Activity logged to Supabase');
      } catch (activityError) {
        console.warn('[Content] ⚠️ Failed to log activity to Supabase:', activityError);
        // Don't throw - deal was created successfully, activity logging is secondary
      }
    }
    
    // Refresh deals count and list if deals section exists
    if (contactId) {
      setTimeout(() => {
        const dealsSection = document.querySelector('.deals-section');
        if (dealsSection) {
          const contactIdAttr = dealsSection.getAttribute('data-contact-id');
          if (contactIdAttr === contactId || contactIdAttr === String(contactId)) {
            // Reset loaded flag to force refresh
            dealsSection.dataset.dealsLoaded = 'false';
            // Refresh count
            refreshDealsCount(contactIdAttr, dealsSection).catch(error => {
              console.error('[Content] Error refreshing deals count after creation:', error);
            });
            // If section is expanded, reload deals
            const dealsContent = dealsSection.querySelector('.deals-content');
            if (dealsContent && dealsContent.style.display !== 'none') {
              loadContactDeals(contactIdAttr, dealsSection);
            }
          }
        }
      }, 500);
    }
    
    return result;
  } catch (error) {
    console.error('[Content] ❌ Error in createHubSpotDeal');
    console.error('[Content] Error type:', error.constructor.name);
    console.error('[Content] Error message:', error.message);
    if (error.stack) {
      console.error('[Content] Error stack:', error.stack);
    }
    throw error;
  }
}

// Function to associate deal with contact
async function associateDealWithContact(dealId, contactId) {
  try {
    const response = await fetch(HUBSPOT_EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'associateDealWithContact',
        data: {
          dealId: dealId,
          contactId: contactId
        }
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to associate deal: ${response.status}`);
    }
    
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('[Content] Error associating deal with contact:', error);
    throw error;
  }
}

// Function to log deal activity to Supabase database (hubspot_contact_logs table)
// Uses the same pattern as tickets, tasks, and notes - via background script
async function logDealActivityToSupabase(activityData) {
  try {
    // Get userId from storage
    const storageResult = await extensionStorageGet('external_auth_session');
    const session = storageResult.external_auth_session;
    const userId = session?.user?.id;
    
    if (!userId) {
      console.warn('[Content] No userId found, cannot log deal activity to Supabase');
      return;
    }
    
    console.log('[Content] Logging deal activity to hubspot_contact_logs via background script');
    console.log('[Content] Activity data:', activityData);
    console.log('[Content] User ID:', userId);
    
    // Extract deal ID
    const dealId = activityData.dealId ? String(activityData.dealId) : null;
    
    // Get deal name/subject
    const dealName = activityData.dealName || 'Deal created';
    
    // Prepare log data matching the pattern used by tickets/tasks/notes
    const logData = {
      userId: userId,
      hubspotContactId: activityData.contactId ? String(activityData.contactId) : null,
      dealId: dealId,
      dealName: dealName,
      dealAmount: activityData.amount || null,
      dealStage: activityData.dealStage || null,
      dealCloseDate: activityData.closeDate || null,
      dealType: activityData.dealType || null,
      dealPriority: activityData.priority || null
    };
    
    console.log('[Content] Sending log request to background script...');
    console.log('[Content] Log data:', JSON.stringify(logData, null, 2));
    
    // Send to background script to handle logging (same pattern as tickets/tasks/notes)
    const response = await sendExtensionMessage({
      action: 'logDealCreation',
      data: logData
    });
    
    if (response && response.success) {
      console.log('[Content] ✅ Deal activity logged successfully to hubspot_contact_logs');
      console.log('[Content] Log result:', response.data);
      return response.data;
    } else {
      const errorMsg = response?.error || 'Failed to log deal activity';
      console.error('[Content] ❌ Deal activity logging failed:', errorMsg);
      throw new Error(errorMsg);
    }
  } catch (error) {
    console.error('[Content] Error logging deal activity to Supabase:', error);
    // Don't throw - logging failure shouldn't break deal creation
    // Just log the error and continue
  }
}

// Function to setup "Add existing" ticket form
function setupAddExistingTicketForm(modal, contactId, closeModal) {
  const searchInput = modal.querySelector('#ticket-search-input');
  const ticketList = modal.querySelector('#ticket-list');
  const ticketListLoading = modal.querySelector('#ticket-list-loading');
  const ticketListEmpty = modal.querySelector('#ticket-list-empty');
  const sortDropdown = modal.querySelector('#ticket-sort-dropdown');
  const addSelectedBtn = modal.querySelector('#ticket-add-selected-btn');
  const cancelBtn = modal.querySelector('#ticket-cancel-existing');
  const totalCount = modal.querySelector('#ticket-total-count');
  const countText = modal.querySelector('#ticket-count-text');
  const paginationInfo = modal.querySelector('#ticket-pagination-info');
  
  let allTickets = [];
  let selectedTickets = new Set();
  let currentlyAssociatedTickets = new Set(); // Track tickets currently associated with contact
  let searchTimeout = null;
  
  // Search input handler
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      const searchTerm = e.target.value.trim();
      
      searchTimeout = setTimeout(() => {
        if (searchTerm) {
          searchTickets(searchTerm, contactId);
        } else {
          loadExistingTickets(contactId);
        }
      }, 300); // Debounce search
    });
  }
  
  // Sort dropdown handler
  if (sortDropdown) {
    sortDropdown.addEventListener('change', () => {
      sortTickets(sortDropdown.value);
    });
  }
  
  // Add selected button handler
  if (addSelectedBtn) {
    addSelectedBtn.addEventListener('click', async () => {
      if (selectedTickets.size === 0) {
        alert('Please select at least one ticket');
        return;
      }
      
      try {
        addSelectedBtn.disabled = true;
        addSelectedBtn.textContent = 'Saving...';
        
        console.log('[Ticket Modal] Selected tickets:', Array.from(selectedTickets));
        console.log('[Ticket Modal] Currently associated:', Array.from(currentlyAssociatedTickets));
        
        // Determine which tickets to associate and disassociate
        const ticketsToAssociate = Array.from(selectedTickets).filter(
          ticketId => !currentlyAssociatedTickets.has(ticketId)
        );
        const ticketsToDisassociate = Array.from(currentlyAssociatedTickets).filter(
          ticketId => !selectedTickets.has(ticketId)
        );
        
        console.log('[Ticket Modal] Tickets to associate:', ticketsToAssociate);
        console.log('[Ticket Modal] Tickets to disassociate:', ticketsToDisassociate);
        
        // Associate new tickets
        if (ticketsToAssociate.length > 0) {
          await associateTicketsWithContact(contactId, ticketsToAssociate);
        }
        
        // Disassociate unchecked tickets
        if (ticketsToDisassociate.length > 0) {
          await disassociateTicketsFromContact(contactId, ticketsToDisassociate);
        }
        
        // Update currentlyAssociatedTickets to reflect new state
        currentlyAssociatedTickets.clear();
        selectedTickets.forEach(ticketId => {
          currentlyAssociatedTickets.add(ticketId);
        });
        
        console.log('[Ticket Modal] Successfully updated ticket associations');
        
        // Close modal
        if (closeModal) {
          closeModal();
        }
        
        // Refresh tickets section in sidebar
        setTimeout(() => {
          const ticketsSection = document.querySelector('.tickets-section');
          if (ticketsSection) {
            const contactIdAttr = ticketsSection.getAttribute('data-contact-id');
            if (contactIdAttr) {
              // Reset loaded flag to force refresh
              ticketsSection.dataset.ticketsLoaded = 'false';
              // Refresh count
              refreshTicketsCount(contactIdAttr, ticketsSection).catch(error => {
                console.error('[Content] Error refreshing tickets count after association:', error);
              });
              // If section is expanded, reload tickets
              const ticketsContent = ticketsSection.querySelector('.tickets-content');
              if (ticketsContent && ticketsContent.style.display !== 'none') {
                loadContactTickets(contactIdAttr, ticketsSection);
              }
            }
          }
        }, 100);
        
      } catch (error) {
        console.error('[Ticket Modal] Error updating ticket associations:', error);
        alert(`Error updating tickets: ${error.message || 'Failed to update ticket associations'}`);
        addSelectedBtn.disabled = false;
        addSelectedBtn.textContent = 'Save';
      }
    });
  }
  
  // Cancel button handler
  if (cancelBtn && closeModal) {
    cancelBtn.addEventListener('click', closeModal);
  }
  
  // Function to load existing tickets
  async function loadExistingTickets(contactId) {
    try {
      ticketListLoading.style.display = 'block';
      ticketList.innerHTML = '';
      ticketListEmpty.style.display = 'none';
      
      // Fetch all tickets and associated tickets in parallel
      // fetchTicketsFromHubSpot returns tickets associated with the contact
      // For "Add existing", we need ALL tickets (not filtered by contact)
      console.log('[Ticket Modal] Loading all tickets for "Add existing" panel');
      
      let allTicketsList = [];
      try {
        allTicketsList = await fetchAllTicketsFromHubSpot(null);
        console.log('[Ticket Modal] Fetched all tickets:', allTicketsList.length);
      } catch (error) {
        console.error('[Ticket Modal] Error fetching all tickets:', error);
        // Try alternative: use getHubSpotTickets with fetchAll flag
        try {
          const response = await sendExtensionMessage({
            action: 'getHubSpotTickets',
            contactId: null,
            fetchAll: true
          });
          if (response && response.success && response.data) {
            allTicketsList = response.data;
            console.log('[Ticket Modal] Fetched all tickets via getHubSpotTickets:', allTicketsList.length);
          }
        } catch (err) {
          console.error('[Ticket Modal] Error with getHubSpotTickets fallback:', err);
        }
      }
      
      // Get tickets currently associated with this contact
      const associatedTicketsList = await fetchTicketsFromHubSpot(contactId).catch(() => []);
      console.log('[Ticket Modal] Fetched associated tickets:', associatedTicketsList.length);
      
      // Track currently associated tickets
      currentlyAssociatedTickets.clear();
      selectedTickets.clear(); // Reset selected tickets
      
      if (associatedTicketsList && associatedTicketsList.length > 0) {
        associatedTicketsList.forEach(ticket => {
          const ticketId = ticket.id || ticket.hs_object_id || '';
          if (ticketId) {
            const ticketIdStr = String(ticketId);
            currentlyAssociatedTickets.add(ticketIdStr);
            // Also add to selected tickets so they appear checked
            selectedTickets.add(ticketIdStr);
          }
        });
      }
      
      ticketListLoading.style.display = 'none';
      
      // Use all tickets for display, but mark associated ones
      if (allTicketsList && allTicketsList.length > 0) {
        allTickets = allTicketsList;
        displayTickets(allTicketsList);
        updateTicketCount(allTicketsList.length);
        updatePaginationInfo(allTicketsList.length);
        updateSelectedCount(); // Update button state
      } else {
        ticketListEmpty.style.display = 'block';
        updateTicketCount(0);
        updatePaginationInfo(0);
      }
    } catch (error) {
      console.error('[Ticket Modal] Error loading tickets:', error);
      ticketListLoading.style.display = 'none';
      ticketListEmpty.style.display = 'block';
      ticketListEmpty.innerHTML = '<p>Error loading tickets. Please try again.</p>';
      updateTicketCount(0);
      updatePaginationInfo(0);
    }
  }
  
  // Initialize count to 0 on load
  updateTicketCount(0);
  
  // Function to search tickets
  async function searchTickets(searchTerm, contactId) {
    try {
      ticketListLoading.style.display = 'block';
      ticketList.innerHTML = '';
      ticketListEmpty.style.display = 'none';
      
      // For "Add existing", we want to search ALL tickets, not just associated ones
      // Pass null as contactId to get all tickets, or use fetchAllTicketsFromHubSpot if search is empty
      let tickets;
      if (!searchTerm || searchTerm.trim() === '') {
        // Empty search - fetch all tickets
        tickets = await fetchAllTicketsFromHubSpot(contactId);
      } else {
        // Has search term - search all tickets (pass null to not filter by contact)
        tickets = await searchTicketsInHubSpot(searchTerm, null);
      }
      
      ticketListLoading.style.display = 'none';
      
      if (tickets && tickets.length > 0) {
        allTickets = tickets;
        displayTickets(tickets);
        updateTicketCount(tickets.length);
        updatePaginationInfo(tickets.length);
      } else {
        ticketListEmpty.style.display = 'block';
        updateTicketCount(0);
        updatePaginationInfo(0);
      }
    } catch (error) {
      console.error('[Ticket Modal] Error searching tickets:', error);
      ticketListLoading.style.display = 'none';
      ticketListEmpty.style.display = 'block';
      ticketListEmpty.innerHTML = '<p>Error searching tickets. Please try again.</p>';
      updateTicketCount(0);
      updatePaginationInfo(0);
    }
  }
  
  // Function to display tickets
  function displayTickets(tickets) {
    if (!tickets || tickets.length === 0) {
      ticketListEmpty.style.display = 'block';
      return;
    }
    
    ticketListEmpty.style.display = 'none';
    ticketList.innerHTML = tickets.map(ticket => formatTicketItem(ticket)).join('');
    
    // Setup checkbox handlers
    const checkboxes = ticketList.querySelectorAll('.ticket-item-checkbox');
    checkboxes.forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        const ticketId = String(e.target.getAttribute('data-ticket-id'));
        if (e.target.checked) {
          selectedTickets.add(ticketId);
        } else {
          selectedTickets.delete(ticketId);
        }
        updateSelectedCount();
      });
    });
  }
  
  // Function to format ticket item
  function formatTicketItem(ticket) {
    const ticketId = ticket.id || ticket.hs_object_id || '';
    const subject = ticket.properties?.subject || ticket.subject || 'Untitled Ticket';
    const isChecked = selectedTickets.has(String(ticketId));
    
    return `
      <div class="ticket-item-row">
        <input type="checkbox" 
               class="ticket-item-checkbox" 
               data-ticket-id="${ticketId}"
               ${isChecked ? 'checked' : ''}>
        <label class="ticket-item-label">${subject}</label>
      </div>
    `;
  }
  
  // Function to sort tickets
  function sortTickets(sortBy) {
    let sorted = [...allTickets];
    
    switch (sortBy) {
      case 'oldest-first':
        sorted.sort((a, b) => {
          const dateA = new Date(a.properties?.createdate || a.createdAt || 0);
          const dateB = new Date(b.properties?.createdate || b.createdAt || 0);
          return dateA - dateB;
        });
        break;
      case 'subject-asc':
        sorted.sort((a, b) => {
          const subjA = (a.properties?.subject || a.subject || '').toLowerCase();
          const subjB = (b.properties?.subject || b.subject || '').toLowerCase();
          return subjA.localeCompare(subjB);
        });
        break;
      case 'subject-desc':
        sorted.sort((a, b) => {
          const subjA = (a.properties?.subject || a.subject || '').toLowerCase();
          const subjB = (b.properties?.subject || b.subject || '').toLowerCase();
          return subjB.localeCompare(subjA);
        });
        break;
      case 'priority-high':
        const priorityOrder = { 'URGENT': 4, 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
        sorted.sort((a, b) => {
          const priA = priorityOrder[a.properties?.hs_ticket_priority] || 0;
          const priB = priorityOrder[b.properties?.hs_ticket_priority] || 0;
          return priB - priA;
        });
        break;
      case 'priority-low':
        const priorityOrderLow = { 'URGENT': 4, 'HIGH': 3, 'MEDIUM': 2, 'LOW': 1 };
        sorted.sort((a, b) => {
          const priA = priorityOrderLow[a.properties?.hs_ticket_priority] || 0;
          const priB = priorityOrderLow[b.properties?.hs_ticket_priority] || 0;
          return priA - priB;
        });
        break;
      case 'recently-added':
      default:
        sorted.sort((a, b) => {
          const dateA = new Date(a.properties?.createdate || a.createdAt || 0);
          const dateB = new Date(b.properties?.createdate || b.createdAt || 0);
          return dateB - dateA;
        });
    }
    
    displayTickets(sorted);
  }
  
  // Function to update total ticket count
  function updateTicketCount(count) {
    if (totalCount) {
      totalCount.textContent = count;
    }
    if (countText) {
      countText.textContent = count === 1 ? 'Ticket' : 'Tickets';
    }
  }
  
  // Function to update selected count
  function updateSelectedCount() {
    const count = selectedTickets.size;
    addSelectedBtn.disabled = count === 0;
  }
  
  // Function to update pagination info
  function updatePaginationInfo(count) {
    if (paginationInfo) {
      paginationInfo.textContent = `${count} item${count === 1 ? '' : 's'}`;
    }
  }
  
  // Return handlers for external access
  return {
    loadTickets: loadExistingTickets,
    searchTickets: searchTickets
  };
}

// Function to fetch tickets from HubSpot
async function fetchTicketsFromHubSpot(contactId) {
  try {
    console.log('[Content] Fetching tickets from HubSpot for contact:', contactId);
    
    // Call edge function to get tickets
    const response = await sendExtensionMessage({
      action: 'getHubSpotTickets',
      contactId: contactId
    });
    
    if (response && response.success && response.data) {
      return response.data;
    }
    
    return [];
  } catch (error) {
    console.error('[Content] Error fetching tickets:', error);
    return [];
  }
}

// Function to fetch deals from HubSpot for a contact
async function fetchDealsFromHubSpot(contactId) {
  try {
    console.log('[Content] ===== FETCHING DEALS FROM HUBSPOT =====');
    console.log('[Content] Contact ID:', contactId, '(type:', typeof contactId, ')');
    
    if (!contactId) {
      console.warn('[Content] No contact ID provided for fetching deals');
      return [];
    }
    
    // Ensure contactId is a string
    const contactIdStr = String(contactId);
    console.log('[Content] Calling background script with contactId:', contactIdStr);
    
    // Call edge function to get deals
    const response = await sendExtensionMessage({
      action: 'getHubSpotDeals',
      contactId: contactIdStr
    });
    
    console.log('[Content] Deals fetch response:', response);
    
    if (response && response.success && response.data) {
      const deals = response.data;
      console.log('[Content] ✅ Deals fetched successfully:', deals.length, 'deals found for contact', contactIdStr);
      
      // Additional validation: Log deal details for debugging
      if (deals.length > 0) {
        console.log('[Content] Sample deal data:', deals.slice(0, 2).map(d => ({
          id: d.id,
          name: d.properties?.dealname,
          associations: d.associations
        })));
      }
      
      return deals;
    } else {
      console.error('[Content] ❌ Failed to fetch deals:', response?.error);
      return [];
    }
  } catch (error) {
    console.error('[Content] ❌ Error fetching deals:', error);
    console.error('[Content] Error stack:', error.stack);
    return [];
  }
}

// Function to search tickets in HubSpot
async function searchTicketsInHubSpot(searchTerm, contactId) {
  try {
    console.log('[Content] Searching tickets in HubSpot:', searchTerm);
    
    // Call edge function to search tickets
    const response = await sendExtensionMessage({
      action: 'searchHubSpotTickets',
      searchTerm: searchTerm,
      contactId: contactId
    });
    
    if (response && response.success && response.data) {
      return response.data;
    }
    
    return [];
  } catch (error) {
    console.error('[Content] Error searching tickets:', error);
    return [];
  }
}

// Function to fetch all tickets from HubSpot (not just associated ones)
async function fetchAllTicketsFromHubSpot(contactId) {
  try {
    console.log('[Content] Fetching all tickets from HubSpot (not filtered by contact)');
    
    // Try using getAllHubSpotTickets first
    let response = await sendExtensionMessage({
      action: 'getAllHubSpotTickets',
      contactId: null, // Pass null to indicate we want ALL tickets
      fetchAll: true
    });
    
    if (response && response.success && response.data && response.data.length > 0) {
      console.log('[Content] Fetched all tickets via getAllHubSpotTickets:', response.data.length);
      return response.data;
    }
    
    // Fallback 1: Use getHubSpotTickets with fetchAll flag
    console.log('[Content] Fallback 1: Trying getHubSpotTickets with fetchAll flag');
    response = await sendExtensionMessage({
      action: 'getHubSpotTickets',
      contactId: null,
      fetchAll: true // Flag to fetch all tickets, not just associated ones
    });
    
    if (response && response.success && response.data && response.data.length > 0) {
      console.log('[Content] Fetched all tickets via getHubSpotTickets:', response.data.length);
      return response.data;
    }
    
    // Fallback 2: Use search with wildcard pattern
    console.log('[Content] Fallback 2: Trying search with wildcard');
    response = await sendExtensionMessage({
      action: 'searchHubSpotTickets',
      searchTerm: '*', // Wildcard to get all
      contactId: null,
      fetchAll: true
    });
    
    if (response && response.success && response.data && response.data.length > 0) {
      console.log('[Content] Fetched all tickets via search wildcard:', response.data.length);
      return response.data;
    }
    
    // Fallback 3: Use search with empty term
    console.log('[Content] Fallback 3: Trying search with empty term');
    response = await sendExtensionMessage({
      action: 'searchHubSpotTickets',
      searchTerm: '',
      contactId: null,
      fetchAll: true
    });
    
    if (response && response.success && response.data) {
      console.log('[Content] Fetched tickets via search empty term:', response.data.length);
      return response.data;
    }
    
    console.warn('[Content] No tickets found via any method');
    return [];
  } catch (error) {
    console.error('[Content] Error fetching all tickets:', error);
    return [];
  }
}

// Function to associate tickets with a contact
async function associateTicketsWithContact(contactId, ticketIds) {
  try {
    console.log('[Content] Associating tickets with contact:', contactId, ticketIds);
    
    const response = await sendExtensionMessage({
      action: 'associateTicketsWithContact',
      contactId: contactId,
      ticketIds: ticketIds
    });
    
    if (response && response.success) {
      console.log('[Content] Successfully associated tickets');
      return response.data;
    } else {
      throw new Error(response?.error || 'Failed to associate tickets');
    }
  } catch (error) {
    console.error('[Content] Error associating tickets:', error);
    throw error;
  }
}

// Function to disassociate tickets from a contact
async function disassociateTicketsFromContact(contactId, ticketIds) {
  try {
    console.log('[Content] Disassociating tickets from contact:', contactId, ticketIds);
    
    const response = await sendExtensionMessage({
      action: 'disassociateTicketsFromContact',
      contactId: contactId,
      ticketIds: ticketIds
    });
    
    if (response && response.success) {
      console.log('[Content] Successfully disassociated tickets');
      return response.data;
    } else {
      throw new Error(response?.error || 'Failed to disassociate tickets');
    }
  } catch (error) {
    console.error('[Content] Error disassociating tickets:', error);
    throw error;
  }
}

// Function to setup copy email handler
function setupCopyEmailHandler() {
  const copyBtn = document.querySelector('.copy-email-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const email = copyBtn.getAttribute('data-email');
      if (email && email !== '--') {
        try {
          await navigator.clipboard.writeText(email);
          // Show feedback
          const originalHTML = copyBtn.innerHTML;
          copyBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          `;
          setTimeout(() => {
            copyBtn.innerHTML = originalHTML;
          }, 2000);
        } catch (err) {
          console.error('Failed to copy email:', err);
        }
      }
    });
  }
}

// Function to setup create contact form handler
function setupCreateContactForm(phoneNumber) {
  const form = document.getElementById('createContactForm');
  const createBtn = document.getElementById('createContactBtn');
  const messageDiv = document.getElementById('createContactMessage');
  const ownerSelect = document.getElementById('contactOwner');
  const ownerHint = document.getElementById('contactOwnerHint');
  const ownerGroup = document.getElementById('contactOwnerGroup');
  
  if (!form || !createBtn || !messageDiv) return;

  const { firstName: defaultFirst, lastName: defaultLast } = parseContactNameParts(
    getCurrentContactName()
  );
  const firstNameInput = document.getElementById('firstName');
  const lastNameInput = document.getElementById('lastName');
  if (firstNameInput && !firstNameInput.value && defaultFirst) {
    firstNameInput.value = defaultFirst;
  }
  if (lastNameInput && !lastNameInput.value && defaultLast) {
    lastNameInput.value = defaultLast;
  }

  getSyncSettings().then((syncSettings) => {
    const mode = syncSettings?.contact_owner_assignment || 'round_robin';
    if (ownerHint) {
      ownerHint.textContent = CONTACT_OWNER_ASSIGNMENT_HINTS[mode] || CONTACT_OWNER_ASSIGNMENT_HINTS.round_robin;
    }
    if (ownerGroup && mode === 'none') {
      ownerGroup.classList.add('contact-owner--auto-none');
    }
  });
  
  // Fetch and populate owners dropdown
  if (ownerSelect) {
    fetchHubSpotOwners().then(owners => {
      ownerSelect.innerHTML = '<option value="">Use automatic assignment</option>';
      
      if (owners && owners.length > 0) {
        owners.forEach(owner => {
          const option = document.createElement('option');
          option.value = owner.id;
          option.textContent = owner.email || owner.firstName + ' ' + owner.lastName || owner.id;
          ownerSelect.appendChild(option);
        });
      } else {
        ownerSelect.innerHTML = '<option value="">No owners available</option>';
      }
    }).catch(error => {
      console.error('[Content] Error loading owners:', error);
      if (ownerSelect) {
        ownerSelect.innerHTML = '<option value="">Error loading owners</option>';
      }
    });
  }
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Disable form
    createBtn.disabled = true;
    createBtn.querySelector('.btn-text').style.display = 'none';
    createBtn.querySelector('.btn-loading').style.display = 'inline';
    messageDiv.style.display = 'none';
    
    // Get form data: use real phone from data-phone-full when masked for display
    const phoneField = document.getElementById('phone');
    const rawPhone = phoneField?.getAttribute('data-phone-full') || phoneNumber || phoneField?.value || '';
    const hubspotPhoneFormat = formatPhoneForHubSpot(rawPhone);
    
    const firstName = document.getElementById('firstName').value.trim();
    const lastName = document.getElementById('lastName').value.trim();
    const contactName = `${firstName} ${lastName}`.trim() || getCurrentContactName() || '';

    const contactData = {
      sourceData: {
        phone: hubspotPhoneFormat || undefined,
        contact_name: contactName,
        last_message_date: Date.now(),
        email: document.getElementById('email').value.trim() || undefined,
        company: document.getElementById('company').value.trim() || undefined,
        job_title: document.getElementById('jobTitle').value.trim() || undefined,
      },
      properties: {
        hubspot_owner_id: (() => {
          const manual = document.getElementById('contactOwner')?.value?.trim();
          return manual || undefined;
        })(),
        lifecyclestage: document.getElementById('lifecycleStage').value.trim() || undefined,
        hs_lead_status: document.getElementById('leadStatus').value.trim() || undefined
      }
    };
    
    try {
      const result = await createHubSpotContact(contactData);
      
      // Show success message
      messageDiv.className = 'form-message success';
      messageDiv.textContent = '✅ Contact created successfully in HubSpot!';
      messageDiv.style.display = 'block';
      
      // Reset form
      form.reset();
      // Restore phone display (masked if privacy.mask_phone) and real value for submit
      const realPhone = formatPhoneForHubSpot(phoneNumber);
      const phoneInput = document.getElementById('phone');
      if (phoneInput) {
        const privacy = await getPrivacySettings();
        phoneInput.value = privacy.mask_phone && realPhone ? maskPhoneForPrivacy(realPhone) : (realPhone || '');
        phoneInput.setAttribute('data-phone-full', realPhone || '');
      }
      
      // Reload sidebar content to show the new contact after a short delay
      setTimeout(() => {
        updateSidebarContent();
      }, 1500);
      
    } catch (error) {
      // Show error message
      messageDiv.className = 'form-message error';
      messageDiv.textContent = `❌ Error: ${error.message || 'Failed to create contact'}`;
      messageDiv.style.display = 'block';
    } finally {
      // Re-enable form
      createBtn.disabled = false;
      createBtn.querySelector('.btn-text').style.display = 'inline';
      createBtn.querySelector('.btn-loading').style.display = 'none';
    }
  });
}

// Function to create a note in HubSpot (via background script)
async function createHubSpotNote(contactId, noteText, noteHtml, createTodo) {
  console.log('[Content] ===== CREATE HUBSPOT NOTE =====');
  console.log('[Content] HubSpot Contact ID:', contactId);
  console.log('[Content] Note text length:', noteText?.length || 0);
  console.log('[Content] Note text preview:', noteText ? `"${noteText.substring(0, 100)}${noteText.length > 100 ? '...' : ''}"` : 'undefined');
  console.log('[Content] Note HTML length:', noteHtml?.length || 0);
  console.log('[Content] Create todo:', createTodo);
  
  if (!contactId) {
    console.error('[Content] ❌ Validation failed: Contact ID is required');
    throw new Error('Contact ID is required to create a note');
  }
  
  console.log('[Content] ✅ Validation passed, sending message to background script...');
  
  // Convert contactId to number if it's a string
  const numericContactId = typeof contactId === 'string' ? parseInt(contactId, 10) : contactId;
  
  if (isNaN(numericContactId)) {
    console.error('[Content] ❌ Invalid contact ID:', contactId);
    throw new Error('Invalid contact ID format');
  }
  
  const messagePayload = {
    action: 'createHubSpotNote',
    data: {
      contactId: numericContactId,
      noteText: await appendMessageHistoryIfEnabled(noteText),
      noteHtml: noteHtml,
      createTodo: createTodo
    }
  };
  
  console.log('[Content] Creating note for contact:', numericContactId);

  try {
    console.log('[Content] Sending message to background script...');
    const response = await sendExtensionMessage(messagePayload);

    console.log('[Content] Response received from background script');
    console.log('[Content] Response success:', response?.success);

    if (!response) {
      throw new Error('No response from the extension. Please reload WhatsApp Web and try again.');
    }

    if (response.success) {
      console.log('[Content] ✅ Note created successfully!');
      return response.data;
    } else {
      const errorMsg = response.error || 'Failed to create note';
      console.error('[Content] ❌ Note creation failed:', errorMsg);
      throw new Error(errorMsg);
    }
  } catch (error) {
    console.error('[Content] ❌ Error in createHubSpotNote');
    console.error('[Content] Error type:', error.constructor.name);
    console.error('[Content] Error message:', error.message);
    if (error.stack) {
      console.error('[Content] Error stack:', error.stack);
    }
    console.log('[Content] =========================================');
    throw error;
  }
}

// Function to check HubSpot CRM for phone number match (via background script)
async function checkHubSpotContact(phoneNumber) {
  if (!phoneNumber) {
    console.log('[Content] No phone number to check');
    return null;
  }
  
  console.log('[Content] Sending HubSpot search request for phone:', phoneNumber);
  
  try {
    const response = await sendExtensionMessage({
      action: 'checkHubSpotContact',
      phoneNumber: phoneNumber
    });
    
    console.log('[Content] Received response from background:', response);
    
    if (response) {
      if (response.success) {
        if (response.data) {
          console.log('[Content] ✅ HubSpot Contact Match Found:', response.data);
          return response.data;
        } else {
          console.log('[Content] ⚠️ No matching contacts found in HubSpot for:', phoneNumber);
          return null;
        }
      } else if (response.error) {
        console.error('[Content] ❌ HubSpot API Error:', response.error);
        return null;
      }
    }
    
    console.log('[Content] No response or invalid response format');
    return null;
  } catch (error) {
    console.error('[Content] Error checking HubSpot:', error);
    return null;
  }
}

// Function to format create contact form HTML (respects privacy mask_phone for display)
async function formatCreateContactForm(phoneNumber, options = {}) {
  const { manualPhoneEntry = false } = options;
  const contactName = getCurrentContactName()?.trim() || '';
  // Convert phone number to HubSpot format (with dashes) for display
  const hubspotPhoneFormat = phoneNumber ? formatPhoneForHubSpot(phoneNumber) : '';
  const phoneReadonly = hubspotPhoneFormat && !manualPhoneEntry;
  const privacy = await getPrivacySettings();
  const displayPhone = privacy.mask_phone && hubspotPhoneFormat
    ? maskPhoneForPrivacy(hubspotPhoneFormat)
    : hubspotPhoneFormat;

  console.log('[Privacy] mask_phone check (Create Contact form):', {
    mask_phone: privacy.mask_phone,
    rawPhone: hubspotPhoneFormat || '(empty)',
    displayPhone: displayPhone || '(empty)',
    masked: privacy.mask_phone && !!hubspotPhoneFormat
  });

  const heading = manualPhoneEntry
    ? (contactName ? `No contact found for ${escapeHtml(contactName)}` : 'No Phone Number')
    : 'No Contact Found';
  const subtext = manualPhoneEntry
    ? (contactName
      ? `Could not read ${contactName}'s phone from WhatsApp. Enter it below to search or create them in HubSpot.`
      : 'Could not read a phone number from this chat. Enter it below to search or create in HubSpot.')
    : 'This phone number is not in your HubSpot CRM.';

  const { firstName: defaultFirstName, lastName: defaultLastName } = parseContactNameParts(contactName);

  return `
    <div class="no-contact-found">
      <h4>${heading}</h4>
      <p>${subtext}</p>
      
      <div class="create-contact-section">
        <h5>Create New Contact</h5>
        <form id="createContactForm" class="create-contact-form">
          <div class="form-group">
            <label for="firstName">First Name *</label>
            <input type="text" id="firstName" name="firstName" value="${escapeHtml(defaultFirstName)}" required>
          </div>
          <div class="form-group">
            <label for="lastName">Last Name *</label>
            <input type="text" id="lastName" name="lastName" value="${escapeHtml(defaultLastName)}" required>
          </div>
          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email">
          </div>
          <div class="form-group">
            <label for="phone">Phone</label>
            <input type="tel" id="phone" name="phone" value="${escapeHtml(displayPhone)}" data-phone-full="${escapeHtml(hubspotPhoneFormat)}" placeholder="${manualPhoneEntry ? 'Enter phone number' : ''}" ${phoneReadonly ? 'readonly' : ''}>
          </div>
          <div class="form-group">
            <label for="company">Company</label>
            <input type="text" id="company" name="company">
          </div>
          <div class="form-group">
            <label for="jobTitle">Job Title</label>
            <input type="text" id="jobTitle" name="jobTitle">
          </div>
          <div class="form-group" id="contactOwnerGroup">
            <label for="contactOwner">Contact Owner <span class="optional-label">(optional)</span></label>
            <p class="form-hint" id="contactOwnerHint"></p>
            <select id="contactOwner" name="contactOwner">
              <option value="">Loading owners...</option>
            </select>
          </div>
          <div class="form-group">
            <label for="lifecycleStage">Lifecycle Stage</label>
            <select id="lifecycleStage" name="lifecycleStage">
              <option value="">Select Lifecycle Stage</option>
              <option value="subscriber">Subscriber</option>
              <option value="lead">Lead</option>
              <option value="marketingqualifiedlead">Marketing Qualified Lead</option>
              <option value="salesqualifiedlead">Sales Qualified Lead</option>
              <option value="opportunity">Opportunity</option>
              <option value="customer">Customer</option>
              <option value="evangelist">Evangelist</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="form-group">
            <label for="leadStatus">Lead Status</label>
            <select id="leadStatus" name="leadStatus">
              <option value="">Select Lead Status</option>
              <option value="NEW">New</option>
              <option value="OPEN">Open</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="OPEN_DEAL">Open Deal</option>
              <option value="UNQUALIFIED">Unqualified</option>
              <option value="ATTEMPTED_TO_CONTACT">Attempted to Contact</option>
              <option value="CONNECTED">Connected</option>
              <option value="BAD_TIMING">Bad Timing</option>
              <option value="NOT_INTERESTED">Not Interested</option>
            </select>
          </div>
          <div class="form-actions">
            <button type="submit" id="createContactBtn" class="create-btn">
              <span class="btn-text">Create Contact</span>
              <span class="btn-loading" style="display: none;">Creating...</span>
            </button>
          </div>
          <div id="createContactMessage" class="form-message" style="display: none;"></div>
        </form>
      </div>
    </div>
  `;
}

// ==================== Dynamic Sidebar Fields ====================

// Store current contact data for soft re-render
let currentContactData = null;
let currentPhoneNumber = null;

/** Fallback when backend privacy is unavailable (e.g. error path in renderDefaultAboutSection) */
const DEFAULT_PRIVACY = { mask_phone: true, mask_media: false, allowed_properties: ['firstname_lastname', 'phone', 'email', 'company'] };
/** When rendering media/attachments, check (await getPrivacySettings()).mask_media and skip rendering if true */

/**
 * Get privacy settings: always from backend via background script (edge function, 5-min cache).
 */
async function getSyncSettings() {
  try {
    const response = await sendExtensionMessage({ action: 'getSyncSettings' });
    if (!response) return {
      contact_owner_assignment: 'round_robin',
      default_pipeline_id: null,
      default_stage_id: null,
    };
    if (response?.success && response.settings) {
      return response.settings;
    }
  } catch (error) {
    if (!isExtensionContextInvalidated(error)) {
      console.warn('[Content] getSyncSettings failed:', error);
    }
  }
  return {
    contact_owner_assignment: 'round_robin',
    default_pipeline_id: null,
    default_stage_id: null,
  };
}

const CONTACT_OWNER_ASSIGNMENT_HINTS = {
  round_robin: 'Owner is assigned automatically (round robin) when left blank.',
  creator: 'Owner is set to your HubSpot user (matched by email) when left blank.',
  none: 'No owner is assigned automatically. Pick one below to override.',
};

async function getPrivacySettings() {
  try {
    const response = await sendExtensionMessage({ action: 'getPrivacySettings' });
    if (!response) return DEFAULT_PRIVACY;
    if (response?.success && response.privacy) {
      console.log('[Privacy] Fetched from backend:', response.privacy);
      const p = response.privacy;
      return {
        mask_phone: !!p.mask_phone,
        mask_media: !!p.mask_media,
        allowed_properties: Array.isArray(p.allowed_properties) ? p.allowed_properties : null
      };
    }
  } catch (err) {
    if (!isExtensionContextInvalidated(err)) {
      console.warn('[Privacy] Failed to fetch from backend:', err);
    }
  }
  return DEFAULT_PRIVACY;
}

/**
 * Mask phone for display when privacy.mask_phone is true.
 * Keeps country code and last 3 digits visible: +971 *** *** 343
 */
function maskPhoneForPrivacy(phone) {
  if (!phone || typeof phone !== 'string') return phone;
  // Normalize: digits only, keep leading + so regex matches (handles +971-52-288-5343 etc.)
  const normalized = (phone.trim().startsWith('+') ? '+' : '') + phone.replace(/\D/g, '');
  const masked = normalized.replace(/(\+\d{1,4})\d+(\d{3})$/, '$1 *** *** $2');
  return masked === normalized ? phone : masked; // fallback to original if regex didn't match
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Map hubspot_property to display label
const fieldLabels = {
  email: 'Email',
  phone: 'Phone Number',
  company: 'Company',
  lifecyclestage: 'Lifecycle Stage',
  hs_lead_status: 'Lead Status',
  createdate: 'Create Date',
  jobtitle: 'Job Title',
  hubspot_owner_id: 'Owner',
  firstname: 'First Name',
  lastname: 'Last Name',
  firstname_lastname: 'Full Name',
  website: 'Website',
  city: 'City',
  state: 'State',
  country: 'Country',
  notes_last_updated: 'Notes Updated'
};

/**
 * Fetch sidebar field config via background (includes user session token).
 */
// Canonical sidebar field catalog — must mirror the Sidebar Designer (useSidebarFields.ts).
// The list lives here; the backend only stores each key's on/off preference.
const SIDEBAR_CONTACT_CATALOG = [
  { hubspot_property: 'firstname_lastname', column_name: 'Contact Name' },
  { hubspot_property: 'phone', column_name: 'Phone' },
  { hubspot_property: 'email', column_name: 'Email' },
  { hubspot_property: 'company', column_name: 'Company' },
  { hubspot_property: 'jobtitle', column_name: 'Job Title' },
  { hubspot_property: 'hubspot_owner_id', column_name: 'Contact Owner' },
  { hubspot_property: 'lifecyclestage', column_name: 'Lifecycle Stage' },
  { hubspot_property: 'hs_lead_status', column_name: 'Lead Status' },
  { hubspot_property: 'createdate', column_name: 'Create Date' },
];
const SIDEBAR_LOCKED_FIELDS = ['firstname_lastname', 'phone'];

// Map of field_key -> enabled. null until loaded; missing keys default to enabled.
let sidebarPrefsCache = null;
function isSidebarFieldEnabled(key) {
  if (SIDEBAR_LOCKED_FIELDS.includes(key)) return true;
  if (!sidebarPrefsCache) return true; // default visible until prefs load
  return sidebarPrefsCache[key] !== false;
}

async function fetchSidebarFieldsFromBackend(userId) {
  if (!userId || extensionContextInvalidated) {
    return { contactFields: [], actionFields: [] };
  }

  if (!(await hasExtensionAuthToken())) {
    return { contactFields: [], actionFields: [] };
  }

  try {
    const response = await sendExtensionMessage({
      action: 'getSidebarFields',
      data: { userId }
    });

    const data = response?.data || {};

    // Build the prefs cache from the flat fields list (key -> enabled).
    const prefs = {};
    (data.fields || []).forEach((f) => {
      const key = f.field_key || f.hubspot_property;
      if (key) prefs[key] = (f.is_enabled ?? f.enabled) !== false;
    });
    sidebarPrefsCache = prefs;

    // Return the canonical About contact fields, filtered by prefs (locked always on).
    const contactFields = SIDEBAR_CONTACT_CATALOG
      .filter((f) => SIDEBAR_LOCKED_FIELDS.includes(f.hubspot_property) || isSidebarFieldEnabled(f.hubspot_property))
      .map((f) => ({ ...f, field_type: 'contact_info', enabled: true }));

    return { contactFields, actionFields: [] };
  } catch {
    return { contactFields: [], actionFields: [] };
  }
}

/**
 * Function to fetch enabled action fields for a specific user
 */
async function getEnabledActionFields(userId) {
  if (!userId) {
    console.error('[Action Fields] ❌ No userId provided for fetching action fields');
    return [];
  }

  const { actionFields } = await fetchSidebarFieldsFromBackend(userId);
  const enabledActions = actionFields.filter(
    (field) => field.field_type === 'action' && field.enabled === true
  );
  console.log(`[Action Fields] ✅ Fetched ${enabledActions.length} enabled action fields for user`);
  return enabledActions;
}

/**
 * Fetch enabled sidebar fields for current user
 */
async function getEnabledSidebarFields(userId) {
  return fetchSidebarFieldsFromBackend(userId);
}

/**
 * Get value from contact properties by property name
 */
function getContactPropertyValue(props, property) {
  // Handle different property name variations
  const propertyMap = {
    'email': ['email'],
    'phone': ['phone'],
    'company': ['company', 'associatedcompanyname', 'companyname'],
    'lifecyclestage': ['lifecyclestage', 'hs_lifecyclestage'],
    'hs_lead_status': ['hs_lead_status', 'lead_status', 'hs_lead_status_label'],
    'createdate': ['createdate', 'hs_createdate'],
    'jobtitle': ['jobtitle', 'job_title'],
    'hubspot_owner_id': ['hubspot_owner_id', 'hs_owner_id'],
    'firstname': ['firstname'],
    'lastname': ['lastname'],
    'firstname_lastname': ['firstname', 'lastname'], // Combined name
    'website': ['website', 'hs_analytics_source'],
    'city': ['city'],
    'state': ['state'],
    'country': ['country'],
    'notes_last_updated': ['notes_last_updated', 'hs_note_last_contacted_date']
  };

  const possibleKeys = propertyMap[property] || [property];
  
  for (const key of possibleKeys) {
    if (props[key] !== undefined && props[key] !== null && props[key] !== '') {
      return props[key];
    }
  }
  
  return null;
}

/**
 * Format date value
 */
function formatDateValue(dateValue) {
  if (!dateValue) return '--';
  
  try {
    const date = new Date(dateValue);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit' 
      });
    }
  } catch (e) {
    console.warn('[Sidebar Fields] Error formatting date:', e);
  }
  
  return dateValue || '--';
}

/**
 * Generate dynamic about section HTML based on enabled fields and privacy settings
 */
async function renderAboutSection(contact, userId) {
  try {
    const [sidebarData, privacy] = await Promise.all([getEnabledSidebarFields(userId), getPrivacySettings()]);
    let contactFields = sidebarData.contactFields || [];
    const props = contact.properties || {};
    const aboutContactId = contact.id || contact.hs_object_id || props.hs_object_id || '';

    // Filter CRM fields by privacy.allowed_properties when set
    if (Array.isArray(privacy.allowed_properties) && privacy.allowed_properties.length > 0) {
      const allowedSet = new Set(privacy.allowed_properties.map(k => String(k).toLowerCase()));
      contactFields = contactFields.filter(f => allowedSet.has(String(f.hubspot_property || f.field_key || '').toLowerCase()));
    }

    if (!contactFields || contactFields.length === 0) {
      return renderDefaultAboutSection(props, privacy);
    }

    const fieldsHtml = contactFields.map((field, index) => {
      const property = field.hubspot_property || field.field_key;
      const label = fieldLabels[property] || property.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      let value;

      if (property === 'firstname_lastname') {
        const firstName = props.firstname || '';
        const lastName = props.lastname || '';
        value = `${firstName} ${lastName}`.trim() || '--';
      } else {
        value = getContactPropertyValue(props, property);
      }

      if (property === 'createdate' || property === 'hs_createdate' || property === 'notes_last_updated') {
        value = formatDateValue(value);
      } else {
        value = value || '--';
      }

      if (property === 'phone' && privacy.mask_phone && value && value !== '--') {
        value = maskPhoneForPrivacy(String(value));
      }

      const valueClass = property === 'email' ? 'email-value' : property === 'phone' ? 'phone-value' : '';

      // Contact owner: the raw value is an owner id — render a placeholder that
      // setupOwnerNameResolution() replaces with the owner's real name.
      if (property === 'hubspot_owner_id') {
        const ownerId = getContactPropertyValue(props, 'hubspot_owner_id') || '';
        return `
        <div class="info-row">
          <div class="info-label-text">${label}</div>
          <div class="info-value owner-value" data-owner-id="${escapeHtml(String(ownerId))}">${ownerId ? 'Loading…' : 'Unassigned'}</div>
        </div>
        ${index < contactFields.length - 1 ? '<div class="info-divider"></div>' : ''}
      `;
      }

      // Lifecycle stage and lead status are editable: render an enum <select> that PATCHes
      // HubSpot on change. Options are populated asynchronously by setupEditableContactFields().
      if ((property === 'lifecyclestage' || property === 'hs_lead_status') && aboutContactId) {
        const rawValue = property === 'firstname_lastname' ? '' : (getContactPropertyValue(props, property) || '');
        return `
        <div class="info-row">
          <div class="info-label-text">${label}</div>
          <div class="info-value">
            <select class="editable-contact-field info-edit-select"
                    data-property="${property}"
                    data-contact-id="${escapeHtml(String(aboutContactId))}"
                    data-current="${escapeHtml(String(rawValue))}">
              <option value="${escapeHtml(String(rawValue))}">${escapeHtml(String(value))}</option>
            </select>
          </div>
        </div>
        ${index < contactFields.length - 1 ? '<div class="info-divider"></div>' : ''}
      `;
      }

      return `
        <div class="info-row">
          <div class="info-label-text">${label}</div>
          <div class="info-value ${valueClass}">${escapeHtml(String(value))}</div>
        </div>
        ${index < contactFields.length - 1 ? '<div class="info-divider"></div>' : ''}
      `;
    }).join('');

    // Always surface Contact Owner, even if it isn't in the enabled-fields config.
    const hasOwnerField = contactFields.some(
      (f) => (f.hubspot_property || f.field_key) === 'hubspot_owner_id'
    );
    let ownerRowHtml = '';
    if (!hasOwnerField && isSidebarFieldEnabled('hubspot_owner_id')) {
      const ownerId = getContactPropertyValue(props, 'hubspot_owner_id') || '';
      ownerRowHtml = `
        <div class="info-divider"></div>
        <div class="info-row">
          <div class="info-label-text">Contact Owner</div>
          <div class="info-value owner-value" data-owner-id="${escapeHtml(String(ownerId))}">${ownerId ? 'Loading…' : 'Unassigned'}</div>
        </div>
      `;
    }

    return `
      <div class="about-section">
        <div class="about-header">
          <div class="about-title">
            <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span>About this contact</span>
          </div>
        </div>
        <div class="contact-info">
          ${fieldsHtml}
          ${ownerRowHtml}
        </div>
      </div>
    `;
  } catch (error) {
    console.warn('[Sidebar Fields] Error rendering about section:', error);
    return renderDefaultAboutSection(contact.properties || {}, DEFAULT_PRIVACY);
  }
}

/**
 * Soft refresh: Re-render only the "About this contact" section without page reload
 */
async function refreshAboutSection() {
  if (!currentContactData || !currentPhoneNumber) {
    console.log('[Sidebar Refresh] No contact data stored, cannot refresh');
    return;
  }
  
  try {
    console.log('[Sidebar Refresh] 🔄 Refreshing about section...');
    
    // Get userId
    const result = await extensionStorageGet('external_auth_session');
    const session = result.external_auth_session;
    const userId = session?.user?.id || null;
    
    if (!userId) {
      console.warn('[Sidebar Refresh] No userId found');
      return;
    }
    
    // Re-render the about section
    const newAboutSectionHTML = await renderAboutSection(currentContactData, userId);
    
    // Find and update only the about-section
    const aboutSection = document.querySelector('#hubspot-sidebar .about-section');
    if (aboutSection) {
      aboutSection.outerHTML = newAboutSectionHTML;
      // Re-bind handlers since outerHTML replaced the element.
      setupAboutCollapsible();
      setupEditableContactFields();
      setupOwnerNameResolution();
      console.log('[Sidebar Refresh] ✅ About section refreshed successfully');
    } else {
      console.warn('[Sidebar Refresh] About section not found in DOM');
    }
  } catch (error) {
    console.error('[Sidebar Refresh] Error refreshing about section:', error);
  }
}

/**
 * Render default about section (fallback when no enabled fields). Respects privacy (mask_phone, allowed_properties).
 */
function renderDefaultAboutSection(props, privacy = DEFAULT_PRIVACY) {
  const allowed = Array.isArray(privacy?.allowed_properties) && privacy.allowed_properties.length > 0
    ? new Set(privacy.allowed_properties.map(k => String(k).toLowerCase()))
    : null;
  const show = (key) => !allowed || allowed.has(String(key).toLowerCase());

  let rawPhone = props.phone || '--';
  const phone = privacy?.mask_phone && rawPhone !== '--' ? maskPhoneForPrivacy(String(rawPhone)) : rawPhone;
  const email = props.email || '--';
  const company = props.company || props.associatedcompanyname || props.companyname || '--';
  const lifecycleStage = props.lifecyclestage || props.hs_lifecyclestage || '--';
  const leadStatus = props.hs_lead_status || props.lead_status || props.hs_lead_status_label || '--';
  const createDate = formatDateValue(props.createdate || props.hs_createdate);

  const rows = [];
  if (show('email')) rows.push({ label: 'Email', value: email, cls: 'email-value' });
  if (show('phone')) rows.push({ label: 'Phone Number', value: phone, cls: 'phone-value' });
  if (show('company')) rows.push({ label: 'Company', value: company, cls: '' });
  if (show('lifecyclestage')) rows.push({ label: 'Lifecycle Stage', value: lifecycleStage, cls: '' });
  if (show('hs_lead_status')) rows.push({ label: 'Lead Status', value: leadStatus, cls: '' });
  if (show('createdate')) rows.push({ label: 'Create Date', value: createDate, cls: '' });

  const rowsHtml = rows.map((r, i) => `
    <div class="info-row">
      <div class="info-label-text">${escapeHtml(r.label)}</div>
      <div class="info-value ${r.cls}">${escapeHtml(r.value)}</div>
    </div>
    ${i < rows.length - 1 ? '<div class="info-divider"></div>' : ''}
  `).join('');

  // Always surface Contact Owner, resolved to a name by setupOwnerNameResolution().
  const ownerId = props.hubspot_owner_id || props.hs_owner_id || '';
  const ownerRowHtml = `
    ${rows.length ? '<div class="info-divider"></div>' : ''}
    <div class="info-row">
      <div class="info-label-text">Contact Owner</div>
      <div class="info-value owner-value" data-owner-id="${escapeHtml(String(ownerId))}">${ownerId ? 'Loading…' : 'Unassigned'}</div>
    </div>
  `;

  return `
    <div class="about-section">
      <div class="about-header">
        <div class="about-title">
          <svg class="chevron-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
          <span>About this contact</span>
        </div>
      </div>
      <div class="contact-info">
        ${rowsHtml}
        ${ownerRowHtml}
      </div>
    </div>
  `;
}

// ==================== Sidebar Fields Polling ====================

async function initializeSidebarFieldsSync() {
  if (extensionContextInvalidated) return;
  const userId = await getExtensionUserId();
  if (!userId) return;
  startSidebarFieldsPolling(userId);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initializeSidebarFieldsSync, 2000);
  });
} else {
  setTimeout(initializeSidebarFieldsSync, 2000);
}

function cleanupSidebarFieldsSync() {
  stopSidebarFieldsPolling();
}

window.addEventListener('beforeunload', cleanupSidebarFieldsSync);

window.testSidebarFieldsRefresh = async function() {
  await refreshAboutSection();
};

window.refreshAboutSection = refreshAboutSection;

let lastSidebarFieldsHash = null;

/**
 * Poll for sidebar fields changes from dashboard config
 */
async function startSidebarFieldsPolling(userId) {
  if (extensionContextInvalidated) return;

  // Get initial state
  try {
    const { contactFields } = await getEnabledSidebarFields(userId);
    lastSidebarFieldsHash = JSON.stringify(contactFields.map(f => ({ id: f.id, enabled: f.enabled })));
  } catch {
    // use defaults
  }

  // Poll every 5 seconds
  sidebarFieldsPollingInterval = setInterval(async () => {
    if (extensionContextInvalidated) {
      stopSidebarFieldsPolling();
      return;
    }
    try {
      const { contactFields } = await getEnabledSidebarFields(userId);
      const currentHash = JSON.stringify(contactFields.map(f => ({ id: f.id, enabled: f.enabled })));
      
      if (lastSidebarFieldsHash && currentHash !== lastSidebarFieldsHash) {
        await refreshAboutSection();
      }
      
      lastSidebarFieldsHash = currentHash;
    } catch {
      // ignore transient polling errors
    }
  }, 5000);
}

/**
 * Stop polling
 */
function stopSidebarFieldsPolling() {
  if (sidebarFieldsPollingInterval) {
    clearInterval(sidebarFieldsPollingInterval);
    sidebarFieldsPollingInterval = null;
  }
}

// ==================== End Dynamic Sidebar Fields ====================

// Function to format contact details HTML
async function formatContactDetails(contacts, phoneNumber) {
  // Store contact data for soft re-render
  if (contacts && contacts.length > 0) {
    currentContactData = contacts[0];
    currentPhoneNumber = phoneNumber;
  } else {
    currentContactData = null;
    currentPhoneNumber = phoneNumber;
  }
  
  if (!contacts || contacts.length === 0) {
    return await formatCreateContactForm(phoneNumber);
  }
  
  const contact = contacts[0]; // Use first contact
  const props = contact.properties || {};
  
  // Get userId for dynamic sidebar fields
  let userId = null;
  try {
    const result = await extensionStorageGet('external_auth_session');
    const session = result.external_auth_session;
    userId = session?.user?.id || null;
  } catch (error) {
    console.error('[Content] Error getting userId:', error);
  }

  // Warm the sidebar prefs cache so section/action visibility gating below is accurate.
  try { if (userId) await fetchSidebarFieldsFromBackend(userId); } catch { /* defaults to visible */ }

  // Get the actual HubSpot contact ID (numeric)
  const hubspotContactId = contact.id || contact.hs_object_id || props.hs_object_id || '';
  
  // Debug: Log all available properties to see what's available
  
  const firstName = props.firstname || '';
  const lastName = props.lastname || '';
  const fullName = `${firstName} ${lastName}`.trim() || 'Unknown';
  const phone = props.phone || '--';
  const email = props.email || '--';
  
  // Try multiple possible company property names from HubSpot
  // HubSpot stores company in 'company' property, or as associatedcompanyid/associatedcompanyname
  let company = '--';
  if (props.company && props.company.trim() !== '') {
    company = props.company;
  } else if (props.associatedcompanyname && props.associatedcompanyname.trim() !== '') {
    company = props.associatedcompanyname;
  } else if (props.companyname && props.companyname.trim() !== '') {
    company = props.companyname;
  }
  
  
  const jobTitle = props.jobtitle || props.job_title || '--';
  
  // Extract lifecycle stage, lead status, and create date
  const lifecycleStage = props.lifecyclestage || props.hs_lifecyclestage || '--';
  const leadStatus = props.hs_lead_status || props.lead_status || props.hs_lead_status_label || '--';
  
  // Format create date
  let createDate = '--';
  if (props.createdate || props.hs_createdate) {
    const dateValue = props.createdate || props.hs_createdate;
    try {
      const date = new Date(dateValue);
      if (!isNaN(date.getTime())) {
        // Format as MM/DD/YYYY
        createDate = date.toLocaleDateString('en-US', { 
          year: 'numeric', 
          month: '2-digit', 
          day: '2-digit' 
        });
      }
    } catch (e) {
      console.warn('[Content] Error formatting date:', e);
    }
  }
  
  return `
    <div class="contact-details">
      <div class="contact-header">
        <div class="contact-header-row-1">
          <div class="contact-avatar">
            ${fullName.charAt(0).toUpperCase()}
          </div>
          <div class="contact-name-section">
            <h3>${fullName}</h3>
            ${hubSpotOpenLink('contact', hubspotContactId, 'Open contact in HubSpot')}
          </div>
        </div>
        <div class="contact-job-section">
          <span class="job-label">${jobTitle !== '--' ? jobTitle : 'Job'}</span>
        </div>
        <div class="contact-email-header">
          ${email !== '--' ? `
            <a href="mailto:${email}" class="email-link">${email}</a>
            <button class="copy-email-btn" title="Copy email" data-email="${email}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          ` : ''}
        </div>
        <div class="contact-actions">
            ${!isSidebarFieldEnabled('action_note') ? '' : `
            <button class="action-btn" id="create-note-btn" title="Create a note" data-name="${fullName}" data-email="${email}" data-contact-id="${hubspotContactId}" data-phone="${phoneNumber}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
              <span>Note</span>
            </button>`}
            ${!isSidebarFieldEnabled('action_email') ? '' : `
            <button class="action-btn" id="create-email-btn" title="Create a Email" data-email="${email}" data-name="${fullName}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                <polyline points="22,6 12,13 2,6"></polyline>
              </svg>
              <span>Email</span>
            </button>`}
            ${!isSidebarFieldEnabled('action_log_whatsapp') ? '' : `
            <button class="action-btn action-btn-whatsapp" id="log-whatsapp-message-btn" title="Log a WhatsApp message">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path fill="#25D366" d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.945C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.86 9.86 0 0 0 1.51 5.26l-.999 3.648 3.738-.981v-.026zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.521.149-.174.198-.298.298-.497.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/>
              </svg>
              <span>Log</span>
            </button>`}
            ${!isSidebarFieldEnabled('action_task') ? '' : `
            <button class="action-btn" id="create-task-btn" title="Create a Task" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 11 12 14 22 4"></polyline>
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
              </svg>
              <span>Task</span>
            </button>`}
            ${!isSidebarFieldEnabled('action_meeting') ? '' : `
            <button class="action-btn" id="schedule-meeting-btn" title="Schedule a meeting" data-email="${email}" data-name="${fullName}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
              <span>Meeting</span>
            </button>`}
            <div class="more-actions-wrapper">
              <button class="action-btn" id="more-actions-btn" title="More">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="1"></circle>
                  <circle cx="12" cy="5" r="1"></circle>
                  <circle cx="12" cy="19" r="1"></circle>
                </svg>
                <span>More</span>
              </button>
              <div class="more-actions-dropdown" id="more-actions-dropdown" style="display: none;">
                <!-- Kept as a hidden anchor for action-field/template insertion logic.
                     The user-facing "Log WhatsApp" action now lives in the primary action row. -->
                <div class="more-actions-option" id="log-whatsapp-message-option" style="display: none;">
                  <div class="more-actions-option-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <!-- WhatsApp icon -->
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" fill="#25D366"/>
                      <!-- Plus sign badge -->
                      <circle cx="17.5" cy="6.5" r="5" fill="#25D366"/>
                      <line x1="17.5" y1="4" x2="17.5" y2="9" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
                      <line x1="15" y1="6.5" x2="20" y2="6.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                  </div>
                  <span>Log a WhatsApp message</span>
                </div>
                ${!isSidebarFieldEnabled('action_ticket') ? '' : `
                <div class="more-actions-option" id="more-create-ticket-option" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}">
                  <div class="more-actions-option-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M2 9a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9z"></path>
                      <path d="M8 9v6"></path>
                      <path d="M16 9v6"></path>
                      <circle cx="6" cy="12" r="1"></circle>
                      <circle cx="18" cy="12" r="1"></circle>
                    </svg>
                  </div>
                  <span>Create Ticket</span>
                </div>`}
              </div>
            </div>
          </div>
        </div>
      </div>
      ${await renderAboutSection(contact, userId)}
      ${!isSidebarFieldEnabled('section_activity') ? '' : `
      <div class="activities-section" data-contact-id="${hubspotContactId}">
        <div class="activities-header">
          <div class="activities-title">
            <svg class="chevron-icon activities-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span>Recent activity (<span class="activities-count">0</span>)</span>
          </div>
        </div>
        <div class="activities-content">
          <div class="activities-list">
            <div class="activities-empty">No recent activity yet.</div>
          </div>
        </div>
      </div>
      `}
      ${!isSidebarFieldEnabled('section_notes') ? '' : `
      <div class="notes-section" data-contact-id="${hubspotContactId}">
        <div class="notes-header">
          <div class="notes-title">
            <svg class="chevron-icon notes-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span>Note created (<span class="notes-count">0</span>)</span>
          </div>
          <div class="notes-header-actions">
            <button class="notes-add-btn" id="notes-add-btn" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}" title="Add Note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              <span>Add</span>
            </button>
          </div>
        </div>
        <div class="notes-content" style="display: none;">
          <div class="notes-loading" style="display: none;">
            <div class="loading-spinner"></div>
            <p>Loading notes...</p>
          </div>
          <div class="notes-list"></div>
          <div class="notes-empty" style="display: none;">
            <div class="notes-empty-content">
              <p class="notes-empty-text">No notes found for this contact.</p>
              <button class="notes-create-btn" id="notes-empty-create-btn" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
                <span>Create Note</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      `}
      ${!isSidebarFieldEnabled('section_tickets') ? '' : `
      <div class="tickets-section" data-contact-id="${hubspotContactId}">
        <div class="tickets-header">
          <div class="tickets-title">
            <svg class="chevron-icon tickets-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span>Ticket created (<span class="tickets-count">0</span>)</span>
          </div>
          <div class="tickets-header-actions">
            <button class="tickets-add-btn" id="tickets-add-btn" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}" title="Add Ticket">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              <span>Add</span>
            </button>
          </div>
        </div>
        <div class="tickets-content" style="display: none;">
          <div class="tickets-loading" style="display: none;">
            <div class="loading-spinner"></div>
            <p>Loading tickets...</p>
          </div>
          <div class="tickets-list"></div>
          <div class="tickets-empty" style="display: none;">
            <div class="tickets-empty-content">
              <p class="tickets-empty-text">No tickets found for this contact.</p>
              <button class="tickets-create-btn" id="tickets-empty-create-btn" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>Create Ticket</span>
              </button>
            </div>
          </div>
          <button class="tickets-view-all-btn" id="tickets-view-all-btn" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}">
            <span>View all associated Tickets</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
          </button>
        </div>
      </div>
      `}
      <!-- Tasks Section -->
      ${!isSidebarFieldEnabled('section_tasks') ? '' : `
      <div class="tasks-section" data-contact-id="${hubspotContactId}">
        <div class="tasks-header">
          <div class="tasks-title">
            <svg class="chevron-icon tasks-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span>Task created (<span class="tasks-count">0</span>)</span>
          </div>
          <div class="tasks-header-actions">
            <button class="tasks-add-btn" id="tasks-add-btn" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}" title="Add Task">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              <span>Add</span>
            </button>
          </div>
        </div>
        <div class="tasks-content" style="display: none;">
          <div class="tasks-loading" style="display: none;">
            <div class="loading-spinner"></div>
            <p>Loading tasks...</p>
          </div>
          <div class="tasks-list"></div>
          <div class="tasks-empty" style="display: none;">
            <div class="tasks-empty-content">
              <p class="tasks-empty-text">No tasks found for this contact.</p>
              <button class="tasks-create-btn" id="tasks-empty-create-btn" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>Create Task</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      `}
      <!-- Deals Section -->
      ${!isSidebarFieldEnabled('section_deals') ? '' : `
      <div class="deals-section" data-contact-id="${hubspotContactId}">
        <div class="deals-header">
          <div class="deals-title">
            <svg class="chevron-icon deals-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
            <span>Deal created (<span class="deals-count">0</span>)</span>
          </div>
          <div class="deals-header-actions">
            <button class="deals-add-btn" id="deals-add-btn" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}" title="Add Deal">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              <span>Add</span>
            </button>
          </div>
        </div>
        <div class="deals-content" style="display: none;">
          <div class="deals-loading" style="display: none;">
            <div class="loading-spinner"></div>
            <p>Loading deals...</p>
          </div>
          <div class="deals-list"></div>
          <div class="deals-empty" style="display: none;">
            <div class="deals-empty-content">
              <p class="deals-empty-text">No deals found for this contact.</p>
              <button class="deals-create-btn" id="deals-empty-create-btn" data-contact-id="${hubspotContactId}" data-name="${fullName}" data-email="${email}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                <span>Create Deal</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      `}
    </div>
  `;
}

// Incremented on each sidebar refresh so stale async updates are ignored
let sidebarContentUpdateToken = 0;
// Identity of the chat the sidebar is currently rendering, so observer-driven
// retriggers (firing on scroll as WhatsApp loads messages) don't rebuild the
// sidebar — or supersede an in-flight contact lookup — when the chat hasn't
// actually changed.
let lastRenderedChatKey = null;

// A stable-per-chat key from the conversation header title (the saved-contact
// name, or the phone number for unsaved contacts). Differs between chats,
// constant while scrolling within one.
function getCurrentChatHeaderKey() {
  const header = document.querySelector('div#main header');
  if (!header) return '';
  const titleEl =
    header.querySelector('span[dir="auto"][title]') ||
    header.querySelector('span[dir="auto"]') ||
    header.querySelector('[role="button"] span');
  return (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim();
}

// Resolve the shared WhatSync state: is the extension signed in, and is HubSpot
// connected for this account? Both the website and the extension read the same
// backend, so this is the single source of truth the sidebar renders against.
async function getWhatsyncState() {
  try {
    const result = await extensionStorageGet(['userLoggedIn', 'userId']);
    const loggedIn = result.userLoggedIn === true && !!result.userId;
    if (!loggedIn) return { loggedIn: false, hubspotConnected: false };
    const hubspotConnected = await checkHubSpotIntegrationStatus();
    return { loggedIn: true, hubspotConnected };
  } catch {
    return { loggedIn: false, hubspotConnected: false };
  }
}

// State screens shown in the sidebar when we can't show CRM data yet.
function renderSignInState(sidebarContent) {
  sidebarContent.innerHTML = `
    <div class="ws-state">
      <div class="ws-state-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
          <polyline points="10 17 15 12 10 7"></polyline>
          <line x1="15" y1="12" x2="3" y2="12"></line>
        </svg>
      </div>
      <h4>Sign in to WhatSync</h4>
      <p>Log in to your WhatSync account to see HubSpot CRM details for your chats.</p>
      <button class="ws-state-btn" id="ws-signin-btn">Sign in</button>
      <p class="ws-state-hint">Tip: you can also click the WhatSync icon in your browser toolbar.</p>
    </div>
  `;
  const btn = sidebarContent.querySelector('#ws-signin-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      // Try to open the extension popup; fall back to the web login.
      try {
        sendExtensionMessage({ action: 'openPopup' }).catch(() => {});
      } catch { /* ignore */ }
      window.open('https://whatsync.io/auth', '_blank', 'noopener,noreferrer');
    });
  }
}

function renderConnectHubSpotState(sidebarContent) {
  sidebarContent.innerHTML = `
    <div class="ws-state">
      <div class="ws-state-icon ws-state-icon-warn">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
        </svg>
      </div>
      <h4>Connect HubSpot</h4>
      <p>You're signed in, but your HubSpot account isn't connected yet. Connect it in the WhatSync dashboard to sync contacts, deals and activity here.</p>
      <button class="ws-state-btn" id="ws-connect-btn">Open WhatSync dashboard</button>
      <p class="ws-state-hint">After connecting, reopen this panel — it updates automatically.</p>
    </div>
  `;
  const btn = sidebarContent.querySelector('#ws-connect-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      window.open('https://whatsync.io/dashboard', '_blank', 'noopener,noreferrer');
    });
  }
}

// Function to update sidebar content based on maindiv
async function updateSidebarContent() {
  const sidebar = document.getElementById("hubspot-sidebar");
  if (!sidebar) return;

  closeWhatsAppContactDrawer();

  const sidebarContent = sidebar.querySelector(".sidebar-content");
  if (!sidebarContent) return;

  // Single-source-of-truth gate: only show CRM data when signed in AND connected.
  const state = await getWhatsyncState();
  if (!state.loggedIn) {
    renderSignInState(sidebarContent);
    return;
  }
  if (!state.hubspotConnected) {
    renderConnectHubSpotState(sidebarContent);
    return;
  }

  // Record which chat this render is for (synchronously, before any async work)
  // so concurrent retriggers for the same chat are deduped instead of racing.
  lastRenderedChatKey = getCurrentChatHeaderKey();

  const updateToken = ++sidebarContentUpdateToken;
  
  const maindiv = document.querySelector("div#main");
  
  if (!maindiv) {
    // Show "NO Chat Selected" message
    sidebarContent.innerHTML = `
      <div class="no-chat-selected">
        <div class="no-chat-selected-icon">💬</div>
        <h4>NO Chat Selected</h4>
        <p>Please select a chat from your conversation list to view details here.</p>
      </div>
    `;
  } else {
    // Show loading state
    sidebarContent.innerHTML = `
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <p>Checking HubSpot CRM...</p>
      </div>
    `;
    
    // Main div exists - extract phone and check HubSpot
    // Phone extraction happens when sidebar shows
    console.log('[Sidebar] Sidebar is showing - extracting phone number...');
    extractPhoneFromChat().then(async extractedPhone => {
      if (updateToken !== sidebarContentUpdateToken) return;

      if (extractedPhone) {
        console.log('[Sidebar] ✅ Extracted Phone:', extractedPhone);
        const contacts = await checkHubSpotContact(extractedPhone);
        if (updateToken !== sidebarContentUpdateToken) return;

        if (contacts && contacts.length > 0) {
          console.log('Matching contact found in HubSpot:', contacts);
          sidebarContent.innerHTML = await formatContactDetails(contacts, extractedPhone);
          // Setup copy email functionality
          setupCopyEmailHandler();
          // Setup email handler
          setupEmailHandler();
          // Setup meeting scheduling functionality
          setupMeetingScheduler();
          // Setup note creation functionality
          setupNoteCreation();
          // Setup ticket creation functionality
          setupTicketCreation();
          // Setup task creation functionality
          setupTaskCreation();
          // Setup custom tooltips for action buttons
          setupActionButtonTooltips();
          // Setup more actions dropdown
          setupMoreActionsDropdown();
          // Make the About section collapsible + lifecycle/lead-status editable
          setupAboutCollapsible();
          setupEditableContactFields();
          setupOwnerNameResolution();
          // Recent activity timeline
          setupActivitiesSection();
          // Setup notes section
          setupNotesSection();
          // Setup tickets section
          setupTicketsSection();
          setupTasksSection();
          // Setup deals section
          setupDealsSection();
          // Load notes count immediately (without expanding) - use setTimeout to ensure DOM is ready
          setTimeout(() => {
            const notesSection = document.querySelector('.notes-section');
            if (notesSection) {
              const contactIdAttr = notesSection.getAttribute('data-contact-id');
              if (contactIdAttr) {
                refreshNotesCount(contactIdAttr, notesSection).catch(error => {
                  console.error('[Content] Error loading initial notes count:', error);
                });
              }
            }
            // Load tickets count immediately (without expanding)
            const ticketsSection = document.querySelector('.tickets-section');
            if (ticketsSection) {
              const contactIdAttr = ticketsSection.getAttribute('data-contact-id');
              if (contactIdAttr) {
                console.log('[Content] Loading initial tickets count for contact:', contactIdAttr);
                refreshTicketsCount(contactIdAttr, ticketsSection).catch(error => {
                  console.error('[Content] Error loading initial tickets count:', error);
                });
              }
            }
            // Load tasks count immediately (without expanding)
            const tasksSection = document.querySelector('.tasks-section');
            if (tasksSection) {
              const contactIdAttr = tasksSection.getAttribute('data-contact-id');
              if (contactIdAttr) {
                console.log('[Content] Loading initial tasks count for contact:', contactIdAttr);
                refreshTasksCount(contactIdAttr, tasksSection).catch(error => {
                  console.error('[Content] Error loading initial tasks count:', error);
                });
              }
            }
          }, 100);
        } else {
          if (updateToken !== sidebarContentUpdateToken) return;

          const syncSettings = await getSyncSettings();
          if (syncSettings?.auto_sync_contacts) {
            try {
              const contactName = getCurrentContactName() || '';
              const nameParts = contactName.trim().split(/\s+/).filter(Boolean);
              const hubspotPhone = formatPhoneForHubSpot(extractedPhone);
              await createHubSpotContact({
                sourceData: {
                  phone: hubspotPhone || undefined,
                  contact_name: contactName,
                  last_message_date: Date.now(),
                },
                properties: {},
              });
              const syncedContacts = await checkHubSpotContact(extractedPhone);
              if (updateToken !== sidebarContentUpdateToken) return;
              if (syncedContacts && syncedContacts.length > 0) {
                sidebarContent.innerHTML = await formatContactDetails(syncedContacts, extractedPhone);
                setupCopyEmailHandler();
                setupEmailHandler();
                setupMeetingScheduler();
                setupNoteCreation();
                setupTicketCreation();
                setupTaskCreation();
                setupActionButtonTooltips();
                setupMoreActionsDropdown();
                setupAboutCollapsible();
                setupEditableContactFields();
                setupOwnerNameResolution();
                setupActivitiesSection();
                setupNotesSection();
                setupTicketsSection();
                setupTasksSection();
                setupDealsSection();
                return;
              }
            } catch (autoSyncError) {
              console.warn('[Sidebar] auto_sync_contacts failed:', autoSyncError);
            }
          }

          sidebarContent.innerHTML = await formatContactDetails(null, extractedPhone);
          setupCreateContactForm(extractedPhone);
        }
      } else {
        if (updateToken !== sidebarContentUpdateToken) return;
        sidebarContent.innerHTML = await formatCreateContactForm(null, { manualPhoneEntry: true });
        setupCreateContactForm('');
      }
    }).catch(error => {
      if (updateToken !== sidebarContentUpdateToken) return;
      console.error('Error updating sidebar content:', error);
      sidebarContent.innerHTML = `
        <div class="no-contact-found">
          <div class="no-contact-icon">⚠️</div>
          <h4>Error</h4>
          <p>Failed to load contact information.</p>
        </div>
      `;
    });
  }
}

// Function to inject sidebar
function injectSidebar() {
  // Check if sidebar already exists
  const existingSidebar = document.getElementById("hubspot-sidebar");
  if (existingSidebar) {
    // Update content if sidebar already exists
    updateSidebarContent();
    return; // Sidebar already exists
  }

  // Create sidebar
  const sidebar = document.createElement("div");
  sidebar.id = "hubspot-sidebar";
  sidebar.innerHTML = `
    <div class="sidebar-header">
      <h3>WhatSync</h3>
      <button class="sidebar-close" id="sidebarClose" aria-label="Close sidebar">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="sidebar-content">
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading…</p>
      </div>
    </div>
  `;
  
  document.body.appendChild(sidebar);
  console.log('Sidebar injected successfully');
  
  // Update content based on maindiv
  updateSidebarContent();
}

// Function to setup sidebar toggle
function setupSidebarToggle() {
  const checkOpenchat = document.getElementById("checkOpenchat");
  const sidebar = document.getElementById("hubspot-sidebar");
  
  if (checkOpenchat && !checkOpenchat.hasAttribute('data-listener-attached')) {
    checkOpenchat.setAttribute('data-listener-attached', 'true');
    
    checkOpenchat.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      // WhatsApp contact drawer + HubSpot sidebar together crush the chat column
      closeWhatsAppContactDrawer();
      
      const currentSidebar = document.getElementById("hubspot-sidebar");
      if (!currentSidebar) {
        // Inject sidebar if it doesn't exist
        injectSidebar();
        // Wait a moment for sidebar to be injected, then open it
        setTimeout(() => {
          const newSidebar = document.getElementById("hubspot-sidebar");
          if (newSidebar) {
            // Update content before opening
            updateSidebarContent();
            newSidebar.classList.add('open');
            widthSetting(); // Reflow WhatsApp to make room for the docked panel
            setupSidebarClose();
          }
        }, 100);
      } else {
        // Update content when opening
        if (!currentSidebar.classList.contains('open')) {
          updateSidebarContent();
        }
        // Toggle sidebar
        currentSidebar.classList.toggle('open');
        widthSetting(); // Reflow WhatsApp to match the new open/closed state
        setupSidebarClose();
      }
    });
  }
  
  // Setup close button
  setupSidebarClose();
}

// Function to setup sidebar close button
function setupSidebarClose() {
  const sidebar = document.getElementById("hubspot-sidebar");
  const sidebarClose = sidebar ? sidebar.querySelector("#sidebarClose") : null;
  
  if (sidebarClose && !sidebarClose.hasAttribute('data-listener-attached')) {
    sidebarClose.setAttribute('data-listener-attached', 'true');
    
    sidebarClose.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (sidebar) {
        sidebar.classList.remove('open');
        setTimeout(() => widthSetting(), 10); // Adjust width after closing
      }
    });
  }
}

// Function to remove navbar
function removeNavbar() {
  teardownThemeDetection();
  const existingNavbar = document.getElementById("hubspot-navbar");
  if (existingNavbar) {
    existingNavbar.remove();
  }
  // CSS is loaded via manifest.json, so no need to remove style element
  // Also remove sidebar when navbar is removed
  const existingSidebar = document.getElementById("hubspot-sidebar");
  if (existingSidebar) {
    existingSidebar.remove();
  }
  
  // Remove body classes to disable layout adjustments CSS
  document.body.classList.remove('hubspot-navbar-active');
  document.body.classList.remove('hubspot-sidebar-open');

  // Reset inline width styles on div#main that might have been set by widthSetting()
  const maindiv = document.querySelector("div#main");
  if (maindiv) {
    maindiv.style.width = '';
    maindiv.style.maxWidth = '';
  }
}

// HubSpot portal id, captured from the connection status so we can build deep links
// to records (deals, notes, tasks, tickets, contacts) in the HubSpot UI.
let hubspotPortalId = null;

// HubSpot CRM object type ids used in record deep links.
const HUBSPOT_OBJECT_TYPE_IDS = {
  contact: '0-1',
  deal: '0-3',
  ticket: '0-5',
  note: '0-46',
  task: '0-27',
  call: '0-48',
  email: '0-49',
  meeting: '0-47',
};

// Build a HubSpot UI deep link for a record. Returns null when we don't yet know
// the portal id or the object id, so callers can skip rendering a link.
function hubSpotRecordUrl(objectType, objectId) {
  const typeId = HUBSPOT_OBJECT_TYPE_IDS[objectType];
  if (!hubspotPortalId || !typeId || !objectId) return null;
  return `https://app.hubspot.com/contacts/${hubspotPortalId}/record/${typeId}/${objectId}`;
}

// Returns an "open in HubSpot" anchor (external-link icon) for a record card, or an
// empty string if we can't build a URL. CSP-safe: no inline handlers — a delegated
// listener (below) stops propagation so collapsible cards don't toggle on click.
function hubSpotOpenLink(objectType, objectId, label) {
  const url = hubSpotRecordUrl(objectType, objectId);
  if (!url) return '';
  return `<a class="hs-open-link" href="${url}" target="_blank" rel="noopener noreferrer" title="${label || 'Open in HubSpot'}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
        <polyline points="15 3 21 3 21 9"></polyline>
        <line x1="10" y1="14" x2="21" y2="3"></line>
      </svg>
    </a>`;
}

// Attach (once) a capture-phase listener so clicking an "open in HubSpot" link opens
// the record without also triggering a parent card's collapse/expand handler.
let hubSpotLinkHandlerAttached = false;
function ensureHubSpotLinkHandler() {
  if (hubSpotLinkHandlerAttached) return;
  hubSpotLinkHandlerAttached = true;
  document.addEventListener(
    'click',
    (e) => {
      const link = e.target?.closest?.('.hs-open-link');
      if (link) e.stopPropagation(); // let the anchor's own navigation proceed
    },
    true
  );
}
ensureHubSpotLinkHandler();

// Function to check HubSpot integration status via edge function
async function checkHubSpotIntegrationStatus() {
  const response = await sendExtensionMessage({
    action: 'checkHubSpotIntegration',
  });

  if (!response?.success || !response.data) {
    return false;
  }

  // Capture the portal id so record cards can deep-link into HubSpot.
  const portalId = response.data.portalId ?? response.data.portal_id;
  if (portalId) hubspotPortalId = String(portalId);

  const status = response.data.status;
  return status === 'active' || status === 'connected';
}

// Function to check login state and inject/remove navbar (gate on HubSpot connected)
async function checkLoginStateAndInjectNavbar() {
  try {
    if (!isExtensionRuntimeAvailable() || extensionContextInvalidated) {
      markExtensionContextInvalidated();
      return;
    }

    // Always provide the navbar entry point on WhatsApp Web. The sidebar itself
    // shows the right state (sign-in / connect-HubSpot / CRM data), so we no longer
    // hide the whole UI when signed out or not connected — that left users stuck
    // with no way in. Refresh any open sidebar so it reflects the current state.
    const refreshOpenSidebar = () => {
      const sb = document.getElementById('hubspot-sidebar');
      if (sb && sb.classList.contains('open')) updateSidebarContent();
    };

    const appRoot = document.getElementById('app') || document.querySelector('#app');
    if (appRoot) {
      injectNavbar();
      refreshOpenSidebar();
      return;
    }

    let checkCount = 0;
    const maxChecks = 50;
    const checkAppRoot = setInterval(() => {
      checkCount++;
      const root = document.getElementById('app') || document.querySelector('#app');
      if (root) {
        clearInterval(checkAppRoot);
        injectNavbar();
        refreshOpenSidebar();
      } else if (checkCount >= maxChecks) {
        clearInterval(checkAppRoot);
      }
    }, 100);
  } catch {
    if (!isExtensionRuntimeAvailable()) {
      markExtensionContextInvalidated();
    }
    removeNavbar();
  }
}

function initExtension() {
  if (!isExtensionRuntimeAvailable() || extensionContextInvalidated) {
    markExtensionContextInvalidated();
    return;
  }

  if (window.location.hostname !== 'web.whatsapp.com') {
    return;
  }

  document.body.classList.add('whatsapp-extension-active');
  checkLoginStateAndInjectNavbar();

  setTimeout(() => {
    if (isExtensionRuntimeAvailable() && !extensionContextInvalidated) {
      initializeChatListRowObserver();
    }
  }, 500);
}

function registerExtensionListeners() {
  if (extensionListenersRegistered || !isExtensionRuntimeAvailable()) {
    return;
  }

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'extensionUpdated') {
        window.location.reload();
        sendResponse({ success: true });
        return true;
      }
      if (message.action === 'userLoggedIn') {
        checkLoginStateAndInjectNavbar();
        sendResponse({ success: true });
      } else if (message.action === 'userLoggedOut') {
        // Keep the navbar; refresh the sidebar to its sign-in state.
        checkLoginStateAndInjectNavbar();
        sendResponse({ success: true });
      }
      return true;
    });

    chrome.storage.onChanged.addListener((changes, namespace) => {
      // Any change to login OR HubSpot connection should re-evaluate the sidebar state.
      if (namespace === 'local' && (changes.userLoggedIn || changes.hubspotConnected)) {
        checkLoginStateAndInjectNavbar();
      }
    });

    extensionListenersRegistered = true;
  } catch {
    markExtensionContextInvalidated();
  }
}

function bootstrapExtension() {
  if (!isExtensionRuntimeAvailable()) {
    markExtensionContextInvalidated();
    return;
  }
  initExtension();
  registerExtensionListeners();
}

// MutationObserver for chat list to detect chat clicks
let chatListObserver = null;
let mainChatObserver = null;
let sidebarRetriggerTimeout = null;
let chatClickHandler = null;

let chatListObserverRetries = 0;
const CHAT_LIST_OBSERVER_MAX_RETRIES = 60;

function initializeChatListRowObserver() {
  if (extensionContextInvalidated) return;

  // Select the chat list container
  const chatList = document.querySelector('[aria-label="Chat list"]');

  if (!chatList) {
    // Retry for up to a minute (e.g. WhatsApp still loading or on QR screen),
    // then stop — navigation/bootstrap will re-arm this when the UI appears.
    if (chatListObserverRetries < CHAT_LIST_OBSERVER_MAX_RETRIES) {
      chatListObserverRetries++;
      setTimeout(initializeChatListRowObserver, 1000);
    } else {
      console.log('[Chat List Observer] Chat list not found after max retries — stopping.');
    }
    return;
  }
  chatListObserverRetries = 0;

  console.log('[Chat List Observer] ✅ Chat list container found, initializing observer...');
  
  // Clean up existing observer if any
  if (chatListObserver) {
    chatListObserver.disconnect();
  }
  
  // Remove existing click handler if any
  if (chatClickHandler) {
    chatList.removeEventListener('click', chatClickHandler, true);
  }
  
  // Add direct click event listener as primary method
  chatClickHandler = (e) => {
    // Check if clicked element or its parent is a gridcell
    const gridcell = e.target.closest('[role="gridcell"]');
    if (gridcell) {
      console.log('[Chat List Observer] 🖱️ Chat clicked (via click event)');
      // div#main only exists once a chat is open, and WhatsApp can recreate it —
      // (re)arm its observer whenever the observed node is gone or detached
      if (!observedMainChat || !observedMainChat.isConnected) {
        mainChatObserverRetries = 0;
        setupMainChatObserver();
      }
      retriggerSidebar();
    }
  };
  
  // Use capture phase to catch clicks early
  chatList.addEventListener('click', chatClickHandler, true);
  console.log('[Chat List Observer] ✅ Click event listener attached');
  
  // Create a mutation observer to listen for changes in the chat list
  chatListObserver = new MutationObserver((mutationsList, observer) => {
    mutationsList.forEach(mutation => {
      if (mutation.type === 'childList') {
        // Check if a chat element has been added
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the added node or any of its children is a gridcell
            const clickedChat = node.matches && node.matches('[role="gridcell"]') 
              ? node 
              : node.querySelector && node.querySelector('[role="gridcell"]');
            
            if (clickedChat) {
              console.log('[Chat List Observer] ✅ Chat gridcell added');
              retriggerSidebar();
            }
          }
        });
      }
      
      // Also check for attribute changes that might indicate selection
      if (mutation.type === 'attributes') {
        const target = mutation.target;
        // Check if aria-selected changed to true (chat was selected)
        if (mutation.attributeName === 'aria-selected') {
          const isSelected = target.getAttribute('aria-selected') === 'true';
          if (isSelected && target.matches('[role="gridcell"]')) {
            console.log('[Chat List Observer] ✅ Chat selected via aria-selected change');
            retriggerSidebar();
          }
        }
      }
    });
  });
  
  // Observer options: Listen for added or removed child elements and attribute changes
  const config = { 
    childList: true, 
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected', 'class', 'style']
  };
  
  // Start observing the chat list
  chatListObserver.observe(chatList, config);
  console.log('[Chat List Observer] ✅ MutationObserver initialized and watching chat list');
  
  // Also observe the main chat area for changes (when a chat is opened)
  setupMainChatObserver();
}

// Observer for main chat area changes (when a chat is selected)
let mainChatObserverRetries = 0;
const MAIN_CHAT_OBSERVER_MAX_RETRIES = 30;
let observedMainChat = null;

function setupMainChatObserver() {
  if (extensionContextInvalidated) return;

  const mainChat = document.querySelector('div#main');

  if (!mainChat) {
    // div#main doesn't exist until the user opens a chat. Retry briefly, then
    // stop — the chat-list click handler re-arms this when a chat is opened.
    if (mainChatObserverRetries < MAIN_CHAT_OBSERVER_MAX_RETRIES) {
      mainChatObserverRetries++;
      setTimeout(setupMainChatObserver, 1000);
    }
    return;
  }
  mainChatObserverRetries = 0;

  // Clean up existing observer if any
  if (mainChatObserver) {
    mainChatObserver.disconnect();
  }
  
  console.log('[Chat List Observer] ✅ Setting up main chat area observer...');
  
  mainChatObserver = new MutationObserver((mutationsList) => {
    mutationsList.forEach(mutation => {
      // When main chat area content changes, it means a new chat was opened
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // Check if significant content was added (not just small updates)
        const hasSignificantChange = Array.from(mutation.addedNodes).some(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check for header or message container
            return node.querySelector && (
              node.querySelector('[data-testid="conversation-header"]') ||
              node.querySelector('[data-testid="conversation-panel-messages"]') ||
              node.querySelector('[data-testid="msg-container"]')
            );
          }
          return false;
        });
        
        if (hasSignificantChange) {
          console.log('[Chat List Observer] ✅ Main chat area changed (new chat opened)');
          retriggerSidebar();
        }
      }
    });
  });
  
  mainChatObserver.observe(mainChat, {
    childList: true,
    subtree: true
  });
  observedMainChat = mainChat;

  console.log('[Chat List Observer] ✅ Main chat area observer initialized');
}

// Function to retrigger the sidebar only if it's already showing
function retriggerSidebar() {
  // Clear any existing timeout
  if (sidebarRetriggerTimeout) {
    clearTimeout(sidebarRetriggerTimeout);
  }
  
  // Debounce the sidebar update to prevent rapid triggers
  sidebarRetriggerTimeout = setTimeout(() => {
    const sidebar = document.getElementById("hubspot-sidebar");
    
    // Check if sidebar exists and is currently showing/open
    if (!sidebar) {
      console.log('[Chat List Observer] ⏭️ Sidebar not found - skipping (not opening automatically)');
      return;
    }
    
    const isSidebarOpen = sidebar.classList.contains('open');

    if (!isSidebarOpen) {
      console.log('[Chat List Observer] ⏭️ Sidebar is not showing - skipping (not opening automatically)');
      return;
    }

    // Skip if the chat hasn't changed since the last render. This is what makes
    // scrolling a chat NOT rebuild the sidebar (WhatsApp loads messages on
    // scroll, which fires the observer), and prevents those retriggers from
    // discarding an in-progress contact lookup for the same chat.
    const chatKey = getCurrentChatHeaderKey();
    if (chatKey && chatKey === lastRenderedChatKey) {
      return;
    }

    // Sidebar is showing and the chat changed — update its content.
    console.log('[Chat List Observer] ✅ Chat changed - updating sidebar content...');
    updateSidebarContent();
    const maindiv = document.querySelector("div#main");
    if (maindiv) widthSetting(); // Adjust width if maindiv exists
    console.log('[Chat List Observer] ✅ Sidebar content updated');
  }, 300); // 300ms debounce delay
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapExtension);
} else {
  bootstrapExtension();
}

// Listen for navigation changes (WhatsApp Web is an SPA). A lightweight URL
// poll is far cheaper than a document-wide MutationObserver, which fired on
// every DOM mutation on the page.
let lastUrl = location.href;
const navigationCheckInterval = setInterval(() => {
  if (extensionContextInvalidated) {
    clearInterval(navigationCheckInterval);
    return;
  }
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    bootstrapExtension();
    setTimeout(() => {
      if (isExtensionRuntimeAvailable() && !extensionContextInvalidated) {
        initializeChatListRowObserver();
      }
    }, 1000);
  }
}, 1000);

