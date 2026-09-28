/*───────────────────────────────────────────────────────────────
  ArticuWrite — Google Apps Script Backend (Code.gs)
  Version: Task 1 + Task 2 (dual-task build)
  Sheet:   1--BDfW25jbpch7yjZ4-AuVN9hQd6LZ8f5X1jo108rpo

  DEPLOY: Extensions ▸ Apps Script ▸ paste ▸ Deploy ▸ New deployment
          ▸ Web app ▸ Execute as: Me ▸ Who has access: Anyone
          ▸ copy /exec URL into GAS_URL constant in each .html

  DRIVE PERMISSIONS:
  Run `authorizeDrive` once manually after first deploy to grant
  full Drive scope (needed for folder/file operations).

  Router: both doGet (JSONP) and doPost (fetch) dispatch on `action`.
  Companion file: Retention.gs (deadline mail, free-writing lifecycle,
  archive/purge). Live observation lives in CacheService, not the sheet.
  All responses: { success:Boolean, data|error }
───────────────────────────────────────────────────────────────*/

function authorizeDrive() {
  var f = DriveApp.getFolderById(FEEDBACK_FOLDER_ID);
  Logger.log('Drive OK — folder: ' + f.getName());
  return f.getName();
}

// ── Constants ──────────────────────────────────────────────────
const SHEET_ID          = '1--BDfW25jbpch7yjZ4-AuVN9hQd6LZ8f5X1jo108rpo';
const FEEDBACK_FOLDER_ID = '19qEb8EI2Z0jsC8x5KJLh2KbbVSaOy_FU'; // reuse same Drive folder
const LIVE_STALE_MS     = 45 * 1000;   // client keep-alive is 20 s; 45 s tolerates one lost ping
const LIBRARY_SHEET_ID   = '1hGGkk18_qiDWnZYx1yILHRpVHfdEpGOo-drEByKsplg';
const LIBRARY_TAB        = ''; // '' = first tab

// ── Tab names ──────────────────────────────────────────────────
const T = {
  STUDENTS: 'Students',
  TEACHERS: 'Teachers',
  CLASSES:  'Classes',
  HISTORY:  'History',
  FREE:     'Free-writing',
  HOMEWORK: 'Homework',
  INCLASS:  'In-class Practice',
  ASSIGN:   'Assignments',
  LIVE:     'LiveSessions',
  ANNOT:    'Annotations',
  BOARDS:   'Boards',
  LIBACCESS:'LibraryAccess',
  VOCAB:    'Vocabulary',
  QUERIES:  'FeedbackQueries',
  TR_SETS:    'TranslateSets',
  TR_RESULTS: 'TranslateResults',
};

// ── Column headers ─────────────────────────────────────────────
// NEW vs original:
//   ASSIGN gets 'Task Type' ('task1'|'task2') and 'Chart Image ID' (Drive file ID)
//   Submission tabs (FREE/HOMEWORK/INCLASS) get 'Task Type' so results can be
//   filtered/displayed correctly without re-fetching the assignment.
const SUBMISSION_COLS = [
  'Timestamp','Student ID','Name','Class','Topic','Topic ID',
  'Task Type',                          // ← NEW: 'task1' | 'task2'
  'Start time','Finish time','Duration',
  'TR','CC','LR','GRA',
  'AI Grading','Teacher Grading',
  'Attempt','Essay','Feedback','Teacher Score'
];

const HEADERS = {
  [T.STUDENTS]: ['Student ID','Name','Class','Birthdate','Password','Phone','Email','CreatedAt'],
  [T.TEACHERS]: ['Name','Class','Birthdate','Password','Phone','Email','CreatedAt'],
  [T.CLASSES]:  ['Class ID','Class Name','Academic Year','Semester','Teacher Email','CreatedAt'],
  [T.HISTORY]:  ['Timestamp','Student ID','Name','Practice Mode','Topic','Topic ID','Task Type'],
  [T.FREE]:     [...SUBMISSION_COLS],
  [T.HOMEWORK]: [...SUBMISSION_COLS, 'Google Doc Link'],
  [T.INCLASS]:  [...SUBMISSION_COLS, 'Google Doc Link'],
  [T.ASSIGN]:   [
    'Topic ID','Mode','Class','Topic','Prompt',
    'Task Type',          // ← 'task1' | 'task2' (default 'task2')
    'Chart Image ID',     // ← Drive file ID of chart image (Task 1 only)
    'Min Words',          // ← custom minimum word count (0 = use default 150/250)
    'Writing Type',       // ← 'full_essay' | 'paragraph' | 'sentences'
    'AI Notes','Required Attempts','Duration Min','Deadline','CreatedAt','Active'
  ],
  [T.LIVE]:     ['Student ID','Name','Class','Topic ID','Topic','Mode','Status',
                 'Word Count','Snapshot','Raised Hand','Updated'],
  [T.ANNOT]:    ['Timestamp','Student ID','Topic ID','Mode','Teacher',
                 'Suggestions','Annotated HTML','TR','CC','LR','GRA','Note'],
  [T.BOARDS]:   ['Board ID','Class','Title','Content','Owner','CreatedAt','UpdatedAt'],
  [T.LIBACCESS]:['Question','Scope','Target','State','UpdatedAt'],
  [T.VOCAB]:    ['Word','IPA','Band','Meaning VI','Synonyms','Example 1','Example 2'],
  [T.QUERIES]:  ['Query ID','Class','Student ID','Student Name','Mode','Topic','Topic ID',
                 'Attempt','Error Quote','Question','Teacher Answer','Status',
                 'Shared','Phase','CreatedAt','AnsweredAt'],
  [T.TR_SETS]: [
    'Set ID','Class','Title','Target Words','Items JSON',
    'Pass Score','Session Start','Session End','Deadline',
    'Duration Min','Shuffle','Active','CreatedAt','Created By'
  ],
  [T.TR_RESULTS]: [
    'Timestamp','Student ID','Name','Class','Set ID','Title',
    'Run Index','Score','Passed','Duration Sec',
    'Item Scores JSON','Cleared Item IDs JSON','Chest JSON',
    'Partial','Current Index'
  ],
};

// ── Router ─────────────────────────────────────────────────────
function doGet(e)  { return handle(e, 'GET');  }
function doPost(e) { return handle(e, 'POST'); }

function handle(e, method) {
  var params  = (e && e.parameter) || {};
  var action  = params.action || '';
  var payload = {};
  try {
    if (method === 'POST' && e.postData && e.postData.contents) {
      var body = JSON.parse(e.postData.contents);
      action   = body.action  || action;
      payload  = body.payload || {};
    } else if (params.payload) {
      payload = JSON.parse(params.payload);
    }
  } catch (err) {
    return respond(e, { success:false, error:'Bad payload: ' + err.message });
  }
  var out;
  try   { out = dispatch(action, payload); }
  catch (err) { out = { success:false, error:err.message, action:action }; }
  return respond(e, out);
}

/*  Actions that write to a row found by index (read → setValue at i+1) run
    under the script lock (rtLocked, Retention.gs) so a background purge
    deleting rows can never shift the target row in between.              */
function dispatch(action, p) {
  switch (action) {
    // auth
    case 'auth.studentSignup':       return studentSignup(p);
    case 'auth.studentLogin':        return studentLogin(p);
    case 'auth.teacherLogin':        return teacherLogin(p);
    case 'auth.teacherSignup':       return teacherSignup(p);
    case 'auth.forgotPassword':      return forgotPassword(p);
    case 'auth.changePassword':      return changePassword(p);
    // classes
    case 'class.create':             return classCreate(p);
    case 'class.list':               return classList(p);
    case 'class.get':                return classGet(p);
    case 'class.roster':             return getRoster(p);
    case 'class.archive':            return archiveClass(p);
    case 'class.setAiEnabled':       return classSetAiEnabled(p);
    case 'student.archive':          return archiveStudent(p);
    case 'student.getById':          return studentGetById(p);
    case 'student.edit':             return studentEdit(p);
    // writing (student)
    case 'write.saveResult':         return saveResult(p);
    case 'write.getHistory':         return getHistory(p);
    case 'write.getAttempt':         return getAttempt(p);
    case 'write.heartbeat':          return heartbeat(p);
    case 'write.raiseHand':          return setRaiseHand(p);
    case 'write.getAnnotation':      return getAnnotationForStudent(p);
    case 'write.getAssignments':     return getAssignments(p);
    case 'write.getPrompt':          return getPromptForTopic(p);
    case 'write.getAttemptCount':    return getAttemptCount(p);
    case 'write.getMyResults':       return rtMergeResults(getMyResults(p), p, 'student');
    case 'write.exportDoc':          return exportFeedbackDoc(p);
    case 'write.getDraftSnapshot':   return getDraftSnapshot(p);
    case 'write.clearSnapshot':      return clearSnapshot(p);
    case 'write.backfillFeedback':   return rtLocked(function(){ return backfillFeedback(p); });
    case 'write.getSubmissions':     return getSubmissions(p);
    // chart image upload (teacher, Task 1)
    case 'assign.uploadChart':       return assignUploadChart(p);
    case 'assign.deleteChart':       return assignDeleteChart(p);
    // teacher
    case 'teacher.getLive':          return getLive(p);
    case 'teacher.clearLive':        return clearLiveSessions(p);
    case 'teacher.getResults':       return rtMergeResults(getResults(p), p, 'teacher');
    case 'teacher.getAttemptDetail': return getAttemptDetail(p);
    case 'teacher.saveManualScore':  return rtLocked(function(){ return saveManualScore(p); });
    case 'teacher.exportResults':    return exportResultsSheet(p);
    case 'teacher.saveAnnotation':   return rtLocked(function(){ return saveAnnotation(p); });
    case 'teacher.getAnnotation':    return getAnnotationForTeacher(p);
    case 'teacher.getOverview':      return getOverview(p);
    case 'teacher.createAssignment': return createAssignment(p);
    case 'teacher.updateAssignment': return updateAssignment(p);
    case 'teacher.deleteAssignment': return deleteAssignment(p);
    case 'teacher.getAlerts':        return getAlerts(p);
    // vocab
    case 'vocab.today':              return getTodaysWord(p);
    case 'admin.initVocab':          return initVocab();
    // queries
    case 'query.create':             return createQuery(p);
    case 'query.listForStudent':     return listQueriesForStudent(p);
    case 'query.listForTeacher':     return listQueriesForTeacher(p);
    case 'query.listLive':           return listLiveQueries(p);
    case 'query.answer':             return rtLocked(function(){ return answerQuery(p); });
    case 'query.share':              return rtLocked(function(){ return shareQuery(p); });
    // boards
    case 'board.create':             return boardCreate(p);
    case 'board.list':               return boardList(p);
    case 'board.get':                return boardGet(p);
    case 'board.save':               return boardSave(p);
    case 'board.delete':             return boardDelete(p);
    case 'board.uploadImage':        return boardUploadImage(p);
    // library
    case 'write.getLibrary':     return getLibrary(p);
    case 'library.add':          return libraryAdd(p);
    case 'library.delete':       return libraryDelete(p);
    case 'library.toggleLock':   return libraryToggleLock(p);
    case 'library.lockAll':      return libraryLockAll(p);
    case 'library.setAccess':    return librarySetAccess(p);
    case 'library.removeAccess': return libraryRemoveAccess(p);
    // admin / util
    case 'ping':                     return { success:true, data:'pong', time:new Date().toISOString() };
    case 'admin.resetTab':           return resetTab(p);
    case 'admin.debug':              return debugTabs(p);
    // translate practice
    case 'translate.create':         return translateCreate(p);
    case 'translate.update':         return translateUpdate(p);
    case 'translate.delete':         return translateDelete(p);
    case 'translate.list':           return translateList(p);
    case 'translate.forStudent':     return translateForStudent(p);
    case 'translate.get':            return translateGet(p);
    case 'translate.saveProgress':   return translateSaveProgress(p);
    case 'translate.saveResult':     return translateSaveResult(p);
    case 'translate.stats':          return rtMergeTranslateStats(translateStats(p), p);
    case 'translate.myProgress':     return translateMyProgress(p);
    default: return rtDispatch(action, p) || { success:false, error:'Unknown action: ' + action };
  }
}

// ── Response (JSONP-aware) ─────────────────────────────────────
function respond(e, obj) {
  var json = JSON.stringify(obj);
  var cb   = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Sheet helpers ───────────────────────────────────────────────
function ss() { return SpreadsheetApp.openById(SHEET_ID); }

function sheet(name) {
  var book = ss();
  var sh   = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    var head = HEADERS[name];
    if (head) {
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      sh.setFrozenRows(1);
      forceTextColumns(sh, head, ['Student ID','Password','Phone']);
    }
  }
  return sh;
}

function forceTextColumns(sh, head, cols) {
  cols.forEach(function(c) {
    var i = head.indexOf(c);
    if (i > -1) sh.getRange(2, i+1, sh.getMaxRows()-1, 1).setNumberFormat('@');
  });
}

function readAll(name) {
  var sh  = sheet(name);
  var rng = sh.getDataRange().getValues();
  if (rng.length < 2) return [];
  var head = rng[0];
  var rows = [];
  for (var i = 1; i < rng.length; i++) {
    var o = { _row: i + 1 };
    for (var c = 0; c < head.length; c++) o[head[c]] = rng[i][c];
    rows.push(o);
  }
  return rows;
}

/*  readFiltered — scan full sheet but apply filterFn per row and stop at limit.
    Use for targeted lookups (by ID) where row order doesn't matter.            */
function readFiltered(name, filterFn, limit) {
  var sh      = sheet(name);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = Math.max(1, sh.getLastColumn());
  var values  = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var head    = values[0];
  var rows    = [];
  for (var i = 1; i < values.length; i++) {
    var o = { _row: i + 1 };
    for (var c = 0; c < head.length; c++) o[head[c]] = values[i][c];
    if (!filterFn || filterFn(o)) {
      rows.push(o);
      if (limit && rows.length >= limit) break;
    }
  }
  return rows;
}

/*  readRecent — read N rows from the bottom up (newest-first).
    Efficient for append-only tables like results/queries.      */
function readRecent(name, limit, filterFn, scan) {
  var sh      = sheet(name);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = Math.max(1, sh.getLastColumn());
  var head    = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  scan        = scan || Math.max((limit || 50) * 4, 400);
  var start   = Math.max(2, lastRow - scan + 1);
  var numRows = lastRow - start + 1;
  var values  = sh.getRange(start, 1, numRows, lastCol).getValues();
  var rows    = [];
  for (var i = values.length - 1; i >= 0; i--) {
    var o = { _row: start + i };
    for (var c = 0; c < head.length; c++) o[head[c]] = values[i][c];
    if (!filterFn || filterFn(o)) {
      rows.push(o);
      if (limit && rows.length >= limit) break;
    }
  }
  return rows; // newest-first
}

function headerIndex(name) {
  var sh   = sheet(name);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx  = {};
  head.forEach(function(h, i) { idx[h] = i; });
  return idx;
}

function appendRowByHeader(name, obj) {
  var sh      = sheet(name);
  var lastCol = Math.max(1, sh.getLastColumn());
  var head    = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  while (head.length && head[head.length-1] === '') head.pop();

  // auto-add missing columns from HEADERS definition
  var want = HEADERS[name] || Object.keys(obj);
  want.forEach(function(h) {
    if (head.indexOf(h) === -1) { head.push(h); sh.getRange(1, head.length).setValue(h); }
  });
  Object.keys(obj).forEach(function(h) {
    if (head.indexOf(h) === -1) { head.push(h); sh.getRange(1, head.length).setValue(h); }
  });

  var row = head.map(function(h) { return obj[h] != null ? obj[h] : ''; });
  sh.appendRow(row);
  return sh.getLastRow();
}

/*  readRowsFor — rows of one student+topic without reading the whole tab.
    Reads the two key columns (a few KB even at thousands of rows), then one
    block covering only the matching rows. readAll() on a submission tab
    pulls every Essay + Feedback JSON (~7 KB/row) and was the main cost of
    saveResult / exportDoc / getAttemptDetail as the tabs grew.             */
function readRowsFor(name, studentId, topicId) {
  var sh = sheet(name), last = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (last < 2 || !lastCol) return [];
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var ks = keyRowsFor(sh, head, last, studentId, topicId);
  if (!ks.length) return [];
  var lo = ks[0], hi = ks[ks.length - 1];
  var vals = sh.getRange(lo + 2, 1, hi - lo + 1, lastCol).getValues();
  return ks.map(function(k){
    var r = vals[k - lo], o = { _row: k + 2 };
    head.forEach(function(h, i){ if (h !== '' && !(h in o)) o[h] = r[i]; });
    return o;
  });
}

// Attempt count from the two key columns only
function countRowsFor(name, studentId, topicId) {
  var sh = sheet(name), last = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (last < 2 || !lastCol) return 0;
  return keyRowsFor(sh, sh.getRange(1, 1, 1, lastCol).getValues()[0], last, studentId, topicId).length;
}

