// ============================================================
// Setup.gs — สร้าง Sheet และหัวตารางอัตโนมัติ | E-Sarabun DMS
// ============================================================
// วิธีใช้: เปิด Apps Script Editor → เลือกฟังก์ชัน setupSheets
//          แล้วกด ▶ Run เพียงครั้งเดียวก่อน deploy ครั้งแรก
//
// ฟังก์ชันนี้:
//   1. ตรวจสอบว่าแต่ละ Sheet มีอยู่แล้วหรือไม่
//   2. ถ้ายังไม่มี → สร้างใหม่
//   3. ถ้า row 1 ว่าง → ใส่ header row
//   4. ตกแต่ง header row (bold, freeze, สีพื้นหลัง)
//   5. ไม่แตะข้อมูลที่มีอยู่แล้ว (idempotent)
// ============================================================

/**
 * โครงสร้าง Schema ของทุก Sheet
 * ดึงมาจากโค้ดจริงใน DbService, AuthService, InternalDoc, ExternalDoc,
 * NotifyService, LogService, DocNumber
 */
const SHEET_SCHEMA = {

  /**
   * DB_DOCS — เอกสารทั้งหมด (Internal + External)
   * Columns จาก: InternalDoc.gs, ExternalDoc.gs, DocService.gs
   */
  [CONFIG.SHEETS.DOCS]: {
    headers: [
      'id',            // UUID ของเอกสาร
      'docType',       // 'internal' | 'external'
      'docNo',         // เลขเอกสาร เช่น ฝอก.001/2569
      'date',          // วันที่เอกสาร (ISO)
      'subject',       // ชื่อเรื่อง
      'sender',        // ฝ่าย/องค์กรต้นเรื่อง
      'receiver',      // ผู้รับ / ฝ่ายปลายทาง
      'assignedDepts', // JSON array ของฝ่ายที่เกี่ยวข้อง
      'urgency',       // ความเร่งด่วน (ด่วน, ด่วนมาก, ปกติ)
      'secrecy',       // ชั้นความลับ (ลับ, ลับมาก, ปกติ)
      'status',        // draft | in_progress | approved | rejected | completed
      'fileId',        // Google Drive File ID (ไฟล์หลัก/PDF)
      'originalFileId',// Google Drive File ID (ไฟล์ต้นฉบับ Word)
      'workflow',      // JSON object ของ Workflow ทุกขั้นตอน
      'currentStep',   // ขั้นตอนปัจจุบัน (1–4)
      'createdBy',     // username ผู้สร้าง
      'createdAt',     // timestamp สร้าง
      'updateAt'       // timestamp อัปเดตล่าสุด
    ],
    color: '#1a73e8' // Google Blue
  },

  /**
   * DB_RUNNING — เลขรันประจำปี/ประเภท/prefix
   * Columns จาก: DocNumber.gs
   */
  [CONFIG.SHEETS.RUNNING]: {
    headers: [
      'prefix',     // เช่น 'ฝอก.' หรือ 'รับ'
      'year',       // ปีพุทธศักราช เช่น 2569
      'type',       // 'internal' | 'external'
      'current_no'  // เลขล่าสุดที่ถูกจอง
    ],
    color: '#e67700' // Orange
  },

  /**
   * USER — ข้อมูลผู้ใช้งานระบบ
   * Columns จาก: AuthService.gs
   */
  [CONFIG.SHEETS.USERS]: {
    headers: [
      'username',      // ชื่อผู้ใช้ (lowercase unique)
      'password_hash', // 'salt:hash' (SHA-256)
      'role',          // officer | dept_head | asst_manager | manager
      'department',    // ฝ่ายที่สังกัด เช่น 'ฝอก.'
      'displayName',   // ชื่อแสดงผล
      'createdAt',     // timestamp สร้าง
      'createdBy'      // username ผู้สร้าง account
    ],
    color: '#0d652d' // Green
  },

  /**
   * DB_NOTIFY — การแจ้งเตือนในระบบ
   * Columns จาก: NotifyService.gs
   */
  [CONFIG.SHEETS.NOTIFY]: {
    headers: [
      'id',        // UUID
      'user',      // username ผู้รับแจ้งเตือน
      'docId',     // ID เอกสารที่เกี่ยวข้อง
      'message',   // ข้อความแจ้งเตือน
      'status',    // 'unread' | 'read'
      'createdAt'  // timestamp
    ],
    color: '#7b1fa2' // Purple
  },

  /**
   * DB_LOG — Activity Log ทุก action
   * Columns จาก: LogService.gs
   */
  [CONFIG.SHEETS.LOG]: {
    headers: [
      'time',   // timestamp
      'user',   // username ผู้กระทำ
      'action', // ชื่อ action เช่น LOGIN, CREATE_INTERNAL_DOC
      'docId',  // ID เอกสารที่เกี่ยวข้อง (ถ้ามี)
      'detail'  // รายละเอียดเพิ่มเติม
    ],
    color: '#37474f' // Blue Grey
  }
};

