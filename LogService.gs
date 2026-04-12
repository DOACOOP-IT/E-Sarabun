// ============================================================
// LogService.gs — บันทึก Activity Log ทุก action ในระบบ
// ============================================================

const LogService = {

  /**
   * บันทึก Log รายการทั่วไป
   * @param {string} user - username ผู้กระทำ
   * @param {string} action - ชื่อ action (เช่น 'LOGIN', 'CREATE_DOC')
   * @param {string} docId - ID เอกสารที่เกี่ยวข้อง (ถ้ามี)
   * @param {string} detail - รายละเอียดเพิ่มเติม
   */
  write(user, action, docId, detail) {
    try {
      DbService.insert(CONFIG.SHEETS.LOG, {
        time:   Utils.now(),
        user:   user   || 'system',
        action: action || 'UNKNOWN',
        docId:  docId  || '',
        detail: detail || ''
      });
    } catch (e) {
      // ไม่ throw เพื่อไม่ให้ Log failure กระทบ flow หลัก
      console.error('LogService.write failed:', e.message);
    }
  },

  /**
   * บันทึก Log การ Login
   * @param {string} username
   * @param {boolean} success
   * @param {string} ip
   */
  login(username, success, ip) {
    this.write(username, success ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED', '', `IP: ${ip || 'unknown'}`);
  },

  /**
   * บันทึก Log การ Logout
   * @param {string} username
   */
  logout(username) {
    this.write(username, 'LOGOUT', '', '');
  },

  /**
   * บันทึก Log การสร้างเอกสาร
   * @param {string} username
   * @param {string} docId
   * @param {string} docNo - เลขเอกสาร
   */
  createDoc(username, docId, docNo) {
    this.write(username, 'CREATE_DOC', docId, `DocNo: ${docNo}`);
  },

  /**
   * บันทึก Log การอนุมัติ/ปฏิเสธเอกสาร
   * @param {string} username
   * @param {string} docId
   * @param {string} action - 'APPROVE' | 'REJECT'
   * @param {number} step - ขั้นตอนที่
   * @param {string} remark - หมายเหตุ
   */
  workflowAction(username, docId, action, step, remark) {
    this.write(username, `WORKFLOW_${action}`, docId, `Step: ${step}, Remark: ${remark || '-'}`);
  },

  /**
   * บันทึก Log การอัปโหลดไฟล์
   * @param {string} username
   * @param {string} docId
   * @param {string} fileId
   * @param {string} fileName
   */
  uploadFile(username, docId, fileId, fileName) {
    this.write(username, 'UPLOAD_FILE', docId, `FileId: ${fileId}, Name: ${fileName}`);
  },

  /**
   * บันทึก Error
   * @param {string} action - action ที่เกิด error
   * @param {string} errorMessage
   * @param {string} user
   */
  error(action, errorMessage, user) {
    this.write(user || 'system', `ERROR_${action}`, '', errorMessage);
  },

  // ─── Query ────────────────────────────────────────────────────

  /**
   * ดึง Log ของเอกสาร
   * @param {string} docId
   * @returns {Array<Object>}
   */
  getDocLogs(docId) {
    return DbService.findMany(CONFIG.SHEETS.LOG, 'docId', docId)
      .sort((a, b) => new Date(b.time) - new Date(a.time));
  },

  /**
   * ดึง Log ของผู้ใช้
   * @param {string} username
   * @param {number} limit - จำนวนสูงสุด
   * @returns {Array<Object>}
   */
  getUserLogs(username, limit = 50) {
    return DbService.findMany(CONFIG.SHEETS.LOG, 'user', username)
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, limit);
  },

  /**
   * ดึง Log ล่าสุด N รายการ
   * @param {number} limit
   * @returns {Array<Object>}
   */
  getRecentLogs(limit = 100) {
    return DbService.getAll(CONFIG.SHEETS.LOG)
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, limit);
  }
};
