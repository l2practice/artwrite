/*───────────────────────────────────────────────────────────────
  ArticuWrite — Firebase data layer (fbdata.js)

  AW.api(action, payload) lands here when Firebase is switched on
  (AW_FIREBASE.config.apiKey set in aw-common.js). Each action below
  answers from Firestore in the SAME shape the old Apps Script returned,
  so the pages did not have to change. Three kinds of actions:

    ACTIONS      answered here, straight from Firestore
    GAS_FB       Apps Script, Firebase edition (Firebase.gs): accounts,
                 Google Docs / Sheets export — needs admin rights or
                 Google services. Sent with the caller's ID token.
    everything   still on the Google Sheet (Live, annotations, queries,
    else         boards, translate, library, vocab) until it moves over.

  Collections (see firestore.rules):
    users/{uid}          role 'student'|'teacher', studentId, name, classId,
                         teacherUid (students), birthdate, phone, email,
                         archived, createdAt
    loginIndex/{sha256}  sha256(lowercased email) → { sid }   (email sign-in)
    classes/{classId}    classId, className, year, semester, teacherUid,
                         teacherEmail, aiEnabled, archived, createdAt, …
    assignments/{topicId} topicId, mode, classId, teacherUid, topic, prompt,
                         taskType, chartImageId, minWords, writingType,
                         aiNotes, requiredAttempts, durationMin, deadline,
                         active, dataStatus, createdAt
    progress/{uid}       ONE doc per student: studentId, name, classId,
                         teacherUid, items { subId: light row (scores) },
                         tscore { 'mode|topicId': teacher score }
    essays/{subId}       essay + feedback JSON of one attempt (loaded only
                         when someone opens that attempt)
───────────────────────────────────────────────────────────────*/
(function () {
'use strict';

const CFG = window.AW_FIREBASE || {};
const STUDENT_DOMAIN = CFG.studentDomain || 'students.articuwrite.app';

let fs = null, auth = null, FV = null, FP = null, rtdb = null, _authReady = null;
function init() {
  if (fs) return;
  firebase.initializeApp(window.__FB_CONFIG || CFG.config);
  fs = firebase.firestore();
  auth = firebase.auth();
  rtdb = firebase.database();
  if (window.__FB_EMU) {   // tests only
    auth.useEmulator('http://127.0.0.1:9099'); fs.useEmulator('127.0.0.1', 8080); rtdb.useEmulator('127.0.0.1', 9000);
  }
  FV = firebase.firestore.FieldValue;
  FP = firebase.firestore.FieldPath;
  _authReady = new Promise(res => { const off = auth.onAuthStateChanged(u => { off(); res(u); }); });
}
function authReady() { init(); return _authReady; }

// ── helpers ─────────────────────────────────
// Firebase refuses passwords under 6 characters; older accounts may have one.
// Every place that sets or checks a password pads it the same way (Firebase.gs too).
function authPw(p) { p = String(p == null ? '' : p); return p.length >= 6 ? p : (p + '______').slice(0, 6); }
function loginEmailFor(studentId) {
  return String(studentId).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_') + '@' + STUDENT_DOMAIN;
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function genId(n) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < (n || 10); i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
const ok   = data => (data === undefined ? { success: true } : { success: true, data });
const fail = (msg, extra) => Object.assign({ success: false, error: msg }, extra || {});
const str  = v => String(v == null ? '' : v).trim();
const low  = v => str(v).toLowerCase();
const docs = qs => qs.docs.map(d => Object.assign({ _id: d.id }, d.data()));
const nowIso = () => new Date().toISOString();
const ms = v => { const t = new Date(v).getTime(); return isNaN(t) ? 0 : t; };
// Map keys become Firestore field names: keep them to [A-Za-z0-9_].
const safeKey = v => str(v).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120);
const tsKey = (mode, topicId) => mode + '|' + str(topicId);

// ── short-lived memo (one page visit re-reads the same lists a lot) ──
const _memo = {};
async function memo(key, ttl, fn) {
  const h = _memo[key];
  if (h && Date.now() - h.t < ttl) return h.v;
  const v = await fn();
  _memo[key] = { t: Date.now(), v };
  return v;
}
function forget(prefix) { Object.keys(_memo).forEach(k => { if (!prefix || k.indexOf(prefix) === 0) delete _memo[k]; }); }

// ── current user ────────────────────────────
let _me = null;
async function me() {
  await authReady();
  const u = auth.currentUser;
  if (!u) throw new Error('SESSION_EXPIRED');
  if (_me && _me.uid === u.uid) return _me;
  const d = await fs.doc('users/' + u.uid).get();
  if (!d.exists) throw new Error('SESSION_EXPIRED');
  const v = Object.assign({ uid: u.uid }, d.data());
  // A student of an archived class is shut out, also from a session kept
  // signed in before the class was archived.
  if (v.role === 'student') {
    const c = await fs.doc('classes/' + v.classId).get();
    if (c.exists && c.data().archived) { await signOut(); throw new Error('CLASS_ARCHIVED'); }
  }
  return (_me = v);
}
const CLOSED_MSG = 'Lớp của bạn đã kết thúc học kỳ nên tài khoản đã khoá. Liên hệ giảng viên nếu bạn học lại lớp này.';
async function teacher() {
  const t = await me();
  if (t.role !== 'teacher') throw Object.assign(new Error('Chỉ giáo viên mới dùng được chức năng này.'), { code: 'not-teacher' });
  return t;
}
async function setPersistence(remember) {
  const P = firebase.auth.Auth.Persistence;
  try { await auth.setPersistence(remember ? P.LOCAL : P.SESSION); } catch (e) {}
}

// ── teacher-side cached lists ───────────────
const myClasses   = t => memo('classes', 60000, async () => docs(await fs.collection('classes').where('teacherUid', '==', t.uid).get()));
const myStudents  = t => memo('students', 60000, async () => docs(await fs.collection('users').where('teacherUid', '==', t.uid).get()));
const classAssign = (t, classId) => memo('assign|' + classId, 60000, async () =>
  docs(await fs.collection('assignments').where('classId', '==', classId).get()));
const classProgress = (t, classId) => memo('progress|' + classId, 20000, async () =>
  docs(await fs.collection('progress').where('teacherUid', '==', t.uid).where('classId', '==', classId).get()));
async function studentByIdForTeacher(t, studentId) {
  const hit = (await myStudents(t)).find(s => str(s.studentId) === str(studentId));
  if (hit) return hit;
  const qs = await fs.collection('users').where('teacherUid', '==', t.uid).where('studentId', '==', str(studentId)).limit(1).get();
  return qs.empty ? null : Object.assign({ _id: qs.docs[0].id }, qs.docs[0].data());
}
function itemsOf(prog) { return Object.values((prog && prog.items) || {}); }
function byTime(a, b) { return ms(a.timestamp) - ms(b.timestamp); }
// Attempts of one task in their real order: the attempt number first, the
// time only as a tie-break. Sorting by time alone shuffles attempts whose
// timestamps are missing or equal (rows copied over from the Sheet).
function byAttempt(a, b) { return ((Number(a.attempt) || 0) - (Number(b.attempt) || 0)) || byTime(a, b); }

// ════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════
async function studentLogin(p) {
  init();
  const id = str(p.studentId || p.login);
  if (!id) return fail('Vui lòng nhập Student ID hoặc email.');
  let sid = id;
  if (id.indexOf('@') >= 0) {
    const idx = await fs.doc('loginIndex/' + await sha256Hex(low(id))).get();
    if (!idx.exists) return fail('Sai Student ID/email hoặc mật khẩu.');
    if (idx.data().multi) return fail('Email này gắn với nhiều tài khoản. Hãy đăng nhập bằng Student ID.');
    sid = idx.data().sid;
  }
  await setPersistence(!!p.remember);
  try { await auth.signInWithEmailAndPassword(loginEmailFor(sid), authPw(p.password)); }
  catch (e) {
    const c = e.code || '';
    if (/too-many-requests/.test(c)) return fail('Đăng nhập sai quá nhiều lần. Vui lòng đợi vài phút.');
    if (/network/.test(c)) return fail('Lỗi mạng — kiểm tra kết nối và thử lại.');
    if (/user-disabled/.test(c)) return fail(CLOSED_MSG);
    return fail('Sai Student ID/email hoặc mật khẩu.');
  }
  _me = null; forget();
  let u;
  try { u = await me(); }
  catch (e) { if (e.message === 'CLASS_ARCHIVED') return fail(CLOSED_MSG); throw e; }
  if (u.role !== 'student' || u.archived) { await signOut(); return fail('Sai Student ID/email hoặc mật khẩu.'); }
  return ok({ studentId: u.studentId, name: u.name, class: u.classId, email: u.email || '' });
}

async function teacherLogin(p) {
  init();
  const email = low(p.email);
  if (!email || !p.password) return fail('Sai email hoặc mật khẩu.');
  await setPersistence(!!p.remember);
  try { await auth.signInWithEmailAndPassword(email, authPw(p.password)); }
  catch (e) {
    if (/too-many-requests/.test(e.code || '')) return fail('Đăng nhập sai quá nhiều lần. Vui lòng đợi vài phút.');
    return fail('Sai email hoặc mật khẩu.');
  }
  _me = null; forget();
  const u = await me().catch(() => null);
  if (!u || u.role !== 'teacher') { await signOut(); return fail('Sai email hoặc mật khẩu.'); }
  return ok({ name: u.name || '', email: u.email || email, class: '' });
}

async function signOut() { init(); _me = null; forget(); try { await auth.signOut(); } catch (e) {} }

async function changePassword(p) {
  if (!p.oldPass || !p.newPass) return fail('Thiếu mật khẩu.');
  await me();
  const u = auth.currentUser;
  try { await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, authPw(p.oldPass))); }
  catch (e) { return fail('Sai mật khẩu hiện tại.'); }
  await u.updatePassword(authPw(p.newPass));
  return ok();
}