// ============================================================
// ฟังก์ชันหลัก — เรียกจาก Apps Script Editor
// ============================================================

/**
 * สร้างและตั้งค่า Sheet ทั้งหมดอัตโนมัติ
 * — Idempotent: ปลอดภัยที่จะรันซ้ำ ไม่ลบข้อมูลเดิม
 */
function setupSheets() {
  const ss      = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const results = [];

  for (const [sheetName, schema] of Object.entries(SHEET_SCHEMA)) {
    const result = _setupSingleSheet(ss, sheetName, schema);
    results.push(result);
    console.log(`[Setup] ${sheetName}: ${result.action} — ${result.note}`);
  }

  // สรุปผล
  const created = results.filter(r => r.action === 'CREATED').length;
  const updated = results.filter(r => r.action === 'HEADERS_SET').length;
  const skipped = results.filter(r => r.action === 'SKIPPED').length;

  const summary = `✅ Setup เสร็จสิ้น\n` +
    `   สร้างใหม่: ${created} Sheet\n` +
    `   ใส่ Header: ${updated} Sheet\n` +
    `   ข้ามแล้ว:  ${skipped} Sheet (มีข้อมูลอยู่แล้ว)`;

  console.log(summary);

  // แสดง Toast แจ้งใน Spreadsheet (เฉพาะเมื่อมี UI context เช่นเปิดจาก Spreadsheet)
  try { ss.toast(summary, '🗂️ E-Sarabun Setup', 8); } catch (_) { /* ไม่มี UI context — ข้ามได้ */ }

  return results;
}

// ============================================================
// seedUsers() — สร้างผู้ใช้งานเริ่มต้น
// ============================================================
// วิธีใช้: เปิด Apps Script Editor → เลือก seedUsers → กด ▶ Run
//
// ⚠️  รันได้ครั้งเดียว — ถ้า username ซ้ำจะข้ามอัตโนมัติ
// ⚠️  แก้ไขรหัสผ่านในส่วน INITIAL_USERS ก่อน deploy จริง
// ============================================================

/**
 * ข้อมูลผู้ใช้งานเริ่มต้น — แก้ไขตามโครงสร้างองค์กร
 * role: officer | dept_head | asst_manager | manager
 * department: ฝอก. | ฝสท. | ฝสส. | ฝสช. | ฝบช. | ฝกง.
 */
const INITIAL_USERS = [
  // ─── ระดับผู้จัดการ ─────────────────────────────────────────
  { username: 'manager',       password: 'Manager@1234',      role: 'manager',      department: 'ฝอก.', displayName: 'ผู้จัดการ' },
  { username: 'asst.manager',  password: 'AsstMgr@1234',      role: 'asst_manager', department: 'ฝอก.', displayName: 'ผู้ช่วยผู้จัดการ' },

  // ─── หัวหน้าฝ่าย ────────────────────────────────────────────
  { username: 'head.fok',      password: 'HeadFok@1234',      role: 'dept_head',    department: 'ฝอก.', displayName: 'หัวหน้า ฝอก.' },
  { username: 'head.fst',      password: 'HeadFst@1234',      role: 'dept_head',    department: 'ฝสท.', displayName: 'หัวหน้า ฝสท.' },
  { username: 'head.fss',      password: 'HeadFss@1234',      role: 'dept_head',    department: 'ฝสส.', displayName: 'หัวหน้า ฝสส.' },
  { username: 'head.fsc',      password: 'HeadFsc@1234',      role: 'dept_head',    department: 'ฝสช.', displayName: 'หัวหน้า ฝสช.' },
  { username: 'head.fbc',      password: 'HeadFbc@1234',      role: 'dept_head',    department: 'ฝบช.', displayName: 'หัวหน้า ฝบช.' },
  { username: 'head.fkg',      password: 'HeadFkg@1234',      role: 'dept_head',    department: 'ฝกง.', displayName: 'หัวหน้า ฝกง.' },

  // ─── เจ้าหน้าที่ (ตัวอย่าง ฝอก.) ────────────────────────────
  { username: 'officer.fok',   password: 'Officer@1234',      role: 'officer',      department: 'ฝอก.', displayName: 'เจ้าหน้าที่ ฝอก.' },
];