function keyRowsFor(sh, head, last, studentId, topicId) {
  var cs = head.indexOf('Student ID'), ct = head.indexOf('Topic ID');
  if (cs < 0 || ct < 0) return [];
  var n = last - 1, sid = String(studentId).trim(), tid = String(topicId).trim(), ks = [];
  var colS = sh.getRange(2, cs + 1, n, 1).getValues();
  var colT = sh.getRange(2, ct + 1, n, 1).getValues();
  for (var k = 0; k < n; k++)
    if (String(colS[k][0]).trim() === sid && String(colT[k][0]).trim() === tid) ks.push(k);
  return ks;
}

function nowIso()      { return new Date().toISOString(); }
function uid(prefix)   { return (prefix||'') + Date.now().toString(36) + Math.floor(Math.random()*1e4).toString(36); }

// ── Auth ───────────────────────────────────────────────────────
function studentSignup(p) {
  // ── 1. Required field validation ──────────────────────────────
  var missing = [];
  if (!p.studentId || !String(p.studentId).trim()) missing.push('Student ID');
  if (!p.name      || !String(p.name).trim())      missing.push('Họ và tên');
  if (!p.class     || !String(p.class).trim())      missing.push('Mã lớp');
  if (!p.email     || !String(p.email).trim())      missing.push('Email');
  if (!p.birthdate || !String(p.birthdate).trim())  missing.push('Ngày sinh');
  if (!p.phone     || !String(p.phone).trim())      missing.push('Số điện thoại');
  if (!p.password  || !String(p.password).trim())   missing.push('Mật khẩu');
  if (missing.length)
    return { success:false, error:'Vui lòng nhập đầy đủ thông tin: ' + missing.join(', ') + '.' };

  // ── 2. Validate class code ─────────────────────────────────────
  var cls = readAll(T.CLASSES).filter(function(r){
    return String(r['Class ID']) === String(p.class).trim().toUpperCase();
  })[0];
  if (!cls) return { success:false, error:'Mã lớp "' + p.class + '" không tồn tại. Kiểm tra lại với giảng viên.' };

  // ── 3. Duplicate checks ─────────────────────────────────────────
  var rows  = readAll(T.STUDENTS);
  var sid   = String(p.studentId).trim();
  var email = String(p.email).trim().toLowerCase();
  var phone = String(p.phone).trim();

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r['Student ID']).trim() === sid)
      return { success:false, error:'Student ID "' + sid + '" đã được đăng ký. Nếu là tài khoản của bạn, hãy đăng nhập hoặc liên hệ giảng viên.', field:'studentId' };
    if (email && String(r['Email']||'').trim().toLowerCase() === email)
      return { success:false, error:'Email "' + p.email + '" đã được đăng ký với một tài khoản khác.', field:'email' };
    if (phone && String(r['Phone']||'').trim() === phone)
      return { success:false, error:'Số điện thoại "' + phone + '" đã được đăng ký với một tài khoản khác.', field:'phone' };
  }

  // ── 4. Create account ──────────────────────────────────────────
  appendRowByHeader(T.STUDENTS, {
    'Student ID': sid,
    'Name':       String(p.name).trim(),
    'Class':      String(p.class).trim().toUpperCase(),
    'Birthdate':  String(p.birthdate).trim(),
    'Password':   p.password,
    'Phone':      phone,
    'Email':      email,
    'CreatedAt':  nowIso()
  });
  return { success:true, data:{ studentId:sid, name:p.name, class:p.class } };
}

function studentLogin(p) {
  var idOrEmail = String(p.studentId || p.login || '').trim();
  var pass      = String(p.password || '');
  if (!idOrEmail) return { success:false, error:'Vui lòng nhập Student ID hoặc email.' };
  var lower = idOrEmail.toLowerCase();

  // Match by Student ID (exact, trimmed) OR by email (case-insensitive)
  var rows    = readAll(T.STUDENTS);
  var matches = rows.filter(function(r){
    if (r['Archived'] === true || String(r['Archived']).toLowerCase() === 'true') return false;
    return String(r['Student ID']).trim() === idOrEmail ||
           String(r['Email'] || '').trim().toLowerCase() === lower;
  });
  if (!matches.length) return { success:false, error:'Sai Student ID/email hoặc mật khẩu.' };

  var u = matches.filter(function(r){ return samePassword(r['Password'], pass); })[0];
  if (!u) return { success:false, error:'Sai Student ID/email hoặc mật khẩu.' };

  // Guard against one email linked to multiple accounts
  if (matches.length > 1 && String(u['Student ID']).trim() !== idOrEmail) {
    var sameEmail = matches.filter(function(r){
      return String(r['Email'] || '').trim().toLowerCase() === lower;
    });
    if (sameEmail.length > 1)
      return { success:false, error:'Email này gắn với nhiều tài khoản. Hãy đăng nhập bằng Student ID.' };
  }
  return { success:true, data:{ studentId:u['Student ID'], name:u['Name'], class:u['Class'], email:u['Email'] } };
}

/*  samePassword: tolerant compare to survive Google Sheets coercion.
    Sheets may store a numeric password as a number (e.g. 123456 → 123456.0),
    so we normalise both sides before comparing.
    Cases handled:
      1. Exact string match                  "abc" === "abc"
      2. Sheets number → trimmed string      123456 stored as 123456 → "123456"
      3. Trimmed whitespace                  " abc " → "abc"
      4. Leading-zero numbers (0912345):     parseFloat would corrupt these,
         so we compare raw trimmed strings first which already handles it.    */
function samePassword(stored, given) {
  var s = String(stored).trim();
  var g = String(given).trim();
  if (s === g) return true;
  // Numeric coercion fallback: Sheets stores 123456 as the number 123456
  // parseFloat('123456') === 123456 → String both → "123456" === "123456" ✓
  // But DO NOT use parseFloat for strings starting with 0 — it would strip the zero.
  // Safe to use parseFloat only when stored value has no leading zero after trimming.
  if (!/^0\d/.test(s) && !/^0\d/.test(g)) {
    var sf = parseFloat(s), gf = parseFloat(g);
    if (!isNaN(sf) && !isNaN(gf) && String(sf) === String(gf)) return true;
  }
  return false;
}

function teacherSignup(p) {
  if (!p.email || !p.password) return { success:false, error:'Thiếu email hoặc mật khẩu.' };
  var rows = readAll(T.TEACHERS);
  if (rows.some(function(r){ return String(r['Email']).toLowerCase()===String(p.email).toLowerCase(); }))
    return { success:false, error:'Email đã tồn tại.' };
  appendRowByHeader(T.TEACHERS, {
    'Name':p.name||'', 'Class':p.class||'', 'Birthdate':p.birthdate||'',
    'Password':p.password, 'Phone':p.phone||'', 'Email':p.email, 'CreatedAt':nowIso()
  });
  return { success:true, data:{ name:p.name, email:p.email, class:p.class } };
}

function teacherLogin(p) {
  var email = String(p.email||'').trim().toLowerCase();
  var pass  = String(p.password||'');
  var u     = readAll(T.TEACHERS).filter(function(r){
    return String(r['Email']).trim().toLowerCase()===email && samePassword(r['Password'], pass);
  })[0];
  if (!u) return { success:false, error:'Sai email hoặc mật khẩu.' };
  return { success:true, data:{ name:u['Name'], email:u['Email'], class:u['Class'] } };
}

function forgotPassword(p) {
  var email = String(p.email||'').trim().toLowerCase();
  if (!email) return { success:false, error:'Nhập email đã đăng ký.' };
  var found = readAll(T.STUDENTS).filter(function(r){ return String(r['Email']).trim().toLowerCase()===email; })[0]
           || readAll(T.TEACHERS).filter(function(r){ return String(r['Email']).trim().toLowerCase()===email; })[0];
  if (!found) return { success:false, error:'Không tìm thấy tài khoản với email này.' };
  try {
    MailApp.sendEmail({
      to: email,
      subject: 'ArticuWrite — Khôi phục mật khẩu',
      body: 'Xin chào ' + (found['Name']||'') + ',\n\n' +
            'Mật khẩu tài khoản ArticuWrite của bạn là: ' + found['Password'] + '\n\n' +
            (found['Student ID'] ? 'Student ID: ' + found['Student ID'] + '\n' : '') +
            '\nVui lòng đăng nhập và đổi mật khẩu nếu cần.\n\n— ArticuWrite'
    });
    return { success:true, data:{ sent:true } };
  } catch (err) {
    return { success:false, error:'Không gửi được email: ' + err.message };
  }
}

function changePassword(p) {
  if (!p.oldPass || !p.newPass) return { success:false, error:'Thiếu mật khẩu.' };
  if (p.studentId) {
    var sh = sheet(T.STUDENTS), idx = headerIndex(T.STUDENTS), data = sh.getDataRange().getValues();
    for (var i=1;i<data.length;i++){
      if (String(data[i][idx['Student ID']]).trim()===String(p.studentId).trim() && samePassword(data[i][idx['Password']], p.oldPass)){
        sh.getRange(i+1, idx['Password']+1).setValue(p.newPass).setNumberFormat('@');
        return { success:true };
      }
    }
    return { success:false, error:'Sai mật khẩu hiện tại.' };
  } else if (p.email) {
    var sh2 = sheet(T.TEACHERS), idx2 = headerIndex(T.TEACHERS), data2 = sh2.getDataRange().getValues();
    for (var j=1;j<data2.length;j++){
      if (String(data2[j][idx2['Email']]).toLowerCase()===String(p.email).toLowerCase() && samePassword(data2[j][idx2['Password']], p.oldPass)){
        sh2.getRange(j+1, idx2['Password']+1).setValue(p.newPass);
        return { success:true };
      }
    }
    return { success:false, error:'Sai mật khẩu hiện tại.' };
  }
  return { success:false, error:'Thiếu studentId hoặc email.' };
}

// ── Classes ────────────────────────────────────────────────────
function genClassId() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return 'AW-' + s;
}

function classCreate(p) {
  if (!p.className) return { success:false, error:'Thiếu tên lớp.' };
  var id;
  var existing = readAll(T.CLASSES);
  do { id = genClassId(); } while (existing.some(function(r){ return r['Class ID']===id; }));
  appendRowByHeader(T.CLASSES, {
    'Class ID':id, 'Class Name':p.className, 'Academic Year':p.year||'',
    'Semester':p.semester||'', 'Teacher Email':p.teacherEmail||'', 'CreatedAt':nowIso()
  });
  return { success:true, data:{ classId:id, className:p.className, year:p.year, semester:p.semester } };
}

function classList(p) {
  var rows = readAll(T.CLASSES).filter(function(r){
    if (r['Archived']===true || String(r['Archived']).toLowerCase()==='true') return false;
    return !p.teacherEmail || String(r['Teacher Email']).toLowerCase()===String(p.teacherEmail).toLowerCase();
  });
  return { success:true, data: rows.map(function(r){
    var aiEnabled = r['AI Enabled'] === false || String(r['AI Enabled']).toLowerCase() === 'false' ? false : true;
    return { classId:r['Class ID'], className:r['Class Name'], year:r['Academic Year'],
             semester:r['Semester'], teacherEmail:r['Teacher Email'], aiEnabled:aiEnabled };
  }) };
}

function classGet(p) {
  var c = readAll(T.CLASSES).filter(function(r){ return String(r['Class ID'])===String(p.classId); })[0];
  if (!c) return { success:false, error:'Mã lớp không tồn tại.' };
  // aiEnabled: default TRUE for existing classes that predate the column
  var aiEnabled = c['AI Enabled'] === false || String(c['AI Enabled']).toLowerCase() === 'false' ? false : true;
  return { success:true, data:{ classId:c['Class ID'], className:c['Class Name'],
           year:c['Academic Year'], semester:c['Semester'], aiEnabled:aiEnabled } };
}

/*  class.setAiEnabled — toggle AI on/off per class for experimental/control design.
    Auto-creates the 'AI Enabled' column if the Classes sheet doesn't have it yet.  */
function classSetAiEnabled(p) {
  if (!p.classId) return { success:false, error:'Missing classId.' };
  var sh  = sheet(T.CLASSES);
  var idx = headerIndex(T.CLASSES);
  // Auto-add column if first time
  if (idx['AI Enabled'] == null) {
    sh.getRange(1, sh.getLastColumn() + 1).setValue('AI Enabled');
    idx = headerIndex(T.CLASSES); // refresh after adding column
  }
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idx['Class ID']]) === String(p.classId)) {
      // Store 'false' as string to match how other flags are stored (Archived='true')
      sh.getRange(i + 1, idx['AI Enabled'] + 1).setValue(p.enabled === false ? 'false' : 'true');
      return { success:true, data:{ classId:p.classId, aiEnabled: p.enabled !== false } };
    }
  }
  return { success:false, error:'Class not found.' };
}

function getRoster(p) {
  var rows = readAll(T.STUDENTS).filter(function(r){
    if (r['Archived']===true || String(r['Archived']).toLowerCase()==='true') return false;
    return !p.class || String(r['Class'])===String(p.class);
  });
  return { success:true, data: rows.map(function(r){
    return { studentId:r['Student ID'], name:r['Name'], email:r['Email'], phone:r['Phone'] };
  }) };
}

function archiveClass(p) {
  if (!p.classId) return { success:false, error:'Missing classId.' };
  var sh = sheet(T.CLASSES), idx = headerIndex(T.CLASSES);
  if (idx['Archived']==null) { sh.getRange(1,sh.getLastColumn()+1).setValue('Archived'); idx=headerIndex(T.CLASSES); }
  var data = sh.getDataRange().getValues();
  for (var i=1;i<data.length;i++){
    if (String(data[i][idx['Class ID']])===String(p.classId)) {
      sh.getRange(i+1, idx['Archived']+1).setValue(p.archived===false?'':'true');
      return { success:true };
    }
  }
  return { success:false, error:'Class not found.' };
}

function archiveStudent(p) {
  if (!p.studentId) return { success:false, error:'Missing studentId.' };
  var sh = sheet(T.STUDENTS), idx = headerIndex(T.STUDENTS);
  if (idx['Archived']==null) { sh.getRange(1,sh.getLastColumn()+1).setValue('Archived'); idx=headerIndex(T.STUDENTS); }
  var data = sh.getDataRange().getValues();
  for (var i=1;i<data.length;i++){
    if (String(data[i][idx['Student ID']])===String(p.studentId)) {
      sh.getRange(i+1, idx['Archived']+1).setValue(p.archived===false?'':'true');
      return { success:true };
    }
  }
  return { success:false, error:'Student not found.' };
}

function studentGetById(p) {
  if (!p.studentId) return { success:false, error:'Missing studentId.' };
  var u = readAll(T.STUDENTS).filter(function(r){
    return String(r['Student ID']).trim()===String(p.studentId).trim();
  })[0];
  if (!u) return { success:false, error:'Sinh viên không tồn tại.' };
  return { success:true, data:{ studentId:u['Student ID'], name:u['Name']||'', class:u['Class']||'',
    birthdate:u['Birthdate']||'', phone:u['Phone']||'', email:u['Email']||'' }};
}

function studentEdit(p) {
  if (!p.studentId) return { success:false, error:'Missing studentId.' };
  var newId = (p.newStudentId||'').trim();
  var sh = sheet(T.STUDENTS), idx = headerIndex(T.STUDENTS);
  var data = sh.getDataRange().getValues();
  if (newId && newId !== String(p.studentId).trim()) {
    for (var j=1;j<data.length;j++){
      if (String(data[j][idx['Student ID']]).trim()===newId)
        return { success:false, error:'Student ID "'+newId+'" đã tồn tại trong hệ thống.' };
    }
  }
  for (var i=1;i<data.length;i++){
    if (String(data[i][idx['Student ID']]).trim()===String(p.studentId).trim()){
      var fields={'Name':p.name,'Class':p.class,'Birthdate':p.birthdate,'Phone':p.phone};
      Object.keys(fields).forEach(function(col){
        if (fields[col]==null||fields[col]===undefined||fields[col]==='') return;
        if (idx[col]==null) return;
        sh.getRange(i+1,idx[col]+1).setValue(fields[col]);
      });
      if (newId && newId !== String(p.studentId).trim())
        sh.getRange(i+1,idx['Student ID']+1).setValue(newId);
      return { success:true };
    }
  }
  return { success:false, error:'Sinh viên không tồn tại.' };
}

