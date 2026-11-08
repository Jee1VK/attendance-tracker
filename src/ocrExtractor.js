/**
 * Advanced Document & PDF OCR Extractor using Gemini Vision API
 * Dual-Mode Engine: Works with Backend Server OR Standalone Client-Side in Mobile Browser!
 */


export function getGeminiApiKey(autoShowModal = true) {
  let key = localStorage.getItem('gemini_api_key') || '';
  if (!key && autoShowModal && typeof document !== 'undefined') {
    const modal = document.getElementById('api-key-modal');
    if (modal) modal.style.display = 'flex';
  }
  return key.trim().replace(/^["']|["']$/g, '');
}

function computeLevenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = [];
  for (let i = 0; i <= m; i++) d[i] = [i];
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

export function fuzzyMatchMasterName(rawName, customDirectory = null) {
  let masterDir = customDirectory;
  if (!masterDir) {
    try {
      if (typeof localStorage !== 'undefined') {
        masterDir = JSON.parse(localStorage.getItem('attendance_master_directory') || '[]');
      }
    } catch (e) {
      masterDir = [];
    }
  }
  if (!Array.isArray(masterDir) || masterDir.length === 0) return rawName;

  const target = rawName.trim().toUpperCase();
  const normTarget = target.replace(/[\s\.\-\_\(\)]/g, '');
  if (!normTarget) return rawName;

  let bestMatch = rawName;
  let highestScore = 0;

  for (const officialName of masterDir) {
    const official = officialName.trim().toUpperCase();
    const normOfficial = official.replace(/[\s\.\-\_\(\)]/g, '');

    // 1. Exact match or normalized space/dot match (e.g. "DEVARAJ N T" vs "DEVARAJ NT")
    if (target === official || normTarget === normOfficial) {
      return officialName;
    }

    // 2. Substring containment match on normalized strings
    if (normOfficial.includes(normTarget) || normTarget.includes(normOfficial)) {
      const score = Math.min(normOfficial.length, normTarget.length) / Math.max(normOfficial.length, normTarget.length);
      if (score > highestScore && score >= 0.7) {
        highestScore = score;
        bestMatch = officialName;
      }
    }

    // 3. Levenshtein edit-distance similarity for minor OCR spelling variations (e.g. "ANANDAMA" vs "ANANDAMMA")
    const maxLen = Math.max(normTarget.length, normOfficial.length);
    if (maxLen >= 4) {
      const dist = computeLevenshtein(normTarget, normOfficial);
      const sim = (maxLen - dist) / maxLen;
      if (sim > highestScore && sim >= 0.75) {
        highestScore = sim;
        bestMatch = officialName;
      }
    }
  }

  return bestMatch;
}

export function deduplicateAndMergeRecords(records) {
  if (!Array.isArray(records)) return [];
  const map = new Map();

  records.forEach(r => {
    if (!r || typeof r !== 'object') return;
    let rawName = (r.name || '').trim().toUpperCase();
    if (!rawName || rawName.length < 2) return;

    rawName = fuzzyMatchMasterName(rawName);

    // Normalize comparison key: strip all spaces, dots, dashes, and parens
    // e.g. "DEVARAJ N T" and "DEVARAJ NT" both map to "DEVARAJNT"
    const normalizedKey = rawName.replace(/[\s\.\-\_\(\)]/g, '');

    if (!map.has(normalizedKey)) {
      map.set(normalizedKey, { ...r, name: rawName });
    } else {
      const existing = map.get(normalizedKey);
      // Prefer cleaner / canonical name representation
      const bestName = (existing.name && existing.name.includes(' ') && !rawName.includes(' ')) ? existing.name : rawName;
      map.set(normalizedKey, {
        slNo: existing.slNo || r.slNo,
        name: bestName,
        in: (existing.in && existing.in !== 'AB' && existing.in !== '-') ? existing.in : r.in,
        out1: existing.out1 || r.out1,
        in1: existing.in1 || r.in1,
        out2: existing.out2 || r.out2,
        in2: existing.in2 || r.in2,
        out3: existing.out3 || r.out3,
        in3: existing.in3 || r.in3,
        finalOut: (existing.finalOut && existing.finalOut !== 'AB' && existing.finalOut !== 'NOTPUNCHED' && existing.finalOut !== '-') ? existing.finalOut : r.finalOut,
        targetMinutes: existing.targetMinutes !== undefined && existing.targetMinutes !== null ? existing.targetMinutes : (r.targetMinutes !== undefined ? r.targetMinutes : null),
        remarks: existing.remarks || r.remarks || ''
      });
    }
  });

  const uniqueList = Array.from(map.values());
  uniqueList.forEach((r, i) => { r.slNo = i + 1; });
  return uniqueList;
}

export function resizeCanvasIfNeeded(sourceCanvas, maxDimension = 1800) {
  let width = sourceCanvas.width;
  let height = sourceCanvas.height;

  if (width <= maxDimension && height <= maxDimension) {
    return sourceCanvas;
  }

  if (width > height) {
    height = Math.round((height * maxDimension) / width);
    width = maxDimension;
  } else {
    width = Math.round((width * maxDimension) / height);
    height = maxDimension;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, width, height);
  return canvas;
}

/**
 * Fast client-side document scanner enhancement filter.
 * Dynamically stretches luminance range, suppresses paper background shadows/yellowing,
 * and deepens handwritten pen/pencil strokes.
 */
export function enhanceDocumentContrast(sourceCanvas) {
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0);

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const len = data.length;

  // Step 1: Sample histogram to find min and max luminance percentiles
  const step = Math.max(1, Math.floor(len / 40000)) * 4;
  let minLum = 255;
  let maxLum = 0;

  for (let i = 0; i < len; i += step) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }

  // Ensure reasonable dynamic range
  if (maxLum - minLum < 30) {
    minLum = Math.max(0, minLum - 20);
    maxLum = Math.min(255, maxLum + 20);
  }

  const range = (maxLum - minLum) || 1;

  // Step 2: Auto-levels + gamma curve to push paper background to clean white and deepen ink strokes
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let norm = (i - minLum) / range;
    norm = Math.min(1, Math.max(0, norm));
    // Apply contrast curve (gamma 1.25) to deepen handwriting ink
    const curved = Math.pow(norm, 1.25);
    lut[i] = Math.round(curved * 255);
  }

  for (let i = 0; i < len; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

export function loadImageFileToCanvas(file, maxDimension = 1800) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("No file selected."));
    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const cvs = document.createElement('canvas');
        cvs.width = width;
        cvs.height = height;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(cvs);
      };
      img.onerror = () => {
        reject(new Error(`Failed to decode image "${file.name || 'photo'}". Please ensure it is a valid JPEG, PNG, or WebP file.`));
      };
      img.src = evt.target.result;
    };
    reader.onerror = () => {
      reject(new Error(`Failed to read file "${file.name || 'photo'}".`));
    };
    reader.readAsDataURL(file);
  });
}

