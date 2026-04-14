// ============================================================
// InternalDoc.gs — ระบบเอกสารภายใน (Phase 3)
// ============================================================
// รับผิดชอบ:
//   • processAndSaveFile()  — รับข้อมูลฟอร์ม + ไฟล์ base64
//                             แปลง Word→PDF, บันทึก Archive,
//                             เพิ่ม DB_DOCS + สร้าง Workflow JSON
//   • _buildInternalWorkflow() — สร้างโครงสร้าง Workflow เริ่มต้น
//   • _notifyNextActor()       — แจ้งเตือนผู้ดำเนินการขั้นถัดไป
// ============================================================

const InternalDoc = {

  // ─── Public API ───────────────────────────────────────────────

  /**
   * ประมวลผลและบันทึกเอกสารภายใน (ฟังก์ชันหลัก)
   *
   * ขั้นตอน:
   *  1. ตรวจสอบสิทธิ์ (requireAuth)
   *  2. Validate ข้อมูล input
   *  3. Decode base64 → Blob
   *  4. บันทึกไฟล์ต้นฉบับลง Archive
   *  5. ถ้าเป็น Word → แปลงเป็น PDF ผ่าน Drive API อัตโนมัติ
   *  6. สร้าง Workflow JSON เริ่มต้น (step 1 = completed, step 2 = pending)
   *  7. เพิ่ม record ลงชีต DB_DOCS
   *  8. แจ้งเตือนหัวหน้าฝ่ายต้นเรื่อง (step 2)
   *  9. เขียน Log
   *
   * @param {Object} params
   * @param {string} params.docNo         - เลขเอกสารที่จองแล้ว เช่น "ฝอก.001/2569"
   * @param {string} params.subject       - ชื่อเรื่องเอกสาร
   * @param {string} params.senderDept    - ฝ่ายผู้จัดทำ เช่น "ฝอก."
   * @param {Array}  params.assignedDepts - ฝ่ายที่เกี่ยวข้อง (array of string)
   * @param {string} params.docDate       - วันที่เอกสาร (ISO string, optional; default = วันนี้)
   * @param {string} params.fileName      - ชื่อไฟล์ (รวมนามสกุล)
   * @param {string} params.mimeType      - MIME type เช่น 'application/pdf'
   * @param {string} params.base64Data    - ข้อมูลไฟล์ encoded base64
   * @returns {{ success: boolean, data: { docId, docNo, fileId, pdfFileId }, message: string }}
   */
  processAndSaveFile(params) {
    try {
      // ─── 1. Auth ─────────────────────────────────────────────
      const session = AuthService.requireAuth();

      // ─── 2. Validate ─────────────────────────────────────────
      if (Utils.isEmpty(params.docNo))      return Utils.error('กรุณาจองเลขเอกสารก่อนบันทึก');
      if (Utils.isEmpty(params.subject))    return Utils.error('กรุณากรอกชื่อเรื่องเอกสาร');
      if (Utils.isEmpty(params.senderDept)) return Utils.error('ไม่พบข้อมูลฝ่ายผู้จัดทำ');
      if (Utils.isEmpty(params.fileName))   return Utils.error('กรุณาแนบไฟล์เอกสาร');
      if (Utils.isEmpty(params.base64Data)) return Utils.error('ไม่พบข้อมูลไฟล์ที่อัปโหลด');

      const ext = this._getExtension(params.fileName).toLowerCase();
      if (!['pdf', 'docx', 'doc'].includes(ext)) {
        return Utils.error('รองรับเฉพาะไฟล์ PDF และ Word (.docx, .doc) เท่านั้น');
      }

      // ตรวจว่าเลขเอกสารนี้ยังไม่มีใน DB (ป้องกัน duplicate)
      const existing = DbService.findOne(CONFIG.SHEETS.DOCS, 'docNo', params.docNo);
      if (existing) {
        return Utils.error(`เลขเอกสาร ${params.docNo} ถูกใช้งานแล้ว`);
      }

      // ─── 3. Decode base64 → Blob ──────────────────────────────
      const docDate   = params.docDate ? new Date(params.docDate) : new Date();
      const decoded   = Utilities.base64Decode(params.base64Data);
      const blob      = Utilities.newBlob(decoded, params.mimeType, params.fileName);

      // ─── 4. บันทึกไฟล์ต้นฉบับลง Archive ─────────────────────
      const savedOriginal = Archive.saveFile(blob, CONFIG.DOC_TYPES.INTERNAL, docDate, {
        description: `เอกสารภายใน ${params.docNo} — ${params.subject}`
      });
      const originalFileId = savedOriginal.fileId;

      // ─── 5. แปลง Word → PDF (ถ้าเป็น .doc/.docx) ─────────────
      let finalFileId = originalFileId;
      let pdfFileId   = null;

      if (['docx', 'doc'].includes(ext)) {
        const pdfResult = Archive.convertAndSaveWordToPdf(
          blob, params.fileName, CONFIG.DOC_TYPES.INTERNAL, docDate
        );

        if (pdfResult && pdfResult.success) {
          pdfFileId   = pdfResult.data.fileId;
          finalFileId = pdfFileId; // ใช้ PDF เป็นไฟล์หลัก
        }
        // ถ้าแปลงไม่สำเร็จ ยังใช้ originalFileId ต่อได้ (degraded gracefully)
      }

      // ─── 6. Build Workflow JSON (step 1 = completed) ──────────
      const workflow = this._buildInternalWorkflow(session, params.senderDept);

      // ─── 7. Build DB Record ──────────────────────────────────
      const docId = Utils.generateId();
      const docRecord = {
        id:            docId,
        docType:       CONFIG.DOC_TYPES.INTERNAL,
        docNo:         params.docNo,
        date:          Utils.toISODate(docDate),
        subject:       params.subject,
        sender:        params.senderDept,
        receiver:      (params.assignedDepts || []).join(', '),
        assignedDepts: Utils.safeJsonStringify(params.assignedDepts || []),
        status:        CONFIG.DOC_STATUS.IN_PROGRESS,  // step 1 done → เข้า workflow
        fileId:        finalFileId,
        originalFileId: originalFileId,
        workflow:      Utils.safeJsonStringify(workflow),
        currentStep:   2,  // step 1 เสร็จแล้ว → รอ step 2
        createdBy:     session.username,
        createdAt:     Utils.now(),
        updateAt:      Utils.now()
      };

      // ─── 8. Insert ลง DB_DOCS ────────────────────────────────
      DbService.insert(CONFIG.SHEETS.DOCS, docRecord);

      // ─── 9. แจ้งเตือน step 2 (dept_head ของฝ่ายต้นเรื่อง) ────
      this._notifyNextActor(workflow, 2, docId, params.docNo, params.subject, session.username);

      // ─── Log ─────────────────────────────────────────────────
      LogService.write(
        session.username,
        'CREATE_INTERNAL_DOC',
        docId,
        `สร้างเอกสารภายใน ${params.docNo} — ${params.subject} (fileId: ${finalFileId})`
      );

      return Utils.success(
        {
          docId,
          docNo:       params.docNo,
          fileId:      finalFileId,
          pdfFileId,
          originalFileId,
          archivePath: savedOriginal.folder
        },
        `บันทึกเอกสาร ${params.docNo} สำเร็จ — ส่งให้หัวหน้าฝ่ายลงนามแล้ว`
      );

    } catch (e) {
      LogService.error('PROCESS_INTERNAL_DOC', e.message);
      return Utils.error('เกิดข้อผิดพลาดในการบันทึกเอกสาร: ' + e.message);
    }
  },

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * สร้าง Workflow JSON เริ่มต้นสำหรับเอกสารภายใน
   *
   * step 1 (officer/create) = completed  ← ผู้สร้างทำเสร็จแล้ว
   * step 2 (dept_head/sign) = pending    ← รอหัวหน้าฝ่ายต้นเรื่อง
   * step 3 (asst_manager)   = waiting
   * step 4 (manager)        = waiting
   *
   * @param {Object} session    - Session ของผู้สร้าง
   * @param {string} senderDept - ฝ่ายต้นเรื่อง (ใช้กำหนด dept สำหรับ step 2)
   * @returns {Object} workflow object พร้อม steps array
   * @private
   */
  _buildInternalWorkflow(session, senderDept) {
    const template = CONFIG.WORKFLOW_INTERNAL;
    const now      = Utils.now();

    const steps = template.map(t => {
      let status   = 'waiting';
      let signedBy = null;
      let signedAt = null;

      if (t.step === 1) {
        // step 1 (create) เสร็จแล้วตอนที่ officer สร้างเอกสาร
        status   = 'completed';
        signedBy = session.username;
        signedAt = now;
      } else if (t.step === 2) {
        // step 2 เป็น current step → pending
        status = 'pending';
      }

      return {
        step:          t.step,
        role:          t.role,
        dept:          t.step <= 2 ? senderDept : (t.dept || null),
        label:         t.label,
        action:        t.action,
        status,
        signedBy,
        signedAt,
        remark:        null,
        assignedDepts: null
      };
    });

    return {
      docType: CONFIG.DOC_TYPES.INTERNAL,
      steps
    };
  },

  /**
   * แจ้งเตือนผู้ดำเนินการในขั้นตอนที่กำหนด
   *
   * @param {Object} workflow   - workflow object ที่สร้าง
   * @param {number} stepNo     - หมายเลข step ที่ต้องแจ้ง
   * @param {string} docId      - ID เอกสาร
   * @param {string} docNo      - เลขเอกสาร
   * @param {string} subject    - ชื่อเรื่อง
   * @param {string} fromUsername - ผู้สร้าง (ใช้กัน notify ตัวเอง)
   * @private
   */
  _notifyNextActor(workflow, stepNo, docId, docNo, subject, fromUsername) {
    try {
      const step = workflow.steps.find(s => s.step === stepNo);
      if (!step) return;

      const msg = `📝 มีเอกสารภายในรอ${step.label}: [${docNo}] ${subject}`;

      if (step.dept) {
        // แจ้งเฉพาะฝ่ายที่กำหนดตาม role (เช่น dept_head ของ ฝอก.)
        NotifyService.sendToDepartment(step.dept, docId, msg, step.role);
      } else {
        // แจ้งตาม role ทั่วไป (asst_manager, manager ไม่ผูกกับฝ่าย)
        NotifyService.sendToRole(step.role, docId, msg);
      }
    } catch (e) {
      // Notification failure ไม่ควร block การบันทึกเอกสาร
      LogService.error('NOTIFY_INTERNAL_STEP', e.message);
    }
  },

  /**
   * ดึงนามสกุลไฟล์จากชื่อไฟล์
   * @param {string} fileName
   * @returns {string} นามสกุล (ไม่มีจุด)
   * @private
   */
  _getExtension(fileName) {
    const parts = String(fileName).split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  }

};
