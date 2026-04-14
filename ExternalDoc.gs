// ============================================================
// ExternalDoc.gs — ระบบรับเอกสารภายนอก (Phase 4)
// ============================================================
// สิทธิ์: เฉพาะเจ้าหน้าที่ฝ่าย ฝอก. (officer + department = 'ฝอก.')
//
// รับผิดชอบ:
//   • listInboxFiles()     — ดึงรายการไฟล์จากโฟลเดอร์ INBOX
//   • receiveDocument()    — ลงรับเอกสาร (ฟังก์ชันหลัก):
//                           จองเลข → ย้ายไฟล์ INBOX→Archive
//                           → สร้าง Workflow → บันทึก DB_DOCS
//                           → แจ้งเตือน Step 2
//   • _buildExternalWorkflow()  — สร้าง Workflow JSON
//   • _moveFileToArchive()      — ย้ายไฟล์ใน Google Drive
//   • _notifyNextActor()        — แจ้งเตือนผู้ดำเนินการถัดไป
// ============================================================

const ExternalDoc = {

  // ─── Public API ───────────────────────────────────────────────

  /**
   * ดึงรายการไฟล์จากโฟลเดอร์ INBOX
   * สำหรับให้เจ้าหน้าที่ ฝอก. เลือกไฟล์ที่จะลงรับ
   *
   * @returns {{ success: boolean, data: Array<{
   *   id, name, mimeType, size, sizeLabel,
   *   url, previewUrl, thumbnailUrl, createdAt, createdAtTH
   * }> }}
   */
  listInboxFiles() {
    try {
      // ─── Auth + Permission ────────────────────────────────────
      const session = AuthService.requireAuth();
      this._requireFokOfficer(session);

      // ─── ตรวจ INBOX Folder ID ─────────────────────────────────
      if (!CONFIG.INBOX_FOLDER_ID || CONFIG.INBOX_FOLDER_ID === 'YOUR_INBOX_FOLDER_ID_HERE') {
        return Utils.error('ยังไม่ได้กำหนด INBOX_FOLDER_ID ใน Config.gs');
      }

      const inboxFolder = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);
      const files       = [];
      const iter        = inboxFolder.getFiles();

      while (iter.hasNext()) {
        const f    = iter.next();
        const mime = f.getMimeType();

        // กรองเฉพาะ PDF и ไฟล์ Word (docx/doc)
        const allowed = [
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/msword',
          'image/jpeg',
          'image/png',
          'image/tiff'           // ไฟล์สแกนจาก scanner
        ];
        if (!allowed.includes(mime)) continue;

        files.push({
          id:          f.getId(),
          name:        f.getName(),
          mimeType:    mime,
          size:        f.getSize(),
          sizeLabel:   this._formatFileSize(f.getSize()),
          url:         f.getUrl(),
          previewUrl:  `https://drive.google.com/file/d/${f.getId()}/preview`,
          downloadUrl: `https://drive.google.com/uc?export=download&id=${f.getId()}`,
          createdAt:   f.getDateCreated().toISOString(),
          createdAtTH: Utils.formatDateTH(f.getDateCreated(), true)
        });
      }

      // เรียงจากไฟล์ที่เข้ามาล่าสุดก่อน
      files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return Utils.success(files, `พบ ${files.length} ไฟล์ใน INBOX`);

    } catch (e) {
      LogService.error('LIST_INBOX', e.message);
      return Utils.error('โหลด INBOX ไม่สำเร็จ: ' + e.message);
    }
  },

  /**
   * ลงรับเอกสารภายนอก (ฟังก์ชันหลัก)
   *
   * ขั้นตอน:
   *  1. ตรวจสอบสิทธิ์ (officer + ฝอก. เท่านั้น)
   *  2. Validate ข้อมูล input
   *  3. ตรวจว่าไฟล์ยังอยู่ใน INBOX (ไม่ถูก claim ไปแล้ว)
   *  4. จองเลขเอกสารภายนอก (LockService-safe)
   *  5. ย้ายไฟล์จาก INBOX → Digital Archive (ย้าย, ไม่ copy)
   *  6. สร้าง Workflow JSON (step 1 = completed, step 2 = pending)
   *  7. เพิ่ม record ลงชีต DB_DOCS
   *  8. แจ้งเตือน asst_manager (step 2)
   *  9. เขียน Log
   *
   * @param {Object} params
   * @param {string} params.selectedFileId  - Google Drive File ID ที่เลือกจาก INBOX
   * @param {string} params.subject         - ชื่อเรื่องเอกสาร
   * @param {string} params.fromOrg         - จาก (หน่วยงานที่ส่งมา, free text)
   * @param {string} params.receiver        - เรียน (ผู้รับ / ตำแหน่ง, free text)
   * @param {Array}  params.assignedDepts   - ฝ่ายที่รับมอบหมาย (step 4 acknowledge)
   * @param {string} params.docDate         - วันที่ในหนังสือ (ISO string)
   * @param {string} params.urgency         - ชั้นความเร่งด่วน: 'normal'|'urgent'|'very_urgent'
   * @param {string} params.secrecy         - ชั้นความลับ: 'normal'|'confidential'|'secret'
   * @returns {{ success: boolean, data: { docId, docNo, fileId, archivePath }, message: string }}
   */
  receiveDocument(params) {
    try {
      // ─── 1. Auth & Permission ─────────────────────────────────
      const session = AuthService.requireAuth();
      this._requireFokOfficer(session);

      // ─── 2. Validate ─────────────────────────────────────────
      if (Utils.isEmpty(params.selectedFileId)) return Utils.error('กรุณาเลือกไฟล์จาก INBOX');
      if (Utils.isEmpty(params.subject))        return Utils.error('กรุณากรอกชื่อเรื่องเอกสาร');
      if (Utils.isEmpty(params.fromOrg))        return Utils.error('กรุณากรอกหน่วยงานที่ส่ง (จาก)');
      if (Utils.isEmpty(params.receiver))       return Utils.error('กรุณากรอกผู้รับ (เรียน)');
      if (Utils.isEmpty(params.docDate))        return Utils.error('กรุณาระบุวันที่ในหนังสือ');

      const assignedDepts = Array.isArray(params.assignedDepts) ? params.assignedDepts : [];
      const docDate       = new Date(params.docDate);
      const urgency       = params.urgency  || 'normal';
      const secrecy       = params.secrecy  || 'normal';

      // ─── 3. ตรวจสอบไฟล์ยังอยู่ใน INBOX ──────────────────────
      let inboxFile;
      try {
        inboxFile = DriveApp.getFileById(params.selectedFileId);
      } catch (_) {
        return Utils.error('ไม่พบไฟล์ที่เลือก — อาจถูกลบหรือย้ายไปแล้ว');
      }

      // ตรวจว่าไฟล์ยังอยู่ในโฟลเดอร์ INBOX จริง (ป้องกัน claim ซ้ำ)
      if (!this._isFileInFolder(inboxFile, CONFIG.INBOX_FOLDER_ID)) {
        return Utils.error('ไฟล์นี้ถูกลงรับไปแล้ว — กรุณารีเฟรช INBOX');
      }

      // ─── 4. จองเลขเอกสารภายนอก (Thread-Safe) ────────────────
      const reserveResult = DocNumber.reserveDocumentNumber('external', '');
      if (!reserveResult.success) {
        return Utils.error('จองเลขเอกสารไม่สำเร็จ: ' + reserveResult.message);
      }
      const docNo = reserveResult.data.docNo;

      // ─── 5. ย้ายไฟล์ INBOX → Archive ─────────────────────────
      const moveResult = this._moveFileToArchive(inboxFile, docDate, docNo, params.subject);

      // ─── 6. Build Workflow JSON ───────────────────────────────
      const workflow = this._buildExternalWorkflow(session, assignedDepts);

      // ─── 7. Build & Insert DB Record ─────────────────────────
      const docId = Utils.generateId();
      const docRecord = {
        id:            docId,
        docType:       CONFIG.DOC_TYPES.EXTERNAL,
        docNo:         docNo,
        date:          Utils.toISODate(docDate),
        subject:       params.subject,
        sender:        params.fromOrg,
        receiver:      params.receiver,
        assignedDepts: Utils.safeJsonStringify(assignedDepts),
        status:        CONFIG.DOC_STATUS.IN_PROGRESS,   // step 1 done → ส่งขึ้น workflow
        fileId:        moveResult.fileId,
        originalFileId: moveResult.fileId,
        urgency:       urgency,
        secrecy:       secrecy,
        workflow:      Utils.safeJsonStringify(workflow),
        currentStep:   2,                               // step 1 เสร็จ → รอ step 2
        createdBy:     session.username,
        createdAt:     Utils.now(),
        updateAt:      Utils.now()
      };

      DbService.insert(CONFIG.SHEETS.DOCS, docRecord);

      // ─── 8. แจ้งเตือน Step 2 (asst_manager) ──────────────────
      this._notifyNextActor(workflow, 2, docId, docNo, params.subject, session.username);

      // ─── 9. Log ───────────────────────────────────────────────
      LogService.write(
        session.username,
        'RECEIVE_EXTERNAL_DOC',
        docId,
        `ลงรับ ${docNo} — "${params.subject}" จาก ${params.fromOrg} (fileId: ${moveResult.fileId})`
      );

      return Utils.success(
        {
          docId,
          docNo,
          fileId:      moveResult.fileId,
          fileUrl:     moveResult.fileUrl,
          archivePath: moveResult.archivePath
        },
        `ลงรับเอกสาร ${docNo} สำเร็จ — ส่งให้ผู้ช่วยผู้จัดการลงนามแล้ว`
      );

    } catch (e) {
      LogService.error('RECEIVE_EXTERNAL_DOC', e.message);
      return Utils.error('เกิดข้อผิดพลาดในการลงรับเอกสาร: ' + e.message);
    }
  },

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * สร้าง Workflow JSON สำหรับเอกสารภายนอก
   *
   * step 1 (officer/ฝอก./receive)  = completed  ← ผู้ลงรับทำเสร็จแล้ว
   * step 2 (asst_manager/sign)     = pending    ← รอ
   * step 3 (manager/command)       = waiting
   * step 4 (dept_head/acknowledge) = waiting    ← multi-dept
   *
   * @param {Object} session       - Session ของผู้ลงรับ
   * @param {Array}  assignedDepts - ฝ่ายที่รับมอบหมาย (สำหรับ step 4)
   * @returns {Object} Workflow object
   * @private
   */
  _buildExternalWorkflow(session, assignedDepts) {
    const template = CONFIG.WORKFLOW_EXTERNAL;
    const now      = Utils.now();

    const steps = template.map(t => {
      let status   = 'waiting';
      let signedBy = null;
      let signedAt = null;

      if (t.step === 1) {
        status   = 'completed';
        signedBy = session.username;
        signedAt = now;
      } else if (t.step === 2) {
        status = 'pending';
      }

      // step 4 (acknowledge) ได้รับ assignedDepts
      const stepAssignedDepts = (t.action === 'acknowledge' && assignedDepts.length > 0)
        ? assignedDepts
        : null;

      return {
        step:          t.step,
        role:          t.role,
        dept:          t.dept || null,      // ฝอก. สำหรับ step 1, null สำหรับที่เหลือ
        label:         t.label,
        action:        t.action,
        status,
        signedBy,
        signedAt,
        remark:        null,
        assignedDepts: stepAssignedDepts
      };
    });

    return {
      docType: CONFIG.DOC_TYPES.EXTERNAL,
      steps
    };
  },

  /**
   * ย้ายไฟล์จากโฟลเดอร์ INBOX ไปยัง Digital Archive
   *
   * ใช้ DriveApp addFile/removeFile เพื่อ "ย้าย" (ไม่ใช่ copy)
   * ตั้ง description และ sharing ให้ไฟล์หลังย้าย
   *
   * @param {GoogleAppsScript.Drive.File} file     - File object จาก INBOX
   * @param {Date}   docDate  - วันที่เอกสาร (ใช้สร้าง path Archive)
   * @param {string} docNo    - เลขเอกสาร (ใช้ตั้ง description)
   * @param {string} subject  - ชื่อเรื่อง (ใช้ตั้ง description)
   * @returns {{ fileId: string, fileUrl: string, archivePath: string }}
   * @private
   */
  _moveFileToArchive(file, docDate, docNo, subject) {
    // สร้าง/ค้นหาโฟลเดอร์ Archive ปลายทาง
    const archiveFolder = Archive.getArchiveFolder(CONFIG.DOC_TYPES.EXTERNAL, docDate);
    const archivePath   = Archive.getArchiveFolderPath(CONFIG.DOC_TYPES.EXTERNAL, docDate);

    // ย้ายไฟล์: เพิ่มใน Archive → ลบออกจาก INBOX
    archiveFolder.addFile(file);
    try {
      const inboxFolder = DriveApp.getFolderById(CONFIG.INBOX_FOLDER_ID);
      inboxFolder.removeFile(file);
    } catch (_) {
      // ถ้าลบออกจาก INBOX ไม่ได้ ไม่ถือว่า fatal — ไฟล์ยังอยู่ใน Archive แล้ว
      LogService.error('INBOX_REMOVE', `ไม่สามารถลบออกจาก INBOX: ${file.getId()}`);
    }

    // ตั้ง sharing + description
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    file.setDescription(`[${docNo}] ${subject}`);

    const fileId = file.getId();
    return {
      fileId,
      fileUrl:     `https://drive.google.com/file/d/${fileId}/view`,
      archivePath
    };
  },

  /**
   * แจ้งเตือนผู้ดำเนินการในขั้นตอนที่กำหนด
   *
   * @param {Object} workflow      - Workflow object
   * @param {number} stepNo        - หมายเลข step ที่ต้องแจ้ง
   * @param {string} docId         - ID เอกสาร
   * @param {string} docNo         - เลขเอกสาร
   * @param {string} subject       - ชื่อเรื่อง
   * @param {string} fromUsername  - ผู้ลงรับ
   * @private
   */
  _notifyNextActor(workflow, stepNo, docId, docNo, subject, fromUsername) {
    try {
      const step = workflow.steps.find(s => s.step === stepNo);
      if (!step || step.status !== 'pending') return;

      const msg = `📨 มีเอกสารภายนอกรอ${step.label}: [${docNo}] ${subject}`;

      if (step.action === 'acknowledge' && step.assignedDepts && step.assignedDepts.length > 0) {
        step.assignedDepts.forEach(dept => {
          NotifyService.sendToDepartment(dept, docId, msg, CONFIG.ROLES.DEPT_HEAD);
        });
      } else if (step.dept) {
        NotifyService.sendToDepartment(step.dept, docId, msg, step.role);
      } else {
        NotifyService.sendToRole(step.role, docId, msg);
      }
    } catch (e) {
      LogService.error('NOTIFY_EXTERNAL_STEP', e.message);
    }
  },

  /**
   * ตรวจว่าไฟล์อยู่ใน folder ที่กำหนดหรือไม่
   * @param {GoogleAppsScript.Drive.File} file
   * @param {string} folderId
   * @returns {boolean}
   * @private
   */
  _isFileInFolder(file, folderId) {
    try {
      const parents = file.getParents();
      while (parents.hasNext()) {
        if (parents.next().getId() === folderId) return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  },

  /**
   * ตรวจสิทธิ์: เฉพาะ officer ของฝ่าย ฝอก. เท่านั้น
   * @param {Object} session
   * @throws {Error} ถ้าไม่มีสิทธิ์
   * @private
   */
  _requireFokOfficer(session) {
    if (!session) throw new Error('กรุณาเข้าสู่ระบบก่อน');
    if (!PermissionService.canReceiveExternal(session)) {
      throw new Error('สิทธิ์การลงรับเอกสารภายนอกสำหรับเจ้าหน้าที่ ฝอก. เท่านั้น');
    }
  },

  /**
   * Format ขนาดไฟล์ให้อ่านง่าย
   * @param {number} bytes
   * @returns {string}
   * @private
   */
  _formatFileSize(bytes) {
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1048576)    return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(1)} GB`;
  }

};
