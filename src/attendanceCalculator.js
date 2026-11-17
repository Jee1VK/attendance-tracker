/**
 * Attendance Calculator Engine & Monthly Reporting Aggregator
 * Enforces Asia/Kolkata (IST) calendar boundaries, time conversions, working hours,
 * break deductions, Half Day / Overtime detection, Late IN tracking, and NaN-safe payroll metrics.
 */

export const IST_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_TARGET_MINUTES = 9.5 * 60; // Default 9.5 hours = 570 mins
export const DEFAULT_EXPECTED_IN_MINUTES = 10 * 60; // Default 10:00 AM = 600 mins

const istPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

/**
 * Extracts explicit Asia/Kolkata (IST) calendar and clock components from any Date/timestamp.
 * Guarantees timestamps between 00:00 and 05:30 AM IST map to the true local IST calendar day
 * rather than leaking into the previous UTC day.
 */
export function getISTDateParts(dateInput = new Date()) {
  let d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) {
    d = new Date();
  }

  const partsMap = {};
  istPartsFormatter.formatToParts(d).forEach(part => {
    if (part.type !== 'literal') {
      partsMap[part.type] = part.value;
    }
  });

  const hour = partsMap.hour === '24' ? '00' : String(partsMap.hour || '00').padStart(2, '0');

  return {
    year: partsMap.year,
    month: partsMap.month,
    day: partsMap.day,
    weekday: String(partsMap.weekday || '').toUpperCase(),
    hour,
    minute: String(partsMap.minute || '00').padStart(2, '0'),
    second: String(partsMap.second || '00').padStart(2, '0')
  };
}

/**
 * Returns canonical YYYY-MM-DD work_date string explicitly in Asia/Kolkata (IST).
 */
export function getISTDateISO(dateInput = new Date()) {
  const { year, month, day } = getISTDateParts(dateInput);
  return `${year}-${month}-${day}`;
}

/**
 * Returns DD/MM/YYYY (or DD/MM/YYYY WEEKDAY) display date string in Asia/Kolkata (IST).
 */
export function getISTDisplayDate(dateInput = new Date(), includeWeekday = false) {
  const { year, month, day, weekday } = getISTDateParts(dateInput);
  const base = `${day}/${month}/${year}`;
  return includeWeekday && weekday ? `${base} ${weekday}` : base;
}

/**
 * Returns ISO-8601 timestamp anchored to +05:30 IST (e.g. 2026-11-17T00:15:00+05:30).
 */
