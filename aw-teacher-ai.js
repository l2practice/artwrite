/*───────────────────────────────────────────────────────────────
  ArticuWrite — Teacher AI Assistant  (aw-teacher-ai.js)

  Floating "Ask AI" widget. Keys stored in localStorage, never
  proxied through backend. All 5 providers use native streaming
  (SSE / ReadableStream) so text appears token-by-token like
  ChatGPT — no waiting for the full response.
───────────────────────────────────────────────────────────────*/
(function (AW) {
  'use strict';

  var LS_KEYS   = 'aw_teacher_ai_keys';
  var LS_ACTIVE = 'aw_teacher_ai_active';
  var LS_HIST   = 'aw_teacher_ai_hist';

  // ── System prompt ─────────────────────────────────────────────
  var SYSTEM_PROMPT =
    'You are a concise, practical teaching assistant for an English lecturer using the ArticuWrite IELTS Writing app.\n' +
    'Your role: help with grading decisions, feedback phrasing, grammar/vocabulary explanations, Vietnamese↔English translation, lesson design, and IELTS band descriptors.\n\n' +
    'RESPONSE RULES:\n' +
    '• Reply in the same language the teacher uses (Vietnamese or English).\n' +
    '• Be direct — lead with the answer, then explain if needed.\n' +
    '• Use **bold** for key terms. Use bullet lists (- item) for multiple points.\n' +
    '• Max 4-6 bullet points unless specifically asked for more.\n' +
    '• Never pad with filler phrases like "Certainly!" or "Great question!".\n' +
    '• If asked to generate text (feedback, corrections), produce it directly without meta-commentary.';

  // ── Providers ─────────────────────────────────────────────────
  var PROVIDERS = {
    gemini: {
      name: 'Gemini', label: 'Google Gemini', color: '#1A73E8',
      model: 'gemini-3.5-flash',
      detect: function (k) { return /^AIza/.test(k) || /^AQ/.test(k); }
    },
    openai: {
      name: 'ChatGPT', label: 'OpenAI ChatGPT', color: '#10A37F',
      model: 'gpt-4o-mini',
      detect: function (k) { return /^sk-(?!ant-)/.test(k); }
    },
    claude: {
      name: 'Claude', label: 'Anthropic Claude', color: '#D97757',
      model: 'claude-sonnet-4-5',
      detect: function (k) { return /^sk-ant-/.test(k); }
    },
    grok: {
      name: 'Grok', label: 'xAI Grok', color: '#111',
      model: 'grok-3-mini',
      detect: function (k) { return /^xai-/.test(k); }
    },
    groq: {
      name: 'Groq', label: 'Groq', color: '#F55036',
      model: 'openai/gpt-oss-120b',
      detect: function (k) { return /^gsk_/.test(k); }
    }
  };
  var ORDER = ['gemini', 'openai', 'claude', 'grok', 'groq'];

  // ── SSE line reader ──────────────────────────────────────────
  // Reads a streaming response body and calls onChunk(text) for
  // each token as it arrives. Works for all OpenAI-compatible SSE
  // streams and Gemini SSE.
  async function readSSE(response, parseChunk, onChunk) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    while (true) {
      var _r = await reader.read();
      if (_r.done) break;
      buf += decoder.decode(_r.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop(); // incomplete last line → keep in buffer
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.startsWith('data:')) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          var chunk = parseChunk(JSON.parse(payload));
          if (chunk) onChunk(chunk);
        } catch (e) { /* skip malformed */ }
      }
    }
  }

  // ── Per-provider streaming calls ─────────────────────────────
  async function callGemini(key, messages, onChunk) {
    var sys = messages.filter(function (m) { return m.role === 'system'; })
                      .map(function (m) { return m.content; }).join('\n');
    var turns = messages.filter(function (m) { return m.role !== 'system'; })
                        .map(function (m) {
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
    });
    if (sys && turns.length && turns[0].role === 'user')
      turns[0].parts[0].text = sys + '\n\n' + turns[0].parts[0].text;

    var r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      PROVIDERS.gemini.model + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(key),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: turns,
          generationConfig: { temperature: 0.4, maxOutputTokens: 1500 }
        })
      }
    );
    if (!r.ok) throw new Error('Gemini ' + r.status + ': ' + (await r.text()).slice(0, 200));
    await readSSE(r, function (d) {
      return (((d.candidates || [])[0] || {}).content || {}).parts
        ? (d.candidates[0].content.parts || []).map(function (p) { return p.text || ''; }).join('')
        : '';
    }, onChunk);
  }

  async function callOpenAIStyle(url, model, key, messages, onChunk, extraHeaders) {
    var headers = Object.assign(
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      extraHeaders || {}
    );
    var r = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ model: model, messages: messages, temperature: 0.4, max_tokens: 1500, stream: true })
    });
    if (!r.ok) throw new Error(r.status + ': ' + (await r.text()).slice(0, 200));
    await readSSE(r, function (d) {
      return (((d.choices || [])[0] || {}).delta || {}).content || '';
    }, onChunk);
  }

  async function callClaude(key, messages, onChunk) {
    var sys = messages.filter(function (m) { return m.role === 'system'; })
                      .map(function (m) { return m.content; }).join('\n');
    var turns = messages.filter(function (m) { return m.role !== 'system'; });
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: PROVIDERS.claude.model,
        max_tokens: 1500,
        stream: true,
        system: sys || undefined,
        messages: turns
      })
    });
    if (!r.ok) throw new Error('Claude ' + r.status + ': ' + (await r.text()).slice(0, 200));
    await readSSE(r, function (d) {
      return (d.type === 'content_block_delta' && d.delta) ? (d.delta.text || '') : '';
    }, onChunk);
  }

  async function streamProvider(active, key, messages, onChunk) {
    switch (active) {
      case 'gemini': return callGemini(key, messages, onChunk);
      case 'openai': return callOpenAIStyle('https://api.openai.com/v1/chat/completions',      PROVIDERS.openai.model, key, messages, onChunk);
      case 'grok':   return callOpenAIStyle('https://api.x.ai/v1/chat/completions',            PROVIDERS.grok.model,   key, messages, onChunk);
      case 'groq':   return callOpenAIStyle('https://api.groq.com/openai/v1/chat/completions', PROVIDERS.groq.model,   key, messages, onChunk);
      case 'claude': return callClaude(key, messages, onChunk);
      default: throw new Error('Unknown provider: ' + active);
    }
  }

  // ── Markdown renderer ────────────────────────────────────────
  // Safe: escapes HTML first, then applies formatting. No XSS risk.
  function renderMd(raw) {
    if (!raw) return '';
    var s = raw
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    // Code fences
    s = s.replace(/```[\w]*\n?([\s\S]*?)```/g,
      '<pre style="background:#f5f6f7;padding:8px 10px;border-radius:6px;font-size:.82rem;overflow-x:auto;white-space:pre-wrap;margin:6px 0">$1</pre>');
    // Inline code
    s = s.replace(/`([^`\n]+)`/g,
      '<code style="background:#f0f1f3;padding:1px 5px;border-radius:4px;font-size:.87em;font-family:monospace">$1</code>');
    // Bold
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');
    // Italic
    s = s.replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
    // Headings → bold line
    s = s.replace(/^#{1,3}\s+(.+)$/gm, '<div style="font-weight:700;margin:6px 0 2px">$1</div>');
    // Bullet points
    s = s.replace(/^[\s]*[-*+]\s+(.+)$/gm,
      '<div style="display:flex;gap:6px;margin:2px 0"><span style="color:#0A6EBD;flex-shrink:0">•</span><span>$1</span></div>');
    // Numbered list
    s = s.replace(/^[\s]*(\d+)\.\s+(.+)$/gm,
      '<div style="display:flex;gap:6px;margin:2px 0"><span style="color:#0A6EBD;flex-shrink:0;min-width:1.2em">$1.</span><span>$2</span></div>');
    // Paragraphs
    s = s.replace(/\n{2,}/g, '<br>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  // ── Storage ──────────────────────────────────────────────────
  function getKeys()   { try { return JSON.parse(localStorage.getItem(LS_KEYS))   || {}; } catch(e){ return {}; } }
  function setKeys(o)  { localStorage.setItem(LS_KEYS,   JSON.stringify(o)); }
  function getActive() { return localStorage.getItem(LS_ACTIVE) || ''; }
  function setActive(p){ localStorage.setItem(LS_ACTIVE, p || ''); }
  function getHist()   { try { return JSON.parse(localStorage.getItem(LS_HIST))   || []; } catch(e){ return []; } }
  function setHist(h)  { localStorage.setItem(LS_HIST,   JSON.stringify(h.slice(-40))); }

  function detectProvider(key) {
    for (var i = 0; i < ORDER.length; i++)
      if (PROVIDERS[ORDER[i]].detect(key)) return ORDER[i];
    return null;
  }

  function pageContext() {
    try { return (typeof AW.teacherAIContext === 'function') ? (AW.teacherAIContext() || '') : ''; }
    catch(e){ return ''; }
  }

  // ── UI ───────────────────────────────────────────────────────
  var hist = getHist();
  var panel, msgsEl, inputEl, view = 'chat';
  var isSending = false; // prevent double-send

  function injectStyles() {
    if (document.getElementById('awTaiStyle')) return;
    var s = document.createElement('style');
    s.id = 'awTaiStyle';
    s.textContent = [
      '.aw-tai-fab{position:fixed;bottom:24px;right:24px;z-index:850;background:linear-gradient(135deg,#0A6EBD,#0A93BD);color:#fff;border:none;border-radius:30px;padding:13px 22px;font-weight:600;font-size:.95rem;cursor:pointer;box-shadow:0 8px 28px rgba(10,110,189,.4);font-family:var(--aw-font-body);transition:transform .15s}',
      '.aw-tai-fab:hover{transform:translateY(-2px)}',
      '.aw-tai-panel{position:fixed;bottom:24px;right:24px;z-index:851;width:420px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100vh - 48px);background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.32);display:none;flex-direction:column;overflow:hidden;font-family:var(--aw-font-body)}',
      '.aw-tai-panel.show{display:flex}',
      '.aw-tai-head{background:linear-gradient(135deg,#0A6EBD,#0A93BD);color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-shrink:0}',
      '.aw-tai-head b{font-family:var(--aw-font-display)}',
      '.aw-tai-models{display:flex;gap:5px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid var(--aw-border-2,#e5e9ee);background:var(--aw-surface-2,#f8f9fb);flex-shrink:0}',
      '.aw-tai-chip{border:1px solid var(--aw-border,#dde2e8);background:#fff;border-radius:16px;padding:4px 12px;font-size:.76rem;font-weight:600;cursor:pointer;color:var(--aw-ink-2,#445);display:flex;align-items:center;gap:5px;transition:opacity .15s}',
      '.aw-tai-chip.on{color:#fff;border-color:transparent}',
      '.aw-tai-chip.off{opacity:.4}',
      '.aw-tai-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}',
      '.aw-tai-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--aw-bg,#f4f6f8)}',
      '.aw-tai-msg{max-width:90%;padding:10px 13px;border-radius:14px;font-size:.87rem;line-height:1.6;word-break:break-word}',
      '.aw-tai-msg.user{align-self:flex-end;background:linear-gradient(135deg,#0A6EBD,#0A93BD);color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap}',
      '.aw-tai-msg.ai{align-self:flex-start;background:#fff;border:1px solid var(--aw-border-2,#e5e9ee);border-bottom-left-radius:4px;min-width:60px}',
      '.aw-tai-who{font-size:.67rem;font-weight:700;margin-bottom:4px;opacity:.65;text-transform:uppercase;letter-spacing:.04em}',
      '.aw-tai-body{line-height:1.6}',
      /* streaming cursor */
      '@keyframes aw-blink{0%,100%{opacity:1}50%{opacity:0}}',
      '.aw-tai-cursor{display:inline-block;width:2px;height:1em;background:#0A6EBD;vertical-align:text-bottom;margin-left:2px;border-radius:1px;animation:aw-blink .7s infinite}',
      '.aw-tai-input{display:flex;gap:6px;padding:10px;border-top:1px solid var(--aw-border-2,#e5e9ee);background:#fff;flex-shrink:0}',
      '.aw-tai-input textarea{flex:1;border:1px solid var(--aw-border,#dde2e8);border-radius:12px;padding:9px 12px;font-size:.88rem;font-family:var(--aw-font-body);resize:none;max-height:120px;outline:none;line-height:1.4}',
      '.aw-tai-input textarea:focus{border-color:#0A6EBD}',
      '.aw-tai-send{background:#0A6EBD;color:#fff;border:none;border-radius:10px;padding:0 16px;font-weight:600;cursor:pointer;font-size:.9rem;transition:opacity .15s}',
      '.aw-tai-send:disabled{opacity:.45;cursor:not-allowed}',
      '.aw-tai-keys{padding:14px;font-size:.85rem;overflow-y:auto;flex:1}',
      '.aw-tai-keys input{width:100%;border:1px solid var(--aw-border,#dde2e8);border-radius:8px;padding:8px 10px;font-size:.85rem;box-sizing:border-box;margin:6px 0 4px}',
      '.aw-tai-keyrow{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--aw-border-2,#e5e9ee)}',
      '.aw-tai-ctx{font-size:.72rem;color:var(--aw-ink-3,#889);padding:5px 14px;background:#EAF2FB;border-bottom:1px solid #D3E4F7;display:flex;align-items:center;gap:6px;flex-shrink:0}',
      '.aw-tai-ctx input{margin:0}',
      '.aw-tai-icon-btn{background:none;border:none;color:#fff;cursor:pointer;font-size:1.05rem;line-height:1;padding:2px 6px;border-radius:6px;opacity:.85}',
      '.aw-tai-icon-btn:hover{opacity:1;background:rgba(255,255,255,.2)}',
      '.aw-tai-clear-btn{background:rgba(255,255,255,.18);border:none;color:#fff;cursor:pointer;font-size:.76rem;font-weight:600;padding:5px 10px;border-radius:14px}',
      '.aw-tai-clear-btn:hover{background:rgba(255,255,255,.32)}'
    ].join('\n');
    document.head.appendChild(s);
  }

  function build() {
    injectStyles();
    var fab = document.createElement('button');
    fab.className = 'aw-tai-fab'; fab.id = 'awTaiFab'; fab.textContent = '🤖 Ask AI';
    fab.onclick = function () { panel.classList.add('show'); fab.style.display = 'none'; render(); if (inputEl) inputEl.focus(); };
    document.body.appendChild(fab);

    panel = document.createElement('div');
    panel.className = 'aw-tai-panel'; panel.id = 'awTaiPanel';
    document.body.appendChild(panel);
    renderShell();
  }

  function renderShell() {
    panel.innerHTML =
      '<div class="aw-tai-head">' +
        '<b>🤖 AI Assistant</b>' +
        '<div style="display:flex;gap:4px;align-items:center">' +
          '<button class="aw-tai-clear-btn" id="awTaiClear">Clear chat</button>' +
          '<button class="aw-tai-icon-btn" id="awTaiKeysBtn" title="API keys">🔑</button>' +
          '<button class="aw-tai-icon-btn" id="awTaiClose" title="Close" style="font-size:1.3rem">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="aw-tai-models" id="awTaiModels"></div>' +
      '<label class="aw-tai-ctx"><input type="checkbox" id="awTaiCtx" checked> Cho AI biết ngữ cảnh trang đang xem</label>' +
      '<div class="aw-tai-msgs" id="awTaiMsgs"></div>' +
      '<div class="aw-tai-keys" id="awTaiKeys" style="display:none"></div>' +
      '<div class="aw-tai-input" id="awTaiInputBar">' +
        '<textarea id="awTaiInput" rows="1" placeholder="Hỏi AI bất cứ điều gì…"></textarea>' +
        '<button class="aw-tai-send" id="awTaiSend">Gửi</button>' +
      '</div>';

    msgsEl  = document.getElementById('awTaiMsgs');
    inputEl = document.getElementById('awTaiInput');

    document.getElementById('awTaiClose').onclick = function () {
      panel.classList.remove('show'); document.getElementById('awTaiFab').style.display = '';
    };
    document.getElementById('awTaiClear').onclick = function () {
      if (!confirm('Xoá lịch sử chat? (API key vẫn giữ nguyên)')) return;
      hist = []; setHist(hist); render();
    };
    document.getElementById('awTaiKeysBtn').onclick = function () {
      view = (view === 'keys' ? 'chat' : 'keys'); render();
    };
    document.getElementById('awTaiSend').onclick = send;
    inputEl.onkeydown = function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
    inputEl.oninput = function () {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
    };
  }

  function render() {
    renderModels();
    var keysEl = document.getElementById('awTaiKeys');
    var msgs2  = document.getElementById('awTaiMsgs');
    var inputBar = document.getElementById('awTaiInputBar');
    if (view === 'keys') {
      keysEl.style.display = ''; msgs2.style.display = 'none'; inputBar.style.display = 'none';
      renderKeys();
    } else {
      keysEl.style.display = 'none'; msgs2.style.display = ''; inputBar.style.display = '';
      renderMsgs();
    }
  }

  function renderModels() {
    var keys = getKeys(), active = getActive();
    var box = document.getElementById('awTaiModels');
    if (!box) return;
    box.innerHTML = ORDER.map(function (id) {
      var p = PROVIDERS[id], has = !!keys[id], on = active === id && has;
      return '<button class="aw-tai-chip ' + (on ? 'on' : has ? '' : 'off') + '" data-prov="' + id + '"' +
        (on ? ' style="background:' + p.color + '"' : '') + '>' +
        '<span class="aw-tai-dot" style="background:' + (has ? p.color : '#bbb') + '"></span>' + p.name + '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.aw-tai-chip'), function (b) {
      b.onclick = function () {
        if (!getKeys()[b.dataset.prov]) { view = 'keys'; render(); return; }
        setActive(b.dataset.prov); render();
      };
    });
  }

  function renderKeys() {
    var keys = getKeys();
    document.getElementById('awTaiKeys').innerHTML =
      '<p style="margin:0 0 10px;color:var(--aw-ink-2,#445);font-size:.83rem">Dán API key. App tự nhận diện theo prefix. Key lưu trên máy, không gửi lên server.</p>' +
      '<input id="awTaiNewKey" type="password" placeholder="sk-… / AIza… / gsk_… / xai-… / sk-ant-…">' +
      '<button class="aw-btn aw-btn-primary" id="awTaiAddKey" style="padding:7px 16px;margin-top:6px;width:100%">Thêm key</button>' +
      '<div style="margin-top:12px">' +
        ORDER.map(function (id) {
          var p = PROVIDERS[id], has = !!keys[id];
          return '<div class="aw-tai-keyrow"><span class="aw-tai-dot" style="background:' + (has ? p.color : '#ccc') + '"></span>' +
            '<b style="flex:1;font-size:.85rem">' + p.label + '</b>' +
            (has ? '<span style="color:#1A9E5C;font-size:.8rem">✓ đã lưu</span> <button class="aw-tai-delkey" data-p="' + id + '" style="background:none;border:none;color:#D93025;cursor:pointer;padding:2px 4px">🗑</button>'
                 : '<span style="color:#aaa;font-size:.79rem">chưa có</span>') + '</div>';
        }).join('') +
      '</div>' +
      '<p style="margin:12px 0 0;font-size:.73rem;color:#889;line-height:1.6">Lấy key miễn phí: ' +
        '<a href="https://aistudio.google.com/app/apikey" target="_blank">Gemini</a> · ' +
        '<a href="https://platform.openai.com/api-keys" target="_blank">ChatGPT</a> · ' +
        '<a href="https://console.anthropic.com/settings/keys" target="_blank">Claude</a> · ' +
        '<a href="https://console.x.ai" target="_blank">Grok</a> · ' +
        '<a href="https://console.groq.com/keys" target="_blank">Groq</a></p>';

    document.getElementById('awTaiAddKey').onclick = function () {
      var k = (document.getElementById('awTaiNewKey').value || '').trim();
      if (!k) return;
      var prov = detectProvider(k);
      if (!prov) {
        var opts = ORDER.map(function (id, i) { return (i+1) + '. ' + PROVIDERS[id].label; }).join('\n');
        var pick = prompt('Không nhận diện được provider. Chọn số:\n' + opts);
        var idx = parseInt(pick, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= ORDER.length) return;
        prov = ORDER[idx];
      }
      var k2 = getKeys(); k2[prov] = k; setKeys(k2);
      if (!getActive()) setActive(prov);
      AW.toast && AW.toast(PROVIDERS[prov].name + ' key saved ✓', 'ok');
      render();
    };
    Array.prototype.forEach.call(document.querySelectorAll('.aw-tai-delkey'), function (b) {
      b.onclick = function () {
        var k2 = getKeys(); delete k2[b.dataset.p]; setKeys(k2);
        if (getActive() === b.dataset.p) setActive(Object.keys(k2)[0] || '');
        render();
      };
    });
  }

  // Renders all messages from hist[] into msgsEl
  function renderMsgs() {
    if (!msgsEl) return;
    if (!hist.length) {
      msgsEl.innerHTML =
        '<div class="aw-tai-msg ai">' +
          '<div class="aw-tai-who">AI Assistant</div>' +
          '<div class="aw-tai-body">Xin chào! Mình có thể giúp soạn phản hồi, giải thích ngữ pháp, dịch, tóm tắt… ' +
          (getActive() ? 'Đang dùng <b>' + PROVIDERS[getActive()].name + '</b>. ' : '<b>Bấm 🔑 để thêm API key trước.</b> ') +
          'Bạn cần hỗ trợ gì?</div>' +
        '</div>';
      return;
    }
    msgsEl.innerHTML = hist.map(function (m) {
      if (m.role === 'user')
        return '<div class="aw-tai-msg user">' + AW.esc(m.content) + '</div>';
      return '<div class="aw-tai-msg ai">' +
        '<div class="aw-tai-who">' + AW.esc(m.model || 'AI') + '</div>' +
        '<div class="aw-tai-body">' + renderMd(m.content) + '</div>' +
        '</div>';
    }).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // Creates or returns the last AI bubble's body element for live streaming
  function getStreamBubble(modelName) {
    var existing = msgsEl.querySelector('.aw-tai-stream');
    if (existing) return existing.querySelector('.aw-tai-body');
    var div = document.createElement('div');
    div.className = 'aw-tai-msg ai aw-tai-stream';
    div.innerHTML = '<div class="aw-tai-who">' + AW.esc(modelName) + '</div>' +
                    '<div class="aw-tai-body"><span class="aw-tai-cursor"></span></div>';
    msgsEl.appendChild(div);
    return div.querySelector('.aw-tai-body');
  }

  // Called with each new chunk during streaming
  var _accumulated = '';
  function onChunk(text) {
    _accumulated += text;
    var bodyEl = msgsEl.querySelector('.aw-tai-stream .aw-tai-body');
    if (bodyEl) {
      bodyEl.innerHTML = renderMd(_accumulated) + '<span class="aw-tai-cursor"></span>';
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  }

  async function send() {
    if (isSending) return;
    var active = getActive();
    if (!active || !getKeys()[active]) { view = 'keys'; render(); return; }
    var text = (inputEl.value || '').trim();
    if (!text) return;

    isSending = true;
    var sendBtn = document.getElementById('awTaiSend');
    if (sendBtn) sendBtn.disabled = true;
    inputEl.value = ''; inputEl.style.height = 'auto';

    hist.push({ role: 'user', content: text });
    setHist(hist);
    renderMsgs(); // show user message

    // Build message list (system + last 12 turns)
    var wantCtx = document.getElementById('awTaiCtx') && document.getElementById('awTaiCtx').checked;
    var sys = SYSTEM_PROMPT + (wantCtx ? '\n\nCurrent screen context:\n' + pageContext() : '');
    var msgs = [{ role: 'system', content: sys }].concat(
      hist.slice(-12).map(function (m) { return { role: m.role, content: m.content }; })
    );

    // Create streaming bubble
    _accumulated = '';
    getStreamBubble(PROVIDERS[active].name);

    try {
      await streamProvider(active, getKeys()[active], msgs, onChunk);
    } catch (e) {
      _accumulated = '⚠️ ' + PROVIDERS[active].name + ' không phản hồi được.\n' +
        (e.message || String(e)) + '\n\nBạn có thể chọn mô hình khác ở thanh trên.';
    }

    // Finalise: remove stream marker, save to hist
    var streamEl = msgsEl.querySelector('.aw-tai-stream');
    if (streamEl) streamEl.classList.remove('aw-tai-stream');

    hist.push({ role: 'assistant', content: _accumulated, model: PROVIDERS[active].name });
    setHist(hist);

    // Remove cursor, render final markdown
    var bodyEl = msgsEl.querySelector('.aw-tai-msg.ai:last-child .aw-tai-body');
    if (bodyEl) bodyEl.innerHTML = renderMd(_accumulated);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
    if (inputEl) inputEl.focus();
  }

  // Public API
  AW.teacherAI = {
    open: function () { var f = document.getElementById('awTaiFab'); if (f) f.click(); },
    setContextProvider: function (fn) { AW.teacherAIContext = fn; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();

})(window.AW = window.AW || {});
