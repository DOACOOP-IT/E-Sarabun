// ============================================================
// DocNumber.gs — ระบบจองเลขเอกสาร (Running Number)
// ============================================================
// ใช้ LockService.getScriptLock() เพื่อป้องกัน Race Condition
// เมื่อผู้ใช้หลายคนกดจองเลขพร้อมกัน
//
// รูปแบบเลขเอกสาร:
//   ภายใน  → "{prefix}{XXX}/{ปีพศ}"  เช่น "ฝอก.001/2569"
//   ภายนอก → "รับ.{XXX}/{ปีพศ}"     เช่น "รับ.001/2569"
// ============================================================

const DocNumber = {

  // ─── Public API ───────────────────────────────────────────────

  /**
   * จองเลขเอกสาร (Thread-Safe ด้วย LockService)
   *
   * @param {string} type            - 'internal' | 'external'
   * @param {string} departmentPrefix - prefix ของฝ่าย เช่น 'ฝอก.' (สำหรับ internal)
   *                                    ถ้าเป็น external ส่งค่าใดก็ได้ ระบบจะใช้ CONFIG.EXTERNAL_PREFIX แทน
   * @returns {{ success: boolean, data: { docNo, runningNo, prefix, year }, message: string }}
   */
  reserveDocumentNumber(type, departmentPrefix) {
    // ─── Auth Check ─────────────────────────────────────────────
    let session;
    try {
      session = AuthService.requireAuth();
    } catch (e) {
      return Utils.error('กรุณาเข้าสู่ระบบก่อนจองเลขเอกสาร');
    }

    // ─── Validate Input ──────────────────────────────────────────
    if (!type || !CONFIG.DOC_TYPES[type.toUpperCase()]) {
      // ตรวจค่า string โดยตรง
      if (type !== 'internal' && type !== 'external') {
        return Utils.error('ประเภทเอกสารไม่ถูกต้อง (internal หรือ external เท่านั้น)');
      }
    }

    if (type === 'internal' && Utils.isEmpty(departmentPrefix)) {
      return Utils.error('กรุณาระบุ prefix ของฝ่ายสำหรับเอกสารภายใน');
    }

    // กำหนด prefix ตาม type
    const prefix     = type === 'internal' ? departmentPrefix : CONFIG.EXTERNAL_PREFIX;
    const targetYear = Utils.toBuddhistYear(new Date());

    // ─── LockService (Script-level Lock สูงสุด 30 วินาที) ────────
    const lock = LockService.getScriptLock();

    try {
      // รอ lock สูงสุด 15 วินาที — ถ้าเกินจะ throw Error
      lock.waitLock(15000);

      // ─── อ่าน current_no เฉพาะ prefix+year นี้ ──────────────
      const sheet   = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
                        .getSheetByName(CONFIG.SHEETS.RUNNING);
      if (!sheet) throw new Error(`ไม่พบชีต ${CONFIG.SHEETS.RUNNING}`);

      const data    = sheet.getDataRange().getValues();
      const headers = data[0];

      // หา column index
      const colPrefix = headers.indexOf('prefix');
      const colYear   = headers.indexOf('year');
      const colType   = headers.indexOf('type');
      const colNo     = headers.indexOf('current_no');

      if ([colPrefix, colYear, colType, colNo].some(i => i === -1)) {
        throw new Error('โครงสร้าง Sheet DB_RUNNING ไม่ถูกต้อง — ตรวจสอบ headers');
      }

      // ค้นหา row ที่มี prefix + year + type ตรงกัน
      let matchRow = -1;
      let currentNo = 0;

      for (let i = 1; i < data.length; i++) {
        if (
          String(data[i][colPrefix]) === prefix &&
          String(data[i][colYear])   === String(targetYear) &&
          String(data[i][colType])   === type
        ) {
          matchRow  = i + 1; // 1-based row index สำหรับ sheet.getRange()
          currentNo = Number(data[i][colNo]) || 0;
          break;
        }
      }

      const nextNo = currentNo + 1;

      if (matchRow === -1) {
        // ─── ยังไม่มีใน DB → สร้างแถวใหม่ ──────────────────────
        sheet.appendRow([prefix, String(targetYear), type, nextNo]);
      } else {
        // ─── มีอยู่แล้ว → อัปเดต current_no ตรงๆ บน Sheet ──────
        // ไม่ผ่าน DbService เพื่อลด overhead ภายใต้ Lock
        sheet.getRange(matchRow, colNo + 1).setValue(nextNo);

        // Flush ทันทีเพื่อให้บันทึกก่อน release lock
        SpreadsheetApp.flush();
      }

      // Format เลขเอกสาร
      const docNo = `${prefix}${Utils.padNumber(nextNo, CONFIG.RUNNING_DIGITS)}/${targetYear}`;

      // ─── Release Lock ─────────────────────────────────────────
      lock.releaseLock();

      LogService.write(session.username, 'RESERVE_DOC_NO', '', `จอง ${docNo}`);

      return Utils.success(
        { docNo, runningNo: nextNo, prefix, year: targetYear },
        `จองเลขเอกสาร ${docNo} สำเร็จ`
      );

    } catch (e) {
      // ─── Release Lock เสมอ แม้เกิด Error ───────────────────────
      try { lock.releaseLock(); } catch (_) { /* ignore */ }

      // ตรวจประเภท error
      if (e.message && e.message.includes('Could not obtain lock')) {
        LogService.error('RESERVE_DOC_NO', 'Lock timeout', session && session.username);
        return Utils.error('ระบบไม่ว่าง มีการจองเลขพร้อมกัน กรุณาลองใหม่อีกครั้ง');
      }

      LogService.error('RESERVE_DOC_NO', e.message, session && session.username);
      return Utils.error('เกิดข้อผิดพลาดในการจองเลขเอกสาร: ' + e.message);
    }
  },

  // ─── Query ────────────────────────────────────────────────────

  /**
   * ดึงสถานะเลขปัจจุบัน (สำหรับแสดง UI — ไม่ต้อง Lock)
   * @param {string} type
   * @param {string} departmentPrefix
   * @returns {{ success: boolean, data: { current_no, nextDocNo } }}
   */
  peekNextNumber(type, departmentPrefix) {
    try {
      AuthService.requireAuth();
      const prefix      = type === 'internal' ? departmentPrefix : CONFIG.EXTERNAL_PREFIX;
      const targetYear  = Utils.toBuddhistYear(new Date());

      const existing = DbService.findWhere(CONFIG.SHEETS.RUNNING, {
        prefix: prefix,
        year:   String(targetYear),
        type:   type
      });

      const currentNo = existing.length > 0 ? Number(existing[0].current_no) : 0;
      const nextNo    = currentNo + 1;
      const nextDocNo = `${prefix}${Utils.padNumber(nextNo, CONFIG.RUNNING_DIGITS)}/${targetYear}`;

      return Utils.success({ current_no: currentNo, nextDocNo, prefix, year: targetYear });
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  /**
   * ดึงรายการเลขทั้งหมดแยกตาม prefix/ปี (สำหรับ Admin)
   * @returns {{ success: boolean, data: Array }}
   */
  getRunningReport() {
    try {
      AuthService.requireAuth();
      if (!AuthService.hasRole(CONFIG.ROLES.ASST_MANAGER)) {
        return Utils.error('ไม่มีสิทธิ์ดูรายงาน Running Number');
      }
      const rows = DbService.getAll(CONFIG.SHEETS.RUNNING)
        .sort((a, b) => String(b.year).localeCompare(String(a.year)) || String(a.prefix).localeCompare(String(b.prefix)));
      return Utils.success(rows);
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  // ─── Validation ───────────────────────────────────────────────

  /**
   * ตรวจสอบว่าเลขเอกสารที่กรอกมือถูก format หรือไม่
   * @param {string} docNo - เช่น "ฝอก.001/2569"
   * @returns {boolean}
   */
  validateDocNoFormat(docNo) {
    if (!docNo) return false;
    // Pattern: {chars}.{digits}/{4-digit-year}
    return /^[\u0E00-\u0E7Fa-zA-Z]+\.\d{3}\/\d{4}$/.test(docNo);
  }
};
