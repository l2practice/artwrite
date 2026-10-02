/*───────────────────────────────────────────────────────────────
  ArticuWrite — Firebase edition, Apps Script side (Firebase.gs)
  Add as a script file in the same project as Code.gs.

  Data lives in Firestore and the browser reads/writes it directly
  (fbdata.js). This file keeps only what needs admin rights or Google
  services:
    • accounts: student / teacher sign-up, forgot password, teacher edits
      a student (Student ID / class change)
    • Google Doc feedback export and Results → Google Sheet export,
      reading their data from Firestore
    • the one-time migration Google Sheet → Firebase (run from the editor)

  It talks to Firebase as the Google account that owns this script, which
  must be an Owner of the Firebase project (create the project with the
  same account, or add it under Firebase → Project settings → Users and
  permissions). Helpers below follow the FluentTalk Firebase edition.
───────────────────────────────────────────────────────────────*/

var FB = {
  // Firebase console → Project settings → General
  PROJECT_ID: 'articuwrite',
  API_KEY:    'AIzaSyCj8WTr6eaqMGhqKltiZ9444LELV-7ZDIw',
  // Realtime Database (Live): Firebase console → Realtime Database → the URL at the top
  RTDB_URL:   'https://articuwrite-default-rtdb.asia-southeast1.firebasedatabase.app',
  // Must match AW_FIREBASE.studentDomain in aw-common.js
  STUDENT_DOMAIN: 'students.articuwrite.app',
  // Classes in the Sheet without a teacher email go to this teacher
  // ('' = the first teacher of the Teachers tab).
  DEFAULT_TEACHER_EMAIL: ''
};

// ── ROUTER (called from handle() in Code.gs for actions 'fb.*') ──
function fbRoute(action, p, idToken) {
  if (action === 'fb.studentSignup')  return fbStudentSignup(p);
  if (action === 'fb.teacherSignup')  return fbTeacherSignup(p);
  if (action === 'fb.forgotPassword') return fbForgotPassword(p);

  var caller = fbVerifyIdToken(idToken);
  if (!caller) return { success:false, error:'SESSION_EXPIRED' };
  if (action === 'fb.exportDoc')      return fbExportDoc(p, caller);
  if (action === 'fb.notifyQuery')    return fbNotifyQuery(p, caller);

  if (!caller.isTeacher) return { success:false, error:'Unknown action: ' + action };
  if (action === 'fb.exportResults')  return fbExportResults(p, caller);
  if (action === 'fb.studentEdit')    return fbStudentEdit(p, caller);
  if (action === 'fb.endSemester')    return fbEndSemester(p, caller);
  if (action === 'fb.restore')        return fbRestore(p, caller);
  if (action === 'fb.clearData')      return fbClearData(p, caller);
  if (action === 'fb.resetData')      return fbResetData(p, caller);
  return { success:false, error:'Unknown action: ' + action };
}

// ════════════════════════════════════════════════════════════
// FIRESTORE (REST, as the script owner — bypasses the rules)
// ════════════════════════════════════════════════════════════
function fsBase() { return 'https://firestore.googleapis.com/v1/projects/' + FB.PROJECT_ID + '/databases/(default)/documents'; }
function fsName(path) { return 'projects/' + FB.PROJECT_ID + '/databases/(default)/documents/' + path; }
function gapi(method, url, payload) {
  var opt = { method: method, muteHttpExceptions: true, contentType: 'application/json',
              headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Goog-User-Project': FB.PROJECT_ID } };
  if (payload !== undefined) opt.payload = JSON.stringify(payload);
  var r = UrlFetchApp.fetch(url, opt), code = r.getResponseCode(), text = r.getContentText();
  var json = text ? JSON.parse(text) : {};
  if (code >= 300) {
    var msg = (json.error && (json.error.message || json.error.status)) || ('HTTP ' + code);
    var err = new Error(msg); err.code = code; throw err;
  }
  return json;
}
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v });
  if (v instanceof Date) return { stringValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}
