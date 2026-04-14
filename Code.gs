// ============================================================
// Code.gs — Main Router | E-Sarabun DMS
// ============================================================
// จัดการ HTTP requests ทั้งหมด:
//   doGet()  → แสดง HTML page
//   doPost() → JSON API endpoint
// และ expose server-side functions ให้ google.script.run เรียกได้
// ============================================================

/**
 * HTTP GET — ส่ง HTML Template ตาม page parameter
 * URL: ?page=login | dashboard | doc-internal | doc-external | inbox | archive
 */
function doGet(e) {
  const page    = (e && e.parameter && e.parameter.page) ? e.parameter.page : 'login';
  const session = AuthService.getSession();

  // Redirect ไป login ถ้ายังไม่ได้ authenticate (ยกเว้นหน้า login)
  if (!session && page !== 'login') {
    return _renderPage('Login', { redirected: true });
  }

  // ถ้า login แล้วแต่เปิดหน้า login อีก → redirect dashboard
  if (session && page === 'login') {
    return _renderPage('Dashboard', { session });
  }

  // Route map
  const routes = {
    'login':           { template: 'Login',           title: 'เข้าสู่ระบบ'              },
    'dashboard':       { template: 'Dashboard',       title: 'หน้าหลัก'                 },
    'doc-internal':    { template: 'DocInternal',     title: 'เอกสารภายใน'              },
    'create-internal':   { template: 'CreateInternal',   title: 'สร้างเอกสารภายใน'         },
    'doc-external':       { template: 'DocExternal',      title: 'เอกสารภายนอก'             },
    'receive-external':   { template: 'ReceiveExternal',  title: 'ลงรับเอกสารภายนอก'       },
    'inbox':           { template: 'Inbox',           title: 'กล่องงานค้าง'              },
    'approve':         { template: 'Approve',         title: 'งานรอดำเนินการ'            },
    'archive':         { template: 'ArchivePage',     title: 'แฟ้มจัดเก็บดิจิทัล'       },
    'admin':           { template: 'Admin',           title: 'จัดการระบบ'               }
  };

  const route = routes[page] || routes['dashboard'];
  return _renderPage(route.template, { session }, route.title);
}

/**
 * HTTP POST — JSON API endpoint
 * Body: { action: string, data: Object }
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action  = payload.action;
    const data    = payload.data || {};

    // Actions ที่ไม่ต้อง auth
    const publicActions = ['login'];
    if (!publicActions.includes(action)) {
      const session = AuthService.getSession();
      if (!session) {
        return _jsonResponse({ success: false, message: 'กรุณาเข้าสู่ระบบก่อน' });
      }
    }

    let result;

    switch (action) {

      // ─── Auth ───
      case 'login':           result = AuthService.login(data.username, data.password); break;
      case 'logout':          result = AuthService.logout(); break;
      case 'changePassword':  result = AuthService.changePassword(data.oldPassword, data.newPassword); break;
      case 'createUser':      result = AuthService.createUser(data); break;
      case 'getAllUsers':      result = AuthService.getAllUsers(); break;

      // ─── Documents ───
      case 'reserveDocNo':      result = DocNumber.reserveDocumentNumber(data.type, data.dept); break;
      case 'peekDocNo':         result = DocNumber.peekNextNumber(data.type, data.dept); break;
      case 'getRunningReport':  result = DocNumber.getRunningReport(); break;
      case 'createDoc':         result = DocService.createDocument(data); break;
      case 'getDoc':            result = DocService.getDocument(data.id); break;
      case 'getDocs':           result = DocService.getDocuments(data); break;
      case 'updateDoc':         result = DocService.updateDocument(data.id, data); break;
      case 'getDashboard':      result = DocService.getDashboardStats(AuthService.getSession()); break;

      // ─── Internal Doc (Phase 3) ───
      case 'processInternalDoc':  result = InternalDoc.processAndSaveFile(data); break;

      // ─── External Doc (Phase 4) ───
      case 'listInboxFiles':       result = ExternalDoc.listInboxFiles(); break;
      case 'receiveExternalDoc':   result = ExternalDoc.receiveDocument(data); break;

      // ─── Workflow ───
      case 'approveDoc':         result = WorkflowService.approve(data); break;
      case 'rejectDoc':          result = WorkflowService.reject(data); break;
      case 'acknowledgeDoc':     result = WorkflowService.acknowledge(data); break;
      case 'getWorkflow':        result = WorkflowService.getWorkflowStatus(data.id); break;

      // ─── Workflow Query (Phase 5) ───
      case 'getPendingDocs':     result = WorkflowQuery.getPendingDocs(); break;
      case 'getDocDetail':       result = WorkflowQuery.getDocDetail(data.docId); break;
      case 'getMyPendingCount':  result = WorkflowQuery.getMyPendingCount(); break;

      // ─── Dashboard (Phase 6) ───
      case 'getFullDashboard':   result = DashboardService.getStats(); break;

      // ─── Notification Broadcast (Phase 6) ───
      case 'broadcastNotify':    result = (AuthService.requireAuth().role === CONFIG.ROLES.MANAGER)
                                   ? (WorkflowNotify.broadcast(data.message), Utils.success(null, 'ส่งแจ้งเตือนแล้ว'))
                                   : Utils.error('ไม่มีสิทธิ์'); break;

      // ─── Files ───
      case 'uploadFile':        result = FileService.uploadFile(data); break;
      case 'getFileUrl':        result = FileService.getFileUrl(data.fileId); break;
      case 'listFiles':         result = FileService.listFilesInFolder(data.docType, new Date(data.date)); break;

      // ─── Archive ───
      case 'listArchiveFiles':  result = Archive.listFiles(data); break;
      case 'listArchiveYears':  result = Archive.listAvailableYears(); break;
      case 'listArchiveMonths': result = Archive.listMonthStructure(data.year, data.docType); break;

      // ─── Notifications ───
      case 'getNotify':       result = NotifyService.getUserNotifications(data.username); break;
      case 'getAllNotify':     result = NotifyService.getAllNotifications(data.username, data.limit); break;
      case 'readNotify':      result = NotifyService.markAsRead(data.id); break;
      case 'readAllNotify':   result = NotifyService.markAllAsRead(data.username); break;
      case 'deleteNotify':    result = NotifyService.delete(data.id); break;

      // ─── Logs ───
      case 'getLogs':         result = { success: true, data: LogService.getRecentLogs(data.limit || 50) }; break;
      case 'getDocLogs':      result = { success: true, data: LogService.getDocLogs(data.docId) }; break;

      default:
        result = Utils.error(`ไม่รู้จัก action: "${action}"`);
    }

    return _jsonResponse(result);

  } catch (err) {
    LogService.error('doPost', err.message, 'system');
    return _jsonResponse(Utils.error('เกิดข้อผิดพลาดของระบบ: ' + err.message));
  }
}

// ============================================================
// Server-side functions สำหรับ google.script.run
// ============================================================

/** ดึง Session ปัจจุบัน */
function getSessionData() {
  return AuthService.getSession();
}

