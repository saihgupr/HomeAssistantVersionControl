// In-app login for API auth.
//
// The browser's HTTP Basic dialog works in Safari and desktop browsers, but
// Home Assistant Ingress loads this app inside a frame in the Companion app,
// where iOS does not surface the dialog. This wrapper sends the credentials
// with every API request and shows a form when the server returns 401.
(function () {
  'use strict';

  const AUTH_KEY = 'havc-api-auth';
  const FAILED_KEY = 'havc-api-auth-failed';
  const DEFAULT_USERNAME = 'havc';

  function readStorage(key) {
    try {
      return sessionStorage.getItem(key) || '';
    } catch (error) {
      return '';
    }
  }

  function writeStorage(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (error) {
      // Private mode or a locked-down webview. The form still works for this page.
    }
  }

  function removeStorage(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (error) {
      // Ignore.
    }
  }

  function getStoredAuth() {
    return readStorage(AUTH_KEY);
  }

  function isApiRequest(url) {
    try {
      const path = new URL(url, window.location.href).pathname;
      return path === '/api' || path.startsWith('/api/');
    } catch (error) {
      return false;
    }
  }

  function showLogin() {
    const overlay = document.getElementById('authOverlay');
    if (!overlay) return;

    const form = document.getElementById('authForm');
    const username = document.getElementById('authUsername');
    const password = document.getElementById('authPassword');
    const errorBox = document.getElementById('authError');

    overlay.hidden = false;
    document.body.classList.add('auth-locked');

    // Keep the error message across the app's several parallel 401s. Only the
    // first call after a failed attempt sets it; later calls leave it alone.
    const failed = readStorage(FAILED_KEY) === '1';
    if (failed) {
      removeStorage(FAILED_KEY);
      if (errorBox) errorBox.textContent = 'Wrong username or password.';
    }
    if (username && !username.value) {
      username.value = DEFAULT_USERNAME;
    }
    if (password) {
      password.value = '';
    }

    if (form && !form.dataset.authBound) {
      form.dataset.authBound = '1';
      form.addEventListener('submit', function (event) {
        event.preventDefault();

        const user = (username && username.value ? username.value : '').trim();
        const pass = password && password.value ? password.value : '';

        if (!user || !pass) {
          if (errorBox) errorBox.textContent = 'Enter a username and password.';
          return;
        }

        writeStorage(AUTH_KEY, btoa(user + ':' + pass));
        window.location.reload();
      });
    }

    if (password) {
      window.setTimeout(function () {
        password.focus();
      }, 50);
    }
  }

  const nativeFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    const options = init ? Object.assign({}, init) : {};
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const apiRequest = isApiRequest(url);

    if (apiRequest) {
      const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('X-Requested-With', 'XMLHttpRequest');

      const auth = getStoredAuth();
      if (auth) {
        headers.set('Authorization', 'Basic ' + auth);
      }
      options.headers = headers;
    }

    return nativeFetch(input, options).then(function (response) {
      if (apiRequest && response.status === 401) {
        if (getStoredAuth()) {
          removeStorage(AUTH_KEY);
          writeStorage(FAILED_KEY, '1');
        }
        showLogin();
      }
      return response;
    });
  };

  window.havcAuth = {
    show: showLogin,
    clear: function () {
      removeStorage(AUTH_KEY);
    }
  };
})();