// ── Assignments ────────────────────────────────────────────────
/*
  Task Type values:
    'task2'  — IELTS Writing Task 2 (essay/opinion) — default
    'task1'  — IELTS Writing Task 1 (data/chart/diagram)

  Chart Image ID: Drive file ID stored when teacher uploads a chart image.
  The frontend fetches the public URL as:
    https://drive.google.com/uc?export=view&id=<chartImageId>
*/
function createAssignment(p) {
  var topicId   = p.topicId || uid('A');
  var taskType  = (p.taskType === 'task1') ? 'task1' : 'task2';
  appendRowByHeader(T.ASSIGN, {
    'Topic ID':         topicId,
    'Mode':             p.mode        || 'homework',
    'Class':            p.class       || '',
    'Topic':            p.topic       || '',
    'Prompt':           p.prompt      || '',
    'Task Type':        taskType,
    'Chart Image ID':   p.chartImageId || '',
    'Min Words':        p.minWords     || 0,
    'Writing Type':     p.writingType  || 'full_essay',
    'AI Notes':         p.aiNotes     || '',
    'Required Attempts':p.requiredAttempts || 1,
    'Duration Min':     p.durationMin || '',
    'Deadline':         p.deadline    || '',
    'CreatedAt':        nowIso(),
    'Active':           true
  });
  return { success:true, data:{ topicId:topicId, taskType:taskType } };
}

function updateAssignment(p) {
  if (!p.topicId) return { success:false, error:'Missing topicId.' };
  var sh = sheet(T.ASSIGN), idx = headerIndex(T.ASSIGN);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idx['Topic ID']]) === String(p.topicId)) {
      if (p.topic    != null && idx['Topic']    != null) sh.getRange(i+1, idx['Topic']+1).setValue(p.topic);
      if (p.prompt   != null && idx['Prompt']   != null) sh.getRange(i+1, idx['Prompt']+1).setValue(p.prompt);
      if (p.deadline != null && idx['Deadline'] != null) sh.getRange(i+1, idx['Deadline']+1).setValue(p.deadline);
      if (p.aiNotes  != null && idx['AI Notes'] != null) sh.getRange(i+1, idx['AI Notes']+1).setValue(p.aiNotes);
      if (p.minWords != null && idx['Min Words']!= null) sh.getRange(i+1, idx['Min Words']+1).setValue(p.minWords);
      if (p.requiredAttempts != null && idx['Required Attempts'] != null)
        sh.getRange(i+1, idx['Required Attempts']+1).setValue(p.requiredAttempts);
      return { success:true };
    }
  }
  return { success:false, error:'Assignment not found.' };
}

function deleteAssignment(p) {
  if (!p.topicId) return { success:false, error:'Missing topicId.' };
  var sh = sheet(T.ASSIGN), idx = headerIndex(T.ASSIGN);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idx['Topic ID']]) === String(p.topicId)) {
      // Soft-delete: set Active = false (preserves submissions that reference this topicId)
      sh.getRange(i+1, idx['Active']+1).setValue(false);
      return { success:true };
    }
  }
  return { success:false, error:'Assignment not found.' };
}

function getAssignments(p) {
  var rows = readAll(T.ASSIGN).filter(function(r){
    if (r['Active']===false || String(r['Active']).toLowerCase()==='false') return false;
    if (p.class && String(r['Class'])!==String(p.class)) return false;
    if (p.mode  && String(r['Mode']) !==String(p.mode))  return false;
    // optional taskType filter (e.g. show only task1 or task2)
    if (p.taskType && String(r['Task Type']||'task2')!==String(p.taskType)) return false;
    return true;
  });
  return { success:true, data: rows.map(function(r){
    return {
      topicId:          r['Topic ID'],
      mode:             r['Mode'],
      class:            r['Class'],
      topic:            r['Topic'],
      prompt:           r['Prompt'],
      taskType:         r['Task Type'] || 'task2',
      chartImageId:     r['Chart Image ID'] || '',
      aiNotes:          r['AI Notes']   || '',
      requiredAttempts: r['Required Attempts'],
      durationMin:      r['Duration Min'],
      deadline:         r['Deadline']
    };
  }) };
}

/*  getPromptForTopic — called by write.html on load to fetch the
    official prompt + task type + chart image for an assignment.
    Returns taskType and chartImageId so the frontend can render
    the chart image viewer when taskType === 'task1'.             */
function getPromptForTopic(p) {
  if (!p.topicId) return { success:false, error:'Missing topicId.' };
  var a = readAll(T.ASSIGN).filter(function(r){ return String(r['Topic ID'])===String(p.topicId); })[0];
  if (!a) return { success:true, data:{ prompt:'', topic:'', taskType:'task2', chartImageId:'' } };
  return { success:true, data:{
    prompt:       a['Prompt']        || '',
    topic:        a['Topic']         || '',
    taskType:     a['Task Type']     || 'task2',
    chartImageId: a['Chart Image ID']|| '',
    minWords:     a['Min Words']     || 0,
    writingType:  a['Writing Type']  || 'full_essay',
    aiNotes:      a['AI Notes']      || '',
    durationMin:  a['Duration Min']  || ''
  } };
}

// ── Chart image upload / delete (Task 1) ──────────────────────
/*  Teacher pastes or drops a chart image in the assignment modal.
    The frontend converts it to base64 and calls assign.uploadChart.
    The file is stored in a dedicated Drive folder and shared
    publicly (view-only) so students can load it in write.html.

    On delete: called when teacher removes the chart or replaces it
    with a new one (so Drive doesn't fill up with orphaned images).  */
function assignUploadChart(p) {
  if (!p.dataUrl) return { success:false, error:'Thiếu dữ liệu ảnh.' };
  try {
    var parts = p.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!parts) return { success:false, error:'Định dạng ảnh không hợp lệ (cần data URL).' };
    var mimeType = parts[1];
    var blob     = Utilities.newBlob(Utilities.base64Decode(parts[2]), mimeType,
                     p.name || ('chart-' + Date.now() + '.png'));
    var folder   = getChartFolder();
    var file     = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var fileId   = file.getId();
    var viewUrl  = 'https://drive.google.com/uc?export=view&id=' + fileId;
    return { success:true, data:{ fileId:fileId, url:viewUrl } };
  } catch (err) {
    return { success:false, error:'Upload lỗi: ' + err.message };
  }
}

/*  assignDeleteChart: remove old chart image from Drive to avoid orphans.
    Call before replacing a chart image (pass the old fileId).             */
function assignDeleteChart(p) {
  if (!p.fileId) return { success:false, error:'Missing fileId.' };
  try {
    var file = DriveApp.getFileById(p.fileId);
    file.setTrashed(true);
    return { success:true };
  } catch (err) {
    // non-fatal: log and continue (file may already be gone)
    return { success:true, data:{ warning:'Could not trash file: ' + err.message } };
  }
}

/*  Also update Chart Image ID on an existing assignment row
    (called after upload completes, before creating the assignment record).
    In practice, the frontend uploads first → gets fileId → then calls
    teacher.createAssignment with chartImageId included, so this is only
    needed if teacher replaces a chart after the assignment was created.   */
function updateAssignmentChart(p) {
  if (!p.topicId) return { success:false, error:'Missing topicId.' };
  var sh = sheet(T.ASSIGN), idx = headerIndex(T.ASSIGN);
  if (idx['Chart Image ID']==null) {
    sh.getRange(1,sh.getLastColumn()+1).setValue('Chart Image ID');
    idx = headerIndex(T.ASSIGN);
  }
  var data = sh.getDataRange().getValues();
  for (var i=1;i<data.length;i++){
    if (String(data[i][idx['Topic ID']])===String(p.topicId)) {
      sh.getRange(i+1, idx['Chart Image ID']+1).setValue(p.chartImageId||'');
      return { success:true };
    }
  }
  return { success:false, error:'Assignment not found.' };
}

function getChartFolder() {
  var name = 'ArticuWrite Chart Images';
  var it   = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

// ── Save result ────────────────────────────────────────────────
function saveResult(p) {
  var tabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
  var tab    = tabMap[p.mode];
  if (!tab) return { success:false, error:'Mode không hợp lệ: ' + p.mode };

  // Deadline check needs no lock — keep the locked section as short as possible
  if (p.mode !== 'free' && p.topicId) {
    var asg = readAll(T.ASSIGN).filter(function(r){ return String(r['Topic ID'])===String(p.topicId); })[0];
    if (asg && asg['Deadline']) {
      var dl = new Date(asg['Deadline']);
      if (!isNaN(dl) && new Date() > new Date(dl.getTime()+86400000))
        return { success:false, error:'Đã quá hạn nộp bài (deadline: '+asg['Deadline']+').', locked:true };
    }
  }

  var taskType = p.taskType || 'task2';
  var row = {
    'Timestamp':       nowIso(),
    'Student ID':      p.studentId,
    'Name':            p.name      || '',
    'Class':           p.class     || '',
    'Topic':           p.topic     || '',
    'Topic ID':        p.topicId   || '',
    'Task Type':       taskType,           // ← stored so results tab shows T1/T2
    'Start time':      p.startTime || '',
    'Finish time':     p.finishTime|| '',
    'Duration':        p.duration  || '',
    'TR':  p.tr  != null ? p.tr  : '',
    'CC':  p.cc  != null ? p.cc  : '',
    'LR':  p.lr  != null ? p.lr  : '',
    'GRA': p.gra != null ? p.gra : '',
    'AI Grading':      p.aiGrading      != null ? p.aiGrading      : '',
    'Teacher Grading': p.teacherGrading != null ? p.teacherGrading : '',
    'Attempt':         0,
    'Essay':           p.essay    || '',
    'Feedback':        p.feedback || ''
  };
  if (tab === T.HOMEWORK || tab === T.INCLASS) row['Google Doc Link'] = p.docLink || '';

  // LockService: attempt number = rows already stored + 1, so count and append
  // must not interleave between students. Only the two key columns are read
  // inside the lock (not the whole tab), so it is held for well under a second
  // and 60 students submitting together queue for seconds, not minutes.
  var lock = LockService.getScriptLock();
  var lockAcquired = false;
  try { lockAcquired = lock.tryLock(25000); } catch(e) {}
  if (!lockAcquired) return { success:false, error:'Server đang bận. Vui lòng thử lại sau 5 giây.', retry:true };
  var attempt;
  try {
    var prior = countRowsFor(tab, p.studentId, p.topicId);
    if (p.mode !== 'free' && prior >= 3)
      return { success:false, error:'Bạn đã viết đủ 3 lần cho bài này.', locked:true, attempt:prior };
    attempt = prior + 1;
    row['Attempt'] = attempt;
    appendRowByHeader(tab, row);
  } finally { try { lock.releaseLock(); } catch(e) {} }

  appendRowByHeader(T.HISTORY, {
    'Timestamp':    nowIso(),
    'Student ID':   p.studentId,
    'Name':         p.name  || '',
    'Practice Mode':p.mode,
    'Topic':        p.topic || '',
    'Topic ID':     p.topicId || '',
    'Task Type':    taskType
  });
  clearLive(p.studentId);
  // Free writing: the 3rd attempt triggers the result mail (Retention.gs) within ~1 min
  var freeDone = p.mode === 'free' && attempt === RT.FREE_ATTEMPTS;
  if (freeDone) rtScheduleKick(1);
  return { success:true, data:{ attempt:attempt, topicId:p.topicId, freeComplete:freeDone, freeKeepDays:RT.FREE_DAYS } };
}

// ── History / Re-try ───────────────────────────────────────────
function getHistory(p) {
  var rows = readAll(T.HISTORY).filter(function(r){
    return String(r['Student ID'])===String(p.studentId);
  });
  var seen = {};
  rows.reverse().forEach(function(r){ if (!seen[r['Topic ID']]) seen[r['Topic ID']] = r; });
  return { success:true, data: Object.keys(seen).map(function(k){
    return { topicId:k, topic:seen[k]['Topic'], mode:seen[k]['Practice Mode'],
             taskType:seen[k]['Task Type']||'task2', timestamp:seen[k]['Timestamp'] };
  }) };
}

function getAttempt(p) {
  var tabs = [T.FREE, T.HOMEWORK, T.INCLASS];
  var found = null;
  tabs.forEach(function(tab){
    readAll(tab).forEach(function(r){
      if (String(r['Student ID'])===String(p.studentId) && String(r['Topic ID'])===String(p.topicId)){
        if (!found || new Date(r['Timestamp']) > new Date(found['Timestamp'])) found = r;
      }
    });
  });
  if (!found) return { success:false, error:'Không tìm thấy bài cũ.' };
  return { success:true, data:{
    topic:found['Topic'], topicId:found['Topic ID'],
    taskType:found['Task Type']||'task2',
    essay:found['Essay'], aiGrading:found['AI Grading'], teacherGrading:found['Teacher Grading']
  }};
}

function getAttemptCount(p) {
  var tabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
  var tab    = tabMap[p.mode];
  if (!tab) return { success:true, data:{ count:0 } };
  return { success:true, data:{ count:countRowsFor(tab, p.studentId, p.topicId) } };
}

// ── Live observation (CacheService) ────────────────────────────
/*  Why not the LiveSessions sheet any more: every heartbeat read the whole
    tab (8 KB snapshots included) and wrote ~12 cells one call at a time.
    60 students × one ping per 10 s = 6 full-tab read/writes per second on
    one sheet, which Sheets serialises — requests queue, then time out.
    The script cache is in memory: a heartbeat is one getAll + one putAll
    (~10–30 ms), no sheet access, no lock. Live state is ephemeral anyway;
    the 6-hour TTL (CacheService maximum) covers a class session. The
    student's localStorage draft remains the primary draft copy.

    Keys
      lv:<sid>   { sid,name,cls,tid,topic,mode,status,wc,snap,orig,t }
      lvh:<sid>  { t, where }  raised hand — its own key so a heartbeat
                 arriving at the same moment can never overwrite it
      lvi:<cls>  [sid…] students seen heartbeating in this class
      lvr:<cls>  [sid…] class roster from Students (5-min cache)        */
var LIVE_TTL    = 21600;                 // seconds — CacheService maximum
var LIVE_WINDOW = 8 * 60 * 60 * 1000;    // same 8-hour session window as before

function liveCache() { return CacheService.getScriptCache(); }
function liveParse(v) { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } }

function heartbeat(p) {
  if (!p.studentId) return { success:false, error:'Thiếu studentId.' };
  var sid = String(p.studentId).trim(), cls = String(p.class || '').trim();
  var c = liveCache(), keys = ['lv:' + sid];
  if (cls) keys.push('lvi:' + cls);
  var got  = c.getAll(keys);
  var prev = liveParse(got['lv:' + sid]);
  var tid  = String(p.topicId || ''), snap = String(p.snapshot || '').slice(0, 8000);
  var o = {
    sid:sid, name:p.name || (prev && prev.name) || '', cls:cls || (prev && prev.cls) || '',
    tid:tid, topic:p.topic || '', mode:p.mode || '', status:p.status || 'Writing',
    wc:p.wordCount || 0, snap:snap,
    // Original Essay = first snapshot of this topic, never overwritten while on it
    orig:(prev && prev.tid === tid) ? prev.orig : snap,
    t:Date.now()
  };
  var puts = {};
  puts['lv:' + sid] = JSON.stringify(o);
  puts['lvlast'] = String(o.t);          // "someone is writing" stamp for Retention.gs
  if (cls) {
    var idx = liveParse(got['lvi:' + cls]) || [];
    if (idx.indexOf(sid) === -1) { idx.push(sid); puts['lvi:' + cls] = JSON.stringify(idx); }
  }
  c.putAll(puts, LIVE_TTL);
  if (p.raiseHand != null) liveSetHand(sid, !!p.raiseHand, p.topic);
  return { success:true };
}

function liveSetHand(sid, raised, where) {
  if (raised) liveCache().put('lvh:' + sid, JSON.stringify({ t:Date.now(), where:where || '' }), LIVE_TTL);
  else liveCache().remove('lvh:' + sid);
}

// Roster ∪ index: the index alone can miss a student when many first pings
// race at the start of class; the roster alone misses a student whose
// session still carries an old class code.
function liveSids(cls) {
  var c = liveCache(), key = 'lvr:' + (cls || '*');
  var got = c.getAll([key, 'lvi:' + cls]);
  var roster = liveParse(got[key]);
  if (!roster) {
    roster = readAll(T.STUDENTS).filter(function(r){
      if (r['Archived'] === true || String(r['Archived']).toLowerCase() === 'true') return false;
      return !cls || String(r['Class']).trim() === cls;
    }).map(function(r){ return String(r['Student ID']).trim(); });
    c.put(key, JSON.stringify(roster), 300);
  }
  var seen = {}, out = [];
  roster.concat(liveParse(got['lvi:' + cls]) || []).forEach(function(s){ if (s && !seen[s]) { seen[s] = 1; out.push(s); } });
  return out;
}

// [{ o: live state, hand: raised-hand record | null }] for one class
function liveEntries(cls) {
  cls = String(cls || '').trim();
  var sids = liveSids(cls), keys = [];
  sids.forEach(function(s){ keys.push('lv:' + s, 'lvh:' + s); });
  var got = keys.length ? liveCache().getAll(keys) : {}, now = Date.now(), out = [];
  sids.forEach(function(s){
    var o = liveParse(got['lv:' + s]);
    if (!o || (cls && o.cls !== cls) || now - o.t > LIVE_WINDOW) return;
    out.push({ o:o, hand:liveParse(got['lvh:' + s]) });
  });
  return out;
}