// Accounts are created by Apps Script (admin), then we sign in here.
async function studentSignup(p) {
  const res = await gas('fb.studentSignup', p, true);
  if (!res || !res.success) return res;
  await setPersistence(false);
  try { await auth.signInWithEmailAndPassword(loginEmailFor(p.studentId), authPw(p.password)); } catch (e) {}
  _me = null; forget();
  return res;
}
async function teacherSignup(p) {
  const res = await gas('fb.teacherSignup', p, true);
  if (!res || !res.success) return res;
  await setPersistence(false);
  try { await auth.signInWithEmailAndPassword(low(p.email), authPw(p.password)); } catch (e) {}
  _me = null; forget();
  return res;
}

// ════════════════════════════════════════════
// CLASSES / STUDENTS
// ════════════════════════════════════════════
function classRow(c) {
  return { classId: c.classId || c._id, className: c.className, year: c.year || '', semester: c.semester || '',
           teacherEmail: c.teacherEmail || '', aiEnabled: c.aiEnabled !== false };
}
async function classCreate(p) {
  const t = await teacher();
  if (!str(p.className)) return fail('Thiếu tên lớp.');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let k = 0; k < 20; k++) {
    id = 'AW-'; for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
    if (!(await fs.doc('classes/' + id).get()).exists) break;
  }
  await fs.doc('classes/' + id).set({
    classId: id, className: str(p.className), year: str(p.year), semester: str(p.semester),
    teacherUid: t.uid, teacherEmail: t.email || '', aiEnabled: true, archived: false, createdAt: nowIso()
  });
  await rtdb.ref('classOwner/' + id).set(t.uid);   // lets this teacher watch the class Live
  forget('classes');
  return ok({ classId: id, className: p.className, year: p.year, semester: p.semester });
}
async function classList() {
  const t = await teacher();
  const rows = (await myClasses(t)).filter(c => !c.archived)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return ok(rows.map(classRow));
}
async function classGet(p) {
  await me();
  const d = await fs.doc('classes/' + str(p.classId)).get();
  if (!d.exists) return fail('Mã lớp không tồn tại.');
  const r = classRow(Object.assign({ _id: d.id }, d.data()));
  delete r.teacherEmail;
  return ok(r);
}
async function classPatch(classId, patch) {
  const t = await teacher();
  const ref = fs.doc('classes/' + str(classId));
  const d = await ref.get();
  if (!d.exists || d.data().teacherUid !== t.uid) return fail('Class not found.');
  await ref.update(patch);
  forget('classes');
  return null;
}
async function classArchive(p) {
  if (!p.classId) return fail('Missing classId.');
  const e = await classPatch(p.classId, p.archived === false ? { archived: false, archivedAt: '' } : { archived: true, archivedAt: nowIso() });
  return e || ok();
}
async function classSetAiEnabled(p) {
  if (!p.classId) return fail('Missing classId.');
  const e = await classPatch(p.classId, { aiEnabled: p.enabled !== false });
  return e || ok({ classId: p.classId, aiEnabled: p.enabled !== false });
}
async function classListArchived() {
  const t = await teacher();
  const [classes, students] = await Promise.all([myClasses(t), myStudents(t)]);
  const counts = {};
  students.forEach(s => { if (!s.archived) counts[s.classId] = (counts[s.classId] || 0) + 1; });
  return ok(classes.filter(c => c.archived).map(c => ({
    classId: c.classId, className: c.className, year: c.year || '', semester: c.semester || '',
    archivedAt: c.archivedAt || '', reportUrl: c.lastReport || '', students: counts[c.classId] || 0
  })));
}
async function getRoster(p) {
  const t = await teacher();
  const rows = (await myStudents(t)).filter(s => !s.archived && (!p.class || s.classId === str(p.class)));
  rows.sort((a, b) => String(a.studentId).localeCompare(String(b.studentId)));
  return ok(rows.map(s => ({ studentId: s.studentId, name: s.name, email: s.email || '', phone: s.phone || '',
                             birthdate: s.birthdate || '' })));
}
async function archiveStudent(p) {
  if (!p.studentId) return fail('Missing studentId.');
  const t = await teacher();
  const s = await studentByIdForTeacher(t, p.studentId);
  if (!s) return fail('Student not found.');
  await fs.doc('users/' + s._id).update({ archived: p.archived !== false });
  forget('students');
  return ok();
}