export async function renderPdfToCanvas(pdfArrayBuffer, pageNum = 1) {
  if (!window.pdfjsLib) {
    throw new Error("PDF.js library is loading. Please try again.");
  }

  const bufferCopy = pdfArrayBuffer.slice(0);
  const dataCopy = new Uint8Array(bufferCopy);

  const loadingTask = window.pdfjsLib.getDocument({ data: dataCopy });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNum);

  const scale = 2.0;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({
    canvasContext: context,
    viewport: viewport
  }).promise;

  return {
    canvas,
    totalPages: pdf.numPages
  };
}

export function rotateCanvas(sourceCanvas, degrees) {
  if (degrees === 0) return sourceCanvas;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const rad = (degrees * Math.PI) / 180;
  const is90or270 = Math.abs(degrees % 180) === 90;

  canvas.width = is90or270 ? sourceCanvas.height : sourceCanvas.width;
  canvas.height = is90or270 ? sourceCanvas.width : sourceCanvas.height;

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);

  return canvas;
}

export function parseJsonResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let cleanText = rawText.trim();
  if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  }

  // 1. Direct JSON parse
  try {
    const direct = JSON.parse(cleanText);
    if (direct) return direct;
  } catch (e) {}

  // 2. Match outermost JSON object { ... }
  const objMatch = cleanText.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed) return parsed;
    } catch (e) {}
  }

  // 3. Match outermost JSON array [ ... ]
  const arrMatch = cleanText.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (parsed) return parsed;
    } catch (e) {}
  }

  return null;
}