/**
 * สร้างผู้ใช้งานเริ่มต้นจาก INITIAL_USERS
 * — ข้าม username ที่มีอยู่แล้ว (idempotent)
 */
function seedUsers() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEETS.USERS);

  if (!sheet) {
    console.error('❌ ไม่พบ Sheet USER — รัน setupSheets() ก่อน');
    return;
  }

  let created = 0;
  let skipped = 0;

  INITIAL_USERS.forEach(u => {
    // ตรวจซ้ำ
    const existing = DbService.findOne(CONFIG.SHEETS.USERS, 'username', u.username);
    if (existing) {
      console.log(`  ข้าม: ${u.username} (มีอยู่แล้ว)`);
      skipped++;
      return;
    }

    // Hash password
    const salt   = Utils.generateSalt();
    const hash   = Utils.hashPassword(u.password, salt);
    const pwHash = `${salt}:${hash}`;

    DbService.insert(CONFIG.SHEETS.USERS, {
      username:     u.username.trim().toLowerCase(),
      password_hash: pwHash,
      role:         u.role,
      department:   u.department,
      displayName:  u.displayName || u.username,
      createdAt:    Utils.now(),
      createdBy:    'system'
    });

    console.log(`  ✅ สร้าง: ${u.username} [${u.role}] ${u.department}`);
    created++;
  });

  const summary = `\n👤 Seed Users เสร็จสิ้น — สร้าง: ${created}, ข้าม: ${skipped}`;
  console.log(summary);
  try { ss.toast(summary, 'E-Sarabun Setup', 5); } catch (_) {}
}

/**
 * รีเซ็ตรหัสผ่านผู้ใช้ (รันใน Apps Script Editor)
 * — แก้ไข TARGET_USERNAME และ NEW_PASSWORD ก่อนรัน
 */
function resetPassword() {
  const TARGET_USERNAME = 'officer.fok';   // ← แก้ไข username
  const NEW_PASSWORD    = 'NewPass@1234';  // ← แก้ไข password ใหม่

  const user = DbService.findOne(CONFIG.SHEETS.USERS, 'username', TARGET_USERNAME);
  if (!user) {
    console.error(`❌ ไม่พบ username: ${TARGET_USERNAME}`);
    return;
  }

  const salt   = Utils.generateSalt();
  const hash   = Utils.hashPassword(NEW_PASSWORD, salt);
  DbService.updateById(CONFIG.SHEETS.USERS, user.id, {
    password_hash: `${salt}:${hash}`
  });

  console.log(`✅ เปลี่ยนรหัสผ่านของ ${TARGET_USERNAME} สำเร็จ`);
}

/**
 * แสดงรายชื่อ user ทั้งหมด (ไม่แสดง password_hash)
 */
function listUsers() {
  const users = DbService.getAll(CONFIG.SHEETS.USERS);
  console.log(`\n👤 ผู้ใช้งานในระบบ (${users.length} คน):\n`);
  users.forEach((u, i) => {
    console.log(`${i + 1}. ${u.username.padEnd(20)} role: ${u.role.padEnd(14)} dept: ${u.department}`);
  });
}

/**
 * ตรวจสอบและแสดงโครงสร้าง Sheet ปัจจุบันเทียบกับ Schema
 * — ใช้ debug ว่า Sheet ตรงกับที่ระบบต้องการหรือไม่
 */
