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

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

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

                if ',' in image_base64:
                    header_part = image_base64.split(',', 1)[0]
                    image_base64 = image_base64.split(',', 1)[1]
                    mime_match = re.search(r'data:([^;]+)', header_part)
                    if mime_match:
                        mime_type = mime_match.group(1)

                print(f"[Gemini Vision] Scanning handwritten document ({len(image_base64)//1024} KB)...")
                scan_result = scan_with_gemini_vision(image_base64, mime_type)

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


def scan_with_gemini_vision(image_base64, mime_type='image/png'):
    if not GEMINI_API_KEY:
        return {'records': [], 'reportDate': ''}

    models = [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-2.0-flash-exp',
        'gemini-1.5-flash',
        'gemini-1.5-pro'
    ]

    prompt = """You are an expert OCR vision AI specializing in reading and transcribing handwritten daily staff attendance register tables.

CRITICAL INSTRUCTIONS:
1. Scan the attendance register image row by row from top to bottom.
2. Look at the "NAME" or "EMPLOYEE NAME" column (usually column 2).
3. For every person / row:
   - Carefully read and transcribe the EXACT REAL HANDWRITTEN NAME written in that row in UPPERCASE (e.g. "ANANDAMMA", "KUMAR", "RAMESH", "GEETHA", etc.).
   - DO NOT output generic placeholders like "STAFF MEMBER" or "PERSON" - read the actual handwriting written in the image!
   - Extract the Serial Number ("slNo").
   - Extract Punch IN time ("in") - e.g. "10:01", "09:55", "10:44", "11:20", or "AB" if absent.
   - Extract Break OUT/IN times ("out1", "in1", "out2", "in2", "out3", "in3") - e.g. "02:00:00 PM", "02:50:00 PM", or "" if empty.
   - Extract Final Punch OUT time ("finalOut") - e.g. "07:30:00 PM", "09:30:00 PM", "NOTPUNCHED", or "AB".
4. Extract the register header date into "reportDate" (e.g. "31/07/2026 FRIDAY" or whatever date is written at the top).

OUTPUT FORMAT:
Return ONLY a valid JSON object matching this schema:
{
  "reportDate": "31/07/2026 FRIDAY",
  "records": [
    {
      "slNo": 1,
      "name": "REAL_NAME_FROM_IMAGE",
      "in": "10:01",
      "out1": "02:00:00 PM",
      "in1": "02:50:00 PM",
      "out2": "",
      "in2": "",
      "out3": "",
      "in3": "",
      "finalOut": "07:30:00 PM"
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
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}"
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
        print(f"[Gemini Vision] Error: {e}")

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