export function normalizeExtractedRecords(parsedData) {
  let rawList = [];
  let reportDate = '';

  if (Array.isArray(parsedData)) {
    rawList = parsedData;
  } else if (parsedData && typeof parsedData === 'object') {
    reportDate = parsedData.reportDate || parsedData.report_date || parsedData.date || parsedData.Date || '';

    // Check all common array keys returned by AI models
    const candidates = [
      parsedData.records,
      parsedData.staff,
      parsedData.employees,
      parsedData.attendance,
      parsedData.data,
      parsedData.rows,
      parsedData.entries,
      parsedData.staff_records,
      parsedData.attendance_records,
      parsedData.items
    ];

    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) {
        rawList = c;
        break;
      }
    }

    // Fallback: search for any array of objects inside the response
    if (rawList.length === 0) {
      for (const val of Object.values(parsedData)) {
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
          rawList = val;
          break;
        }
      }
    }
  }

  const normalized = [];
  rawList.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;

    // Resolve name from any common naming convention
    const rawName = item.name || item.Name || item.NAME ||
                    item.staff_name || item.staffName || item.StaffName || item.STAFF_NAME ||
                    item.employee_name || item.employeeName || item.EmployeeName || item.EMPLOYEE_NAME ||
                    item.employee || item.Employee || item.EMPLOYEE ||
                    item.staff || item.Staff || item.STAFF ||
                    item.person || item.person_name || '';

    let cleanName = String(rawName).trim().toUpperCase();
    cleanName = cleanName.replace(/^[\d\s\.\-\(\)]+/, '').trim();
    if (!cleanName || cleanName.length < 2) return;

    // Resolve punch IN time
    const inTime = item.in !== undefined ? item.in :
                   item.In !== undefined ? item.In :
                   item.IN !== undefined ? item.IN :
                   item.in_time || item.inTime || item.InTime || item.IN_TIME ||
                   item.punch_in || item.punchIn || item.PunchIn || item.PUNCH_IN ||
                   item.check_in || item.checkIn || item.arrival || '';

    // Resolve punch OUT time
    const outTime = item.finalOut !== undefined ? item.finalOut :
                    item.final_out !== undefined ? item.final_out :
                    item.FinalOut !== undefined ? item.FinalOut :
                    item.FINAL_OUT !== undefined ? item.FINAL_OUT :
                    item.out !== undefined ? item.out :
                    item.Out !== undefined ? item.Out :
                    item.OUT !== undefined ? item.OUT :
                    item.out_time || item.outTime || item.OutTime || item.OUT_TIME ||
                    item.punch_out || item.punchOut || item.PunchOut || item.PUNCH_OUT ||
                    item.check_out || item.checkOut || item.departure || '';

    // Resolve break times
    const out1 = item.out1 || item.out_1 || item.Out1 || item.break1_out || item.break_out_1 || item.lunch_out || '';
    const in1 = item.in1 || item.in_1 || item.In1 || item.break1_in || item.break_in_1 || item.lunch_in || '';
    const out2 = item.out2 || item.out_2 || item.Out2 || item.break2_out || item.break_out_2 || item.tea_out || '';
    const in2 = item.in2 || item.in_2 || item.In2 || item.break2_in || item.break_in_2 || item.tea_in || '';
    const out3 = item.out3 || item.out_3 || item.Out3 || item.break3_out || item.break_out_3 || '';
    const in3 = item.in3 || item.in_3 || item.In3 || item.break3_in || item.break_in_3 || '';

    const slNo = parseInt(item.slNo || item.sl_no || item.SlNo || item.SL_NO || item.id || item.s_no || (idx + 1), 10) || (idx + 1);

    normalized.push({
      slNo,
      name: cleanName,
      in: String(inTime).trim(),
      out1: String(out1).trim(),
      in1: String(in1).trim(),
      out2: String(out2).trim(),
      in2: String(in2).trim(),
      out3: String(out3).trim(),
      in3: String(in3).trim(),
      finalOut: String(outTime).trim(),
      remarks: item.remarks || item.Remarks || item.reason || ''
    });
  });

  return { records: normalized, reportDate: String(reportDate).trim() };
}

