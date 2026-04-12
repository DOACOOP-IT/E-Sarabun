// ============================================================
// DocService.gs — จัดการเอกสาร, จองเลขรัน, CRUD
// ============================================================

const DocService = {

  // ─── Running Number ───────────────────────────────────────────

  /**
   * จองเลขเอกสารและบันทึกลง DB_RUNNING
   * @param {Object} options
   * @param {string} options.type - 'internal' | 'external'
   * @param {string} options.dept - ฝ่าย (สำหรับ internal) เช่น 'ฝอก.'
   * @param {number} options.year - ปี พ.ศ. เช่น 2569
   * @returns {{ success: boolean, data: { docNo: string }, message: string }}
   */
  reserveDocNumber({ type, dept, year }) {
    // Delegate to DocNumber.gs which handles LockService internally
    return DocNumber.reserveDocumentNumber(type, dept || '');
  },

  // ─── CRUD ─────────────────────────────────────────────────────

  /**
   * สร้างเอกสารใหม่ในระบบ
   * @param {Object} data
   * @param {string} data.docType - 'internal' | 'external'
   * @param {string} data.docNo - เลขเอกสาร
   * @param {string} data.date - วันที่เอกสาร (ISO)
   * @param {string} data.subject - เรื่อง
   * @param {string} data.sender - จาก (ฝ่าย/หน่วยงาน)
   * @param {string} data.receiver - ถึง (ฝ่าย/บุคคล)
   * @param {Array}  data.assignedDepts - ฝ่ายที่รับมอบหมาย (array สำหรับ external)
   * @returns {{ success: boolean, data: Object, message: string }}
   */
  createDocument(data) {
    try {
      const session = AuthService.requireAuth();

      // Validate
      if (Utils.isEmpty(data.subject)) return Utils.error('กรุณากรอกเรื่องเอกสาร');
      if (Utils.isEmpty(data.docNo))   return Utils.error('กรุณาจองเลขเอกสารก่อน');

      // สร้าง Workflow steps ตาม docType
      const workflowTemplate = data.docType === CONFIG.DOC_TYPES.INTERNAL
        ? CONFIG.WORKFLOW_INTERNAL
        : CONFIG.WORKFLOW_EXTERNAL;

      const workflow = this._buildWorkflow(workflowTemplate, data, session);

      const docId = Utils.generateId();
      const docRecord = {
        id:           docId,
        docType:      data.docType,
        docNo:        data.docNo,
        date:         data.date || Utils.toISODate(new Date()),
        subject:      data.subject,
        sender:       data.sender || session.department,
        receiver:     data.receiver || '',
        assignedDepts: Utils.safeJsonStringify(data.assignedDepts || []),
        status:       CONFIG.DOC_STATUS.PENDING,
        fileId:       data.fileId || '',
        workflow:     Utils.safeJsonStringify(workflow),
        currentStep:  1,
        createdBy:    session.username,
        createdAt:    Utils.now(),
        updateAt:     Utils.now()
      };

      DbService.insert(CONFIG.SHEETS.DOCS, docRecord);

      // แจ้งเตือนผู้ที่ต้องดำเนินการ step 1 (ถ้าไม่ใช่คนสร้าง)
      this._notifyNextStep(workflow, 1, docId, data.docNo, data.subject, session.username);

      LogService.createDoc(session.username, docId, data.docNo);
      return Utils.success({ id: docId, docNo: data.docNo }, `สร้างเอกสาร ${data.docNo} สำเร็จ`);

    } catch (e) {
      LogService.error('CREATE_DOC', e.message);
      return Utils.error('เกิดข้อผิดพลาด: ' + e.message);
    }
  },

  /**
   * ดึงข้อมูลเอกสารตาม ID
   * @param {string} id
   * @returns {{ success: boolean, data: Object }}
   */
  getDocument(id) {
    try {
      AuthService.requireAuth();
      const doc = DbService.findOne(CONFIG.SHEETS.DOCS, 'id', id);
      if (!doc) return Utils.error('ไม่พบเอกสาร');
      return Utils.success(this._formatDoc(doc));
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  /**
   * ดึงรายการเอกสารพร้อม filter
   * @param {Object} filters
   * @param {string} filters.docType - 'internal' | 'external' (optional)
   * @param {string} filters.status  - สถานะ (optional)
   * @param {string} filters.dept    - ฝ่าย (optional)
   * @param {number} filters.year    - ปี พ.ศ. (optional)
   * @returns {{ success: boolean, data: Array }}
   */
  getDocuments(filters = {}) {
    try {
      const session = AuthService.requireAuth();
      let docs = DbService.getAll(CONFIG.SHEETS.DOCS)
        .filter(d => d.status !== 'deleted');

      // Filter ตาม role — เจ้าหน้าที่เห็นแค่ของฝ่ายตัวเอง
      if (session.role === CONFIG.ROLES.OFFICER) {
        docs = docs.filter(d =>
          d.createdBy === session.username ||
          d.sender === session.department ||
          d.receiver === session.department
        );
      } else if (session.role === CONFIG.ROLES.DEPT_HEAD) {
        docs = docs.filter(d =>
          d.sender === session.department ||
          d.receiver === session.department ||
          d.createdBy === session.username
        );
      }
      // asst_manager และ manager เห็นทั้งหมด

      // Apply filters
      if (filters.docType) docs = docs.filter(d => d.docType === filters.docType);
      if (filters.status)  docs = docs.filter(d => d.status  === filters.status);
      if (filters.dept)    docs = docs.filter(d => d.sender  === filters.dept || d.receiver === filters.dept);
      if (filters.year) {
        docs = docs.filter(d => {
          const yr = Utils.toBuddhistYear(new Date(d.date));
          return String(yr) === String(filters.year);
        });
      }

      // Sort by latest first
      docs = docs
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(d => this._formatDoc(d));

      return Utils.success(docs);
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  /**
   * อัปเดตข้อมูลเอกสาร (แก้ไขเฉพาะ field ที่อนุญาต)
   * @param {string} id
   * @param {Object} updates
   * @returns {{ success: boolean, message: string }}
   */
  updateDocument(id, updates) {
    try {
      const session = AuthService.requireAuth();
      const doc = DbService.findOne(CONFIG.SHEETS.DOCS, 'id', id);
      if (!doc) return Utils.error('ไม่พบเอกสาร');

      // ตรวจสิทธิ์
      if (doc.createdBy !== session.username && !AuthService.hasRole(CONFIG.ROLES.DEPT_HEAD)) {
        return Utils.error('ไม่มีสิทธิ์แก้ไขเอกสารนี้');
      }

      // เฉพาะ field ที่แก้ไขได้
      const allowed = ['subject', 'date', 'sender', 'receiver', 'fileId', 'assignedDepts'];
      const safeUpdates = {};
      allowed.forEach(field => {
        if (updates[field] !== undefined) safeUpdates[field] = updates[field];
      });

      DbService.updateById(CONFIG.SHEETS.DOCS, id, safeUpdates);
      LogService.write(session.username, 'UPDATE_DOC', id, JSON.stringify(safeUpdates));
      return Utils.success(null, 'แก้ไขเอกสารสำเร็จ');

    } catch (e) {
      return Utils.error(e.message);
    }
  },

  // ─── Dashboard ────────────────────────────────────────────────

  /**
   * ดึงข้อมูลสถิติสำหรับ Dashboard
   * @param {Object} session
   * @returns {{ success: boolean, data: Object }}
   */
  getDashboardStats(session) {
    try {
      const allDocs = DbService.getAll(CONFIG.SHEETS.DOCS)
        .filter(d => d.status !== 'deleted');

      const stats = {
        totalDocs:     allDocs.length,
        pending:       allDocs.filter(d => d.status === CONFIG.DOC_STATUS.PENDING).length,
        inProgress:    allDocs.filter(d => d.status === CONFIG.DOC_STATUS.IN_PROGRESS).length,
        completed:     allDocs.filter(d => d.status === CONFIG.DOC_STATUS.COMPLETED).length,
        rejected:      allDocs.filter(d => d.status === CONFIG.DOC_STATUS.REJECTED).length,
        internal:      allDocs.filter(d => d.docType === CONFIG.DOC_TYPES.INTERNAL).length,
        external:      allDocs.filter(d => d.docType === CONFIG.DOC_TYPES.EXTERNAL).length,
        recentDocs:    allDocs
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
          .slice(0, 10)
          .map(d => this._formatDoc(d)),
        pendingForMe:  this._getPendingForUser(allDocs, session)
      };

      return Utils.success(stats);
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  // ─── Private Helpers ─────────────────────────────────────────

  /**
   * สร้าง Workflow จาก template
   * @private
   */
  _buildWorkflow(template, data, session) {
    return {
      docType: data.docType,
      steps: template.map(t => ({
        step:       t.step,
        role:       t.role,
        dept:       t.dept || (t.role === 'officer' || t.role === 'dept_head' ? session.department : null),
        label:      t.label,
        action:     t.action,
        status:     t.step === 1 ? 'pending' : 'waiting', // step แรก = pending, ที่เหลือ = waiting
        signedBy:   null,
        signedAt:   null,
        remark:     null,
        // สำหรับ external step สุดท้าย (acknowledge) อาจมีหลาย dept
        assignedDepts: (t.action === 'acknowledge' && data.assignedDepts)
          ? data.assignedDepts
          : null
      }))
    };
  },

  /**
   * แจ้งเตือนผู้ที่ต้องดำเนินการใน step ถัดไป
   * @private
   */
  _notifyNextStep(workflow, stepNo, docId, docNo, subject, fromUsername) {
    const step = workflow.steps.find(s => s.step === stepNo);
    if (!step) return;

    if (step.action === 'acknowledge' && step.assignedDepts) {
      // แจ้งทุก dept ที่ได้รับมอบหมาย
      step.assignedDepts.forEach(dept => {
        NotifyService.sendToDepartment(dept, docId,
          `📋 มีเอกสารรอรับทราบ: [${docNo}] ${subject}`,
          CONFIG.ROLES.DEPT_HEAD
        );
      });
    } else if (step.dept) {
      // แจ้งเฉพาะ dept ที่กำหนด
      NotifyService.sendToDepartment(step.dept, docId,
        `📄 มีเอกสารรอดำเนินการ: [${docNo}] ${subject}`,
        step.role
      );
    } else {
      // แจ้งตาม role ทั่วไป (asst_manager, manager)
      NotifyService.sendToRole(step.role, docId,
        `📄 มีเอกสารรอ${step.label}: [${docNo}] ${subject}`
      );
    }
  },

  /**
   * Format doc object (parse JSON fields)
   * @private
   */
  _formatDoc(doc) {
    return {
      ...doc,
      workflow:      Utils.safeJsonParse(doc.workflow,      { steps: [] }),
      assignedDepts: Utils.safeJsonParse(doc.assignedDepts, []),
      dateTH:        Utils.formatDateTH(doc.date),
      createdAtTH:   Utils.formatDateTH(doc.createdAt, true)
    };
  },

  /**
   * ดึงเอกสารที่รอการดำเนินการสำหรับผู้ใช้คนนี้
   * @private
   */
  _getPendingForUser(allDocs, session) {
    return allDocs
      .filter(doc => {
        const wf = Utils.safeJsonParse(doc.workflow, { steps: [] });
        const currentStep = wf.steps?.find(s => s.status === 'pending');
        if (!currentStep) return false;

        // ตรวจว่า session มีสิทธิ์ดำเนินการ step นี้หรือไม่
        const roleMatch = currentStep.role === session.role;
        const deptMatch = !currentStep.dept || currentStep.dept === session.department;
        return roleMatch && deptMatch;
      })
      .sort((a, b) => new Date(b.updateAt) - new Date(a.updateAt))
      .slice(0, 5);
  }
};