export function getISTTimestamp(dateInput = new Date()) {
  const { year, month, day, hour, minute, second } = getISTDateParts(dateInput);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+05:30`;
}

/**
 * Normalizes various register date strings ('03/09/2026 THURSDAY', '31/07/2026', '2026-09-03')
 * into canonical YYYY-MM-DD for chronological sorting and previous-day checks.
 */
export function normalizeWorkDateIST(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const trimmed = dateStr.trim();
  if (!trimmed) return '';

  // Match YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = trimmed.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Match DD/MM/YYYY or DD-MM-YYYY (with optional trailing weekday like '03/09/2026 THURSDAY')
  const dmyMatch = trimmed.match(/\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\b/);
  if (dmyMatch) {
    const d = dmyMatch[1].padStart(2, '0');
    const m = dmyMatch[2].padStart(2, '0');
    const y = dmyMatch[3];
    return `${y}-${m}-${d}`;
  }

  return '';
}

/**
 * Normalizes a staff name into a canonical identifier for idempotency checks.
 */
export function normalizeEmployeeId(name) {
  return String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[\s\.\-\_\(\)]+/g, ' ')
    .trim();
}

export function parseTimeToMinutes(timeStr, isCheckIn = false) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const cleaned = timeStr.trim().toUpperCase();
  if (cleaned === 'AB' || cleaned === 'ABSENT' || cleaned === 'NOTPUNCHED' || cleaned === 'INVALID' || cleaned === '-' || cleaned === '') {
    return null;
  }

  const isPM = cleaned.includes('PM');
  const isAM = cleaned.includes('AM');
  const timeOnly = cleaned.replace(/AM|PM/gi, '').trim();
  if (!timeOnly) return null;

  const rawParts = timeOnly.split(/[:\.\-\=]/).map(s => s.trim()).filter(s => s !== '');
  if (rawParts.length === 0) return null;

  const parts = rawParts.map(p => (/^\d+$/.test(p) ? parseInt(p, 10) : NaN));
  if (parts.some(p => isNaN(p))) return null;

  let hours = parts[0];
  const minutes = parts.length > 1 ? parts[1] : 0;
  const seconds = parts.length > 2 ? parts[2] : 0;

  if (hours < 0 || hours > 24 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) {
    return null;
  }
  if (hours === 24 && (minutes > 0 || seconds > 0)) {
    return null;
  }

  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;

  if (!isAM && !isPM) {
    if (isCheckIn) {
      // Early-morning IST check-ins (00:00 - 05:59 AM) written with leading 0 (e.g. 00:30, 04:15)
      // stay in AM; ambiguous 1:00 - 6:59 without leading zero default to afternoon shift PM.
      const hasEarlyZeroPrefix = /^0[0-5](?:[:\.\-\=]|$)/.test(timeOnly);
      if (hours >= 1 && hours <= 6 && !hasEarlyZeroPrefix) {
        hours += 12;
      }
    } else {
      // Break punches & final check-out 1:00 - 6:59 without AM/PM default to PM.
      if (hours >= 1 && hours <= 6) {
        hours += 12;
      }
    }
  }

  const total = hours * 60 + minutes + (seconds / 60);
  return Number.isFinite(total) ? total : null;
}

export function formatMinutesToTime(minutes, includeSign = false) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "0:00:00";

  const isNegative = minutes < 0;
  const absMinutes = Math.abs(minutes);

  let h = Math.floor(absMinutes / 60);
  let m = Math.floor(absMinutes % 60);
  let s = Math.round((absMinutes % 1) * 60);

  if (s === 60) {
    s = 0;
    m += 1;
    if (m === 60) {
      m = 0;
      h += 1;
    }
  }

  const pad = (n) => String(n).padStart(2, '0');
  const formatted = `${h}:${pad(m)}:${pad(s)}`;

  if (isNegative) {
    return `-${formatted}`;
  } else if (includeSign && minutes > 0) {
    return `${formatted}`;
  }
  return formatted;
}

/**
 * Calculates a single staff attendance record with custom shift target, grace period,
 * Late IN threshold, Half Day & Overtime detection, and strict time-order validation.
 */
export function calculateAttendanceRecord(
  record,
  targetMinutes = DEFAULT_TARGET_MINUTES,
  graceMinutes = 0,
  expectedInMinutes = DEFAULT_EXPECTED_IN_MINUTES,
  options = {}
) {
  const safeTarget = Number.isFinite(Number(targetMinutes)) && Number(targetMinutes) > 0 ? Number(targetMinutes) : DEFAULT_TARGET_MINUTES;
  const safeGrace = Number.isFinite(Number(graceMinutes)) && Number(graceMinutes) >= 0 ? Number(graceMinutes) : 0;
  const safeExpectedIn = Number.isFinite(Number(expectedInMinutes)) && Number(expectedInMinutes) >= 0 ? Number(expectedInMinutes) : DEFAULT_EXPECTED_IN_MINUTES;
  const isPreviousDay = Boolean(options.isPreviousDay);

  const inVal = String(record?.in || '').trim().toUpperCase();
  const outVal = String(record?.finalOut || '').trim().toUpperCase();
  const remarksStr = String(record?.remarks || '').trim();
  const remarksLower = remarksStr.toLowerCase();

  if (inVal === 'AB' || outVal === 'AB') {
    return {
      ...record,
      targetMinutes: safeTarget,
      totalWorkingHours: 'AB',
      shortfall: 'AB',
      overtime: '0:00:00',
      isShortfall: false,
      isOvertime: false,
      isHalfDay: false,
      isAbsent: true,
      isNotPunched: false,
      isIncompletePreviousDay: false,
      isInvalidTimeOrder: false,
      isLateIn: false,
      netWorkMinutes: 0,
      shortfallMinutes: 0,
      overtimeMinutes: 0,
      breakMinutes: 0,
      sessionStatus: 'ABSENT',
      statusLabel: 'ABSENT'
    };
  }

  const startMins = parseTimeToMinutes(record?.in, true);

  // Active / unclosed check-in (marked NOTPUNCHED or blank finalOut while valid check-in exists)
  if (
    outVal === 'NOTPUNCHED' ||
    inVal === 'NOTPUNCHED' ||
    (startMins !== null && (outVal === '' || outVal === '-'))
  ) {
    const isLateIn = startMins !== null && startMins > safeExpectedIn;
    const isIncompletePrev = isPreviousDay || record?.sessionStatus === 'INCOMPLETE_MANUAL_REVIEW';
    return {
      ...record,
      targetMinutes: safeTarget,
      totalWorkingHours: 'NOTPUNCHED',
      shortfall: 'NOTPUNCHED',
      overtime: '0:00:00',
      isShortfall: true,
      isOvertime: false,
      isHalfDay: false,
      isAbsent: false,
      isNotPunched: true,
      isIncompletePreviousDay: isIncompletePrev,
      isInvalidTimeOrder: false,
      isLateIn,
      netWorkMinutes: 0,
      shortfallMinutes: 0,
      overtimeMinutes: 0,
      breakMinutes: 0,
      sessionStatus: isIncompletePrev ? 'INCOMPLETE_MANUAL_REVIEW' : 'ACTIVE',
      statusLabel: isIncompletePrev ? 'Incomplete / Manual Review Required' : 'Active / Not Punched'
    };
  }

  let endMins = parseTimeToMinutes(record?.finalOut, false);

  if (startMins === null || endMins === null) {
    return {
      ...record,
      targetMinutes: safeTarget,
      totalWorkingHours: 'INVALID',
      shortfall: 'INVALID',
      overtime: '0:00:00',
      isShortfall: true,
      isOvertime: false,
      isHalfDay: false,
      isAbsent: false,
      isNotPunched: false,
      isIncompletePreviousDay: false,
      isInvalidTimeOrder: false,
      isLateIn: false,
      netWorkMinutes: 0,
      shortfallMinutes: 0,
      overtimeMinutes: 0,
      breakMinutes: 0,
      sessionStatus: 'INVALID_TIME_ORDER',
      statusLabel: 'Invalid Punch Time'
    };
  }

  // Resolve ambiguous PM punch-outs without explicit AM/PM (e.g. In 10:00, Out 7:30 -> 19:30)
  const explicitOutAM = outVal.includes('AM');
  const allowsOvernight = /\b(overnight|night\s*shift)\b/i.test(remarksLower);

  if (endMins < startMins) {
    if (!explicitOutAM && endMins < 720 && (endMins + 12 * 60) > startMins) {
      endMins += 12 * 60;
    } else if (allowsOvernight) {
      endMins += 24 * 60;
    }
  }

  // Strictly enforce check_out_time > check_in_time
  if (endMins <= startMins) {
    return {
      ...record,
      targetMinutes: safeTarget,
      totalWorkingHours: 'INVALID',
      shortfall: 'INVALID',
      overtime: '0:00:00',
      isShortfall: true,
      isOvertime: false,
      isHalfDay: false,
      isAbsent: false,
      isNotPunched: false,
      isIncompletePreviousDay: false,
      isInvalidTimeOrder: true,
      isLateIn: startMins > safeExpectedIn,
      netWorkMinutes: 0,
      shortfallMinutes: 0,
      overtimeMinutes: 0,
      breakMinutes: 0,
      sessionStatus: 'INVALID_TIME_ORDER',
      statusLabel: 'Check-Out <= Check-In'
    };
  }

  let totalBreakMinutes = 0;
  const breakPairs = [
    { out: record?.out1, in: record?.in1 },
    { out: record?.out2, in: record?.in2 },
    { out: record?.out3, in: record?.in3 }
  ];

  breakPairs.forEach(pair => {
    let oMins = parseTimeToMinutes(pair.out, false);
    let iMins = parseTimeToMinutes(pair.in, false);
    if (oMins !== null && iMins !== null) {
      if (oMins < startMins && oMins < 720 && (oMins + 12 * 60) >= startMins) oMins += 12 * 60;
      if (iMins < oMins && iMins < 720 && (iMins + 12 * 60) >= oMins) iMins += 12 * 60;
      else if (iMins < oMins && allowsOvernight) iMins += 24 * 60;
      const diff = iMins - oMins;
      if (Number.isFinite(diff) && diff > 0) {
        totalBreakMinutes += diff;
      }
    }
  });

  const parsedCustomTarget = (record?.targetMinutes !== undefined && record?.targetMinutes !== null && record?.targetMinutes !== '')
    ? parseInt(record.targetMinutes, 10)
    : NaN;
  const recordTargetMinutes = Number.isFinite(parsedCustomTarget) && parsedCustomTarget > 0 ? parsedCustomTarget : safeTarget;

  const grossMinutes = endMins - startMins;
  const netWorkMinutes = Math.max(0, grossMinutes - totalBreakMinutes);

  const effectiveMinutes = netWorkMinutes + safeGrace;
  const rawShortfall = recordTargetMinutes - effectiveMinutes;
  const isShortfall = rawShortfall > 0;
  const shortfallMinutes = isShortfall ? rawShortfall : 0;

  const overtimeMinutes = Math.max(0, netWorkMinutes - recordTargetMinutes);
  const isOvertime = overtimeMinutes > 0;

  const hasHalfDayRemark = /\b(half\s*day|h\.?d\.?|0\.5\s*day)\b/i.test(remarksLower);
  const isHalfDay = hasHalfDayRemark || (netWorkMinutes > 0 && netWorkMinutes <= recordTargetMinutes * 0.6);

  const isLateIn = startMins > safeExpectedIn;

  return {
    ...record,
    targetMinutes: recordTargetMinutes,
    totalWorkingHours: formatMinutesToTime(netWorkMinutes),
    shortfall: formatMinutesToTime(shortfallMinutes),
    overtime: formatMinutesToTime(overtimeMinutes),
    isShortfall,
    isOvertime,
    isHalfDay,
    isAbsent: false,
    isNotPunched: false,
    isIncompletePreviousDay: false,
    isInvalidTimeOrder: false,
    isLateIn,
    netWorkMinutes,
    shortfallMinutes,
    overtimeMinutes,
    breakMinutes: totalBreakMinutes,
    sessionStatus: 'COMPLETED',
    statusLabel: isHalfDay ? 'Half Day' : (isShortfall ? 'Shortfall' : (isOvertime ? 'Overtime' : 'Full Hours'))
  };
}

/**
 * Calculates overall summary metrics
 */
export function calculateSummaryMetrics(
  records,
  targetMinutes = DEFAULT_TARGET_MINUTES,
  graceMinutes = 0,
  expectedInMinutes = DEFAULT_EXPECTED_IN_MINUTES,
  options = {}
) {
  const safeRecords = Array.isArray(records) ? records : [];
  const safeTarget = Number.isFinite(Number(targetMinutes)) && Number(targetMinutes) > 0 ? Number(targetMinutes) : DEFAULT_TARGET_MINUTES;

  const processed = safeRecords.map((r, idx) => ({
    ...calculateAttendanceRecord(r, safeTarget, graceMinutes, expectedInMinutes, options),
    _originalIndex: idx
  }));

  const totalStaff = processed.length;
  const absentCount = processed.filter(r => r.isAbsent).length;
  const notPunchedCount = processed.filter(r => r.isNotPunched).length;
  const presentCount = totalStaff - absentCount;

  const shortfallCount = processed.filter(r => r.isShortfall && !r.isAbsent).length;
  const fullHoursCount = processed.filter(r => !r.isShortfall && !r.isAbsent && !r.isNotPunched).length;
  const lateInCount = processed.filter(r => r.isLateIn && !r.isAbsent).length;

  let totalWorkMinutes = 0;
  let workCount = 0;

  processed.forEach(r => {
    if (typeof r.netWorkMinutes === 'number' && Number.isFinite(r.netWorkMinutes) && r.netWorkMinutes > 0) {
      totalWorkMinutes += r.netWorkMinutes;
      workCount++;
    }
  });

  const avgWorkMinutes = workCount > 0 ? (totalWorkMinutes / workCount) : 0;
  const targetHoursLabel = `${(safeTarget / 60).toFixed(1)} Hours`;

  return {
    processedRecords: processed,
    metrics: {
      totalStaff,
      presentCount,
      absentCount,
      notPunchedCount,
      shortfallCount,
      fullHoursCount,
      lateInCount,
      avgWorkingHours: formatMinutesToTime(avgWorkMinutes),
      targetHoursLabel,
      graceMinutes: Number.isFinite(Number(graceMinutes)) ? Number(graceMinutes) : 0
    }
  };
}

/**
 * Aggregates multi-day rosters into Monthly Attendance & Payroll metrics.
 * Deduplicates by (employeeId, workDate) and guards against NaN or zero-division errors.
 */
export function aggregateMonthlyAttendance(rostersByDate, options = {}) {
  if (!rostersByDate || typeof rostersByDate !== 'object') return [];

  const targetMinutes = Number.isFinite(Number(options.targetMinutes)) && Number(options.targetMinutes) > 0
    ? Number(options.targetMinutes)
    : DEFAULT_TARGET_MINUTES;
  const graceMinutes = Number.isFinite(Number(options.graceMinutes)) && Number(options.graceMinutes) >= 0
    ? Number(options.graceMinutes)
    : 0;
  const expectedInMinutes = Number.isFinite(Number(options.expectedInMinutes)) && Number(options.expectedInMinutes) >= 0
    ? Number(options.expectedInMinutes)
    : DEFAULT_EXPECTED_IN_MINUTES;
  const normalizeNameFn = typeof options.normalizeNameFn === 'function'
    ? options.normalizeNameFn
    : (n) => n;

  const todayIST = options.currentISTDate || getISTDateISO();
  const dateKeys = Object.keys(rostersByDate).sort((a, b) => {
    const isoA = normalizeWorkDateIST(a) || a;
    const isoB = normalizeWorkDateIST(b) || b;
    return isoA.localeCompare(isoB);
  });

  const staffStatsMap = {};
  const seenEmployeeDateKeys = new Set();

  dateKeys.forEach(dateKey => {
    const normalizedDate = normalizeWorkDateIST(dateKey) || String(dateKey).trim();
    const isPreviousDay = Boolean(normalizeWorkDateIST(dateKey) && normalizedDate < todayIST);
    const dailyRecords = Array.isArray(rostersByDate[dateKey]) ? rostersByDate[dateKey] : [];

    dailyRecords.forEach(r => {
      if (!r || typeof r !== 'object') return;
      let displayName = String(r.name || '').trim().toUpperCase();
      if (!displayName) return;
      displayName = normalizeNameFn(displayName);

      const empId = normalizeEmployeeId(displayName);
      if (!empId) return;

      // Prevent double-counting if duplicate entry exists for the same employee on the same date
      const dedupeKey = `${empId}::${normalizedDate}`;
      if (seenEmployeeDateKeys.has(dedupeKey)) return;
      seenEmployeeDateKeys.add(dedupeKey);

      if (!staffStatsMap[empId]) {
        staffStatsMap[empId] = {
          employeeId: empId,
          name: displayName,
          presentDays: 0,
          halfDays: 0,
          lateDays: 0,
          lateCheckIns: 0,
          shortfallDays: 0,
          absentDays: 0,
          incompleteDays: 0,
          totalWorkMinutes: 0,
          totalOvertimeMinutes: 0
        };
      }

      const computed = calculateAttendanceRecord(r, targetMinutes, graceMinutes, expectedInMinutes, { isPreviousDay });
      const stats = staffStatsMap[empId];

      if (computed.isAbsent) {
        stats.absentDays++;
      } else {
        stats.presentDays++;
        if (computed.isHalfDay) stats.halfDays++;
        if (computed.isLateIn) {
          stats.lateDays++;
          stats.lateCheckIns++;
        }
        if (computed.isShortfall) stats.shortfallDays++;
        if (computed.isIncompletePreviousDay) stats.incompleteDays++;

        const workMins = Number.isFinite(computed.netWorkMinutes) ? Math.max(0, computed.netWorkMinutes) : 0;
        const otMins = Number.isFinite(computed.overtimeMinutes) ? Math.max(0, computed.overtimeMinutes) : 0;
        stats.totalWorkMinutes += workMins;
        stats.totalOvertimeMinutes += otMins;
      }
    });
  });

  const aggregatedList = Object.values(staffStatsMap).map(s => {
    const safeWorkMins = Number.isFinite(s.totalWorkMinutes) ? s.totalWorkMinutes : 0;
    const safeOtMins = Number.isFinite(s.totalOvertimeMinutes) ? s.totalOvertimeMinutes : 0;
    const avgMins = s.presentDays > 0 ? (safeWorkMins / s.presentDays) : 0;

    return {
      ...s,
      totalWorkMinutes: safeWorkMins,
      totalHoursWorked: formatMinutesToTime(safeWorkMins),
      totalHoursDecimal: Number((safeWorkMins / 60).toFixed(2)),
      totalOvertimeMinutes: safeOtMins,
      totalOvertimeHours: formatMinutesToTime(safeOtMins),
      overtimeHoursDecimal: Number((safeOtMins / 60).toFixed(2)),
      avgDailyHours: formatMinutesToTime(avgMins)
    };
  });

  return calculatePayroll(aggregatedList, options);
}

/**
 * Calculates monthly payroll, half-day adjustments, late penalties, and net estimated salary.
 * Protected against NaN and division-by-zero inputs.
 */
export function calculatePayroll(monthlyStats, options = {}) {
  const safeList = Array.isArray(monthlyStats) ? monthlyStats : [];
  const parsedRate = Number(options.dailyRate);
  const dailyRate = Number.isFinite(parsedRate) && parsedRate >= 0 ? parsedRate : 500;

  const parsedLateRule = parseInt(options.lateDeductionRule, 10);
  const lateDeductionRule = Number.isFinite(parsedLateRule) && parsedLateRule >= 0 ? parsedLateRule : 3;

  const parsedOtHourlyRate = Number(options.overtimeHourlyRate);
  const overtimeHourlyRate = Number.isFinite(parsedOtHourlyRate) && parsedOtHourlyRate >= 0 ? parsedOtHourlyRate : 0;

  return safeList.map(staff => {
    const present = Number.isFinite(Number(staff?.presentDays)) ? Number(staff.presentDays) : 0;
    const halfDays = Number.isFinite(Number(staff?.halfDays)) ? Number(staff.halfDays) : 0;
    const lates = Number.isFinite(Number(staff?.lateDays)) ? Number(staff.lateDays) : 0;
    const otMins = Number.isFinite(Number(staff?.totalOvertimeMinutes)) ? Number(staff.totalOvertimeMinutes) : 0;

    const effectivePresentDays = Math.max(0, present - halfDays * 0.5);
    const latePenaltyDays = lateDeductionRule > 0 ? Math.floor(lates / lateDeductionRule) * 0.5 : 0;
    const netPayableDays = Math.max(0, effectivePresentDays - latePenaltyDays);
    const overtimePay = overtimeHourlyRate > 0 ? Math.round((otMins / 60) * overtimeHourlyRate) : 0;
    const estimatedSalary = Math.max(0, Math.round(netPayableDays * dailyRate) + overtimePay);

    return {
      ...staff,
      presentDays: present,
      halfDays,
      lateDays: lates,
      lateCheckIns: lates,
      effectivePresentDays,
      dailyRate,
      latePenaltyDays,
      netPayableDays,
      overtimePay,
      estimatedSalary: Number.isFinite(estimatedSalary) ? estimatedSalary : 0
    };
  });
}