/**
 * Direct Client-Side Gemini Vision Scan — Speed-Optimized for Mobile!
 */
export async function directGeminiVisionScan(base64Image) {
  let apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Gemini API Key is required to scan your handwritten documents. Please click the 'AI Key' button at the top to enter your free key from https://aistudio.google.com/app/apikey");
  }

  apiKey = apiKey.trim().replace(/^["']|["']$/g, '');
  const cleanBase64 = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image;

  // Retrieve Master Staff Directory names to ground the vision AI
  let masterRosterGrounding = '';
  try {
    if (typeof localStorage !== 'undefined') {
      const masterDir = JSON.parse(localStorage.getItem('attendance_master_directory') || '[]');
      if (Array.isArray(masterDir) && masterDir.length > 0) {
        masterRosterGrounding = `\n\nOFFICIAL MASTER STAFF ROSTER (${masterDir.length} enrolled employees):
${JSON.stringify(masterDir)}
GROUNDING RULE FOR STAFF NAMES:
When transcribing cursive, hasty, or faint handwriting in Column 2 (NAME), strongly prioritize matching against this official master staff roster when visually plausible. Do not invent arbitrary names not present in the register.`;
      }
    }
  } catch (e) {}
  
  const prompt = `You are an expert OCR vision AI specializing in reading handwritten and printed daily staff attendance registers.

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
5. Extract the date at the top of the register into "reportDate" (e.g. "03/09/2026 THURSDAY").${masterRosterGrounding}

OUTPUT FORMAT:
Return pure JSON only in this format:
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
Return pure JSON only, without markdown code blocks, backticks, or any additional text.`;

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: "image/jpeg", data: cleanBase64 } }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 16384,
      responseMimeType: "application/json"
    }
  };

  const modelMode = (typeof localStorage !== 'undefined' ? localStorage.getItem('gemini_model_mode') : '') || 'flash';

  let models;
  if (modelMode === 'pro') {
    models = [
      'gemini-2.5-pro',
      'gemini-1.5-pro',
      'gemini-2.5-flash',
      'gemini-flash-latest',
      'gemini-flash-lite-latest'
    ];
  } else {
    models = [
      'gemini-2.5-flash',
      'gemini-flash-latest',
      'gemini-2.5-flash-lite',
      'gemini-flash-lite-latest',
      'gemini-1.5-pro',
      'gemini-2.5-pro'
    ];
  }
  let lastError = null;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({}));
        const errMsg = errorData?.error?.message || `HTTP ${resp.status}`;
        
        if (resp.status === 403 || (resp.status === 400 && errMsg.toLowerCase().includes('api_key'))) {
          localStorage.removeItem('gemini_api_key');
          throw new Error(`Invalid Gemini API Key: ${errMsg}. Please click 'AI Key' at the top to re-enter your key.`);
        }

        // Auto-pause for rate limits (429) or temporary server errors (500/503)
        if (resp.status === 429 || resp.status >= 500) {
          console.warn(`Model ${model} hit ${resp.status}, pausing 3.5s before fallback...`);
          await new Promise(r => setTimeout(r, 3500));
        }

        throw new Error(`Gemini Vision API (${model}) error: ${errMsg}`);
      }

      const data = await resp.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      
      const parsed = parseJsonResponse(rawText);
      if (parsed) {
        const normalized = normalizeExtractedRecords(parsed);
        if (normalized.records.length > 0) {
          return normalized;
        }
      }
    } catch (err) {
      if (err.message && err.message.includes('API Key')) throw err;
      if (err.name === 'AbortError') {
        lastError = new Error("Request timed out. Please check your mobile internet connection.");
      } else if (err.message && err.message.includes('Failed to fetch')) {
        lastError = new Error("Network connection error (Failed to fetch). Please check your internet connection or verify your API key.");
      } else {
        lastError = err;
      }
      console.warn(`Vision model ${model} failed, trying next...`, err);
    }
  }

  if (lastError) throw lastError;
  return { records: [], reportDate: '' };
}