function clearLive(studentId) {
  var sid = String(studentId).trim(), c = liveCache();
  var o = liveParse(c.get('lv:' + sid));
  if (!o) return;
  o.status = 'Submitted'; o.t = Date.now();
  c.put('lv:' + sid, JSON.stringify(o), LIVE_TTL);
}

function getLive(p) {
  var now = Date.now();
  var out = liveEntries(p.class).map(function(e){
    var o = e.o, status = o.status;
    if (status !== 'Submitted' && now - o.t > LIVE_STALE_MS) status = 'Offline';
    return {
      studentId:o.sid, name:o.name, class:o.cls, topicId:o.tid, topic:o.topic, mode:o.mode,
      status:status, wordCount:o.wc, snapshot:o.snap, raisedHand:!!e.hand,
      originalEssay:o.orig || '', updated:new Date(o.t).toISOString()
    };
  });
  return { success:true, data:out };
}

/*  clearLiveSessions: teacher's manual "clear" for one class (or all).
    The old LiveSessions sheet is no longer written; it can be deleted.  */
function clearLiveSessions(p) {
  var cls = String(p.class || '').trim(), keys = [];
  liveSids(cls).forEach(function(s){ keys.push('lv:' + s, 'lvh:' + s); });
  if (cls) keys.push('lvi:' + cls);
  if (keys.length) liveCache().removeAll(keys);
  return { success:true, data:{ cleared:true } };
}

function setRaiseHand(p) {
  if (!p.studentId) return { success:false, error:'Missing studentId.' };
  var sid = String(p.studentId).trim();
  liveSetHand(sid, !!p.raised, p.topic || p.where);
  // a hand raised from outside write.html still needs a card in Live view
  if (p.raised && !liveCache().get('lv:' + sid)) {
    heartbeat({ studentId:sid, name:p.name, class:p.class, topic:p.topic || p.where || '',
                mode:p.mode || '', status:'Idle', wordCount:0, snapshot:'' });
  }
  return { success:true };
}

/*  getDraftSnapshot: server-side draft backup (switched device / cleared
    cache / incognito). Valid while the live entry exists (≤ 6 h).       */
function getDraftSnapshot(p) {
  if (!p.studentId || !p.topicId) return { success:false, error:'Missing params.' };
  var o = liveParse(liveCache().get('lv:' + String(p.studentId).trim()));
  if (!o || o.tid !== String(p.topicId) || !o.snap || o.status === 'Submitted') return { success:true, data:null };
  return { success:true, data:{ snapshot:o.snap, wordCount:o.wc || 0 } };
}

// write.html calls this after a submitted attempt so a stale draft is never restored
function clearSnapshot(p) {
  if (!p.studentId) return { success:false, error:'Missing studentId.' };
  var sid = String(p.studentId).trim(), c = liveCache();
  var o = liveParse(c.get('lv:' + sid));
  if (o && (!p.topicId || o.tid === String(p.topicId))) { o.snap = ''; c.put('lv:' + sid, JSON.stringify(o), LIVE_TTL); }
  return { success:true };
}


// ── Annotation / scoring ───────────────────────────────────────
/*  getAnnotationForTeacher: full annotation data for teacher's annotation modal.
    Returns annotatedHtml, suggestions, scores, and timestamp.
    Unlike getAnnotationForStudent which only returns annotatedHtml for display.  */
function getAnnotationForTeacher(p) {
  if (!p.studentId) return { success:false, error:'Missing studentId.' };
  var rows = readAll(T.ANNOT).filter(function(r){
    if (String(r['Student ID'])!==String(p.studentId)) return false;
    if (p.topicId && String(r['Topic ID'])!==String(p.topicId)) return false;
    return true;
  });
  if (!rows.length) return { success:true, data:null };
  // Return ALL pushes sorted newest-first so teacher sees full history
  rows.sort(function(a,b){ return new Date(b['Timestamp'])-new Date(a['Timestamp']); });
  var history = rows.map(function(r, i){
    var suggestions = [];
    try { if (r['Suggestions']) suggestions = JSON.parse(r['Suggestions']); } catch(e){}
    return {
      index:        rows.length - i,   // push #1, #2, #3...
      timestamp:    r['Timestamp'],
      teacher:      r['Teacher']||'',
      annotatedHtml:r['Annotated HTML']||'',
      suggestions:  suggestions,
      tr: r['TR']||'', cc:r['CC']||'',
      lr: r['LR']||'', gra:r['GRA']||'',
      note:r['Note']||''
    };
  });
  // Latest scores (for pre-filling scoring inputs)
  var latest = history[0];
  return { success:true, data:{
    history:      history,            // all pushes, newest first
    pushCount:    history.length,
    latestAt:     latest.timestamp,
    tr:  latest.tr,  cc:  latest.cc,
    lr:  latest.lr,  gra: latest.gra
  }};
}

function getAnnotationForStudent(p) {
  if (!p.studentId) return { success:false, error:'Missing studentId.' };
  var rows = readAll(T.ANNOT).filter(function(r){
    if (String(r['Student ID'])!==String(p.studentId)) return false;
    if (p.topicId && String(r['Topic ID'])!==String(p.topicId)) return false;
    return String(r['Annotated HTML']||'').trim() !== '';
  });
  if (!rows.length) return { success:true, data:null };
  rows.sort(function(a,b){ return new Date(b['Timestamp'])-new Date(a['Timestamp']); });
  var r = rows[0];
  return { success:true, data:{ timestamp:r['Timestamp'], teacher:r['Teacher']||'', annotatedHtml:r['Annotated HTML']||'' } };
}

function saveAnnotation(p) {
  appendRowByHeader(T.ANNOT, {
    'Timestamp':nowIso(), 'Student ID':p.studentId, 'Topic ID':p.topicId,
    'Mode':p.mode||'', 'Teacher':p.teacher||'',
    'Suggestions':p.suggestions ? JSON.stringify(p.suggestions) : '',
    'Annotated HTML':(p.annotatedHtml||'').slice(0,45000),
    'TR':p.tr!=null?p.tr:'', 'CC':p.cc!=null?p.cc:'',
    'LR':p.lr!=null?p.lr:'', 'GRA':p.gra!=null?p.gra:'', 'Note':p.note||''
  });
  if (p.teacherGrading != null && p.mode) {
    var tabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
    var tab    = tabMap[p.mode];
    if (tab) {
      var sh   = sheet(tab), idx = headerIndex(tab), data = sh.getDataRange().getValues();
      var targetRow = -1;
      for (var i=1;i<data.length;i++){
        if (String(data[i][idx['Student ID']])===String(p.studentId) &&
            String(data[i][idx['Topic ID']])===String(p.topicId)) targetRow = i+1;
      }
      if (targetRow > -1) sh.getRange(targetRow, idx['Teacher Grading']+1).setValue(p.teacherGrading);
    }
  }
  return { success:true };
}

function saveManualScore(p) {
  var tabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
  var tab    = tabMap[p.mode];
  if (!tab) return { success:false, error:'Invalid mode.' };
  var sh   = sheet(tab), idx = headerIndex(tab), data = sh.getDataRange().getValues();
  var scoreJson = JSON.stringify({
    tr:p.tr||'', cc:p.cc||'', lr:p.lr||'', gra:p.gra||'',
    overall:p.overall||'', note:p.note||'', privateNote:p.privateNote||'', gradedAt:nowIso()
  });
  var targetRow = -1, latestTime = 0;
  for (var i=1;i<data.length;i++){
    if (String(data[i][idx['Student ID']])===String(p.studentId) &&
        String(data[i][idx['Topic ID']])===String(p.topicId)){
      var t = new Date(data[i][idx['Timestamp']]).getTime();
      if (t >= latestTime) { latestTime = t; targetRow = i; }
    }
  }
  if (targetRow < 0) return { success:false, error:'Submission not found.' };
  if (idx['Teacher Score']==null) {
    var col = sh.getLastColumn()+1;
    sh.getRange(1,col).setValue('Teacher Score');
    sh.getRange(targetRow+1,col).setValue(scoreJson);
  } else {
    sh.getRange(targetRow+1, idx['Teacher Score']+1).setValue(scoreJson);
  }
  if (idx['Teacher Grading']!=null && p.overall)
    sh.getRange(targetRow+1, idx['Teacher Grading']+1).setValue(p.overall);
  return { success:true };
}

// ── Results (teacher) ─────────────────────────────────────────
function getResults(p) {
  var tabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
  var tab    = tabMap[p.mode] || T.FREE;
  var allRows = readAll(tab);
  var classNames = {};
  readAll(T.CLASSES).forEach(function(c){ classNames[c['Class ID']] = c['Class Name']; });
  var prompts = {};
  readAll(T.ASSIGN).forEach(function(a){ prompts[a['Topic ID']] = { prompt:a['Prompt'], taskType:a['Task Type']||'task2', minWords:parseInt(a['Min Words']||'0',10)||0 }; });

  // Build student→currentClass map as fallback for submissions with wrong/empty Class
  var studentClassMap = {};
  readAll(T.STUDENTS).forEach(function(s){
    var sid = String(s['Student ID']||'').trim();
    if (sid) studentClassMap[sid] = String(s['Class']||'').trim();
  });

  var groups = {};
  allRows.forEach(function(r){
    var rClass     = String(r['Class']      ||'').trim();
    var rStudentId = String(r['Student ID'] ||'').trim();
    var rTopicId   = String(r['Topic ID']   ||'').trim();
    if (!rStudentId || !rTopicId) return;

    // ── CLASS FILTER — accept if submission class OR student's current class matches ──
    if (p.class) {
      var pClass = String(p.class).trim();
      var currentClass = studentClassMap[rStudentId] || '';
      if (rClass !== pClass && currentClass !== pClass) return;
    }
    // ── TOPIC FILTER ──
    if (p.topicId && rTopicId !== String(p.topicId).trim()) return;
    // ── DATE RANGE FILTER ──
    if (p.days && parseInt(p.days,10) > 0) {
      var ts = r['Timestamp'] ? new Date(r['Timestamp']).getTime() : 0;
      var cutoff = Date.now() - parseInt(p.days,10) * 24 * 60 * 60 * 1000;
      if (ts < cutoff) return;
    }

    var key = (r['Student ID']||'') + '||' + (r['Topic ID']||'');
    if (!groups[key]) groups[key] = {
      studentId:r['Student ID'], name:r['Name'],
      class:r['Class']||'', className:classNames[r['Class']] || r['Class'] || '',
      topic:r['Topic'], topicId:r['Topic ID'],
      taskType: r['Task Type'] || (prompts[r['Topic ID']] && prompts[r['Topic ID']].taskType) || 'task2',
      prompt: (prompts[r['Topic ID']] && prompts[r['Topic ID']].prompt) || '',
      minWords: (prompts[r['Topic ID']] && prompts[r['Topic ID']].minWords) || 0,
      writes:[], teacherScore:null
    };
    if (r['Teacher Score']) {
      try { groups[key].teacherScore = JSON.parse(r['Teacher Score']); } catch(e){}
    }
    // ── Strip essay/feedback from list response (heavy, only needed on detail view) ──
    // essay and feedback JSON can be 3-5KB each; with 40 students × 3 attempts = ~360-600KB
    // Teacher results table only needs scores + timestamps, not full text.
    // Use teacher.getAttemptDetail(studentId, topicId, mode) to fetch full text on demand.
    groups[key].writes.push({
      timestamp:r['Timestamp'], startTime:r['Start time'], finishTime:r['Finish time'],
      duration:r['Duration'], overall:r['AI Grading'], teacher:r['Teacher Grading'],
      tr:r['TR']||'', cc:r['CC']||'', lr:r['LR']||'', gra:r['GRA']||'',
      // essay and feedback intentionally omitted here — fetch via getAttemptDetail
      hasAiFeedback: !!(r['Feedback'] && String(r['Feedback']).length > 10)
    });
  });

  var out = Object.keys(groups).map(function(k){
    var g = groups[k];
    g.writes.sort(function(a,b){ return new Date(a.timestamp)-new Date(b.timestamp); });
    var best = null;
    g.writes.forEach(function(w){
      var v = parseFloat(w.overall);
      if (!isNaN(v) && (best===null || v > best.value)) best = { value:v, write:w };
    });
    g.bestResult   = best ? best.value : '';
    g.attemptCount = g.writes.length;
    return g;
  });
  return { success:true, data:out };
}

// ── Student: my results ────────────────────────────────────────

/*  getAttemptDetail: returns essay + feedback JSON for ONE student+topic.
    Called lazily when teacher/student opens a specific attempt, not on list load.
    This keeps getResults/getMyResults lightweight (no essay/feedback in list).  */
function getAttemptDetail(p) {
  if (!p.studentId || !p.topicId || !p.mode) return { success:false, error:'Missing params.' };
  var tabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
  var tab = tabMap[p.mode];
  if (!tab) return { success:false, error:'Invalid mode.' };
  var rows = readRowsFor(tab, p.studentId, p.topicId);
  rows.sort(function(a,b){ return new Date(a['Timestamp'])-new Date(b['Timestamp']); });
  return { success:true, data: rows.map(function(r, i){
    return {
      attempt:   i+1,
      timestamp: r['Timestamp'],
      duration:  r['Duration'],
      overall:   r['AI Grading'],
      tr:r['TR']||'', cc:r['CC']||'', lr:r['LR']||'', gra:r['GRA']||'',
      essay:    r['Essay']||'',
      feedback: r['Feedback']||''
    };
  }) };
}
function getMyResults(p) {
  if (!p.studentId) return { success:false, error:'Missing studentId.' };
  var sid = String(p.studentId);

  // Read lookup tables once (small, fast)
  var classNames = {};
  readAll(T.CLASSES).forEach(function(c){ classNames[c['Class ID']] = c['Class Name']; });
  var assignInfo = {};
  readAll(T.ASSIGN).forEach(function(a){
    assignInfo[a['Topic ID']] = {
      created:a['CreatedAt'], deadline:a['Deadline'], prompt:a['Prompt'],
      taskType:a['Task Type']||'task2', chartImageId:a['Chart Image ID']||'',
      minWords: parseInt(a['Min Words']||'0',10)||0
    };
  });

  // Read submission tabs — filter by studentId row-by-row so we only keep
  // this student's rows, not the entire sheet. Each tab is still a full readAll
  // (GAS has no row-level query), but we discard unrelated rows immediately.
  var tabs    = [T.FREE, T.HOMEWORK, T.INCLASS];
  var modeMap = {};
  modeMap[T.FREE]='free'; modeMap[T.HOMEWORK]='homework'; modeMap[T.INCLASS]='inclass';

  // Optional: filter to a specific mode if requested (e.g. only homework)
  if (p.mode) {
    var modeTabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
    tabs = modeTabMap[p.mode] ? [modeTabMap[p.mode]] : tabs;
  }

  var groups = {};
  tabs.forEach(function(tab){
    var sh   = sheet(tab);
    var data = sh.getDataRange().getValues();
    if (data.length < 2) return;
    var head = data[0];
    var idx  = {};
    head.forEach(function(h, i){ idx[h] = i; });
    // Read only this student's rows — skip all others immediately
    for (var ri = 1; ri < data.length; ri++) {
      if (String(data[ri][idx['Student ID']||0]) !== sid) continue;
      var r = {};
      head.forEach(function(h, i){ r[h] = data[ri][i]; });
      var mode = modeMap[tab]||tab;
      var key  = mode + '||' + (r['Topic ID']||'');
      var ai   = assignInfo[r['Topic ID']] || {};
      if (!groups[key]) groups[key] = {
        mode:mode, topic:r['Topic'], topicId:r['Topic ID'],
        taskType:   r['Task Type'] || ai.taskType || 'task2',
        chartImageId: ai.chartImageId || '',
        prompt:     ai.prompt || '',
        minWords:   ai.minWords || 0,
        className:  classNames[r['Class']] || r['Class'] || '',
        assignedDate: ai.created || r['Timestamp'],
        deadline:   ai.deadline || '',
        writes:[], teacherScore:null
      };
      if (r['Teacher Score']) {
        try {
          var ts = JSON.parse(r['Teacher Score']);
          if (ts) delete ts.note;
          groups[key].teacherScore = ts;
        } catch(e){}
      }
      // essay + feedback kept here: per-student data is small (~3-9 rows total)
      // so no lazy-loading needed on the student side
      groups[key].writes.push({
        timestamp:r['Timestamp'], startTime:r['Start time'], finishTime:r['Finish time'],
        duration:r['Duration'], overall:r['AI Grading'], teacher:r['Teacher Grading'],
        tr:r['TR']||'', cc:r['CC']||'', lr:r['LR']||'', gra:r['GRA']||'',
        attempt:r['Attempt'], essay:r['Essay']||'', feedback:r['Feedback']||''
      });
    }
  });

  var out = Object.keys(groups).map(function(k){
    var g = groups[k];
    g.writes.sort(function(a,b){ return new Date(a.timestamp)-new Date(b.timestamp); });
    var best = null;
    g.writes.forEach(function(x){ var v=parseFloat(x.overall); if(!isNaN(v)&&(best===null||v>best))best=v; });
    g.bestResult  = best !== null ? best : '';
    g.attemptCount = g.writes.length;
    g.latestTime  = g.writes.length ? g.writes[g.writes.length-1].timestamp : '';
    return g;
  });
  out.sort(function(a,b){ return new Date(b.latestTime)-new Date(a.latestTime); });
  return { success:true, data:out };
}

