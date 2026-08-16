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

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}"

    prompt = """You are an expert at reading handwritten daily staff attendance registers.

Carefully examine this handwritten attendance register image and extract:
1. "reportDate": The register date written at the top header (e.g. "31/07/2026 FRIDAY" or similar date text). If not found, put "".
2. "records": A JSON array of all staff attendance entries in the register.

For each staff entry:
- slNo: Integer serial number
- name: Full staff name (uppercase)
- in: Punch IN time (e.g. "10:01", "10:44", or "AB")
- out1: 1st break OUT time (e.g. "02:00:00 PM"). Leave "" if none.
- in1: 1st break IN time. Leave "" if none.
- out2: 2nd break OUT time. Leave "" if none.
- in2: 2nd break IN time. Leave "" if none.
- out3: 3rd break OUT time. Leave "" if none.
- in3: 3rd break IN time. Leave "" if none.
- finalOut: Punch OUT time (e.g. "07:30:00 PM", "NOTPUNCHED", or "AB").

CRITICAL: Return ONLY a valid JSON object matching this schema:
{
  "reportDate": "31/07/2026 FRIDAY",
  "records": [
    {"slNo":1,"name":"STAFF MEMBER","in":"10:01","out1":"02:00:00 PM","in1":"02:50:00 PM","out2":"","in2":"","out3":"","in3":"","finalOut":"07:30:00 PM"}
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
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": image_base64
                        }
                    }
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 8192
        }
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            res_data = json.loads(resp.read().decode('utf-8'))
            if 'candidates' not in res_data or len(res_data['candidates']) == 0:
                return {'records': [], 'reportDate': ''}

            candidate = res_data['candidates'][0]
            if 'content' not in candidate or 'parts' not in candidate['content']:
                return {'records': [], 'reportDate': ''}

            text = candidate['content']['parts'][0].get('text', '').strip()

            if text.startswith('```'):
                text = re.sub(r'^```[a-zA-Z]*\n?', '', text)
                text = re.sub(r'\n?```$', '', text).strip()

            json_match = re.search(r'\{[\s\S]*\}', text)
            if json_match:
                parsed = json.loads(json_match.group(0))
                records = parsed.get('records', [])
                report_date = parsed.get('reportDate', '')

                cleaned = []
                for r in records:
                    if isinstance(r, dict) and 'name' in r:
                        cleaned.append({
                            'slNo': r.get('slNo', len(cleaned) + 1),
                            'name': str(r.get('name', '')).strip().upper(),
                            'in': str(r.get('in', '')).strip(),
                            'out1': str(r.get('out1', '')).strip(),
                            'in1': str(r.get('in1', '')).strip(),
                            'out2': str(r.get('out2', '')).strip(),
                            'in2': str(r.get('in2', '')).strip(),
                            'out3': str(r.get('out3', '')).strip(),
                            'in3': str(r.get('in3', '')).strip(),
                            'finalOut': str(r.get('finalOut', '')).strip()
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
            print(f" Attendance Tracker Server Live!")
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