/**
 * Sends canvas image to backend Gemini Vision API or direct client-side vision fallback.
 */
export async function processCanvasOCR(canvas, progressCallback) {
  progressCallback && progressCallback(10, "Optimizing high-resolution document image...");

  const resized = resizeCanvasIfNeeded(canvas, 1800);
  const dataUrl = resized.toDataURL('image/jpeg', 0.88);

  progressCallback && progressCallback(25, "Scanning handwriting with Gemini AI Vision (5-7s)...");

  let scanError = null;
  const clientKey = getGeminiApiKey(false);

  // 1. Try backend proxy server if available (e.g. running on local server, LAN IP, or port 8000)
  const isLikelyBackendHost = typeof window !== 'undefined' && (
    window.location.port === '8000' ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    /^192\.168\./.test(window.location.hostname) ||
    /^10\./.test(window.location.hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(window.location.hostname) ||
    window.location.hostname.endsWith('.local')
  );

  if (isLikelyBackendHost) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);
      const masterDirList = (function() {
        try { return JSON.parse(localStorage.getItem('attendance_master_directory') || '[]'); } catch(e) { return []; }
      })();
      const activeModelMode = (function() {
        try { return localStorage.getItem('gemini_model_mode') || 'flash'; } catch(e) { return 'flash'; }
      })();

      const response = await fetch('/api/scan-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: dataUrl,
          mimeType: 'image/jpeg',
          apiKey: clientKey,
          masterDirectory: masterDirList,
          modelMode: activeModelMode
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const res = await response.json();
        if (res.success && res.records && res.records.length > 0) {
          progressCallback && progressCallback(100, `Gemini extracted ${res.records.length} staff records!`);
          const uniqueRecords = deduplicateAndMergeRecords(res.records);
          return { records: uniqueRecords, reportDate: res.reportDate || '' };
        }
      }
    } catch (err) {
      console.warn("Backend server unreached, using direct client-side Gemini Vision...", err);
    }
  }

  // 2. Direct Client-Side Gemini Vision Scan
  try {
    progressCallback && progressCallback(45, "Extracting real handwritten names with Gemini 2.0 Flash...");
    const directRes = await directGeminiVisionScan(dataUrl);
    if (directRes && directRes.records && directRes.records.length > 0) {
      progressCallback && progressCallback(100, `Extracted ${directRes.records.length} handwritten staff names from document!`);
      const uniqueRecords = deduplicateAndMergeRecords(directRes.records);
      return { records: uniqueRecords, reportDate: directRes.reportDate || '' };
    }
  } catch (err) {
    scanError = err;
    console.error("Direct Gemini scan error:", err);
  }

  if (scanError) {
    throw scanError;
  }

  throw new Error("No staff names could be detected in this image. Please ensure the document is clear, well-lit, and upright.");
}

