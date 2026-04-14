// ============================================================
// SmokeTest.gs — ทดสอบ flow สิทธิ์ตาม role/dept แบบไม่พึ่งข้อมูลจริง
// ============================================================

function runSmokeTests() {
  const sessions = {
    officerFok:   { username: 'officer.fok', role: 'officer',      department: 'ฝอก.' },
    headFok:      { username: 'head.fok',    role: 'dept_head',    department: 'ฝอก.' },
    headFst:      { username: 'head.fst',    role: 'dept_head',    department: 'ฝสท.' },
    asstManager:  { username: 'asst.manager',role: 'asst_manager', department: 'ฝอก.' },
    manager:      { username: 'manager',     role: 'manager',      department: 'ฝอก.' }
  };

  const docs = [
    {
      id: 'DOC-INT-FOK',
      docType: 'internal',
      docNo: 'ฝอก.001/2569',
      subject: 'หนังสือภายใน ฝอก.',
      sender: 'ฝอก.',
      receiver: '',
      assignedDepts: '[]',
      createdBy: 'officer.fok',
      status: 'in_progress',
      createdAt: '2026-04-14T08:00:00Z',
      updateAt: '2026-04-14T08:30:00Z',
      workflow: JSON.stringify({
        steps: [
          { step: 1, role: 'officer', dept: 'ฝอก.', label: 'จองเลข/แนบไฟล์', action: 'create', status: 'approved' },
          { step: 2, role: 'dept_head', dept: 'ฝอก.', label: 'ลงนาม (ต้นเรื่อง)', action: 'sign', status: 'pending' },
          { step: 3, role: 'asst_manager', dept: null, label: 'ลงนาม', action: 'sign', status: 'waiting' }
        ]
      })
    },
    {
      id: 'DOC-INT-FST',
      docType: 'internal',
      docNo: 'ฝสท.001/2569',
      subject: 'หนังสือภายใน ฝสท.',
      sender: 'ฝสท.',
      receiver: '',
      assignedDepts: '[]',
      createdBy: 'officer.fst',
      status: 'in_progress',
      createdAt: '2026-04-14T08:10:00Z',
      updateAt: '2026-04-14T08:40:00Z',
      workflow: JSON.stringify({
        steps: [
          { step: 1, role: 'officer', dept: 'ฝสท.', label: 'จองเลข/แนบไฟล์', action: 'create', status: 'approved' },
          { step: 2, role: 'dept_head', dept: 'ฝสท.', label: 'ลงนาม (ต้นเรื่อง)', action: 'sign', status: 'pending' }
        ]
      })
    },
    {
      id: 'DOC-EXT-ACK',
      docType: 'external',
      docNo: 'รับ001/2569',
      subject: 'เอกสารภายนอกมอบหมาย ฝอก./ฝสท.',
      sender: 'หน่วยงานภายนอก',
      receiver: 'ผู้จัดการ',
      assignedDepts: JSON.stringify(['ฝอก.', 'ฝสท.']),
      createdBy: 'officer.fok',
      status: 'in_progress',
      createdAt: '2026-04-14T08:20:00Z',
      updateAt: '2026-04-14T08:50:00Z',
      workflow: JSON.stringify({
        steps: [
          { step: 1, role: 'officer', dept: 'ฝอก.', label: 'ลงรับ', action: 'receive', status: 'completed' },
          { step: 2, role: 'asst_manager', dept: null, label: 'ลงนาม', action: 'sign', status: 'completed' },
          { step: 3, role: 'manager', dept: null, label: 'ลงนาม/สั่งการ', action: 'command', status: 'completed' },
          { step: 4, role: 'dept_head', dept: null, label: 'รับทราบ', action: 'acknowledge', status: 'pending', assignedDepts: ['ฝอก.', 'ฝสท.'], acknowledgedBy: [{ username: 'head.fok', dept: 'ฝอก.', at: '2026-04-14T08:45:00Z' }] }
        ]
      })
    }
  ];

  const tests = [
    {
      name: 'officer ฝอก. เห็นเอกสารของตัวเอง',
      passed: PermissionService.canViewDoc(docs[0], sessions.officerFok)
    },
    {
      name: 'officer ฝอก. ไม่เห็นเอกสารภายในของ ฝสท.',
      passed: !PermissionService.canViewDoc(docs[1], sessions.officerFok)
    },
    {
      name: 'head ฝสท. เห็นเอกสาร external ที่ assigned มาที่ ฝสท.',
      passed: PermissionService.canViewDoc(docs[2], sessions.headFst)
    },
    {
      name: 'head ฝอก. ไม่สามารถ acknowledge ซ้ำได้',
      passed: !PermissionService.checkStepPermission(PermissionService.getCurrentPendingStep(docs[2]), sessions.headFok).allowed
    },
    {
      name: 'head ฝสท. มี pending acknowledge ของตัวเอง',
      passed: PermissionService.getPendingDocsForSession(docs, sessions.headFst).some(doc => doc.id === 'DOC-EXT-ACK')
    },
    {
      name: 'asst_manager เห็นทุกเอกสาร',
      passed: PermissionService.filterVisibleDocs(docs, sessions.asstManager).length === docs.length
    },
    {
      name: 'manager เห็นทุกเอกสาร',
      passed: PermissionService.filterVisibleDocs(docs, sessions.manager).length === docs.length
    },
    {
      name: 'manager ไม่มีสิทธิ์ลงรับเอกสารภายนอกแทน officer',
      passed: !PermissionService.canReceiveExternal(sessions.manager)
    },
    {
      name: 'officer ฝอก. มีสิทธิ์ลงรับเอกสารภายนอก',
      passed: PermissionService.canReceiveExternal(sessions.officerFok)
    }
  ];

  const passed = tests.filter(test => test.passed).length;
  const failed = tests.filter(test => !test.passed);

  return {
    success: failed.length === 0,
    summary: {
      total: tests.length,
      passed,
      failed: failed.length
    },
    tests,
    failedTests: failed
  };
}