// ── Overview KPIs ─────────────────────────────────────────────
function getOverview(p) {
  // Lightweight overview: only reads Students + Assignments tabs (small, fast).
  // Avoids reading all 3 submission tabs which can be hundreds of rows.
  var classId = p.class || '';
  // Count students in this class
  var students = readAll(T.STUDENTS).filter(function(r){
    return !classId || String(r['Class']) === classId;
  });
  // Count assignments for this class
  var assignments = readAll(T.ASSIGN).filter(function(r){
    return (!classId || String(r['Class']) === classId) &&
           String(r['Active'] || 'true').toLowerCase() !== 'false';
  });
  var hwCount = assignments.filter(function(a){ return a['Mode']==='homework'; }).length;
  var icCount = assignments.filter(function(a){ return a['Mode']==='inclass'; }).length;
  return { success:true, data:{
    activeStudents:  students.length,
    totalAssignments: assignments.length,
    hwAssignments:   hwCount,
    icAssignments:   icCount,
    // These require submission tabs — removed to keep overview fast.
    // Teachers see detailed stats in the Results tab with filters.
    avgScore:        '—',
    totalEssays:     '—',
    feedbackPending: '—'
  } };
}

// ── Export feedback Doc (rich version — emoji, colours, correction markup) ──
function exportFeedbackDoc(p) {
  var tabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
  var tab = tabMap[p.mode];
  if (!tab) return { success:false, error:'Invalid mode.' };

  var rows = readRowsFor(tab, p.studentId, p.topicId);
  if (!rows.length) return { success:false, error:'No submissions to export.' };
  rows.sort(function(a,b){ return new Date(a['Timestamp'])-new Date(b['Timestamp']); });

  var classNames = {};
  readAll(T.CLASSES).forEach(function(c){ classNames[c['Class ID']] = c['Class Name']; });
  var className   = classNames[rows[0]['Class']] || rows[0]['Class'] || 'Class';
  var asg         = readAll(T.ASSIGN).filter(function(r){ return String(r['Topic ID'])===String(p.topicId); })[0];
  var assignDate  = asg && asg['CreatedAt'] ? new Date(asg['CreatedAt']) : new Date(rows[0]['Timestamp']);
  var dateStr     = Utilities.formatDate(assignDate, Session.getScriptTimeZone(), 'yyyy-dd-MM');
  var taskType    = (asg && asg['Task Type']) || rows[0]['Task Type'] || 'task2';
  var taskLabel   = taskType === 'task1' ? 'T1' : 'T2';
  var modeCode    = p.mode==='homework' ? 'HW' : (p.mode==='inclass' ? 'IC' : 'FW');
  var studentName = rows[0]['Name'] || p.studentId;
  var studentEmail= rows[0]['Email'] || '';
  var topicShort  = (rows[0]['Topic']||'Topic').replace(/[\\/:*?"<>|]/g,'').slice(0,40);
  var promptText  = asg && asg['Prompt'] ? String(asg['Prompt']).replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim() : '';
  var fileName    = dateStr+'_'+className+'_'+p.studentId+'_'+studentName+'_'+taskLabel+'_'+modeCode+'_'+topicShort;

  var folder;
  try { folder = DriveApp.getFolderById(FEEDBACK_FOLDER_ID); }
  catch(e){ return { success:false, error:'Cannot access feedback folder: '+e.message }; }

  // Preserve teacher comments: reuse existing doc, append new attempts only
  var docIdCol = 'Feedback Doc ID', docCntCol = 'Feedback Doc Attempts', docSumCol = 'Feedback Doc Summarized';
  var storedId='', storedCnt=0, alreadySummarized=false;
  for (var ri=0;ri<rows.length;ri++){
    if (rows[ri][docIdCol]) storedId=String(rows[ri][docIdCol]);
    if (rows[ri][docCntCol]!==''&&rows[ri][docCntCol]!=null) storedCnt=parseInt(rows[ri][docCntCol],10)||0;
    if (String(rows[ri][docSumCol]||'')==='1') alreadySummarized=true;
  }
  var currentCnt=rows.length;

  var _req0 = asg && asg['Required Attempts'] ? (parseInt(asg['Required Attempts'],10)||3) : 3;
  var _dlPassed0=false;
  if (asg && asg['Deadline']){ var _d0=new Date(asg['Deadline']); if (!isNaN(_d0)&&new Date()>new Date(_d0.getTime()+86400000)) _dlPassed0=true; }
  var _complete0=(currentCnt>=_req0)||_dlPassed0;
  if (p.regenerate) alreadySummarized=false;
  var needsSummary=_complete0&&!alreadySummarized;

  var doc, existingFile=null, startIndex=-1, appendMode=false, body;
  if (storedId && !p.regenerate){
    try {
      existingFile=DriveApp.getFileById(storedId); doc=DocumentApp.openById(storedId);
      if (currentCnt>storedCnt){ appendMode=true; startIndex=storedCnt; body=doc.getBody(); }
      else if (needsSummary){ appendMode=true; startIndex=currentCnt; body=doc.getBody(); }
      else { return { success:true, data:{ url:doc.getUrl(), fileName:existingFile.getName(), reused:true } }; }
    } catch(e){ storedId=''; doc=null; existingFile=null; }
  }
  if (!doc){
    if (storedId && p.regenerate){
      try { existingFile=DriveApp.getFileById(storedId); doc=DocumentApp.openById(storedId); doc.getBody().clear(); } catch(e){ storedId=''; }
    }
    if (!doc){
      var it=folder.getFilesByName(fileName);
      if (it.hasNext()){ existingFile=it.next(); doc=DocumentApp.openById(existingFile.getId()); doc.getBody().clear(); }
      else { doc=DocumentApp.create(fileName); }
    }
    startIndex=-1; appendMode=false; body=doc.getBody();
  }
  body.setMarginTop(50).setMarginBottom(50).setMarginLeft(56).setMarginRight(56);

  function S(v){
    if (v==null) return '';
    if (Array.isArray(v)) return v.map(S).join('; ');
    if (typeof v==='object'){ try{ return JSON.stringify(v); }catch(e){ return String(v); } }
    return String(v);
  }
  function A(v){
    if (v==null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v==='string') return v.trim()?[v]:[];
    if (typeof v==='object') return Object.keys(v).map(function(k){ return v[k]; });
    return [v];
  }

  var NAVY='#0A3D62', BLUE='#0A6EBD', GREY='#5B6B7A', RED='#C5221F',
      GREEN='#1E7E42', AMBER='#8A6410', LIGHT='#8A97A3';

  function h1(txt,color){ var p=body.appendParagraph(txt); p.setHeading(DocumentApp.ParagraphHeading.HEADING1); p.setAttributes({FOREGROUND_COLOR:color||NAVY,BOLD:true,FONT_SIZE:17,SPACING_BEFORE:14,SPACING_AFTER:6}); return p; }
  function h2(txt,color){ var p=body.appendParagraph(txt); p.setHeading(DocumentApp.ParagraphHeading.HEADING2); p.setAttributes({FOREGROUND_COLOR:color||BLUE,BOLD:true,FONT_SIZE:13,SPACING_BEFORE:12,SPACING_AFTER:4}); return p; }
  function note(txt,color,size){ var p=body.appendParagraph(txt); p.setAttributes({FOREGROUND_COLOR:color||GREY,FONT_SIZE:size||9.5,SPACING_AFTER:2}); return p; }

  function correction(wrong,right,explain){
    var li=body.appendListItem(''); li.setGlyphType(DocumentApp.GlyphType.BULLET);
    var t=li.editAsText();
    var a=S(wrong),b=S(right),c=S(explain);
    t.appendText(a);
    if (a){ t.setForegroundColor(0,a.length-1,RED); t.setStrikethrough(0,a.length-1,false); }
    var arrowStart=t.getText().length; t.appendText('  →  '); t.setForegroundColor(arrowStart,t.getText().length-1,LIGHT);
    var rStart=t.getText().length; t.appendText(b);
    if (b){ t.setForegroundColor(rStart,t.getText().length-1,GREEN); t.setBold(rStart,t.getText().length-1,true); }
    if (c){ var cStart=t.getText().length; t.appendText('\n'+c); t.setForegroundColor(cStart,t.getText().length-1,GREY); t.setItalic(cStart,t.getText().length-1,true); t.setBold(cStart,t.getText().length-1,false); }
    li.setAttributes({FONT_SIZE:10.5,SPACING_AFTER:6}); return li;
  }
  function infoTable(pairs){
    var tbl=body.appendTable(pairs); tbl.setBorderColor('#FFFFFF');
    for (var r=0;r<tbl.getNumRows();r++){
      tbl.getRow(r).getCell(0).setAttributes({BOLD:true,FOREGROUND_COLOR:NAVY,FONT_SIZE:10.5});
      tbl.getRow(r).getCell(1).setAttributes({BOLD:false,FOREGROUND_COLOR:'#1F2933',FONT_SIZE:10.5});
      tbl.getRow(r).getCell(0).setWidth(110);
    }
    return tbl;
  }

  // Task-specific labels
  var trLabel = taskType==='task1' ? '🎯 Task Achievement' : '🎯 Task Response';
  var taskFullLabel = taskType==='task1' ? 'IELTS Writing Task 1 (Data/Chart)' : 'IELTS Writing Task 2 (Essay)';
  var docTitle = taskType==='task1' ? '📘 ArticuWrite — Task 1 Feedback Report' : '📘 ArticuWrite — Writing Feedback Report';

  if (!appendMode){
    var title=body.appendParagraph(docTitle);
    title.setHeading(DocumentApp.ParagraphHeading.TITLE);
    title.setAttributes({FOREGROUND_COLOR:NAVY,BOLD:true,FONT_SIZE:22,SPACING_AFTER:2});
    note('Báo cáo phản hồi bài viết '+taskFullLabel,LIGHT,10.5);
    body.appendHorizontalRule();
    infoTable([
      ['👤 Student', S(studentName)+'  ('+S(p.studentId)+')'],
      ['🏫 Class',   S(className)],
      ['📝 Topic',   S(rows[0]['Topic'])],
      ['📊 Task',    taskFullLabel],
      ['🎯 Mode',    p.mode==='homework'?'Homework':p.mode==='inclass'?'In-class Practice':'Free Writing'],
      ['🔁 Attempts',rows.length+' / '+_req0],
      ['🕒 Generated',Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyy-MM-dd HH:mm')]
    ]);
    if (promptText){
      var pq=body.appendParagraph('📝 Đề bài');
      pq.setAttributes({FOREGROUND_COLOR:NAVY,BOLD:true,FONT_SIZE:12,SPACING_BEFORE:10,SPACING_AFTER:3});
      var qt=body.appendTable([[promptText]]); qt.setBorderColor('#B8D4F0');
      var qc=qt.getCell(0,0); qc.setBackgroundColor('#EAF2FB');
      qc.getChild(0).asParagraph().setAttributes({FOREGROUND_COLOR:'#1F2933',ITALIC:true,FONT_SIZE:11,LINE_SPACING:1.3});
    }
  }

  if (appendMode){
    body.appendHorizontalRule();
    var addNote=body.appendParagraph('🆕 Bài nộp mới (thêm vào sau khi giáo viên đã xem các lần trước)');
    addNote.setAttributes({FOREGROUND_COLOR:BLUE,BOLD:true,FONT_SIZE:11,SPACING_BEFORE:6,SPACING_AFTER:2});
  }

  var loopStart=appendMode?startIndex:0;
  rows.forEach(function(r,i){
    if (i<loopStart) return;
    body.appendPageBreak();
    h1('✍️ Attempt '+(i+1),NAVY);

    var band=S(r['AI Grading'])||'—';
    var c1key = taskType==='task1' ? 'TA' : 'TR';
    var scoreP=body.appendParagraph(''); var st=scoreP.editAsText();
    st.appendText('Band '+band); st.setBold(0,st.getText().length-1,true); st.setForegroundColor(0,st.getText().length-1,BLUE); st.setFontSize(0,st.getText().length-1,15);
    var rest='     '+c1key+' '+(S(r['TR'])||'—')+'  ·  CC '+(S(r['CC'])||'—')+'  ·  LR '+(S(r['LR'])||'—')+'  ·  GRA '+(S(r['GRA'])||'—');
    var rs=st.getText().length; st.appendText(rest); st.setForegroundColor(rs,st.getText().length-1,GREY); st.setBold(rs,st.getText().length-1,false); st.setFontSize(rs,st.getText().length-1,11);
    scoreP.setAttributes({SPACING_AFTER:2});
    var subAt='—'; try{ if(r['Timestamp']) subAt=Utilities.formatDate(new Date(r['Timestamp']),Session.getScriptTimeZone(),'dd/MM/yyyy  HH:mm'); }catch(e){}
    note('🗓 Nộp lúc: '+subAt+'     ⏱ Thời gian làm bài: '+(r['Duration']?Math.round(parseInt(r['Duration'],10)/60)+' phút':'—'),LIGHT,9.5);

    h2('📄 '+(taskType==='task1'?'Response':'Essay'));
    var essayText = S(r['Essay']) || '(no text)';

    // ── Word count note ──────────────────────────────────────────────
    var essayWC  = essayText.trim() ? essayText.trim().split(/\s+/).filter(Boolean).length : 0;
    var asgMinW  = asg ? parseInt(asg['Min Words']||'0',10)||0 : 0;
    var ieltsDef = taskType==='task1' ? 150 : 250;
    var minWC    = asgMinW > 0 ? asgMinW : ieltsDef;
    var wcOk     = essayWC >= minWC;
    var wcSource = asgMinW > 0 ? 'yêu cầu của GV: '+minWC+' từ' : 'chuẩn IELTS '+taskType.toUpperCase()+': '+minWC+' từ';
    note((wcOk?'✓':'⚠')+' Word count: '+essayWC+' từ — '+(wcOk?'đạt ':' chưa đạt ')+wcSource, wcOk?GREEN:RED, 9.5);

    // Split essay — double newline first, fallback to single newline for legacy essays
    var essayParas = essayText.split(/\n\n+/).map(function(p){ return p.replace(/\n/g,' ').trim(); }).filter(Boolean);
    if (essayParas.length<=1 && essayText.indexOf('\n')!==-1)
      essayParas = essayText.split(/\n+/).map(function(p){ return p.trim(); }).filter(Boolean);
    if (!essayParas.length) essayParas = ['(no text)'];
    essayParas.forEach(function(paraText, paraIdx){
      var ep = body.appendParagraph(paraText);
      ep.setHeading(DocumentApp.ParagraphHeading.NORMAL);
      ep.setAttributes({
        FONT_SIZE:       11,
        FOREGROUND_COLOR:'#1F2933',
        BOLD:            false,
        ITALIC:          false,
        INDENT_START:    14,
        INDENT_END:      8,
        LINE_SPACING:    1.4,
        SPACING_BEFORE:  paraIdx===0 ? 0 : 10,
        SPACING_AFTER:   4,
      });
    });

    var fb=null; try{ fb=r['Feedback']?JSON.parse(r['Feedback']):null; }catch(e){}
    if (!fb){ note('Không có dữ liệu phản hồi AI cho lần nộp này.',LIGHT,10); return; }

    try {
      h1('💬 Feedback',BLUE);
      if (fb.overall_feedback_vi){
        h2('⭐ Nhận xét chung');
        body.appendParagraph(S(fb.overall_feedback_vi)).setAttributes({FONT_SIZE:11,FOREGROUND_COLOR:'#1F2933',LINE_SPACING:1.3,SPACING_AFTER:6});
      }
      if (fb.repeated_errors_vi){
        h2('⚠️ Lỗi lặp lại',AMBER);
        body.appendParagraph(S(fb.repeated_errors_vi)).setAttributes({FONT_SIZE:10.5,FOREGROUND_COLOR:AMBER,ITALIC:true,SPACING_AFTER:6});
      }
      var trList=A(fb.tr_comments);
      if (trList.length){
        h2(trLabel);
        trList.forEach(function(c){
          if (typeof c!=='object'||c===null){ c={assessment_vi:S(c)}; }
          var li=body.appendListItem(''); var t=li.editAsText(); var lab=S(c.paragraph_role);
          if (lab){ t.appendText(lab+': '); t.setBold(0,t.getText().length-1,true); t.setForegroundColor(0,t.getText().length-1,NAVY); }
          var qs=t.getText().length;
          if (c.quote){ t.appendText('"'+S(c.quote)+'"  '); t.setItalic(qs,t.getText().length-1,true); t.setForegroundColor(qs,t.getText().length-1,GREY); t.setBold(qs,t.getText().length-1,false); }
          var as=t.getText().length; t.appendText(S(c.assessment_vi)); t.setBold(as,t.getText().length-1,false); t.setItalic(as,t.getText().length-1,false); t.setForegroundColor(as,t.getText().length-1,'#1F2933');
          if (c.suggestion_en){ var ss=t.getText().length; t.appendText('\n→ '+S(c.suggestion_en)); t.setForegroundColor(ss,t.getText().length-1,GREEN); t.setItalic(ss,t.getText().length-1,true); }
          li.setAttributes({FONT_SIZE:10.5,SPACING_AFTER:6});
        });
      }
      var graList=A(fb.gra_errors);
      if (graList.length){
        h2('🔧 Grammar ('+graList.length+')');
        graList.forEach(function(e){ if (typeof e!=='object'||e===null){ note('• '+S(e),'#1F2933',10.5); return; } correction(e.wrong,e.correct,e.explanation_vi); });
      }
      var lrList=A(fb.lr_issues);
      if (lrList.length){
        h2('📚 Lexical Resource ('+lrList.length+')');
        lrList.forEach(function(e){ if (typeof e!=='object'||e===null){ note('• '+S(e),'#1F2933',10.5); return; } correction(e.original,e.better,e.explanation_vi); });
      }
      if (fb.cc_feedback&&fb.cc_feedback.assessment_vi){
        h2('🔗 Coherence & Cohesion');
        body.appendParagraph(S(fb.cc_feedback.assessment_vi)).setAttributes({FONT_SIZE:10.5,FOREGROUND_COLOR:'#1F2933',LINE_SPACING:1.3,SPACING_AFTER:4});
        A(fb.cc_feedback.suggestions).forEach(function(sug){
          body.appendListItem('→ '+S(sug)).setAttributes({FONT_SIZE:10.5,FOREGROUND_COLOR:GREEN,ITALIC:true,SPACING_AFTER:3});
        });
      }
    } catch(renderErr){
      note('⚠️ Một phần phản hồi không hiển thị được ('+renderErr.message+'). Dữ liệu gốc vẫn lưu trong hệ thống.',AMBER,9.5);
    }
  });

  // Final summary table (once process is complete)
  var summaryAdded=false;
  if (_complete0&&!alreadySummarized){
    body.appendPageBreak();
    var sh1=body.appendParagraph('📊 Tổng kết quá trình làm bài');
    sh1.setAttributes({FOREGROUND_COLOR:NAVY,BOLD:true,FONT_SIZE:15,SPACING_BEFORE:8,SPACING_AFTER:2});
    note(_dlPassed0&&rows.length<_req0?'Đã hết hạn nộp bài. Dưới đây là kết quả các lần bạn đã làm.':'Bạn đã hoàn thành đủ '+rows.length+' lần làm bài. So sánh điểm từng lần bên dưới.',LIGHT,10);
    var c1h=taskType==='task1'?'TA':'TR';
    var sumRows=[['Lần','Nộp lúc','Thời gian','Overall',c1h,'CC','LR','GRA']];
    rows.forEach(function(r,i){
      var when='—'; try{ if(r['Timestamp']) when=Utilities.formatDate(new Date(r['Timestamp']),Session.getScriptTimeZone(),'dd/MM/yy HH:mm'); }catch(e){}
      var dur='—'; if(r['Duration']){ var mm=Math.round(parseInt(r['Duration'],10)/60); if(!isNaN(mm)) dur=mm+' phút'; }
      sumRows.push([String(i+1),when,dur,S(r['AI Grading'])||'—',S(r['TR'])||'—',S(r['CC'])||'—',S(r['LR'])||'—',S(r['GRA'])||'—']);
    });
    var stbl=body.appendTable(sumRows);
    stbl.getRow(0).setAttributes({BOLD:true,FOREGROUND_COLOR:'#FFFFFF',BACKGROUND_COLOR:NAVY,FONT_SIZE:10});
    for (var sr=1;sr<stbl.getNumRows();sr++){
      stbl.getRow(sr).setAttributes({FONT_SIZE:10,FOREGROUND_COLOR:'#1F2933'});
      stbl.getRow(sr).getCell(3).setAttributes({BOLD:true,FOREGROUND_COLOR:BLUE,FONT_SIZE:11});
    }
    var bands=rows.map(function(r){ return parseFloat(r['AI Grading']); }).filter(function(v){ return !isNaN(v); });
    if (bands.length){
      var best=Math.max.apply(null,bands), first=bands[0], last=bands[bands.length-1];
      var trend=last>first?'tiến bộ +'+(Math.round((last-first)*10)/10)+' band so với lần đầu':last<first?'giảm '+(Math.round((first-last)*10)/10)+' band so với lần đầu':'giữ nguyên so với lần đầu';
      body.appendParagraph('⭐ Band cao nhất: '+best+'   ·   '+trend).setAttributes({FOREGROUND_COLOR:GREEN,BOLD:true,FONT_SIZE:11,SPACING_BEFORE:6});
    }
    summaryAdded=true;
  }

  if (!appendMode||summaryAdded){
    body.appendHorizontalRule();
    note('Báo cáo tạo tự động bởi ArticuWrite · Dong Nai University',LIGHT,9);
  }
  doc.saveAndClose();
  var newDocId=doc.getId();

  // Store doc ID back on all rows so future calls append instead of recreate
  // Re-locate this student's rows (key columns only) right before writing:
  // building the Doc takes seconds and rows may have shifted meanwhile.
  var sh2=sheet(tab), idx2=headerIndex(tab);
  if (idx2[docIdCol]==null){ sh2.getRange(1,sh2.getLastColumn()+1).setValue(docIdCol); idx2=headerIndex(tab); }
  if (idx2[docCntCol]==null){ sh2.getRange(1,sh2.getLastColumn()+1).setValue(docCntCol); idx2=headerIndex(tab); }
  if (idx2[docSumCol]==null){ sh2.getRange(1,sh2.getLastColumn()+1).setValue(docSumCol); idx2=headerIndex(tab); }
  var head2=sh2.getRange(1,1,1,sh2.getLastColumn()).getValues()[0];
  keyRowsFor(sh2, head2, sh2.getLastRow(), p.studentId, p.topicId).forEach(function(k){
    sh2.getRange(k+2,idx2[docIdCol]+1).setValue(newDocId);
    sh2.getRange(k+2,idx2[docCntCol]+1).setValue(currentCnt);
    if (summaryAdded) sh2.getRange(k+2,idx2[docSumCol]+1).setValue('1');
  });

  try {
    var file2=DriveApp.getFileById(newDocId);
    if (!existingFile){ folder.addFile(file2); DriveApp.getRootFolder().removeFile(file2); }
    file2.setSharing(DriveApp.Access.ANYONE_WITH_LINK,DriveApp.Permission.VIEW);
  } catch(err){
    return { success:true, data:{ url:doc.getUrl(), warning:'Folder move: '+err.message } };
  }
  return { success:true, data:{ url:doc.getUrl(), fileName:fileName, updated:!!existingFile } };
}

// ── Export results sheet ───────────────────────────────────────
function exportResultsSheet(p) {
  var res    = rtMergeResults(getResults({ mode:p.mode, class:p.class }), { mode:p.mode, class:p.class }, 'teacher');
  var groups = res.data || [];
  if (!groups.length) return { success:false, error:'No results to export.' };

  var modeLabel = p.mode==='homework'?'Homework':(p.mode==='inclass'?'In-class Practice':'Free Writing');
  var dateStr   = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');
  var fileName  = 'ArticuWrite_Results_'+modeLabel.replace(/\s+/g,'-')+'_'+dateStr;

  var ssNew = SpreadsheetApp.create(fileName);
  var sh    = ssNew.getSheets()[0];
  sh.setName(modeLabel);

  var writeCols = ['First Write','Second Write','Third Write','Best Write'];
  var row1 = ['Student ID','Name','Class','Task','Title','Prompt (đề bài)'];
  var row2 = ['','','','','',''];
  writeCols.forEach(function(wl){ row1.push(wl,'','',''); row2.push('Start','Finish','Dur','Result'); });
  row1.push('Attempts','AI Best','AI Avg','Teacher TR','Teacher CC','Teacher LR','Teacher GRA','Teacher Overall','Private Note','Note for Student');
  ['','','','','','','','','',''].forEach(function(x){ row2.push(x); });

  var data = [row1, row2];
  function tm(x){ if(!x)return ''; var d=new Date(x); return isNaN(d)?x:Utilities.formatDate(d,Session.getScriptTimeZone(),'HH:mm'); }
  function du(s){ if(!s)return ''; s=parseInt(s,10); return isNaN(s)?'':Math.round(s/60)+'m'; }

  groups.forEach(function(g){
    var w    = g.writes||[];
    var best = null;
    w.forEach(function(x){ var v=parseFloat(x.overall); if(!isNaN(v)&&(best===null||v>parseFloat(best.overall)))best=x; });
    var picks = [w[0],w[1],w[2],best];
    var vals  = w.map(function(x){return parseFloat(x.overall);}).filter(function(v){return !isNaN(v);});
    var avg   = vals.length?(vals.reduce(function(a,b){return a+b;},0)/vals.length).toFixed(1):'';
    var ts    = g.teacherScore||{};
    var promptPlain = g.prompt ? String(g.prompt).replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim() : '';
    var taskLabel   = (g.taskType==='task1') ? 'Task 1' : 'Task 2';
    var rowArr = [g.studentId, g.name||'', g.className||g.class||'', taskLabel, g.topic||'', promptPlain];
    picks.forEach(function(x){
      if(x) rowArr.push(tm(x.startTime), tm(x.finishTime), du(x.duration), x.overall||'');
      else   rowArr.push('','','','');
    });
    rowArr.push(w.length+'/3', (best?best.overall:''), avg,
      ts.tr||'', ts.cc||'', ts.lr||'', ts.gra||'', ts.overall||'', ts.note||'', ts.privateNote||'');
    data.push(rowArr);
  });

  sh.getRange(1,1,data.length,data[0].length).setValues(data);
  for (var lc=1;lc<=6;lc++){ sh.getRange(1,lc,2,1).merge(); }
  var col=7;
  writeCols.forEach(function(){ sh.getRange(1,col,1,4).merge(); col+=4; });
  for (var c=col;c<=data[0].length;c++){ sh.getRange(1,c,2,1).merge(); }
  sh.getRange(1,1,2,data[0].length).setFontWeight('bold').setHorizontalAlignment('center')
    .setBackground('#0A6EBD').setFontColor('#ffffff');
  sh.setFrozenRows(2);
  sh.autoResizeColumns(1, data[0].length);

  try {
    var file   = DriveApp.getFileById(ssNew.getId());
    var folder = DriveApp.getFolderById(FEEDBACK_FOLDER_ID);
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch(err) {
    return { success:true, data:{ url:ssNew.getUrl(), warning:'Folder move issue: '+err.message } };
  }
  return { success:true, data:{ url:ssNew.getUrl(), fileName:fileName, rows:groups.length } };
}

// ── Boards ────────────────────────────────────────────────────
function boardCreate(p) {
  var id = uid('B');
  appendRowByHeader(T.BOARDS, {
    'Board ID':id, 'Class':p.class||'', 'Title':p.title||'Untitled Board',
    'Content':'', 'Owner':p.owner||'', 'CreatedAt':nowIso(), 'UpdatedAt':nowIso()
  });
  return { success:true, data:{ boardId:id, title:p.title||'Untitled Board' } };
}
function boardList(p) {
  var classNames = {};
  readAll(T.CLASSES).forEach(function(c){ classNames[c['Class ID']] = c['Class Name']; });
  var rows = readAll(T.BOARDS).filter(function(r){
    if (r['Archived']===true || String(r['Archived']).toLowerCase()==='true') return false;
    if (!p.class) return true;
    var rc = String(r['Class']||'').trim();
    return !rc || rc===String(p.class).trim();
  });
  return { success:true, data: rows.map(function(r){
    return { boardId:r['Board ID'], class:r['Class'], className:classNames[r['Class']]||r['Class'],
             title:r['Title'], owner:r['Owner'], updatedAt:r['UpdatedAt'] };
  }) };
}
function boardGet(p) {
  var b = readAll(T.BOARDS).filter(function(r){ return String(r['Board ID'])===String(p.boardId); })[0];
  if (!b) return { success:false, error:'Board không tồn tại.' };
  return { success:true, data:{ boardId:b['Board ID'], class:b['Class'], title:b['Title'],
           content:b['Content'], owner:b['Owner'], updatedAt:b['UpdatedAt'] } };
}
function boardSave(p) {
  if (!p.boardId) return { success:false, error:'Missing boardId.' };
  var sh = sheet(T.BOARDS), idx = headerIndex(T.BOARDS);
  var data = sh.getDataRange().getValues();
  // Google Sheets cell limit: 50,000 chars. Images stored as Drive URLs are tiny.
  // If content still exceeds 45,000 chars it means base64 images slipped through —
  // return an error so the frontend can warn the teacher instead of silently truncating.
  var contentStr = String(p.content || '');
  if (contentStr.length > 45000) {
    return { success:false, error:'CONTENT_TOO_LARGE',
             detail:'Nội dung board quá lớn (' + Math.round(contentStr.length/1000) + 'KB). '+
                    'Hãy xóa bớt ảnh hoặc dùng ảnh nhỏ hơn.' };
  }
  for (var i=1; i<data.length; i++){
    if (String(data[i][idx['Board ID']])===String(p.boardId)) {
      if (p.title   != null && idx['Title']    != null) sh.getRange(i+1,idx['Title']+1).setValue(p.title);
      if (p.content != null && idx['Content']  != null) sh.getRange(i+1,idx['Content']+1).setValue(contentStr);
      if (idx['UpdatedAt'] != null) sh.getRange(i+1,idx['UpdatedAt']+1).setValue(nowIso());
      return { success:true, data:{ boardId:p.boardId } };
    }
  }
  return { success:false, error:'Board không tồn tại.' };
}
function boardDelete(p) {
  // Soft-delete: set Archived = true so boards are never permanently lost.
  // Teachers can see all class boards as reference after lessons.
  var sh = sheet(T.BOARDS), idx = headerIndex(T.BOARDS);
  if (idx['Archived']==null) {
    sh.getRange(1, sh.getLastColumn()+1).setValue('Archived');
    idx = headerIndex(T.BOARDS);
  }
  var data = sh.getDataRange().getValues();
  for (var i=1;i<data.length;i++){
    if (String(data[i][idx['Board ID']])===String(p.boardId)){
      sh.getRange(i+1, idx['Archived']+1).setValue('true');
      sh.getRange(i+1, idx['UpdatedAt']+1).setValue(nowIso());
      return { success:true };
    }
  }
  return { success:false, error:'Board không tồn tại.' };
}
function boardUploadImage(p) {
  if (!p.dataUrl) return { success:false, error:'Thiếu ảnh.' };
  try {
    var parts = p.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!parts) return { success:false, error:'Định dạng ảnh không hợp lệ.' };
    var blob   = Utilities.newBlob(Utilities.base64Decode(parts[2]), parts[1], p.name||('board-'+Date.now()));
    var folder = getBoardFolder();
    var file   = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var id = file.getId();
    // Use thumbnail URL — uc?export=view is blocked by Drive CORS policy when embedded cross-origin.
    // lh3.googleusercontent.com/d/{id} is the reliable public CDN URL for Drive images.
    var url = 'https://lh3.googleusercontent.com/d/' + id;
    return { success:true, data:{ url:url, id:id } };
  } catch (err) {
    return { success:false, error:'Upload lỗi: ' + err.message };
  }
}
function getBoardFolder() {
  var name = 'ArticuWrite Board Images';
  var it   = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

// ── Vocab / Today's Word ───────────────────────────────────────
function initVocab() {
  var book = SpreadsheetApp.openById(SHEET_ID);
  var sh   = book.getSheetByName(T.VOCAB);
  if (!sh) sh = book.insertSheet(T.VOCAB);
  if (sh.getLastRow()===0) {
    sh.getRange(1,1,1,7).setValues([HEADERS[T.VOCAB]]).setFontWeight('bold')
      .setBackground('#0A6EBD').setFontColor('#fff');
    var seed = [
      ['stringent','ˈstrɪndʒənt','Band 8 · C1','Nghiêm ngặt, khắt khe','strict, rigorous, tight','The factory must comply with stringent safety regulations.','Universities are adopting more stringent admission criteria.'],
      ['inevitable','ɪnˈevɪtəbl','Band 7 · B2','Tất yếu, không thể tránh khỏi','unavoidable, certain','Change is an inevitable part of life.','A rise in prices seems inevitable this year.'],
      ['ubiquitous','juːˈbɪkwɪtəs','Band 8 · C1','Có mặt khắp nơi, phổ biến','omnipresent, pervasive','Smartphones have become ubiquitous in modern life.','Advertising is ubiquitous in big cities.']
    ];
    sh.getRange(2,1,seed.length,7).setValues(seed);
    sh.autoResizeColumns(1,7);
    return { success:true, data:{ created:true, seeded:seed.length } };
  }
  return { success:true, data:{ created:false, note:'Already exists.' } };
}

function getTodaysWord(p) {
  var rows = readAll(T.VOCAB).filter(function(r){ return r['Word']; });
  if (!rows.length) return { success:true, data:null };
  var now     = new Date();
  var shifted = new Date(now.getTime() - 3*3600*1000);
  var epochDay = Math.floor(shifted.getTime()/86400000);
  var idx;
  if (p && p.index!=null && !isNaN(parseInt(p.index,10))) {
    idx = parseInt(p.index,10) % rows.length;
  } else {
    idx = epochDay % rows.length;
  }
  if (idx<0) idx+=rows.length;
  var prevIdx = (idx-1+rows.length)%rows.length;
  function pack(r){
    return {
      word:r['Word']||'', ipa:r['IPA']||'', band:r['Band']||'', meaningVi:r['Meaning VI']||'',
      synonyms:String(r['Synonyms']||'').split(/[,;]/).map(function(s){return s.trim();}).filter(Boolean),
      examples:[r['Example 1'],r['Example 2']].filter(Boolean)
    };
  }
  return { success:true, data:{ dayIndex:epochDay, total:rows.length, current:pack(rows[idx]), previous:pack(rows[prevIdx]) } };
}

// ── Queries (Feedback Q&A) ─────────────────────────────────────
function createQuery(p) {
  var id = 'Q-' + Utilities.getUuid().slice(0,8).toUpperCase();
  appendRowByHeader(T.QUERIES, {
    'Query ID':id, 'Class':p.class||'', 'Student ID':p.studentId||'',
    'Student Name':p.studentName||'', 'Mode':p.mode||'', 'Topic':p.topic||'',
    'Topic ID':p.topicId||'', 'Attempt':p.attempt||'', 'Error Quote':p.errorQuote||'',
    'Question':p.question||'', 'Teacher Answer':'', 'Status':'open',
    'Shared':'', 'Phase':p.phase||'review', 'CreatedAt':nowIso(), 'AnsweredAt':''
  });
  // Email notification to teacher
  try {
    var cls = readAll(T.CLASSES).filter(function(r){ return String(r['Class ID']).trim()===String(p.class||'').trim(); })[0];
    var teacherEmail = (cls && cls['Teacher Email']) ? cls['Teacher Email'] : Session.getEffectiveUser().getEmail();
    if (teacherEmail) {
      var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm');
      MailApp.sendEmail({
        to: teacherEmail,
        subject: '📚 ArticuWrite — Câu hỏi mới từ ' + (p.studentName||p.studentId||'Sinh viên'),
        body: 'Xin chào Thầy/Cô,\n\nCó một câu hỏi mới từ sinh viên:\n\n' +
          '────────────────────────────\n' +
          '👤 Sinh viên : ' + (p.studentName||'') + ' (' + (p.studentId||'') + ')\n' +
          '🏫 Lớp       : ' + (p.class||'') + '\n' +
          '📝 Bài       : ' + (p.topic||'') + (p.attempt?' · Attempt '+p.attempt:'') + '\n' +
          '🕐 Thời gian : ' + now + '\n' +
          '────────────────────────────\n\n' +
          '💬 Câu hỏi:\n' + (p.question||'') + '\n\n' +
          (p.errorQuote?'📌 Trích dẫn:\n"'+p.errorQuote+'"\n\n':'') +
          'Truy cập ArticuWrite: https://l2practice.github.io/artwrite_v2/teacher.html#queries\n\n— ArticuWrite (tự động)'
      });
    }
  } catch(mailErr) { Logger.log('Query email failed: ' + mailErr.message); }
  return { success:true, data:{ queryId:id } };
}
function listQueriesForStudent(p) {
  var rows = readAll(T.QUERIES).filter(function(r){
    var mine         = String(r['Student ID'])===String(p.studentId);
    var sharedToClass = String(r['Shared']).toLowerCase()==='true' && String(r['Class'])===String(p.class);
    return mine || sharedToClass;
  });
  return { success:true, data: rows.map(mapQuery).sort(byNewest) };
}
function listQueriesForTeacher(p) {
  var rows = readAll(T.QUERIES).filter(function(r){ return !p.class || String(r['Class'])===String(p.class); });
  return { success:true, data: rows.map(mapQuery).sort(byNewest) };
}
function listLiveQueries(p) {
  var rows = readAll(T.QUERIES).filter(function(r){
    if (p.class && String(r['Class'])!==String(p.class)) return false;
    return String(r['Phase'])==='live';
  });
  return { success:true, data: rows.map(mapQuery).sort(byNewest) };
}
function answerQuery(p) {
  var sh = sheet(T.QUERIES), idx = headerIndex(T.QUERIES), data = sh.getDataRange().getValues();
  for (var i=1;i<data.length;i++){
    if (String(data[i][idx['Query ID']])===String(p.queryId)){
      sh.getRange(i+1,idx['Teacher Answer']+1).setValue(p.dismissed ? '[dismissed]' : (p.answer||''));
      sh.getRange(i+1,idx['Status']+1).setValue('answered');
      sh.getRange(i+1,idx['AnsweredAt']+1).setValue(nowIso());
      return { success:true, dismissed: !!p.dismissed };
    }
  }
  return { success:false, error:'Query not found.' };
}
function shareQuery(p) {
  var sh = sheet(T.QUERIES), idx = headerIndex(T.QUERIES), data = sh.getDataRange().getValues();
  for (var i=1;i<data.length;i++){
    if (String(data[i][idx['Query ID']])===String(p.queryId)){
      sh.getRange(i+1,idx['Shared']+1).setValue(p.shared===false?'':'true');
      return { success:true };
    }
  }
  return { success:false, error:'Query not found.' };
}
function mapQuery(r){
  return {
    queryId:r['Query ID'], class:r['Class'], studentId:r['Student ID'],
    studentName:r['Student Name'], mode:r['Mode'], topic:r['Topic'],
    topicId:r['Topic ID'], attempt:r['Attempt'], errorQuote:r['Error Quote'],
    question:r['Question'], answer:r['Teacher Answer'], status:r['Status'],
    shared:String(r['Shared']).toLowerCase()==='true', phase:r['Phase']||'review',
    createdAt:r['CreatedAt'], answeredAt:r['AnsweredAt']
  };
}
function byNewest(a,b){ return new Date(b.createdAt)-new Date(a.createdAt); }

// ── Alerts (hands + questions) ─────────────────────────────────
function getAlerts(p) {
  var hands = liveEntries(p.class).filter(function(e){ return e.hand; }).map(function(e){
    return { studentId:e.o.sid, name:e.o.name, where:e.o.topic||e.hand.where||'', updated:new Date(e.hand.t).toISOString() };
  });
  var qs = readAll(T.QUERIES).filter(function(r){
    if (p.class && String(r['Class'])!==String(p.class)) return false;
    return String(r['Status'])==='open';
  }).map(function(r){
    return { queryId:r['Query ID'], studentId:r['Student ID'], name:r['Student Name'],
             question:r['Question'], topic:r['Topic'], createdAt:r['CreatedAt'] };
  });
  return { success:true, data:{ hands:hands, questions:qs } };
}

// ── Admin / setup ─────────────────────────────────────────────
function setup() {
  Object.keys(HEADERS).forEach(function(name){ sheet(name); });
  Logger.log('All tabs created: ' + Object.keys(HEADERS).join(', '));
}

function resetTab(p) {
  var targets = (!p || p.tab==='all') ? [T.FREE, T.HOMEWORK, T.INCLASS] : [p.tab];
  var results = [];
  targets.forEach(function(name){
    var book = ss();
    var existing = book.getSheetByName(name);
    if (existing) existing.setName(name + '_bak' + Date.now().toString().slice(-4));
    var fresh = book.insertSheet(name);
    var head  = HEADERS[name];
    if (head) {
      fresh.getRange(1,1,1,head.length).setValues([head]).setFontWeight('bold');
      fresh.setFrozenRows(1);
      forceTextColumns(fresh, head, ['Student ID','Password','Phone']);
    }
    results.push(name + ' reset OK');
  });
  return { success:true, data:results };
}

function debugTabs() {
  var book = ss();
  var out  = {};
  book.getSheets().forEach(function(sh){
    var name    = sh.getName();
    var lastCol = sh.getLastColumn();
    var headers = lastCol > 0 ? sh.getRange(1,1,1,lastCol).getValues()[0] : [];
    out[name]   = { rows: Math.max(0, sh.getLastRow()-1), headers:headers };
  });
  return { success:true, data:out };
}

function fmt(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v==null ? '' : String(v);
}

// ── Library ────────────────────────────────────────────────────
/*  Library questions are stored in a SEPARATE Google Sheet (LIBRARY_SHEET_ID).
    Column layout (0-indexed):
     0  Testing Date | 1  Theme | 2  Task Type | 3  Question | 4  Keywords
     5-8   Body1 MP1: why, mp, example, result
     9-12  Body1 MP2: why, mp, example, result
     13-16 Body2 MP1: why, mp, example, result
     17-20 Body2 MP2: why, mp, example, result
     21    Outline  ('Open' = unlocked, else locked)                         */
function librarySheet() {
  var book = SpreadsheetApp.openById(LIBRARY_SHEET_ID);
  if (LIBRARY_TAB) { var t = book.getSheetByName(LIBRARY_TAB); if (t) return t; }
  return book.getSheets()[0];
}

function getLibrary(p) {
  p = p || {};
  var sh = librarySheet();
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { success:true, data:[] };
  var rules = readAll(T.LIBACCESS);
  var isTeacher = !p.studentId;
  var byTopic = {};
  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[3] && !r[1]) continue;
    var topic = r[1] || 'Uncategorized';
    var question = r[3] || '';
    if (!byTopic[topic]) byTopic[topic] = { topic:topic, questions:[] };
    var globalOpen = String(r[21]||'').toLowerCase() === 'open';
    var qRules = rules.filter(function(x){ return String(x['Question'])===String(question); });
    var unlocked = isTeacher ? globalOpen : resolveStudentAccess(qRules, globalOpen, p.studentId, p.class);
    var item = {
      rowIndex: i+1, testingDate: fmt(r[0]),
      taskType: r[2]||'', question: question, keywords: r[4]||'',
      outlineUnlocked: unlocked, globalOpen: globalOpen,
      body1: {
        mp1:{ why:r[5]||'',  mp:r[6]||'',  example:r[7]||'',  result:r[8]||''  },
        mp2:{ why:r[9]||'',  mp:r[10]||'', example:r[11]||'', result:r[12]||'' }
      },
      body2: {
        mp1:{ why:r[13]||'', mp:r[14]||'', example:r[15]||'', result:r[16]||'' },
        mp2:{ why:r[17]||'', mp:r[18]||'', example:r[19]||'', result:r[20]||'' }
      }
    };
    if (isTeacher) item.accessRules = qRules.map(function(x){
      return { scope:x['Scope'], target:x['Target'], state:x['State'] };
    });
    byTopic[topic].questions.push(item);
  }
  return { success:true, data: Object.keys(byTopic).map(function(k){ return byTopic[k]; }) };
}

function resolveStudentAccess(qRules, globalOpen, studentId, classId) {
  var stu = qRules.filter(function(x){ return x['Scope']==='student' && String(x['Target'])===String(studentId); })[0];
  if (stu) return String(stu['State']).toLowerCase()==='open';
  var cls = qRules.filter(function(x){ return x['Scope']==='class' && String(x['Target'])===String(classId); })[0];
  if (cls) return String(cls['State']).toLowerCase()==='open';
  var all = qRules.filter(function(x){ return x['Scope']==='all'; })[0];
  if (all) return String(all['State']).toLowerCase()==='open';
  return globalOpen;
}

function librarySetAccess(p) {
  if (!p.question) return { success:false, error:'Missing question.' };
  var scope = p.scope||'all', target = p.target||'';
  var state = (p.state==='Open') ? 'Open' : 'Locked';
  var sh = sheet(T.LIBACCESS), idx = headerIndex(T.LIBACCESS);
  var data = sh.getDataRange().getValues();
  for (var i=1;i<data.length;i++){
    if (String(data[i][idx['Question']])===String(p.question) &&
        String(data[i][idx['Scope']])===String(scope) &&
        String(data[i][idx['Target']])===String(target)) {
      sh.getRange(i+1,idx['State']+1).setValue(state);
      sh.getRange(i+1,idx['UpdatedAt']+1).setValue(nowIso());
      return { success:true, data:{ updated:true } };
    }
  }
  appendRowByHeader(T.LIBACCESS, { 'Question':p.question,'Scope':scope,'Target':target,'State':state,'UpdatedAt':nowIso() });
  return { success:true, data:{ created:true } };
}

function libraryRemoveAccess(p) {
  var sh = sheet(T.LIBACCESS), idx = headerIndex(T.LIBACCESS);
  var data = sh.getDataRange().getValues();
  for (var i=data.length-1;i>=1;i--){
    if (String(data[i][idx['Question']])===String(p.question) &&
        String(data[i][idx['Scope']])===String(p.scope||'') &&
        String(data[i][idx['Target']])===String(p.target||'')){
      sh.deleteRow(i+1); return { success:true };
    }
  }
  return { success:false, error:'Rule not found.' };
}

function libraryLockAll(p) {
  var sh = librarySheet(), last = sh.getLastRow();
  if (last < 2) return { success:true, data:{ open:!!p.open } };
  if (sh.getLastColumn() < 22) sh.getRange(1,22).setValue('Outline');
  var val = p.open ? 'Open' : 'Locked', arr = [];
  for (var i=2;i<=last;i++) arr.push([val]);
  sh.getRange(2,22,arr.length,1).setValues(arr);
  return { success:true, data:{ open:!!p.open } };
}

function libraryToggleLock(p) {
  if (!p.rowIndex) return { success:false, error:'Thiếu rowIndex.' };
  var sh = librarySheet();
  if (sh.getLastColumn() < 22) sh.getRange(1,22).setValue('Outline');
  var cur = String(sh.getRange(p.rowIndex,22).getValue()||'').toLowerCase();
  var next = (cur==='open') ? 'Locked' : 'Open';
  sh.getRange(p.rowIndex,22).setValue(next);
  return { success:true, data:{ rowIndex:p.rowIndex, outlineUnlocked:next==='Open' } };
}

function libraryAdd(p) {
  var sh = librarySheet();
  var row = new Array(21).fill('');
  row[0]=p.testingDate||''; row[1]=p.topic||'General'; row[2]=p.taskType||'';
  row[3]=p.question||''; row[4]=p.keywords||'';
  sh.appendRow(row); return { success:true };
}

function libraryDelete(p) {
  var sh = librarySheet(), data = sh.getDataRange().getValues();
  for (var i=1;i<data.length;i++){
    if (String(data[i][3])===String(p.question)){ sh.deleteRow(i+1); return { success:true }; }
  }
  return { success:false, error:'Không tìm thấy.' };
}

// ── Backfill feedback (re-grade tool) ─────────────────────────
/*  getSubmissions: returns all rows (across modes) that have an essay
    but empty/missing Feedback — used by regrade.html to build the queue.
    Can filter by mode, class, or studentId.                            */
function getSubmissions(p) {
  var tabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
  var modes  = p.mode ? [p.mode] : ['free','homework','inclass'];
  var out    = [];
  modes.forEach(function(mode){
    var tab = tabMap[mode]; if (!tab) return;
    readAll(tab).forEach(function(r){
      if (!r['Essay'] || String(r['Essay']).trim().length < 30) return;
      if (p.class     && String(r['Class'])     !== String(p.class))      return;
      if (p.studentId && String(r['Student ID'])!== String(p.studentId))  return;
      // only rows without feedback (or with invalid JSON)
      if (p.emptyOnly !== false) {
        var fb = String(r['Feedback']||'').trim();
        var hasValidFb = false;
        if (fb.length > 10) {
          try { var o = JSON.parse(fb); hasValidFb = !!(o && o.scores); } catch(e){}
        }
        if (hasValidFb) return;
      }
      out.push({
        mode:       mode,
        rowIndex:   r._row,
        studentId:  r['Student ID'],
        name:       r['Name']       || '',
        class:      r['Class']      || '',
        topic:      r['Topic']      || '',
        topicId:    r['Topic ID']   || '',
        taskType:   r['Task Type']  || 'task2',
        attempt:    r['Attempt']    || '',
        essay:      r['Essay']      || '',
        aiGrading:  r['AI Grading'] || '',
        timestamp:  r['Timestamp']  || ''
      });
    });
  });
  // Sort oldest first so earliest attempts get re-graded first
  out.sort(function(a,b){ return new Date(a.timestamp) - new Date(b.timestamp); });
  return { success:true, data:out };
}

/*  backfillFeedback: write feedbackJson (and optionally TR/CC/LR/GRA/overall)
    into the correct row identified by mode + rowIndex.
    rowIndex comes from getSubmissions so we never have to search again.  */
function backfillFeedback(p) {
  if (!p.mode || !p.rowIndex) return { success:false, error:'Missing mode or rowIndex.' };
  var tabMap = { free:T.FREE, homework:T.HOMEWORK, inclass:T.INCLASS };
  var tab = tabMap[p.mode];
  if (!tab) return { success:false, error:'Invalid mode: ' + p.mode };
  var sh  = sheet(tab);
  var idx = headerIndex(tab);
  // Safety: confirm the row still matches the student (guard against row shift)
  var data = sh.getDataRange().getValues();
  var ri   = parseInt(p.rowIndex, 10);
  if (!data[ri-1]) return { success:false, error:'Row ' + ri + ' not found.' };
  var rowSid = String(data[ri-1][idx['Student ID']]||'').trim();
  if (p.studentId && rowSid !== String(p.studentId).trim())
    return { success:false, error:'Row mismatch: expected '+p.studentId+' found '+rowSid };
  // Write Feedback JSON
  if (idx['Feedback'] != null)
    sh.getRange(ri, idx['Feedback']+1).setValue(p.feedbackJson || '');
  // Optionally update scores + overall (if re-grading should overwrite old scores)
  if (p.updateScores) {
    if (idx['TR']          != null && p.tr  != null) sh.getRange(ri, idx['TR']+1).setValue(p.tr);
    if (idx['CC']          != null && p.cc  != null) sh.getRange(ri, idx['CC']+1).setValue(p.cc);
    if (idx['LR']          != null && p.lr  != null) sh.getRange(ri, idx['LR']+1).setValue(p.lr);
    if (idx['GRA']         != null && p.gra != null) sh.getRange(ri, idx['GRA']+1).setValue(p.gra);
    if (idx['AI Grading']  != null && p.overall != null) sh.getRange(ri, idx['AI Grading']+1).setValue(p.overall);
  }
  return { success:true, data:{ rowIndex:ri, mode:p.mode } };
}

// ═══════════════════════════════════════════════════════════
//  TRANSLATE PRACTICE
// ═══════════════════════════════════════════════════════════

function _trSessionStatus(r) {
  var now    = new Date();
  var start  = r['Session Start'] ? new Date(r['Session Start']) : null;
  var end    = r['Session End']   ? new Date(r['Session End'])   : null;
  var dl     = r['Deadline']      ? new Date(r['Deadline'])      : null;
  var active = String(r['Active']).toUpperCase() === 'TRUE';
  if (!active) return 'closed';
  if (start && !isNaN(start) && now < start) return 'upcoming';
  var closeAt = (end && !isNaN(end)) ? end : (dl && !isNaN(dl) ? dl : null);
  if (closeAt && now > closeAt) return 'closed';
  return 'open';
}

function translateCreate(p) {
  if (!p.classId || !p.title || !p.sessionStart)
    return { success:false, error:'Missing classId, title, or sessionStart.' };
  if (!p.items || !p.items.length)
    return { success:false, error:'items array required.' };
  var id = p.setId || uid('tr_');
  var existing = readFiltered(T.TR_SETS, function(r){ return String(r['Set ID'])===String(id); }, 1);
  if (existing.length) return { success:true, data:{ setId:id } };
  // Compute Session End: prefer explicit, then start + duration, then deadline
  var sessionEnd = p.sessionEnd || '';
  if (!sessionEnd && p.durationMin && parseInt(p.durationMin,10) > 0) {
    var ms = new Date(p.sessionStart).getTime();
    if (!isNaN(ms)) sessionEnd = new Date(ms + parseInt(p.durationMin,10)*60000).toISOString();
  }
  if (!sessionEnd && p.deadline) sessionEnd = p.deadline;
  appendRowByHeader(T.TR_SETS, {
    'Set ID':       id,
    'Class':        p.classId,
    'Title':        p.title,
    'Target Words': p.targetWords || '',
    'Items JSON':   JSON.stringify(p.items || []),
    'Pass Score':   p.passScore || 85,
    'Session Start':p.sessionStart,
    'Session End':  sessionEnd,
    'Deadline':     p.deadline || sessionEnd,
    'Duration Min': p.durationMin || '',
    'Shuffle':      p.shuffle !== false ? 'TRUE' : 'FALSE',
    'Active':       'TRUE',
    'CreatedAt':    nowIso(),
    'Created By':   p.teacherEmail || '',
  });
  return { success:true, data:{ setId:id } };
}

function translateUpdate(p) {
  if (!p.setId) return { success:false, error:'Missing setId.' };
  var sh = sheet(T.TR_SETS), idx = headerIndex(T.TR_SETS);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idx['Set ID']]) === String(p.setId)) {
      var fields = {
        'Active':       p.active !== undefined ? (p.active ? 'TRUE' : 'FALSE') : undefined,
        'Title':        p.title,
        'Pass Score':   p.passScore,
        'Session Start':p.sessionStart,
        'Session End':  p.sessionEnd,
        'Deadline':     p.deadline,
      };
      Object.keys(fields).forEach(function(k) {
        if (fields[k] !== undefined && idx[k] != null)
          sh.getRange(i+1, idx[k]+1).setValue(fields[k]);
      });
      return { success:true };
    }
  }
  return { success:false, error:'Set not found.' };
}

