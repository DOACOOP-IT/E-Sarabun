// ============================================================
// Utils.gs — ฟังก์ชันอรรถประโยชน์ทั่วไป
// ============================================================

const Utils = {

  // ─── Date & Time ─────────────────────────────────────────────

  /**
   * แปลง Date เป็นปี พ.ศ. (พุทธศักราช)
   * @param {Date} date
   * @returns {number} ปี พ.ศ.
   */
  toBuddhistYear(date) {
    const d = date || new Date();
    return d.getFullYear() + 543;
  },

  /**
   * ฟอร์แมต Date เป็น String ภาษาไทย
   * @param {Date|string} date
   * @param {boolean} includeTime - รวมเวลา
   * @returns {string} เช่น "12 เมษายน 2569"
   */
  formatDateTH(date, includeTime = false) {
    const d = date ? new Date(date) : new Date();
    const months = [
      'มกราคม','กุมภาพันธ์','มีนาคม','เมษายน',
      'พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม',
      'กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'
    ];
    const day   = d.getDate();
    const month = months[d.getMonth()];
    const year  = d.getFullYear() + 543;
    let result  = `${day} ${month} ${year}`;
    if (includeTime) {
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      result += ` ${h}:${m} น.`;
    }
    return result;
  },

  /**
   * ฟอร์แมต Date เป็น ISO string (YYYY-MM-DD)
   * @param {Date} date
   * @returns {string}
   */
  toISODate(date) {
    const d = date || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  /**
   * ดึง timestamp ปัจจุบัน (ISO)
   * @returns {string}
   */
  now() {
    return new Date().toISOString();
  },

  /**
   * แปลงวันที่เป็น path สำหรับโฟลเดอร์ Drive
   * @param {Date} date
   * @returns {{ year: string, month: string, day: string }}
   */
  toFolderPath(date) {
    const d = date || new Date();
    return {
      year:  String(this.toBuddhistYear(d)),
      month: String(d.getMonth() + 1).padStart(2, '0'),
      day:   String(d.getDate()).padStart(2, '0')
    };
  },

  // ─── String Helpers ───────────────────────────────────────────

  /**
   * แพด string ด้านซ้ายด้วยตัวเลข 0
   * @param {number} num
   * @param {number} digits
   * @returns {string} เช่น padNumber(5, 3) => "005"
   */
  padNumber(num, digits) {
    return String(num).padStart(digits, '0');
  },

  /**
   * ตัด whitespace และคืน null ถ้าว่าง
   * @param {*} value
   * @returns {string|null}
   */
  cleanString(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s.length > 0 ? s : null;
  },

  /**
   * ตรวจว่า string ว่างหรือไม่
   * @param {*} value
   * @returns {boolean}
   */
  isEmpty(value) {
    return !value || String(value).trim().length === 0;
  },

  // ─── Security ─────────────────────────────────────────────────

  /**
   * Hash password ด้วย SHA-256 + salt
   * @param {string} password
   * @param {string} salt
   * @returns {string} hex hash
   */
  hashPassword(password, salt) {
    const raw = password + salt;
    const digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      raw,
      Utilities.Charset.UTF_8
    );
    return digest.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  },

  /**
   * สร้าง salt แบบ random
   * @returns {string}
   */
  generateSalt() {
    return Utilities.getUuid().replace(/-/g, '');
  },

  /**
   * สร้าง UUID
   * @returns {string}
   */
  generateId() {
    return Utilities.getUuid();
  },

  // ─── Validation ───────────────────────────────────────────────

  /**
   * ตรวจสอบ username (ตัวอักษร/ตัวเลข/_/. 3-30 ตัวอักษร)
   * @param {string} username
   * @returns {{ valid: boolean, message: string }}
   */
  validateUsername(username) {
    if (this.isEmpty(username))
      return { valid: false, message: 'กรุณากรอก Username' };
    if (!/^[a-zA-Z0-9_.]{3,30}$/.test(username))
      return { valid: false, message: 'Username ต้องเป็นตัวอักษร/ตัวเลข/จุด/ขีดล่าง 3-30 ตัว' };
    return { valid: true, message: '' };
  },

  /**
   * ตรวจสอบ password (อย่างน้อย 8 ตัว)
   * @param {string} password
   * @returns {{ valid: boolean, message: string }}
   */
  validatePassword(password) {
    if (this.isEmpty(password))
      return { valid: false, message: 'กรุณากรอก Password' };
    if (password.length < 8)
      return { valid: false, message: 'Password ต้องมีอย่างน้อย 8 ตัวอักษร' };
    return { valid: true, message: '' };
  },

  // ─── Response Helpers ─────────────────────────────────────────

  /**
   * สร้าง response สำเร็จ
   * @param {*} data
   * @param {string} message
   * @returns {{ success: true, data: *, message: string }}
   */
  success(data, message = 'ดำเนินการสำเร็จ') {
    return { success: true, data, message };
  },

  /**
   * สร้าง response ผิดพลาด
   * @param {string} message
   * @param {*} details
   * @returns {{ success: false, message: string }}
   */
  error(message, details = null) {
    return { success: false, message, details };
  },

  // ─── JSON Safe Helpers ────────────────────────────────────────

  /**
   * Parse JSON อย่างปลอดภัย
   * @param {string} str
   * @param {*} fallback
   * @returns {*}
   */
  safeJsonParse(str, fallback = null) {
    try {
      return JSON.parse(str);
    } catch (e) {
      return fallback;
    }
  },

  /**
   * Stringify JSON อย่างปลอดภัย
   * @param {*} obj
   * @returns {string}
   */
  safeJsonStringify(obj) {
    try {
      return JSON.stringify(obj);
    } catch (e) {
      return '{}';
    }
  }
};
