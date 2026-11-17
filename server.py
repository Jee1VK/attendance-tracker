import http.server
import socketserver
import os
import sys
import json
import re
import sqlite3
import datetime
import urllib.request
import urllib.parse

PORT = 8000
IST_TZ = datetime.timezone(datetime.timedelta(hours=5, minutes=30), name="IST")

# Fix PyInstaller frozen directory resolution
if getattr(sys, 'frozen', False):
    # Running as standalone compiled executable (PyInstaller)
    DIRECTORY = os.path.dirname(os.path.abspath(sys.executable))
else:
    # Running as Python script
    DIRECTORY = os.path.dirname(os.path.abspath(__file__))

DB_PATH = os.path.join(DIRECTORY, "attendance_tracker.db")
MIGRATION_PATH = os.path.join(DIRECTORY, "migrations", "001_attendance_idempotency_ist.sql")

EMBEDDED_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT NOT NULL,
    employee_name TEXT NOT NULL,
    work_date TEXT NOT NULL,
    display_date TEXT NOT NULL,
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
    created_at_ist TEXT NOT NULL,
    updated_at_ist TEXT NOT NULL,
    CONSTRAINT uq_employee_work_date UNIQUE (employee_id, work_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_checkin
    ON attendance_records (employee_id, work_date)
    WHERE session_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_attendance_work_date
    ON attendance_records (work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_stale_active
    ON attendance_records (session_status, work_date)
    WHERE session_status = 'ACTIVE';
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
"""

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
if not GEMINI_API_KEY:
    key_file = os.path.join(DIRECTORY, "gemini_key.txt")
    if os.path.exists(key_file):
        try:
            with open(key_file, "r", encoding="utf-8") as kf:
                GEMINI_API_KEY = kf.read().strip()
        except Exception:
            pass


def get_ist_now():
    """Returns current datetime strictly anchored to Asia/Kolkata (+05:30 IST)."""
    return datetime.datetime.now(IST_TZ)


def get_ist_date_iso(dt=None):
    """Returns YYYY-MM-DD strictly in Asia/Kolkata (IST)."""
    target = dt.astimezone(IST_TZ) if dt else get_ist_now()
    return target.strftime("%Y-%m-%d")


def get_ist_timestamp(dt=None):
    """Returns ISO-8601 +05:30 IST timestamp string."""
    target = dt.astimezone(IST_TZ) if dt else get_ist_now()
    return target.strftime("%Y-%m-%dT%H:%M:%S+05:30")


def normalize_work_date_ist(date_str):
    """Normalizes DD/MM/YYYY or YYYY-MM-DD register date strings into YYYY-MM-DD."""
    if not date_str or not isinstance(date_str, str):
        return ""
    trimmed = date_str.strip()
    if not trimmed:
        return ""

    iso_match = re.match(r'^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b', trimmed)
    if iso_match:
        return f"{iso_match.group(1)}-{int(iso_match.group(2)):02d}-{int(iso_match.group(3)):02d}"

    dmy_match = re.search(r'\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b', trimmed)
    if dmy_match:
        return f"{dmy_match.group(3)}-{int(dmy_match.group(2)):02d}-{int(dmy_match.group(1)):02d}"

    return ""


def normalize_employee_id(name):
    """Produces a canonical uppercase ID string for idempotent DB keys."""
    return re.sub(r'[\s\.\-\_\(\)]+', ' ', str(name or '').strip().upper()).strip()


def parse_time_to_minutes(time_str, is_check_in=False):
    """Parses 12h/24h attendance strings into minutes since midnight with validation."""
    if not time_str or not isinstance(time_str, str):
        return None
    cleaned = time_str.strip().upper()
    if cleaned in ('AB', 'ABSENT', 'NOTPUNCHED', 'INVALID', '-', ''):
        return None

    is_pm = 'PM' in cleaned
    is_am = 'AM' in cleaned
    time_only = re.sub(r'AM|PM', '', cleaned, flags=re.IGNORECASE).strip()
    if not time_only:
        return None

    raw_parts = [p.strip() for p in re.split(r'[:.\-=]', time_only) if p.strip() != '']
    if not raw_parts:
        return None

    parts = []
    for p in raw_parts:
        if not p.isdigit():
            return None
        parts.append(int(p))

    hours = parts[0]
    minutes = parts[1] if len(parts) > 1 else 0
    seconds = parts[2] if len(parts) > 2 else 0

    if hours < 0 or hours > 24 or minutes < 0 or minutes >= 60 or seconds < 0 or seconds >= 60:
        return None
    if hours == 24 and (minutes > 0 or seconds > 0):
        return None

    if is_pm and hours < 12:
        hours += 12
    if is_am and hours == 12:
        hours = 0

    if not is_am and not is_pm:
        if is_check_in:
            has_early_zero = bool(re.match(r'^0[0-5](?:[:.\-=]|$)', time_only))
            if 1 <= hours <= 6 and not has_early_zero:
                hours += 12
        else:
            if 1 <= hours <= 6:
                hours += 12

    return hours * 60 + minutes + (seconds / 60.0)


def compute_record_state(rec, work_date_iso, target_minutes=570, grace_minutes=0, expected_in_minutes=600):
    """Computes status, work minutes, overtime, half-day, and check_out > check_in validation."""
    current_ist = get_ist_date_iso()
    is_previous_day = bool(work_date_iso and work_date_iso < current_ist)

    in_val = str(rec.get('in') or rec.get('check_in_time') or '').strip().upper()
    out_val = str(rec.get('finalOut') or rec.get('check_out_time') or '').strip().upper()
    remarks = str(rec.get('remarks') or '').strip()
    remarks_lower = remarks.lower()

    try:
        safe_target = int(rec.get('targetMinutes') or target_minutes or 570)
    except (TypeError, ValueError):
        safe_target = 570
    if safe_target <= 0:
        safe_target = 570

    if in_val == 'AB' or out_val == 'AB':
        return {
            'session_status': 'ABSENT',
            'net_work_minutes': 0.0,
            'overtime_minutes': 0.0,
            'shortfall_minutes': 0.0,
            'is_half_day': 0,
            'is_late_in': 0,
            'remarks': remarks,
            'error': None
        }

    start_mins = parse_time_to_minutes(rec.get('in') or rec.get('check_in_time') or '', is_check_in=True)

    if out_val == 'NOTPUNCHED' or in_val == 'NOTPUNCHED' or (start_mins is not None and out_val in ('', '-')):
        is_late = 1 if (start_mins is not None and start_mins > expected_in_minutes) else 0
        if is_previous_day:
            if 'Incomplete / Manual Review Required' not in remarks:
                remarks = f"{remarks} | Incomplete / Manual Review Required" if remarks else "Incomplete / Manual Review Required"
            status = 'INCOMPLETE_MANUAL_REVIEW'
        else:
            status = 'ACTIVE'
        return {
            'session_status': status,
            'net_work_minutes': 0.0,
            'overtime_minutes': 0.0,
            'shortfall_minutes': 0.0,
            'is_half_day': 0,
            'is_late_in': is_late,
            'remarks': remarks,
            'error': None
        }

    end_mins = parse_time_to_minutes(rec.get('finalOut') or rec.get('check_out_time') or '', is_check_in=False)
    if start_mins is None or end_mins is None:
        return {
            'session_status': 'INVALID_TIME_ORDER',
            'net_work_minutes': 0.0,
            'overtime_minutes': 0.0,
            'shortfall_minutes': 0.0,
            'is_half_day': 0,
            'is_late_in': 0,
            'remarks': remarks,
            'error': 'Invalid check-in or check-out time format.'
        }

    explicit_out_am = 'AM' in out_val
    allows_overnight = bool(re.search(r'\b(overnight|night\s*shift)\b', remarks_lower))
    if end_mins < start_mins:
        if not explicit_out_am and end_mins < 720 and (end_mins + 720) > start_mins:
            end_mins += 720
        elif allows_overnight:
            end_mins += 1440

    if end_mins <= start_mins:
        return {
            'session_status': 'INVALID_TIME_ORDER',
            'net_work_minutes': 0.0,
            'overtime_minutes': 0.0,
            'shortfall_minutes': 0.0,
            'is_half_day': 0,
            'is_late_in': 1 if start_mins > expected_in_minutes else 0,
            'remarks': remarks,
            'error': 'check_out_time must be strictly later than check_in_time.'
        }

    total_break = 0.0
    for o_key, i_key in [('out1', 'in1'), ('out2', 'in2'), ('out3', 'in3')]:
        o_mins = parse_time_to_minutes(rec.get(o_key) or '', is_check_in=False)
        i_mins = parse_time_to_minutes(rec.get(i_key) or '', is_check_in=False)
        if o_mins is not None and i_mins is not None:
            if o_mins < start_mins and o_mins < 720 and (o_mins + 720) >= start_mins:
                o_mins += 720
            if i_mins < o_mins and i_mins < 720 and (i_mins + 720) >= o_mins:
                i_mins += 720
            elif i_mins < o_mins and allows_overnight:
                i_mins += 1440
            total_break += max(0.0, i_mins - o_mins)

    net_work = max(0.0, (end_mins - start_mins) - total_break)
    effective = net_work + grace_minutes
    shortfall = max(0.0, safe_target - effective)
    overtime = max(0.0, net_work - safe_target)
    has_hd_remark = bool(re.search(r'\b(half\s*day|h\.?d\.?|0\.5\s*day)\b', remarks_lower))
    is_half_day = 1 if (has_hd_remark or (0 < net_work <= safe_target * 0.6)) else 0
    is_late = 1 if start_mins > expected_in_minutes else 0

    return {
        'session_status': 'COMPLETED',
        'net_work_minutes': round(net_work, 2),
        'overtime_minutes': round(overtime, 2),
        'shortfall_minutes': round(shortfall, 2),
        'is_half_day': is_half_day,
        'is_late_in': is_late,
        'remarks': remarks,
        'error': None
    }


def get_db_connection(db_path=None):
    """Returns a SQLite connection configured for strict transactional integrity."""
    conn = sqlite3.connect(db_path or DB_PATH, timeout=15.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def init_db(db_path=None):
    """Initializes SQLite tables, unique constraints, and monthly summary view."""
    schema_sql = EMBEDDED_SCHEMA_SQL
    if os.path.exists(MIGRATION_PATH):
        try:
            with open(MIGRATION_PATH, "r", encoding="utf-8") as mf:
                schema_sql = mf.read()
        except Exception:
            pass

    conn = get_db_connection(db_path)
    try:
        conn.executescript(schema_sql)
    finally:
        conn.close()


def reconcile_stale_sessions(conn, current_ist_date=None):
    """Flags any unclosed previous-day active check-in as INCOMPLETE_MANUAL_REVIEW."""
    today_iso = current_ist_date or get_ist_date_iso()
    now_ist = get_ist_timestamp()
    cur = conn.execute(
        """
        UPDATE attendance_records
        SET session_status = 'INCOMPLETE_MANUAL_REVIEW',
            remarks = CASE
                WHEN TRIM(COALESCE(remarks, '')) = '' THEN 'Incomplete / Manual Review Required'
                WHEN remarks NOT LIKE '%Incomplete / Manual Review Required%' THEN remarks || ' | Incomplete / Manual Review Required'
                ELSE remarks
            END,
            updated_at_ist = ?
        WHERE work_date < ?
          AND session_status = 'ACTIVE'
        """,
        (now_ist, today_iso)
    )
    return cur.rowcount


def atomic_check_in(payload, db_path=None):
    """Atomically creates a single ACTIVE check-in per (employee_id, work_date)."""
    emp_name = str(payload.get('employeeName') or payload.get('name') or '').strip().upper()
    emp_id = normalize_employee_id(payload.get('employeeId') or emp_name)
    if not emp_id or not emp_name:
        return 400, {'success': False, 'error': 'employeeName is required.'}

    raw_date = str(payload.get('workDate') or payload.get('reportDate') or '').strip()
    work_date = normalize_work_date_ist(raw_date) or get_ist_date_iso()
    display_date = raw_date or get_ist_now().strftime("%d/%m/%Y")
    check_in_time = str(payload.get('checkInTime') or payload.get('in') or '').strip() or get_ist_now().strftime("%H:%M")

    start_mins = parse_time_to_minutes(check_in_time, is_check_in=True)
    if start_mins is None:
        return 400, {'success': False, 'error': 'Invalid checkInTime format.'}

    expected_in = int(payload.get('expectedInMinutes') or 600)
    target_mins = int(payload.get('targetMinutes') or 570)
    is_late = 1 if start_mins > expected_in else 0
    now_ist = get_ist_timestamp()

    conn = get_db_connection(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        reconcile_stale_sessions(conn)
        conn.execute(
            """
            INSERT INTO attendance_records (
                employee_id, employee_name, work_date, display_date,
                check_in_time, check_out_time, session_status, target_minutes,
                is_late_in, remarks, created_at_ist, updated_at_ist
            ) VALUES (?, ?, ?, ?, ?, 'NOTPUNCHED', 'ACTIVE', ?, ?, ?, ?, ?)
            """,
            (emp_id, emp_name, work_date, display_date, check_in_time, target_mins, is_late, str(payload.get('remarks') or '').strip(), now_ist, now_ist)
        )
        conn.execute("COMMIT")
        return 201, {
            'success': True,
            'employeeId': emp_id,
            'workDate': work_date,
            'checkInTime': check_in_time,
            'sessionStatus': 'ACTIVE'
        }
    except sqlite3.IntegrityError:
        conn.execute("ROLLBACK")
        return 409, {
            'success': False,
            'error': f'Duplicate check-in blocked: {emp_name} already has a check-in session for {work_date}.'
        }
    except Exception as e:
        conn.execute("ROLLBACK")
        return 500, {'success': False, 'error': str(e)}
    finally:
        conn.close()


def atomic_check_out(payload, db_path=None):
    """Validates check_out_time > check_in_time and atomically completes the session."""
    emp_name = str(payload.get('employeeName') or payload.get('name') or '').strip().upper()
    emp_id = normalize_employee_id(payload.get('employeeId') or emp_name)
    raw_date = str(payload.get('workDate') or payload.get('reportDate') or '').strip()
    work_date = normalize_work_date_ist(raw_date) or get_ist_date_iso()
    check_out_time = str(payload.get('checkOutTime') or payload.get('finalOut') or '').strip() or get_ist_now().strftime("%I:%M %p")

    if not emp_id:
        return 400, {'success': False, 'error': 'employeeName or employeeId is required.'}

    conn = get_db_connection(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM attendance_records WHERE employee_id = ? AND work_date = ?",
            (emp_id, work_date)
        ).fetchone()
        if not row:
            conn.execute("ROLLBACK")
            return 404, {'success': False, 'error': f'No check-in session found for {emp_id} on {work_date}.'}

        rec_dict = dict(row)
        rec_dict['finalOut'] = check_out_time
        rec_dict['in'] = rec_dict['check_in_time']
        for k in ('out1', 'in1', 'out2', 'in2', 'out3', 'in3'):
            if k in payload:
                rec_dict[k] = payload[k]
        if 'remarks' in payload:
            rec_dict['remarks'] = payload['remarks']

        state = compute_record_state(
            rec_dict,
            work_date,
            target_minutes=int(payload.get('targetMinutes') or rec_dict['target_minutes'] or 570),
            grace_minutes=int(payload.get('graceMinutes') or 0),
            expected_in_minutes=int(payload.get('expectedInMinutes') or 600)
        )
        if state['error']:
            conn.execute("ROLLBACK")
            return 400, {'success': False, 'error': state['error']}

        now_ist = get_ist_timestamp()
        conn.execute(
            """
            UPDATE attendance_records
            SET check_out_time = ?, out1 = ?, in1 = ?, out2 = ?, in2 = ?, out3 = ?, in3 = ?,
                session_status = ?, net_work_minutes = ?, overtime_minutes = ?,
                shortfall_minutes = ?, is_half_day = ?, is_late_in = ?, remarks = ?, updated_at_ist = ?
            WHERE employee_id = ? AND work_date = ?
            """,
            (
                check_out_time,
                rec_dict.get('out1', ''), rec_dict.get('in1', ''),
                rec_dict.get('out2', ''), rec_dict.get('in2', ''),
                rec_dict.get('out3', ''), rec_dict.get('in3', ''),
                state['session_status'], state['net_work_minutes'], state['overtime_minutes'],
                state['shortfall_minutes'], state['is_half_day'], state['is_late_in'],
                state['remarks'], now_ist, emp_id, work_date
            )
        )
        conn.execute("COMMIT")
        return 200, {
            'success': True,
            'employeeId': emp_id,
            'workDate': work_date,
            'checkOutTime': check_out_time,
            **state
        }
    except Exception as e:
        conn.execute("ROLLBACK")
        return 500, {'success': False, 'error': str(e)}
    finally:
        conn.close()


def sync_daily_roster(payload, db_path=None):
    """Syncs a daily roster batch into SQLite atomically and reconciles prior-day unclosed sessions."""
    raw_date = str(payload.get('workDate') or payload.get('reportDate') or '').strip()
    work_date = normalize_work_date_ist(raw_date) or get_ist_date_iso()
    display_date = raw_date or get_ist_now().strftime("%d/%m/%Y")
    records = payload.get('records') or []
    target_mins = int(payload.get('targetMinutes') or 570)
    grace_mins = int(payload.get('graceMinutes') or 0)
    expected_in = int(payload.get('expectedInMinutes') or 600)
    now_ist = get_ist_timestamp()

    conn = get_db_connection(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        flagged_stale = reconcile_stale_sessions(conn)
        seen_ids = set()
        synced_count = 0

        for rec in records:
            emp_name = str(rec.get('name') or '').strip().upper()
            emp_id = normalize_employee_id(emp_name)
            if not emp_id or emp_id in seen_ids:
                continue
            seen_ids.add(emp_id)

            state = compute_record_state(rec, work_date, target_mins, grace_mins, expected_in)
            conn.execute(
                """
                INSERT INTO attendance_records (
                    employee_id, employee_name, work_date, display_date,
                    check_in_time, out1, in1, out2, in2, out3, in3, check_out_time,
                    session_status, target_minutes, net_work_minutes, overtime_minutes,
                    shortfall_minutes, is_half_day, is_late_in, remarks, created_at_ist, updated_at_ist
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(employee_id, work_date) DO UPDATE SET
                    employee_name = excluded.employee_name,
                    display_date = excluded.display_date,
                    check_in_time = excluded.check_in_time,
                    out1 = excluded.out1, in1 = excluded.in1,
                    out2 = excluded.out2, in2 = excluded.in2,
                    out3 = excluded.out3, in3 = excluded.in3,
                    check_out_time = excluded.check_out_time,
                    session_status = excluded.session_status,
                    target_minutes = excluded.target_minutes,
                    net_work_minutes = excluded.net_work_minutes,
                    overtime_minutes = excluded.overtime_minutes,
                    shortfall_minutes = excluded.shortfall_minutes,
                    is_half_day = excluded.is_half_day,
                    is_late_in = excluded.is_late_in,
                    remarks = excluded.remarks,
                    updated_at_ist = excluded.updated_at_ist
                """,
                (
                    emp_id, emp_name, work_date, display_date,
                    str(rec.get('in') or '').strip(),
                    str(rec.get('out1') or '').strip(), str(rec.get('in1') or '').strip(),
                    str(rec.get('out2') or '').strip(), str(rec.get('in2') or '').strip(),
                    str(rec.get('out3') or '').strip(), str(rec.get('in3') or '').strip(),
                    str(rec.get('finalOut') or '').strip(),
                    state['session_status'], int(rec.get('targetMinutes') or target_mins),
                    state['net_work_minutes'], state['overtime_minutes'], state['shortfall_minutes'],
                    state['is_half_day'], state['is_late_in'], state['remarks'], now_ist, now_ist
                )
            )
            synced_count += 1

        conn.execute("COMMIT")
        return 200, {
            'success': True,
            'workDate': work_date,
            'syncedCount': synced_count,
            'flaggedStalePreviousDays': flagged_stale
        }
    except Exception as e:
        conn.execute("ROLLBACK")
        return 500, {'success': False, 'error': str(e)}
    finally:
        conn.close()


def get_monthly_summary_from_db(month_filter=None, db_path=None):
    """Reconciles stale sessions and returns NaN/zero-safe monthly aggregation metrics."""
    conn = get_db_connection(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        reconcile_stale_sessions(conn)
        conn.execute("COMMIT")

        if month_filter:
            rows = conn.execute(
                "SELECT * FROM v_monthly_attendance_summary WHERE year_month = ? ORDER BY employee_name ASC",
                (month_filter.strip(),)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM v_monthly_attendance_summary ORDER BY year_month DESC, employee_name ASC"
            ).fetchall()

        summary = []
        for r in rows:
            item = dict(r)
            item['total_hours_worked'] = item.get('total_hours_worked') or 0.0
            item['total_overtime_hours'] = item.get('total_overtime_hours') or 0.0
            item['avg_daily_hours'] = item.get('avg_daily_hours') or 0.0
            summary.append(item)

        return 200, {'success': True, 'timezone': 'Asia/Kolkata', 'istDate': get_ist_date_iso(), 'summary': summary}
    except Exception as e:
        return 500, {'success': False, 'error': str(e)}
    finally:
        conn.close()


class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def _send_json(self, status_code, payload):
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else b'{}'

        if self.path in ('/api/attendance/check-in', '/api/attendance/check-out', '/api/attendance/sync'):
            try:
                data = json.loads(body.decode('utf-8'))
                if self.path == '/api/attendance/check-in':
                    code, res = atomic_check_in(data)
                elif self.path == '/api/attendance/check-out':
                    code, res = atomic_check_out(data)
                else:
                    code, res = sync_daily_roster(data)
                self._send_json(code, res)
            except Exception as e:
                self._send_json(500, {'success': False, 'error': str(e)})
            return

        if self.path == '/api/scan-document':
            try:
                data = json.loads(body.decode('utf-8'))
                image_base64 = data.get('image', '')
                mime_type = data.get('mimeType', 'image/png')
                client_api_key = (data.get('apiKey') or '').strip()
                master_directory = data.get('masterDirectory', [])
                model_mode = data.get('modelMode', 'flash')

                if ',' in image_base64:
                    header_part = image_base64.split(',', 1)[0]
                    image_base64 = image_base64.split(',', 1)[1]
                    mime_match = re.search(r'data:([^;]+)', header_part)
                    if mime_match:
                        mime_type = mime_match.group(1)

                print(f"[Gemini Vision] Scanning handwritten document ({len(image_base64)//1024} KB) | Mode: {model_mode}...")
                scan_result = scan_with_gemini_vision(
                    image_base64,
                    mime_type,
                    api_key=client_api_key,
                    master_directory=master_directory,
                    model_mode=model_mode
                )

                records = scan_result.get('records', [])
                report_date = scan_result.get('reportDate', '')

                print(f"[Gemini Vision] Extracted {len(records)} records | Date: {report_date}")

                self._send_json(200, {
                    'success': True,
                    'records': records,
                    'reportDate': report_date,
                    'count': len(records)
                })
                return

            except Exception as e:
                print(f"[Gemini Vision] Error: {e}")
                self._send_json(500, {
                    'success': False,
                    'error': str(e)
                })
                return

        self._send_json(404, {'error': 'Not Found'})

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        if parsed_url.path == '/api/attendance/monthly-summary':
            params = urllib.parse.parse_qs(parsed_url.query)
            month_filter = params.get('month', [None])[0]
            code, res = get_monthly_summary_from_db(month_filter)
            self._send_json(code, res)
            return

        if parsed_url.path == '/api/health':
            self._send_json(200, {
                'status': 'ok',
                'timezone': 'Asia/Kolkata',
                'ist_date': get_ist_date_iso(),
                'db_path': DB_PATH,
                'gemini_configured': bool(GEMINI_API_KEY),
                'directory': DIRECTORY
            })
            return
        super().do_GET()


def scan_with_gemini_vision(image_base64, mime_type='image/png', api_key=None, master_directory=None, model_mode='flash'):
    active_key = (api_key or '').strip() or GEMINI_API_KEY
    if not active_key:
        return {'records': [], 'reportDate': ''}

    if model_mode == 'pro':
        models = [
            'gemini-2.5-pro',
            'gemini-1.5-pro',
            'gemini-2.5-flash',
            'gemini-flash-latest',
            'gemini-flash-lite-latest'
        ]
    else:
        models = [
            'gemini-2.5-flash',
            'gemini-flash-latest',
            'gemini-2.5-flash-lite',
            'gemini-flash-lite-latest',
            'gemini-1.5-pro',
            'gemini-2.5-pro'
        ]

    master_roster_grounding = ""
    if master_directory and isinstance(master_directory, list) and len(master_directory) > 0:
        names_json = json.dumps(master_directory)
        master_roster_grounding = f"""

OFFICIAL MASTER STAFF ROSTER ({len(master_directory)} enrolled employees):
{names_json}
GROUNDING RULE FOR STAFF NAMES:
When reading cursive, hasty, or faint handwriting in Column 2 (NAME), strongly prioritize matching against this official master staff roster when visually plausible. Do not invent arbitrary names not present in the register."""

    prompt = f"""You are an expert OCR vision AI specializing in reading handwritten and printed daily staff attendance registers.

CRITICAL RULES & ANTI-HALLUCINATION INSTRUCTIONS:
1. Column 2 is labeled "NAME". Transcribe the staff name ONLY from Column 2.
   - DO NOT read names from the "IN/SIGN" or "OUT SIGN" signature columns!
   - NEVER hallucinate, guess, or invent staff names. Only output names that are clearly written in Column 2.
   - If a row has a serial number but no staff name is printed/written, SKIP that row completely!
   - Preserve single-letter initials (e.g. "KUMAR S", "BALAJI H", "DEVARAJ N T").
2. Multi-Page Support:
   - This image is part of an attendance register. Extract every valid staff row visible on this page.
3. Handwritten Notation & Idiosyncrasy Rules:
   - Time Notations: Convert handwritten decimal dots or dashes like "10.45", "10-45", "10=45" into standard time "10:45".
   - Ditto Marks: Marks like '"', ',,', or '-do-' in a time cell mean copy the exact time from the row directly above it.
   - Corrected/Overwritten Numbers: If a time was struck through with a line and rewritten, transcribe the final corrected time.
   - Absent Marks: If marked "A", "Ab", "Abs", "Absent", "L", "CL", "SL", "WO", "Off", output "AB" in the "in" column.
   - Half Day Marks: If marked "HD", "H.D", or "Half Day", record "Half day" in "remarks".
4. For each row:
   - "slNo": The integer serial number printed on this sheet (e.g. 1..20, 21..40, 41..60).
   - "name": Exact printed or written staff name in UPPERCASE from Column 2.
   - "in": Punch IN time (e.g. "10:45", "10:38", "11:12", "09:55", "11:24") or "AB" if absent.
   - "out1": 1st Out break time. Convert notations like "2-05", "2.05", "12-07" to afternoon format e.g. "02:05 PM", "12:07 PM", or "" if blank.
   - "in1": 1st In break time. Convert notations like "2-50", "12-40" to "02:50 PM", "12:40 PM", or "" if blank.
   - "out2": 2nd Out break time (e.g. "01:36 PM", "04:58 PM") or "" if blank.
   - "in2": 2nd In break time (e.g. "02:07 PM", "05:07 PM") or "" if blank.
   - "out3": 3rd Out break time or "" if blank.
   - "in3": 3rd In break time or "" if blank.
   - "finalOut": Final Out punch time with "PM" attached (e.g. "7:30" -> "07:30 PM", "8:12" -> "08:12 PM"). If absent, output "AB". If blank/left without punch, output "NOTPUNCHED".
   - "remarks": Any handwritten remark (e.g. "Half day", "Permission") or "".
5. Extract the date at the top of the register into "reportDate" (e.g. "03/09/2026 THURSDAY").{master_roster_grounding}

OUTPUT FORMAT:
Return pure JSON only matching this schema:
{{
  "reportDate": "03/09/2026 THURSDAY",
  "records": [
    {{
      "slNo": 1,
      "name": "ANANDAMMA",
      "in": "10:45",
      "out1": "02:05 PM",
      "in1": "02:50 PM",
      "out2": "",
      "in2": "",
      "out3": "",
      "in3": "",
      "finalOut": "07:30 PM",
      "remarks": ""
    }}
  ]
}}
Return raw JSON only, no backticks, no markdown.
"""

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": image_base64
                        }
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 16384,
            "responseMimeType": "application/json"
        }
    }

    for model in models:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={active_key}"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                res_data = json.loads(resp.read().decode('utf-8'))
                if 'candidates' not in res_data or len(res_data['candidates']) == 0:
                    continue

                candidate = res_data['candidates'][0]
                if 'content' not in candidate or 'parts' not in candidate['content']:
                    continue

                text = candidate['content']['parts'][0].get('text', '').strip()
                if not text:
                    continue

            if text.startswith('```'):
                text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
                text = re.sub(r'\n?```$', '', text).strip()

            parsed = None
            try:
                parsed = json.loads(text)
            except Exception:
                json_match = re.search(r'\{[\s\S]*\}', text)
                if json_match:
                    try:
                        parsed = json.loads(json_match.group(0))
                    except Exception:
                        pass

            if not parsed:
                print(f"[Gemini Vision] Warning: Could not parse JSON from {model}, trying fallback model...")
                continue

            raw_records = []
            report_date = ''
            if isinstance(parsed, list):
                raw_records = parsed
            elif isinstance(parsed, dict):
                report_date = parsed.get('reportDate') or parsed.get('report_date') or parsed.get('date') or ''
                for k in ['records', 'staff', 'employees', 'attendance', 'data', 'rows', 'entries']:
                    if isinstance(parsed.get(k), list):
                        raw_records = parsed[k]
                        break

            cleaned = []
            for idx, r in enumerate(raw_records):
                if isinstance(r, dict):
                    name = str(r.get('name') or r.get('Name') or r.get('staff_name') or r.get('employee_name') or '').strip().upper()
                    name = re.sub(r'^[\d\s\.\-\(\)]+', '', name).strip()
                    if len(name) < 2:
                        continue
                    in_time = str(r.get('in') if r.get('in') is not None else r.get('in_time') or r.get('punch_in') or '').strip()
                    final_out = str(r.get('finalOut') if r.get('finalOut') is not None else r.get('out') or r.get('out_time') or r.get('punch_out') or '').strip()
                    cleaned.append({
                        'slNo': int(r.get('slNo') or r.get('sl_no') or (idx + 1)),
                        'name': name,
                        'in': in_time,
                        'out1': str(r.get('out1') or r.get('out_1') or r.get('break1_out') or '').strip(),
                        'in1': str(r.get('in1') or r.get('in_1') or r.get('break1_in') or '').strip(),
                        'out2': str(r.get('out2') or r.get('out_2') or r.get('break2_out') or '').strip(),
                        'in2': str(r.get('in2') or r.get('in_2') or r.get('break2_in') or '').strip(),
                        'out3': str(r.get('out3') or r.get('out_3') or '').strip(),
                        'in3': str(r.get('in3') or r.get('in_3') or '').strip(),
                        'finalOut': final_out,
                        'remarks': str(r.get('remarks') or r.get('Remarks') or r.get('reason') or '').strip()
                    })

            if cleaned:
                return {'records': cleaned, 'reportDate': report_date}

        except urllib.error.HTTPError as e:
            print(f"[Gemini Vision] HTTP Error {e.code} with {model}: {e.reason}")
            if e.code == 429:
                import time
                time.sleep(3)
        except Exception as e:
            print(f"[Gemini Vision] Error with {model}: {e}")

    return {'records': [], 'reportDate': ''}

if __name__ == '__main__':
    os.chdir(DIRECTORY)
    init_db()
    socketserver.TCPServer.allow_reuse_address = True
    
    import socket
    local_ip = "localhost"
    hostname = socket.gethostname()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass

    try:
        with socketserver.TCPServer(("0.0.0.0", PORT), CustomHandler) as httpd:
            print(f"============================================================")
            print(f" Staff Attendance Tracking App Server Live!")
            print(f" Root Directory:      {DIRECTORY}")
            print(f" Local PC Access:     http://localhost:{PORT}")
            print(f" Network IP Access:   http://{local_ip}:{PORT}")
            print(f" Permanent Phone URL: http://{hostname}:{PORT}")
            print(f" iPhone / mDNS URL:   http://{hostname.lower()}.local:{PORT}")
            print(f"============================================================")
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                sys.exit(0)
    except OSError as e:
        print(f"")
        print(f"============================================================")
        print(f" ERROR: Could not start server on port {PORT}!")
        print(f" Reason: {e}")
        print(f"")
        print(f" Another application may be using port {PORT}.")
        print(f" Close that application first, or try a different port.")
        print(f"============================================================")
        input("Press Enter to exit...")
        sys.exit(1)
