// ============================================================
// WorkflowService.gs — จัดการ Workflow การอนุมัติเอกสาร
// ============================================================
// รับผิดชอบ: อนุมัติ, ปฏิเสธ, เลื่อน step, อัปเดต status
// ============================================================

const WorkflowService = {

  /**
   * อนุมัติเอกสารในขั้นตอนปัจจุบัน
   * @param {Object} params
   * @param {string} params.docId  - ID เอกสาร
   * @param {string} params.remark - หมายเหตุ/คำสั่งการ (optional)
   * @returns {{ success: boolean, message: string }}
   */
  approve({ docId, remark }) {
    try {
      const session = AuthService.requireAuth();
      const doc     = DbService.findOne(CONFIG.SHEETS.DOCS, 'id', docId);

      if (!doc) return Utils.error('ไม่พบเอกสาร');
      if (doc.status === CONFIG.DOC_STATUS.COMPLETED)
        return Utils.error('เอกสารนี้เสร็จสิ้นแล้ว');
      if (doc.status === CONFIG.DOC_STATUS.REJECTED)
        return Utils.error('เอกสารนี้ถูกปฏิเสธแล้ว ไม่สามารถอนุมัติได้');

      const workflow    = Utils.safeJsonParse(doc.workflow, { steps: [] });
      const currentStep = this._getCurrentStep(workflow);

      if (!currentStep)
        return Utils.error('ไม่มีขั้นตอนที่รออยู่');

      // ตรวจสิทธิ์
      const authCheck = this._checkStepPermission(currentStep, session);
      if (!authCheck.allowed) return Utils.error(authCheck.message);

      // บันทึกการลงนาม
      currentStep.status   = 'approved';
      currentStep.signedBy = session.username;
      currentStep.signedAt = Utils.now();
      currentStep.remark   = remark || null;

      // หา step ถัดไป
      const nextStep = this._getNextStep(workflow, currentStep.step);

      let newStatus;
      if (nextStep) {
        // ยังมี step ถัดไป
        nextStep.status = 'pending';
        newStatus = CONFIG.DOC_STATUS.IN_PROGRESS;

        // แจ้งเตือนผู้รับผิดชอบ step ถัดไปอัตโนมัติ
        WorkflowNotify.onStepPending(nextStep, docId, doc.docNo, doc.subject, session.username);
      } else {
        // ผ่านทุก step แล้ว
        newStatus = CONFIG.DOC_STATUS.COMPLETED;

        // แจ้งผู้สร้างและผู้ดำเนินการว่าเสร็จสิ้น
        WorkflowNotify.onCompleted(docId, doc.docNo, doc.subject, session.username, doc.createdBy);
      }

      // บันทึก workflow ที่อัปเดตกลับลง Sheets
      DbService.updateById(CONFIG.SHEETS.DOCS, docId, {
        workflow:    Utils.safeJsonStringify(workflow),
        status:      newStatus,
        currentStep: nextStep ? nextStep.step : currentStep.step,
        updateAt:    Utils.now()
      });

      LogService.workflowAction(session.username, docId, 'APPROVE', currentStep.step, remark);

      const msg = nextStep
        ? `ส่งต่อขั้นตอนที่ ${nextStep.step}: ${nextStep.label} สำเร็จ`
        : 'เอกสารได้รับการอนุมัติและเสร็จสิ้นแล้ว';
      return Utils.success({ newStatus, nextStep }, msg);

    } catch (e) {
      LogService.error('APPROVE', e.message);
      return Utils.error('เกิดข้อผิดพลาด: ' + e.message);
    }
  },

  /**
   * ปฏิเสธเอกสาร (คืนกลับหรือยุติ)
   * @param {Object} params
   * @param {string} params.docId
   * @param {string} params.remark - เหตุผลที่ปฏิเสธ (บังคับกรอก)
   * @param {boolean} params.returnToCreator - ส่งคืนผู้สร้าง (true) หรือยุติ (false)
   * @returns {{ success: boolean, message: string }}
   */
  reject({ docId, remark, returnToCreator }) {
    try {
      const session = AuthService.requireAuth();
      const doc     = DbService.findOne(CONFIG.SHEETS.DOCS, 'id', docId);

      if (!doc) return Utils.error('ไม่พบเอกสาร');
      if (!remark || remark.trim() === '')
        return Utils.error('กรุณาระบุเหตุผลในการปฏิเสธ');

      const workflow    = Utils.safeJsonParse(doc.workflow, { steps: [] });
      const currentStep = this._getCurrentStep(workflow);

      if (!currentStep) return Utils.error('ไม่มีขั้นตอนที่รออยู่');

      const authCheck = this._checkStepPermission(currentStep, session);
      if (!authCheck.allowed) return Utils.error(authCheck.message);

      // บันทึกการปฏิเสธ
      currentStep.status   = 'rejected';
      currentStep.signedBy = session.username;
      currentStep.signedAt = Utils.now();
      currentStep.remark   = remark;

      const newStatus = returnToCreator
        ? CONFIG.DOC_STATUS.DRAFT     // ส่งคืนให้แก้ไข
        : CONFIG.DOC_STATUS.REJECTED; // ยุติ

      if (returnToCreator) {
        // Reset workflow กลับ step 1
        workflow.steps.forEach(s => {
          s.status   = s.step === 1 ? 'pending' : 'waiting';
          s.signedBy = null;
          s.signedAt = null;
          if (s.step !== currentStep.step) s.remark = null;
        });
      }

      DbService.updateById(CONFIG.SHEETS.DOCS, docId, {
        workflow:    Utils.safeJsonStringify(workflow),
        status:      newStatus,
        currentStep: returnToCreator ? 1 : currentStep.step,
        updateAt:    Utils.now()
      });

      // แจ้งผู้สร้างว่าถูกปฏิเสธหรือส่งคืน
      WorkflowNotify.onRejected(docId, doc.docNo, doc.subject, session.username, doc.createdBy, remark, returnToCreator);

      LogService.workflowAction(session.username, docId, 'REJECT', currentStep.step, remark);

      return Utils.success({ newStatus },
        returnToCreator ? 'ส่งคืนผู้สร้างเพื่อแก้ไขแล้ว' : 'ปฏิเสธเอกสารแล้ว'
      );

    } catch (e) {
      LogService.error('REJECT', e.message);
      return Utils.error('เกิดข้อผิดพลาด: ' + e.message);
    }
  },

  /**
   * รับทราบ (สำหรับ step ประเภท acknowledge ที่มีหลาย dept)
   * @param {Object} params
   * @param {string} params.docId
   * @param {string} params.remark
   * @returns {{ success: boolean, message: string }}
   */
  acknowledge({ docId, remark }) {
    try {
      const session = AuthService.requireAuth();
      const doc     = DbService.findOne(CONFIG.SHEETS.DOCS, 'id', docId);
      if (!doc) return Utils.error('ไม่พบเอกสาร');

      const workflow    = Utils.safeJsonParse(doc.workflow, { steps: [] });
      const currentStep = this._getCurrentStep(workflow);
      if (!currentStep || currentStep.action !== 'acknowledge')
        return Utils.error('ไม่ใช่ขั้นตอนรับทราบ');

      const authCheck = this._checkStepPermission(currentStep, session);
      if (!authCheck.allowed) return Utils.error(authCheck.message);

      // บันทึกการรับทราบของ dept นี้
      if (!currentStep.acknowledgedBy) currentStep.acknowledgedBy = [];
      currentStep.acknowledgedBy.push({
        username: session.username,
        dept:     session.department,
        at:       Utils.now(),
        remark:   remark || ''
      });

      // ตรวจว่าทุก dept รับทราบแล้วหรือยัง
      const assignedDepts    = currentStep.assignedDepts || [];
      const acknowledgedDepts = currentStep.acknowledgedBy.map(a => a.dept);
      const allAcknowledged   = assignedDepts.every(d => acknowledgedDepts.includes(d));

      const remaining = assignedDepts.filter(d => !acknowledgedDepts.includes(d));

      if (allAcknowledged) {
        currentStep.status = 'approved';
        DbService.updateById(CONFIG.SHEETS.DOCS, docId, {
          workflow: Utils.safeJsonStringify(workflow),
          status:   CONFIG.DOC_STATUS.COMPLETED,
          updateAt: Utils.now()
        });
        WorkflowNotify.onAcknowledged(docId, doc.docNo, doc.subject,
          session.username, session.department, []);
        LogService.workflowAction(session.username, docId, 'ACKNOWLEDGE', currentStep.step, remark);
        return Utils.success(null, 'ทุกฝ่ายรับทราบแล้ว — เอกสารเสร็จสิ้น');
      } else {
        DbService.updateById(CONFIG.SHEETS.DOCS, docId, {
          workflow: Utils.safeJsonStringify(workflow),
          updateAt: Utils.now()
        });
        WorkflowNotify.onAcknowledged(docId, doc.docNo, doc.subject,
          session.username, session.department, remaining);
        LogService.workflowAction(session.username, docId, 'ACKNOWLEDGE', currentStep.step, remark);
        return Utils.success(null, `รับทราบแล้ว รอฝ่าย: ${remaining.join(', ')}`);
      }

    } catch (e) {
      return Utils.error(e.message);
    }
  },

  /**
   * ดึงสถานะ Workflow ของเอกสาร
   * @param {string} id - doc id
   * @returns {{ success: boolean, data: Object }}
   */
  getWorkflowStatus(id) {
    try {
      AuthService.requireAuth();
      const doc = DbService.findOne(CONFIG.SHEETS.DOCS, 'id', id);
      if (!doc) return Utils.error('ไม่พบเอกสาร');

      const workflow = Utils.safeJsonParse(doc.workflow, { steps: [] });
      return Utils.success({
        docId:       id,
        docNo:       doc.docNo,
        docStatus:   doc.status,
        currentStep: doc.currentStep,
        workflow
      });
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  // ─── Private Helpers ─────────────────────────────────────────

  /**
   * หา step ที่อยู่ในสถานะ pending
   * @private
   */
  _getCurrentStep(workflow) {
    return workflow.steps?.find(s => s.status === 'pending') || null;
  },

  /**
   * หา step ถัดไปหลังจาก stepNo ที่กำหนด
   * @private
   */
  _getNextStep(workflow, currentStepNo) {
    return workflow.steps?.find(s => s.step > currentStepNo && s.status === 'waiting') || null;
  },

  /**
   * ตรวจสิทธิ์ว่า session นี้สามารถดำเนินการ step นี้ได้หรือไม่
   * @private
   */
  _checkStepPermission(step, session) {
    return PermissionService.checkStepPermission(step, session);
  },

  /**
   * แจ้งเตือนผู้ใช้ที่เกี่ยวข้องใน step
   * @private
   */
  _notifyStepUsers(step, docId, docNo, subject) {
    if (step.action === 'acknowledge' && step.assignedDepts) {
      step.assignedDepts.forEach(dept => {
        NotifyService.sendToDepartment(dept, docId,
          `📋 มีเอกสารรอรับทราบ: [${docNo}] ${subject}`,
          CONFIG.ROLES.DEPT_HEAD
        );
      });
    } else if (step.dept) {
      NotifyService.sendToDepartment(step.dept, docId,
        `📄 มีเอกสารรอ${step.label}: [${docNo}] ${subject}`,
        step.role
      );
    } else {
      NotifyService.sendToRole(step.role, docId,
        `📄 มีเอกสารรอ${step.label}: [${docNo}] ${subject}`
      );
    }
  },

  /**
   * แปลง role key เป็นภาษาไทย
   * @private
   */
  _getRoleLabel(role) {
    const labels = {
      officer:      'เจ้าหน้าที่',
      dept_head:    'หัวหน้าฝ่าย',
      asst_manager: 'ผู้ช่วยผู้จัดการ',
      manager:      'ผู้จัดการ'
    };
    return labels[role] || role;
  }
};
