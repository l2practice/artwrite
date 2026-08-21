/*───────────────────────────────────────────────────
  ArticuWrite — shared client library (aw-common.js)
  Include once per page:  <script src="aw-common.js"></script>
  Provides: AW.api, AW.session, AW.toast, AW.el, guards.
───────────────────────────────────────────────────*/
(function (global) {
  'use strict';

  // ── CONFIG ─────────────────────────────────────
  var GAS = 'https://script.google.com/macros/s/AKfycbxgVhsy3WKU-hL7rW7GZaNsn0B-z6zt6iH2Q-UlpbJVqP9koAE49P175m0tR3ISGp-m/exec';

  var AW = {
    GAS: GAS,
    // where to send unauthenticated users
    LOGIN_PAGE: 'login.html',
    STUDENT_HOME: 'student.html',
    TEACHER_HOME: 'teacher.html',
  };

  /*── API ──────────────────────────────────────────
    POST via fetch (preferred). Falls back to JSONP GET
    if fetch is blocked by CORS/redirect on some setups.
    Returns a Promise resolving to the parsed response.
  ─────────────────────────────────────────────────*/
  AW.api = function (action, payload) {
    payload = payload || {};
    return postJSON(action, payload).catch(function () {
      // fallback to JSONP for read actions
      return jsonp(action, payload);
    });
  };

  function postJSON(action, payload) {
    return fetch(GAS, {
      method: 'POST',
      // text/plain avoids CORS preflight against Apps Script
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, payload: payload }),
      redirect: 'follow',
    }).then(function (r) { return r.json(); });
  }

  var _jsonpId = 0;
  function jsonp(action, payload) {
    return new Promise(function (resolve, reject) {
      var cb = 'awcb_' + (++_jsonpId) + '_' + Date.now();
      var timer = setTimeout(function () { cleanup(); reject(new Error('JSONP timeout')); }, 20000);
      global[cb] = function (data) { cleanup(); resolve(data); };
      function cleanup() {
        clearTimeout(timer);
        try { delete global[cb]; } catch (e) { global[cb] = undefined; }
        if (s && s.parentNode) s.parentNode.removeChild(s);
      }
      var params = new URLSearchParams({
        action: action, callback: cb, payload: JSON.stringify(payload),
      });
      var s = document.createElement('script');
      s.src = GAS + '?' + params.toString();
      s.onerror = function () { cleanup(); reject(new Error('JSONP network error')); };
      document.head.appendChild(s);
    });
  }

  /*── SESSION ─────────────────────────────────────────────────────
      Tab-close: "Remember me" = localStorage (survives close, 12h TTL).
                 No "Remember me" = sessionStorage (dies with tab).
      Idle-out:  45 min of no mouse/keyboard/touch → auto logout.
      API keys (aw_gemini_key) are intentionally kept across sessions.
  ─────────────────────────────────────────────────────────────────*/
  var SKEY           = 'aw_session';
  var IDLE_KEY       = 'aw_last_active';
  var IDLE_LIMIT_MS  = 45 * 60 * 1000;   // 45 minutes
  var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours hard cap

  function _refreshIdle() {
    try { localStorage.setItem(IDLE_KEY, String(Date.now())); } catch(e) {}
  }
  function _isIdle() {
    try {
      var t = parseInt(localStorage.getItem(IDLE_KEY) || '0', 10);
      // If IDLE_KEY never set (first visit), not idle
      return t > 0 && (Date.now() - t) > IDLE_LIMIT_MS;
    } catch(e) { return false; }
  }

  AW.session = {
    // opts.remember = true  → localStorage (persists after tab close)
    // opts.remember = false → sessionStorage (cleared when tab closes)
    // Default is FALSE — safer for shared/lab computers
    set: function(obj, opts) {
      var remember = !!(opts && opts.remember === true);
      var payload  = JSON.stringify({ data:obj, exp:Date.now()+SESSION_TTL_MS });
      try { sessionStorage.removeItem(SKEY); } catch(e) {}
      try { localStorage.removeItem(SKEY);   } catch(e) {}
      try {
        if (remember) localStorage.setItem(SKEY, payload);
        else          sessionStorage.setItem(SKEY, payload);
      } catch(e) {}
      _refreshIdle();
    },
    get: function() {
      var raw = null;
      try { raw = sessionStorage.getItem(SKEY) || localStorage.getItem(SKEY); } catch(e) {}
      if (!raw) return null;
      try {
        var o = JSON.parse(raw);
        if (!o || !o.data || !o.exp) { AW.session.clear(); return null; }
        if (Date.now() > o.exp)      { AW.session.clear(); return null; }
        if (_isIdle())               { AW.session.clear(); return null; }
        return o.data;
      } catch(e) { AW.session.clear(); return null; }
    },
    clear: function() {
      try { localStorage.removeItem(SKEY);   } catch(e) {}
      try { sessionStorage.removeItem(SKEY); } catch(e) {}
      // Keep: aw_gemini_key, aw_groq_key, aw_last_active
    },
    role:   function() { var s = AW.session.get(); return s ? s.role : null; },
    require: function(role) {
      var s = AW.session.get();
      if (!s || (role && s.role !== role)) {
        location.href = AW.LOGIN_PAGE;
        return null;
      }
      _refreshIdle(); // reset idle clock on every page load
      return s;
    },
    logout: function() { AW.session.clear(); location.href = AW.LOGIN_PAGE; },
  };

  // Activity listeners — reset idle clock on any interaction
  // (throttled to once per minute to avoid excessive localStorage writes)
  var _idleThrottle = 0;
  function _onActivity() {
    var now = Date.now();
    if (now - _idleThrottle > 60000) { _idleThrottle = now; _refreshIdle(); }
  }
  ['click','keydown','touchstart','scroll'].forEach(function(ev) {
    document.addEventListener(ev, _onActivity, { passive:true, capture:true });
  });

  // Gemini key is stored separately (never leaves device)
  AW.geminiKey = {
    get: function () { return localStorage.getItem('aw_gemini_key') || ''; },
    set: function (k) { localStorage.setItem('aw_gemini_key', k || ''); },
  };
  AW.groqKey = {
    get: function () { return localStorage.getItem('aw_groq_key') || ''; },
    set: function (k) { localStorage.setItem('aw_groq_key', k || ''); },
  };

  /*── DOM + UX helpers ─────────────────────────────*/
  AW.el = function (sel, root) { return (root || document).querySelector(sel); };
  AW.els = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var _toastEl = null;
  AW.toast = function (msg, kind, ms) {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.className = 'aw-toast';
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.className = 'aw-toast show' + (kind ? ' ' + kind : '');
    clearTimeout(_toastEl._t);
    _toastEl._t = setTimeout(function () {
      _toastEl.className = 'aw-toast' + (kind ? ' ' + kind : '');
    }, ms || 2600);
  };

  // Inject the shared logo mark (pencil-in-rounded-square) as SVG string
  AW.logoSVG = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 20l1.2-4.2L15 6a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L8.2 18.8 4 20z" fill="currentColor"/><path d="M13.5 7.5l3 3" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>';

  AW.brandLockup = function () {
    return '<a class="aw-logo" href="#"><span class="aw-logo-mark">' + AW.logoSVG +
           '</span><span class="aw-logo-name">ArticuWrite</span></a>';
  };

  // word counter for essays
  AW.wordCount = function (text) {
    var t = (text || '').replace(/<[^>]*>/g, ' ').trim();
    return t ? t.split(/\s+/).length : 0;
  };

  // load Google Fonts once
  (function loadFonts() {
    if (document.getElementById('aw-fonts')) return;
    var l = document.createElement('link');
    l.id = 'aw-fonts'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap';
    document.head.appendChild(l);
  })();

  /*── icons (inline SVG) ───────────────────────────*/
  var IC = {
    modes:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    library:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5a1 1 0 0 1 1-1h5v16H5a1 1 0 0 1-1-1V5z"/><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5V4z"/></svg>',
    progress:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
    settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.2.62.79 1.05 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    live:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M5 12a7 7 0 0 1 14 0M2 12a10 10 0 0 1 20 0"/></svg>',
    results:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>',
    overview:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
    bell:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
    menu:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>',
  };
  AW.icon = function (name) { return IC[name] || ''; };

  /*── SHELL renderer (sidebar + topbar) ────────────*/
  AW.renderShell = function (opts) {
    var s = AW.session.get() || {};
    var name = (opts.user && opts.user.name) || s.name || s.email || 'User';
    var roleLabel = (opts.user && opts.user.role) || (s.role === 'teacher' ? 'Teacher' : 'Student');
    var initials = name.split(/\s+/).map(function (w) { return w[0] || ''; }).slice(0, 2).join('').toUpperCase();

    var navHtml = opts.nav.map(function (n) {
      var cls = 'aw-nav' + (n.sub ? ' aw-nav-sub' : '') + (n.active ? ' active' : '');
      var ic = n.icon ? AW.icon(n.icon) : '';
      return '<a class="' + cls + '" ' + (n.href ? 'href="' + n.href + '"' : 'data-nav="' + n.id + '"') + '>' +
             ic + '<span>' + n.label + '</span></a>';
    }).join('');

    var html =
      '<div class="aw-shell">' +
        '<aside class="aw-side" id="awSide">' +
          AW.brandLockup() + navHtml +
          '<div style="margin-top:auto">' +
            '<button class="aw-nav" id="awLogout">' + AW.icon('logout') + '<span>Sign out</span></button>' +
          '</div>' +
        '</aside>' +
        '<div class="aw-main">' +
          '<header class="aw-topbar">' +
            '<button class="aw-menu-btn" id="awMenuBtn">' + AW.icon('menu') + '</button>' +
            '<div><div class="aw-eyebrow">' + (opts.eyebrow || '') + '</div>' +
            '<h1 class="aw-page-title" id="awPageTitle">' + (opts.title || '') + '</h1></div>' +
            '<div class="aw-topbar-right">' +
              '<span style="color:var(--aw-ink-3)">' + AW.icon('bell') + '</span>' +
              '<div class="aw-user"><div class="aw-avatar">' + initials + '</div>' +
              '<div><div class="aw-user-name">' + AW.esc(name) + '</div>' +
              '<div class="aw-user-role">' + roleLabel + '</div></div></div>' +
            '</div>' +
          '</header>' +
          '<main class="aw-content" id="awContent"></main>' +
        '</div>' +
      '</div>';

    document.getElementById(opts.mount || 'app').innerHTML = html;
    document.getElementById('awLogout').onclick = function () { AW.session.logout(); };

    // ── Idle auto-logout with 5-minute warning ──────────────────
    // Check every 60s. Show banner at T-5min, logout at T=0.
    var _idleWarned = false;
    var _idleCheck = setInterval(function() {
      try {
        var t   = parseInt(localStorage.getItem(IDLE_KEY) || '0', 10);
        if (!t) return;
        var ago = Date.now() - t;
        var warn5 = IDLE_LIMIT_MS - 5 * 60 * 1000; // 40 min

        if (ago >= IDLE_LIMIT_MS) {
          clearInterval(_idleCheck);
          AW.session.clear();
          // Show message before redirect so user understands what happened
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(16,34,46,.85);z-index:99999;display:flex;align-items:center;justify-content:center';
          overlay.innerHTML = '<div style="background:#fff;border-radius:16px;padding:28px 32px;max-width:380px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)">' +
            '<div style="font-size:2rem;margin-bottom:10px">⏰</div>' +
            '<h2 style="margin:0 0 8px;font-size:1.1rem">Phiên làm việc đã hết hạn</h2>' +
            '<p style="color:#5B6B7A;font-size:.9rem;margin:0 0 18px">Bạn không hoạt động trong 45 phút. Vui lòng đăng nhập lại.</p>' +
            '<a href="' + AW.LOGIN_PAGE + '" style="display:inline-block;background:#0A6EBD;color:#fff;padding:10px 24px;border-radius:24px;text-decoration:none;font-weight:700">Đăng nhập lại</a>' +
          '</div>';
          document.body.appendChild(overlay);
          setTimeout(function(){ location.href = AW.LOGIN_PAGE; }, 3000);

        } else if (!_idleWarned && ago >= warn5) {
          _idleWarned = true;
          var mins = Math.ceil((IDLE_LIMIT_MS - ago) / 60000);
          // Show dismissible warning toast
          var warn = document.createElement('div');
          warn.id = 'aw-idle-warn';
          warn.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
            'background:#B42318;color:#fff;padding:12px 20px;border-radius:12px;z-index:9998;' +
            'font-size:.88rem;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.3);' +
            'display:flex;align-items:center;gap:12px;max-width:360px;text-align:left';
          warn.innerHTML = '⏰ Còn <b>' + mins + ' phút</b> trước khi tự động đăng xuất. <button onclick="this.parentNode.remove()" style="background:rgba(255,255,255,.2);border:none;border-radius:8px;color:#fff;padding:4px 10px;cursor:pointer;font-size:.8rem">Huỷ</button>';
          document.body.appendChild(warn);
        }
      } catch(e) {}
    }, 60000);
    var menuBtn = document.getElementById('awMenuBtn');
    if (menuBtn) menuBtn.onclick = function (e) {
      e.stopPropagation();  // prevent the outside-click listener from immediately closing it
      document.getElementById('awSide').classList.toggle('open');
    };
    // close sidebar when clicking outside on mobile (only when actually open)
    document.addEventListener('click', function(e){
      var side = document.getElementById('awSide');
      if (!side || !side.classList.contains('open')) return;
      if (side.contains(e.target)) return;               // click inside sidebar
      if (menuBtn && menuBtn.contains(e.target)) return; // click on the button itself
      side.classList.remove('open');
    });
    AW.els('[data-nav]').forEach(function (a) {
      a.onclick = function () { if (opts.onNav) opts.onNav(a.getAttribute('data-nav'), a); };
    });
    return document.getElementById('awContent');
  };

  AW.setActiveNav = function (id) {
    AW.els('.aw-nav').forEach(function (a) { a.classList.remove('active'); });
    var el = AW.el('[data-nav="' + id + '"]'); if (el) el.classList.add('active');
  };

  AW.scoreClass = function (n) {
    n = parseFloat(n); if (isNaN(n)) return '';
    return n >= 80 ? 'aw-score-hi' : n >= 60 ? 'aw-score-mid' : 'aw-score-lo';
  };
  AW.esc = function (str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  };

  // Strip HTML tags, return plain text (for displaying saved richtext prompts)
  AW.stripHtml = function (html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return tmp.textContent || tmp.innerText || '';
  };

  /*  AW.fmtDate — format any date string/value as local dd/MM/yyyy HH:mm.
      Uses the browser's timezone automatically (no hardcoded UTC+7).
      If the value is just a date (yyyy-MM-dd), shows only the date part.
      Falls back to the raw string if parsing fails.                        */
  AW.fmtDate = function (val) {
    if (!val) return '—';
    var s = String(val).trim();
    if (!s) return '—';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s; // unparseable → show raw
    // Date-only input (yyyy-MM-dd): show as dd/MM/yyyy without time
    var dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (dateOnly) {
      return d.toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric' });
    }
    // Full datetime: show dd/MM/yyyy HH:mm
    return d.toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric' }) +
           ' ' + d.toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit', hour12:false });
  };

  /*──────── Today's Word widget ────────
    Rotates at 3 AM (server-side day index) OR after every 5 logins.
    Renders into the element with id given (default 'todaysWord').
  */
  AW.renderTodaysWord = function (mountId) {
    var mount = document.getElementById(mountId || 'todaysWord');
    if (!mount) return;
    // Don't force an index — let the server pick by epochDay (UTC+7 after 3am)
    // so every student sees the same word each calendar day.
    // Only pass index when the teacher/student explicitly requests a different word
    // (e.g. a "Next word" button passes { force: true, index: N }).
    AW.api('vocab.today', {}).then(function (res) {
      if (!res || !res.success || !res.data) { mount.innerHTML = ''; return; }
      var d = res.data, c = d.current, prev = d.previous;
      mount.innerHTML =
        '<div class="aw-tw">' +
          '<div class="aw-tw-glow"></div>' +
          '<div class="aw-tw-grid">' +
            '<div class="aw-tw-left">' +
              '<div class="aw-tw-eyebrow">✦ TODAY\'S WORD</div>' +
              '<div class="aw-tw-word">' + AW.esc(c.word) +
                (c.ipa ? '<span class="aw-tw-ipa">/' + AW.esc(c.ipa) + '/</span>' : '') +
                (c.band ? '<span class="aw-tw-band">' + AW.esc(c.band) + '</span>' : '') +
              '</div>' +
              (c.meaningVi ? '<div class="aw-tw-mean"><span class="aw-tw-flag">🇻🇳</span> ' + AW.esc(c.meaningVi) + '</div>' : '') +
              (c.synonyms && c.synonyms.length ?
                '<div class="aw-tw-syn"><span class="aw-tw-lbl">SYNONYMS</span><div class="aw-tw-chips">' +
                c.synonyms.map(function (s) { return '<span class="aw-tw-chip">' + AW.esc(s) + '</span>'; }).join('') + '</div></div>' : '') +
            '</div>' +
            '<div class="aw-tw-right">' +
              (prev && prev.word ?
                '<div class="aw-tw-prev"><span class="aw-tw-prev-lbl">PREVIOUSLY</span>' +
                '<div class="aw-tw-prev-word">' + AW.esc(prev.word) + '</div>' +
                (prev.meaningVi ? '<div class="aw-tw-prev-mean">' + AW.esc(prev.meaningVi) + '</div>' : '') + '</div>' : '') +
              (c.examples && c.examples.length ?
                '<div class="aw-tw-ex"><span class="aw-tw-lbl">EXAMPLES</span>' +
                c.examples.map(function (e) { return '<p>"' + AW.esc(e) + '"</p>'; }).join('') + '</div>' : '') +
            '</div>' +
          '</div>' +
        '</div>';
    });
  };
  // call once per session to increment login count (used by rotation)
  AW.bumpLoginCount = function () {
    var LK = 'aw_login_count';
    localStorage.setItem(LK, String(parseInt(localStorage.getItem(LK) || '0', 10) + 1));
  };

  /*──────── Class mode: Experimental (AI on) vs Control (AI off) ────────
     The teacher flips this per class. Students in a control class keep every
     human feature but see no AI grading or AI tutor, so the two research
     groups differ only in the thing being studied.
     Cached briefly so navigating between pages doesn't re-query each time. */
  var AI_TTL = 120000; // 2 minutes
  /* Synchronous read of the cached flag. Returns true/false, or null when we
     have never looked it up on this device. Lets a page render immediately
     with the right controls instead of flashing the wrong ones. */
  AW.classAICached = function (classId) {
    if (!classId) return null;
    try {
      var hit = JSON.parse(sessionStorage.getItem('aw_classai_' + classId) || 'null');
      if (hit && (Date.now() - hit.t) < AI_TTL) return hit.on !== false;
    } catch (e) {}
    return null;
  };
  AW.loadClassAI = function (classId, cb) {
    if (!classId) { cb(true); return; }
    var key = 'aw_classai_' + classId;
    try {
      var hit = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (hit && (Date.now() - hit.t) < AI_TTL) { cb(hit.on !== false); return; }
    } catch (e) {}
    AW.api('class.get', { classId: classId }).then(function (res) {
      // default to ON if the class can't be read, so a network hiccup never
      // silently downgrades an experimental class
      var on = !(res && res.data && res.data.aiEnabled === false);
      try { sessionStorage.setItem(key, JSON.stringify({ on: on, t: Date.now() })); } catch (e) {}
      cb(on);
    }).catch(function () { cb(true); });
  };

  global.AW = AW;
})(window);