// ════════════════════════════════════════════
// ASSIGNMENTS
// ════════════════════════════════════════════
// Deadlines are 'YYYY-MM-DDTHH:MM:00' (local time); older ones are a bare
// date, which means the end of that day.
function deadlineMs(d) {
  d = str(d);
  if (!d) return 0;
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? ms(d + 'T23:59:59') : ms(d);
}
// A student's own deadline: the class deadline, or the extension the
// teacher gave them (extensions: { studentKey: deadline }).
function myDeadline(a, u) {
  const ext = u && u.role === 'student' && a.extensions ? a.extensions[safeKey(u.studentId)] : '';
  return ext || a.deadline || '';
}
function isPast(a, u) {
  const d = myDeadline(a, u);
  return a.mode === 'homework' && !!d && Date.now() > deadlineMs(d);
}
function assignOut(a, u) {
  const out = {
    topicId: a.topicId || a._id, mode: a.mode, class: a.classId, topic: a.topic, prompt: a.prompt,
    taskType: a.taskType || 'task2', chartImageId: a.chartImageId || '', aiNotes: a.aiNotes || '',
    requiredAttempts: a.requiredAttempts, durationMin: a.durationMin, deadline: a.deadline,
    dataStatus: a.dataStatus || ''
  };
  if (u && u.role === 'student') {
    out.myDeadline = myDeadline(a, u);
    out.extended = out.myDeadline !== (a.deadline || '');
    out.isPastDeadline = isPast(a, u);
  } else {
    out.extensions = a.extensions || {};
  }
  return out;
}
async function getAssignments(p) {
  const u = await me();
  const classId = str(p.class || (u.role === 'student' ? u.classId : ''));
  if (!classId) return ok([]);
  let rows = u.role === 'teacher'
    ? await classAssign(u, classId)
    : docs(await fs.collection('assignments').where('classId', '==', classId).get());
  rows = rows.filter(a => a.active !== false &&
    (!p.mode || a.mode === p.mode) && (!p.taskType || (a.taskType || 'task2') === p.taskType))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return ok(rows.map(a => assignOut(a, u)));
}
async function getPrompt(p) {
  if (!p.topicId) return fail('Missing topicId.');
  const u = await me();
  const d = await fs.doc('assignments/' + str(p.topicId)).get();
  if (!d.exists) return ok({ prompt: '', topic: '', taskType: 'task2', chartImageId: '' });
  const a = d.data();
  return ok({ prompt: a.prompt || '', topic: a.topic || '', taskType: a.taskType || 'task2',
              chartImageId: a.chartImageId || '', minWords: a.minWords || 0,
              writingType: a.writingType || 'full_essay', aiNotes: a.aiNotes || '', durationMin: a.durationMin || '',
              mode: a.mode || '', deadline: myDeadline(a, u), isPastDeadline: isPast(a, u), dataStatus: a.dataStatus || '' });
}
async function createAssignment(p) {
  const t = await teacher();
  const classId = str(p.class);
  const cls = (await myClasses(t)).find(c => c.classId === classId);
  if (!cls) return fail('Lớp không thuộc tài khoản của bạn.');
  const topicId = safeKey(p.topicId) || ('A' + Date.now().toString(36) + genId(4));
  const taskType = p.taskType === 'task1' ? 'task1' : 'task2';
  await fs.doc('assignments/' + topicId).set({
    topicId, mode: p.mode || 'homework', classId, teacherUid: t.uid, topic: p.topic || '', prompt: p.prompt || '',
    taskType, chartImageId: p.chartImageId || '', minWords: Number(p.minWords) || 0,
    writingType: p.writingType || 'full_essay', aiNotes: p.aiNotes || '',
    requiredAttempts: Number(p.requiredAttempts) || 1, durationMin: p.durationMin || '',
    deadline: p.deadline || '', createdAt: nowIso(), active: true, dataStatus: ''
  });
  forget('assign|');
  return ok({ topicId, taskType });
}
async function updateAssignment(p) {
  if (!p.topicId) return fail('Missing topicId.');
  await teacher();
  const ref = fs.doc('assignments/' + str(p.topicId));
  if (!(await ref.get()).exists) return fail('Assignment not found.');
  const patch = {};
  ['topic', 'prompt', 'deadline', 'aiNotes'].forEach(k => { if (p[k] != null) patch[k] = p[k]; });
  if (p.minWords != null) patch.minWords = Number(p.minWords) || 0;
  if (p.requiredAttempts != null) patch.requiredAttempts = Number(p.requiredAttempts) || 1;
  await ref.update(patch);
  forget('assign|');
  return ok();
}
async function deleteAssignment(p) {
  if (!p.topicId) return fail('Missing topicId.');
  await teacher();
  const ref = fs.doc('assignments/' + str(p.topicId));
  if (!(await ref.get()).exists) return fail('Assignment not found.');
  await ref.update({ active: false });     // soft delete: submissions keep their topic
  forget('assign|');
  return ok();
}

// ════════════════════════════════════════════
// SUBMISSIONS
// ════════════════════════════════════════════
/*  One transaction: numbers the attempt from the student's own progress doc,
    so two saves can never take the same number, and a re-sent save (same
    submissionId) is recognised instead of counted twice.                    */
async function saveResult(p) {
  const u = await me();
  if (u.role !== 'student') return fail('Chỉ sinh viên mới nộp bài được.');
  const mode = p.mode;
  if (['free', 'homework', 'inclass'].indexOf(mode) < 0) return fail('Mode không hợp lệ: ' + mode);
  const topicId = str(p.topicId);
  const subId = safeKey(p.submissionId) || (safeKey(u.studentId) + '_' + Date.now().toString(36) + '_' + genId(5));

  let asg = null;
  if (mode !== 'free' && topicId) {
    const d = await fs.doc('assignments/' + topicId).get();
    asg = d.exists ? d.data() : null;
  }
  const progRef = fs.doc('progress/' + u.uid), essayRef = fs.doc('essays/' + subId);
  return fs.runTransaction(async tx => {
    const snap = await tx.get(progRef);
    const items = (snap.exists && snap.data().items) || {};
    if (items[subId]) return ok({ attempt: Number(items[subId].attempt) || 1, topicId: items[subId].topicId || topicId, duplicate: true });
    const prior = Object.values(items).filter(r => r.mode === mode && str(r.topicId) === topicId).length;
    if (mode !== 'free' && prior >= 3)
      return fail('Bạn đã viết đủ 3 lần cho bài này.', { locked: true, attempt: prior });
    if (asg && asg.dataStatus)
      return fail('Bài này đã được giáo viên lưu trữ (Clear Data), không nộp thêm được.', { locked: true, attempt: prior });
    // The page closes an overdue task; two hours of grace lets an essay that
    // was started before the deadline (homework is capped at 60 min) be sent.
    const dlStr = asg ? myDeadline(asg, u) : '';
    if (asg && asg.mode === 'homework' && dlStr) {
      const dl = deadlineMs(dlStr);
      if (dl && Date.now() > dl + 2 * 3600000)
        return fail('Đã quá hạn nộp bài (deadline: ' + dlStr + '). Hãy xin giáo viên gia hạn.', { locked: true, overdue: true, attempt: prior });
    }
    const attempt = prior + 1, ts = nowIso();
    const light = {
      id: subId, mode, topicId, topic: p.topic || '', taskType: p.taskType || 'task2', classId: u.classId,
      timestamp: ts, startTime: p.startTime || '', finishTime: p.finishTime || '', duration: p.duration || '',
      tr: p.tr != null ? p.tr : '', cc: p.cc != null ? p.cc : '', lr: p.lr != null ? p.lr : '', gra: p.gra != null ? p.gra : '',
      aiGrading: p.aiGrading != null ? p.aiGrading : '', teacherGrading: p.teacherGrading != null ? p.teacherGrading : '',
      attempt, hasFb: String(p.feedback || '').length > 10, noAI: !!p.noAI, docLink: p.docLink || ''
    };
    tx.set(essayRef, { uid: u.uid, studentId: u.studentId, classId: u.classId, teacherUid: u.teacherUid || '',
                       mode, topicId, timestamp: ts, essay: String(p.essay || ''), feedback: String(p.feedback || '') });
    const base = { studentId: u.studentId, name: u.name || '', classId: u.classId, teacherUid: u.teacherUid || '' };
    if (snap.exists) tx.update(progRef, Object.assign(base, { ['items.' + subId]: light }));
    else tx.set(progRef, Object.assign(base, { items: { [subId]: light }, tscore: {} }));
    return ok({ attempt, topicId });
  });
}

