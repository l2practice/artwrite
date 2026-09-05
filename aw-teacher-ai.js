/*───────────────────────────────────────────────────────────────
  ArticuWrite — Teacher AI Assistant (aw-teacher-ai.js)

  A floating "Ask AI" widget available on every teacher screen. The teacher
  pastes one or more API keys; each key is matched to a provider by its
  prefix (with a manual override when the prefix is ambiguous). The teacher
  picks a model and chats. Every call goes straight from the browser to the
  provider using the teacher's own key — nothing is proxied through the
  backend, so ArticuWrite never sees the keys.

  Chat history + keys are stored in localStorage on the teacher's device.

  Depends on: aw-common.js (for AW.esc). Loads its own styles.
───────────────────────────────────────────────────────────────*/
(function (AW) {
  'use strict';

  var LS_KEYS = 'aw_teacher_ai_keys';     // { provider: key }
  var LS_ACTIVE = 'aw_teacher_ai_active';  // provider id
  var LS_HIST = 'aw_teacher_ai_hist';      // [{role, content, model}]

  /* Providers. `detect` matches a pasted key to a provider by prefix.
     endpoint/build/parse isolate the per-API differences. */
  var PROVIDERS = {
    gemini: {
      name: 'Gemini', label: 'Google Gemini', color: '#1A73E8',
      model: 'gemini-2.5-flash',
      detect: function (k) { return /^AIza/.test(k); },
      call: async function (key, messages) {
        // Gemini wants a single "contents" array; fold system into the first user turn
        var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
        var turns = messages.filter(function (m) { return m.role !== 'system'; }).map(function (m) {
          return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
        });
        if (sys && turns.length && turns[0].role === 'user') turns[0].parts[0].text = sys + '\n\n' + turns[0].parts[0].text;
        var r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(key), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: turns, generationConfig: { temperature: 0.5, maxOutputTokens: 2048 } })
        });
        if (!r.ok) throw new Error('Gemini ' + r.status + ': ' + (await r.text()).slice(0, 200));
        var d = await r.json();
        return (((d.candidates || [])[0] || {}).content || {}).parts.map(function (p) { return p.text || ''; }).join('');
      }
    },
    openai: {
      name: 'ChatGPT', label: 'OpenAI ChatGPT', color: '#10A37F',
      model: 'gpt-4o-mini',
      detect: function (k) { return /^sk-(?!ant-)/.test(k); }, // sk- but not sk-ant-
      call: function (key, messages) { return openaiStyle('https://api.openai.com/v1/chat/completions', 'gpt-4o-mini', key, messages); }
    },
    claude: {
      name: 'Claude', label: 'Anthropic Claude', color: '#D97757',
      model: 'claude-sonnet-4-5',
      detect: function (k) { return /^sk-ant-/.test(k); },
      call: async function (key, messages) {
        var sys = messages.filter(function (m) { return m.role === 'system'; }).map(function (m) { return m.content; }).join('\n');
        var turns = messages.filter(function (m) { return m.role !== 'system'; });
        var r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true' // required for browser calls
          },
          body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2048, system: sys || undefined, messages: turns })
        });
        if (!r.ok) throw new Error('Claude ' + r.status + ': ' + (await r.text()).slice(0, 200));
        var d = await r.json();
        return (d.content || []).map(function (b) { return b.text || ''; }).join('');
      }
    },
    grok: {
      name: 'Grok', label: 'xAI Grok', color: '#111',
      model: 'grok-2-latest',
      detect: function (k) { return /^xai-/.test(k); },
      call: function (key, messages) { return openaiStyle('https://api.x.ai/v1/chat/completions', 'grok-2-latest', key, messages); }
    },
    groq: {
      name: 'Groq', label: 'Groq (Llama)', color: '#F55036',
      model: 'llama-3.3-70b-versatile',
      detect: function (k) { return /^gsk_/.test(k); },
      call: function (key, messages) { return openaiStyle('https://api.groq.com/openai/v1/chat/completions', 'llama-3.3-70b-versatile', key, messages); }
    }
  };
  var ORDER = ['gemini', 'openai', 'claude', 'grok', 'groq'];

  // OpenAI-compatible providers (OpenAI, Grok, Groq) share this shape
  async function openaiStyle(url, model, key, messages) {
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: model, messages: messages, temperature: 0.5, max_tokens: 2048 })
    });
    if (!r.ok) throw new Error(r.status + ': ' + (await r.text()).slice(0, 200));
    var d = await r.json();
    return (((d.choices || [])[0] || {}).message || {}).content || '';
  }

  function detectProvider(key) {
    for (var i = 0; i < ORDER.length; i++) {
      if (PROVIDERS[ORDER[i]].detect(key)) return ORDER[i];
    }
    return null; // ambiguous → caller asks the teacher to choose
  }

  /*──────── storage ────────*/
  function getKeys() { try { return JSON.parse(localStorage.getItem(LS_KEYS)) || {}; } catch (e) { return {}; } }
  function setKeys(o) { localStorage.setItem(LS_KEYS, JSON.stringify(o)); }
  function getActive() { return localStorage.getItem(LS_ACTIVE) || ''; }
  function setActive(p) { localStorage.setItem(LS_ACTIVE, p || ''); }
  function getHist() { try { return JSON.parse(localStorage.getItem(LS_HIST)) || []; } catch (e) { return []; } }
  function setHist(h) { localStorage.setItem(LS_HIST, JSON.stringify(h.slice(-40))); }

  /*──────── context from the current teacher screen ────────*/
  // The host page can set AW.teacherAIContext() to return a short string
  // describing what's on screen (class, active tab, open essay…).
  function pageContext() {
    try { return (typeof AW.teacherAIContext === 'function') ? (AW.teacherAIContext() || '') : ''; }
    catch (e) { return ''; }
  }

  /*──────── UI ────────*/
  var hist = getHist();

  function injectStyles() {
    if (document.getElementById('awTaiStyle')) return;
    var s = document.createElement('style');
    s.id = 'awTaiStyle';
    s.textContent = [
      '.aw-tai-fab{position:fixed;bottom:24px;right:24px;z-index:850;background:linear-gradient(135deg,#0A6EBD,#0A93BD);color:#fff;border:none;border-radius:30px;padding:13px 22px;font-weight:600;font-size:.95rem;cursor:pointer;box-shadow:0 8px 28px rgba(10,110,189,.4);font-family:var(--aw-font-body)}',
      '.aw-tai-fab:hover{transform:translateY(-2px)}',
      '.aw-tai-panel{position:fixed;bottom:24px;right:24px;z-index:851;width:420px;max-width:calc(100vw - 32px);height:600px;max-height:calc(100vh - 48px);background:#fff;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.32);display:none;flex-direction:column;overflow:hidden;font-family:var(--aw-font-body)}',
      '.aw-tai-panel.show{display:flex}',
      '.aw-tai-head{background:linear-gradient(135deg,#0A6EBD,#0A93BD);color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px}',
      '.aw-tai-head b{font-family:var(--aw-font-display)}',
      '.aw-tai-models{display:flex;gap:5px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid var(--aw-border-2);background:var(--aw-surface-2)}',
      '.aw-tai-chip{border:1px solid var(--aw-border);background:#fff;border-radius:16px;padding:4px 12px;font-size:.76rem;font-weight:600;cursor:pointer;color:var(--aw-ink-2);display:flex;align-items:center;gap:5px}',
      '.aw-tai-chip.on{color:#fff;border-color:transparent}',
      '.aw-tai-chip.off{opacity:.45}',
      '.aw-tai-dot{width:8px;height:8px;border-radius:50%;display:inline-block}',
      '.aw-tai-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--aw-bg)}',
      '.aw-tai-msg{max-width:88%;padding:9px 13px;border-radius:14px;font-size:.88rem;line-height:1.5;word-break:break-word}',
      '.aw-tai-msg.user{align-self:flex-end;background:var(--aw-primary);color:#fff;border-bottom-right-radius:4px;white-space:pre-wrap}',
      '.aw-tai-msg.ai{align-self:flex-start;background:#fff;border:1px solid var(--aw-border-2);border-bottom-left-radius:4px}',
      '@keyframes aw-blink{0%,100%{opacity:1}50%{opacity:0}}',
      '.aw-tai-cursor{display:inline-block;animation:aw-blink 0.8s infinite;margin-left:1px;color:var(--aw-primary)}',
      '.aw-tai-who{font-size:.68rem;font-weight:700;margin-bottom:3px;opacity:.75}',
      '.aw-tai-input{display:flex;gap:6px;padding:10px;border-top:1px solid var(--aw-border-2);background:#fff}',
      '.aw-tai-input textarea{flex:1;border:1px solid var(--aw-border);border-radius:12px;padding:9px 12px;font-size:.88rem;font-family:var(--aw-font-body);resize:none;max-height:120px;outline:none}',
      '.aw-tai-input textarea:focus{border-color:var(--aw-primary)}',
      '.aw-tai-send{background:var(--aw-primary);color:#fff;border:none;border-radius:10px;padding:0 16px;font-weight:600;cursor:pointer}',
      '.aw-tai-keys{padding:14px;font-size:.85rem;overflow-y:auto}',
      '.aw-tai-keys input{width:100%;border:1px solid var(--aw-border);border-radius:8px;padding:8px 10px;font-size:.85rem;box-sizing:border-box;margin:6px 0 4px}',
      '.aw-tai-keyrow{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--aw-border-2)}',
      '.aw-tai-ctx{font-size:.72rem;color:var(--aw-ink-3);padding:6px 14px;background:#EAF2FB;border-bottom:1px solid #D3E4F7;display:flex;align-items:center;gap:6px}',
      '.aw-tai-ctx input{margin:0}',
      '.aw-tai-icon-btn{background:none;border:none;color:#fff;cursor:pointer;font-size:1.05rem;line-height:1;padding:2px 4px}',
      '.aw-tai-clear-btn{background:rgba(255,255,255,.18);border:none;color:#fff;cursor:pointer;font-size:.76rem;font-weight:600;line-height:1;padding:5px 10px;border-radius:14px}',
      '.aw-tai-clear-btn:hover{background:rgba(255,255,255,.32)}'
    ].join('\n');
    document.head.appendChild(s);
  }

  var panel, msgsEl, inputEl, view = 'chat';

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
        '<div style="display:flex;gap:4px">' +
          '<button class="aw-tai-clear-btn" id="awTaiClear" title="Clear chat history (keeps keys)">Clear chat</button>' +
          '<button class="aw-tai-icon-btn" id="awTaiKeysBtn" title="Manage API keys">🔑</button>' +
          '<button class="aw-tai-icon-btn" id="awTaiClose" title="Close">×</button>' +
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
    msgsEl = document.getElementById('awTaiMsgs');
    inputEl = document.getElementById('awTaiInput');
    document.getElementById('awTaiClose').onclick = function () { panel.classList.remove('show'); document.getElementById('awTaiFab').style.display = ''; };
    document.getElementById('awTaiClear').onclick = function () { if (confirm('Xoá lịch sử chat? (API key của bạn vẫn được giữ nguyên)')) { hist = []; setHist(hist); render(); } };
    document.getElementById('awTaiKeysBtn').onclick = function () { view = (view === 'keys' ? 'chat' : 'keys'); render(); };
    document.getElementById('awTaiSend').onclick = send;
    inputEl.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    inputEl.oninput = function () { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px'; };
  }

  function render() {
    renderModels();
    if (view === 'keys') {
      document.getElementById('awTaiKeys').style.display = '';
      document.getElementById('awTaiMsgs').style.display = 'none';
      document.getElementById('awTaiInputBar').style.display = 'none';
      renderKeys();
    } else {
      document.getElementById('awTaiKeys').style.display = 'none';
      document.getElementById('awTaiMsgs').style.display = '';
      document.getElementById('awTaiInputBar').style.display = '';
      renderMsgs();
    }
  }

  function renderModels() {
    var keys = getKeys(), active = getActive(), box = document.getElementById('awTaiModels');
    box.innerHTML = ORDER.map(function (id) {
      var p = PROVIDERS[id], has = !!keys[id];
      var on = active === id && has;
      return '<button class="aw-tai-chip ' + (on ? 'on' : (has ? '' : 'off')) + '" data-prov="' + id + '"' +
        (on ? ' style="background:' + p.color + '"' : '') + '>' +
        '<span class="aw-tai-dot" style="background:' + (has ? p.color : '#bbb') + '"></span>' + p.name + '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.aw-tai-chip'), function (b) {
      b.onclick = function () {
        var id = b.dataset.prov;
        if (!getKeys()[id]) { view = 'keys'; render(); return; }
        setActive(id); render();
      };
    });
  }

  function renderKeys() {
    var keys = getKeys();
    document.getElementById('awTaiKeys').innerHTML =
      '<p style="margin:0 0 10px;color:var(--aw-ink-2)">Dán API key của bạn. App tự nhận diện mô hình theo định dạng key; key nào không rõ sẽ hỏi bạn chọn. Key lưu trên máy này.</p>' +
      '<input id="awTaiNewKey" type="password" placeholder="Dán một API key (sk-…, AIza…, gsk_…, xai-…, sk-ant-…)">' +
      '<button class="aw-btn aw-btn-primary" id="awTaiAddKey" style="padding:7px 16px;margin-top:6px">Thêm key</button>' +
      '<div style="margin-top:14px">' +
        ORDER.map(function (id) {
          var p = PROVIDERS[id], has = !!keys[id];
          return '<div class="aw-tai-keyrow"><span class="aw-tai-dot" style="background:' + (has ? p.color : '#ccc') + '"></span>' +
            '<b style="flex:1">' + p.label + '</b>' +
            (has ? '<span style="color:var(--aw-writing);font-size:.8rem">✓ đã lưu</span> <button class="aw-tai-delkey" data-p="' + id + '" title="Xoá key này" style="background:none;border:none;color:var(--aw-danger);cursor:pointer;font-size:1rem">🗑</button>'
                 : '<span style="color:var(--aw-ink-3);font-size:.8rem">chưa có</span>') +
          '</div>';
        }).join('') +
      '</div>' +
      '<p style="margin:14px 0 0;font-size:.75rem;color:var(--aw-ink-3);line-height:1.5">Lấy key: ' +
        '<a href="https://aistudio.google.com/app/apikey" target="_blank">Gemini</a> · ' +
        '<a href="https://platform.openai.com/api-keys" target="_blank">ChatGPT</a> · ' +
        '<a href="https://console.anthropic.com/settings/keys" target="_blank">Claude</a> · ' +
        '<a href="https://console.x.ai" target="_blank">Grok</a> · ' +
        '<a href="https://console.groq.com/keys" target="_blank">Groq</a></p>';

    document.getElementById('awTaiAddKey').onclick = function () {
      var k = document.getElementById('awTaiNewKey').value.trim();
      if (!k) return;
      var prov = detectProvider(k);
      if (!prov) {
        // ambiguous — ask which provider
        var opts = ORDER.map(function (id, i) { return (i + 1) + '. ' + PROVIDERS[id].label; }).join('\n');
        var pick = prompt('Không nhận diện được mô hình từ key này. Chọn số:\n' + opts);
        var idx = parseInt(pick, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= ORDER.length) return;
        prov = ORDER[idx];
      }
      var keys2 = getKeys(); keys2[prov] = k; setKeys(keys2);
      if (!getActive()) setActive(prov);
      AW.toast && AW.toast(PROVIDERS[prov].name + ' key saved', 'ok');
      render();
    };
    Array.prototype.forEach.call(document.querySelectorAll('.aw-tai-delkey'), function (b) {
      b.onclick = function () {
        var keys2 = getKeys(); delete keys2[b.dataset.p]; setKeys(keys2);
        if (getActive() === b.dataset.p) setActive(Object.keys(keys2)[0] || '');
        render();
      };
    });
  }

  /* ── Minimal markdown → safe HTML ──────────────────────────────
     Converts **bold**, *italic*, `code`, numbered/bullet lists,
     and headings. No external library needed.                       */
  function renderMd(text) {
    if (!text) return '';
    // Escape HTML first to prevent XSS
    var s = text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
    // Code blocks (``` ... ```)
    s = s.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre style="background:var(--aw-surface-2,#f5f5f5);padding:8px;border-radius:6px;font-size:.82rem;overflow-x:auto;white-space:pre-wrap">$1</pre>');
    // Inline code
    s = s.replace(/`([^`]+)`/g, '<code style="background:var(--aw-surface-2,#f5f5f5);padding:1px 4px;border-radius:3px;font-size:.88em">$1</code>');
    // Bold **text** or __text__
    s = s.replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/__([^_]+)__/g,'<b>$1</b>');
    // Italic *text* or _text_
    s = s.replace(/\*([^*]+)\*/g,'<i>$1</i>').replace(/_([^_]+)_/g,'<i>$1</i>');
    // Headings ## → bold larger
    s = s.replace(/^###\s+(.+)$/gm,'<b style="font-size:1rem">$1</b>');
    s = s.replace(/^##\s+(.+)$/gm,'<b style="font-size:1.05rem">$1</b>');
    s = s.replace(/^#\s+(.+)$/gm,'<b style="font-size:1.1rem">$1</b>');
    // Bullet lists
    s = s.replace(/^[\s]*[-*]\s+(.+)$/gm,'<div style="padding-left:12px">• $1</div>');
    // Numbered lists
    s = s.replace(/^[\s]*\d+\.\s+(.+)$/gm,'<div style="padding-left:12px">$1</div>');
    // Line breaks (double newline → paragraph break)
    s = s.replace(/\n{2,}/g,'<br><br>').replace(/\n/g,'<br>');
    return s;
  }

  function renderMsgs() {
    if (!hist.length) {
      msgsEl.innerHTML = '<div class="aw-tai-msg ai"><div class="aw-tai-who">AI Assistant</div>' +
        'Xin chào! Mình có thể giúp bạn soạn phản hồi, giải thích lỗi ngữ pháp, gợi ý cách chấm, dịch, tóm tắt… ' +
        (getActive() ? 'Đang dùng <b>' + PROVIDERS[getActive()].name + '</b>. ' : 'Bấm 🔑 để thêm API key trước. ') +
        'Bạn cần hỗ trợ gì?</div>';
      return;
    }
    msgsEl.innerHTML = hist.map(function (m) {
      if (m.role === 'user') return '<div class="aw-tai-msg user">' + AW.esc(m.content) + '</div>';
      return '<div class="aw-tai-msg ai"><div class="aw-tai-who">' + AW.esc(m.model || 'AI') + '</div>' + renderMd(m.content) + '</div>';
    }).join('');
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  /* ── Streaming helpers ─────────────────────────────────────────
     Appends text to the last (thinking) bubble in real time so the
     teacher sees words appearing immediately instead of waiting for
     the full response.                                              */
  function streamChunk(chunk) {
    var lastMsg = hist[hist.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') return;
    if (lastMsg.content === '…') lastMsg.content = '';
    lastMsg.content += chunk;
    // Update only the last bubble for performance
    var bubbles = msgsEl.querySelectorAll('.aw-tai-msg.ai');
    var last = bubbles[bubbles.length - 1];
    if (last) {
      var body = last.querySelector('.aw-tai-msg-body') || last;
      body.innerHTML = renderMd(lastMsg.content) + '<span class="aw-tai-cursor">▍</span>';
    }
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  /* ── Streaming call for Gemini ────────────────────────────────*/
  async function geminiStream(key, messages) {
    var sys = messages.filter(function(m){ return m.role==='system'; }).map(function(m){ return m.content; }).join('\n');
    var turns = messages.filter(function(m){ return m.role!=='system'; }).map(function(m){
      return { role: m.role==='assistant'?'model':'user', parts:[{text:m.content}] };
    });
    if (sys && turns.length && turns[0].role==='user') turns[0].parts[0].text = sys+'\n\n'+turns[0].parts[0].text;
    var r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse&key='+encodeURIComponent(key), {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents:turns, generationConfig:{ temperature:0.5, maxOutputTokens:1024 } })
    });
    if (!r.ok) throw new Error('Gemini '+r.status+': '+(await r.text()).slice(0,200));
    var reader = r.body.getReader(), decoder = new TextDecoder(), buf = '', full = '';
    while (true) {
      var _r = await reader.read(); if (_r.done) break;
      buf += decoder.decode(_r.value, {stream:true});
      var lines = buf.split('\n'); buf = lines.pop();
      for (var li=0; li<lines.length; li++) {
        var line = lines[li].trim();
        if (!line.startsWith('data:')) continue;
        try {
          var d = JSON.parse(line.slice(5));
          var chunk = (((d.candidates||[])[0]||{}).content||{}).parts;
          if (chunk) { var t = chunk.map(function(p){return p.text||'';}).join(''); full+=t; streamChunk(t); }
        } catch(e){}
      }
    }
    return full;
  }

  /* ── Streaming call for OpenAI-style (GPT, Grok, Groq, Claude) */
  async function openaiStream(url, model, key, messages, isAnthropic) {
    var headers = {'Content-Type':'application/json'};
    var body;
    if (isAnthropic) {
      headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
      var sys2 = messages.filter(function(m){return m.role==='system';}).map(function(m){return m.content;}).join('\n');
      var turns2 = messages.filter(function(m){return m.role!=='system';}).map(function(m){return{role:m.role,content:m.content};});
      body = JSON.stringify({model:model, max_tokens:1024, stream:true, system:sys2||undefined, messages:turns2});
    } else {
      headers['Authorization'] = 'Bearer '+key;
      body = JSON.stringify({model:model, messages:messages, temperature:0.5, max_tokens:1024, stream:true});
    }
    var r = await fetch(url, {method:'POST', headers:headers, body:body});
    if (!r.ok) throw new Error(r.status+': '+(await r.text()).slice(0,200));
    var reader = r.body.getReader(), decoder = new TextDecoder(), buf2 = '', full2 = '';
    while (true) {
      var _r2 = await reader.read(); if (_r2.done) break;
      buf2 += decoder.decode(_r2.value,{stream:true});
      var lines2 = buf2.split('\n'); buf2 = lines2.pop();
      for (var li2=0; li2<lines2.length; li2++) {
        var line2 = lines2[li2].trim();
        if (!line2.startsWith('data:')) continue;
        var payload2 = line2.slice(5).trim();
        if (payload2==='[DONE]') continue;
        try {
          var d2 = JSON.parse(payload2);
          var chunk2 = isAnthropic
            ? (d2.delta && d2.delta.text || '')
            : ((((d2.choices||[])[0]||{}).delta||{}).content||'');
          if (chunk2) { full2+=chunk2; streamChunk(chunk2); }
        } catch(e){}
      }
    }
    return full2;
  }

  async function send() {
    var active = getActive();
    if (!active || !getKeys()[active]) { view = 'keys'; render(); return; }
    var text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = ''; inputEl.style.height = 'auto';

    hist.push({ role: 'user', content: text });
    setHist(hist); renderMsgs();

    var sys = 'You are a helpful teaching assistant for an English lecturer using the ArticuWrite IELTS Writing app. ' +
      'Help with grading, feedback wording, grammar/vocabulary explanations, translation (Vietnamese/English), and lesson tasks. Be concise and practical. ' +
      'Reply in Vietnamese if the teacher writes in Vietnamese. ' +
      'Format your response in plain, readable text. Use bullet points with "•" character for lists. Do NOT use markdown symbols like ** or ## — write bold concepts in CAPITAL LETTERS or just plain text instead.';
    var wantCtx = document.getElementById('awTaiCtx') && document.getElementById('awTaiCtx').checked;
    var ctx = wantCtx ? pageContext() : '';
    if (ctx) sys += '\n\nCurrent screen context:\n' + ctx;

    var msgs = [{ role: 'system', content: sys }].concat(
      hist.slice(-12).map(function (m) { return { role: m.role, content: m.content }; })
    );

    var thinking = { role: 'assistant', content: '…', model: PROVIDERS[active].name };
    hist.push(thinking);
    // Show thinking bubble with streaming-ready body div
    var thinkingHtml = '<div class="aw-tai-msg ai"><div class="aw-tai-who">' + AW.esc(PROVIDERS[active].name) + '</div>' +
      '<div class="aw-tai-msg-body"><span class="aw-tai-cursor">▍</span></div></div>';
    msgsEl.innerHTML = hist.slice(0,-1).map(function(m){
      if (m.role==='user') return '<div class="aw-tai-msg user">'+AW.esc(m.content)+'</div>';
      return '<div class="aw-tai-msg ai"><div class="aw-tai-who">'+AW.esc(m.model||'AI')+'</div>'+renderMd(m.content)+'</div>';
    }).join('') + thinkingHtml;
    msgsEl.scrollTop = msgsEl.scrollHeight;

    try {
      var reply;
      var key = getKeys()[active];
      // Use streaming where supported
      if (active === 'gemini') {
        reply = await geminiStream(key, msgs);
      } else if (active === 'openai') {
        reply = await openaiStream('https://api.openai.com/v1/chat/completions', PROVIDERS.openai.model, key, msgs, false);
      } else if (active === 'grok') {
        reply = await openaiStream('https://api.x.ai/v1/chat/completions', PROVIDERS.grok.model, key, msgs, false);
      } else if (active === 'groq') {
        reply = await openaiStream('https://api.groq.com/openai/v1/chat/completions', PROVIDERS.groq.model, key, msgs, false);
      } else if (active === 'claude') {
        reply = await openaiStream('https://api.anthropic.com/v1/messages', PROVIDERS.claude.model, key, msgs, true);
      } else {
        reply = await PROVIDERS[active].call(key, msgs);
      }
      thinking.content = reply || '(không có phản hồi)';
    } catch (e) {
      thinking.content = '⚠️ ' + PROVIDERS[active].name + ' không phản hồi được.\n' + (e.message || e) +
        '\n\nBạn có thể chọn mô hình khác ở thanh trên.';
    }
    setHist(hist); renderMsgs();
  }

  // expose a tiny API in case a page wants to open it programmatically
  AW.teacherAI = {
    open: function () { var f = document.getElementById('awTaiFab'); if (f) f.click(); },
    setContextProvider: function (fn) { AW.teacherAIContext = fn; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();

})(window.AW = window.AW || {});
