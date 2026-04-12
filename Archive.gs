// ============================================================
// Archive.gs — ระบบแฟ้มจัดเก็บดิจิทัล (Digital Archive)
// ============================================================
// รับผิดชอบ:
//   • สร้าง/ค้นหาโฟลเดอร์ Google Drive ตาม path
//     Root → ปี(พ.ศ.) → เดือน → วัน → ประเภทเอกสาร
//   • List ไฟล์ในโฟลเดอร์
//   • ค้นหาเอกสารใน Archive
// ============================================================

const Archive = {

  // ─── Folder Name Maps ─────────────────────────────────────────

  /** ชื่อโฟลเดอร์ประเภทเอกสาร */
  FOLDER_NAMES: {
    internal: 'เอกสารภายใน',
    external: 'เอกสารภายนอก'
  },

  /** ชื่อเดือนภาษาไทย (ใช้เป็นชื่อโฟลเดอร์) */
  MONTH_NAMES: [
    'มกราคม','กุมภาพันธ์','มีนาคม',
    'เมษายน','พฤษภาคม','มิถุนายน',
    'กรกฎาคม','สิงหาคม','กันยายน',
    'ตุลาคม','พฤศจิกายน','ธันวาคม'
  ],

  // ─── Core: getArchiveFolder ──────────────────────────────────

  /**
   * ดึงหรือสร้างโฟลเดอร์ Archive ตาม path:
   *   Root → ปี(พ.ศ.) → เดือน → วัน → ประเภทเอกสาร
   *
   * @param {string} docType  - 'internal' | 'external'
   * @param {Date}   [date]   - วันที่เอกสาร (default: วันนี้)
   * @returns {GoogleAppsScript.Drive.Folder} โฟลเดอร์ปลายทาง
   *
   * @example
   *   Archive.getArchiveFolder('external', new Date('2026-04-12'))
   *   // ผลลัพธ์: E-Sarabun / 2569 / เมษายน / 12 / เอกสารภายนอก
   */
  getArchiveFolder(docType, date) {
    const d = date ? new Date(date) : new Date();

    // ─── Validate docType ─────────────────────────────────────
    const folderTypeName = this.FOLDER_NAMES[docType];
    if (!folderTypeName) {
      throw new Error(`docType ไม่ถูกต้อง: "${docType}" — ต้องเป็น internal หรือ external`);
    }

    // ─── คำนวณ path segments ──────────────────────────────────
    const buddhistYear = Utils.toBuddhistYear(d);            // เช่น 2569
    const monthName    = this.MONTH_NAMES[d.getMonth()];     // เช่น "เมษายน"
    const dayPadded    = String(d.getDate()).padStart(2,'0'); // เช่น "12"

    // ─── สร้างโฟลเดอร์ตามลำดับ ────────────────────────────────
    let folder = DriveApp.getFolderById(CONFIG.DRIVE_ROOT_FOLDER_ID);

    const pathSegments = [
      String(buddhistYear), // "2569"
      monthName,            // "เมษายน"
      dayPadded,            // "12"
      folderTypeName        // "เอกสารภายนอก"
    ];

    for (const segment of pathSegments) {
      folder = this._getOrCreateSubFolder(folder, segment);
    }

    return folder;
  },

  /**
   * ดึง path ของโฟลเดอร์เป็น string (สำหรับแสดงใน UI)
   * @param {string} docType
   * @param {Date}   [date]
   * @returns {string} เช่น "E-Sarabun/2569/เมษายน/12/เอกสารภายนอก"
   */
  getArchiveFolderPath(docType, date) {
    const d            = date ? new Date(date) : new Date();
    const buddhistYear = Utils.toBuddhistYear(d);
    const monthName    = this.MONTH_NAMES[d.getMonth()];
    const dayPadded    = String(d.getDate()).padStart(2,'0');
    const typeName     = this.FOLDER_NAMES[docType] || docType;
    return `E-Sarabun/${buddhistYear}/${monthName}/${dayPadded}/${typeName}`;
  },

  // ─── File Operations ─────────────────────────────────────────

  /**
   * บันทึกไฟล์ลง Archive พร้อม permission
   * ใช้แทน DriveApp.createFile() โดยตรง เพื่อ centralize logic
   *
   * @param {GoogleAppsScript.Base.Blob} blob - ไฟล์ที่ต้องการบันทึก
   * @param {string} docType - 'internal' | 'external'
   * @param {Date}   [date]
   * @param {Object} [options]
   * @param {boolean} [options.publicView=true]  - ให้ view ผ่าน link ได้หรือไม่
   * @param {string}  [options.description]      - คำอธิบายไฟล์
   * @returns {{ fileId: string, fileUrl: string, folder: string }}
   */
  saveFile(blob, docType, date, options) {
    const opt    = options || {};
    const folder = this.getArchiveFolder(docType, date);
    const file   = folder.createFile(blob);

    // ตั้งค่า sharing
    const publicView = opt.publicView !== false; // default = true
    if (publicView) {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }

    // ตั้ง description ถ้ามี
    if (opt.description) file.setDescription(opt.description);

    return {
      fileId:  file.getId(),
      fileUrl: `https://drive.google.com/file/d/${file.getId()}/view`,
      folder:  this.getArchiveFolderPath(docType, date)
    };
  },

  // ─── List & Browse ───────────────────────────────────────────

  /**
   * แสดงรายการไฟล์ในโฟลเดอร์ตาม docType + date
   * @param {Object} params
   * @param {string} params.docType
   * @param {string} params.date - ISO date string เช่น "2026-04-12"
   * @returns {{ success: boolean, data: Array<{ id, name, mimeType, size, url, createdAt }> }}
   */
  listFiles({ docType, date }) {
    try {
      AuthService.requireAuth();

      const folder = this.getArchiveFolder(docType, date ? new Date(date) : new Date());
      const files  = [];
      const iter   = folder.getFiles();

      while (iter.hasNext()) {
        const f = iter.next();
        files.push({
          id:          f.getId(),
          name:        f.getName(),
          mimeType:    f.getMimeType(),
          size:        f.getSize(),
          sizeLabel:   this._formatFileSize(f.getSize()),
          url:         f.getUrl(),
          previewUrl:  `https://drive.google.com/file/d/${f.getId()}/preview`,
          downloadUrl: `https://drive.google.com/uc?export=download&id=${f.getId()}`,
          createdAt:   f.getDateCreated().toISOString(),
          createdAtTH: Utils.formatDateTH(f.getDateCreated(), true)
        });
      }

      // เรียงจากใหม่ไปเก่า
      files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return Utils.success(files, `พบ ${files.length} ไฟล์`);
    } catch (e) {
      LogService.error('ARCHIVE_LIST', e.message);
      return Utils.error('โหลดรายการไฟล์ไม่สำเร็จ: ' + e.message);
    }
  },

  /**
   * แสดงโครงสร้างโฟลเดอร์รายเดือน (สำหรับ Archive browser)
   * @param {number} buddhistYear - เช่น 2569
   * @param {string} docType      - 'internal' | 'external'
   * @returns {{ success: boolean, data: Array<{ month, days }> }}
   */
  listMonthStructure(buddhistYear, docType) {
    try {
      AuthService.requireAuth();
      const root       = DriveApp.getFolderById(CONFIG.DRIVE_ROOT_FOLDER_ID);
      const yearFolder = this._getSubFolder(root, String(buddhistYear));

      if (!yearFolder) {
        return Utils.success([], `ไม่พบโฟลเดอร์ปี ${buddhistYear}`);
      }

      const typeName = this.FOLDER_NAMES[docType] || docType;
      const result   = [];

      // วนทุกเดือน
      const monthIter = yearFolder.getFolders();
      while (monthIter.hasNext()) {
        const monthFolder = monthIter.next();
        const monthName   = monthFolder.getName();
        const days        = [];

        // วนทุกวัน
        const dayIter = monthFolder.getFolders();
        while (dayIter.hasNext()) {
          const dayFolder  = dayIter.next();
          const dayName    = dayFolder.getName();
          const typeFolder = this._getSubFolder(dayFolder, typeName);

          // นับจำนวนไฟล์
          const count = typeFolder
            ? this._countFiles(typeFolder)
            : 0;

          if (count > 0) {
            days.push({ day: dayName, count });
          }
        }

        if (days.length > 0) {
          days.sort((a, b) => Number(a.day) - Number(b.day));
          result.push({ month: monthName, days });
        }
      }

      // เรียงตามลำดับเดือน
      result.sort((a, b) =>
        this.MONTH_NAMES.indexOf(a.month) - this.MONTH_NAMES.indexOf(b.month)
      );

      return Utils.success(result);
    } catch (e) {
      return Utils.error('โหลดโครงสร้างโฟลเดอร์ไม่สำเร็จ: ' + e.message);
    }
  },

  /**
   * ดึงรายการปีที่มีข้อมูลใน Archive
   * @returns {{ success: boolean, data: Array<number> }}
   */
  listAvailableYears() {
    try {
      AuthService.requireAuth();
      const root  = DriveApp.getFolderById(CONFIG.DRIVE_ROOT_FOLDER_ID);
      const years = [];
      const iter  = root.getFolders();

      while (iter.hasNext()) {
        const f    = iter.next();
        const name = f.getName();
        const year = Number(name);
        if (!isNaN(year) && year > 2500) years.push(year);
      }

      years.sort((a, b) => b - a); // ใหม่ก่อน
      return Utils.success(years);
    } catch (e) {
      return Utils.error(e.message);
    }
  },

  // ─── Word → PDF Conversion ────────────────────────────────────

  /**
   * แปลงไฟล์ Word เป็น PDF และบันทึกลง Archive
   * ลบ temp Google Doc ออกหลังแปลงเสร็จ
   *
   * @param {GoogleAppsScript.Base.Blob} wordBlob - Word blob
   * @param {string} originalFileName - ชื่อไฟล์เดิม (รวมนามสกุล)
   * @param {string} docType
   * @param {Date}   [date]
   * @returns {{ success: boolean, data: { fileId, fileUrl, pdfFileName } }}
   */
  convertAndSaveWordToPdf(wordBlob, originalFileName, docType, date) {
    let tempDocId = null;
    try {
      // 1. Import Word → Google Docs (เพื่อ enable PDF export)
      const resource = {
        title:    originalFileName,
        mimeType: 'application/vnd.google-apps.document'
      };
      const tempDoc = Drive.Files.insert(resource, wordBlob, { convert: true });
      tempDocId = tempDoc.id;

      // 2. Export เป็น PDF
      const pdfBlob = DriveApp.getFileById(tempDocId)
        .getAs('application/pdf');

      const pdfFileName = originalFileName.replace(/\.(docx?|doc)$/i, '.pdf');
      pdfBlob.setName(pdfFileName);

      // 3. บันทึกลง Archive
      const saved = this.saveFile(pdfBlob, docType, date, {
        description: `แปลงจาก ${originalFileName}`
      });

      return Utils.success({ ...saved, pdfFileName }, `แปลง PDF และบันทึกสำเร็จ: ${pdfFileName}`);

    } catch (e) {
      LogService.error('WORD_TO_PDF', e.message);
      return Utils.error('แปลงไฟล์ Word เป็น PDF ไม่สำเร็จ: ' + e.message);

    } finally {
      // 4. ลบ temp Google Doc เสมอ (แม้เกิด error)
      if (tempDocId) {
        try { DriveApp.getFileById(tempDocId).setTrashed(true); } catch (_) {}
      }
    }
  },

  // ─── Private Helpers ─────────────────────────────────────────

  /**
   * ค้นหา sub-folder — ถ้าไม่มีให้สร้างใหม่
   * @private
   */
  _getOrCreateSubFolder(parentFolder, name) {
    const iter = parentFolder.getFoldersByName(name);
    if (iter.hasNext()) return iter.next();
    return parentFolder.createFolder(name);
  },

  /**
   * ค้นหา sub-folder — ถ้าไม่มีคืน null
   * @private
   */
  _getSubFolder(parentFolder, name) {
    const iter = parentFolder.getFoldersByName(name);
    return iter.hasNext() ? iter.next() : null;
  },

  /**
   * นับจำนวนไฟล์ใน folder
   * @private
   */
  _countFiles(folder) {
    let count = 0;
    const iter = folder.getFiles();
    while (iter.hasNext()) { iter.next(); count++; }
    return count;
  },

  /**
   * Format ขนาดไฟล์ให้อ่านง่าย
   * @private
   */
  _formatFileSize(bytes) {
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1048576)    return `${(bytes/1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes/1048576).toFixed(1)} MB`;
    return `${(bytes/1073741824).toFixed(1)} GB`;
  }
};