async function getAttemptCount(p) {
  const u = await me();
  const d = await fs.doc('progress/' + u.uid).get();
  const n = itemsOf(d.exists ? d.data() : null).filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).length;
  return ok({ count: n });
}

async function getEssay(p) {
  await me();
  const d = await fs.doc('essays/' + safeKey(p.id)).get();
  if (!d.exists) return fail('Không tìm thấy bài viết.');
  return ok({ essay: d.data().essay || '', feedback: d.data().feedback || '' });
}

function groupKey(r) { return r.mode + '||' + str(r.topicId); }
function writeOut(r) {
  return { attempt: Number(r.attempt) || '', timestamp: r.timestamp, startTime: r.startTime, finishTime: r.finishTime, duration: r.duration,
           overall: r.aiGrading, teacher: r.teacherGrading, tr: r.tr || '', cc: r.cc || '', lr: r.lr || '', gra: r.gra || '' };
}
function bestOf(writes) {
  let best = null;
  writes.forEach(w => { const v = parseFloat(w.overall); if (!isNaN(v) && (best === null || v > best)) best = v; });
  return best;
}

async function getMyResults(p) {
  const u = await me();
  const [progSnap, classSnap] = await Promise.all([
    fs.doc('progress/' + u.uid).get(), fs.doc('classes/' + u.classId).get()]);
  const prog = progSnap.exists ? progSnap.data() : {};
  const asn = {};
  if (u.classId) docs(await fs.collection('assignments').where('classId', '==', u.classId).get())
    .forEach(a => { asn[a.topicId || a._id] = a; });
  const className = classSnap.exists ? (classSnap.data().className || u.classId) : u.classId;
  const groups = {};
  itemsOf(prog).filter(r => !p.mode || r.mode === p.mode).forEach(r => {
    const k = groupKey(r), a = asn[r.topicId] || {};
    if (!groups[k]) {
      let ts = (prog.tscore || {})[tsKey(r.mode, r.topicId)] || null;
      if (ts) { ts = Object.assign({}, ts); delete ts.note; }
      groups[k] = { mode: r.mode, topic: r.topic, topicId: r.topicId, taskType: r.taskType || a.taskType || 'task2',
        chartImageId: a.chartImageId || '', prompt: a.prompt || '', minWords: a.minWords || 0,
        className: r.classId === u.classId ? className : (r.classId || ''),
        assignedDate: a.createdAt || r.timestamp, deadline: a.deadline || '', writes: [], teacherScore: ts };
    }
    if (r.cleared) { groups[k].cleared = true; groups[k].docUrl = r.docUrl || ''; }
    // essay + feedback load on demand (write.getEssay) — keeps this read light
    groups[k].writes.push(Object.assign(writeOut(r), { attempt: r.attempt, essayId: r.id }));
  });
  const out = Object.values(groups).map(g => {
    g.writes.sort(byAttempt);
    const best = bestOf(g.writes);
    g.bestResult = best !== null ? best : '';
    g.attemptCount = g.writes.length;
    g.latestTime = g.writes.length ? g.writes[g.writes.length - 1].timestamp : '';
    return g;
  }).sort((a, b) => ms(b.latestTime) - ms(a.latestTime));
  return ok(out);
}

async function getResults(p) {
  const t = await teacher();
  const classId = str(p.class);
  const [classes, progs, asg] = await Promise.all([myClasses(t), classProgress(t, classId), classAssign(t, classId)]);
  const classNames = {}, prompts = {};
  classes.forEach(c => { classNames[c.classId] = c.className; });
  asg.forEach(a => { prompts[a.topicId] = { prompt: a.prompt, taskType: a.taskType || 'task2', minWords: Number(a.minWords) || 0 }; });
  const mode = ['free', 'homework', 'inclass'].indexOf(p.mode) >= 0 ? p.mode : 'free';
  const cutoff = Number(p.days) > 0 ? Date.now() - Number(p.days) * 86400000 : 0;
  const groups = {};
  progs.forEach(prog => {
    itemsOf(prog).forEach(r => {
      if (r.mode !== mode || !r.topicId) return;
      if (p.topicId && str(r.topicId) !== str(p.topicId)) return;
      if (cutoff && ms(r.timestamp) < cutoff) return;
      const key = prog.studentId + '||' + r.topicId, pr = prompts[r.topicId] || {};
      if (!groups[key]) groups[key] = {
        studentId: prog.studentId, name: prog.name, class: r.classId || prog.classId,
        className: classNames[r.classId || prog.classId] || r.classId || '',
        topic: r.topic, topicId: r.topicId, taskType: r.taskType || pr.taskType || 'task2',
        prompt: pr.prompt || '', minWords: pr.minWords || 0, writes: [],
        teacherScore: (prog.tscore || {})[tsKey(mode, r.topicId)] || null
      };
      if (r.cleared) { groups[key].cleared = true; groups[key].docUrl = r.docUrl || ''; }
      groups[key].writes.push(Object.assign(writeOut(r), { hasAiFeedback: !!r.hasFb }));
    });
  });
  return ok(Object.values(groups).map(g => {
    g.writes.sort(byAttempt);
    const best = bestOf(g.writes);
    g.bestResult = best !== null ? best : '';
    g.attemptCount = g.writes.length;
    return g;
  }));
}

async function studentProgress(t, studentId) {
  const s = await studentByIdForTeacher(t, studentId);
  if (!s) return null;
  const d = await fs.doc('progress/' + s._id).get();
  return { uid: s._id, ref: d.ref, data: d.exists ? d.data() : { items: {}, tscore: {} } };
}
async function getAttemptDetail(p) {
  if (!p.studentId || !p.topicId || !p.mode) return fail('Missing params.');
  const t = await teacher();
  const sp = await studentProgress(t, p.studentId);
  if (!sp) return ok([]);
  const rows = itemsOf(sp.data).filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).sort(byAttempt);
  const es = await Promise.all(rows.map(r => fs.doc('essays/' + r.id).get().catch(() => null)));
  return ok(rows.map((r, i) => {
    const e = es[i] && es[i].exists ? es[i].data() : {};
    return { attempt: i + 1, timestamp: r.timestamp, duration: r.duration, overall: r.aiGrading,
             tr: r.tr || '', cc: r.cc || '', lr: r.lr || '', gra: r.gra || '',
             essay: e.essay || '', feedback: e.feedback || '' };
  }));
}

// Teacher deletes one attempt so the student can redo it. Remaining attempts
// of that student+topic are renumbered 1..n in time order.
async function deleteAttempt(p) {
  if (!p.studentId || !p.topicId || !p.mode || !p.timestamp) return fail('Thiếu thông tin bài cần xoá.');
  const t = await teacher();
  const s = await studentByIdForTeacher(t, p.studentId);
  if (!s) return fail('Không tìm thấy bài này (có thể đã bị xoá).');
  const ref = fs.doc('progress/' + s._id), target = ms(p.timestamp);
  const res = await fs.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const same = itemsOf(snap.exists ? snap.data() : null)
      .filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).sort(byAttempt);
    const hit = same.find(r => Math.abs(ms(r.timestamp) - target) < 1000 || String(r.timestamp) === String(p.timestamp));
    if (!hit) return fail('Không tìm thấy bài này (có thể đã bị xoá).');
    const args = [new FP('items', hit.id), FV.delete()];
    same.filter(r => r.id !== hit.id).forEach((r, k) => { args.push(new FP('items', r.id, 'attempt'), k + 1); });
    tx.update(ref, ...args);
    tx.delete(fs.doc('essays/' + hit.id));
    return ok();
  });
  forget('progress|');
  return res;
}

