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
  PROJECT_ID: 'YOUR-FIREBASE-PROJECT-ID',
  API_KEY:    'YOUR-WEB-API-KEY',
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

  if (!caller.isTeacher) return { success:false, error:'Unknown action: ' + action };
  if (action === 'fb.exportResults')  return fbExportResults(p, caller);
  if (action === 'fb.studentEdit')    return fbStudentEdit(p, caller);
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
function fbAuthUpdate(uid, fields) {
  var body = { localId: uid };
  if (fields.email) body.email = fields.email;
  if (fields.password) body.password = fbAuthPw(fields.password);
  if (fields.role) body.customAttributes = JSON.stringify({ role: fields.role });
  return gapi('post', itk('/accounts:update'), body);
}
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
    catch (e) { if (/EXISTS|DUPLICATE/.test(e.message)) skipped++; else Logger.log('Account ' + sid + ': ' + e.message); }
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
    ', rows of unknown students skipped: ' + unknown + '. Migration complete.');
}
