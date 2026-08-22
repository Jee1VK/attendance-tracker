import { calculateSummaryMetrics, parseTimeToMinutes, calculatePayroll, calculateAttendanceRecord } from './src/attendanceCalculator.js';
import { generateAttendancePDF } from './src/pdfExporter.js';
import { renderPdfToCanvas, rotateCanvas, processCanvasOCR, processAllPdfPages, deduplicateAndMergeRecords } from './src/ocrExtractor.js';

// Application State
let staffRecords = [];
let currentFilter = 'all';
let searchQuery = '';

// Shift Target, Grace & Expected IN Settings
let targetMinutes = 570; // 9.5 hours standard
let graceMinutes = 0;
let expectedInMinutes = 600; // 10:00 AM default
let reportDate = new Date().toLocaleDateString('en-GB');

// Document Preview State (Single File)
let currentPdfBuffer = null;
let currentPdfPage = 1;
let totalPdfPages = 1;
let currentCanvas = null;
let currentRotation = 0;

// Multi-Photo Camera Gallery Session State
let capturedPhotos = [];

// DOM References
const tableBody = document.getElementById('table-body');
const searchInput = document.getElementById('search-input');
const filterChips = document.querySelectorAll('.filter-chip');
const statTotal = document.getElementById('stat-total');
const statPresent = document.getElementById('stat-present');
const statShortfall = document.getElementById('stat-shortfall');
const statLateIn = document.getElementById('stat-late-in');
const statAbsent = document.getElementById('stat-absent');
const statAvgHours = document.getElementById('stat-avg-hours');
const statTargetLabel = document.getElementById('stat-target-label');
const countAll = document.getElementById('count-all');
const countShortfall = document.getElementById('count-shortfall');
const countLateIn = document.getElementById('count-latein');
const countFull = document.getElementById('count-full');
const countNotPunched = document.getElementById('count-notpunched');
const countAbsent = document.getElementById('count-absent');
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');
const modalTitle = document.getElementById('modal-title');
const fileInput = document.getElementById('file-input');
const cameraInput = document.getElementById('camera-input');
const cameraAppendInput = document.getElementById('camera-append-input');
const cameraGalleryModal = document.getElementById('camera-gallery-modal');
const galleryThumbnailsGrid = document.getElementById('gallery-thumbnails-grid');
const galleryCountText = document.getElementById('gallery-count-text');
const btnProcessGallery = document.getElementById('btn-process-gallery');
const btnClearGallery = document.getElementById('btn-clear-gallery');
const btnCloseGalleryModal = document.getElementById('btn-close-gallery-modal');
const ocrStatus = document.getElementById('ocr-status');
const ocrMsg = document.getElementById('ocr-msg');
const uploadSection = document.getElementById('upload-section');
const docPreviewModal = document.getElementById('doc-preview-modal');
const previewCanvas = document.getElementById('preview-canvas');
const pageIndicator = document.getElementById('page-indicator');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const whatsappModal = document.getElementById('whatsapp-modal');
const waTextPreview = document.getElementById('wa-text-preview');
const selectTargetHours = document.getElementById('select-target-hours');
const selectGraceMins = document.getElementById('select-grace-mins');
const selectExpectedIn = document.getElementById('select-expected-in');
const inputReportDate = document.getElementById('input-report-date');
const btnInstallApp = document.getElementById('btn-install-app');

const discrepancyPanel = document.getElementById('discrepancy-panel');
const discrepancyList = document.getElementById('discrepancy-list');
const discrepancyBadge = document.getElementById('discrepancy-badge');

let galleryObjectURLs = [];

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (btnInstallApp) btnInstallApp.style.display = 'inline-flex';
});

function isImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|bmp|gif|jfif|heic|tiff?)$/i.test(file.name || '');
}

// Safe JSON parser — prevents app crash if localStorage data is corrupted
function safeJsonParse(raw, fallback = {}) {
  try { return JSON.parse(raw) || fallback; }
  catch (e) { console.warn('Corrupted localStorage data, resetting:', e); return fallback; }
}

document.addEventListener('DOMContentLoaded', () => {
  inputReportDate.value = reportDate;
  updateSavedReportsDropdown();
  
  // Load today's records from localStorage cache if present
  const db = safeJsonParse(localStorage.getItem('attendance_tracker_rosters') || '{}');
  if (db[reportDate]) {
    staffRecords = db[reportDate];
  }
  
  renderApp();
  setupEventListeners();
});

function saveRosterToCache() {
  const dateKey = (inputReportDate.value || reportDate).trim();
  if (!dateKey) return;

  const db = safeJsonParse(localStorage.getItem('attendance_tracker_rosters') || '{}');
  db[dateKey] = staffRecords;
  localStorage.setItem('attendance_tracker_rosters', JSON.stringify(db));

  updateSavedReportsDropdown();
}

function loadRosterFromCache(dateKey) {
  const db = safeJsonParse(localStorage.getItem('attendance_tracker_rosters') || '{}');
  if (db[dateKey]) {
    staffRecords = db[dateKey];
    showToast(`Loaded records for ${dateKey}`, "success");
  } else {
    staffRecords = [];
    showToast(`No records found for ${dateKey}`, "info");
  }
  renderApp();
}

function updateSavedReportsDropdown() {
  const selectSavedReports = document.getElementById('select-saved-reports');
  if (!selectSavedReports) return;

  const db = safeJsonParse(localStorage.getItem('attendance_tracker_rosters') || '{}');
  const savedDates = Object.keys(db).sort().reverse();

  selectSavedReports.innerHTML = '<option value="">-- Select Date --</option>';
  savedDates.forEach(date => {
    const opt = document.createElement('option');
    opt.value = date;
    opt.textContent = `${date} (${db[date].length} Staff)`;
    selectSavedReports.appendChild(opt);
  });
}

function renderApp() {
  const { processedRecords, metrics } = calculateSummaryMetrics(staffRecords, targetMinutes, graceMinutes, expectedInMinutes);

  statTotal.textContent = metrics.totalStaff;
  statPresent.textContent = metrics.presentCount;
  statShortfall.textContent = metrics.shortfallCount;
  statLateIn.textContent = metrics.lateInCount;
  statAbsent.textContent = metrics.absentCount;
  if (statAvgHours) statAvgHours.textContent = metrics.avgWorkingHours;
  statTargetLabel.textContent = `${(targetMinutes / 60).toFixed(1)}h`;

  countAll.textContent = metrics.totalStaff;
  countShortfall.textContent = metrics.shortfallCount;
  countLateIn.textContent = metrics.lateInCount;
  countFull.textContent = metrics.fullHoursCount;
  countNotPunched.textContent = metrics.notPunchedCount;
  countAbsent.textContent = metrics.absentCount;

  const filtered = processedRecords.filter(r => {
    const matchesSearch = !searchQuery || r.name.toLowerCase().includes(searchQuery.toLowerCase());
    let matchesFilter = true;
    if (currentFilter === 'shortfall') matchesFilter = r.isShortfall && !r.isAbsent;
    else if (currentFilter === 'latein') matchesFilter = r.isLateIn && !r.isAbsent;
    else if (currentFilter === 'absent') matchesFilter = r.isAbsent;
    else if (currentFilter === 'full') matchesFilter = !r.isShortfall && !r.isAbsent && !r.isNotPunched;
    else if (currentFilter === 'notpunched') matchesFilter = r.isNotPunched;
    return matchesSearch && matchesFilter;
  });

  renderTable(filtered);
  checkDiscrepancies(processedRecords);
}