function checkSheets() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const report = [];

  for (const [sheetName, schema] of Object.entries(SHEET_SCHEMA)) {
    const sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      report.push({ sheet: sheetName, status: '❌ ไม่พบ Sheet', missing: schema.headers });
      continue;
    }

    const existingHeaders = sheet.getLastRow() > 0
      ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].filter(h => h !== '')
      : [];

    const missing = schema.headers.filter(h => !existingHeaders.includes(h));
    const extra   = existingHeaders.filter(h => !schema.headers.includes(h));

    report.push({
      sheet:    sheetName,
      status:   missing.length === 0 && extra.length === 0 ? '✅ ตรง' : '⚠️ ไม่ตรง',
      existing: existingHeaders,
      expected: schema.headers,
      missing,
      extra
    });
  }

  report.forEach(r => {
    console.log(`\n[${r.status}] ${r.sheet}`);
    if (r.missing && r.missing.length > 0) console.log(`  ขาด:  ${r.missing.join(', ')}`);
    if (r.extra  && r.extra.length  > 0) console.log(`  เกิน: ${r.extra.join(', ')}`);
  });

  return report;
}

// ============================================================
// Private Helpers
// ============================================================

/**
 * ตั้งค่า Sheet เดียว
 * @private
 */
function _setupSingleSheet(ss, sheetName, schema) {
  let sheet  = ss.getSheetByName(sheetName);
  let action = 'SKIPPED';
  let note   = 'Sheet + Headers มีอยู่แล้ว';

  // ─── 1. สร้าง Sheet ถ้ายังไม่มี ──────────────────────────────
  if (!sheet) {
    sheet  = ss.insertSheet(sheetName);
    action = 'CREATED';
    note   = 'สร้าง Sheet ใหม่และใส่ Headers';
  }

  // ─── 2. ตรวจว่า row 1 ว่างหรือไม่ (ยังไม่มี headers) ─────────
  const firstCell = sheet.getRange(1, 1).getValue();
  if (firstCell !== '' && action !== 'CREATED') {
    // มี header อยู่แล้ว — ข้าม
    return { sheet: sheetName, action: 'SKIPPED', note: 'Headers มีอยู่แล้ว ไม่แตะข้อมูล' };
  }

  // ─── 3. เขียน Header Row ─────────────────────────────────────
  const headers    = schema.headers;
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);

  // ─── 4. จัดแต่ง Header Row ───────────────────────────────────
  headerRange
    .setBackground(schema.color || '#1a73e8')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setBorder(true, true, true, true, true, true);

  // ─── 5. Freeze Row 1 (Header ไม่เลื่อนตาม scroll) ──────────
  sheet.setFrozenRows(1);

  // ─── 6. ปรับความกว้างคอลัมน์อัตโนมัติ ───────────────────────
  sheet.autoResizeColumns(1, headers.length);

  // ─── 7. ตั้งค่า Column widths ขั้นต่ำสำหรับคอลัมน์ที่ต้องการ ─
  _applyMinColumnWidths(sheet, headers);

  if (action !== 'CREATED') {
    action = 'HEADERS_SET';
    note   = 'ใส่ Headers ใน Sheet ที่มีอยู่แล้ว';
  }

  return { sheet: sheetName, action, note };
}

/**
 * กำหนดความกว้างขั้นต่ำให้คอลัมน์สำคัญ
 * @private
 */
function _applyMinColumnWidths(sheet, headers) {
  const minWidths = {
    'id':            180,
    'workflow':      260,
    'assignedDepts': 180,
    'subject':       240,
    'message':       300,
    'detail':        280,
    'password_hash': 200,
    'docNo':         140,
    'sender':        140,
    'receiver':      140,
    'displayName':   140,
    'createdAt':     155,
    'updateAt':      155,
    'time':          155
  };

  headers.forEach((header, idx) => {
    if (minWidths[header]) {
      const colWidth = sheet.getColumnWidth(idx + 1);
      if (colWidth < minWidths[header]) {
        sheet.setColumnWidth(idx + 1, minWidths[header]);
      }
    }
  });
}
