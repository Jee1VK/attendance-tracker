import http.server
import socketserver
import os
import sys
import json
import re
import urllib.request

PORT = 8000

# Fix PyInstaller frozen directory resolution
if getattr(sys, 'frozen', False):
    # Running as standalone compiled executable (PyInstaller)
    DIRECTORY = os.path.dirname(os.path.abspath(sys.executable))
else:
    # Running as Python script
    DIRECTORY = os.path.dirname(os.path.abspath(__file__))

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
if not GEMINI_API_KEY:
    key_file = os.path.join(DIRECTORY, "gemini_key.txt")
    if os.path.exists(key_file):
        try:
            with open(key_file, "r", encoding="utf-8") as kf:
                GEMINI_API_KEY = kf.read().strip()
        except Exception:
            pass

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        if self.path == '/api/scan-document':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            try:
                data = json.loads(body.decode('utf-8'))
                image_base64 = data.get('image', '')
                mime_type = data.get('mimeType', 'image/png')
                client_api_key = (data.get('apiKey') or '').strip()

                if ',' in image_base64:
                    header_part = image_base64.split(',', 1)[0]
                    image_base64 = image_base64.split(',', 1)[1]
                    mime_match = re.search(r'data:([^;]+)', header_part)
                    if mime_match:
                        mime_type = mime_match.group(1)

                print(f"[Gemini Vision] Scanning handwritten document ({len(image_base64)//1024} KB)...")
                scan_result = scan_with_gemini_vision(image_base64, mime_type, api_key=client_api_key)

                records = scan_result.get('records', [])
                report_date = scan_result.get('reportDate', '')

                print(f"[Gemini Vision] Extracted {len(records)} records | Date: {report_date}")

                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'success': True,
                    'records': records,
                    'reportDate': report_date,
                    'count': len(records)
                }).encode('utf-8'))
                return

            except Exception as e:
                print(f"[Gemini Vision] Error: {e}")
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'success': False,
                    'error': str(e)
                }).encode('utf-8'))
                return

        self.send_response(404)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': 'Not Found'}).encode('utf-8'))

    def do_GET(self):
        if self.path == '/api/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'ok',
                'gemini_configured': bool(GEMINI_API_KEY),
                'directory': DIRECTORY
            }).encode('utf-8'))
            return
        super().do_GET()


def scan_with_gemini_vision(image_base64, mime_type='image/png', api_key=None):
    active_key = (api_key or '').strip() or GEMINI_API_KEY
    if not active_key:
        return {'records': [], 'reportDate': ''}

    models = [
        'gemini-flash-lite-latest',
        'gemini-flash-latest',
        'gemini-3.5-flash-lite',
        'gemini-3.5-flash'
    ]

    prompt = """You are an expert OCR vision AI specializing in reading handwritten and printed daily staff attendance registers.

CRITICAL RULES & ANTI-HALLUCINATION INSTRUCTIONS:
1. Column 2 is labeled "NAME". Transcribe the staff name ONLY from Column 2.
   - DO NOT read names from the "IN/SIGN" or "OUT SIGN" signature columns!
   - NEVER hallucinate, guess, or invent staff names (e.g. do NOT invent CHANDRA, DEEPA, GIRISH, KAVYA, KUMAR, LAKSHMI, MOHAN, NAGARAJ, POOJA)! Only output names that are clearly written in Column 2.
   - If a row has a serial number but no staff name is printed/written, SKIP that row completely!
2. Multi-Page Support:
   - This image is part of an attendance register. It may contain:
     * Page 1 (Sl No 1 to 20)
     * Page 2 (Sl No 21 to 40)
     * Page 3 (Sl No 41 to 60)
   - Extract every valid staff row visible on this page.
3. For each row:
   - "slNo": The integer serial number printed on this sheet (e.g. 1..20, 21..40, 41..60).
   - "name": Exact printed or written staff name in UPPERCASE from Column 2 (e.g. "ANANDAMMA", "ARUNKUMAR J", "B M SUHAS", "BABY G", "BALAJI H", "RAVI M", "RAVISH P M", "RAJESHWARI S", "SHOBHA", "SHRUTHI C", "SRIDHAR S", "SRIKANTA DATTA", "SRINIVAS D A", "SUSHMITHA", "SURESH C", "VEENA K S", "VARADHA RAJAN", "VENKATESH BABU", etc.).
   - "in": Punch IN time (e.g. "10:45", "10:38", "11:12", "09:55", "11:24", "10:29", "12:30", "11:20") or "AB" if marked Ab/Absent.
   - "out1": 1st Out break time. Convert notations like "2-05", "2.05", "2=05", "12-07" to afternoon format e.g. "02:05 PM", "12:07 PM", or "" if blank.
   - "in1": 1st In break time. Convert notations like "2-50", "12-40" to "02:50 PM", "12:40 PM", or "" if blank.
   - "out2": 2nd Out break time (e.g. "01:36 PM", "04:58 PM", "03:00 PM") or "" if blank.
   - "in2": 2nd In break time (e.g. "02:07 PM", "05:07 PM", "03:34 PM") or "" if blank.
   - "out3": 3rd Out break time (e.g. "04:58 PM", "05:43 PM") or "" if blank.
   - "in3": 3rd In break time (e.g. "05:07 PM", "06:18 PM") or "" if blank.
   - "finalOut": Final Out punch time. IMPORTANT: Evening punch out times MUST have "PM" attached (e.g. "7:30" -> "07:30 PM", "8:12" -> "08:12 PM", "8:31" -> "08:31 PM", "9:30" -> "09:30 PM", "8:28" -> "08:28 PM"). If absent, output "AB". If blank/left without punch, output "NOTPUNCHED".
   - "remarks": If marked "Half day" or any special remark in handwriting, include it in "remarks" (e.g. "Half day").
4. Extract the date at the top of the register into "reportDate" (e.g. "03/09/2026 THURSDAY").

OUTPUT FORMAT:
Return pure JSON only matching this schema:
{
  "reportDate": "03/09/2026 THURSDAY",
  "records": [
    {
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
    }
  ]
}
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
            "maxOutputTokens": 8192,
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
                return {'records': [], 'reportDate': ''}

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
                        'finalOut': final_out
                    })

            return {'records': cleaned, 'reportDate': report_date}

        except Exception as e:
            print(f"[Gemini Vision] Error with {model}: {e}")

    return {'records': [], 'reportDate': ''}

if __name__ == '__main__':
    os.chdir(DIRECTORY)
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