/** Login */
function loginUser(username, password) {
  return AuthService.login(username, password);
}

/** Logout */
function logoutUser() {
  return AuthService.logout();
}

/** ดึง Dashboard stats */
function getDashboardData() {
  const session = AuthService.getSession();
  if (!session) return Utils.error('กรุณาเข้าสู่ระบบ');
  return DocService.getDashboardStats(session);
}

/** ดึงรายการเอกสาร */
function getDocumentList(filters) {
  return DocService.getDocuments(filters || {});
}

/** ดึงเอกสารเดี่ยว */
function getDocumentById(id) {
  return DocService.getDocument(id);
}

/** จองเลขเอกสาร (LockService-safe) */
function reserveDocumentNumber(type, dept) {
  return DocNumber.reserveDocumentNumber(type, dept || '');
}

/** ดูเลขถัดไป (peek, ไม่ increment) */
function peekDocumentNumber(type, dept) {
  return DocNumber.peekNextNumber(type, dept || '');
}

/** รายงานเลขรัน */
function getRunningNumberReport() {
  return DocNumber.getRunningReport();
}

/** รายการไฟล์ Archive ของวัน/ประเภท */
function listArchiveFiles(params) {
  AuthService.requireAuth();
  return Archive.listFiles(params);
}

/** ดึงปีที่มีเอกสารใน Archive */
function listArchiveYears() {
  AuthService.requireAuth();
  return Archive.listAvailableYears();
}

/** สรุปโครงสร้างเดือนในปีที่ระบุ */
function listArchiveMonths(year, docType) {
  AuthService.requireAuth();
  return Archive.listMonthStructure(year, docType);
}

/** อนุมัติเอกสาร */
function approveDocument(docId, remark) {
  return WorkflowService.approve({ docId, remark });
}

/** ปฏิเสธเอกสาร */
function rejectDocument(docId, remark, returnToCreator) {
  return WorkflowService.reject({ docId, remark, returnToCreator });
}

/** รับทราบเอกสาร */
function acknowledgeDocument(docId, remark) {
  return WorkflowService.acknowledge({ docId, remark });
}

/** อัปโหลดไฟล์ */
function uploadDocumentFile(params) {
  return FileService.uploadFile(params);
}

