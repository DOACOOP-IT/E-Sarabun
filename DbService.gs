// ============================================================
// DbService.gs — ชั้นการเข้าถึงฐานข้อมูล Google Sheets
// ============================================================
// รับผิดชอบ CRUD ทั้งหมดกับ Google Sheets
// ไม่มี business logic — เป็นแค่ data access layer
// ============================================================

const DbService = {

  // ─── Connection ───────────────────────────────────────────────

  /**
   * ดึง Spreadsheet หลัก (Cache ไว้ใน instance)
   * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
   */
  _ss: null,
  getSpreadsheet() {
    if (!this._ss) {
      this._ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    }
    return this._ss;
  },

  /**
   * ดึง Sheet ตามชื่อ
   * @param {string} sheetName
   * @returns {GoogleAppsScript.Spreadsheet.Sheet}
   */
  getSheet(sheetName) {
    const sheet = this.getSpreadsheet().getSheetByName(sheetName);
    if (!sheet) throw new Error(`ไม่พบ Sheet: "${sheetName}"`);
    return sheet;
  },

  // ─── Read ─────────────────────────────────────────────────────

  /**
   * ดึงข้อมูลทั้งหมดของ Sheet เป็น Array of Objects
   * @param {string} sheetName
   * @returns {Array<Object>}
   */
  getAll(sheetName) {
    const sheet = this.getSheet(sheetName);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    return data.slice(1)
      .filter(row => row.some(cell => cell !== '')) // กรองแถวว่าง
      .map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i]; });
        return obj;
      });
  },

  /**
   * ค้นหาแถวแรกที่ตรงกับเงื่อนไข
   * @param {string} sheetName
   * @param {string} field - ชื่อคอลัมน์
   * @param {*} value - ค่าที่ต้องการหา
   * @returns {Object|null}
   */
  findOne(sheetName, field, value) {
    const rows = this.getAll(sheetName);
    return rows.find(row => String(row[field]) === String(value)) || null;
  },

  /**
   * ค้นหาหลายแถวที่ตรงกับเงื่อนไข
   * @param {string} sheetName
   * @param {string} field
   * @param {*} value
   * @returns {Array<Object>}
   */
  findMany(sheetName, field, value) {
    const rows = this.getAll(sheetName);
    return rows.filter(row => String(row[field]) === String(value));
  },

  /**
   * ค้นหาด้วยหลายเงื่อนไข (AND)
   * @param {string} sheetName
   * @param {Object} conditions - { field: value, ... }
   * @returns {Array<Object>}
   */
  findWhere(sheetName, conditions) {
    const rows = this.getAll(sheetName);
    return rows.filter(row =>
      Object.entries(conditions).every(([k, v]) => String(row[k]) === String(v))
    );
  },

  // ─── Write ────────────────────────────────────────────────────

  /**
   * เพิ่มแถวใหม่ตาม headers ของ Sheet
   * @param {string} sheetName
   * @param {Object} data - Object ที่มี key ตรงกับ header
   * @returns {boolean}
   */
  insert(sheetName, data) {
    const sheet   = this.getSheet(sheetName);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const row     = headers.map(h => (data[h] !== undefined ? data[h] : ''));
    sheet.appendRow(row);
    return true;
  },

  /**
   * อัปเดตแถวที่มี id ตรงกัน
   * @param {string} sheetName
   * @param {string} id
   * @param {Object} updates - Object ที่มี field ที่ต้องการอัปเดต
   * @returns {boolean} true ถ้าพบและอัปเดตแล้ว
   */
  updateById(sheetName, id, updates) {
    const sheet   = this.getSheet(sheetName);
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const idIdx   = headers.indexOf('id');

    if (idIdx === -1) throw new Error(`Sheet "${sheetName}" ไม่มีคอลัมน์ id`);

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][idIdx]) === String(id)) {
        // อัปเดต updateAt อัตโนมัติถ้า column นั้นมีอยู่
        const updateAtIdx = headers.indexOf('updateAt');
        if (updateAtIdx !== -1) {
          sheet.getRange(i + 1, updateAtIdx + 1).setValue(Utils.now());
        }

        Object.entries(updates).forEach(([key, val]) => {
          const colIdx = headers.indexOf(key);
          if (colIdx !== -1) {
            sheet.getRange(i + 1, colIdx + 1).setValue(val);
          }
        });
        return true;
      }
    }
    return false;
  },

  /**
   * อัปเดตแถวตาม field ใด ๆ (ไม่ใช่ id)
   * @param {string} sheetName
   * @param {string} matchField - ชื่อคอลัมน์ที่ใช้ match
   * @param {*} matchValue
   * @param {Object} updates
   * @returns {boolean}
   */
  updateWhere(sheetName, matchField, matchValue, updates) {
    const sheet   = this.getSheet(sheetName);
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const matchIdx = headers.indexOf(matchField);

    if (matchIdx === -1) throw new Error(`ไม่พบคอลัมน์ "${matchField}" ใน "${sheetName}"`);

    let updated = false;
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][matchIdx]) === String(matchValue)) {
        Object.entries(updates).forEach(([key, val]) => {
          const colIdx = headers.indexOf(key);
          if (colIdx !== -1) sheet.getRange(i + 1, colIdx + 1).setValue(val);
        });
        updated = true;
      }
    }
    return updated;
  },

  /**
   * ลบแถวตาม id (Soft Delete — set status = 'deleted')
   * @param {string} sheetName
   * @param {string} id
   * @returns {boolean}
   */
  softDeleteById(sheetName, id) {
    return this.updateById(sheetName, id, { status: 'deleted' });
  },

  // ─── Aggregate ────────────────────────────────────────────────

  /**
   * นับจำนวนแถวที่ตรงกับเงื่อนไข
   * @param {string} sheetName
   * @param {Object} conditions
   * @returns {number}
   */
  count(sheetName, conditions = {}) {
    const rows = Object.keys(conditions).length > 0
      ? this.findWhere(sheetName, conditions)
      : this.getAll(sheetName);
    return rows.length;
  },

  // ─── Utilities ────────────────────────────────────────────────

  /**
   * ดึง headers ของ Sheet
   * @param {string} sheetName
   * @returns {Array<string>}
   */
  getHeaders(sheetName) {
    const sheet = this.getSheet(sheetName);
    if (sheet.getLastColumn() === 0) return [];
    return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  },

  /**
   * ตรวจว่า Sheet มีข้อมูลหรือไม่
   * @param {string} sheetName
   * @returns {boolean}
   */
  hasData(sheetName) {
    return this.getSheet(sheetName).getLastRow() > 1;
  }
};
