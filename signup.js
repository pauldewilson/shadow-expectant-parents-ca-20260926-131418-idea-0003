/*
 * signup.js — config-gated signup form handler for the Dueplans local page
 * (idea-0003, session expectant-parents-ca__20260926-131418).
 * Normative contract: docs/backend-architecture.md §12 (frontend) + §7 (API).
 *
 * Two-state contract:
 *  - Local engineering pages ship a comment-only signup-config.js stub, so
 *    window.__SHADOW_SIGNUP_CONFIG__ stays undefined. Every submit attempt
 *    then does nothing — no fetch, no storage, no external request, no
 *    message, ever. (Load-time work is limited to binding listeners that
 *    no-op without a live config; the config is read lazily per attempt.)
 *  - Deployed variants carry a real signup-config.js; only then does a submit
 *    collect ALL form fields, optionally run reCAPTCHA Enterprise, and POST
 *    once to config.backendUrl + /api/v1/signups.
 *
 * Status messaging (2026-09-26 user direction): the live submit path maps
 * every backend rejection to a DISTINCT plain-language message rendered in a
 * role="status" region (created only when a live config exists):
 *   200 → success (config.successMessage when provided; fallback below)
 *   422 → specific "Please check the form" wording naming what to fix — the
 *         backend's per-field detail is parsed when parseable (e.g. email);
 *         never the generic fallback
 *   429 → rate-limit wording; 400 → captcha wording; captcha/network failure
 *         → its own retry wording; 500/unknown → plain retry wording.
 *
 * Never: cookies, localStorage/sessionStorage, analytics, or any request other
 * than the reCAPTCHA loader (live + captchaRequired only) and the signup POST.
 */