async function saveManualScore(p) {
  if (['free', 'homework', 'inclass'].indexOf(p.mode) < 0) return fail('Invalid mode.');
  const t = await teacher();
  const sp = await studentProgress(t, p.studentId);
  const rows = sp ? itemsOf(sp.data).filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).sort(byAttempt) : [];
  if (!rows.length) return fail('Submission not found.');
  const score = { tr: p.tr || '', cc: p.cc || '', lr: p.lr || '', gra: p.gra || '', overall: p.overall || '',
                  note: p.note || '', privateNote: p.privateNote || '', gradedAt: nowIso() };
  const args = [new FP('tscore', tsKey(p.mode, p.topicId)), score];
  if (p.overall) args.push(new FP('items', rows[rows.length - 1].id, 'teacherGrading'), p.overall);
  await sp.ref.update(...args);
  forget('progress|');
  return ok();
}

async function getOverview(p) {
  const t = await teacher();
  const classId = str(p.class);
  const [students, asg] = await Promise.all([myStudents(t), classId ? classAssign(t, classId) : Promise.resolve([])]);
  const active = asg.filter(a => a.active !== false);
  return ok({
    activeStudents: students.filter(s => !classId || s.classId === classId).length,
    totalAssignments: active.length,
    hwAssignments: active.filter(a => a.mode === 'homework').length,
    icAssignments: active.filter(a => a.mode === 'inclass').length,
    avgScore: '—', totalEssays: '—', feedbackPending: '—'
  });
}


