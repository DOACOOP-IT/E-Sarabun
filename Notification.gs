// ============================================================
// Notification.gs — ระบบแจ้งเตือน Workflow อัตโนมัติ
// ============================================================
// WorkflowNotify เป็น orchestration layer สำหรับ workflow events
// — ถูกเรียกจาก WorkflowService เมื่อสถานะเปลี่ยน
// — กำหนด message template และส่งไปยังผู้เกี่ยวข้องอัตโนมัติ
// — เขียน DB_NOTIFY ผ่าน NotifyService.send()
// ============================================================

const WorkflowNotify = {

  // ──────────────────────────────────────────────────────────
  // PUBLIC TRIGGERS — เรียกจาก WorkflowService
  // ──────────────────────────────────────────────────────────

  /**
   * แจ้งเตือนเมื่อ workflow step ใหม่กลายเป็น pending
   * — ส่งแจ้งเตือนให้ผู้มีสิทธิ์ดำเนินการ step นั้น
   *
   * @param {Object} step      - workflow step object (มี role, dept, action, label)
   * @param {string} docId
   * @param {string} docNo
   * @param {string} subject
   * @param {string} fromUser  - username ที่ดำเนินการ step ก่อนหน้า
   */
  onStepPending(step, docId, docNo, subject, fromUser) {
    try {
      const action   = step.action || 'approve';
      const label    = step.label  || 'ดำเนินการ';
      const stepNo   = step.step   || '';
      const emoji    = this._actionEmoji(action);
      const msg      = `${emoji} [ขั้นที่ ${stepNo}] มีเอกสารรอ${label}: [${docNo}] ${subject}`;

      if (action === 'acknowledge') {
        // acknowledge step → แจ้ง dept_head ของทุก assignedDepts
        const depts = step.assignedDepts || [];
        depts.forEach(dept => {
          NotifyService.sendToDepartment(dept, docId, msg, CONFIG.ROLES.DEPT_HEAD);
        });

      } else if (step.dept) {
        // แจ้ง role ที่กำหนดในฝ่ายที่ระบุ
        NotifyService.sendToDepartment(step.dept, docId, msg, step.role);

      } else {
        // แจ้งทุกคนที่มี role นั้น (manager, asst_manager ระดับองค์กร)
        NotifyService.sendToRole(step.role, docId, msg);
      }

    } catch (e) {
      LogService.error('NOTIFY_STEP_PENDING', e.message, 'system');
    }
  },

  /**
   * แจ้งเตือนเมื่อเอกสารเสร็จสิ้นสมบูรณ์ (ครบทุกขั้นตอน)
   *
   * @param {string} docId
   * @param {string} docNo
   * @param {string} subject
   * @param {string} byUser      - username ที่ทำให้ doc complete
   * @param {string} createdBy   - username ผู้สร้าง
   */
  onCompleted(docId, docNo, subject, byUser, createdBy) {
    try {
      const msg = `✅ เอกสาร [${docNo}] ${subject} — ดำเนินการเสร็จสิ้นทุกขั้นตอนแล้ว`;
      // แจ้งผู้สร้าง
      if (createdBy) NotifyService.send(createdBy, docId, msg);
      // แจ้งผู้ที่เพิ่งดำเนินการ (ถ้าไม่ใช่คนเดียวกัน)
      if (byUser && byUser !== createdBy) NotifyService.send(byUser, docId, msg);
    } catch (e) {
      LogService.error('NOTIFY_COMPLETED', e.message, 'system');
    }
  },

  /**
   * แจ้งเตือนเมื่อเอกสารถูกปฏิเสธหรือส่งคืนผู้สร้าง
   *
   * @param {string} docId
   * @param {string} docNo
   * @param {string} subject
   * @param {string} byUser          - username ที่กด reject
   * @param {string} createdBy       - username ผู้สร้าง
   * @param {string} remark          - เหตุผล
   * @param {boolean} returnToCreator - true = ส่งคืนแก้ไข, false = ปฏิเสธถาวร
   */
  onRejected(docId, docNo, subject, byUser, createdBy, remark, returnToCreator) {
    try {
      const event = returnToCreator ? 'ส่งคืนเพื่อแก้ไข' : 'ถูกปฏิเสธ';
      const emoji = returnToCreator ? '↩️' : '❌';
      const byLine = byUser ? ` (โดย ${byUser})` : '';
      const remarkLine = remark ? ` — เหตุผล: ${remark}` : '';
      const msg = `${emoji} เอกสาร [${docNo}] ${subject}${byLine} ${event}${remarkLine}`;
      if (createdBy) NotifyService.send(createdBy, docId, msg);
    } catch (e) {
      LogService.error('NOTIFY_REJECTED', e.message, 'system');
    }
  },

  /**
   * แจ้งเตือนเมื่อมีการ acknowledge (รับทราบ) จากฝ่ายหนึ่ง
   * — แจ้งผู้สร้างรายฝ่ายที่รับทราบ
   *
   * @param {string} docId
   * @param {string} docNo
   * @param {string} subject
   * @param {string} byUser
   * @param {string} byDept
   * @param {Array}  remainingDepts - ฝ่ายที่ยังไม่รับทราบ
   */
  onAcknowledged(docId, docNo, subject, byUser, byDept, remainingDepts) {
    try {
      if (remainingDepts && remainingDepts.length > 0) {
        const remaining = remainingDepts.join(', ');
        const msg = `📋 ${byDept} รับทราบเอกสาร [${docNo}] แล้ว — ยังรอ: ${remaining}`;
        NotifyService.sendToRole(CONFIG.ROLES.ASST_MANAGER, docId, msg);
      } else {
        // ทุกฝ่ายรับทราบครบ → แจ้ง manager/asst_manager
        const msg = `✅ ทุกฝ่ายรับทราบเอกสาร [${docNo}] ${subject} ครบแล้ว`;
        NotifyService.sendToRole(CONFIG.ROLES.ASST_MANAGER, docId, msg);
        NotifyService.sendToRole(CONFIG.ROLES.MANAGER, docId, msg);
      }
    } catch (e) {
      LogService.error('NOTIFY_ACKNOWLEDGED', e.message, 'system');
    }
  },

  // ──────────────────────────────────────────────────────────
  // UTILITY
  // ──────────────────────────────────────────────────────────

  /**
   * ส่งแจ้งเตือนระบบ (admin broadcast)
   * @param {string} message - ข้อความ
   */
  broadcast(message) {
    try {
      const allUsers = DbService.getAll(CONFIG.SHEETS.USERS);
      allUsers.forEach(u => {
        NotifyService.send(u.username, '', `📢 ${message}`);
      });
    } catch (e) {
      LogService.error('NOTIFY_BROADCAST', e.message, 'system');
    }
  },

  /**
   * ดึง emoji ตาม action type
   * @private
   */
  _actionEmoji(action) {
    const map = {
      receive:     '📥',
      sign:        '✍️',
      command:     '📋',
      approve:     '✅',
      acknowledge: '👁️',
      create:      '📝'
    };
    return map[action] || '📄';
  }
};
