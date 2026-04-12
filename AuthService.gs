// ============================================================
// AuthService.gs — ระบบ Authentication & Session Management
// ============================================================
// ใช้ CacheService เก็บ Session token
// Password เก็บเป็น SHA-256 hash + salt ใน Google Sheets
// ============================================================

const AuthService = {

  // ─── Login / Logout ───────────────────────────────────────────

  /**
   * เข้าสู่ระบบ — ตรวจสอบ username/password และสร้าง session
   * @param {string} username
   * @param {string} password - plain text (จะถูก hash ก่อน compare)
   * @returns {{ success: boolean, session?: Object, message: string }}
   */
  login(username, password) {
    // Validate input
    const uv = Utils.validateUsername(username);
    if (!uv.valid) return Utils.error(uv.message);

    const pv = Utils.validatePassword(password);
    if (!pv.valid) return Utils.error(pv.message);

    try {
      // ค้นหาผู้ใช้ใน DB
      const user = DbService.findOne(CONFIG.SHEETS.USERS, 'username', username.trim().toLowerCase());

      if (!user) {
        LogService.login(username, false, '');
        return Utils.error('ไม่พบบัญชีผู้ใช้นี้ในระบบ');
      }

      // ตรวจสอบ password_hash
      // รูปแบบใน DB: "salt:hash"
      const [salt, storedHash] = String(user.password_hash).split(':');
      const inputHash = Utils.hashPassword(password, salt);

      if (inputHash !== storedHash) {
        LogService.login(username, false, '');
        return Utils.error('รหัสผ่านไม่ถูกต้อง');
      }

      // สร้าง Session
      const session = {
        username:   user.username,
        role:       user.role,
        department: user.department,
        displayName: user.displayName || user.username,
        loginAt:    Utils.now(),
        token:      Utils.generateId() // unique token สำหรับ session นี้
      };

      // เก็บ Session ใน CacheService (8 ชั่วโมง)
      const cache = CacheService.getUserCache();
      cache.put(
        CONFIG.SESSION_PREFIX + session.token,
        Utils.safeJsonStringify(session),
        CONFIG.SESSION_DURATION
      );

      // เก็บ token ใน Properties เพื่อ retrieve กลับมา
      PropertiesService.getUserProperties().setProperty(
        CONFIG.SESSION_PREFIX + 'current_token',
        session.token
      );

      LogService.login(username, true, '');
      return Utils.success({ session, token: session.token }, `ยินดีต้อนรับ ${session.displayName}`);

    } catch (e) {
      LogService.error('LOGIN', e.message, username);
      return Utils.error('เกิดข้อผิดพลาดในการเข้าสู่ระบบ: ' + e.message);
    }
  },

  /**
   * ออกจากระบบ — ลบ Session
   * @returns {{ success: boolean, message: string }}
   */
  logout() {
    try {
      const token = PropertiesService.getUserProperties()
        .getProperty(CONFIG.SESSION_PREFIX + 'current_token');

      if (token) {
        CacheService.getUserCache().remove(CONFIG.SESSION_PREFIX + token);
        PropertiesService.getUserProperties()
          .deleteProperty(CONFIG.SESSION_PREFIX + 'current_token');

        const session = this.getSession();
        if (session) LogService.logout(session.username);
      }
      return Utils.success(null, 'ออกจากระบบสำเร็จ');
    } catch (e) {
      return Utils.error('เกิดข้อผิดพลาดในการออกจากระบบ');
    }
  },

  // ─── Session ─────────────────────────────────────────────────

  /**
   * ดึงข้อมูล Session ปัจจุบัน
   * @returns {Object|null} session object หรือ null ถ้าไม่ได้ login
   */
  getSession() {
    try {
      const token = PropertiesService.getUserProperties()
        .getProperty(CONFIG.SESSION_PREFIX + 'current_token');
      if (!token) return null;

      const cached = CacheService.getUserCache()
        .get(CONFIG.SESSION_PREFIX + token);
      if (!cached) return null;

      return Utils.safeJsonParse(cached, null);
    } catch (e) {
      return null;
    }
  },

  /**
   * ต่ออายุ Session (reset countdown)
   * @returns {boolean}
   */
  renewSession() {
    const session = this.getSession();
    if (!session) return false;

    const token  = session.token;
    const cache  = CacheService.getUserCache();
    const cached = cache.get(CONFIG.SESSION_PREFIX + token);
    if (!cached) return false;

    cache.put(CONFIG.SESSION_PREFIX + token, cached, CONFIG.SESSION_DURATION);
    return true;
  },

  /**
   * ตรวจสอบว่า Session ยังใช้งานได้หรือไม่
   * @returns {boolean}
   */
  isLoggedIn() {
    return this.getSession() !== null;
  },

  // ─── Authorization ────────────────────────────────────────────

  /**
   * ตรวจสอบว่า Session มี role ตามที่กำหนดหรือไม่
   * @param {string} requiredRole - role ที่ต้องการ
   * @returns {boolean}
   */
  hasRole(requiredRole) {
    const session = this.getSession();
    if (!session) return false;
    const userLevel = CONFIG.ROLE_LEVEL[session.role] || 0;
    const reqLevel  = CONFIG.ROLE_LEVEL[requiredRole]  || 0;
    return userLevel >= reqLevel;
  },

  /**
   * ตรวจสอบว่า Session เป็น role ที่กำหนดพอดี
   * @param {string} role
   * @returns {boolean}
   */
  isRole(role) {
    const session = this.getSession();
    return session && session.role === role;
  },

  /**
   * ตรวจสอบว่า Session อยู่ใน department ที่กำหนด
   * @param {string} dept
   * @returns {boolean}
   */
  isDepartment(dept) {
    const session = this.getSession();
    return session && session.department === dept;
  },

  /**
   * Middleware — ตรวจสอบ session ก่อนทำงาน ถ้าไม่มี throw error
   * @returns {Object} session
   */
  requireAuth() {
    const session = this.getSession();
    if (!session) throw new Error('กรุณาเข้าสู่ระบบก่อน');
    return session;
  },

  // ─── User Management ─────────────────────────────────────────

  /**
   * สร้างผู้ใช้ใหม่ (Admin only)
   * @param {Object} userData
   * @param {string} userData.username
   * @param {string} userData.password
   * @param {string} userData.role
   * @param {string} userData.department
   * @param {string} userData.displayName
   * @returns {{ success: boolean, message: string }}
   */
  createUser(userData) {
    try {
      // ตรวจสอบสิทธิ์ — ต้องเป็น manager
      const session = this.requireAuth();
      if (!this.hasRole(CONFIG.ROLES.MANAGER)) {
        return Utils.error('ไม่มีสิทธิ์สร้างผู้ใช้');
      }

      // ตรวจซ้ำ
      const existing = DbService.findOne(CONFIG.SHEETS.USERS, 'username', userData.username);
      if (existing) return Utils.error(`Username "${userData.username}" มีอยู่แล้วในระบบ`);

      // Hash password
      const salt     = Utils.generateSalt();
      const hash     = Utils.hashPassword(userData.password, salt);
      const pwHash   = `${salt}:${hash}`;

      DbService.insert(CONFIG.SHEETS.USERS, {
        username:      userData.username.trim().toLowerCase(),
        password_hash: pwHash,
        role:          userData.role,
        department:    userData.department,
        displayName:   userData.displayName || userData.username,
        createdAt:     Utils.now(),
        createdBy:     session.username
      });

      LogService.write(session.username, 'CREATE_USER', '', `User: ${userData.username}`);
      return Utils.success(null, `สร้างผู้ใช้ "${userData.username}" สำเร็จ`);

    } catch (e) {
      return Utils.error('เกิดข้อผิดพลาด: ' + e.message);
    }
  },

  /**
   * เปลี่ยนรหัสผ่าน
   * @param {string} oldPassword
   * @param {string} newPassword
   * @returns {{ success: boolean, message: string }}
   */
  changePassword(oldPassword, newPassword) {
    try {
      const session = this.requireAuth();
      const user    = DbService.findOne(CONFIG.SHEETS.USERS, 'username', session.username);

      if (!user) return Utils.error('ไม่พบข้อมูลผู้ใช้');

      const [salt, storedHash] = String(user.password_hash).split(':');
      if (Utils.hashPassword(oldPassword, salt) !== storedHash) {
        return Utils.error('รหัสผ่านเดิมไม่ถูกต้อง');
      }

      const pv = Utils.validatePassword(newPassword);
      if (!pv.valid) return Utils.error(pv.message);

      const newSalt = Utils.generateSalt();
      const newHash = Utils.hashPassword(newPassword, newSalt);
      DbService.updateWhere(CONFIG.SHEETS.USERS, 'username', session.username, {
        password_hash: `${newSalt}:${newHash}`
      });

      LogService.write(session.username, 'CHANGE_PASSWORD', '', '');
      return Utils.success(null, 'เปลี่ยนรหัสผ่านสำเร็จ');

    } catch (e) {
      return Utils.error('เกิดข้อผิดพลาด: ' + e.message);
    }
  },

  /**
   * ดึงรายชื่อผู้ใช้ทั้งหมด (ไม่รวม password)
   * @returns {{ success: boolean, data: Array }}
   */
  getAllUsers() {
    try {
      this.requireAuth();
      if (!this.hasRole(CONFIG.ROLES.ASST_MANAGER)) {
        return Utils.error('ไม่มีสิทธิ์ดูรายชื่อผู้ใช้');
      }
      const users = DbService.getAll(CONFIG.SHEETS.USERS).map(u => ({
        username:    u.username,
        role:        u.role,
        department:  u.department,
        displayName: u.displayName,
        createdAt:   u.createdAt
      }));
      return Utils.success(users);
    } catch (e) {
      return Utils.error(e.message);
    }
  }
};