function toFields(o) { var f = {}; Object.keys(o).forEach(function(k) { if (o[k] !== undefined) f[k] = toFs(o[k]); }); return f; }
function fromFs(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(f) { var o = {}; Object.keys(f || {}).forEach(function(k) { o[k] = fromFs(f[k]); }); return o; }
function docOf(d) { var o = fromFields(d.fields); o._id = d.name.split('/').pop(); return o; }

function fsGet(path) {
  try { return docOf(gapi('get', fsBase() + '/' + path)); }
  catch (e) { if (e.code === 404) return null; throw e; }
}
// where: [[field, op, value], ...]  op: EQUAL | LESS_THAN | ...
function fsQuery(col, where, limit) {
  var q = { from: [{ collectionId: col }] };
  if (where && where.length) {
    var filters = where.map(function(w) { return { fieldFilter: { field: { fieldPath: w[0] }, op: w[1], value: toFs(w[2]) } }; });
    q.where = filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters: filters } };
  }
  if (limit) q.limit = limit;
  var r = gapi('post', fsBase() + ':runQuery', { structuredQuery: q });
  return r.filter(function(x) { return x.document; }).map(function(x) { return docOf(x.document); });
}
function fsBatchGet(paths) {
  var outList = [];
  for (var i = 0; i < paths.length; i += 100) {
    var r = gapi('post', fsBase() + ':batchGet', { documents: paths.slice(i, i + 100).map(fsName) });
    r.forEach(function(x) { if (x.found) outList.push(docOf(x.found)); });
  }
  return outList;
}
// Field path segment, quoted when it is not a plain identifier.
function fp(seg) { return /^[A-Za-z_][A-Za-z_0-9]*$/.test(seg) ? seg : '`' + String(seg).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`'; }
function wSet(path, data) { return { update: { name: fsName(path), fields: toFields(data) } }; }
function wMerge(path, data, maskPaths) {
  return { update: { name: fsName(path), fields: toFields(data) }, updateMask: { fieldPaths: maskPaths || Object.keys(data).map(fp) } };
}
function wDelete(path) { return { delete: fsName(path) }; }
// At most 500 writes and ~10 MB per commit: cut by size (1 MB) and count.
function fsCommit(writes) {
  var batch = [], size = 0, LIMIT = 1024 * 1024;
  function send() { if (batch.length) gapi('post', fsBase() + ':commit', { writes: batch }); batch = []; size = 0; }
  writes.forEach(function(w) {
    var s = JSON.stringify(w).length;
    if (batch.length && (size + s > LIMIT || batch.length >= 400)) send();
    batch.push(w); size += s;
  });
  send();
}

// ════════════════════════════════════════════════════════════
// FIREBASE AUTH (admin, as the script owner)
// ════════════════════════════════════════════════════════════
function itk(path) { return 'https://identitytoolkit.googleapis.com/v1/projects/' + FB.PROJECT_ID + path; }
// Firebase refuses passwords under 6 characters. Pad exactly like fbdata.js.
function fbAuthPw(p) { p = String(p == null ? '' : p).trim(); return p.length >= 6 ? p : (p + '______').slice(0, 6); }
function fbLoginEmailFor(studentId) { return String(studentId).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_') + '@' + FB.STUDENT_DOMAIN; }
function fbSha256(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
// Stable ids: the same person always gets the same uid (migration can re-run).
function fbUidForStudent(studentId) { return 's' + fbSha256('sid:' + String(studentId).trim()).slice(0, 27); }
function fbUidForTeacher(email)     { return 't' + fbSha256('teacher:' + fbLow(email)).slice(0, 27); }
function fbLow(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function fbStr(v) { return String(v == null ? '' : v).trim(); }
function fbIso(v) { return v instanceof Date ? v.toISOString() : fbStr(v); }

function fbAuthCreate(uid, email, password) {
  return gapi('post', itk('/accounts'), { localId: uid, email: email, password: fbAuthPw(password), emailVerified: false });
}
// claims end up in the sign-in token: role ('teacher'|'student') for the
// Firestore rules, cls (a student's class) for the Live rules.
function fbAuthUpdate(uid, fields) {
  var body = { localId: uid };
  if (fields.email) body.email = fields.email;
  if (fields.password) body.password = fbAuthPw(fields.password);
  if (fields.role) body.customAttributes = JSON.stringify({ role: fields.role });
  if (fields.claims) body.customAttributes = JSON.stringify(fields.claims);
  return gapi('post', itk('/accounts:update'), body);
}
function fbStudentClaims(uid, classId) { return fbAuthUpdate(uid, { claims: { role: 'student', cls: classId } }); }

// ── Realtime Database (REST, as the script owner) ──
function rtdbUrl(path) { return FB.RTDB_URL.replace(/\/$/, '') + '/' + path + '.json'; }
function rtdb(method, path, payload) {
  var opt = { method: method, muteHttpExceptions: true, contentType: 'application/json',
              headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (payload !== undefined) opt.payload = JSON.stringify(payload);
  var r = UrlFetchApp.fetch(rtdbUrl(path), opt), code = r.getResponseCode(), text = r.getContentText();
  if (code >= 300) { var err = new Error('Realtime Database ' + code + ': ' + text); err.code = code; throw err; }
  return text ? JSON.parse(text) : null;
}
function fbRtdbKey(v) { return String(v == null ? '' : v).trim().replace(/[.#$\[\]\/]/g, '_') || '_'; }
function fbAuthLookupEmail(email) {
  try { return (gapi('post', itk('/accounts:lookup'), { email: [email] }).users || [])[0] || null; }
  catch (e) { return null; }
}
// Who is calling: the Firebase ID token the browser sent.
function fbVerifyIdToken(idToken) {
  if (!idToken) return null;
  var r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FB.API_KEY,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  var u = (JSON.parse(r.getContentText()).users || [])[0];
  if (!u) return null;
  var claims = {};
  try { claims = JSON.parse(u.customAttributes || '{}'); } catch (e) {}
  return { uid: u.localId, email: u.email, isTeacher: claims.role === 'teacher' };
}
function fbRandomPassword() {
  var c = 'abcdefghjkmnpqrstuvwxyz23456789', s = '';
  for (var i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

// ════════════════════════════════════════════════════════════
// ACCOUNTS
// ════════════════════════════════════════════════════════════
function fbStudentSignup(p) {
  var missing = [];
  if (!fbStr(p.studentId)) missing.push('Student ID');
  if (!fbStr(p.name))      missing.push('Họ và tên');
  if (!fbStr(p.class))     missing.push('Mã lớp');
  if (!fbStr(p.email))     missing.push('Email');
  if (!fbStr(p.birthdate)) missing.push('Ngày sinh');
  if (!fbStr(p.phone))     missing.push('Số điện thoại');
  if (!fbStr(p.password))  missing.push('Mật khẩu');
  if (missing.length) return { success:false, error:'Vui lòng nhập đầy đủ thông tin: ' + missing.join(', ') + '.' };

  var classId = fbStr(p.class).toUpperCase();
  var cls = fsGet('classes/' + classId);
  if (!cls) return { success:false, error:'Mã lớp "' + p.class + '" không tồn tại. Kiểm tra lại với giảng viên.' };
  if (cls.archived) return { success:false, error:'Lớp "' + (cls.className || classId) + '" đã kết thúc học kỳ. Liên hệ giảng viên.' };

  var sid = fbStr(p.studentId), email = fbLow(p.email), phone = fbStr(p.phone), uid = fbUidForStudent(sid);
  if (fsGet('users/' + uid) || fsQuery('users', [['studentId', 'EQUAL', sid]], 1).length)
    return { success:false, error:'Student ID "' + sid + '" đã được đăng ký. Nếu là tài khoản của bạn, hãy đăng nhập hoặc liên hệ giảng viên.', field:'studentId' };
  if (fsGet('loginIndex/' + fbSha256(email)))
    return { success:false, error:'Email "' + p.email + '" đã được đăng ký với một tài khoản khác.', field:'email' };
  if (fsQuery('users', [['phone', 'EQUAL', phone]], 1).length)
    return { success:false, error:'Số điện thoại "' + phone + '" đã được đăng ký với một tài khoản khác.', field:'phone' };

  try { fbAuthCreate(uid, fbLoginEmailFor(sid), p.password); }
  catch (e) {
    if (/EXISTS|DUPLICATE/.test(e.message))
      return { success:false, error:'Student ID "' + sid + '" đã được đăng ký.', field:'studentId' };
    throw e;
  }
  fbStudentClaims(uid, classId);
  fsCommit([
    wSet('users/' + uid, { role:'student', studentId:sid, name:fbStr(p.name), classId:classId, teacherUid:cls.teacherUid || '',
      birthdate:fbStr(p.birthdate), phone:phone, email:email, archived:false, createdAt:new Date().toISOString() }),
    wSet('loginIndex/' + fbSha256(email), { sid: sid })
  ]);
  return { success:true, data:{ studentId:sid, name:p.name, class:classId } };
}

function fbTeacherSignup(p) {
  var email = fbLow(p.email);
  if (!email || !p.password) return { success:false, error:'Thiếu email hoặc mật khẩu.' };
  if (fbAuthLookupEmail(email)) return { success:false, error:'Email đã tồn tại.' };
  var uid = fbUidForTeacher(email);
  fbAuthCreate(uid, email, p.password);
  fbAuthUpdate(uid, { role:'teacher' });
  fsCommit([wSet('users/' + uid, { role:'teacher', name:fbStr(p.name), email:email, phone:fbStr(p.phone),
    birthdate:fbStr(p.birthdate), createdAt:new Date().toISOString() })]);
  return { success:true, data:{ name:p.name, email:email, class:'' } };
}

// Passwords are no longer readable (Firebase stores them hashed): a new one
// is set and emailed instead of the old one.
function fbForgotPassword(p) {
  var email = fbLow(p.email);
  if (!email) return { success:false, error:'Nhập email đã đăng ký.' };
  var uid = '', name = '', sid = '';
  var idx = fsGet('loginIndex/' + fbSha256(email));
  if (idx && idx.multi) return { success:false, error:'Email này gắn với nhiều tài khoản. Liên hệ giảng viên để đặt lại mật khẩu.' };
  if (idx) {
    sid = idx.sid; uid = fbUidForStudent(sid);
    var u = fsGet('users/' + uid); name = u ? u.name : '';
  } else {
    var t = fbAuthLookupEmail(email);
    if (t) { uid = t.localId; var tu = fsGet('users/' + uid); name = tu ? tu.name : ''; }
  }
  if (!uid) return { success:false, error:'Không tìm thấy tài khoản với email này.' };
  var pw = fbRandomPassword();
  fbAuthUpdate(uid, { password: pw });
  try {
    MailApp.sendEmail({
      to: email, name: 'ArticuWrite',
      subject: 'ArticuWrite — Mật khẩu mới',
      body: 'Xin chào ' + (name || '') + ',\n\n' +
            'Mật khẩu mới của tài khoản ArticuWrite: ' + pw + '\n' +
            (sid ? 'Student ID: ' + sid + '\n' : '') +
            '\nĐăng nhập rồi vào Settings để đổi sang mật khẩu bạn muốn.\n\n— ArticuWrite'
    });
  } catch (err) { return { success:false, error:'Không gửi được email: ' + err.message }; }
  return { success:true, data:{ sent:true } };
}

// Teacher edits a student of their own class. A new Student ID changes the
// sign-in name; a new class must also belong to this teacher.
function fbStudentEdit(p, caller) {
  if (!p.studentId) return { success:false, error:'Missing studentId.' };
  var s = fsQuery('users', [['studentId', 'EQUAL', fbStr(p.studentId)], ['teacherUid', 'EQUAL', caller.uid]], 1)[0];
  if (!s) return { success:false, error:'Sinh viên không tồn tại.' };
  var uid = s._id, patch = {}, progPatch = {};
  ['name', 'birthdate', 'phone'].forEach(function(k) { if (fbStr(p[k])) patch[k] = fbStr(p[k]); });
  if (patch.name) progPatch.name = patch.name;

  var newId = fbStr(p.newStudentId);
  if (newId && newId !== fbStr(s.studentId)) {
    if (fsQuery('users', [['studentId', 'EQUAL', newId]], 1).length)
      return { success:false, error:'Student ID "' + newId + '" đã tồn tại trong hệ thống.' };
    fbAuthUpdate(uid, { email: fbLoginEmailFor(newId) });
    patch.studentId = newId; progPatch.studentId = newId;
  }
  if (fbStr(p.class) && fbStr(p.class) !== s.classId) {
    var cls = fsGet('classes/' + fbStr(p.class));
    if (!cls || cls.teacherUid !== caller.uid) return { success:false, error:'Lớp mới không thuộc tài khoản của bạn.' };
    patch.classId = cls.classId; progPatch.classId = cls.classId;
    fbStudentClaims(uid, cls.classId);   // Live follows the new class at the next sign-in
  }
  var writes = [];
  if (Object.keys(patch).length) writes.push(wMerge('users/' + uid, patch));
  if (Object.keys(progPatch).length && fsGet('progress/' + uid)) writes.push(wMerge('progress/' + uid, progPatch));
  if (patch.studentId && s.email) writes.push(wSet('loginIndex/' + fbSha256(fbLow(s.email)), { sid: patch.studentId }));
  fsCommit(writes);
  return { success:true };
}

// ════════════════════════════════════════════════════════════
// GOOGLE DOC / SHEET EXPORT (data from Firestore)
// ════════════════════════════════════════════════════════════
function fbItems(prog) {
  return Object.keys((prog && prog.items) || {}).map(function(k) { return prog.items[k]; });
}
function fbByTime(a, b) { return new Date(a.timestamp) - new Date(b.timestamp); }

function fbExportDoc(p, caller) {
  var mode = p.mode;
  if (['free', 'homework', 'inclass'].indexOf(mode) < 0) return { success:false, error:'Invalid mode.' };
  var user;
  if (caller.isTeacher) user = fsQuery('users', [['studentId', 'EQUAL', fbStr(p.studentId)], ['teacherUid', 'EQUAL', caller.uid]], 1)[0];
  else user = fsGet('users/' + caller.uid);   // a student only ever exports their own work
  if (!user) return { success:false, error:'No submissions to export.' };

  var prog = fsGet('progress/' + user._id) || {};
  var key = mode + '|' + fbStr(p.topicId);
  var items = fbItems(prog).filter(function(r) { return r.mode === mode && fbStr(r.topicId) === fbStr(p.topicId); }).sort(fbByTime);
  if (!items.length) return { success:false, error:'No submissions to export.' };
  var cleared = items.filter(function(r) { return r.cleared; })[0];
  if (cleared) {
    if (!cleared.docUrl) return { success:false, error:'Bài này đã lưu trữ nhưng không tìm thấy Google Doc.' };
    return { success:true, data:{ url:cleared.docUrl, reused:true, cleared:true } };
  }

  var essays = {};
  fsBatchGet(items.map(function(r) { return 'essays/' + r.id; })).forEach(function(e) { essays[e._id] = e; });
  var meta = (prog.docs || {})[key] || {};
  var rows = items.map(function(r) {
    var e = essays[r.id] || {};
    return { 'Timestamp':r.timestamp, 'Name':prog.name || user.name, 'Email':user.email || '', 'Class':r.classId,
      'Topic':r.topic, 'Task Type':r.taskType, 'AI Grading':r.aiGrading, 'TR':r.tr, 'CC':r.cc, 'LR':r.lr, 'GRA':r.gra,
      'Duration':r.duration, 'Essay':e.essay || '', 'Feedback':e.feedback || '',
      'Feedback Doc ID':meta.id || '', 'Feedback Doc Attempts':meta.attempts == null ? '' : meta.attempts,
      'Feedback Doc Summarized':meta.summarized ? '1' : '' };
  });
  var a = fsGet('assignments/' + fbStr(p.topicId));
  var asg = a ? { 'CreatedAt':a.createdAt, 'Task Type':a.taskType, 'Prompt':a.prompt,
                  'Required Attempts':a.requiredAttempts, 'Deadline':a.deadline, 'Min Words':a.minWords } : undefined;
  var cls = fsGet('classes/' + items[0].classId);
  var className = (cls && cls.className) || items[0].classId || 'Class';
  var q = { studentId: user.studentId, topicId: p.topicId, mode: mode, regenerate: p.regenerate };
  return renderFeedbackDoc_(q, rows, asg, className, function(docId, count, summaryAdded) {
    var docs = {}; docs[key] = { id: docId, attempts: count, summarized: !!(summaryAdded || meta.summarized),
                                 url: 'https://docs.google.com/document/d/' + docId + '/edit' };
    fsCommit([wMerge('progress/' + user._id, { docs: docs }, ['docs.' + fp(key)])]);
  });
}

// Same groups as fbdata.js getResults → the Sheet writer of Code.gs.
function fbExportResults(p, caller) {
  var classId = fbStr(p.class), mode = p.mode || 'free';
  var progs = fsQuery('progress', [['teacherUid', 'EQUAL', caller.uid], ['classId', 'EQUAL', classId]]);
  var cls = fsGet('classes/' + classId), prompts = {};
  fsQuery('assignments', [['classId', 'EQUAL', classId]]).forEach(function(a) { prompts[a.topicId] = a; });
  var topicId = p.all ? '' : fbStr(p.topicId);
  var cutoff = (!p.all && Number(p.days) > 0) ? Date.now() - Number(p.days) * 86400000 : 0;
  var groups = {};
  progs.forEach(function(prog) {
    fbItems(prog).forEach(function(r) {
      if (r.mode !== mode || !r.topicId) return;
      if (topicId && fbStr(r.topicId) !== topicId) return;
      if (cutoff && new Date(r.timestamp).getTime() < cutoff) return;
      var k = prog.studentId + '||' + r.topicId, a = prompts[r.topicId] || {};
      if (!groups[k]) groups[k] = { studentId: prog.studentId, name: prog.name, class: classId,
        className: (cls && cls.className) || classId, topic: r.topic, topicId: r.topicId,
        taskType: r.taskType || a.taskType || 'task2', prompt: a.prompt || '', writes: [],
        teacherScore: (prog.tscore || {})[mode + '|' + r.topicId] || null };
      groups[k].writes.push({ timestamp: r.timestamp, startTime: r.startTime, finishTime: r.finishTime,
                              duration: r.duration, overall: r.aiGrading });
    });
  });
  var list = Object.keys(groups).map(function(k) { groups[k].writes.sort(fbByTime); return groups[k]; });
  return writeResultsSheet_(filterExportGroups_(list, p), p);
}

// ════════════════════════════════════════════════════════════
// SETUP + ONE-TIME MIGRATION  Google Sheet → Firebase
// Run from the editor, in order. Every step can run again safely; a step
// that runs out of time stops cleanly — run it again to continue.
// The Google Sheet is not changed: it stays as the backup.
// ════════════════════════════════════════════════════════════
function fbLog(s) { Logger.log(s); return s; }
function fbCursor(key, v) {
  var P = PropertiesService.getScriptProperties();
  if (v === undefined) return parseInt(P.getProperty('fbmig_' + key) || '0', 10);
  P.setProperty('fbmig_' + key, String(v));
}

function fbTestConnection() {
  var r = [];
  try { fsQuery('classes', [], 1); r.push('Firestore (admin)   OK'); } catch (e) { r.push('Firestore (admin)   FAILED: ' + e.message); }
  try { gapi('post', itk('/accounts:lookup'), { email: ['nobody@' + FB.STUDENT_DOMAIN] }); r.push('Firebase Auth admin OK'); }
  catch (e) { r.push('Firebase Auth admin FAILED: ' + e.message); }
  try { rtdb('get', 'classOwner', undefined); r.push('Realtime Database   OK'); }
  catch (e) { r.push('Realtime Database   FAILED: ' + e.message + '  (check FB.RTDB_URL)'); }
  try { ss().getName(); r.push('Google Sheet        OK'); } catch (e) { r.push('Google Sheet        FAILED: ' + e.message); }
  try { MailApp.getRemainingDailyQuota(); r.push('Mail                OK'); } catch (e) { r.push('Mail                FAILED: ' + e.message); }
  return fbLog(r.join('\n'));
}

// Step 0 — big text fields are never searched: switch their indexes off
// (faster saves, and a student's attempt map never hits the index limit).
// Takes a few minutes: wait until Firestore → Indexes → Single field →
// Exemptions shows them done before step 4.
function fbStep0_IndexExemptions() {
  var fields = [['progress', 'items'], ['progress', 'tscore'], ['progress', 'docs'],
                ['essays', 'essay'], ['essays', 'feedback'], ['assignments', 'prompt'], ['assignments', 'aiNotes']];
  var out = [];
  fields.forEach(function(f) {
    var url = 'https://firestore.googleapis.com/v1/projects/' + FB.PROJECT_ID +
      '/databases/(default)/collectionGroups/' + f[0] + '/fields/' + f[1] + '?updateMask=indexConfig';
    try { gapi('patch', url, { indexConfig: { indexes: [] } }); out.push(f.join('.') + '  requested'); }
    catch (e) { out.push(f.join('.') + '  FAILED: ' + e.message); }
  });
  return fbLog(out.join('\n'));
}

function fbTeacherMap_() {
  var map = {}, first = '';
  readAll(T.TEACHERS).forEach(function(t) {
    var email = fbLow(t['Email']); if (!email) return;
    if (!first) first = email;
    map[email] = fbUidForTeacher(email);
  });
  var def = fbLow(FB.DEFAULT_TEACHER_EMAIL) || first;
  return { map: map, def: def };
}

// Step 1 — teachers: same email and password as before.
function fbStep1_Teachers() {
  var made = 0, writes = [];
  readAll(T.TEACHERS).forEach(function(t) {
    var email = fbLow(t['Email']); if (!email) return;
    var uid = fbUidForTeacher(email);
    try { fbAuthCreate(uid, email, String(t['Password'] == null ? '' : t['Password'])); made++; }
    catch (e) { if (!/EXISTS|DUPLICATE/.test(e.message)) throw e; }
    fbAuthUpdate(uid, { role: 'teacher' });
    writes.push(wSet('users/' + uid, { role:'teacher', name:fbStr(t['Name']), email:email, phone:fbStr(t['Phone']),
      birthdate:fbIso(t['Birthdate']).slice(0, 10), createdAt:fbIso(t['CreatedAt']) }));
  });
  fsCommit(writes);
  return fbLog('Teacher accounts created: ' + made + ', profiles written: ' + writes.length);
}

// Step 2 — classes and assignments.
function fbStep2_ClassesAssignments() {
  var tm = fbTeacherMap_(), owner = {}, w = [], orphan = 0;
  readAll(T.CLASSES).forEach(function(c) {
    var id = fbStr(c['Class ID']); if (!id) return;
    var email = fbLow(c['Teacher Email']) || tm.def;
    if (!fbLow(c['Teacher Email'])) orphan++;
    var tuid = fbUidForTeacher(email);
    owner[id] = tuid;
    w.push(wSet('classes/' + id, { classId:id, className:fbStr(c['Class Name']) || id, year:fbStr(c['Academic Year']),
      semester:fbStr(c['Semester']), teacherUid:tuid, teacherEmail:email,
      aiEnabled: !(c['AI Enabled'] === false || fbLow(c['AI Enabled']) === 'false'),
      archived: _semTrue(c['Archived']), archivedAt: fbIso(c['Archived At']), lastReport: fbStr(c['Last Report']),
      createdAt: fbIso(c['CreatedAt']) }));
  });
  var na = 0;
  readAll(T.ASSIGN).forEach(function(a) {
    var id = fbStr(a['Topic ID']); if (!id) return;
    var classId = fbStr(a['Class']);
    w.push(wSet('assignments/' + id, { topicId:id, mode:fbStr(a['Mode']) || 'homework', classId:classId,
      teacherUid: owner[classId] || fbUidForTeacher(tm.def), topic:fbStr(a['Topic']), prompt:String(a['Prompt'] || ''),
      taskType: a['Task Type'] === 'task1' ? 'task1' : 'task2', chartImageId:fbStr(a['Chart Image ID']),
      minWords: parseInt(a['Min Words'], 10) || 0, writingType: fbStr(a['Writing Type']) || 'full_essay',
      aiNotes: String(a['AI Notes'] || ''), requiredAttempts: parseInt(a['Required Attempts'], 10) || 1,
      durationMin: fbStr(a['Duration Min']), deadline: fbIso(a['Deadline']), createdAt: fbIso(a['CreatedAt']),
      active: !(a['Active'] === false || fbLow(a['Active']) === 'false'), dataStatus: fbStr(a['Data Status']) }));
    na++;
  });
  fsCommit(w);
  if (Object.keys(owner).length) rtdb('patch', 'classOwner', owner);   // who may watch each class Live
  return fbLog('Classes: ' + Object.keys(owner).length + ' (' + orphan + ' without teacher email → ' + tm.def + '), assignments: ' + na);
}

// Step 3 — students: same Student ID / email and the SAME password.
function fbStep3_Students() {
  var t0 = Date.now(), rows = readAll(T.STUDENTS), start = fbCursor('stu'), made = 0, skipped = 0;
  for (var i = start; i < rows.length; i++) {
    if (Date.now() - t0 > 4.5 * 60000) { fbCursor('stu', i); return fbLog('Paused at student ' + i + ' of ' + rows.length + ' — run fbStep3_Students again.'); }
    var sid = fbStr(rows[i]['Student ID']);
    if (!sid) { skipped++; continue; }
    try { fbAuthCreate(fbUidForStudent(sid), fbLoginEmailFor(sid), String(rows[i]['Password'] == null ? sid : rows[i]['Password'])); made++; }
    catch (e) { if (/EXISTS|DUPLICATE/.test(e.message)) skipped++; else { Logger.log('Account ' + sid + ': ' + e.message); continue; } }
    fbStudentClaims(fbUidForStudent(sid), fbStr(rows[i]['Class']));
  }
  fbCursor('stu', 0);
  var owner = {};
  readAll(T.CLASSES).forEach(function(c) { owner[fbStr(c['Class ID'])] = fbUidForTeacher(fbLow(c['Teacher Email']) || fbTeacherMap_().def); });
  var writes = [], emails = {};
  rows.forEach(function(s) {
    var sid = fbStr(s['Student ID']); if (!sid) return;
    var email = fbLow(s['Email']), classId = fbStr(s['Class']);
    writes.push(wSet('users/' + fbUidForStudent(sid), { role:'student', studentId:sid, name:fbStr(s['Name']), classId:classId,
      teacherUid: owner[classId] || '', birthdate: fbIso(s['Birthdate']).slice(0, 10), phone: fbStr(s['Phone']),
      email: email, archived: _semTrue(s['Archived']), createdAt: fbIso(s['CreatedAt']) }));
    if (email) (emails[email] = emails[email] || []).push(sid);
  });
  Object.keys(emails).forEach(function(e) {
    writes.push(wSet('loginIndex/' + fbSha256(e), emails[e].length > 1 ? { sid: emails[e][0], multi: true } : { sid: emails[e][0] }));
  });
  fsCommit(writes);
  return fbLog('Student accounts created: ' + made + ', already there/skipped: ' + skipped + ', profiles written: ' + rows.length);
}

/*  Step 4 — submissions. Every row of Free-writing / Homework / In-class
    becomes: one light line in progress/{uid}.items (scores, what Results
    shows) + one essays/{id} doc (essay + AI feedback). Teacher scores →
    progress.tscore, feedback Doc links → progress.docs. Essays go first
    (resumable), the progress docs last.                                    */
function fbStep4_Submissions() {
  var t0 = Date.now();
  var students = {}, known = {}, owner = {};
  readAll(T.CLASSES).forEach(function(c) { var id = fbStr(c['Class ID']); known[id] = 1; owner[id] = fbUidForTeacher(fbLow(c['Teacher Email']) || fbTeacherMap_().def); });
  readAll(T.STUDENTS).forEach(function(s) {
    var sid = fbStr(s['Student ID']); if (!sid) return;
    students[sid] = { uid: fbUidForStudent(sid), name: fbStr(s['Name']), classId: fbStr(s['Class']) };
  });
  var tabs = [[T.FREE, 'free'], [T.HOMEWORK, 'homework'], [T.INCLASS, 'inclass']];
  var progress = {}, essays = [], unknown = 0;
  tabs.forEach(function(tm) {
    var mode = tm[1];
    readAll(tm[0]).forEach(function(r) {
      var sid = fbStr(r['Student ID']), st = students[sid];
      if (!st) { if (sid) unknown++; return; }
      var ts = fbIso(r['Timestamp']), topicId = fbStr(r['Topic ID']);
      var rc = fbStr(r['Class']), classId = known[rc] ? rc : st.classId;
      var id = 'm' + fbSha256(mode + '|' + sid + '|' + ts + '|' + r._row).slice(0, 24);
      var key = mode + '|' + topicId;
      var prog = progress[st.uid] = progress[st.uid] || { studentId: sid, name: st.name, classId: st.classId,
        teacherUid: owner[st.classId] || '', items: {}, tscore: {}, docs: {} };
      prog.items[id] = { id: id, mode: mode, topicId: topicId, topic: fbStr(r['Topic']), taskType: r['Task Type'] === 'task1' ? 'task1' : 'task2',
        classId: classId, timestamp: ts, startTime: fbIso(r['Start time']), finishTime: fbIso(r['Finish time']), duration: r['Duration'] === '' ? '' : r['Duration'],
        tr: r['TR'], cc: r['CC'], lr: r['LR'], gra: r['GRA'], aiGrading: r['AI Grading'], teacherGrading: r['Teacher Grading'],
        attempt: parseInt(r['Attempt'], 10) || 1, hasFb: String(r['Feedback'] || '').length > 10, noAI: _semTrue(r['No AI']),
        docLink: fbStr(r['Google Doc Link']), cleared: String(r['Data Cleared'] || '') === '1', docUrl: fbStr(r['Feedback Doc URL']) };
      if (r['Teacher Score']) { try { prog.tscore[key] = JSON.parse(r['Teacher Score']); } catch (e) {} }
      if (r['Feedback Doc ID']) prog.docs[key] = { id: fbStr(r['Feedback Doc ID']), attempts: parseInt(r['Feedback Doc Attempts'], 10) || 0,
        summarized: String(r['Feedback Doc Summarized'] || '') === '1',
        url: 'https://docs.google.com/document/d/' + fbStr(r['Feedback Doc ID']) + '/edit' };
      essays.push({ id: id, data: { uid: st.uid, studentId: sid, classId: classId, teacherUid: owner[st.classId] || '',
        mode: mode, topicId: topicId, timestamp: ts, essay: String(r['Essay'] || ''), feedback: String(r['Feedback'] || '') } });
    });
  });

  var start = fbCursor('ess'), w = [];
  for (var i = start; i < essays.length; i++) {
    if (Date.now() - t0 > 4.5 * 60000) {
      fsCommit(w); fbCursor('ess', i);
      return fbLog('Paused at essay ' + i + ' of ' + essays.length + ' — run fbStep4_Submissions again.');
    }
    w.push(wSet('essays/' + essays[i].id, essays[i].data));
    if (w.length >= 100) { fsCommit(w); w = []; }
  }
  fsCommit(w);
  fbCursor('ess', essays.length);
  // Progress docs: one per commit (a big attempt map never shares a commit).
  Object.keys(progress).forEach(function(uid) { fsCommit([wSet('progress/' + uid, progress[uid])]); });
  fbCursor('ess', 0);
  return fbLog('Essays: ' + essays.length + ', students with progress: ' + Object.keys(progress).length +
    ', rows of unknown students skipped: ' + unknown + '. Next: fbStep5_Annotations.');
}

/*  Step 5 — feedback already pushed from Live Observation (Annotations tab)
    → Realtime Database, so students and teachers keep seeing it.          */
function fbStep5_Annotations() {
  var cls = {}, n = 0, skipped = 0, data = {};
  readAll(T.STUDENTS).forEach(function(s) { var sid = fbStr(s['Student ID']); if (sid) cls[sid] = fbStr(s['Class']); });
  readAll(T.ANNOT).forEach(function(r) {
    var sid = fbStr(r['Student ID']), c = cls[sid];
    if (!c || !fbStr(r['Topic ID'])) { skipped++; return; }
    var ts = fbIso(r['Timestamp']), path = c + '/' + fbUidForStudent(sid) + '/' + fbRtdbKey(r['Topic ID']);
    var key = 'a' + (new Date(ts).getTime() || 0) + '_' + r._row;
    (data[path] = data[path] || {})[key] = { timestamp: ts, teacher: fbStr(r['Teacher']), topicId: fbStr(r['Topic ID']),
      mode: fbStr(r['Mode']), annotatedHtml: String(r['Annotated HTML'] || '').slice(0, 45000),
      suggestions: String(r['Suggestions'] || '[]'), tr: fbStr(r['TR']), cc: fbStr(r['CC']), lr: fbStr(r['LR']),
      gra: fbStr(r['GRA']), note: fbStr(r['Note']) };
    n++;
  });
  Object.keys(data).forEach(function(path) { rtdb('patch', 'annotations/' + path, data[path]); });
  return fbLog('Live feedback copied: ' + n + ' (rows of unknown students skipped: ' + skipped + '). Next: fbStep6_BoardsQueries.');
}

// ════════════════════════════════════════════════════════════
// FIREBASE EDITION OF: End Course · Reactivate · Clear Data · Reset ·
// question emails · nightly backup. Reports reuse the Sheet edition's
// builders (Semester.gs / ClearData.gs) fed with rows shaped like the old
// tabs, so they look exactly as before.
// ════════════════════════════════════════════════════════════
function wDeleteFields(path, fieldPaths) { return { update: { name: fsName(path), fields: {} }, updateMask: { fieldPaths: fieldPaths } }; }

// Destructive actions re-check the teacher's password (same as the Sheet edition).
function fbCheckPassword(caller, password) {
  if (!password || !caller.email) return false;
  var r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FB.API_KEY,
    { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ email: caller.email, password: fbAuthPw(password), returnSecureToken: false }) });
  return r.getResponseCode() === 200 && JSON.parse(r.getContentText()).localId === caller.uid;
}
function fbOwnedClass(classId, caller) {
  var c = fsGet('classes/' + fbStr(classId));
  return c && c.teacherUid === caller.uid ? c : null;
}
function fbClassSheetShape(c) { return { 'Class ID': c.classId, 'Class Name': c.className, 'Academic Year': c.year, 'Semester': c.semester }; }
function fbAssignSheetShape(a) {
  return { 'Topic ID': a.topicId, 'Mode': a.mode, 'Class': a.classId, 'Topic': a.topic, 'Prompt': a.prompt,
           'Task Type': a.taskType, 'Required Attempts': a.requiredAttempts, 'Deadline': a.deadline,
           'CreatedAt': a.createdAt, 'Min Words': a.minWords, 'Active': a.active !== false };
}

/*  Everything of one class: Firestore (students, attempts, essays, tasks) and
    the Realtime Database (Live feedback, questions). Rows come out shaped
    like the old Sheet tabs.                                                 */
function fbClassData(classId, teacherUid) {
  var students = fsQuery('users', [['teacherUid', 'EQUAL', teacherUid], ['classId', 'EQUAL', classId]])
                   .filter(function(u) { return u.role === 'student'; });
  var progs = fsQuery('progress', [['teacherUid', 'EQUAL', teacherUid], ['classId', 'EQUAL', classId]]);
  var items = [];
  progs.forEach(function(pr) { fbItems(pr).forEach(function(it) { items.push({ prog: pr, it: it }); }); });
  var essays = {};
  fsBatchGet(items.map(function(x) { return 'essays/' + x.it.id; })).forEach(function(e) { essays[e._id] = e; });
  // teacher score of a task sits on its newest attempt (as in the Sheet)
  var newest = {};
  items.forEach(function(x) {
    var k = x.prog._id + '|' + x.it.mode + '|' + x.it.topicId;
    if (!newest[k] || x.it.timestamp > newest[k].timestamp) newest[k] = x.it;
  });
  var tabOf = { free: T.FREE, homework: T.HOMEWORK, inclass: T.INCLASS }, snap = {};
  snap[T.FREE] = []; snap[T.HOMEWORK] = []; snap[T.INCLASS] = [];
  var rows = items.map(function(x) {
    var it = x.it, pr = x.prog, e = essays[it.id] || {}, key = it.mode + '|' + it.topicId;
    var ts = newest[pr._id + '|' + key] === it ? (pr.tscore || {})[key] : null;
    var r = { 'Mode': it.mode, 'Timestamp': it.timestamp, 'Student ID': pr.studentId, 'Name': pr.name, 'Class': it.classId || classId,
      'Topic': it.topic, 'Topic ID': it.topicId, 'Task Type': it.taskType, 'Attempt': it.attempt,
      'Start time': it.startTime, 'Finish time': it.finishTime, 'Duration': it.duration,
      'TR': it.tr, 'CC': it.cc, 'LR': it.lr, 'GRA': it.gra, 'AI Grading': it.aiGrading, 'Teacher Grading': it.teacherGrading,
      'Teacher Score': ts ? JSON.stringify(ts) : '', 'Essay': e.essay || '', 'Feedback': e.feedback || '',
      'Google Doc': it.docUrl || ((pr.docs || {})[key] || {}).url || '' };
    if (tabOf[it.mode]) snap[tabOf[it.mode]].push(r);
    return r;
  });
  var ann = rtdb('get', 'annotations/' + classId) || {}, annRows = [];
  var nameOf = {}; students.forEach(function(s) { nameOf[s._id] = s; });
  Object.keys(ann).forEach(function(uid) { Object.keys(ann[uid] || {}).forEach(function(tk) {
    Object.keys(ann[uid][tk] || {}).forEach(function(k) {
      var a = ann[uid][tk][k], s = nameOf[uid] || {};
      annRows.push({ 'Timestamp': a.timestamp, 'Student ID': s.studentId || uid, 'Name': s.name || '', 'Topic ID': a.topicId,
        'Mode': a.mode, 'Teacher': a.teacher, 'Note': a.note, 'Annotated HTML': a.annotatedHtml, 'Suggestions': a.suggestions });
    });
  }); });
  var qs = rtdb('get', 'queries/' + classId) || {}, qRows = [];
  Object.keys(qs).forEach(function(uid) { Object.keys(qs[uid] || {}).forEach(function(k) {
    var q = qs[uid][k];
    qRows.push({ 'CreatedAt': q.createdAt, 'Student ID': q.studentId, 'Name': q.studentName, 'Topic': q.topic,
      'Question': q.question, 'Error Quote': q.errorQuote, 'Answer': q.answer, 'Status': q.status,
      'Shared': q.shared ? 'yes' : '', 'AnsweredAt': q.answeredAt });
  }); });
  var assigns = fsQuery('assignments', [['classId', 'EQUAL', classId]]);
  return { students: students, progs: progs, items: items, rows: rows, snap: snap, annRows: annRows, qRows: qRows, assigns: assigns };
}

var FB_RAW_HEADS = {
  'Submissions': ['Mode', 'Timestamp', 'Student ID', 'Name', 'Class', 'Topic', 'Topic ID', 'Task Type', 'Attempt',
                  'Start time', 'Finish time', 'Duration', 'TR', 'CC', 'LR', 'GRA', 'AI Grading', 'Teacher Grading',
                  'Teacher Score', 'Essay', 'Feedback', 'Google Doc'],
  'Live feedback': ['Timestamp', 'Student ID', 'Name', 'Topic ID', 'Mode', 'Teacher', 'Note', 'Annotated HTML', 'Suggestions'],
  'Questions': ['CreatedAt', 'Student ID', 'Name', 'Topic', 'Question', 'Error Quote', 'Answer', 'Status', 'Shared', 'AnsweredAt']
};
// Copy rows into a 🗄 tab and check the count. Throws on a mismatch, so
// nothing is deleted unless its copy is complete.
function fbRawTab(book, label, objs) {
  if (!objs.length) return 0;
  var head = FB_RAW_HEADS[label];
  var data = objs.map(function(o) { return head.map(function(h) {
    var v = o[h]; v = v == null ? '' : v;
    return typeof v === 'string' && v.length > 49000 ? v.slice(0, 49000) : v;
  }); });
  var sh = book.insertSheet('🗄 ' + label, book.getNumSheets());
  var sid = head.indexOf('Student ID');
  if (sid > -1) sh.getRange(1, sid + 1, data.length + 1, 1).setNumberFormat('@');
  sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground(SEM_BLUE).setFontColor('#FFFFFF');
  sh.getRange(2, 1, data.length, head.length).setValues(data);
  sh.setFrozenRows(1);
  SpreadsheetApp.flush();
  if (sh.getLastRow() - 1 !== data.length)
    throw new Error('Bản sao "' + label + '" không khớp số dòng (' + (sh.getLastRow() - 1) + '/' + data.length + '), chưa xoá gì.');
  return data.length;
}
// Delete exactly what was copied: those attempts (not attempts saved after
// the read), their essays, and the class's Live / question data.
function fbPurgeClass(classId, d) {
  var w = [];
  d.items.forEach(function(x) { w.push(wDelete('essays/' + x.it.id)); });
  d.progs.forEach(function(pr) {
    var paths = fbItems(pr).map(function(it) { return 'items.' + fp(it.id); });
    if (paths.length) w.push(wDeleteFields('progress/' + pr._id, paths.concat(['tscore', 'docs'])));
  });
  fsCommit(w);
  ['live/', 'liveText/', 'annotations/', 'queries/', 'queryOpen/', 'sharedQueries/'].forEach(function(p) { rtdb('delete', p + classId); });
  return { 'Submissions': d.items.length, 'Live feedback': d.annRows.length, 'Questions': d.qRows.length };
}

function fbSemRun(cls, caller, clear) {
  var d = fbClassData(cls.classId, caller.uid);
  var scope = { students: d.students.map(function(s) {
    return { 'Student ID': s.studentId, 'Name': s.name, 'Class': s.classId, 'Archived': !!s.archived }; }) };
  var stats = _semStats(scope, d.snap, d.assigns.map(fbAssignSheetShape));
  var me = fsGet('users/' + caller.uid) || {};
  var g = { email: caller.email, teacherName: me.name || '', cls: fbClassSheetShape(cls), classId: cls.classId };
  var book = _semReport(g, stats), url = book.getUrl();
  _semShare(book, caller.email);
  var counts = {}, removed = 0;
  try {
    fbRawTab(book, 'Submissions', d.rows);
    fbRawTab(book, 'Live feedback', d.annRows);
    fbRawTab(book, 'Questions', d.qRows);
    if (clear) { counts = fbPurgeClass(cls.classId, d); Object.keys(counts).forEach(function(k) { removed += counts[k]; }); }
  } catch (err) {
    return { ok: false, error: 'Dừng giữa chừng: ' + err.message + ' Báo cáo đã tạo.', data: { url: url } };
  }
  return { ok: true, url: url, stats: stats, counts: counts, removed: removed, g: g };
}

function fbEndSemester(p, caller) {
  if (!fbCheckPassword(caller, p.password)) return { success: false, error: 'Mật khẩu không đúng.' };
  var cls = fbOwnedClass(p.classId, caller);
  if (!cls) return { success: false, error: 'Lớp này không thuộc tài khoản của bạn.' };
  var clear = p.clear !== false, archive = clear && p.archive !== false;
  var run = fbSemRun(cls, caller, clear);
  if (!run.ok) return { success: false, error: run.error, data: run.data };
  var patch = { lastReport: run.url };
  if (archive) { patch.archived = true; patch.archivedAt = new Date().toISOString(); }
  fsCommit([wMerge('classes/' + cls.classId, patch)]);
  var emailed = _semMail(run.g, run, { cleared: clear, archived: archive });
  return { success: true, data: { url: run.url, counts: run.counts, removed: run.removed,
                                  cleared: clear, archived: archive, emailed: emailed } };
}

// Reactivate: students sign in again with a clean slate. A class archived
// without End Course may still hold data: report + back up + clear it first.
function fbRestore(p, caller) {
  if (!fbCheckPassword(caller, p.password)) return { success: false, error: 'Mật khẩu không đúng.' };
  var cls = fbOwnedClass(p.classId, caller);
  if (!cls) return { success: false, error: 'Lớp này không thuộc tài khoản của bạn.' };
  if (!cls.archived) return { success: false, error: 'Lớp này đang hoạt động.' };
  var left = fsQuery('progress', [['teacherUid', 'EQUAL', caller.uid], ['classId', 'EQUAL', cls.classId]])
    .reduce(function(n, pr) { return n + fbItems(pr).length; }, 0);
  var run = null;
  if (left) {
    run = fbSemRun(cls, caller, true);
    if (!run.ok) return { success: false, error: run.error, data: run.data };
    _semMail(run.g, run, { cleared: true, archived: false, restored: true });
  }
  var patch = { archived: false, archivedAt: '' };
  if (run) patch.lastReport = run.url;
  fsCommit([wMerge('classes/' + cls.classId, patch)]);
  var active = fsQuery('users', [['teacherUid', 'EQUAL', caller.uid], ['classId', 'EQUAL', cls.classId]])
    .filter(function(u) { return u.role === 'student' && !u.archived; }).length;
  return { success: true, data: { classId: cls.classId, students: active, leftoverCleared: left, url: run ? run.url : '' } };
}

// Reset (Settings ▸ Reset Toàn Bộ Dữ Liệu): every class of this teacher.
// Attempts, essays, Live feedback and questions are copied into one backup
// Sheet first; accounts, classes and assignments stay.
function fbResetData(p, caller) {
  var classes = fsQuery('classes', [['teacherUid', 'EQUAL', caller.uid]]);
  var book = SpreadsheetApp.create('ArticuWrite_ResetBackup_' + _semDate(Date.now(), 'yyyy-MM-dd_HHmm'));
  try { DriveApp.getFileById(book.getId()).moveTo(DriveApp.getFolderById(FEEDBACK_FOLDER_ID)); } catch (e) {}
  var all = { rows: [], annRows: [], qRows: [] }, data = {};
  classes.forEach(function(c) {
    var d = fbClassData(c.classId, caller.uid); data[c.classId] = d;
    all.rows = all.rows.concat(d.rows); all.annRows = all.annRows.concat(d.annRows); all.qRows = all.qRows.concat(d.qRows);
  });
  var results = [];
  try {
    fbRawTab(book, 'Submissions', all.rows); fbRawTab(book, 'Live feedback', all.annRows); fbRawTab(book, 'Questions', all.qRows);
    var first = book.getSheets()[0];
    if (book.getSheets().length > 1) book.deleteSheet(first); else first.getRange(1, 1).setValue('Không có dữ liệu để sao lưu.');
    classes.forEach(function(c) { var n = fbPurgeClass(c.classId, data[c.classId]); results.push(c.classId + ' reset OK (' + n['Submissions'] + ' bài)'); });
  } catch (err) { return { success: false, error: err.message + ' Bản sao: ' + book.getUrl() }; }
  _semShare(book, caller.email);
  return { success: true, data: results, backupUrl: book.getUrl() };
}

// A student sent a question: email the class's teacher.
function fbNotifyQuery(p, caller) {
  var id = String(p.queryId || '').split('~');
  if (id.length !== 3 || id[1] !== caller.uid) return { success: false, error: 'Query not found.' };
  var q = rtdb('get', 'queries/' + id[0] + '/' + id[1] + '/' + id[2]);
  var cls = fsGet('classes/' + id[0]);
  if (!q || !cls || !cls.teacherEmail) return { success: false, error: 'Query not found.' };
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
  MailApp.sendEmail({ to: cls.teacherEmail, name: 'ArticuWrite',
    subject: '📚 ArticuWrite — Câu hỏi mới từ ' + (q.studentName || q.studentId || 'Sinh viên'),
    body: 'Xin chào Thầy/Cô,\n\nCó một câu hỏi mới từ sinh viên:\n\n────────────────────────────\n' +
      '👤 Sinh viên : ' + (q.studentName || '') + ' (' + (q.studentId || '') + ')\n' +
      '🏫 Lớp       : ' + (cls.className || id[0]) + '\n' +
      '📝 Bài       : ' + (q.topic || '') + (q.attempt ? ' · Attempt ' + q.attempt : '') + '\n' +
      '🕐 Thời gian : ' + now + '\n────────────────────────────\n\n' +
      '💬 Câu hỏi:\n' + (q.question || '') + '\n\n' + (q.errorQuote ? '📌 Trích dẫn:\n"' + q.errorQuote + '"\n\n' : '') +
      'Truy cập ArticuWrite: https://l2practice.github.io/artwrite/teacher.html#queries\n\n— ArticuWrite (tự động)' });
  return { success: true };
}

// ── Clear Data (per assignment), Firebase edition ─────────────
// Same promise as before: each student's essays + feedback go into their
// Google Doc (verified), then the essays leave the database; scores stay
// and Results opens the Doc. Runs in the background, emails when done.
var FBCD_QUEUE = 'AW_FBCD_QUEUE', FBCD_RUN = 'AW_FBCD_RUNNING';
function fbClearData(p, caller) {
  var topicId = fbStr(p.topicId);
  var a = fsGet('assignments/' + topicId);
  if (!a) return { success: false, error: 'Không tìm thấy bài tập.' };
  if (a.teacherUid !== caller.uid) return { success: false, error: 'Bài tập này không thuộc lớp của bạn.' };
  if (a.mode !== 'homework' && a.mode !== 'inclass') return { success: false, error: 'Clear Data chỉ áp dụng cho Homework / In-class.' };
  if (a.dataStatus === 'clearing') return { success: true, data: { status: 'clearing', already: true } };
  var n = fsQuery('progress', [['teacherUid', 'EQUAL', caller.uid], ['classId', 'EQUAL', a.classId]]).filter(function(pr) {
    return fbItems(pr).some(function(it) { return it.mode === a.mode && it.topicId === topicId; }); }).length;
  fsCommit([wMerge('assignments/' + topicId, { dataStatus: 'clearing' })]);
  var q = fbCdQueue().filter(function(j) { return j.topicId !== topicId; });
  q.push({ topicId: topicId, mode: a.mode, classId: a.classId, email: caller.email, teacherUid: caller.uid, fails: {} });
  fbCdSave(q);
  fbCdSchedule(1);
  return { success: true, data: { status: 'clearing', students: n } };
}
function fbCdQueue() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(FBCD_QUEUE) || '[]'); } catch (e) { return []; } }
function fbCdSave(q) { PropertiesService.getScriptProperties().setProperty(FBCD_QUEUE, JSON.stringify(q)); }
function fbCdSchedule(minutes) {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === 'fbClearDataWorker') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('fbClearDataWorker').timeBased().after(minutes * 60 * 1000).create();
}
function fbCdPending(job) {   // [{prog, items}] still holding essays for this task
  return fsQuery('progress', [['teacherUid', 'EQUAL', job.teacherUid], ['classId', 'EQUAL', job.classId]]).map(function(pr) {
    return { prog: pr, items: fbItems(pr).filter(function(it) { return it.mode === job.mode && it.topicId === job.topicId; }) };
  }).filter(function(x) { return x.items.length && x.items.some(function(it) { return !it.cleared; }) &&
                                 (job.fails[x.prog.studentId] || 0) < CD_MAX_FAILS; });
}
function fbClearDataWorker() {
  var t0 = Date.now(), props = PropertiesService.getScriptProperties();
  var running = parseInt(props.getProperty(FBCD_RUN) || '0', 10);
  if (running && t0 - running < 6.5 * 60000) { fbCdSchedule(5); return; }
  props.setProperty(FBCD_RUN, String(t0));
  try {
    while (true) {
      var q = fbCdQueue();
      if (!q.length) return;
      var job = q[0], left = fbCdPending(job);
      for (var i = 0; i < left.length; i++) {
        if (Date.now() - t0 > CD_BUDGET_MS - 40000) { fbCdSave([job].concat(q.slice(1))); fbCdSchedule(1); return; }
        if (!fbCdOne(job, left[i])) job.fails[left[i].prog.studentId] = (job.fails[left[i].prog.studentId] || 0) + 1;
      }
      if (fbCdPending(job).length) { fbCdSave([job].concat(q.slice(1))); fbCdSchedule(1); return; }
      if (Date.now() - t0 > CD_BUDGET_MS - CD_FINISH_MS) { fbCdSave([job].concat(q.slice(1))); fbCdSchedule(1); return; }
      fbCdFinish(job);
      fbCdSave(fbCdQueue().filter(function(j) { return j.topicId !== job.topicId; }));
    }
  } finally { props.deleteProperty(FBCD_RUN); }
}
function fbCdOne(job, x) {
  var res;
  try { res = fbExportDoc({ studentId: x.prog.studentId, topicId: job.topicId, mode: job.mode }, { uid: job.teacherUid, isTeacher: true }); }
  catch (e) { res = null; }
  if (!res || !res.success || !res.data || !res.data.url) return false;
  var pr = fsGet('progress/' + x.prog._id), key = job.mode + '|' + job.topicId;
  var meta = (pr.docs || {})[key] || {};
  var its = fbItems(pr).filter(function(it) { return it.mode === job.mode && it.topicId === job.topicId; });
  if (!meta.id || (meta.attempts || 0) < its.length) return false;          // the Doc must hold every attempt
  try { DriveApp.getFileById(meta.id); } catch (e) { return false; }
  var w = [], fields = { items: {} }, mask = [];
  its.forEach(function(it) {
    fields.items[it.id] = { cleared: true, docUrl: res.data.url };
    mask.push('items.' + fp(it.id) + '.cleared', 'items.' + fp(it.id) + '.docUrl');
    w.push(wDelete('essays/' + it.id));
  });
  w.unshift(wMerge('progress/' + pr._id, fields, mask));
  fsCommit(w);
  return true;
}
function fbCdFinish(job) {
  var a = fsGet('assignments/' + job.topicId) || {}, cls = fsGet('classes/' + job.classId) || {};
  var me = fsGet('users/' + job.teacherUid) || {};
  var students = fsQuery('users', [['teacherUid', 'EQUAL', job.teacherUid], ['classId', 'EQUAL', job.classId]])
    .filter(function(u) { return u.role === 'student'; })
    .map(function(u) { return { 'Student ID': u.studentId, 'Name': u.name, 'Class': u.classId, 'Archived': !!u.archived }; });
  var subRows = [];
  fsQuery('progress', [['teacherUid', 'EQUAL', job.teacherUid], ['classId', 'EQUAL', job.classId]]).forEach(function(pr) {
    var key = job.mode + '|' + job.topicId, its = fbItems(pr).filter(function(it) { return it.mode === job.mode && it.topicId === job.topicId; });
    its.sort(fbByTime).forEach(function(it, i) {
      subRows.push({ 'Topic ID': job.topicId, 'Student ID': pr.studentId, 'Name': pr.name, 'Timestamp': it.timestamp,
        'AI Grading': it.aiGrading, 'Teacher Grading': it.teacherGrading, 'Duration': it.duration,
        'Teacher Score': i === its.length - 1 && (pr.tscore || {})[key] ? JSON.stringify(pr.tscore[key]) : '',
        'Data Cleared': it.cleared ? '1' : '', 'Feedback Doc URL': it.docUrl || '' });
    });
  });
  var sum = _cdSummarize(job, fbAssignSheetShape(a), fbClassSheetShape(cls), students, subRows);
  var teacher = { Name: me.name || '' };
  var book = _cdReport(sum.info, sum.list, teacher, job), url = book.getUrl();
  _semShare(book, job.email);
  fsCommit([wMerge('assignments/' + job.topicId, { dataStatus: 'cleared', dataReport: url })]);
  _cdMail(sum.info, sum.list, teacher, job, url);
}

// ── Step 6 — Boards and Ask-teacher questions → Realtime Database ──
function fbStep6_BoardsQueries() {
  var nb = 0, skipped = 0, patch = {};
  readAll(T.BOARDS).forEach(function(b) {
    var c = fbStr(b['Class']), key = fbRtdbKey(b['Board ID']);
    if (!c || !fbStr(b['Board ID'])) { skipped++; return; }
    var upd = new Date(fbIso(b['UpdatedAt'])).getTime() || Date.now();
    patch['boardMeta/' + c + '/' + key] = { title: fbStr(b['Title']) || 'Untitled Board', owner: fbStr(b['Owner']),
      createdAt: new Date(fbIso(b['CreatedAt'])).getTime() || upd, updatedAt: upd, archived: _semTrue(b['Archived']) };
    patch['boardContent/' + c + '/' + key] = { content: String(b['Content'] || ''), updatedAt: upd };
    nb++;
  });
  var cls = {}, nq = 0;
  readAll(T.STUDENTS).forEach(function(s) { var sid = fbStr(s['Student ID']); if (sid) cls[sid] = fbStr(s['Class']); });
  readAll(T.QUERIES).forEach(function(r) {
    var sid = fbStr(r['Student ID']), c = fbStr(r['Class']) || cls[sid];
    if (!sid || !c || !fbStr(r['Query ID'])) { skipped++; return; }
    var uid = fbUidForStudent(sid), key = fbRtdbKey(r['Query ID']);
    var q = { queryId: c + '~' + uid + '~' + key, uid: uid, class: c, studentId: sid, studentName: fbStr(r['Student Name']),
      mode: fbStr(r['Mode']), topic: fbStr(r['Topic']), topicId: fbStr(r['Topic ID']), attempt: fbStr(r['Attempt']),
      errorQuote: String(r['Error Quote'] || ''), question: String(r['Question'] || ''), answer: String(r['Teacher Answer'] || ''),
      status: fbStr(r['Status']) || 'open', shared: _semTrue(r['Shared']), phase: fbStr(r['Phase']) || 'review',
      createdAt: fbIso(r['CreatedAt']), answeredAt: fbIso(r['AnsweredAt']) };
    patch['queries/' + c + '/' + uid + '/' + key] = q;
    if (q.status === 'open') patch['queryOpen/' + c + '/' + key] = q;
    if (q.shared) patch['sharedQueries/' + c + '/' + key] = q;
    nq++;
  });
  if (Object.keys(patch).length) rtdb('patch', '', patch);
  return fbLog('Boards: ' + nb + ', questions: ' + nq + ' (skipped without class: ' + skipped + ').');
}

// ── Nightly backup: new submissions → a backup Google Sheet ───
// The app never reads this file, so its size never slows anything down.
// One file per year in the Drive folder of the old Sheet. Install once:
// run fbInstallNightlyBackup from the editor.
function fbInstallNightlyBackup() {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === 'fbNightlyBackup') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('fbNightlyBackup').timeBased().atHour(2).everyDays(1).inTimezone('Asia/Ho_Chi_Minh').create();
  return fbLog('Nightly backup scheduled at ~02:00. Running one now…\n' + fbNightlyBackup());
}
function fbBackupBook_() {
  var P = PropertiesService.getScriptProperties(), year = _semDate(Date.now(), 'yyyy'), key = 'fb_backup_book_' + year;
  var id = P.getProperty(key);
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  var book = SpreadsheetApp.create('ArticuWrite Backup ' + year);
  try {
    var parent = DriveApp.getFileById(SHEET_ID).getParents();
    if (parent.hasNext()) DriveApp.getFileById(book.getId()).moveTo(parent.next());
  } catch (e) {}
  var sh = book.getSheets()[0]; sh.setName('Submissions');
  sh.getRange(1, 1, 1, FB_RAW_HEADS['Submissions'].length).setValues([FB_RAW_HEADS['Submissions']]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@');
  P.setProperty(key, book.getId());
  return book;
}
function fbNightlyBackup() {
  var P = PropertiesService.getScriptProperties(), since = P.getProperty('fb_backup_since') || '1970-01-01T00:00:00.000Z';
  var essays = fsQuery('essays', [['timestamp', 'GREATER_THAN', since]]);
  if (!essays.length) return fbLog('Backup: nothing new since ' + since);
  essays.sort(function(a, b) { return a.timestamp < b.timestamp ? -1 : 1; });
  var progs = {};
  fsBatchGet(Object.keys(essays.reduce(function(m, e) { m['progress/' + e.uid] = 1; return m; }, {})))
    .forEach(function(pr) { progs[pr._id] = pr; });
  var head = FB_RAW_HEADS['Submissions'];
  var rows = essays.map(function(e) {
    var pr = progs[e.uid] || {}, it = (pr.items || {})[e._id] || {};
    var o = { 'Mode': e.mode, 'Timestamp': e.timestamp, 'Student ID': e.studentId, 'Name': pr.name, 'Class': e.classId,
      'Topic': it.topic, 'Topic ID': e.topicId, 'Task Type': it.taskType, 'Attempt': it.attempt, 'Start time': it.startTime,
      'Finish time': it.finishTime, 'Duration': it.duration, 'TR': it.tr, 'CC': it.cc, 'LR': it.lr, 'GRA': it.gra,
      'AI Grading': it.aiGrading, 'Teacher Grading': it.teacherGrading, 'Teacher Score': '', 'Essay': e.essay, 'Feedback': e.feedback,
      'Google Doc': it.docUrl || '' };
    return head.map(function(h) { var v = o[h] == null ? '' : o[h]; return typeof v === 'string' && v.length > 49000 ? v.slice(0, 49000) : v; });
  });
  var sh = fbBackupBook_().getSheetByName('Submissions');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, head.length).setValues(rows);
  P.setProperty('fb_backup_since', essays[essays.length - 1].timestamp);
  return fbLog('Backup: ' + rows.length + ' new submissions copied (up to ' + essays[essays.length - 1].timestamp + ').');
}
