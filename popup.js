// Popup script for login/signup functionality with Supabase
document.addEventListener('DOMContentLoaded', async () => {
  // Wait for Supabase library to load
  function waitForSupabase() {
    return new Promise((resolve) => {
      // Check if supabase is available (could be window.supabase or just supabase)
      const checkSupabase = () => {
        return typeof supabase !== 'undefined' || 
               (typeof window !== 'undefined' && typeof window.supabase !== 'undefined');
      };
      
      if (checkSupabase()) {
        resolve();
      } else {
        const checkInterval = setInterval(() => {
          if (checkSupabase()) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);
        
        // Timeout after 5 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          if (!checkSupabase()) {
            console.error('Supabase library failed to load');
            alert('Failed to load Supabase library. Please reload the extension.');
          }
          resolve();
        }, 5000);
      }
    });
  }
  
  await waitForSupabase();
  
  // Get supabase from window or global scope
  const supabaseLib = typeof supabase !== 'undefined' ? supabase : 
                      (typeof window !== 'undefined' && window.supabase) ? window.supabase : null;
  
  if (!supabaseLib || typeof supabaseLib.createClient !== 'function') {
    console.error('Supabase library not available or createClient not found');
    document.getElementById('popupLoading')?.classList.add('hidden');
    document.getElementById('loginSection')?.classList.remove('initial-hide');
    document.getElementById('loginSection').style.display = 'block';
    alert('Supabase library not loaded correctly. Please reload the extension.');
    return;
  }
  
  // Initialize Supabase client
  const supabaseUrl = SUPABASE_CONFIG.url;
  const supabaseKey = SUPABASE_CONFIG.anonKey;
  
  if (!supabaseKey || supabaseKey === 'YOUR_SUPABASE_ANON_KEY_HERE') {
    console.error('Please set your Supabase anon key in config.js');
    document.getElementById('popupLoading')?.classList.add('hidden');
    document.getElementById('loginSection')?.classList.remove('initial-hide');
    document.getElementById('loginSection').style.display = 'block';
    alert('Extension not configured. Please set your Supabase anon key in config.js');
    return;
  }
  
  const supabaseClient = supabaseLib.createClient(supabaseUrl, supabaseKey);
  const loginForm = document.getElementById('loginForm');
  const pageTitle = document.getElementById('pageTitle');
  const switchLink = document.getElementById('switchLink');
  const switchText = document.getElementById('switchText');
  const submitBtn = document.getElementById('submitBtn');
  const togglePassword = document.getElementById('togglePassword');
  const passwordInput = document.getElementById('password');
  const emailLoginInput = document.getElementById('emailLogin');
  const firstNameGroup = document.getElementById('firstNameGroup');
  const lastNameGroup = document.getElementById('lastNameGroup');
  const emailGroup = document.getElementById('emailGroup');
  const emailLoginGroup = document.getElementById('emailLoginGroup');
  const firstNameInput = document.getElementById('firstName');
  const lastNameInput = document.getElementById('lastName');
  const emailInput = document.getElementById('email');
  const successMessage = document.getElementById('successMessage');
  const successTitle = document.getElementById('successTitle');
  const successText = document.getElementById('successText');
  const inlineErrorMessage = document.getElementById('inlineErrorMessage');
  const loggedInSection = document.getElementById('loggedInSection');
  const loginSection = document.getElementById('loginSection');
  const userName = document.getElementById('userName');
  const userEmail = document.getElementById('userEmail');
  const userAvatar = document.getElementById('userAvatar');
  const logoutBtn = document.getElementById('logoutBtn');
  const integrationStatus = document.getElementById('integrationStatus');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const integrationNotice = document.getElementById('integrationNotice');
  const integrationConnectBtn = document.getElementById('integrationConnectBtn');

  const HUBSPOT_NOT_CONNECTED_NOTICE = 'To explore extension features and use them on WhatsApp, please connect your HubSpot account first.';
  const popupLoading = document.getElementById('popupLoading');
  const hubspotAccountDetails = document.getElementById('hubspotAccountDetails');
  const hubspotPortalIdEl = document.getElementById('hubspotPortalId');
  const hubspotConnectedDateEl = document.getElementById('hubspotConnectedDate');
  const hubspotTestConnectionBtn = document.getElementById('hubspotTestConnectionBtn');

  function hideLoadingShowContent() {
    if (popupLoading) popupLoading.classList.add('hidden');
    if (loginSection) loginSection.classList.remove('initial-hide');
  }

  // Safety net: never leave the user staring at "Checking login..." forever.
  // If session restore hangs (storage error, etc.), fall back to the login form.
  setTimeout(() => {
    if (popupLoading && !popupLoading.classList.contains('hidden')) {
      console.warn('Session check timed out — showing login form');
      showLoginForm();
    }
  }, 4000);

  function isValidEmailFormat(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  function showInlineError(message) {
    if (!inlineErrorMessage) return;
    inlineErrorMessage.textContent = message;
    inlineErrorMessage.classList.add('show');
  }

  function clearInlineError() {
    if (!inlineErrorMessage) return;
    inlineErrorMessage.textContent = '';
    inlineErrorMessage.classList.remove('show');
  }

  function formatLoginError(errorMessage) {
    const msg = String(errorMessage || '').toLowerCase();
    if (msg.includes('invalid login credentials') || msg.includes('invalid email or password')) {
      return 'Invalid email or password. Use the same credentials as the WhatSync dashboard, or reset your password there.';
    }
    if (msg.includes('email not confirmed') || msg.includes('confirm your email')) {
      return 'Please confirm your email before logging in. Check your inbox for the verification link.';
    }
    if (msg.includes('external supabase not configured')) {
      return 'Login service is not configured. Please contact your administrator.';
    }
    return errorMessage || 'Login failed. Please try again.';
  }

  function buildProfileFromUser(user, email, existingProfile) {
    if (existingProfile) return existingProfile;
    const metadata = user?.user_metadata || {};
    return {
      user_id: user?.id,
      email: user?.email || email || '',
      first_name: metadata.first_name || '',
      last_name: metadata.last_name || '',
      company: metadata.company || '',
    };
  }

  async function getStoredAuthSession() {
    const storageData = await chrome.storage.local.get([
      'userLoggedIn',
      'userId',
      'accessToken',
      'loginTimestamp',
      'external_auth_session',
      'userProfile',
    ]);
    return storageData;
  }

  async function clearStoredAuthSession() {
    await chrome.storage.local.set({
      userLoggedIn: false,
      userId: null,
      accessToken: null,
      loginTimestamp: null,
      external_auth_session: null,
      userProfile: null,
    });
  }

  /** Same auth path as the Harmony dashboard (external-auth edge function). */
  async function signInViaExternalAuth(email, password) {
    const edgeUrl = `${EDGE_FUNCTIONS_CONFIG.url}/functions/v1/external-auth`;
    const response = await fetch(edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: EDGE_FUNCTIONS_CONFIG.anonKey,
        Authorization: `Bearer ${EDGE_FUNCTIONS_CONFIG.anonKey}`,
      },
      body: JSON.stringify({ action: 'signIn', email, password }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Login request failed (${response.status})`);
    }
    return data;
  }

  function formatConnectedDate(value) {
    if (!value) return null;
    if (typeof value === 'string' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) return value;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  }

  function showHubSpotAccountDetails(connection) {
    if (!hubspotAccountDetails || !hubspotPortalIdEl || !hubspotConnectedDateEl) return;
    // API returns portalId, connectedAt (camelCase); support snake_case for backward compat
    const portalId = connection?.portalId ?? connection?.portal_id ?? null;
    const connectedAt = connection?.connectedAt ?? connection?.connected_at ?? connection?.connected_at_formatted ?? null;
    hubspotPortalIdEl.textContent = portalId != null && String(portalId).trim() !== '' ? `Portal ID: ${portalId}` : 'Portal ID: —';
    const dateStr = formatConnectedDate(connectedAt);
    hubspotConnectedDateEl.textContent = dateStr ? `Connected: ${dateStr}` : 'Connected';
    hubspotAccountDetails.classList.add('visible');
  }

  function hideHubSpotAccountDetails() {
    if (hubspotAccountDetails) hubspotAccountDetails.classList.remove('visible');
  }

  let isLoginMode = true;
  
  // Returns true if session is valid (has non-expired loginTimestamp in storage).
  // Returns false if no timestamp, or expired. Caller should show login or perform auto-logout.
  function isSessionWithinTimeout(loginTimestamp) {
    if (!loginTimestamp || typeof loginTimestamp !== 'number') return false;
    const timeElapsed = Date.now() - loginTimestamp;
    return timeElapsed >= 0 && timeElapsed < SESSION_CONFIG.timeoutMs;
  }

  // Function to check if session has expired and perform auto-logout if so
  async function checkSessionExpiration() {
    try {
      const storageData = await chrome.storage.local.get(['userLoggedIn', 'loginTimestamp']);

      if (!storageData.userLoggedIn || !storageData.loginTimestamp) {
        return true; // No valid stored session — treat as expired (require fresh login)
      }

      if (!isSessionWithinTimeout(storageData.loginTimestamp)) {
        console.log('Session expired (inactivity timeout). Auto-logging out...');
        await performAutoLogout();
        return true; // Session expired
      }

      return false; // Session still valid
    } catch (error) {
      console.error('Error checking session expiration:', error);
      return true; // On error, require fresh login
    }
  }
  
  // Function to perform automatic logout
  async function performAutoLogout() {
    try {
      console.log('User automatically logged out due to session expiration');
      await clearStoredAuthSession();
      
      // Notify content script about logout
      try {
        const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { action: 'userLoggedOut' }).catch(() => {
            // Content script might not be ready, that's okay
          });
        });
      } catch (error) {
        console.error('Error notifying content script:', error);
      }
      
      // Show login form first so user sees the form
      showLoginForm();
      // Always show session-expired message when auto-logging out (stale or inactivity)
      showSuccessMessage('Session Expired', 'Your session has expired. Please log in again.');
      setTimeout(() => successMessage.classList.remove('show'), 3000);
    } catch (error) {
      console.error('Error during auto-logout:', error);
      showLoginForm();
    }
  }
  
  // Function to check HubSpot integration status
  async function checkHubSpotIntegrationStatus() {
    try {
      integrationStatus.style.display = 'flex';
      integrationStatus.className = 'integration-status loading';
      statusDot.className = 'status-dot loading';
      statusText.textContent = 'Checking integration status...';
      if (integrationNotice) { integrationNotice.style.display = 'none'; }

      const response = await chrome.runtime.sendMessage({
        action: 'checkHubSpotIntegration',
      }).catch(() => null);

      if (response && response.success && response.data) {
        const status = (response.data.status || 'disconnected').toLowerCase();

        integrationStatus.className = `integration-status ${status}`;
        statusDot.className = `status-dot ${status}`;
        integrationConnectBtn.style.display = 'none';

        if (status === 'connected' || status === 'active') {
          integrationStatus.style.display = 'none';
          showHubSpotAccountDetails(response.data);
          return { status, connection: response.data };
        }

        hideHubSpotAccountDetails();
        integrationStatus.style.display = 'flex';
        integrationStatus.className = 'integration-status not_connected';
        statusDot.className = 'status-dot not_connected';
        statusText.textContent = 'HubSpot Account is not connected';
        if (integrationNotice) { integrationNotice.textContent = HUBSPOT_NOT_CONNECTED_NOTICE; integrationNotice.style.display = 'block'; }
        integrationConnectBtn.style.display = 'block';
        return { status: 'not_connected', connection: response.data };
      }

      hideHubSpotAccountDetails();
      integrationStatus.style.display = 'flex';
      integrationStatus.className = 'integration-status not_connected';
      statusDot.className = 'status-dot not_connected';
      statusText.textContent = 'HubSpot Account is not connected';
      if (integrationNotice) { integrationNotice.textContent = HUBSPOT_NOT_CONNECTED_NOTICE; integrationNotice.style.display = 'block'; }
      integrationConnectBtn.style.display = 'block';
      return { status: 'not_connected', connection: null };
    } catch (error) {
      console.error('[Popup] Error checking HubSpot integration:', error);
      hideHubSpotAccountDetails();
      integrationStatus.style.display = 'flex';
      integrationStatus.className = 'integration-status not_connected';
      statusDot.className = 'status-dot not_connected';
      statusText.textContent = 'HubSpot Account is not connected';
      if (integrationNotice) { integrationNotice.textContent = HUBSPOT_NOT_CONNECTED_NOTICE; integrationNotice.style.display = 'block'; }
      integrationConnectBtn.style.display = 'block';
      return { status: 'error', connection: null };
    }
  }

  // Function to show logged-in state
  async function showLoggedInState(user, profile = null) {
    hideLoadingShowContent();
    const displayName = profile?.first_name || user.email?.split('@')[0] || 'User';
    const email = user.email || '';
    const initials = profile?.first_name ?
      (profile.first_name.charAt(0) + (profile.last_name?.charAt(0) || '')).toUpperCase() :
      (email.charAt(0) || 'U').toUpperCase();

    userName.textContent = displayName;
    userEmail.textContent = email;
    userAvatar.textContent = initials;

    logoutBtn.disabled = false;
    logoutBtn.textContent = 'Log Out';

    loginSection.style.display = 'none';
    successMessage.classList.remove('show');
    loggedInSection.classList.add('show');

    await checkHubSpotIntegrationStatus();
  }

  // Function to show login form
  function showLoginForm() {
    hideLoadingShowContent();
    loggedInSection.classList.remove('show');
    loginSection.style.display = 'block';
    loginForm.reset();
    clearInlineError();
  }
  
  // Function to show success message
  function showSuccessMessage(title, text) {
    successTitle.textContent = title;
    successText.textContent = text;
    successMessage.classList.add('show');
    
    // Only hide form if not showing logged-in section
    if (!loggedInSection.classList.contains('show')) {
      loginForm.style.display = 'none';
      pageTitle.style.display = 'none';
      
      // Auto-hide after 3 seconds and reset
      setTimeout(() => {
        successMessage.classList.remove('show');
        loginForm.style.display = 'block';
        pageTitle.style.display = 'block';
        loginForm.reset();
      }, 3000);
    }
  }
  
  // Toggle password visibility (button wraps the SVG for keyboard access)
  togglePassword.addEventListener('click', () => {
    const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
    passwordInput.setAttribute('type', type);

    const showing = type === 'text';
    togglePassword.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
    togglePassword.setAttribute('aria-pressed', String(showing));

    const icon = togglePassword.querySelector('svg');
    if (!icon) return;
    if (showing) {
      icon.innerHTML = `
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      `;
    } else {
      icon.innerHTML = `
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      `;
    }
  });
  
  // Switch between login and signup
  switchLink.addEventListener('click', (e) => {
    e.preventDefault();
    isLoginMode = !isLoginMode;
    clearInlineError();
    
    if (isLoginMode) {
      pageTitle.textContent = 'Log In.';
      switchText.textContent = "Don't have an account? ";
      switchLink.textContent = 'Sign Up';
      submitBtn.textContent = 'Log In';
      emailLoginInput.placeholder = 'Enter your email';
      // Hide signup fields, show email login
      firstNameGroup.style.display = 'none';
      lastNameGroup.style.display = 'none';
      emailGroup.style.display = 'none';
      emailLoginGroup.style.display = 'block';
      // Set required attributes for login mode
      emailLoginInput.setAttribute('required', 'required');
      firstNameInput.removeAttribute('required');
      lastNameInput.removeAttribute('required');
      emailInput.removeAttribute('required');
    } else {
      pageTitle.textContent = 'Create new account.';
      switchText.textContent = 'Already A Member? ';
      switchLink.textContent = 'Log In';
      submitBtn.textContent = 'Create Account';
      // Show signup fields, hide email login
      firstNameGroup.style.display = 'block';
      lastNameGroup.style.display = 'block';
      emailGroup.style.display = 'block';
      emailLoginGroup.style.display = 'none';
      // Set required attributes for signup mode
      emailLoginInput.removeAttribute('required');
      firstNameInput.setAttribute('required', 'required');
      lastNameInput.setAttribute('required', 'required');
      emailInput.setAttribute('required', 'required');
    }
    
    // Clear form
    loginForm.reset();
  });
  
  // Handle form submission
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearInlineError();
    
    const submitBtnText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = isLoginMode ? 'Logging in...' : 'Creating account...';
    
    try {
      if (isLoginMode) {
        // Login with email (Supabase Auth requires email)
        const email = emailLoginInput.value.trim();
        const password = passwordInput.value;
        
        if (!email || !password) {
          showInlineError('Please fill in all fields');
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtnText;
          return;
        }

        if (!isValidEmailFormat(email)) {
          showInlineError('Please enter a valid email address');
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtnText;
          return;
        }

        let authResult;
        try {
          authResult = await signInViaExternalAuth(email, password);
        } catch (authError) {
          console.error('Login via external-auth failed:', authError);
          showInlineError(formatLoginError(authError.message));
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtnText;
          return;
        }

        if (authResult.error) {
          showInlineError(formatLoginError(authResult.error));
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtnText;
          return;
        }

        if (!authResult.user || !authResult.session) {
          showInlineError('Login failed: unexpected server response. Please try again.');
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtnText;
          return;
        }

        const data = { user: authResult.user, session: authResult.session };
        const profile = buildProfileFromUser(data.user, email, authResult.profile);

        const session = data.session;
        const accessToken = session?.access_token || null;
        const refreshToken = session?.refresh_token || null;

        const loginTimestamp = Date.now();
        await chrome.storage.local.set({
          userLoggedIn: true,
          userId: data.user.id,
          accessToken: accessToken,
          refreshToken: refreshToken,
          loginTimestamp: loginTimestamp,
          external_auth_session: { ...session, user: data.user },
          userProfile: profile,
        });
        
        // Notify content script about login
        try {
          const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { action: 'userLoggedIn' }).catch(() => {
              // Content script might not be ready, that's okay
            });
          });
        } catch (error) {
          console.error('Error notifying content script:', error);
        }
        
        // Check HubSpot integration status first
        const integrationStatusResult = await checkHubSpotIntegrationStatus();
        
        // Show brief success message first
        const userNameDisplay = profile?.first_name || email.split('@')[0];
        let integrationMessage;
        if (integrationStatusResult.status === 'connected' || integrationStatusResult.status === 'active') {
          integrationMessage = 'Welcome back, ' + userNameDisplay + '!';
        } else if (integrationStatusResult.status === 'not_connected') {
          integrationMessage = 'HubSpot is not connected. Please connect your HubSpot account to continue.';
        } else {
          integrationMessage = 'Welcome back! Please connect your HubSpot account to continue.';
        }
        
        showSuccessMessage('Successfully Logged In!', integrationMessage);
        
        // Show logged-in state after a brief delay
        setTimeout(() => {
          successMessage.classList.remove('show');
          showLoggedInState(data.user, profile);
        }, 1500);
        
      } else {
        // Signup
        const firstName = firstNameInput.value.trim();
        const lastName = lastNameInput.value.trim();
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        
        if (!firstName || !lastName || !email || !password) {
          showInlineError('Please fill in all fields');
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtnText;
          return;
        }

        if (!isValidEmailFormat(email)) {
          showInlineError('Please enter a valid email address');
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtnText;
          return;
        }

        // Validate password length (Supabase requires min 6 characters)
        if (password.length < 6) {
          showInlineError('Password must be at least 6 characters long');
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtnText;
          return;
        }
        
        // Sign up with Supabase Auth
        const { data: authData, error: authError } = await supabaseClient.auth.signUp({
          email: email,
          password: password,
          options: {
            data: {
              first_name: firstName,
              last_name: lastName
            },
            emailRedirectTo: SUPABASE_CONFIG.redirectUrl || window.location.origin
          }
        });
        
        if (authError) {
          // Check if user already exists
          if (authError.message.includes('already registered') || authError.message.includes('already exists')) {
            showInlineError('This email is already registered. Please log in instead.');
            // Switch to login mode
            isLoginMode = true;
            pageTitle.textContent = 'Log In.';
            switchText.textContent = "Don't have an account? ";
            switchLink.textContent = 'Sign Up';
            submitBtn.textContent = 'Log In';
            firstNameGroup.style.display = 'none';
            lastNameGroup.style.display = 'none';
            emailGroup.style.display = 'none';
            emailLoginGroup.style.display = 'block';
            emailLoginInput.setAttribute('required', 'required');
            firstNameInput.removeAttribute('required');
            lastNameInput.removeAttribute('required');
            emailInput.removeAttribute('required');
            // Reset first, then pre-fill the email in the login field
            // (reset() after assignment would wipe the prefill)
            loginForm.reset();
            emailLoginInput.value = email;
          } else {
            showInlineError('Signup failed: ' + authError.message);
          }
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtnText;
          return;
        }
        
        // Create user profile in user_profiles table
        if (authData.user) {
          const { error: profileError } = await supabaseClient
            .from('user_profiles')
            .insert({
              user_id: authData.user.id,
              first_name: firstName,
              last_name: lastName,
              email: email
            });
          
          if (profileError) {
            console.error('Error creating profile:', profileError);
            // Check if profile already exists (user might have signed up before)
            if (profileError.code === '23505' || profileError.message.includes('duplicate')) {
              showSuccessMessage('Account Created!', 'Your account already exists. You can now login.');
            } else {
              // User is created but profile failed - try to get existing profile
              const { data: existingProfile } = await supabaseClient
                .from('user_profiles')
                .select('*')
                .eq('user_id', authData.user.id)
                .single();
              
              if (existingProfile) {
                showSuccessMessage('Account Created Successfully!', 'Welcome, ' + firstName + '!');
              } else {
                showSuccessMessage('Account Created!', 'However, there was an issue saving your profile. You can still login and your profile will be created automatically.');
              }
            }
          } else {
            showSuccessMessage('Account Created Successfully!', 'Welcome, ' + firstName + '!');
          }
        }
        
        // Switch to login mode (form will be hidden by success message, then reset when it disappears)
        isLoginMode = true;
        
        // Set form to login mode for when it reappears after success message
        setTimeout(() => {
          pageTitle.textContent = 'Log In.';
          switchText.textContent = "Don't have an account? ";
          switchLink.textContent = 'Sign Up';
          submitBtn.textContent = 'Log In';
          firstNameGroup.style.display = 'none';
          lastNameGroup.style.display = 'none';
          emailGroup.style.display = 'none';
          emailLoginGroup.style.display = 'block';
          emailLoginInput.setAttribute('required', 'required');
          firstNameInput.removeAttribute('required');
          lastNameInput.removeAttribute('required');
          emailInput.removeAttribute('required');
          loginForm.reset();
        }, 3000);
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      showInlineError('An unexpected error occurred: ' + error.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtnText;
    }
  });
  
  // Restore session from chrome.storage (same source used by content/background scripts)
  const storageData = await getStoredAuthSession();
  const storedSession = storageData.external_auth_session;
  const storedUser = storedSession?.user || (storageData.userId ? { id: storageData.userId } : null);

  if (!storageData.userLoggedIn || !storedSession?.access_token || !storedUser) {
    await clearStoredAuthSession();
    showLoginForm();
    return;
  }

  const hasValidStoredLogin = storageData.loginTimestamp && isSessionWithinTimeout(storageData.loginTimestamp);
  if (!hasValidStoredLogin) {
    console.log('Session expired or missing login timestamp — requiring fresh login');
    await performAutoLogout();
    return;
  }

  showLoggedInState(
    storedUser,
    storageData.userProfile || buildProfileFromUser(storedUser, storedUser.email)
  );
  
  // Logout functionality
  logoutBtn.addEventListener('click', async () => {
    // Save original button state
    const originalText = 'Log Out';
    
    // Update button state
    logoutBtn.disabled = true;
    logoutBtn.textContent = 'Logging out...';
    
    try {
      console.log('User logged out successfully');
      await clearStoredAuthSession();

      // Notify content script about logout
      try {
        const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { action: 'userLoggedOut' }).catch(() => {
            // Content script might not be ready, that's okay
          });
        });
      } catch (error) {
        console.error('Error notifying content script:', error);
      }

      logoutBtn.disabled = false;
      logoutBtn.textContent = originalText;
      showLoginForm();
    } catch (error) {
      console.error('Logout error:', error);
      logoutBtn.disabled = false;
      logoutBtn.textContent = originalText;
      showLoginForm();
      showInlineError('An error occurred during logout: ' + error.message);
    }
  });

  // Test Connection: re-check HubSpot status and refresh account details
  if (hubspotTestConnectionBtn) {
    hubspotTestConnectionBtn.addEventListener('click', async () => {
      const originalText = hubspotTestConnectionBtn.textContent;
      hubspotTestConnectionBtn.textContent = 'Testing...';
      hubspotTestConnectionBtn.disabled = true;
      try {
        const result = await checkHubSpotIntegrationStatus();
        if (result.status === 'connected' || result.status === 'active') {
          hubspotTestConnectionBtn.textContent = 'OK';
          setTimeout(() => {
            hubspotTestConnectionBtn.textContent = originalText;
            hubspotTestConnectionBtn.disabled = false;
          }, 1200);
        } else {
          hubspotTestConnectionBtn.textContent = originalText;
          hubspotTestConnectionBtn.disabled = false;
        }
      } catch (e) {
        hubspotTestConnectionBtn.textContent = originalText;
        hubspotTestConnectionBtn.disabled = false;
      }
    });
  }
});
