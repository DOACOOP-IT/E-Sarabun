// ============================================================
// Workflow.gs — Workflow Query Layer | E-Sarabun DMS
// ============================================================
// รับผิดชอบ: ดึงรายการเอกสารที่รอดำเนินการ, ดึงรายละเอียดเอกสาร
// การอนุมัติ/ปฏิเสธ/รับทราบ → ใช้ WorkflowService.gs
// ============================================================

const WorkflowQuery = {

  /**
   * ดึงรายการเอกสารที่รอดำเนินการโดยผู้ใช้ปัจจุบัน
   * — หา step ที่ status='pending' ซึ่ง role + dept ตรงกับ session
   * @returns {{ success: boolean, data: Array<Object> }}
   */
  getPendingDocs() {
    try {
      const session = AuthService.requireAuth();
      const allDocs = DbService.getAll(CONFIG.SHEETS.DOCS)
        .filter(doc => doc.status !== 'deleted');

      const pending = PermissionService.getPendingDocsForSession(allDocs, session);

      const result = pending.map(doc => {
        const pendingStep = PermissionService.getCurrentPendingStep(doc);
        return {
          id:          doc.id,
          docNo:       doc.docNo,
          docType:     doc.docType,
          subject:     doc.subject,
          sender:      doc.sender,
          receiver:    doc.receiver || '',
          status:      doc.status,
          currentStep: doc.currentStep,
          stepNo:      pendingStep?.step || 0,
          stepLabel:   pendingStep?.label || '',
          stepAction:  pendingStep?.action || 'approve',
          urgency:     doc.urgency || '',
          secrecy:     doc.secrecy || '',
          createdBy:   doc.createdBy,
          createdAt:   doc.createdAt,
          updateAt:    doc.updateAt
        };
      }).sort((a, b) => new Date(b.updateAt) - new Date(a.updateAt));

      return Utils.success(result);

    } catch (e) {
      LogService.error('PENDING_DOCS', e.message);
      return Utils.error('ดึงรายการเอกสารไม่สำเร็จ: ' + e.message);
    }
  },

  /**
   * นับจำนวนเอกสารที่รอดำเนินการ (สำหรับ badge แจ้งเตือน)
   * @returns {{ success: boolean, data: { count: number } }}
   */
  getMyPendingCount() {
    try {
      const result = this.getPendingDocs();
      const count  = (result.success && Array.isArray(result.data)) ? result.data.length : 0;
      return Utils.success({ count });
    } catch (e) {
      return Utils.success({ count: 0 });
    }
  },

  /**
   * ดึงรายละเอียดเอกสารสำหรับหน้า Approve
   * รวม: ข้อมูล doc, workflow object, logs 20 รายการล่าสุด, URL ไฟล์
   * @param {string} docId
   * @returns {{ success: boolean, data: Object }}
   */
  getDocDetail(docId) {
    try {
      const session = AuthService.requireAuth();
      const doc = DbService.findOne(CONFIG.SHEETS.DOCS, 'id', docId);
      if (!doc) return Utils.error('ไม่พบเอกสาร');
      if (!PermissionService.canViewDoc(doc, session)) {
        return Utils.error('ไม่มีสิทธิ์ดูเอกสารนี้');
      }

      const workflow = Utils.safeJsonParse(doc.workflow, { steps: [] });
      const logs     = LogService.getDocLogs(docId).slice(0, 20);

      // สร้าง preview URL สำหรับ iframe (PDF viewer)
      let previewUrl = null;
      if (doc.fileId) {
        previewUrl = `https://drive.google.com/file/d/${doc.fileId}/preview`;
      }

      return Utils.success({
        id:            doc.id,
        docNo:         doc.docNo,
        docType:       doc.docType,
        subject:       doc.subject,
        sender:        doc.sender,
        receiver:      doc.receiver || '',
        assignedDepts: Utils.safeJsonParse(doc.assignedDepts, []),
        date:          doc.date,
        urgency:       doc.urgency || '',
        secrecy:       doc.secrecy || '',
        status:        doc.status,
        currentStep:   doc.currentStep,
        createdBy:     doc.createdBy,
        createdAt:     doc.createdAt,
        updateAt:      doc.updateAt,
        fileId:        doc.fileId || null,
        originalFileId: doc.originalFileId || null,
        previewUrl,
        workflow,
        logs
      });

    } catch (e) {
      LogService.error('DOC_DETAIL', e.message);
      return Utils.error('ดึงรายละเอียดเอกสารไม่สำเร็จ: ' + e.message);
    }
  }

};
