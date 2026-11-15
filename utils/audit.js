'use strict';
const db = require('../database');
const settings = require('../config/settings');
const { getActionLabel, buildActionGroups } = require('./audit-labels');

const CRITICAL_ACTIONS = new Set([
  'auth.login',
  'auth.brute_force',
  'rate_limit.block',
  'audit.cleanup',
  'slow_log.cleanup',
]);

const EXTENDED_ACTIONS = new Set([
  'student.reject',
  'teacher.reject',
  'student.approve',
  'student.archive', 'student.unarchive', 'student.delete',
  'student.finish', 'student.activate',
  'teacher.activate', 'teacher.archive', 'teacher.delete',
  'session.logout_all', 'session.delete',
  'student.change_login', 'student.reset_password',
  'teacher.change_login', 'teacher.reset_password',
  'student.create', 'student.change_name', 'student.change_group',
  'teacher.create', 'teacher.change_name',
  'teacher.update_max',
  'group.create', 'group.rename', 'group.archive', 'group.unarchive',
  'group.delete', 'group.delete_blocked',
  'subject.create', 'subject.update', 'subject.archive', 'subject.unarchive',
  'subject.delete', 'subject.attach_group', 'subject.detach_group',
  'subject.groups_update',
  'subject.change_teacher',
  // ─── Завершение предмета для группы ───
  'subject_groups.finish',      // закрыть для группы
  'subject_groups.restore',     // вернуть группу в предмет
  'subject_groups.bulk_accept', // массовое принятие работ группы
  'subject_groups.bulk_reject', // массовое отклонение работ группы
  'topic.create', 'topic.update', 'topic.delete', 'topic.import',
  'assignment.create', 'assignment.update', 'assignment.archive',
  'assignment.unarchive', 'assignment.delete', 'assignment.archive_on_delete',
  'submission.status', 'submission.archive', 'submission.unarchive',
  'submission.delete', 'submission.reject_ai',
  'announcement.create', 'announcement.update', 'announcement.delete',
  'announcement.pin', 'announcement.unpin',
  'teacher.bulk_delete', 'teacher.bulk_archive', 'teacher.bulk_unarchive',
  'teacher.bulk_finish', 'teacher.bulk_activate',
  'student.bulk_delete', 'student.bulk_archive', 'student.bulk_unarchive',
  'student.bulk_finish', 'student.bulk_activate',
  'group.bulk_delete', 'group.bulk_archive', 'group.bulk_unarchive',
  'group.bulk_finish', 'group.bulk_activate',
  'subject.bulk_delete', 'subject.bulk_archive', 'subject.bulk_unarchive',
  'subject.bulk_finish', 'subject.bulk_activate',
  'topic.bulk_delete',
  'submission.bulk_delete', 'submission.bulk_archive', 'submission.bulk_unarchive',
  'announcement.bulk_delete', 'group_announcement.bulk_delete',
  'student.bulk_approve', 'student.bulk_reject',
  'settings.update',
  'import.teachers', 'import.students', 'import.groups',
  'export.teachers', 'export.students', 'export.groups',
  'demo.seed', 'demo.delete',
]);

const KNOWN_ACTIONS = Array.from(new Set([
  ...CRITICAL_ACTIONS, ...EXTENDED_ACTIONS,
])).sort();

function getMutedActions() {
  try {
    const v = settings.get('audit.mutedActions');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function getForceLogActions() {
  try {
    const v = settings.get('audit.forceLogActions');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function isExtendedAuditActive() {
  try {
    const enabled = !!settings.get('audit.extended');
    if (!enabled) return false;
    const until = settings.get('audit.extendedUntil');
    if (until == null) return true;
    return Date.now() < Number(until);
  } catch { return false; }
}
function isExtendedAllActive() {
  try {
    if (!isExtendedAuditActive()) return false;
    return !!settings.get('audit.extendedAll');
  } catch { return false; }
}
function shouldLog(action) {
  if (CRITICAL_ACTIONS.has(action)) return true;
  if (isExtendedAllActive()) return true;
  if (getForceLogActions().includes(action)) return true;
  if (getMutedActions().includes(action)) return false;
  return isExtendedAuditActive();
}
function audit(req, action, targetType = null, targetId = null, details = null) {
  if (!shouldLog(action)) return;
  try {
    let actorType = 'anonymous';
    let actorId = null;
    let actorName = null;
    if (req.session?.adminId) {
      actorType = 'admin';
      actorId = req.session.adminId;
      actorName = req.session.adminName;
    } else if (req.session?.teacherId) {
      actorType = 'teacher';
      actorId = req.session.teacherId;
      actorName = req.session.teacherName;
    } else if (req.session?.studentId) {
      actorType = 'student';
      actorId = req.session.studentId;
      actorName = req.session.studentName;
    }
    db.prepare(`
      INSERT INTO audit_log
        (actor_type, actor_id, actor_name, action, target_type, target_id,
         details, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actorType, actorId, actorName, action, targetType, targetId,
      details ? JSON.stringify(details) : null,
      req.clientIp || null,
      (req.get('user-agent') || '').slice(0, 500) || null
    );
  } catch (e) {
    console.error('audit error:', e);
  }
}

module.exports = {
  audit,
  CRITICAL_ACTIONS,
  EXTENDED_ACTIONS,
  KNOWN_ACTIONS,
  isExtendedAuditActive,
  isExtendedAllActive,
  shouldLog,
  getActionLabel,
  buildActionGroups,
};