function renderTable(records) {
  tableBody.innerHTML = '';

  if (records.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="14" style="padding: 40px; color: var(--text-muted);">
          <i class="fa-solid fa-file-arrow-up" style="font-size: 36px; margin-bottom: 12px; color: var(--accent-primary);"></i>
          <p style="font-size: 1rem; font-weight: 600; color: var(--text-main); margin-bottom: 4px;">No document uploaded yet</p>
          <p style="font-size: 0.875rem;">Upload your handwritten attendance PDF(s) or photo(s) above, or snap multiple photos with your mobile camera.</p>
        </td>
      </tr>`;
    return;
  }

  records.forEach((r) => {
    const tr = document.createElement('tr');
    if (r.isShortfall && !r.isAbsent) tr.classList.add('row-shortfall');

    const originalIndex = (r.slNo || 1) - 1;
    
    // Format custom individual shift target label if set
    const shiftLabel = r.targetMinutes !== undefined && r.targetMinutes !== targetMinutes
      ? ` (${(r.targetMinutes / 60).toFixed(1)}h)`
      : '';

    tr.innerHTML = `
      <td>${r.slNo}</td>
      <td class="name-cell">${esc(r.name)}${shiftLabel}</td>
      <td class="${r.isLateIn && !r.isAbsent ? 'cell-latein' : ''}">${esc(r.in || '-')}</td>
      <td>${esc(r.out1 || '-')}</td>
      <td>${esc(r.in1 || '-')}</td>
      <td>${esc(r.out2 || '-')}</td>
      <td>${esc(r.in2 || '-')}</td>
      <td>${esc(r.out3 || '-')}</td>
      <td>${esc(r.in3 || '-')}</td>
      <td>${esc(r.finalOut || '-')}</td>
      <td class="${r.isShortfall && !r.isAbsent ? 'cell-shortfall' : ''}">${r.totalWorkingHours}</td>
      <td class="${r.isShortfall && !r.isAbsent ? 'cell-shortfall' : ''}">${r.shortfall}</td>
      <td style="font-size: 0.75rem; color: var(--text-muted);">${esc(r.remarks || '-')}</td>
      <td>
        <button class="action-btn edit-btn" data-id="${originalIndex}" title="Edit"><i class="fa-solid fa-pen-to-square"></i></button>
        <button class="action-btn delete delete-btn" data-id="${originalIndex}" title="Remove"><i class="fa-solid fa-trash-can"></i></button>
      </td>`;
    tableBody.appendChild(tr);
  });

  document.querySelectorAll('.edit-btn').forEach(btn =>
    btn.addEventListener('click', e => openEditModal(+e.currentTarget.dataset.id)));
  document.querySelectorAll('.delete-btn').forEach(btn =>
    btn.addEventListener('click', e => deleteRecord(+e.currentTarget.dataset.id)));
}

function renderGalleryModal() {
  // Revoke old object URLs to prevent memory leaks
  galleryObjectURLs.forEach(url => URL.revokeObjectURL(url));
  galleryObjectURLs = [];
  galleryThumbnailsGrid.innerHTML = '';
  galleryCountText.textContent = `${capturedPhotos.length} page${capturedPhotos.length === 1 ? '' : 's'}`;

  if (capturedPhotos.length === 0) {
    cameraGalleryModal.style.display = 'none';
    return;
  }

  capturedPhotos.forEach((file, idx) => {
    const card = document.createElement('div');
    card.style.cssText = 'position: relative; border-radius: 6px; overflow: hidden; border: 1px solid var(--border-color); aspect-ratio: 3/4; background: #1e293b;';

    const img = document.createElement('img');
    img.style.cssText = 'width: 100%; height: 100%; object-fit: cover;';
    img.src = URL.createObjectURL(file);
    galleryObjectURLs.push(img.src);

    const delBtn = document.createElement('button');
    delBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
    delBtn.style.cssText = 'position: absolute; top: 4px; right: 4px; background: rgba(239,68,68,0.85); color: white; border: none; width: 24px; height: 24px; border-radius: 4px; cursor: pointer; font-size: 11px;';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      capturedPhotos.splice(idx, 1);
      renderGalleryModal();
    };

    const label = document.createElement('div');
    label.textContent = `Page ${idx + 1}`;
    label.style.cssText = 'position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.7); color: white; font-size: 11px; padding: 2px 4px; text-align: center;';

    card.appendChild(img);
    card.appendChild(delBtn);
    card.appendChild(label);
    galleryThumbnailsGrid.appendChild(card);
  });

  cameraGalleryModal.style.display = 'flex';
}

function setupEventListeners() {
  searchInput.addEventListener('input', e => { searchQuery = e.target.value; renderApp(); });

  filterChips.forEach(chip => chip.addEventListener('click', () => {
    filterChips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    currentFilter = chip.dataset.filter;
    renderApp();
  }));

  selectTargetHours.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      const currentHrs = (targetMinutes / 60).toFixed(1);
      const customInput = prompt("⏱️ Enter custom shift target in hours (e.g. 9.5, 8.5, 10, 12):", currentHrs);
      if (customInput !== null && !isNaN(parseFloat(customInput)) && parseFloat(customInput) > 0) {
        const hrs = parseFloat(customInput);
        targetMinutes = Math.round(hrs * 60);
        let opt = selectTargetHours.querySelector(`option[value="${targetMinutes}"]`);
        if (!opt) {
          opt = document.createElement('option');
          opt.value = targetMinutes;
          opt.textContent = `${hrs.toFixed(1)} Hours (Custom)`;
          selectTargetHours.insertBefore(opt, selectTargetHours.lastElementChild);
        }
        selectTargetHours.value = targetMinutes;
      } else {
        selectTargetHours.value = targetMinutes;
        return;
      }
    } else {
      targetMinutes = parseInt(e.target.value, 10);
    }
    renderApp();
    saveRosterToCache();
    showToast(`Shift target updated to ${(targetMinutes / 60).toFixed(1)} hours`, "info");
  });

  selectGraceMins.addEventListener('change', (e) => {
    graceMinutes = parseInt(e.target.value, 10);
    renderApp();
    saveRosterToCache();
    showToast(`Grace period set to ${graceMinutes} minutes`, "info");
  });

  selectExpectedIn.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      let curHrs = Math.floor(expectedInMinutes / 60);
      const curMins = expectedInMinutes % 60;
      const curAmpm = curHrs >= 12 ? 'PM' : 'AM';
      if (curHrs > 12) curHrs -= 12;
      if (curHrs === 0) curHrs = 12;
      const customTime = prompt("⏰ Enter custom Expected IN time (e.g. 10:00 AM, 09:30 AM, 10:45):", `${curHrs}:${curMins < 10 ? '0' + curMins : curMins} ${curAmpm}`);
      if (customTime) {
        const parsed = parseTimeToMinutes(customTime);
        if (parsed !== null && parsed > 0) {
          expectedInMinutes = Math.round(parsed);
          let opt = selectExpectedIn.querySelector(`option[value="${expectedInMinutes}"]`);
          if (!opt) {
            opt = document.createElement('option');
            opt.value = expectedInMinutes;
            let hrs = Math.floor(expectedInMinutes / 60);
            const mins = expectedInMinutes % 60;
            const ampm = hrs >= 12 ? 'PM' : 'AM';
            if (hrs > 12) hrs -= 12;
            if (hrs === 0) hrs = 12;
            opt.textContent = `${hrs}:${mins < 10 ? '0' + mins : mins} ${ampm} (Custom)`;
            selectExpectedIn.insertBefore(opt, selectExpectedIn.lastElementChild);
          }
          selectExpectedIn.value = expectedInMinutes;
        } else {
          showToast("Invalid time format entered.", "info");
          selectExpectedIn.value = expectedInMinutes;
          return;
        }
      } else {
        selectExpectedIn.value = expectedInMinutes;
        return;
      }
    } else {
      expectedInMinutes = parseInt(e.target.value, 10);
    }
    renderApp();
    saveRosterToCache();
    let hrs = Math.floor(expectedInMinutes / 60);
    const mins = expectedInMinutes % 60;
    const ampm = hrs >= 12 ? 'PM' : 'AM';
    if (hrs > 12) hrs -= 12;
    if (hrs === 0) hrs = 12;
    const timeStr = `${hrs}:${mins < 10 ? '0' + mins : mins} ${ampm}`;
    showToast(`Expected IN threshold set to ${timeStr}`, "info");
  });

  // Date updates triggers auto-save & auto-load
  inputReportDate.addEventListener('change', (e) => {
    saveRosterToCache();
    reportDate = e.target.value;
    loadRosterFromCache(reportDate);
  });

  // Saved reports picker
  const selectSavedReports = document.getElementById('select-saved-reports');
  if (selectSavedReports) {
    selectSavedReports.addEventListener('change', (e) => {
      const selected = e.target.value;
      if (selected) {
        saveRosterToCache();
        reportDate = selected;
        inputReportDate.value = selected;
        loadRosterFromCache(selected);
      }
    });
  }

  // Theme toggle (light/dark mode)
  const btnThemeToggle = document.getElementById('btn-theme-toggle');
  if (btnThemeToggle) {
    const savedTheme = localStorage.getItem('attendance_theme') || 'dark';
    if (savedTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      btnThemeToggle.innerHTML = '<i class="fa-solid fa-moon"></i>';
    }

    btnThemeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      if (current === 'light') {
        document.documentElement.removeAttribute('data-theme');
        btnThemeToggle.innerHTML = '<i class="fa-solid fa-sun"></i>';
        localStorage.setItem('attendance_theme', 'dark');
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        btnThemeToggle.innerHTML = '<i class="fa-solid fa-moon"></i>';
        localStorage.setItem('attendance_theme', 'light');
      }
    });
  }

  // Gemini API Key Settings
  const btnApiKey = document.getElementById('btn-api-key');
  if (btnApiKey) {
    btnApiKey.addEventListener('click', () => {
      const currentKey = localStorage.getItem('gemini_api_key') || '';
      const input = prompt("🔑 Free Gemini API Key Settings:\n\nLeave blank to reset, or enter your key below:\n(Get one free at https://aistudio.google.com/app/apikey)", currentKey);
      if (input !== null) {
        if (input.trim()) {
          localStorage.setItem('gemini_api_key', input.trim());
          showToast("Gemini API Key saved for standalone mobile scanning!", "success");
        } else {
          localStorage.removeItem('gemini_api_key');
          showToast("Gemini API Key reset.", "info");
        }
      }
    });
  }

  // Master Staff Directory Modal
  const btnMasterDir = document.getElementById('btn-master-dir');
  const masterDirModal = document.getElementById('master-dir-modal');
  if (btnMasterDir && masterDirModal) {
    btnMasterDir.addEventListener('click', () => {
      renderMasterDirectory();
      masterDirModal.style.display = 'flex';
    });
    document.getElementById('btn-close-dir-modal')?.addEventListener('click', () => masterDirModal.style.display = 'none');
    document.getElementById('btn-add-dir-staff')?.addEventListener('click', addMasterStaffName);
  }

  // Monthly Matrix & Payroll Modal
  const btnMonthlyMatrix = document.getElementById('btn-monthly-matrix');
  const monthlyMatrixModal = document.getElementById('monthly-matrix-modal');
  if (btnMonthlyMatrix && monthlyMatrixModal) {
    btnMonthlyMatrix.addEventListener('click', () => {
      renderMonthlyMatrix();
      monthlyMatrixModal.style.display = 'flex';
    });
    document.getElementById('btn-close-matrix-modal')?.addEventListener('click', () => monthlyMatrixModal.style.display = 'none');
    document.getElementById('btn-export-matrix-csv')?.addEventListener('click', exportMonthlyMatrixCSV);
    document.getElementById('input-daily-rate')?.addEventListener('input', renderMonthlyMatrix);
    document.getElementById('select-late-rule')?.addEventListener('change', renderMonthlyMatrix);
  }

  // Cloud & File Backup / Restore
  const btnBackupExport = document.getElementById('btn-backup-export');
  const backupFileInput = document.getElementById('backup-file-input');
  if (btnBackupExport && backupFileInput) {
    btnBackupExport.addEventListener('click', () => {
      const choice = confirm("Click OK to DOWNLOAD a backup file (.json), or CANCEL to RESTORE from an existing backup file.");
      if (choice) {
        exportBackupJSON();
      } else {
        backupFileInput.click();
      }
    });
    backupFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        importBackupJSON(e.target.files[0]);
      }
    });
  }

  // Force Update / Cache Purge on tapping Version Tag
  const headerVersionTag = document.getElementById('header-version-tag');
  if (headerVersionTag) {
    headerVersionTag.addEventListener('click', async () => {
      showToast("Checking for updates and clearing cached files...", "info");
      try {
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const reg of regs) {
            await reg.unregister();
          }
        }
        sessionStorage.clear();
        setTimeout(() => {
          window.location.reload(true);
        }, 500);
      } catch (err) {
        window.location.reload(true);
      }
    });
  }

  if (btnInstallApp) {
    btnInstallApp.addEventListener('click', async () => {
      if (deferredPrompt) {
        try {
          deferredPrompt.prompt();
          const { outcome } = await deferredPrompt.userChoice;
          if (outcome === 'accepted') {
            showToast("App installed on your phone home screen!", "success");
          }
        } catch (err) {
          console.warn('PWA install prompt error:', err);
        }
        deferredPrompt = null;
        btnInstallApp.style.display = 'none';
      } else {
        showToast("On iPhone: Tap Share ↑ -> Add to Home Screen. On Android: Tap Chrome menu ⋮ -> Add to Home screen", "info");
      }
    });
  }

  document.getElementById('btn-clear-all').addEventListener('click', () => {
    // Clear from localStorage for current date
    const dateKey = (inputReportDate.value || reportDate).trim();
    if (dateKey) {
      const db = safeJsonParse(localStorage.getItem('attendance_tracker_rosters') || '{}');
      delete db[dateKey];
      localStorage.setItem('attendance_tracker_rosters', JSON.stringify(db));
    }
    
    staffRecords = [];
    currentPdfBuffer = null;
    currentCanvas = null;
    capturedPhotos = [];
    renderApp();
    updateSavedReportsDropdown();
    showToast("Session reset. Upload handwritten PDF(s) or photo(s)!", "info");
  });

  document.getElementById('btn-add-staff').addEventListener('click', () => openAddModal());

  document.getElementById('btn-export-pdf').addEventListener('click', () => {
    if (staffRecords.length === 0) {
      showToast("Upload handwritten document(s) first!", "info");
      return;
    }
    const { processedRecords, metrics } = calculateSummaryMetrics(staffRecords, targetMinutes, graceMinutes, expectedInMinutes);
    generateAttendancePDF(processedRecords, metrics, inputReportDate.value || reportDate);
    showToast("PDF Report downloaded!", "success");
  });

  document.getElementById('btn-export-csv').addEventListener('click', () => {
    if (staffRecords.length === 0) {
      showToast("Upload handwritten document(s) first!", "info");
      return;
    }
    const { processedRecords, metrics } = calculateSummaryMetrics(staffRecords, targetMinutes, graceMinutes, expectedInMinutes);
    exportAttendanceCSV(processedRecords, metrics, inputReportDate.value || reportDate);
    showToast("Excel/CSV Report downloaded!", "success");
  });

  document.getElementById('btn-copy-image').addEventListener('click', async () => {
    if (staffRecords.length === 0) {
      showToast("Upload handwritten document(s) first!", "info");
      return;
    }

    if (!window.html2canvas) {
      showToast("Image copy library is loading. Please try again.", "info");
      return;
    }

    showToast("Capturing high-resolution report image...", "info");
    const targetEl = document.getElementById('report-table-card');

    try {
      const cvs = await window.html2canvas(targetEl, {
        scale: 2,
        backgroundColor: '#1e293b'
      });

      cvs.toBlob(async (blob) => {
        if (blob) {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': blob })
            ]);
            showToast("Report image copied to clipboard! Press Ctrl+V in WhatsApp Web to paste.", "success");
          } catch (err) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Attendance_Report_${(inputReportDate.value || reportDate).replace(/[\/\\]/g, '-')}.png`;
            a.click();
            URL.revokeObjectURL(url);
            showToast("Report image downloaded!", "success");
          }
        }
      });
    } catch (err) {
      showToast(`Image Copy Error: ${err.message}`, "info");
    }
  });

  document.getElementById('btn-whatsapp-share').addEventListener('click', () => {
    if (staffRecords.length === 0) { showToast("Upload a PDF or image first!", "info"); return; }
    openWhatsAppModal();
  });

  document.getElementById('btn-close-wa-modal').addEventListener('click', () => whatsappModal.style.display = 'none');
  document.getElementById('btn-wa-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(waTextPreview.value);
    showToast("Summary copied!", "success");
  });
  document.getElementById('btn-wa-launch').addEventListener('click', () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(waTextPreview.value)}`, '_blank');
  });

  // Multi-file upload
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    if (files.length === 1) {
      await handleSingleFileSelected(files[0]);
    } else {
      await handleMultipleFilesSelected(files);
    }
  });

  // Mobile camera capture input listener (supports multiple photos)
  if (cameraInput) {
    cameraInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        capturedPhotos = capturedPhotos.concat(files);
        renderGalleryModal();
      }
    });
  }

  if (cameraAppendInput) {
    cameraAppendInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) {
        capturedPhotos = capturedPhotos.concat(files);
        renderGalleryModal();
      }
    });
  }

  if (btnCloseGalleryModal) {
    btnCloseGalleryModal.addEventListener('click', () => cameraGalleryModal.style.display = 'none');
  }

  if (btnClearGallery) {
    btnClearGallery.addEventListener('click', () => {
      capturedPhotos = [];
      renderGalleryModal();
    });
  }

  if (btnProcessGallery) {
    btnProcessGallery.addEventListener('click', async () => {
      if (capturedPhotos.length === 0) return;
      cameraGalleryModal.style.display = 'none';
      await handleMultipleFilesSelected(capturedPhotos);
    });
  }

  ['dragenter', 'dragover'].forEach(ev => uploadSection.addEventListener(ev, e => { e.preventDefault(); uploadSection.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(ev => uploadSection.addEventListener(ev, e => { e.preventDefault(); uploadSection.classList.remove('drag-over'); }));
  uploadSection.addEventListener('drop', async e => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 1) {
      await handleSingleFileSelected(files[0]);
    } else if (files.length > 1) {
      await handleMultipleFilesSelected(files);
    }
  });

  document.getElementById('btn-rotate-left').addEventListener('click', () => { currentRotation = (currentRotation - 90) % 360; updateCanvasPreview(); });
  document.getElementById('btn-rotate-right').addEventListener('click', () => { currentRotation = (currentRotation + 90) % 360; updateCanvasPreview(); });

  btnPrevPage.addEventListener('click', async () => {
    if (currentPdfBuffer && currentPdfPage > 1) {
      currentPdfPage--;
      const { canvas } = await renderPdfToCanvas(currentPdfBuffer, currentPdfPage);
      currentCanvas = canvas; currentRotation = 0; updateCanvasPreview();
    }
  });

  btnNextPage.addEventListener('click', async () => {
    if (currentPdfBuffer && currentPdfPage < totalPdfPages) {
      currentPdfPage++;
      const { canvas } = await renderPdfToCanvas(currentPdfBuffer, currentPdfPage);
      currentCanvas = canvas; currentRotation = 0; updateCanvasPreview();
    }
  });

  document.getElementById('btn-scan-confirmed').addEventListener('click', async () => {
    if (!currentCanvas) return;
    docPreviewModal.style.display = 'none';
    ocrStatus.style.display = 'block';

    try {
      let scanResult;

      if (currentPdfBuffer && totalPdfPages > 1) {
        ocrMsg.textContent = `Scanning all ${totalPdfPages} pages with Gemini AI Vision...`;
        scanResult = await processAllPdfPages(currentPdfBuffer, currentRotation, (progress, msg) => {
          ocrMsg.textContent = msg;
        });
      } else {
        ocrMsg.textContent = "Sending to Gemini AI Vision for handwriting recognition...";
        const rotatedCvs = rotateCanvas(currentCanvas, currentRotation);
        scanResult = await processCanvasOCR(rotatedCvs, (progress, msg) => {
          ocrMsg.textContent = msg;
        });
      }

      if (scanResult && scanResult.records && scanResult.records.length > 0) {
        if (staffRecords.length > 0) {
          const merged = deduplicateAndMergeRecords(staffRecords.concat(scanResult.records));
          const newStaffCount = merged.length - staffRecords.length;
          staffRecords = merged;
          if (scanResult.reportDate) {
            reportDate = scanResult.reportDate;
            inputReportDate.value = reportDate;
          }
          renderApp();
          saveRosterToCache();
          showToast(`Extracted ${scanResult.records.length} records! Added ${newStaffCount} new staff (Total: ${staffRecords.length})`, "success");
        } else {
          staffRecords = scanResult.records;
          if (scanResult.reportDate) {
            reportDate = scanResult.reportDate;
            inputReportDate.value = reportDate;
          }
          renderApp();
          saveRosterToCache();
          showToast(`Gemini extracted ${scanResult.records.length} unique staff records! Date: ${scanResult.reportDate || 'Default'}`, "success");
        }
      } else {
        showToast("No records found. Try rotating the document.", "info");
      }
    } catch (err) {
      showToast(`Scan Error: ${err.message}`, "info");
    } finally {
      ocrStatus.style.display = 'none';
      if (fileInput) fileInput.value = '';
      if (cameraInput) cameraInput.value = '';
    }
  });

  document.getElementById('btn-close-doc-modal').addEventListener('click', () => {
    docPreviewModal.style.display = 'none';
    if (fileInput) fileInput.value = '';
    if (cameraInput) cameraInput.value = '';
  });

  const editTargetSelect = document.getElementById('edit-target-minutes');
  if (editTargetSelect) {
    editTargetSelect.addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        const customHrs = prompt("⏱️ Enter custom individual shift target in hours (e.g. 9.5, 7.5, 12):", "9.5");
        if (customHrs && !isNaN(parseFloat(customHrs)) && parseFloat(customHrs) > 0) {
          const mins = Math.round(parseFloat(customHrs) * 60);
          let opt = editTargetSelect.querySelector(`option[value="${mins}"]`);
          if (!opt) {
            opt = document.createElement('option');
            opt.value = mins;
            opt.textContent = `${parseFloat(customHrs).toFixed(1)} Hours (Custom)`;
            editTargetSelect.insertBefore(opt, editTargetSelect.lastElementChild);
          }
          editTargetSelect.value = mins;
        } else {
          editTargetSelect.value = "";
        }
      }
    });
  }

  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);
  editForm.addEventListener('submit', e => { e.preventDefault(); saveModalRecord(); });
}

async function handleSingleFileSelected(file) {
  if (file.name.toLowerCase().endsWith('.pdf')) {
    ocrStatus.style.display = 'block';
    ocrMsg.textContent = "Loading PDF Document...";
    try {
      const arrayBuffer = await file.arrayBuffer();
      currentPdfBuffer = arrayBuffer;
      currentPdfPage = 1;
      const { canvas, totalPages } = await renderPdfToCanvas(arrayBuffer, 1);
      totalPdfPages = totalPages;
      currentCanvas = canvas;
      currentRotation = 0;
      showDocumentPreviewModal();
    } catch (err) {
      showToast(`PDF Error: ${err.message}`, "info");
    } finally {
      ocrStatus.style.display = 'none';
    }
  } else if (isImageFile(file)) {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = new Image();
      img.onload = () => {
        const cvs = document.createElement('canvas');
        cvs.width = img.width; cvs.height = img.height;
        cvs.getContext('2d').drawImage(img, 0, 0);
        currentPdfBuffer = null;
        currentCanvas = cvs;
        currentRotation = 0;
        totalPdfPages = 1;
        showDocumentPreviewModal();
      };
      img.onerror = () => {
        showToast(`Failed to load image: ${file.name}`, "info");
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  } else {
    showToast(`Unsupported file type: ${file.name}`, "info");
  }
}

async function handleMultipleFilesSelected(files) {
  ocrStatus.style.display = 'block';
  ocrMsg.textContent = `Preparing ${files.length} pages for fast parallel AI vision scanning...`;
  
  let accumulatedRecords = [];
  let detectedDate = '';
  let lastBatchError = null;
  let completedCount = 0;

  // Convert all files into processing promises in parallel
  const tasks = files.map(async (file, idx) => {
    try {
      if (file.name && file.name.toLowerCase().endsWith('.pdf')) {
        const arrayBuffer = await file.arrayBuffer();
        const scanRes = await processAllPdfPages(arrayBuffer, 0, (prog, msg) => {
          ocrMsg.textContent = `[Page ${idx + 1}/${files.length}] ${msg}`;
        });
        completedCount++;
        ocrMsg.textContent = `Scanned ${completedCount}/${files.length} pages in parallel...`;
        return scanRes;
      } else if (isImageFile(file)) {
        const cvs = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (evt) => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement('canvas');
              c.width = img.width; c.height = img.height;
              c.getContext('2d').drawImage(img, 0, 0);
              resolve(c);
            };
            img.onerror = () => reject(new Error(`Failed to load image ${file.name}`));
            img.src = evt.target.result;
          };
          reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));
          reader.readAsDataURL(file);
        });

        if (cvs) {
          const scanRes = await processCanvasOCR(cvs, (prog, msg) => {
            ocrMsg.textContent = `[Photo ${idx + 1}/${files.length}] ${msg}`;
          });
          completedCount++;
          ocrMsg.textContent = `Scanned ${completedCount}/${files.length} pages in parallel...`;
          return scanRes;
        }
      }
    } catch (err) {
      console.error(`Error scanning file ${file.name || 'Photo'}:`, err);
      lastBatchError = err;
      return null;
    }
    return null;
  });

  // Execute all page/photo scans simultaneously!
  const results = await Promise.allSettled(tasks);

  results.forEach(res => {
    if (res.status === 'fulfilled' && res.value && Array.isArray(res.value.records)) {
      accumulatedRecords = accumulatedRecords.concat(res.value.records);
      if (res.value.reportDate && !detectedDate) {
        detectedDate = res.value.reportDate;
      }
    }
  });

  ocrStatus.style.display = 'none';
  if (fileInput) fileInput.value = '';
  if (cameraInput) cameraInput.value = '';
  if (cameraAppendInput) cameraAppendInput.value = '';
  capturedPhotos = [];

  if (accumulatedRecords.length > 0) {
    const uniqueRecords = deduplicateAndMergeRecords(accumulatedRecords);
    
    // If records were already in the table, merge them cleanly
    if (staffRecords.length > 0) {
      const merged = deduplicateAndMergeRecords(staffRecords.concat(uniqueRecords));
      const newCount = merged.length - staffRecords.length;
      staffRecords = merged;
      showToast(`Scanned ${files.length} page(s)! Added ${newCount} new staff members (Total: ${staffRecords.length})`, "success");
    } else {
      staffRecords = uniqueRecords;
      showToast(`Scanned ${files.length} page(s)! Formatted ${staffRecords.length} unique staff members.`, "success");
    }

    if (detectedDate) {
      reportDate = detectedDate;
      inputReportDate.value = reportDate;
    }

    renderApp();
    saveRosterToCache();
  } else {
    if (lastBatchError) {
      showToast(`Scan Error: ${lastBatchError.message}`, "info");
    } else {
      showToast("No staff records could be extracted from selected files. Ensure images are clear and upright.", "info");
    }
  }
}

function exportAttendanceCSV(processedRecords, metrics, reportDate) {
  const headers = ["SL NO", "NAME", "IN", "1st Out", "1st In", "2nd Out", "2nd In", "3rd Out", "3rd In", "Final Out", "Total Working Hours", "Shortfall", "Remarks", "Status"];

  let csvContent = `DAILY STAFF ATTENDANCE REPORT - ${reportDate}\n`;
  csvContent += `Total Staff: ${metrics.totalStaff}, Present: ${metrics.presentCount}, Absent: ${metrics.absentCount}, Shortfall (<${metrics.targetHoursLabel}): ${metrics.shortfallCount}, Late IN: ${metrics.lateInCount}, Avg Hours: ${metrics.avgWorkingHours}\n\n`;

  csvContent += headers.join(",") + "\n";

  processedRecords.forEach((r, idx) => {
    let status = "Full Hours";
    if (r.isAbsent) status = "ABSENT";
    else if (r.isNotPunched) status = "NOT PUNCHED";
    else if (r.isShortfall) status = "SHORTFALL";
    else if (r.isLateIn) status = "LATE IN";

    const row = [
      r.slNo || (idx + 1),
      `"${(r.name || '').replace(/"/g, '""')}"`,
      `"${r.in || ''}"`,
      `"${r.out1 || ''}"`,
      `"${r.in1 || ''}"`,
      `"${r.out2 || ''}"`,
      `"${r.in2 || ''}"`,
      `"${r.out3 || ''}"`,
      `"${r.in3 || ''}"`,
      `"${r.finalOut || ''}"`,
      `"${r.totalWorkingHours || ''}"`,
      `"${r.shortfall || ''}"`,
      `"${(r.remarks || '').replace(/"/g, '""')}"`,
      `"${status}"`
    ];
    csvContent += row.join(",") + "\n";
  });

  const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Attendance_Report_${reportDate.replace(/[\/\\]/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function showDocumentPreviewModal() { updateCanvasPreview(); docPreviewModal.style.display = 'flex'; }

function updateCanvasPreview() {
  if (!currentCanvas) return;
  const targetCvs = rotateCanvas(currentCanvas, currentRotation);
  previewCanvas.width = targetCvs.width;
  previewCanvas.height = targetCvs.height;
  previewCanvas.getContext('2d').drawImage(targetCvs, 0, 0);

  if (totalPdfPages > 1) {
    pageIndicator.textContent = `Page ${currentPdfPage} of ${totalPdfPages}`;
    btnPrevPage.style.display = currentPdfPage > 1 ? 'inline-flex' : 'none';
    btnNextPage.style.display = currentPdfPage < totalPdfPages ? 'inline-flex' : 'none';
  } else {
    pageIndicator.textContent = "Image File";
    btnPrevPage.style.display = 'none';
    btnNextPage.style.display = 'none';
  }
}

function openAddModal() {
  modalTitle.textContent = "Add Staff Entry";
  document.getElementById('edit-id').value = "-1";
  ['edit-name', 'edit-in', 'edit-finalOut', 'edit-out1', 'edit-in1', 'edit-out2', 'edit-in2', 'edit-out3', 'edit-in3', 'edit-remarks'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const editTargetSelect = document.getElementById('edit-target-minutes');
  if (editTargetSelect) editTargetSelect.value = "";
  editModal.style.display = 'flex';
}

function openEditModal(index) {
  modalTitle.textContent = "Edit Staff Entry";
  const r = staffRecords[index];
  if (!r) return;
  document.getElementById('edit-id').value = index;
  document.getElementById('edit-name').value = r.name || '';
  document.getElementById('edit-in').value = r.in || '';
  document.getElementById('edit-finalOut').value = r.finalOut || '';
  document.getElementById('edit-out1').value = r.out1 || '';
  document.getElementById('edit-in1').value = r.in1 || '';
  document.getElementById('edit-out2').value = r.out2 || '';
  document.getElementById('edit-in2').value = r.in2 || '';
  document.getElementById('edit-out3').value = r.out3 || '';
  document.getElementById('edit-in3').value = r.in3 || '';
  const remarksEl = document.getElementById('edit-remarks');
  if (remarksEl) remarksEl.value = r.remarks || '';
  
  const editTargetSelect = document.getElementById('edit-target-minutes');
  if (editTargetSelect) {
    if (r.targetMinutes !== undefined && r.targetMinutes !== null) {
      let opt = editTargetSelect.querySelector(`option[value="${r.targetMinutes}"]`);
      if (!opt) {
        opt = document.createElement('option');
        opt.value = r.targetMinutes;
        opt.textContent = `${(r.targetMinutes / 60).toFixed(1)} Hours (Custom)`;
        editTargetSelect.insertBefore(opt, editTargetSelect.lastElementChild);
      }
      editTargetSelect.value = String(r.targetMinutes);
    } else {
      editTargetSelect.value = "";
    }
  }
  
  editModal.style.display = 'flex';
}

function closeModal() { editModal.style.display = 'none'; }

function saveModalRecord() {
  const index = +document.getElementById('edit-id').value;
  const editTargetVal = document.getElementById('edit-target-minutes').value;
  const remarksVal = document.getElementById('edit-remarks') ? document.getElementById('edit-remarks').value.trim() : '';
  
  const record = {
    slNo: index >= 0 ? staffRecords[index].slNo : staffRecords.length + 1,
    name: document.getElementById('edit-name').value.trim(),
    in: document.getElementById('edit-in').value.trim(),
    out1: document.getElementById('edit-out1').value.trim(),
    in1: document.getElementById('edit-in1').value.trim(),
    out2: document.getElementById('edit-out2').value.trim(),
    in2: document.getElementById('edit-in2').value.trim(),
    out3: document.getElementById('edit-out3').value.trim(),
    in3: document.getElementById('edit-in3').value.trim(),
    finalOut: document.getElementById('edit-finalOut').value.trim(),
    targetMinutes: editTargetVal ? parseInt(editTargetVal, 10) : null,
    remarks: remarksVal
  };

  if (index >= 0) { staffRecords[index] = record; }
  else { staffRecords.push(record); }
  
  closeModal(); 
  renderApp();
  saveRosterToCache();
  
  showToast(`${index >= 0 ? 'Updated' : 'Added'} entry for ${record.name}`, "success");
}

function deleteRecord(index) {
  if (confirm(`Remove ${staffRecords[index]?.name}?`)) {
    staffRecords.splice(index, 1);
    staffRecords.forEach((r, i) => r.slNo = i + 1);
    renderApp();
    saveRosterToCache();
  }
}

function openWhatsAppModal() {
  const { processedRecords, metrics } = calculateSummaryMetrics(staffRecords, targetMinutes, graceMinutes, expectedInMinutes);
  const shortfall = processedRecords.filter(r => r.isShortfall && !r.isAbsent);
  const lateInStaff = processedRecords.filter(r => r.isLateIn && !r.isAbsent);
  const absentees = processedRecords.filter(r => r.isAbsent);

  const hrs = Math.floor(expectedInMinutes / 60);
  const mins = expectedInMinutes % 60;
  const timeStr = `${hrs}:${mins === 0 ? '00' : (mins < 10 ? '0' + mins : mins)} AM`;

  let msg = `📊 *DAILY STAFF ATTENDANCE REPORT*\n📅 Date: ${inputReportDate.value || reportDate}\n⏱ Shift Target: ${(targetMinutes/60).toFixed(1)} Hours | Grace: ${graceMinutes} Mins\n------------------------------------\n`;
  msg += `👥 Total: ${metrics.totalStaff} | ✅ Present: ${metrics.presentCount} | ❌ Absent: ${metrics.absentCount}\n`;
  msg += `⏰ *Late IN (>${timeStr}): ${metrics.lateInCount} Staff*\n`;
  msg += `🚨 *Shortfall (<${(targetMinutes/60).toFixed(1)}h): ${metrics.shortfallCount} Staff*\n\n`;

  if (lateInStaff.length > 0) {
    msg += `⏰ *LATE IN LIST:*\n`;
    lateInStaff.forEach((r, i) => { msg += `${i + 1}. *${r.name}* — IN: ${r.in}\n`; });
    msg += `\n`;
  }

  if (shortfall.length > 0) {
    msg += `🔻 *SHORTFALL LIST:*\n`;
    shortfall.forEach((r, i) => { msg += `${i + 1}. *${r.name}* — ${r.totalWorkingHours} (Shortfall: ${r.shortfall})\n`; });
    msg += `\n`;
  }

  if (absentees.length > 0) {
    msg += `❌ *ABSENTEES LIST:*\n`;
    absentees.forEach((r, i) => { msg += `${i + 1}. *${r.name}*\n`; });
    msg += `\n`;
  }

  msg += `📥 *PDF Report Attached.*`;

  waTextPreview.value = msg;
  whatsappModal.style.display = 'flex';
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = document.createElement('i');
  icon.className = `fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-info'}`;
  const span = document.createElement('span');
  span.textContent = message;
  toast.appendChild(icon);
  toast.appendChild(span);
  document.getElementById('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// Escapes special HTML characters safely to prevent XSS
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function checkDiscrepancies(processedRecords) {
  if (!discrepancyPanel || !discrepancyList || !discrepancyBadge) return;

  const patternAlerts = [];

  // 1. Identify missing punch out today
  processedRecords.forEach((r) => {
    if (r.isNotPunched) {
      patternAlerts.push({
        category: 'Missing Check-Out',
        severity: 'warning',
        icon: 'fa-solid fa-clock-rotate-left',
        message: `${r.name}: Check-out punch time is missing today (marked NOTPUNCHED).`
      });
    }
  });

  // 2. Scan historical database in localStorage for repetitive negative patterns
  const db = safeJsonParse(localStorage.getItem('attendance_tracker_rosters') || '{}');
  const savedDates = Object.keys(db);
  const totalSavedDays = savedDates.length;

  if (totalSavedDays >= 2) {
    const staffHistory = {};

    savedDates.forEach(dateKey => {
      const dailyRecords = db[dateKey] || [];
      dailyRecords.forEach(r => {
        const name = (r.name || '').trim().toUpperCase();
        if (!name) return;

        if (!staffHistory[name]) {
          staffHistory[name] = {
            totalDays: 0,
            presentDays: 0,
            lateDays: 0,
            shortfallDays: 0,
            missingOutDays: 0,
            absentDays: 0
          };
        }

        const h = staffHistory[name];
        h.totalDays++;

        const isAb = (r.in === 'AB' || r.finalOut === 'AB' || r.isAbsent);
        if (isAb) {
          h.absentDays++;
        } else {
          h.presentDays++;

          // Check late IN pattern
          const startMins = parseTimeToMinutes(r.in);
          if (startMins !== null && startMins > expectedInMinutes) {
            h.lateDays++;
          }

          // Check missing out pattern
          if (r.finalOut === 'NOTPUNCHED' || r.isNotPunched) {
            h.missingOutDays++;
          }

          // Check shortfall pattern
          if (r.isShortfall) {
            h.shortfallDays++;
          }
        }
      });
    });

    // Evaluate staff members for repetitive negative patterns
    processedRecords.forEach(r => {
      const name = (r.name || '').trim().toUpperCase();
      const h = staffHistory[name];
      if (!h || h.presentDays < 2) return;

      // Pattern A: Chronic Lateness (Late >= 50% of present days)
      const lateRate = h.lateDays / h.presentDays;
      if (lateRate >= 0.5 && h.lateDays >= 2) {
        const pct = Math.round(lateRate * 100);
        patternAlerts.push({
          category: 'Repetitive Lateness Pattern',
          severity: 'danger',
          icon: 'fa-solid fa-user-clock',
          message: `${r.name}: Consistently Late — ${h.lateDays} out of ${h.presentDays} present days (${pct}% late rate).`
        });
      }

      // Pattern B: Chronic Shortfall Hours (Shortfall >= 50% of present days)
      const shortfallRate = h.shortfallDays / h.presentDays;
      if (shortfallRate >= 0.5 && h.shortfallDays >= 2) {
        const pct = Math.round(shortfallRate * 100);
        patternAlerts.push({
          category: 'Repetitive Shortfall Hours Pattern',
          severity: 'danger',
          icon: 'fa-solid fa-hourglass-half',
          message: `${r.name}: Frequent Shortfall — Fails to complete full shift target on ${h.shortfallDays} of ${h.presentDays} days (${pct}% shortfall rate).`
        });
      }

      // Pattern C: Repeated Missing Check-Outs (>= 2 missing outs in history)
      if (h.missingOutDays >= 2) {
        patternAlerts.push({
          category: 'Repetitive Unclosed Punches Pattern',
          severity: 'warning',
          icon: 'fa-solid fa-triangle-exclamation',
          message: `${r.name}: Habitually forgets check-out punch — ${h.missingOutDays} unclosed registers recorded.`
        });
      }

      // Pattern D: High Absence Rate (Absent >= 40% of total days)
      const absentRate = h.absentDays / h.totalDays;
      if (absentRate >= 0.4 && h.absentDays >= 2) {
        const pct = Math.round(absentRate * 100);
        patternAlerts.push({
          category: 'High Absence Pattern',
          severity: 'danger',
          icon: 'fa-solid fa-user-slash',
          message: `${r.name}: Frequent Absences — Absent on ${h.absentDays} of ${h.totalDays} recorded dates (${pct}% absence rate).`
        });
      }
    });
  }

  // Render pattern alerts list
  discrepancyList.innerHTML = '';
  discrepancyBadge.textContent = `${patternAlerts.length} Pattern${patternAlerts.length === 1 ? '' : 's'} Flagged`;

  if (patternAlerts.length === 0) {
    discrepancyPanel.style.display = 'none';
    return;
  }

  patternAlerts.forEach((item) => {
    const row = document.createElement('div');
    const isDanger = item.severity === 'danger';
    const bg = isDanger ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)';
    const borderColor = isDanger ? '#ef4444' : '#f59e0b';
    const badgeBg = isDanger ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.2)';
    const badgeColor = isDanger ? '#fca5a5' : '#fcd34d';

    row.style.cssText = `display: flex; align-items: center; justify-content: space-between; background: ${bg}; border-left: 4px solid ${borderColor}; padding: 10px 14px; border-radius: 6px; gap: 12px; flex-wrap: wrap; margin-bottom: 6px;`;

    const leftContainer = document.createElement('div');
    leftContainer.style.cssText = 'display: flex; align-items: center; gap: 10px; flex: 1; min-width: 250px;';

    const categoryTag = document.createElement('span');
    categoryTag.style.cssText = `font-size: 0.6875rem; font-weight: 700; background: ${badgeBg}; color: ${badgeColor}; padding: 2px 7px; border-radius: 4px; text-transform: uppercase; white-space: nowrap;`;
    const catIcon = document.createElement('i');
    catIcon.className = item.icon;
    categoryTag.appendChild(catIcon);
    categoryTag.appendChild(document.createTextNode(' ' + item.category));

    const textSpan = document.createElement('span');
    textSpan.textContent = item.message;
    textSpan.style.cssText = 'font-size: 0.8125rem; color: var(--text-main);';

    leftContainer.appendChild(categoryTag);
    leftContainer.appendChild(textSpan);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'btn btn-outline';
    dismissBtn.style.cssText = 'padding: 3px 8px; font-size: 0.75rem; border-color: var(--border-color); color: var(--text-muted);';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.onclick = () => {
      row.remove();
      const currentCount = parseInt(discrepancyBadge.textContent, 10);
      const remaining = currentCount - 1;
      discrepancyBadge.textContent = `${remaining} Pattern${remaining === 1 ? '' : 's'} Flagged`;
      if (remaining === 0) {
        discrepancyPanel.style.display = 'none';
      }
    };

    row.appendChild(leftContainer);
    row.appendChild(dismissBtn);
    discrepancyList.appendChild(row);
  });

  discrepancyPanel.style.display = 'block';
}

/* ==========================================================================
   FEATURE 1 & 2: MASTER STAFF DIRECTORY UI LOGIC
   ========================================================================== */
function renderMasterDirectory() {
  const container = document.getElementById('dir-staff-list');
  if (!container) return;

  const masterDir = safeJsonParse(localStorage.getItem('attendance_master_directory') || '[]', []);
  container.innerHTML = '';

  if (masterDir.length === 0) {
    container.innerHTML = `<span style="font-size: 0.8125rem; color: var(--text-muted);">No master staff names defined yet. Add official names above!</span>`;
    return;
  }

  masterDir.forEach((name, idx) => {
    const chip = document.createElement('div');
    chip.style.cssText = 'display: inline-flex; align-items: center; gap: 6px; background: rgba(6,182,212,0.15); border: 1px solid #06b6d4; color: #67e8f9; padding: 4px 10px; border-radius: 16px; font-size: 0.8125rem; font-weight: 600;';

    const text = document.createElement('span');
    text.textContent = name;

    const del = document.createElement('i');
    del.className = 'fa-solid fa-xmark';
    del.style.cssText = 'cursor: pointer; opacity: 0.7; font-size: 11px;';
    del.onclick = () => {
      masterDir.splice(idx, 1);
      localStorage.setItem('attendance_master_directory', JSON.stringify(masterDir));
      renderMasterDirectory();
    };

    chip.appendChild(text);
    chip.appendChild(del);
    container.appendChild(chip);
  });
}

function addMasterStaffName() {
  const input = document.getElementById('input-new-staff-name');
  if (!input) return;

  const name = input.value.trim().toUpperCase();
  if (!name) return;

  const masterDir = safeJsonParse(localStorage.getItem('attendance_master_directory') || '[]', []);
  if (!masterDir.includes(name)) {
    masterDir.push(name);
    localStorage.setItem('attendance_master_directory', JSON.stringify(masterDir));
    input.value = '';
    renderMasterDirectory();
    showToast(`Added ${name} to Master Directory`, "success");
  } else {
    showToast(`${name} is already in the Master Directory`, "info");
  }
}

/* ==========================================================================
   FEATURE 3 & 4: MONTHLY ATTENDANCE & PAYROLL MATRIX LOGIC
   ========================================================================== */
function renderMonthlyMatrix() {
  const tableBody = document.getElementById('matrix-table-body');
  if (!tableBody) return;

  const db = safeJsonParse(localStorage.getItem('attendance_tracker_rosters') || '{}');
  const savedDates = Object.keys(db);

  if (savedDates.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="8" style="padding: 30px; text-align: center; color: var(--text-muted);">No saved daily rosters found in storage. Process attendance registers first!</td></tr>`;
    return;
  }

  const staffStatsMap = {};

  savedDates.forEach(dateKey => {
    const dailyRecords = db[dateKey] || [];
    dailyRecords.forEach(r => {
      const name = (r.name || '').trim().toUpperCase();
      if (!name) return;

      if (!staffStatsMap[name]) {
        staffStatsMap[name] = {
          name,
          presentDays: 0,
          lateDays: 0,
          shortfallDays: 0,
          absentDays: 0
        };
      }

      // Compute attendance flags from raw record data
      const computed = calculateAttendanceRecord(r, targetMinutes, graceMinutes, expectedInMinutes);
      const stats = staffStatsMap[name];
      if (computed.isAbsent) {
        stats.absentDays++;
      } else {
        stats.presentDays++;
        if (computed.isLateIn) stats.lateDays++;
        if (computed.isShortfall) stats.shortfallDays++;
      }
    });
  });

  const dailyRate = parseFloat(document.getElementById('input-daily-rate')?.value || 500);
  const lateRule = parseInt(document.getElementById('select-late-rule')?.value || 3, 10);

  const rawList = Object.values(staffStatsMap);
  const payrollList = calculatePayroll(rawList, { dailyRate, lateDeductionRule: lateRule });

  tableBody.innerHTML = '';
  payrollList.forEach(s => {
    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom: 1px solid var(--border-color); text-align: center; color: var(--text-main);';

    tr.innerHTML = `
      <td style="padding: 10px; text-align: left; font-weight: 600; position: sticky; left: 0; background: #0f172a; border-right: 1px solid var(--border-color);">${esc(s.name)}</td>
      <td style="padding: 10px; color: #34d399; font-weight: 600;">${s.presentDays}</td>
      <td style="padding: 10px; color: ${s.lateDays > 0 ? '#fcd34d' : 'inherit'};">${s.lateDays}</td>
      <td style="padding: 10px; color: ${s.shortfallDays > 0 ? '#fca5a5' : 'inherit'};">${s.shortfallDays}</td>
      <td style="padding: 10px; color: ${s.absentDays > 0 ? '#ef4444' : 'inherit'};">${s.absentDays}</td>
      <td style="padding: 10px; color: #fca5a5;">${s.latePenaltyDays > 0 ? '-' + s.latePenaltyDays + ' Days' : '0'}</td>
      <td style="padding: 10px; font-weight: 700; color: #67e8f9;">${s.netPayableDays} Days</td>
      <td style="padding: 10px; font-weight: 700; color: #34d399;">₹${s.estimatedSalary.toLocaleString()}</td>
    `;
    tableBody.appendChild(tr);
  });
}

function exportMonthlyMatrixCSV() {
  const db = safeJsonParse(localStorage.getItem('attendance_tracker_rosters') || '{}');
  const savedDates = Object.keys(db);
  if (savedDates.length === 0) {
    showToast("No saved rosters found to export!", "info");
    return;
  }

  const staffStatsMap = {};
  savedDates.forEach(dateKey => {
    const dailyRecords = db[dateKey] || [];
    dailyRecords.forEach(r => {
      const name = (r.name || '').trim().toUpperCase();
      if (!name) return;

      if (!staffStatsMap[name]) {
        staffStatsMap[name] = { name, presentDays: 0, lateDays: 0, shortfallDays: 0, absentDays: 0 };
      }
      // Compute attendance flags from raw record data
      const computed = calculateAttendanceRecord(r, targetMinutes, graceMinutes, expectedInMinutes);
      const stats = staffStatsMap[name];
      if (computed.isAbsent) stats.absentDays++;
      else {
        stats.presentDays++;
        if (computed.isLateIn) stats.lateDays++;
        if (computed.isShortfall) stats.shortfallDays++;
      }
    });
  });

  const dailyRate = parseFloat(document.getElementById('input-daily-rate')?.value || 500);
  const lateRule = parseInt(document.getElementById('select-late-rule')?.value || 3, 10);

  const payrollList = calculatePayroll(Object.values(staffStatsMap), { dailyRate, lateDeductionRule: lateRule });

  let csv = `MONTHLY ATTENDANCE & PAYROLL SUMMARY MATRIX\n`;
  csv += `Daily Wage Rate: ₹${dailyRate}, Late Deduction Rule: Every ${lateRule} Lates = 0.5 Days Penalty\n\n`;
  csv += `STAFF NAME,PRESENT DAYS,LATE DAYS,SHORTFALL DAYS,ABSENT DAYS,LATE PENALTY DAYS,NET PAYABLE DAYS,ESTIMATED SALARY (INR)\n`;

  payrollList.forEach(s => {
    csv += `"${s.name}",${s.presentDays},${s.lateDays},${s.shortfallDays},${s.absentDays},${s.latePenaltyDays},${s.netPayableDays},${s.estimatedSalary}\n`;
  });

  const blob = new Blob(["\ufeff" + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Monthly_Payroll_Matrix_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Monthly Payroll Excel exported successfully!", "success");
}

/* ==========================================================================
   FEATURE 5: CLOUD & FILE BACKUP / RESTORE LOGIC
   ========================================================================== */
function exportBackupJSON() {
  const rosters = safeJsonParse(localStorage.getItem('attendance_tracker_rosters') || '{}');
  const masterDir = safeJsonParse(localStorage.getItem('attendance_master_directory') || '[]', []);
  const theme = localStorage.getItem('attendance_theme') || 'dark';

  const backupData = {
    version: 1,
    exportDate: new Date().toISOString(),
    rosters,
    masterDirectory: masterDir,
    theme
  };

  const jsonStr = JSON.stringify(backupData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Attendance_Backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Full backup downloaded successfully!", "success");
}

function importBackupJSON(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (data && data.rosters) {
        localStorage.setItem('attendance_tracker_rosters', JSON.stringify(data.rosters));
        if (Array.isArray(data.masterDirectory)) {
          localStorage.setItem('attendance_master_directory', JSON.stringify(data.masterDirectory));
        }
        updateSavedReportsDropdown();
        renderApp();
        showToast("Full backup restored successfully!", "success");
      } else {
        showToast("Invalid backup file structure.", "info");
      }
    } catch (err) {
      showToast(`Backup Restore Error: ${err.message}`, "info");
    }
  };
  reader.readAsText(file);
}