function translateDelete(p) {
  if (!p.setId) return { success:false, error:'Missing setId.' };
  var sh   = sheet(T.TR_SETS);
  var idx  = headerIndex(T.TR_SETS);
  var data = sh.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idx['Set ID']]) === String(p.setId)) {
      sh.deleteRow(i + 1);
      return { success:true };
    }
  }
  return { success:false, error:'Set not found.' };
}

function translateList(p) {
  var rows = readAll(T.TR_SETS).filter(function(r) {
    return !p.classId || String(r['Class']) === String(p.classId);
  });
  rows.sort(function(a,b){ return String(b['CreatedAt']).localeCompare(String(a['CreatedAt'])); });
  return { success:true, data: rows.map(function(r) {
    return {
      setId:        r['Set ID'],
      classId:      r['Class'],
      title:        r['Title'],
      passScore:    parseInt(r['Pass Score'],10)||85,
      sessionStart: r['Session Start'],
      sessionEnd:   r['Session End'],
      deadline:     r['Deadline'],
      createdAt:    r['CreatedAt'],
      active:       String(r['Active']).toUpperCase() === 'TRUE',
      sessionStatus:_trSessionStatus(r),
      itemCount:    (function(){ try{ return JSON.parse(r['Items JSON']||'[]').length; }catch(e){ return 0; } })(),
      shuffle:      String(r['Shuffle']).toUpperCase() !== 'FALSE',
    };
  })};
}

