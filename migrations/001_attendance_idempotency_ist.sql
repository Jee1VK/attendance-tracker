-- Migration: 001_attendance_idempotency_ist.sql
-- Purpose: Enforce Asia/Kolkata (IST) work dates, atomic check-in/check-out idempotency,
--          previous-day incomplete session flagging, and NaN/zero-safe monthly aggregation.

CREATE TABLE IF NOT EXISTS attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    work_date TEXT NOT NULL,               -- Canonical 'YYYY-MM-DD' in Asia/Kolkata (IST)
    display_date TEXT NOT NULL,            -- Display format e.g. 'DD/MM/YYYY'
    check_in_time TEXT DEFAULT '',
    out1 TEXT DEFAULT '',
    in1 TEXT DEFAULT '',
    out2 TEXT DEFAULT '',
    in2 TEXT DEFAULT '',
    out3 TEXT DEFAULT '',
    in3 TEXT DEFAULT '',
    check_out_time TEXT DEFAULT '',
    session_status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (session_status IN ('ACTIVE', 'COMPLETED', 'ABSENT', 'INCOMPLETE_MANUAL_REVIEW', 'INVALID_TIME_ORDER')),
    target_minutes INTEGER NOT NULL DEFAULT 570,
    net_work_minutes REAL NOT NULL DEFAULT 0,
    overtime_minutes REAL NOT NULL DEFAULT 0,
    shortfall_minutes REAL NOT NULL DEFAULT 0,
    is_half_day INTEGER NOT NULL DEFAULT 0,
    is_late_in INTEGER NOT NULL DEFAULT 0,
    remarks TEXT DEFAULT '',
    created_at_ist TEXT NOT NULL,          -- ISO-8601 +05:30 IST timestamp
    updated_at_ist TEXT NOT NULL,          -- ISO-8601 +05:30 IST timestamp
    CONSTRAINT uq_employee_work_date UNIQUE (employee_id, work_date)
);

-- Atomic constraint ensuring an employee cannot hold two active check-in sessions simultaneously on the same work_date
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_checkin
    ON attendance_records (employee_id, work_date)
    WHERE session_status = 'ACTIVE';

-- Fast lookup index for monthly aggregation & chronological date queries
CREATE INDEX IF NOT EXISTS idx_attendance_work_date
    ON attendance_records (work_date);

-- Index for flagging stale unclosed sessions from previous IST calendar days
CREATE INDEX IF NOT EXISTS idx_attendance_stale_active
    ON attendance_records (session_status, work_date)
    WHERE session_status = 'ACTIVE';

-- ============================================================================
-- Stale Session Reconciliation Query (Run with :current_ist_date = 'YYYY-MM-DD')
-- Flags any previous-day check-in left unclosed as 'INCOMPLETE_MANUAL_REVIEW'
-- ============================================================================
-- UPDATE attendance_records
-- SET session_status = 'INCOMPLETE_MANUAL_REVIEW',
--     remarks = CASE
--         WHEN TRIM(COALESCE(remarks, '')) = '' THEN 'Incomplete / Manual Review Required'
--         WHEN remarks NOT LIKE '%Incomplete / Manual Review Required%' THEN remarks || ' | Incomplete / Manual Review Required'
--         ELSE remarks
--     END,
--     updated_at_ist = :now_ist
-- WHERE work_date < :current_ist_date
--   AND session_status = 'ACTIVE';

-- ============================================================================
-- Monthly Aggregation View (Division-by-zero & NULL/NaN safe)
-- Groups by YYYY-MM month slice of IST work_date and employee_id
-- ============================================================================
CREATE VIEW IF NOT EXISTS v_monthly_attendance_summary AS
SELECT
    substr(work_date, 1, 7) AS year_month,
    employee_id,
    MAX(employee_name) AS employee_name,
    SUM(CASE WHEN session_status != 'ABSENT' THEN 1 ELSE 0 END) AS total_present_days,
    SUM(CASE WHEN is_half_day = 1 AND session_status != 'ABSENT' THEN 1 ELSE 0 END) AS total_half_days,
    SUM(CASE WHEN is_late_in = 1 AND session_status != 'ABSENT' THEN 1 ELSE 0 END) AS total_late_checkins,
    SUM(CASE WHEN shortfall_minutes > 0 AND session_status != 'ABSENT' THEN 1 ELSE 0 END) AS total_shortfall_days,
    SUM(CASE WHEN session_status = 'ABSENT' THEN 1 ELSE 0 END) AS total_absent_days,
    SUM(CASE WHEN session_status = 'INCOMPLETE_MANUAL_REVIEW' THEN 1 ELSE 0 END) AS total_incomplete_days,
    ROUND(COALESCE(SUM(COALESCE(net_work_minutes, 0)), 0) / 60.0, 2) AS total_hours_worked,
    ROUND(COALESCE(SUM(COALESCE(overtime_minutes, 0)), 0) / 60.0, 2) AS total_overtime_hours,
    ROUND(
        COALESCE(SUM(COALESCE(net_work_minutes, 0)), 0) /
        NULLIF(SUM(CASE WHEN session_status != 'ABSENT' THEN 1 ELSE 0 END), 0) / 60.0,
        2
    ) AS avg_daily_hours
FROM attendance_records
GROUP BY substr(work_date, 1, 7), employee_id;
