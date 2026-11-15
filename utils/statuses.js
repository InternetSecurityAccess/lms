'use strict';

const WORK_STATUSES = Object.freeze({
  pending: Object.freeze({ label: 'На проверке', cls: 'pending' }),
  accepted: Object.freeze({ label: 'Принята', cls: 'accepted' }),
  rejected: Object.freeze({ label: 'Отклонена', cls: 'rejected' }),
});

function isValidWorkStatus(status) {
  return Object.hasOwn(WORK_STATUSES, status);
}

module.exports = { WORK_STATUSES, isValidWorkStatus };