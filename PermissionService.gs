// ============================================================
// PermissionService.gs — กฎสิทธิ์การมองเห็นข้อมูลและการทำงาน
// ============================================================

const PermissionService = {

  /** ผู้ช่วยผู้จัดการขึ้นไป */
  canAccessAdmin(session) {
    return !!session && [CONFIG.ROLES.ASST_MANAGER, CONFIG.ROLES.MANAGER].includes(session.role);
  },

  /** ผู้จัดการเท่านั้น */
  canCreateUser(session) {
    return !!session && session.role === CONFIG.ROLES.MANAGER;
  },

  /** ลงรับเอกสารภายนอกได้เฉพาะเจ้าหน้าที่ ฝอก. */
  canReceiveExternal(session) {
    return !!session
      && session.role === CONFIG.ROLES.OFFICER
      && session.department === 'ฝอก.';
  },

  /** parse assignedDepts ให้เป็น array เสมอ */
  getAssignedDepts(doc) {
    if (!doc) return [];
    if (Array.isArray(doc.assignedDepts)) return doc.assignedDepts;
    if (typeof doc.assignedDepts === 'string' && doc.assignedDepts.trim()) {
      const parsed = Utils.safeJsonParse(doc.assignedDepts, []);
      return Array.isArray(parsed) ? parsed : [];
    }
    return [];
  },

  /** parse workflow ให้เป็น object ที่มี steps เสมอ */
  getWorkflow(doc) {
    if (!doc || !doc.workflow) return { steps: [] };
    if (typeof doc.workflow === 'object' && Array.isArray(doc.workflow.steps)) return doc.workflow;
    return Utils.safeJsonParse(doc.workflow, { steps: [] });
  },

  /** step ปัจจุบันที่ pending */
  getCurrentPendingStep(doc) {
    const workflow = this.getWorkflow(doc);
    return workflow.steps.find(step => step.status === 'pending') || null;
  },

  /** เอกสารนี้ผู้ใช้มีสิทธิ์เห็นหรือไม่ */
  canViewDoc(doc, session) {
    if (!doc || !session) return false;

    if ([CONFIG.ROLES.ASST_MANAGER, CONFIG.ROLES.MANAGER].includes(session.role)) {
      return true;
    }

    if (String(doc.createdBy || '') === String(session.username || '')) {
      return true;
    }

    if (String(doc.sender || '') === String(session.department || '')) {
      return true;
    }

    if (String(doc.receiver || '') === String(session.department || '')) {
      return true;
    }

    if (this.getAssignedDepts(doc).includes(session.department)) {
      return true;
    }

    const workflow = this.getWorkflow(doc);
    return workflow.steps.some(step => {
      if (step.dept && step.dept === session.department) return true;
      if (step.action === 'acknowledge' && Array.isArray(step.assignedDepts)) {
        return step.assignedDepts.includes(session.department);
      }
      return false;
    });
  },

  /** กรองเอกสารที่ผู้ใช้มองเห็นได้ */
  filterVisibleDocs(docs, session) {
    if (!Array.isArray(docs) || !session) return [];
    return docs.filter(doc => this.canViewDoc(doc, session));
  },

  /** หาเอกสารตาม fileId ที่ user มีสิทธิ์เห็น */
  findDocByFileId(fileId, docs, session) {
    if (!fileId || !Array.isArray(docs)) return null;
    return docs.find(doc => {
      const sameFile = String(doc.fileId || '') === String(fileId)
        || String(doc.originalFileId || '') === String(fileId);
      return sameFile && this.canViewDoc(doc, session);
    }) || null;
  },

  /** กรอง log ตามเอกสารที่มองเห็นหรือ user ของตนเอง */
  filterVisibleLogs(logs, docs, session) {
    if (!Array.isArray(logs) || !session) return [];
    if (this.canAccessAdmin(session)) return logs;

    const visibleDocIds = new Set(this.filterVisibleDocs(docs, session).map(doc => String(doc.id)));
    return logs.filter(log =>
      String(log.user || '') === String(session.username || '')
      || (log.docId && visibleDocIds.has(String(log.docId)))
    );
  },

  /** ตรวจว่าฝ่ายนี้รับทราบไปแล้วหรือยัง */
  hasAcknowledged(step, department) {
    const acknowledgedBy = Array.isArray(step && step.acknowledgedBy) ? step.acknowledgedBy : [];
    return acknowledgedBy.some(item => item && item.dept === department);
  },

  /** ตรวจสิทธิ์ดำเนินการ step */
  checkStepPermission(step, session) {
    if (!step || !session) {
      return { allowed: false, message: 'ไม่มีสิทธิ์ดำเนินการ' };
    }

    if (step.role !== session.role) {
      return {
        allowed: false,
        message: `ขั้นตอนนี้ต้องดำเนินการโดย ${this.getRoleLabel(step.role)}`
      };
    }

    if (step.action === 'acknowledge') {
      const assigned = Array.isArray(step.assignedDepts) ? step.assignedDepts : [];
      if (assigned.length > 0 && !assigned.includes(session.department)) {
        return {
          allowed: false,
          message: `ฝ่ายของคุณ (${session.department}) ไม่ได้รับมอบหมายให้รับทราบเอกสารนี้`
        };
      }
      if (this.hasAcknowledged(step, session.department)) {
        return {
          allowed: false,
          message: `ฝ่าย ${session.department} รับทราบเอกสารนี้แล้ว`
        };
      }
    } else if (step.dept && step.dept !== session.department) {
      return {
        allowed: false,
        message: `ขั้นตอนนี้ต้องดำเนินการโดยฝ่าย ${step.dept}`
      };
    }

    return { allowed: true };
  },

  /** ดึงเอกสารที่กำลัง pending สำหรับ session */
  getPendingDocsForSession(docs, session) {
    if (!Array.isArray(docs) || !session) return [];
    return docs.filter(doc => {
      const step = this.getCurrentPendingStep(doc);
      if (!step) return false;
      return this.checkStepPermission(step, session).allowed;
    }).sort((a, b) => new Date(b.updateAt || b.createdAt || 0) - new Date(a.updateAt || a.createdAt || 0));
  },

  getRoleLabel(role) {
    const labels = {
      officer: 'เจ้าหน้าที่',
      dept_head: 'หัวหน้าฝ่าย',
      asst_manager: 'ผู้ช่วยผู้จัดการ',
      manager: 'ผู้จัดการ'
    };
    return labels[role] || role;
  }
};