/**
 * Phase 3 — บันทึกเอกสารภายใน:
 * แปลง Word→PDF, บันทึก Archive, เพิ่ม DB_DOCS + สร้าง Workflow
 */
function processAndSaveInternalDoc(params) {
  return InternalDoc.processAndSaveFile(params);
}

/**
 * Phase 4 — ดึงรายการไฟล์ใน INBOX (Google Drive)
 * สำหรับเจ้าหน้าที่ ฝอก. เลือกไฟล์เพื่อลงรับ
 */
function listInboxFiles() {
  return ExternalDoc.listInboxFiles();
}

/**
 * Phase 4 — ลงรับเอกสารภายนอก:
 * จองเลข → ย้ายไฟล์ INBOX→Archive → บันทึก DB_DOCS + Workflow
 */
function receiveExternalDocument(params) {
  return ExternalDoc.receiveDocument(params);
}

/**
 * Phase 5 — ดึงรายการเอกสารที่รอดำเนินการโดยผู้ใช้ปัจจุบัน
 */
function getPendingDocsForUser() {
  return WorkflowQuery.getPendingDocs();
}

/**
 * Phase 5 — ดึงรายละเอียดเอกสารสำหรับหน้า Approve
 */
function getDocDetailForApprove(docId) {
  return WorkflowQuery.getDocDetail(docId);
}

/**
 * Phase 5 — นับจำนวนเอกสารรอดำเนินการ (สำหรับ badge)
 */
function getMyPendingCount() {
  return WorkflowQuery.getMyPendingCount();
}

/** ดึง URL ไฟล์ */
function getDocumentFileUrl(fileId) {
  return FileService.getFileUrl(fileId);
}

/** ดึงการแจ้งเตือน */
function getMyNotifications() {
  const session = AuthService.getSession();
  if (!session) return Utils.success([]);
  return NotifyService.getUserNotifications(session.username);
}

/** ทำเครื่องหมายอ่านแล้ว */
function markNotificationRead(id) {
  return NotifyService.markAsRead(id);
}

/** ทำเครื่องหมายอ่านทั้งหมด */
function markAllNotificationsRead() {
  const session = AuthService.getSession();
  if (!session) return Utils.error('กรุณาเข้าสู่ระบบ');
  return NotifyService.markAllAsRead(session.username);
}

/**
 * Phase 6 — สถิติ Dashboard แบบละเอียด (ผ่าน DashboardService)
 * — pendingForMe, totalInProgress, completedThisMonth, monthlyTrend, recentActivity
 */
function getFullDashboardStats() {
  return DashboardService.getStats();
}

/** รายชื่อผู้ใช้สำหรับหน้า Admin */
function getUsersForAdmin() {
  return AuthService.getAllUsers();
}

/** สร้างผู้ใช้ใหม่จากหน้า Admin */
function createUserByAdmin(userData) {
  return AuthService.createUser(userData || {});
}

/** ดึง Log ล่าสุดสำหรับหน้า Admin */
function getRecentLogsForAdmin(limit) {
  try {
    const session = AuthService.requireAuth();
    if (!PermissionService.canAccessAdmin(session)) {
      return Utils.error('ไม่มีสิทธิ์ดู log ระบบ');
    }
    return Utils.success(LogService.getRecentLogs(limit || 50));
  } catch (e) {
    return Utils.error(e.message);
  }
}

/** ดึง URL ของ Web App (ใช้สร้าง link ต่าง ๆ) */
function getAppUrl() {
  return ScriptApp.getService().getUrl();
}

// ============================================================
// Private Helpers
// ============================================================

/**
 * Render HTML Template พร้อม inject data
 * @private
 */
function _renderPage(templateName, data, pageTitle) {
  try {
    const template = HtmlService.createTemplateFromFile(templateName);

    // Inject data ลงใน template
    if (data) {
      Object.entries(data).forEach(([k, v]) => { template[k] = v; });
    }

    const title = pageTitle
      ? `${pageTitle} — ${CONFIG.APP_NAME}`
      : CONFIG.APP_NAME;

    return template.evaluate()
      .setTitle(title)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');

  } catch (e) {
    // Fallback: ถ้าหา template ไม่เจอ
    return HtmlService.createHtmlOutput(`
      <h2>404 — ไม่พบหน้าที่ต้องการ</h2>
      <p><a href="?page=dashboard">กลับหน้าหลัก</a></p>
    `).setTitle('E-Sarabun — 404');
  }
}

/**
 * สร้าง JSON Response
 * @private
 */
function _jsonResponse(data) {
  return ContentService
    .createTextOutput(Utils.safeJsonStringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Include HTML file partials (ใช้ใน <? include('Stylesheet') ?> ใน template)
 * @param {string} filename
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