/**
 * Scans ALL pages of a multi-page PDF through Gemini Vision with safe ArrayBuffer cloning & deduplication.
 */
export async function processAllPdfPages(pdfArrayBuffer, rotation, progressCallback) {
  if (!window.pdfjsLib) {
    throw new Error("PDF.js library is loading. Please try again.");
  }

  const bufferCopy = pdfArrayBuffer.slice(0);
  const dataCopy = new Uint8Array(bufferCopy);

  const loadingTask = window.pdfjsLib.getDocument({ data: dataCopy });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;

  let rawRecords = [];
  let detectedDate = '';
  const clientKey = getGeminiApiKey(false);

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    if (pageNum > 1) {
      progressCallback && progressCallback(
        Math.round((pageNum - 1) / totalPages * 80) + 10,
        `[Page ${pageNum}/${totalPages}] Pacing request (2s)...`
      );
      await new Promise(r => setTimeout(r, 2000));
    }

    progressCallback && progressCallback(
      Math.round((pageNum - 1) / totalPages * 80) + 10,
      `Scanning page ${pageNum} of ${totalPages} with Gemini AI Vision...`
    );

    const page = await pdf.getPage(pageNum);
    const scale = 2.0;
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise;

    const rotatedCvs = rotateCanvas(canvas, rotation);
    const resizedCvs = resizeCanvasIfNeeded(rotatedCvs, 1800);
    const dataUrl = resizedCvs.toDataURL('image/jpeg', 0.88);

    let pageScanned = false;

    try {
      const pdfProxyCtrl = new AbortController();
      const pdfProxyTimeout = setTimeout(() => pdfProxyCtrl.abort(), 90000);
      const masterDirList = (function() {
        try { return JSON.parse(localStorage.getItem('attendance_master_directory') || '[]'); } catch(e) { return []; }
      })();
      const activeModelMode = (function() {
        try { return localStorage.getItem('gemini_model_mode') || 'flash'; } catch(e) { return 'flash'; }
      })();

      const response = await fetch('/api/scan-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: dataUrl,
          mimeType: 'image/jpeg',
          apiKey: clientKey,
          masterDirectory: masterDirList,
          modelMode: activeModelMode
        }),
        signal: pdfProxyCtrl.signal
      });
      clearTimeout(pdfProxyTimeout);

      if (response.ok) {
        const res = await response.json();
        if (res.success && res.records && res.records.length > 0) {
          rawRecords = rawRecords.concat(res.records);
          if (res.reportDate && !detectedDate) detectedDate = res.reportDate;
          pageScanned = true;
        }
      }
    } catch (err) {
      console.warn(`Backend unreached for page ${pageNum}, attempting direct client scan...`, err);
    }

    if (!pageScanned) {
      try {
        const directRes = await directGeminiVisionScan(dataUrl);
        if (directRes && directRes.records) {
          rawRecords = rawRecords.concat(directRes.records);
          if (directRes.reportDate && !detectedDate) detectedDate = directRes.reportDate;
        }
      } catch (e) {
        console.error(`Page ${pageNum} direct scan error:`, e);
      }
    }

    // Free canvas memory to prevent mobile memory spikes on large PDFs
    canvas.width = 0; canvas.height = 0;
    if (rotatedCvs !== canvas) { rotatedCvs.width = 0; rotatedCvs.height = 0; }
    if (resizedCvs !== rotatedCvs) { resizedCvs.width = 0; resizedCvs.height = 0; }
  }

  if (rawRecords.length === 0) {
    throw new Error("No staff records could be extracted from the PDF. Please ensure your Gemini API Key is entered (click 'AI Key' at the top) and the PDF pages are clear.");
  }

  const finalRecords = deduplicateAndMergeRecords(rawRecords);

  progressCallback && progressCallback(100, `Extracted ${finalRecords.length} unique records!`);
  return { records: finalRecords, reportDate: detectedDate };
}
