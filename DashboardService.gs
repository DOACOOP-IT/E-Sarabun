// ============================================================
// DashboardService.gs — สถิติ Dashboard แบบละเอียด
// ============================================================
// คำนวณและรวบรวมสถิติสำหรับหน้า Dashboard
// แยกออกจาก DocService เพื่อความชัดเจนและ performance
// ============================================================

const DashboardService = {

  /**
   * ดึงสถิติครบชุดสำหรับ Dashboard ของผู้ใช้ปัจจุบัน
   * @returns {{ success: boolean, data: Object }}
   */
  getStats() {
    try {
      const session = AuthService.requireAuth();
      const allDocs = DbService.getAll(CONFIG.SHEETS.DOCS)
                               .filter(d => d.status !== 'deleted');
      const visibleDocs = PermissionService.filterVisibleDocs(allDocs, session);

      // ─── สถิติส่วนตัว ────────────────────────────────────────
      const pendingForMe = PermissionService.getPendingDocsForSession(visibleDocs, session);

      // ─── สถิติภาพรวม ─────────────────────────────────────────
      const inProgress        = visibleDocs.filter(d => d.status === CONFIG.DOC_STATUS.IN_PROGRESS);
      const completedAll      = visibleDocs.filter(d => d.status === CONFIG.DOC_STATUS.COMPLETED);
      const rejectedAll       = visibleDocs.filter(d => d.status === CONFIG.DOC_STATUS.REJECTED);
      const pendingAll        = visibleDocs.filter(d => d.status === CONFIG.DOC_STATUS.PENDING);

      // เสร็จสิ้นเดือนนี้
      const completedThisMonth = completedAll.filter(d => this._isThisMonth(d.updateAt));

      // เอกสารแยกตามประเภท
      const internal = visibleDocs.filter(d => d.docType === CONFIG.DOC_TYPES.INTERNAL);
      const external = visibleDocs.filter(d => d.docType === CONFIG.DOC_TYPES.EXTERNAL);

      // ─── เอกสารล่าสุด 10 รายการ ──────────────────────────────
      const recentDocs = visibleDocs
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map(d => this._formatDoc(d));

      // ─── แนวโน้มรายเดือน (6 เดือนล่าสุด) ────────────────────
      const monthlyTrend = this._buildMonthlyTrend(visibleDocs, 6);

      // ─── เอกสารล่าสุดของฉัน ─────────────────────────────────
      const myRecentDocs = visibleDocs
        .filter(d => d.createdBy === session.username || PermissionService.getAssignedDepts(d).includes(session.department))
        .sort((a, b) => new Date(b.updateAt) - new Date(a.updateAt))
        .slice(0, 5)
        .map(d => this._formatDoc(d));

      // ─── Activity log ล่าสุด ─────────────────────────────────
      const recentActivity = PermissionService
        .filterVisibleLogs(LogService.getRecentLogs(50), visibleDocs, session)
        .slice(0, 15);

      return Utils.success({
        // ── สถิติส่วนตัว (เน้นแสดงบน Dashboard) ──
        pendingForMeCount:       pendingForMe.length,
        pendingForMe:            pendingForMe.map(d => this._formatDoc(d)).slice(0, 5),

        // ── สถิติภาพรวม ──
        totalDocs:               visibleDocs.length,
        totalInProgress:         inProgress.length,
        totalCompleted:          completedAll.length,
        totalRejected:           rejectedAll.length,
        totalPending:            pendingAll.length,
        completedThisMonth:      completedThisMonth.length,
        internal:                internal.length,
        external:                external.length,

        // ── ข้อมูลตาราง ──
        recentDocs,
        myRecentDocs,
        monthlyTrend,
        recentActivity
      });

    } catch (e) {
      LogService.error('DASHBOARD_STATS', e.message);
      return Utils.error('ดึงสถิติไม่สำเร็จ: ' + e.message);
    }
  },

  // ──────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────

  /**
   * สร้างข้อมูลแนวโน้มรายเดือน
   * @private
   */
  _buildMonthlyTrend(allDocs, numMonths) {
    const trend = [];
    const now   = new Date();

    for (let i = numMonths - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year  = d.getFullYear();
      const month = d.getMonth();

      const monthDocs = allDocs.filter(doc => {
        const cd = new Date(doc.createdAt);
        return cd.getFullYear() === year && cd.getMonth() === month;
      });

      const monthsTH = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                         'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
      trend.push({
        label:     `${monthsTH[month]} ${year + 543}`,
        total:     monthDocs.length,
        internal:  monthDocs.filter(d => d.docType === 'internal').length,
        external:  monthDocs.filter(d => d.docType === 'external').length,
        completed: monthDocs.filter(d => d.status  === 'completed').length
      });
    }

    return trend;
  },

  /**
   * ตรวจว่า dateStr อยู่ในเดือนปัจจุบันหรือไม่
   * @private
   */
  _isThisMonth(dateStr) {
    if (!dateStr) return false;
    const d   = new Date(dateStr);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  },

  /**
   * Format doc สำหรับ client
   * @private
   */
  _formatDoc(doc) {
    return {
      id:          doc.id,
      docNo:       doc.docNo,
      docType:     doc.docType,
      subject:     doc.subject,
      sender:      doc.sender,
      status:      doc.status,
      currentStep: doc.currentStep,
      urgency:     doc.urgency || '',
      createdBy:   doc.createdBy,
      createdAt:   doc.createdAt,
      updateAt:    doc.updateAt,
      dateTH:      Utils.formatDateTH ? Utils.formatDateTH(doc.date) : (doc.date || '')
    };
  }
};
