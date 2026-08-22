/**
 * Advanced Document & PDF OCR Extractor using Gemini Vision API
 * Dual-Mode Engine: Works with Backend Server OR Standalone Client-Side in Mobile Browser!
 */


export function getGeminiApiKey() {
  let key = localStorage.getItem('gemini_api_key') || '';
  if (!key) {
    key = prompt("🔑 Enter your free Gemini API Key for direct client-side scanning:\n\n(Get one free at https://aistudio.google.com/app/apikey)") || '';
    if (key) {
      localStorage.setItem('gemini_api_key', key.trim());
    }
  }
  return key.trim();
}

export function fuzzyMatchMasterName(rawName) {
  let masterDir = [];
  try {
    masterDir = JSON.parse(localStorage.getItem('attendance_master_directory') || '[]');
  } catch (e) {
    masterDir = [];
  }
  if (!Array.isArray(masterDir) || masterDir.length === 0) return rawName;

  const target = rawName.trim().toUpperCase();
  let bestMatch = target;
  let highestScore = 0;

  masterDir.forEach(officialName => {
    const official = officialName.trim().toUpperCase();
    if (official === target) {
      bestMatch = official;
      highestScore = 1.0;
      return;
    }

    if (official.includes(target) || target.includes(official)) {
      const score = Math.min(official.length, target.length) / Math.max(official.length, target.length);
      if (score > highestScore && score >= 0.7) {
        highestScore = score;
        bestMatch = official;
      }
    }
  });

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

    if (!map.has(rawName)) {
      map.set(rawName, { ...r, name: rawName });
    } else {
      const existing = map.get(rawName);
      map.set(rawName, {
        slNo: existing.slNo,
        name: rawName,
        in: (existing.in && existing.in !== 'AB' && existing.in !== '-') ? existing.in : r.in,
        out1: existing.out1 || r.out1,
        in1: existing.in1 || r.in1,
        out2: existing.out2 || r.out2,
        in2: existing.in2 || r.in2,
        out3: existing.out3 || r.out3,
        in3: existing.in3 || r.in3,
        finalOut: (existing.finalOut && existing.finalOut !== 'AB' && existing.finalOut !== 'NOTPUNCHED' && existing.finalOut !== '-') ? existing.finalOut : r.finalOut
      });
    }
  });

  const uniqueList = Array.from(map.values());
  uniqueList.forEach((r, i) => { r.slNo = i + 1; });
  return uniqueList;
}

export function resizeCanvasIfNeeded(sourceCanvas, maxDimension = 1600) {
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
  ctx.drawImage(sourceCanvas, 0, 0, width, height);
  return canvas;
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
  
  const prompt = `You are an expert OCR vision AI specializing in reading and transcribing handwritten daily staff attendance register tables.

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
      maxOutputTokens: 8192,
      responseMimeType: "application/json"
    }
  };

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = null;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!resp.ok) {
        const errorData = await resp.json().catch(() => ({}));
        const errMsg = errorData?.error?.message || `HTTP ${resp.status}`;
        
        if (resp.status === 403 || (resp.status === 400 && errMsg.toLowerCase().includes('api_key'))) {
          localStorage.removeItem('gemini_api_key');
          throw new Error(`Invalid Gemini API Key: ${errMsg}. Please click 'AI Key' at the top to re-enter your key.`);
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
      lastError = err;
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
  progressCallback && progressCallback(10, "Optimizing image resolution...");

  const resized = resizeCanvasIfNeeded(canvas, 1600);
  const dataUrl = resized.toDataURL('image/jpeg', 0.85);

  progressCallback && progressCallback(25, "Scanning handwriting with Gemini AI Vision...");

  let scanError = null;

  // 1. Try backend proxy server only if running on local server
  const isLocalServer = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1'
  );

  if (isLocalServer) {
    try {
      const response = await fetch('/api/scan-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, mimeType: 'image/jpeg' })
      });

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

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
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
    const resizedCvs = resizeCanvasIfNeeded(rotatedCvs, 1200);
    const dataUrl = resizedCvs.toDataURL('image/jpeg', 0.75);

    let pageScanned = false;

    try {
      const pdfProxyCtrl = new AbortController();
      const pdfProxyTimeout = setTimeout(() => pdfProxyCtrl.abort(), 3000);
      const response = await fetch('/api/scan-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, mimeType: 'image/jpeg' }),
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