function translateForStudent(p) {
  if (!p.classId) return { success:false, error:'Missing classId.' };
  var rows = readAll(T.TR_SETS).filter(function(r) {
    return String(r['Active']).toUpperCase() === 'TRUE' &&
           String(r['Class']).trim() === String(p.classId).trim();
  });
  return { success:true, data: rows.map(function(r) {
    return {
      setId:        r['Set ID'],
      title:        r['Title'],
      passScore:    parseInt(r['Pass Score'],10)||85,
      sessionStart: r['Session Start'],
      sessionEnd:   r['Session End'],
      deadline:     r['Deadline'],
      itemCount:    (function(){ try{ return JSON.parse(r['Items JSON']||'[]').length; }catch(e){ return 0; } })(),
      sessionStatus:_trSessionStatus(r),
      shuffle:      String(r['Shuffle']).toUpperCase() !== 'FALSE',
    };
  })};
}

function translateGet(p) {
  if (!p.setId) return { success:false, error:'Missing setId.' };
  var r = readFiltered(T.TR_SETS, function(row){ return String(row['Set ID'])===String(p.setId); }, 1)[0];
  if (!r) return { success:false, error:'Set not found.' };
  var items = [];
  try { items = JSON.parse(r['Items JSON'] || '[]'); } catch(e) {}
  return { success:true, data:{
    setId:        r['Set ID'],
    classId:      r['Class'],
    title:        r['Title'],
    passScore:    parseInt(r['Pass Score'],10)||85,
    sessionStart: r['Session Start'],
    sessionEnd:   r['Session End'],
    deadline:     r['Deadline'],
    items:        items,
    shuffle:      String(r['Shuffle']).toUpperCase() !== 'FALSE',
    sessionStatus:_trSessionStatus(r),
  }};
}

