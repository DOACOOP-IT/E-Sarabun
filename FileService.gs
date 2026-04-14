// ============================================================
// FileService.gs — จัดการไฟล์แนบบน Google Drive
// ============================================================
// - สร้างโฟลเดอร์ตาม ปี(พ.ศ.) > เดือน > วัน > ประเภทเอกสาร
// - อัปโหลดไฟล์ Word (.docx) และ PDF
// - แปลง Word เป็น PDF อัตโนมัติ (ผ่าน Google Docs conversion)
// ============================================================

const FileService = {

  // ─── Upload ───────────────────────────────────────────────────

  /**
   * อัปโหลดไฟล์แนบ (รับเป็น base64 blob จาก frontend)
   * @param {Object} params
   * @param {string} params.docId      - ID เอกสารที่แนบ
   * @param {string} params.docType    - 'internal' | 'external'
   * @param {string} params.fileName   - ชื่อไฟล์ (รวมนามสกุล)
   * @param {string} params.mimeType   - MIME type เช่น 'application/pdf'
   * @param {string} params.base64Data - ข้อมูลไฟล์ encoded base64
   * @param {Date}   params.docDate    - วันที่เอกสาร (ใช้สร้างโฟลเดอร์)
   * @returns {{ success: boolean, data: { fileId, fileUrl, pdfFileId? } }}
   */
  uploadFile({ docId, docType, fileName, mimeType, base64Data, docDate }) {
    try {
      const session = AuthService.requireAuth();

      if (!base64Data) return Utils.error('ไม่มีข้อมูลไฟล์');
      if (!fileName)   return Utils.error('กรุณาระบุชื่อไฟล์');

      // ตรวจนามสกุลที่อนุญาต
      const ext = this._getExtension(fileName).toLowerCase();
      if (!['pdf', 'docx', 'doc'].includes(ext)) {
        return Utils.error('รองรับเฉพาะไฟล์ PDF และ Word (.docx, .doc) เท่านั้น');
      }

      // สร้างโฟลเดอร์ตาม path — ผ่าน Archive.gs
      const folder = Archive.getArchiveFolder(docType, docDate || new Date());

      // Decode base64 → Blob
      const decoded  = Utilities.base64Decode(base64Data);
      const blob     = Utilities.newBlob(decoded, mimeType, fileName);

      // สร้างไฟล์ใน Drive
      const file   = folder.createFile(blob);
      const fileId = file.getId();

      // ตั้ง permission — ใครก็ดูได้ (สำหรับ preview)
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

      let pdfFileId = null;

      // ถ้าเป็น Word — แปลงเป็น PDF อัตโนมัติ ผ่าน Archive.gs
      if (['docx', 'doc'].includes(ext)) {
        const pdfFile = Archive.convertAndSaveWordToPdf(file.getBlob(), fileName, docType, docDate || new Date());
        if (pdfFile) {
          pdfFileId = pdfFile.getId();
          pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        }
      }

      // อัปเดต fileId ใน DB_DOCS
      if (docId) {
        DbService.updateById(CONFIG.SHEETS.DOCS, docId, {
          fileId:    pdfFileId || fileId, // เลือก PDF ถ้ามี
          updateAt:  Utils.now()
        });
      }

      LogService.uploadFile(session.username, docId, pdfFileId || fileId, fileName);

      return Utils.success({
        fileId:    fileId,
        pdfFileId: pdfFileId,
        fileUrl:   `https://drive.google.com/file/d/${pdfFileId || fileId}/view`,
        fileName:  fileName
      }, 'อัปโหลดไฟล์สำเร็จ');

    } catch (e) {
      LogService.error('UPLOAD_FILE', e.message);
      return Utils.error('เกิดข้อผิดพลาดในการอัปโหลด: ' + e.message);
    }
  },

  /**
   * ดึง URL ของไฟล์สำหรับ preview/download
   * @param {string} fileId - Google Drive File ID
   * @returns {{ success: boolean, data: { url, previewUrl } }}
   */
  getFileUrl(fileId) {
    try {
      const session = AuthService.requireAuth();
      if (!fileId) return Utils.error('ไม่ระบุ fileId');

      const docs = DbService.getAll(CONFIG.SHEETS.DOCS)
        .filter(doc => doc.status !== 'deleted');
      const doc = PermissionService.findDocByFileId(fileId, docs, session);
      if (!doc) {
        return Utils.error('ไม่มีสิทธิ์เข้าถึงไฟล์นี้');
      }

      const file = DriveApp.getFileById(fileId);
      return Utils.success({
        url:        file.getUrl(),
        previewUrl: `https://drive.google.com/file/d/${fileId}/preview`,
        downloadUrl:`https://drive.google.com/uc?export=download&id=${fileId}`,
        name:       file.getName()
      });
    } catch (e) {
      return Utils.error('ไม่สามารถดึง URL ไฟล์ได้: ' + e.message);
    }
  },

  // ─── Folder Management & Word→PDF ─── delegated to Archive.gs ─

  // ─── Helpers ─────────────────────────────────────────────────

  /**
   * ดึงนามสกุลไฟล์
   * @private
   */
  _getExtension(fileName) {
    const parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1] : '';
  },

  /**
   * ดึงรายการไฟล์ในโฟลเดอร์ของเอกสาร (สำหรับ Archive)
   * @param {string} docType
   * @param {Date}   date
   * @returns {Array<Object>}
   */
  listFilesInFolder(docType, date) {
    try {
      AuthService.requireAuth();
      // Delegate to Archive.gs
      return Archive.listFiles({ docType, date });
    } catch (e) {
      return Utils.error('เกิดข้อผิดพลาด: ' + e.message);
    }
  },

  // Keep stub for backward-compat (unused internally)
  _listFilesInFolder_legacy(docType, date) {
    try {
      AuthService.requireAuth();
      const folder = Archive.getArchiveFolder(docType, date);
      const files  = [];
      const iter   = folder.getFiles();
      while (iter.hasNext()) {
        const f = iter.next();
        files.push({
          id:       f.getId(),
          name:     f.getName(),
          mimeType: f.getMimeType(),
          size:     f.getSize(),
          url:      f.getUrl(),
          createdAt: f.getDateCreated().toISOString()
        });
      }
      return Utils.success(files);
    } catch (e) {
      return Utils.error(e.message);
    }
  }
};