// ════════════════════════════════════════════
// LIVE (Realtime Database) — pushed to the teacher the moment it changes
//   live/{classId}/{uid}        status, word count, hand, topic  (small, often)
//   liveText/{classId}/{uid}    the essay text being written      (read when opened)
//   annotations/{classId}/{uid}/{topicKey}/{pushKey}  teacher feedback pushes
//   classOwner/{classId}        teacherUid — who may watch / annotate the class
// Status shown: 'Submitted' stays; otherwise a closed tab (online=false) or
// no heartbeat for 45 s shows as 'Offline'. Rows older than 8 h are hidden.
// ════════════════════════════════════════════
const LIVE_STALE_MS = 45000, LIVE_WINDOW_MS = 8 * 3600000;
const rkey = v => str(v).replace(/[.#$\[\]\/]/g, '_') || '_';
let _offset = 0, _offsetWatch = false;
function serverNow() {
  if (!_offsetWatch) { _offsetWatch = true; rtdb.ref('.info/serverTimeOffset').on('value', s => { _offset = s.val() || 0; }); }
  return Date.now() + _offset;
}
function liveRow(uid, n, now) {
  let status = n.status || 'Writing';
  const age = now - (Number(n.updated) || 0);
  if (status !== 'Submitted' && (n.online === false || age > LIVE_STALE_MS)) status = 'Offline';
  return { uid, studentId: n.studentId, name: n.name, class: n.classId, topicId: n.topicId || '', topic: n.topic || '',
           mode: n.mode || '', status, wordCount: n.wordCount || 0, raisedHand: !!n.raisedHand,
           hasFeedback: !!n.hasFeedback, updated: n.updated ? new Date(Number(n.updated)).toISOString() : '' };
}
function liveRows(val) {
  const now = serverNow();
  return Object.keys(val || {}).map(uid => ({ uid, n: val[uid] || {} }))
    .filter(x => now - (Number(x.n.updated) || 0) <= LIVE_WINDOW_MS)
    .map(x => liveRow(x.uid, x.n, now));
}

// Student side. Called by the pages every few seconds (and on every pause in
// typing): the small node is rewritten, the text only when it changed.
let _lastText = null, _lastTextTopic = null, _disconnectSet = false;
async function heartbeat(p) {
  const u = await me();
  if (u.role !== 'student') return ok();
  const base = 'live/' + u.classId + '/' + u.uid;
  const node = { studentId: u.studentId, name: u.name || '', classId: u.classId, topicId: str(p.topicId), topic: p.topic || '',
                 mode: p.mode || '', status: p.status || 'Writing', wordCount: Number(p.wordCount) || 0, online: true,
                 updated: firebase.database.ServerValue.TIMESTAMP };
  if (p.raiseHand != null) node.raisedHand = !!p.raiseHand;
  if (!_disconnectSet) { _disconnectSet = true; rtdb.ref(base).onDisconnect().update({ online: false }); }
  await rtdb.ref(base).update(node);
  const text = String(p.snapshot || '').slice(0, 8000);
  if (text !== _lastText || str(p.topicId) !== _lastTextTopic) {
    const tref = rtdb.ref('liveText/' + u.classId + '/' + u.uid);
    const cur = (await tref.once('value')).val() || {};
    const sameTopic = cur.topicId === str(p.topicId);
    await tref.set({ topicId: str(p.topicId), snapshot: text,
                     original: sameTopic && cur.original != null ? cur.original : text,   // first text of this task
                     updated: firebase.database.ServerValue.TIMESTAMP });
    _lastText = text; _lastTextTopic = str(p.topicId);
  }
  return ok();
}
async function liveTarget(p) {          // whose live node: the caller, or (teacher) a student of theirs
  const u = await me();
  if (u.role === 'student') return { classId: u.classId, uid: u.uid, me: u };
  const s = await studentByIdForTeacher(u, p.studentId);
  return s ? { classId: s.classId, uid: s._id, me: u } : null;
}
async function raiseHand(p) {
  const t = await liveTarget(p);
  if (!t) return fail('Missing studentId.');
  const patch = { raisedHand: !!p.raised };
  if (t.me.role === 'student') Object.assign(patch, { studentId: t.me.studentId, name: t.me.name || '', classId: t.classId,
    online: true, updated: firebase.database.ServerValue.TIMESTAMP }, p.where ? { topic: p.where } : {}, p.mode ? { mode: p.mode } : {});
  await rtdb.ref('live/' + t.classId + '/' + t.uid).update(patch);
  return ok();
}
async function getDraftSnapshot(p) {
  const u = await me();
  const [n, txt] = await Promise.all([rtdb.ref('live/' + u.classId + '/' + u.uid).once('value'),
                                      rtdb.ref('liveText/' + u.classId + '/' + u.uid).once('value')]);
  const t = txt.val();
  if (!t || t.topicId !== str(p.topicId) || !t.snapshot || (n.val() || {}).status === 'Submitted') return ok(null);
  return ok({ snapshot: t.snapshot, wordCount: (n.val() || {}).wordCount || 0 });
}

// Teacher side
async function getLive(p) {                 // one-shot (alerts, older callers)
  await teacher();
  const snap = await rtdb.ref('live/' + str(p.class)).once('value');
  return ok(liveRows(snap.val()));
}
async function clearLive(p) {
  await teacher();
  const c = str(p.class);
  await Promise.all([rtdb.ref('live/' + c).remove(), rtdb.ref('liveText/' + c).remove()]);
  return ok({ cleared: true });
}
async function getAlerts(p) {
  const [live, open] = await Promise.all([getLive(p), rtdb.ref('queryOpen/' + str(p.class)).once('value')]);
  const o = open.val() || {};
  const ext = await extRequestsOf(p.class, true).catch(() => []);
  return ok({
    extensions: ext.map(r => ({ key: r.key, studentId: r.studentId, name: r.name, topicId: r.topicId, topic: r.topic, createdAt: r.createdAt })),
    hands: (live.data || []).filter(r => r.raisedHand)
      .map(r => ({ studentId: r.studentId, name: r.name, where: r.topic || '', updated: r.updated })),
    questions: Object.keys(o).map(k => o[k]).sort(byNewest)
      .map(q => ({ queryId: q.queryId, studentId: q.studentId, name: q.studentName, question: q.question,
                   topic: q.topic, createdAt: q.createdAt }))
  });
}

// ── Deadline extensions ─────────────────────────────────────────
// extRequests/{classId}/{topicKey__uid}: one request per student per task.
// The teacher grants by writing assignments/{id}.extensions.{studentKey}.
const extKey = (topicId, uid) => rkey(topicId) + '__' + uid;
async function requestExtension(p) {
  const u = await me();
  if (u.role !== 'student') return fail('Chỉ sinh viên mới gửi được yêu cầu này.');
  const d = await fs.doc('assignments/' + str(p.topicId)).get();
  if (!d.exists) return fail('Không tìm thấy bài tập.');
  const a = d.data();
  const key = extKey(p.topicId, u.uid);
  await rtdb.ref('extRequests/' + u.classId + '/' + key).set({
    uid: u.uid, studentId: u.studentId, name: u.name || '', topicId: str(p.topicId), topic: a.topic || '',
    deadline: myDeadline(a, u), reason: String(p.reason || '').slice(0, 500), status: 'pending', createdAt: nowIso()
  });
  gas('fb.notifyExtension', { classId: u.classId, key: key }).catch(() => {});   // email the teacher; never blocks
  return ok({ status: 'pending' });
}
async function myExtensionRequest(p) {
  const u = await me();
  if (u.role !== 'student') return ok(null);
  const v = (await rtdb.ref('extRequests/' + u.classId + '/' + extKey(p.topicId, u.uid)).once('value')).val();
  return ok(v ? { status: v.status, createdAt: v.createdAt, until: v.until || '' } : null);
}
async function extRequestsOf(classId, pendingOnly) {
  const v = (await rtdb.ref('extRequests/' + str(classId)).once('value')).val() || {};
  return Object.keys(v).map(k => Object.assign({ key: k }, v[k]))
    .filter(r => !pendingOnly || r.status === 'pending').sort(byNewest);
}
async function listExtensionRequests(p) {
  await teacher();
  const rows = await extRequestsOf(p.class, false);
  return ok(p.topicId ? rows.filter(r => r.topicId === str(p.topicId)) : rows);
}
async function setExtension(p, grant) {
  const t = await teacher();
  const ref = fs.doc('assignments/' + str(p.topicId));
  const d = await ref.get();
  if (!d.exists || d.data().teacherUid !== t.uid) return fail('Assignment not found.');
  const s = await studentByIdForTeacher(t, p.studentId);
  if (!s) return fail('Student not found.');
  const field = new FP('extensions', safeKey(p.studentId));
  if (grant) {
    if (!deadlineMs(p.until)) return fail('Choose a new deadline.');
    await ref.update(field, str(p.until));
  } else if (p.remove) {
    await ref.update(field, FV.delete());
  }
  const rq = rtdb.ref('extRequests/' + s.classId + '/' + extKey(p.topicId, s._id));
  if ((await rq.once('value')).exists())
    await rq.update({ status: grant ? 'granted' : (p.remove ? 'removed' : 'declined'), until: grant ? str(p.until) : '', decidedAt: nowIso() });
  forget('assign|');
  return ok();
}

// Feedback pushed from the annotation modal: the student sees it at once.
async function saveAnnotation(p) {
  const t = await teacher();
  const s = await studentByIdForTeacher(t, p.studentId);
  if (!s) return fail('Student not found.');
  const now = nowIso();
  if (p.annotatedHtml != null || p.note) {
    await rtdb.ref('annotations/' + s.classId + '/' + s._id + '/' + rkey(p.topicId) + '/a' + Date.now()).set({
      timestamp: now, teacher: p.teacher || '', topicId: str(p.topicId), mode: p.mode || '',
      annotatedHtml: String(p.annotatedHtml || '').slice(0, 45000),
      suggestions: JSON.stringify(p.suggestions || []),
      tr: p.tr || '', cc: p.cc || '', lr: p.lr || '', gra: p.gra || '', note: p.note || ''
    });
    rtdb.ref('live/' + s.classId + '/' + s._id + '/hasFeedback').set(true).catch(() => {});
  }
  // the grade it carries belongs on the submission (Firestore)
  if (p.teacherGrading != null && p.teacherGrading !== '' && p.mode) {
    const sp = await studentProgress(t, p.studentId);
    const rows = sp ? itemsOf(sp.data).filter(r => r.mode === p.mode && str(r.topicId) === str(p.topicId)).sort(byAttempt) : [];
    if (rows.length) await sp.ref.update(new FP('items', rows[rows.length - 1].id, 'teacherGrading'), p.teacherGrading);
    forget('progress|');
  }
  return ok();
}
function annotationsOut(val, forStudent) {
  const rows = Object.keys(val || {}).map(k => val[k]).filter(r => !forStudent || str(r.annotatedHtml))
    .sort((a, b) => ms(b.timestamp) - ms(a.timestamp));
  if (!rows.length) return null;
  const history = rows.map((r, i) => {
    let sug = []; try { sug = JSON.parse(r.suggestions || '[]'); } catch (e) {}
    return { index: rows.length - i, timestamp: r.timestamp, teacher: r.teacher || '', annotatedHtml: r.annotatedHtml || '',
             suggestions: sug, tr: r.tr || '', cc: r.cc || '', lr: r.lr || '', gra: r.gra || '', note: r.note || '' };
  });
  const latest = history[0];
  return { history, pushCount: history.length, latestAt: latest.timestamp,
           tr: latest.tr, cc: latest.cc, lr: latest.lr, gra: latest.gra };
}
// Teacher: history of pushes to one student. Student (write.html): their own.
async function getAnnotation(p) {
  const t = await liveTarget(p);
  if (!t) return ok(null);
  const snap = await rtdb.ref('annotations/' + t.classId + '/' + t.uid + '/' + rkey(p.topicId)).once('value');
  return ok(annotationsOut(snap.val(), t.me.role === 'student'));
}
async function getAnnotationForStudent(p) {
  const r = await getAnnotation(p);
  const h = r.data && r.data.history && r.data.history[0];
  return ok(h ? { timestamp: h.timestamp, teacher: h.teacher, annotatedHtml: h.annotatedHtml } : null);
}

// ── listeners (pages call these directly; each returns an unsubscribe) ──
async function watchLive(classId, cb) {
  await teacher();
  const ref = rtdb.ref('live/' + str(classId));
  let last = null;
  const h = snap => { last = snap.val(); cb(liveRows(last)); };
  ref.on('value', h, () => cb(null));
  // re-evaluate every 10 s: a closed tab / dead connection turns 'Offline'
  // even though nothing new arrives
  const tick = setInterval(() => { if (last !== null) cb(liveRows(last)); }, 10000);
  return () => { clearInterval(tick); ref.off('value', h); };
}
async function watchLiveText(classId, uid, cb) {
  await teacher();
  const ref = rtdb.ref('liveText/' + str(classId) + '/' + str(uid));
  const h = snap => { const v = snap.val() || {}; cb({ snapshot: v.snapshot || '', originalEssay: v.original || '', topicId: v.topicId || '' }); };
  ref.on('value', h, () => {});
  return () => ref.off('value', h);
}
async function watchMyAnnotations(topicId, cb) {
  const u = await me();
  const ref = rtdb.ref('annotations/' + u.classId + '/' + u.uid + '/' + rkey(topicId));
  const h = snap => cb(ok(annotationsOut(snap.val(), true)));
  ref.on('value', h, () => {});
  return () => ref.off('value', h);
}


// ════════════════════════════════════════════
// BOARDS (Realtime Database) — students see edits the moment they are saved
//   boardMeta/{classId}/{key}     title, owner, createdAt, updatedAt, archived
//   boardContent/{classId}/{key}  content (HTML), updatedAt
// boardId given to the pages = classId~key (no lookup needed to find it).
// ════════════════════════════════════════════
const TS = () => firebase.database.ServerValue.TIMESTAMP;
const isoOf = v => (v ? new Date(Number(v)).toISOString() : '');
function splitId(id, parts) {
  const a = String(id || '').split('~');
  return a.length === parts && a.every(Boolean) ? a : null;
}
async function boardClass(u, p) { return u.role === 'student' ? u.classId : str(p.class); }
const classNameOf = classId => memo('cname|' + classId, 300000, async () => {
  const d = await fs.doc('classes/' + classId).get();
  return d.exists ? (d.data().className || classId) : classId;
});
async function boardCreate(p) {
  const t = await teacher();
  const classId = str(p.class);
  if (!(await myClasses(t)).some(c => c.classId === classId)) return fail('Lớp không thuộc tài khoản của bạn.');
  const key = 'B' + Date.now().toString(36) + genId(4);
  const title = str(p.title) || 'Untitled Board';
  await rtdb.ref().update({
    ['boardMeta/' + classId + '/' + key]: { title, owner: p.owner || '', createdAt: TS(), updatedAt: TS(), archived: false },
    ['boardContent/' + classId + '/' + key]: { content: '', updatedAt: TS() }
  });
  return ok({ boardId: classId + '~' + key, title });
}
async function boardList(p) {
  const u = await me();
  const classId = await boardClass(u, p);
  if (!classId) return ok([]);
  const [snap, className] = await Promise.all([rtdb.ref('boardMeta/' + classId).once('value'), classNameOf(classId)]);
  const val = snap.val() || {};
  return ok(Object.keys(val).filter(k => !val[k].archived).map(k => ({
    boardId: classId + '~' + k, class: classId, className, title: val[k].title, owner: val[k].owner || '',
    updatedAt: isoOf(val[k].updatedAt)
  })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
}
async function boardGet(p) {
  await me();
  const id = splitId(p.boardId, 2);
  if (!id) return fail('Board không tồn tại.');
  const [m, c] = await Promise.all([rtdb.ref('boardMeta/' + id[0] + '/' + id[1]).once('value'),
                                    rtdb.ref('boardContent/' + id[0] + '/' + id[1]).once('value')]);
  if (!m.exists() || m.val().archived) return fail('Board không tồn tại.');
  return ok({ boardId: p.boardId, class: id[0], title: m.val().title, content: (c.val() || {}).content || '',
              owner: m.val().owner || '', updatedAt: isoOf(m.val().updatedAt) });
}
async function boardMeta(p) {
  await me();
  const id = splitId(p.boardId, 2);
  if (!id) return fail('Board không tồn tại.');
  const m = await rtdb.ref('boardMeta/' + id[0] + '/' + id[1] + '/updatedAt').once('value');
  return ok({ boardId: p.boardId, updatedAt: isoOf(m.val()) });
}
async function boardSave(p) {
  await teacher();
  const id = splitId(p.boardId, 2);
  if (!id) return fail('Missing boardId.');
  const content = String(p.content || '');
  if (content.length > 1000000) return fail('CONTENT_TOO_LARGE', { detail: 'Nội dung board quá lớn (' +
    Math.round(content.length / 1000) + 'KB). Hãy xóa bớt ảnh hoặc dùng ảnh nhỏ hơn.' });
  const patch = { ['boardContent/' + id[0] + '/' + id[1]]: { content, updatedAt: TS() },
                  ['boardMeta/' + id[0] + '/' + id[1] + '/updatedAt']: TS() };
  if (p.title != null) patch['boardMeta/' + id[0] + '/' + id[1] + '/title'] = String(p.title);
  await rtdb.ref().update(patch);
  return ok({ boardId: p.boardId });
}
async function boardDelete(p) {             // soft delete, like the Sheet version
  await teacher();
  const id = splitId(p.boardId, 2);
  if (!id) return fail('Board không tồn tại.');
  await rtdb.ref('boardMeta/' + id[0] + '/' + id[1]).update({ archived: true, updatedAt: TS() });
  return ok();
}
async function watchBoard(boardId, cb) {
  await me();
  const id = splitId(boardId, 2);
  if (!id) return () => {};
  const ref = rtdb.ref('boardContent/' + id[0] + '/' + id[1]);
  const h = snap => { const v = snap.val() || {}; cb({ content: v.content || '', updatedAt: isoOf(v.updatedAt) }); };
  ref.on('value', h, () => {});
  return () => ref.off('value', h);
}

// ════════════════════════════════════════════
// ASK TEACHER (Realtime Database)
//   queries/{classId}/{uid}/{key}   every question (the student reads their own)
//   queryOpen/{classId}/{key}       unanswered ones only — what alerts read
//   sharedQueries/{classId}/{key}   answers the teacher shared with the class
// queryId given to the pages = classId~uid~key.
// ════════════════════════════════════════════
function queryOut(q) {
  return { queryId: q.queryId, class: q.class, studentId: q.studentId, studentName: q.studentName, mode: q.mode || '',
           topic: q.topic || '', topicId: q.topicId || '', attempt: q.attempt || '', errorQuote: q.errorQuote || '',
           question: q.question || '', answer: q.answer || '', status: q.status || 'open', shared: !!q.shared,
           phase: q.phase || 'review', createdAt: q.createdAt || '', answeredAt: q.answeredAt || '' };
}
const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));
function flatQueries(val) {           // queries/{classId} → [query]
  const out = [];
  Object.keys(val || {}).forEach(u => Object.keys(val[u] || {}).forEach(k => out.push(queryOut(val[u][k]))));
  return out;
}
async function queryCreate(p) {
  const u = await me();
  if (u.role !== 'student') return fail('Chỉ sinh viên mới gửi câu hỏi được.');
  if (!str(p.question)) return fail('Nhập câu hỏi.');
  const key = 'Q' + Date.now().toString(36) + genId(4), qid = u.classId + '~' + u.uid + '~' + key;
  const q = { queryId: qid, uid: u.uid, class: u.classId, studentId: u.studentId, studentName: u.name || '',
              mode: p.mode || '', topic: String(p.topic || '').slice(0, 300), topicId: str(p.topicId),
              attempt: p.attempt || '', errorQuote: String(p.errorQuote || '').slice(0, 2000),
              question: String(p.question).slice(0, 4000), answer: '', status: 'open', shared: false,
              phase: p.phase || 'review', createdAt: nowIso(), answeredAt: '' };
  await rtdb.ref().update({ ['queries/' + u.classId + '/' + u.uid + '/' + key]: q,
                            ['queryOpen/' + u.classId + '/' + key]: q });
  gas('fb.notifyQuery', { queryId: qid }).catch(() => {});        // email the teacher; never blocks
  return ok({ queryId: qid });
}
async function queryListForStudent() {
  const u = await me();
  const [mine, shared] = await Promise.all([rtdb.ref('queries/' + u.classId + '/' + u.uid).once('value'),
                                            rtdb.ref('sharedQueries/' + u.classId).once('value')]);
  const m = mine.val() || {}, sh = shared.val() || {};
  const rows = Object.keys(m).map(k => queryOut(m[k]));
  Object.keys(sh).forEach(k => { if (!m[k]) rows.push(queryOut(sh[k])); });
  return ok(rows.sort(byNewest));
}
async function queryListForTeacher(p) {
  await teacher();
  const snap = await rtdb.ref('queries/' + str(p.class)).once('value');
  return ok(flatQueries(snap.val()).sort(byNewest));
}
async function queryListLive(p) {          // the Live panel shows unanswered live questions
  await teacher();
  const snap = await rtdb.ref('queryOpen/' + str(p.class)).once('value');
  const v = snap.val() || {};
  return ok(Object.keys(v).map(k => queryOut(v[k])).filter(q => q.phase === 'live').sort(byNewest));
}
async function queryAnswer(p) {
  await teacher();
  const id = splitId(p.queryId, 3);
  if (!id) return fail('Query not found.');
  const path = 'queries/' + id[0] + '/' + id[1] + '/' + id[2];
  const cur = (await rtdb.ref(path).once('value')).val();
  if (!cur) return fail('Query not found.');
  const patch = { answer: p.dismissed ? '[dismissed]' : String(p.answer || ''), status: 'answered', answeredAt: nowIso() };
  const up = { ['queryOpen/' + id[0] + '/' + id[2]]: null };
  Object.keys(patch).forEach(f => { up[path + '/' + f] = patch[f]; if (cur.shared) up['sharedQueries/' + id[0] + '/' + id[2] + '/' + f] = patch[f]; });
  await rtdb.ref().update(up);
  return Object.assign(ok(), { dismissed: !!p.dismissed });
}
async function queryShare(p) {
  await teacher();
  const id = splitId(p.queryId, 3);
  if (!id) return fail('Query not found.');
  const path = 'queries/' + id[0] + '/' + id[1] + '/' + id[2];
  const cur = (await rtdb.ref(path).once('value')).val();
  if (!cur) return fail('Query not found.');
  const on = p.shared !== false;
  await rtdb.ref().update({ [path + '/shared']: on,
                            ['sharedQueries/' + id[0] + '/' + id[2]]: on ? Object.assign({}, cur, { shared: true }) : null });
  return ok();
}

// ════════════════════════════════════════════
// Apps Script
// ════════════════════════════════════════════
// Firebase edition actions (Firebase.gs) — the ID token proves who calls.
async function gas(action, payload, anonymous) {
  init();
  const u = auth.currentUser;
  const idToken = (!anonymous && u) ? await u.getIdToken() : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const r = await fetch(window.AW.GAS, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload, idToken }), redirect: 'follow', signal: ctrl.signal
    });
    if (!r.ok) throw new Error('Network error ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
// Still on the Google Sheet: the original transport (fetch + JSONP fallback).
function legacy(action, payload) { return window.AW._legacyApi(action, payload); }

const GAS_FB = {
  'auth.forgotPassword':  p => gas('fb.forgotPassword', p, true),
  // reports / backups / Docs need Google services: Apps Script, Firebase edition
  'class.endSemester':    p => gas('fb.endSemester', p).then(r => { forget(); return r; }),
  'class.restore':        p => gas('fb.restore', p).then(r => { forget(); return r; }),
  'assign.clearData':     p => gas('fb.clearData', p).then(r => { forget('assign|'); return r; }),
  'admin.resetTab':       p => gas('fb.resetData', p).then(r => { forget(); return r; }),
  'student.edit':         p => gas('fb.studentEdit', p).then(r => { forget('students'); forget('progress|'); return r; }),
  'write.exportDoc':      p => gas('fb.exportDoc', p),
  'teacher.exportResults':p => gas('fb.exportResults', p)
};

// Waiting for their Firestore version (End Course / Clear Data / reset read
// the submissions, which no longer live in the Sheet).
// Old actions no page calls any more.
const LATER = ['write.getHistory', 'write.getAttempt', 'write.getSubmissions', 'write.backfillFeedback'];

const ACTIONS = {
  'auth.studentLogin': studentLogin, 'auth.teacherLogin': teacherLogin,
  'auth.studentSignup': studentSignup, 'auth.teacherSignup': teacherSignup,
  'auth.changePassword': changePassword,
  'class.create': classCreate, 'class.list': classList, 'class.get': classGet, 'class.roster': getRoster,
  'class.archive': classArchive, 'class.setAiEnabled': classSetAiEnabled, 'class.listArchived': classListArchived,
  'student.archive': archiveStudent,
  'write.saveResult': saveResult, 'write.getAssignments': getAssignments, 'write.getPrompt': getPrompt,
  'write.getAttemptCount': getAttemptCount, 'write.getMyResults': getMyResults, 'write.getEssay': getEssay,
  'teacher.getResults': getResults, 'teacher.getAttemptDetail': getAttemptDetail,
  'teacher.deleteAttempt': deleteAttempt, 'teacher.saveManualScore': saveManualScore,
  'teacher.saveAnnotation': saveAnnotation, 'teacher.getOverview': getOverview,
  'teacher.createAssignment': createAssignment, 'teacher.updateAssignment': updateAssignment,
  'teacher.deleteAssignment': deleteAssignment,
  'write.heartbeat': heartbeat, 'write.raiseHand': raiseHand, 'write.getDraftSnapshot': getDraftSnapshot,
  'write.getAnnotation': getAnnotationForStudent, 'teacher.getAnnotation': getAnnotation,
  'teacher.getLive': getLive, 'teacher.clearLive': clearLive, 'teacher.getAlerts': getAlerts,
  'write.requestExtension': requestExtension, 'write.myExtensionRequest': myExtensionRequest,
  'teacher.listExtensionRequests': listExtensionRequests,
  'teacher.grantExtension': p => setExtension(p, true), 'teacher.declineExtension': p => setExtension(p, false),
  'teacher.removeExtension': p => setExtension(Object.assign({}, p, { remove: true }), false),
  'board.create': boardCreate, 'board.list': boardList, 'board.get': boardGet, 'board.meta': boardMeta,
  'board.save': boardSave, 'board.delete': boardDelete,
  'query.create': queryCreate, 'query.listForStudent': queryListForStudent, 'query.listForTeacher': queryListForTeacher,
  'query.listLive': queryListLive, 'query.answer': queryAnswer, 'query.share': queryShare
};

async function call(action, payload) {
  init();
  payload = payload || {};
  try {
    if (ACTIONS[action]) return await ACTIONS[action](payload);
    if (GAS_FB[action]) return await GAS_FB[action](payload);
    if (LATER.indexOf(action) >= 0) return fail('Chức năng này không còn dùng.');
    return await legacy(action, payload);
  } catch (e) {
    const code = (e && e.code) || '';
    if (e && e.message === 'CLASS_ARCHIVED') return fail('CLASS_ARCHIVED');
    if (e && (e.message === 'SESSION_EXPIRED' || /unauthenticated|user-disabled/i.test(code))) return fail('SESSION_EXPIRED');
    if (/permission[-_]denied/i.test(code) || /permission_denied/i.test((e && e.message) || '')) return fail(auth && auth.currentUser ? 'Bạn không có quyền truy cập dữ liệu này.' : 'SESSION_EXPIRED');
    if (/unavailable|deadline-exceeded/i.test(code)) return fail('Không kết nối được máy chủ — kiểm tra mạng và thử lại.');
    console.error('[fbdata] ' + action, e);
    return fail((e && e.message) || String(e));
  }
}

// Listener errors (signed out, no access) must not throw into the page.
const safeWatch = fn => (...a) => fn(...a).catch(e => { console.warn('[fbdata] watch', e); return () => {}; });

window.FB = {
  call, authReady, signOut,
  watchLive: safeWatch(watchLive), watchLiveText: safeWatch(watchLiveText),
  watchMyAnnotations: safeWatch(watchMyAnnotations), watchBoard: safeWatch(watchBoard),
  isSignedIn: async () => { await authReady(); return !!auth.currentUser; },
  _helpers: { authPw, loginEmailFor, safeKey, forget }
};
})();
