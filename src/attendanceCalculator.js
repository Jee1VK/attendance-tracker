/**
 * Attendance Calculator Engine
 * Handles time conversions, working hours, break deductions, customizable shift targets, grace periods, and Late IN tracking.
 */

export const DEFAULT_TARGET_MINUTES = 9.5 * 60; // Default 9.5 hours = 570 mins
export const DEFAULT_EXPECTED_IN_MINUTES = 10 * 60; // Default 10:00 AM = 600 mins

export function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const cleaned = timeStr.trim().toUpperCase();
  if (cleaned === 'AB' || cleaned === 'NOTPUNCHED' || cleaned === '') return null;

  const isPM = cleaned.includes('PM');
  const isAM = cleaned.includes('AM');
  const timeOnly = cleaned.replace(/AM|PM/g, '').trim();
  const parts = timeOnly.split(/[:\.]/).map(p => parseInt(p, 10));

  if (parts.length === 0 || isNaN(parts[0])) return null;

  let hours = parts[0];
  let minutes = parts.length > 1 ? parts[1] : 0;
  let seconds = parts.length > 2 ? parts[2] : 0;

  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;
  
  // Only assume PM for ambiguous times 1:00-6:59 (break/out times are always afternoon)
  // Hours 7-12 without AM/PM are kept as-is (could be morning punch-in at 7 or 8 AM)
  if (!isAM && !isPM && hours >= 1 && hours <= 6) {
    hours += 12;
  }

  return hours * 60 + minutes + (seconds / 60);
}

export function formatMinutesToTime(minutes, includeSign = false) {
  if (minutes === null || isNaN(minutes)) return "0:00:00";
  
  const isNegative = minutes < 0;
  const absMinutes = Math.abs(minutes);

  const h = Math.floor(absMinutes / 60);
  const m = Math.floor(absMinutes % 60);
  const s = Math.round((absMinutes % 1) * 60);

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
 * Calculates a single staff attendance record with custom shift target, grace period, and Late IN threshold
 */
export function calculateAttendanceRecord(record, targetMinutes = DEFAULT_TARGET_MINUTES, graceMinutes = 0, expectedInMinutes = DEFAULT_EXPECTED_IN_MINUTES) {
  const inVal = (record.in || '').trim().toUpperCase();
  const outVal = (record.finalOut || '').trim().toUpperCase();

  if (inVal === 'AB' || outVal === 'AB') {
    return {
      ...record,
      totalWorkingHours: 'AB',
      shortfall: 'AB',
      isShortfall: false,
      isAbsent: true,
      isNotPunched: false,
      isLateIn: false,
      breakMinutes: 0
    };
  }

  if (outVal === 'NOTPUNCHED' || inVal === 'NOTPUNCHED') {
    const startMins = parseTimeToMinutes(record.in);
    const isLateIn = startMins !== null && startMins > expectedInMinutes;
    return {
      ...record,
      totalWorkingHours: 'NOTPUNCHED',
      shortfall: 'NOTPUNCHED',
      isShortfall: true,
      isAbsent: false,
      isNotPunched: true,
      isLateIn,
      breakMinutes: 0
    };
  }

  const startMins = parseTimeToMinutes(record.in);
  let endMins = parseTimeToMinutes(record.finalOut);

  if (startMins === null || endMins === null) {
    return {
      ...record,
      totalWorkingHours: 'INVALID',
      shortfall: 'INVALID',
      isShortfall: true,
      isAbsent: false,
      isNotPunched: false,
      isLateIn: false,
      breakMinutes: 0
    };
  }

  // Handle overnight shifts across midnight
  if (endMins < startMins) {
    endMins += 24 * 60;
  }

  let totalBreakMinutes = 0;
  const breakPairs = [
    { out: record.out1, in: record.in1 },
    { out: record.out2, in: record.in2 },
    { out: record.out3, in: record.in3 }
  ];

  breakPairs.forEach(pair => {
    const oMins = parseTimeToMinutes(pair.out);
    let iMins = parseTimeToMinutes(pair.in);
    if (oMins !== null && iMins !== null) {
      if (iMins < oMins) iMins += 24 * 60;
      totalBreakMinutes += (iMins - oMins);
    }
  });

  const recordTargetMinutes = (record.targetMinutes !== undefined && record.targetMinutes !== null) ? parseInt(record.targetMinutes, 10) : targetMinutes;

  const grossMinutes = endMins - startMins;
  const netWorkMinutes = Math.max(0, grossMinutes - totalBreakMinutes);
  
  const effectiveMinutes = netWorkMinutes + graceMinutes;
  const shortfallMinutes = recordTargetMinutes - effectiveMinutes;

  const isShortfall = shortfallMinutes > 0;
  const isLateIn = startMins > expectedInMinutes;

  return {
    ...record,
    targetMinutes: recordTargetMinutes,
    totalWorkingHours: formatMinutesToTime(netWorkMinutes),
    shortfall: formatMinutesToTime(shortfallMinutes),
    isShortfall,
    isAbsent: false,
    isNotPunched: false,
    isLateIn,
    netWorkMinutes,
    shortfallMinutes,
    breakMinutes: totalBreakMinutes
  };
}

/**
 * Calculates overall summary metrics
 */
export function calculateSummaryMetrics(records, targetMinutes = DEFAULT_TARGET_MINUTES, graceMinutes = 0, expectedInMinutes = DEFAULT_EXPECTED_IN_MINUTES) {
  const processed = records.map(r => calculateAttendanceRecord(r, targetMinutes, graceMinutes, expectedInMinutes));

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
    if (typeof r.netWorkMinutes === 'number' && !isNaN(r.netWorkMinutes)) {
      totalWorkMinutes += r.netWorkMinutes;
      workCount++;
    }
  });

  const avgWorkMinutes = workCount > 0 ? (totalWorkMinutes / workCount) : 0;
  const targetHoursLabel = `${(targetMinutes / 60).toFixed(1)} Hours`;

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
      targetHoursLabel
    }
  };
}

/**
 * Calculates monthly payroll, late penalties, and net estimated salary
 */
export function calculatePayroll(monthlyStats, options = {}) {
  const dailyRate = options.dailyRate || 500;
  const lateDeductionRule = options.lateDeductionRule || 3; // 3 Lates = 0.5 Day deduction

  return monthlyStats.map(staff => {
    const present = staff.presentDays || 0;
    const lates = staff.lateDays || 0;
    const absents = staff.absentDays || 0;

    const latePenaltyDays = lateDeductionRule > 0 ? Math.floor(lates / lateDeductionRule) * 0.5 : 0;
    const netPayableDays = Math.max(0, present - latePenaltyDays);
    const estimatedSalary = Math.round(netPayableDays * dailyRate);

    return {
      ...staff,
      dailyRate,
      latePenaltyDays,
      netPayableDays,
      estimatedSalary
    };
  });
}

