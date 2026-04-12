// ============================================================
// Config.gs — ค่าคงที่และการตั้งค่าระบบ E-Sarabun DMS
// ============================================================

/**
 * ค่าคงที่หลักของระบบ — แก้ไขค่าในส่วนนี้เพียงที่เดียว
 * เพื่อกำหนดค่าสำหรับ Spreadsheet และ Drive Folder
 */
const CONFIG = {

  // ─── Google Sheets ─────────────────────────────────────────
  /** ID ของ Google Spreadsheet หลัก (แก้ไขก่อน deploy) */
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID_HERE',

  /** ชื่อ Sheet แต่ละตาราง */
  SHEETS: {
    DOCS:    'DB_DOCS',
    RUNNING: 'DB_RUNNING',
    USERS:   'USER',
    NOTIFY:  'DB_NOTIFY',
    LOG:     'DB_LOG'
  },

  // ─── Google Drive ───────────────────────────────────────────
  /** ID ของโฟลเดอร์ Root ใน Google Drive สำหรับเก็บเอกสาร */
  DRIVE_ROOT_FOLDER_ID: 'YOUR_ROOT_FOLDER_ID_HERE',

  // ─── Session ────────────────────────────────────────────────
  /** Session timeout (วินาที) — 8 ชั่วโมง */
  SESSION_DURATION: 28800,
  /** Cache key prefix สำหรับ Session */
  SESSION_PREFIX: 'esarabun_session_',

  // ─── องค์กร ─────────────────────────────────────────────────
  /** รายชื่อฝ่ายทั้ง 6 ฝ่าย */
  DEPARTMENTS: ['ฝอก.', 'ฝสท.', 'ฝสส.', 'ฝสช.', 'ฝบช.', 'ฝกง.'],

  // ─── บทบาทผู้ใช้ ─────────────────────────────────────────────
  ROLES: {
    OFFICER:      'officer',       // เจ้าหน้าที่
    DEPT_HEAD:    'dept_head',     // หัวหน้าฝ่าย
    ASST_MANAGER: 'asst_manager',  // ผู้ช่วยผู้จัดการ
    MANAGER:      'manager'        // ผู้จัดการ
  },

  /** ลำดับ Role (ใช้ compare permission) */
  ROLE_LEVEL: {
    officer:      1,
    dept_head:    2,
    asst_manager: 3,
    manager:      4
  },

  // ─── ประเภทเอกสาร ────────────────────────────────────────────
  DOC_TYPES: {
    INTERNAL: 'internal', // เอกสารภายใน
    EXTERNAL: 'external'  // เอกสารภายนอก
  },

  // ─── สถานะเอกสาร ─────────────────────────────────────────────
  DOC_STATUS: {
    DRAFT:       'draft',        // ร่าง (ยังไม่ยืนยัน)
    PENDING:     'pending',      // รอดำเนินการ
    IN_PROGRESS: 'in_progress',  // กำลังดำเนินการ (อยู่ในขั้นตอน)
    APPROVED:    'approved',     // อนุมัติแล้ว
    REJECTED:    'rejected',     // ถูกปฏิเสธ
    COMPLETED:   'completed'     // เสร็จสิ้น (ครบทุกขั้นตอน)
  },

  // ─── เลขเอกสาร ───────────────────────────────────────────────
  /** Prefix สำหรับเอกสารภายนอก */
  EXTERNAL_PREFIX: 'รับ',

  /** จำนวน digit ของเลขรัน เช่น 001 = 3 */
  RUNNING_DIGITS: 3,

  // ─── Workflow Steps ──────────────────────────────────────────
  /** ขั้นตอน Workflow เอกสารภายนอก */
  WORKFLOW_EXTERNAL: [
    { step: 1, role: 'officer',      dept: 'ฝอก.', label: 'ลงรับ',          action: 'receive' },
    { step: 2, role: 'asst_manager', dept: null,    label: 'ลงนาม',          action: 'sign'    },
    { step: 3, role: 'manager',      dept: null,    label: 'ลงนาม/สั่งการ',  action: 'command' },
    { step: 4, role: 'dept_head',    dept: null,    label: 'รับทราบ',         action: 'acknowledge' } // multi-dept
  ],

  /** ขั้นตอน Workflow เอกสารภายใน */
  WORKFLOW_INTERNAL: [
    { step: 1, role: 'officer',      dept: null,    label: 'จองเลข/แนบไฟล์', action: 'create'  },
    { step: 2, role: 'dept_head',    dept: null,    label: 'ลงนาม (ต้นเรื่อง)', action: 'sign'  },
    { step: 3, role: 'asst_manager', dept: null,    label: 'ลงนาม',          action: 'sign'    },
    { step: 4, role: 'manager',      dept: null,    label: 'ลงนาม/สั่งการ',  action: 'command' }
  ],

  // ─── แอปพลิเคชัน ─────────────────────────────────────────────
  APP_NAME:    'E-Sarabun',
  APP_VERSION: '1.0.0',
  APP_NAME_TH: 'ระบบสารบรรณอิเล็กทรอนิกส์'
};