(function () {
  'use strict';

  var inflight = new WeakSet(); // per-form single-flight guard
  var sessionId = null; // generated lazily, once per page load
  var recaptchaPromise = null; // module-level guard: loader injected at most once

  /* Status wording — distinct per failure kind; no generic-only message.
     These are live-path status strings, not page copy: the local inert page
     renders none of them (no config → no status element → no message). */
  var MESSAGES = {
    successFallback: 'Thanks — you’re signed up for launch news.',
    invalid422Email: 'Please check the form — enter a valid email address.',
    invalid422Form: 'Please check the form — make sure your entries are valid, then try again.',
    rateLimited: 'Too many attempts — please wait a minute and try again.',
    captchaRejected: 'Verification didn’t complete — please try again.',
    captchaUnavailable: 'Verification is temporarily unavailable — please try again in a moment.',
    network: 'We couldn’t reach the server — check your connection and try again.',
    server: 'That didn’t go through — please try again.'
  };

  /* Returns the live config, or null when absent/malformed (→ inert page). */
  function getConfig() {
    var config = window.__SHADOW_SIGNUP_CONFIG__;
    if (!config || typeof config !== 'object') return null;
    if (typeof config.backendUrl !== 'string' || !config.backendUrl) return null;
    return config;
  }

  /* session_id — one per page load (server schema limit: 64 chars). */
  function ensureSessionId() {
    if (sessionId) return sessionId;
    var crypto = window.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') {
      sessionId = crypto.randomUUID();
    } else if (crypto && typeof crypto.getRandomValues === 'function') {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      sessionId = Array.prototype.map.call(bytes, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } else {
      sessionId = 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }
    return sessionId;
  }

  /* Collect ALL named fields into form_data — the server stores it as-received
     (§6). A single checkbox → boolean; checkboxes sharing a name → array of
     checked values; radios → checked value, omitted when none is checked;
     multi-selects → array. File inputs and buttons are skipped. */
  function collectFormData(form) {
    var groups = Object.create(null);
    Array.prototype.forEach.call(form.elements, function (el) {
      var tag = el.tagName;
      var type = (el.type || '').toLowerCase();
      if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return;
      if (!el.name) return;
      if (type === 'file' || type === 'submit' || type === 'button' ||
          type === 'reset' || type === 'image') return;
      (groups[el.name] = groups[el.name] || []).push(el);
    });

    var data = {};
    Object.keys(groups).forEach(function (name) {
      var els = groups[name];
      var first = els[0];
      var type = (first.type || '').toLowerCase();

      if (type === 'radio') {
        for (var i = 0; i < els.length; i++) {
          if (els[i].checked) { data[name] = els[i].value; break; }
        }
      } else if (type === 'checkbox') {
        if (els.length === 1) {
          data[name] = first.checked; // boolean
        } else {
          data[name] = els.filter(function (el) { return el.checked; })
            .map(function (el) { return el.value; });
        }
      } else if (first.tagName === 'SELECT' && first.multiple) {
        data[name] = Array.prototype.filter.call(first.options, function (opt) {
          return opt.selected;
        }).map(function (opt) { return opt.value; });
      } else {
        data[name] = first.value.trim();
      }
    });
    return data;
  }

  /* email is OPTIONAL (§7): the top-level key is included only when a non-empty
     value exists. Prefer the first input[type=email]; else the first collected
     field whose name mentions "email" and holds a string value (booleans and
     arrays from checkboxes never become the email). */
  function extractEmail(form, formData) {
    var input = form.querySelector('input[type="email"]');
    var value = input && typeof input.value === 'string' ? input.value : '';
    if (!value) {
      var name = Object.keys(formData).find(function (key) {
        return /email/i.test(key) && typeof formData[key] === 'string';
      });
      if (name) value = formData[name];
    }
    value = (value || '').trim();
    return value || null;
  }

  /* Status region — created on demand, live path only; never exists locally. */
  function ensureStatus(form) {
    var status = form.querySelector('[role="status"]');
    if (status) return status;
    status = document.createElement('p');
    status.className = 'signup-status';
    status.setAttribute('role', 'status');
    var consent = form.querySelector('.consent');
    if (consent && consent.parentNode === form) {
      form.insertBefore(status, consent);
    } else {
      form.appendChild(status);
    }
    return status;
  }

  function setStatus(statusEl, message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message; // aria-live region announces the change
    statusEl.classList.toggle('signup-status--error', kind === 'error');
    statusEl.classList.toggle('signup-status--success', kind === 'success');
  }

  function setBusy(form, buttons, busy) {
    if (busy) {
      inflight.add(form);
      form.setAttribute('aria-busy', 'true');
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    } else {
      inflight.delete(form);
      form.removeAttribute('aria-busy');
      // Re-enable even on success: the backend is a fact table — repeated
      // submissions are expected and stored as separate rows (§6).
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
    }
  }

  function captchaError(message) {
    var err = new Error(message);
    err.captcha = true;
    return err;
  }

  /* reCAPTCHA Enterprise (score-based, invisible): inject the loader ONCE
     (data-* guard), then execute with action "signup". This loader is the
     ONLY external request the contract allows, and it never happens without
     a live config requiring captcha. */
  function loadRecaptcha(config) {
    if (window.grecaptcha && window.grecaptcha.enterprise) return Promise.resolve();
    if (recaptchaPromise) return recaptchaPromise;
    recaptchaPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://www.google.com/recaptcha/enterprise.js?render=' +
        encodeURIComponent(config.siteKey);
      script.async = true;
      script.setAttribute('data-shadow-recaptcha-loader', '1');
      script.onload = function () { resolve(); };
      script.onerror = function () {
        recaptchaPromise = null; // a later attempt may retry the load
        reject(captchaError('recaptcha loader failed'));
      };
      document.head.appendChild(script);
    });
    return recaptchaPromise;
  }

  function getRecaptchaToken(config) {
    return loadRecaptcha(config).then(function () {
      var enterprise = window.grecaptcha && window.grecaptcha.enterprise;
      if (!enterprise) return Promise.reject(captchaError('recaptcha unavailable'));
      return new Promise(function (resolve, reject) {
        enterprise.ready(function () {
          enterprise.execute(config.siteKey, { action: 'signup' })
            .then(resolve, function () { reject(captchaError('token failed')); });
        });
      });
    });
  }

  /* 422 → prefer the backend's per-field detail for the offending field;
     fall back to the specific form-level wording (never the generic one). */
  function describe422(payload) {
    var detail = payload && payload.detail;
    if (Array.isArray(detail)) {
      for (var i = 0; i < detail.length; i++) {
        var entry = detail[i];
        var loc = entry && entry.loc;
        if (Array.isArray(loc) && loc.indexOf('email') !== -1) {
          return MESSAGES.invalid422Email;
        }
      }
    }
    return MESSAGES.invalid422Form;
  }

  function successMessage(config) {
    return typeof config.successMessage === 'string' && config.successMessage
      ? config.successMessage
      : MESSAGES.successFallback;
  }

  async function attemptSubmit(form) {
    var config = getConfig();
    if (!config) return; // inert: no live config → do nothing, forever
    if (inflight.has(form)) return; // single-flight

    var status = ensureStatus(form); // created only on the live path
    var buttons = form.querySelectorAll('button');
    setBusy(form, buttons, true);

    try {
      var formData = collectFormData(form);
      var body = {
        source: config.source,
        source_url: window.location.href,
        session_id: ensureSessionId(),
        consent_version: config.consentVersion,
        form_data: formData
      };
      var email = extractEmail(form, formData);
      if (email) body.email = email; // key omitted entirely when empty

      if (config.captchaRequired) {
        body.captcha_token = await getRecaptchaToken(config); // throws → no POST
      }

      var response = await fetch(config.backendUrl.replace(/\/+$/, '') + '/api/v1/signups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.status === 200) {
        setStatus(status, successMessage(config), 'success');
      } else if (response.status === 422) {
        var payload = null;
        try { payload = await response.json(); } catch (e) { payload = null; }
        setStatus(status, describe422(payload), 'error');
      } else if (response.status === 429) {
        setStatus(status, MESSAGES.rateLimited, 'error');
      } else if (response.status === 400) {
        setStatus(status, MESSAGES.captchaRejected, 'error');
      } else {
        // 500 / unexpected: config.errorMessage (live variant) may refine it;
        // the distinct per-status wordings above are never overridden.
        var custom = typeof config.errorMessage === 'string' ? config.errorMessage : '';
        setStatus(status, custom || MESSAGES.server, 'error');
      }
    } catch (err) {
      // captcha failure or network error — error text; controls re-enabled in finally
      setStatus(status, err && err.captcha
        ? MESSAGES.captchaUnavailable
        : MESSAGES.network, 'error');
    } finally {
      setBusy(form, buttons, false);
    }
  }

  /* Submit triggers: the visible control is <button type="button"> (native
     submit never fires), so button clicks and Enter keydowns on text-like
     inputs are bound here. Without a live config both handlers return before
     acting on anything — on a local page Enter may then perform the browser's
     implicit same-file GET (harmless: nothing sent, nothing stored). */
  var TEXTLIKE = /^(text|email|search|tel|url|password|number|date|month|week|time|datetime-local)$/i;

  function onClick(event) {
    if (!event.target || !event.target.closest) return;
    var form = event.currentTarget;
    var button = event.target.closest('button, input[type="button"], input[type="submit"]');
    if (!button || !form.contains(button)) return;
    if (button.getAttribute('type') === 'reset') return;
    if (!getConfig()) return;
    event.preventDefault(); // live pages: no native GET — this form posts via fetch
    attemptSubmit(form);
  }

  function onKeyDown(event) {
    if (event.key !== 'Enter') return;
    var form = event.currentTarget;
    var target = event.target;
    if (!target || target.tagName !== 'INPUT' || !TEXTLIKE.test(target.type || '')) return;
    if (target.form !== form) return;
    if (!getConfig()) return;
    event.preventDefault(); // take over: implicit native submission never fires
    attemptSubmit(form);
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-signup]'), function (form) {
      form.addEventListener('click', onClick);
      form.addEventListener('keydown', onKeyDown);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();