/*  translateSaveProgress — upsert a partial row after each question passed.
    Called after every cleared item; does NOT wait for batch end.            */
function translateSaveProgress(p) {
  if (!p.studentId || !p.setId) return { success:false, error:'Missing studentId or setId.' };
  var setRow = readFiltered(T.TR_SETS, function(r){ return String(r['Set ID'])===String(p.setId); }, 1)[0];
  if (setRow && _trSessionStatus(setRow) !== 'open')
    return { success:false, error:'Session đã đóng.' };

  var clearedIds   = p.clearedItemIds || [];
  var currentIndex = Math.min(20, parseInt(p.currentIndex||clearedIds.length, 10));
  var sh  = sheet(T.TR_RESULTS);
  var idx = headerIndex(T.TR_RESULTS);
  var data = sh.getDataRange().getValues();

  // Find existing partial row for this student + set
  var partialRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idx['Student ID']]) === String(p.studentId) &&
        String(data[i][idx['Set ID']])     === String(p.setId) &&
        String(data[i][idx['Partial']])    === 'TRUE') {
      partialRow = i + 1; break;
    }
  }

  var now = nowIso();
  if (partialRow > 0) {
    sh.getRange(partialRow, idx['Timestamp']+1).setValue(now);
    sh.getRange(partialRow, idx['Cleared Item IDs JSON']+1).setValue(JSON.stringify(clearedIds));
    sh.getRange(partialRow, idx['Current Index']+1).setValue(currentIndex);
    if (p.itemScores && idx['Item Scores JSON'] != null)
      sh.getRange(partialRow, idx['Item Scores JSON']+1).setValue(JSON.stringify(p.itemScores));
  } else {
    appendRowByHeader(T.TR_RESULTS, {
      'Timestamp':'', 'Student ID':p.studentId, 'Name':p.name||'',
      'Class':p.class||'', 'Set ID':p.setId, 'Title':p.title||'',
      'Run Index':0, 'Score':'', 'Passed':'', 'Duration Sec':'',
      'Item Scores JSON':JSON.stringify(p.itemScores||[]),
      'Cleared Item IDs JSON':JSON.stringify(clearedIds),
      'Chest JSON':'[]', 'Partial':'TRUE', 'Current Index':currentIndex,
    });
    // Write timestamp separately so appendRowByHeader doesn't lose it
    var sh2=sheet(T.TR_RESULTS), idx2=headerIndex(T.TR_RESULTS);
    var lr=sh2.getLastRow();
    sh2.getRange(lr, idx2['Timestamp']+1).setValue(now);
  }
  return { success:true };
}

function translateSaveResult(p) {
  if (!p.studentId || !p.setId) return { success:false, error:'Missing studentId or setId.' };
  var setRow = readFiltered(T.TR_SETS, function(r){ return String(r['Set ID'])===String(p.setId); }, 1)[0];
  if (setRow && _trSessionStatus(setRow) !== 'open')
    return { success:false, error:'Session đã đóng — không thể nộp kết quả.' };

  var clearedIds = p.clearedItemIds || [];

  // Close any partial row for this student+set
  var sh=sheet(T.TR_RESULTS), idx=headerIndex(T.TR_RESULTS);
  if (idx['Partial'] != null) {
    var data=sh.getDataRange().getValues();
    for (var i=1;i<data.length;i++){
      if (String(data[i][idx['Student ID']])===String(p.studentId) &&
          String(data[i][idx['Set ID']])===String(p.setId) &&
          String(data[i][idx['Partial']])==='TRUE') {
        sh.getRange(i+1,idx['Partial']+1).setValue('FALSE'); break;
      }
    }
  }

  appendRowByHeader(T.TR_RESULTS, {
    'Timestamp':             nowIso(),
    'Student ID':            p.studentId,
    'Name':                  p.name || '',
    'Class':                 p.class || '',
    'Set ID':                p.setId,
    'Title':                 p.title || '',
    'Run Index':             p.runIndex || 1,
    'Score':                 p.score || 0,
    'Passed':                p.passed ? 'TRUE' : 'FALSE',
    'Duration Sec':          p.durationSec || 0,
    'Item Scores JSON':      JSON.stringify(p.itemScores || []),
    'Cleared Item IDs JSON': JSON.stringify(clearedIds),
    'Chest JSON':            JSON.stringify(p.chest || []),
    'Partial':               'FALSE',
    'Current Index':         Math.min(20, clearedIds.length),
  });
  return { success:true };
}

function translateStats(p) {
  if (!p.setId) return { success:false, error:'Missing setId.' };

  var rows = readRecent(T.TR_RESULTS, 600, function(r){
    return String(r['Set ID']) === String(p.setId);
  }, 1200);

  var students = {};

  rows.forEach(function(r) {
    var sid       = String(r['Student ID']).trim();
    var isPartial = String(r['Partial']).toUpperCase() === 'TRUE';
    if (!sid) return;

    if (!students[sid]) students[sid] = {
      studentId:sid, name:r['Name'],
      runs:0, bestScore:0, lastScore:0,
      clearedCount:0, currentIndex:0, inProgress:false,
      lastTimestamp:'', _partialTs:'',
    };
    var s = students[sid];

    if (isPartial) {
      var ts = String(r['Timestamp']);
      if (ts > s._partialTs) {
        s._partialTs   = ts;
        s.currentIndex = parseInt(r['Current Index']||0, 10);
        s.inProgress   = true;
        var cl=[]; try{cl=JSON.parse(r['Cleared Item IDs JSON']||'[]');}catch(e){}
        if (cl.length > s.clearedCount) s.clearedCount = cl.length;
        if (ts > s.lastTimestamp) s.lastTimestamp = ts;
      }
    } else {
      s.runs++;
      var sc = parseFloat(r['Score'])||0;
      if (sc > s.bestScore) s.bestScore = sc;
      var ts2 = String(r['Timestamp']);
      if (ts2 > s.lastTimestamp) { s.lastTimestamp = ts2; s.lastScore = sc; }
      var cl2=[]; try{cl2=JSON.parse(r['Cleared Item IDs JSON']||'[]');}catch(e){}
      if (cl2.length > s.clearedCount) s.clearedCount = cl2.length;
      // complete run is newer than partial → mark not in progress
      if (ts2 >= s._partialTs) {
        s.inProgress   = false;
        s.currentIndex = Math.min(20, cl2.length);
      }
    }
  });

  var stArr = Object.keys(students).map(function(k){
    var s = students[k];
    delete s._partialTs;
    s.progressLabel = s.clearedCount + '/20';
    return s;
  });

  var completeRows = rows.filter(function(r){ return String(r['Partial']).toUpperCase() !== 'TRUE'; });
  var totalScore   = completeRows.reduce(function(a,r){ return a+(parseFloat(r['Score'])||0); }, 0);

  return { success:true, data:{
    studentCount:    stArr.length,
    runsCount:       completeRows.length,
    avgScore:        completeRows.length ? Math.round(totalScore/completeRows.length) : 0,
    avgCleared:      stArr.length ? Math.round(stArr.reduce(function(a,s){return a+s.clearedCount;},0)/stArr.length) : 0,
    inProgressCount: stArr.filter(function(s){return s.inProgress;}).length,
    students:        stArr.sort(function(a,b){ return b.lastTimestamp.localeCompare(a.lastTimestamp); }),
  }};
}


function translateMyProgress(p) {
  if (!p.studentId || !p.setId) return { success:false, error:'Missing fields.' };
  var rows = readRecent(T.TR_RESULTS, 50, function(r){
    return String(r['Set ID'])===String(p.setId) &&
           String(r['Student ID']).trim()===String(p.studentId).trim();
  }, 200);
  rows.sort(function(a,b){ return String(a['Timestamp']).localeCompare(String(b['Timestamp'])); });
  var clearedSet = {}, bestScore=0, lastScore=0;
  rows.forEach(function(r) {
    var sc = parseFloat(r['Score'])||0;
    if (sc > bestScore) bestScore = sc;
    lastScore = sc;
    var cleared = []; try { cleared = JSON.parse(r['Cleared Item IDs JSON']||'[]'); } catch(e){}
    cleared.forEach(function(id){ clearedSet[id]=true; });
  });
  return { success:true, data:{
    runs:           rows.length,
    clearedItemIds: Object.keys(clearedSet),
    bestScore:      bestScore,
    lastScore:      lastScore,
    nextRunIndex:   rows.length + 1,
  }};
}
