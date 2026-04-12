// ============================================================
// NotifyService.gs — ระบบแจ้งเตือนผู้ใช้
// ============================================================
// จัดการ DB_NOTIFY: id, user, docId, message, status, createdAt
// ============================================================

const NotifyService = {

  // ─── Create ──────────────────────────────────────────────────

  /**
   * ส่งการแจ้งเตือนให้ผู้ใช้
   * @param {string} username - ผู้รับการแจ้งเตือน
   * @param {string} docId - ID เอกสารที่เกี่ยวข้อง
   * @param {string} message - ข้อความแจ้งเตือน
   * @returns {boolean}
   */
  send(username, docId, message) {
    try {
      DbService.insert(CONFIG.SHEETS.NOTIFY, {
        id:        Utils.generateId(),
        user:      username,
        docId:     docId  || '',
        message:   message,
        status:    'unread',
        createdAt: Utils.now()
      });
      return true;
    } catch (e) {
      LogService.error('NOTIFY_SEND', e.message, 'system');
      return false;
    }
  },

  /**
   * ส่งการแจ้งเตือนให้หลายผู้ใช้พร้อมกัน
   * @param {Array<string>} usernames
   * @param {string} docId
   * @param {string} message
   */
  sendBulk(usernames, docId, message) {
    usernames.forEach(u => this.send(u, docId, message));
  },

  /**
   * ส่งการแจ้งเตือนให้ทุกคนใน department
   * @param {string} department
   * @param {string} docId
   * @param {string} message
   * @param {string} roleFilter - กรองเฉพาะ role (optional)
   */
  sendToDepartment(department, docId, message, roleFilter) {
    const conditions = { department };
    if (roleFilter) conditions.role = roleFilter;

    const users = DbService.findWhere(CONFIG.SHEETS.USERS, conditions);
    const usernames = users.map(u => u.username);
    this.sendBulk(usernames, docId, message);
  },

  /**
   * ส่งการแจ้งเตือนให้ทุกคนที่มี role ที่กำหนด
   * @param {string} role
   * @param {string} docId
   * @param {string} message
   */
  sendToRole(role, docId, message) {
    const users = DbService.findMany(CONFIG.SHEETS.USERS, 'role', role);
    const usernames = users.map(u => u.username);
    this.sendBulk(usernames, docId, message);
  },

  // ─── Read ─────────────────────────────────────────────────────

  /**
   * ดึงการแจ้งเตือนของผู้ใช้ (เฉพาะ unread)
   * @param {string} username
   * @returns {{ success: boolean, data: Array }}
   */
  getUserNotifications(username) {
    try {
      const all = DbService.findMany(CONFIG.SHEETS.NOTIFY, 'user', username)
        .filter(n => n.status !== 'read' && n.status !== 'deleted')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return Utils.success(all);
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  /**
   * ดึงจำนวนการแจ้งเตือนที่ยังไม่ได้อ่าน
   * @param {string} username
   * @returns {number}
   */
  getUnreadCount(username) {
    try {
      const all = DbService.findWhere(CONFIG.SHEETS.NOTIFY, { user: username, status: 'unread' });
      return all.length;
    } catch (e) {
      return 0;
    }
  },

  /**
   * ดึงการแจ้งเตือนทั้งหมดของผู้ใช้ (รวม read)
   * @param {string} username
   * @param {number} limit
   * @returns {{ success: boolean, data: Array }}
   */
  getAllNotifications(username, limit = 30) {
    try {
      const all = DbService.findMany(CONFIG.SHEETS.NOTIFY, 'user', username)
        .filter(n => n.status !== 'deleted')
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);
      return Utils.success(all);
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  // ─── Update ───────────────────────────────────────────────────

  /**
   * ทำเครื่องหมายว่าอ่านแล้ว (อ่านทีละรายการ)
   * @param {string} id - notification id
   * @returns {{ success: boolean, message: string }}
   */
  markAsRead(id) {
    try {
      const ok = DbService.updateById(CONFIG.SHEETS.NOTIFY, id, { status: 'read' });
      if (!ok) return Utils.error('ไม่พบการแจ้งเตือนนี้');
      return Utils.success(null, 'อ่านแล้ว');
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  /**
   * ทำเครื่องหมายว่าอ่านทั้งหมดของผู้ใช้
   * @param {string} username
   * @returns {{ success: boolean, message: string }}
   */
  markAllAsRead(username) {
    try {
      DbService.updateWhere(CONFIG.SHEETS.NOTIFY, 'user', username, { status: 'read' });
      return Utils.success(null, 'ทำเครื่องหมายอ่านทั้งหมดแล้ว');
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  /**
   * ลบการแจ้งเตือน (soft delete)
   * @param {string} id
   * @returns {{ success: boolean }}
   */
  delete(id) {
    try {
      DbService.updateById(CONFIG.SHEETS.NOTIFY, id, { status: 'deleted' });
      return Utils.success(null, 'ลบการแจ้งเตือนแล้ว');
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  // ─── Workflow Notifications ───────────────────────────────────

  /**
   * แจ้งเตือนเมื่อเอกสารส่งมาให้พิจารณา
   * @param {string} toUsername - ผู้รับแจ้ง
   * @param {string} docId
   * @param {string} docNo
   * @param {string} subject - เรื่องเอกสาร
   * @param {string} fromUsername - ผู้ส่ง
   */
  notifyPendingApproval(toUsername, docId, docNo, subject, fromUsername) {
    const msg = `📄 มีเอกสารรอการพิจารณา: [${docNo}] ${subject} (จาก ${fromUsername})`;
    this.send(toUsername, docId, msg);
  },

  /**
   * แจ้งเตือนเมื่อเอกสารได้รับการอนุมัติ
   * @param {string} toUsername
   * @param {string} docId
   * @param {string} docNo
   * @param {string} subject
   * @param {string} approverName
   */
  notifyApproved(toUsername, docId, docNo, subject, approverName) {
    const msg = `✅ เอกสาร [${docNo}] ${subject} ได้รับการอนุมัติโดย ${approverName}`;
    this.send(toUsername, docId, msg);
  },

  /**
   * แจ้งเตือนเมื่อเอกสารถูกปฏิเสธ
   * @param {string} toUsername
   * @param {string} docId
   * @param {string} docNo
   * @param {string} subject
   * @param {string} rejectorName
   * @param {string} remark
   */
  notifyRejected(toUsername, docId, docNo, subject, rejectorName, remark) {
    const msg = `❌ เอกสาร [${docNo}] ${subject} ถูกปฏิเสธโดย ${rejectorName}: ${remark || '-'}`;
    this.send(toUsername, docId, msg);
  }
};
