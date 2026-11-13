const DB_NAME = 'FindItGoDB';
const DB_VERSION = 1;
const STORE_NAME = 'shelf_photos';

let db = null;
let photos = [];
let selectedPhotoId = null;
let currentSearch = '';
let focusedCodeBox = null;
let cameraStream = null;
let pulsePhase = 0;

// הגנה מפני הזרקת קוד דרך שמות קבצים, קודים וקבצי גיבוי שמוצגים כ-HTML
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// פתיחת מסד נתונים מקומי (IndexedDB) באחסון הפנימי של המחשב/טלפון
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

function savePhotoToDB(photo) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(photo);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function deletePhotoFromDB(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function clearAllDB() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

function loadAllPhotosFromDB() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      photos = (req.result || []).sort((a, b) => b.createdAt - a.createdAt);
      resolve(photos);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// דחיסת/המרת תמונה ל-DataURL כדי לשמור באחסון הפנימי ביעילות (+ תמונה ממוזערת לרשימה)
function fileToDataURL(file, maxDim = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      c.getContext('2d').drawImage(img, 0, 0, width, height);

      const t = document.createElement('canvas');
      const tRatio = Math.min(1, 160 / Math.max(width, height));
      t.width = Math.round(width * tRatio);
      t.height = Math.round(height * tRatio);
      t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);

      URL.revokeObjectURL(url);
      resolve({
        dataUrl: c.toDataURL('image/jpeg', 0.88),
        thumbUrl: t.toDataURL('image/jpeg', 0.7),
        width,
        height
      });
    };
    // פורמט שהדפדפן לא יודע לפתוח (למשל HEIC) – שגיאה במקום תקיעה אינסופית
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unsupported image: ' + file.name));
    };
    img.src = url;
  });
}

// מנוע OCR אחד שנטען פעם אחת ומשמש את כל הסריקות (מהיר בהרבה מטעינה מחדש לכל תמונה)
const OCR_SCALE = 2;
let ocrWorkerPromise = null;
let ocrProgressCb = null;
function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (ocrProgressCb && m.status === 'recognizing text') {
          ocrProgressCb(Math.round((m.progress || 0) * 100));
        }
      }
    });
    // כשל בטעינה (למשל בלי אינטרנט) – ננסה לטעון שוב בסריקה הבאה
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  return ocrWorkerPromise;
}

// סריקת תמונה בודדת: זיהוי ברקודים (אם נתמך) + זיהוי טקסט/מספרי מק"ט (OCR)
async function scanPhotoCodes(photo, onStatus) {
  const detected = [];

  // 1. שמירה על סימונים ידניים שהמשתמש הוסיף
  if (Array.isArray(photo.codes)) {
    for (const c of photo.codes) {
      if (c.manual) detected.push(c);
    }
  }

  const img = await loadImageElement(photo.dataUrl);

  // 2. סריקת ברקוד / QR מובנית בדפדפן (בכרום/אנדרואיד)
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector();
      const barcodes = await detector.detect(img);
      for (const b of barcodes) {
        if (b.rawValue && b.boundingBox) {
          detected.push({
            text: b.rawValue.trim(),
            bbox: {
              x0: b.boundingBox.x,
              y0: b.boundingBox.y,
              x1: b.boundingBox.x + b.boundingBox.width,
              y1: b.boundingBox.y + b.boundingBox.height
            },
            confidence: 99,
            type: 'barcode'
          });
        }
      }
    } catch (_) {}
  }

  // 3. סריקת טקסט וקודי פריט באמצעות Tesseract OCR
  if (window.Tesseract) {
    const worker = await getOcrWorker();
    // הגדלה פי 2 לפני OCR: תוויות מדף קטנות מזוהות הרבה יותר טוב (נבדק: 14/18 מול 9/18)
    const big = document.createElement('canvas');
    big.width = img.width * OCR_SCALE;
    big.height = img.height * OCR_SCALE;
    const bigCtx = big.getContext('2d');
    bigCtx.imageSmoothingQuality = 'high';
    bigCtx.drawImage(img, 0, 0, big.width, big.height);
    ocrProgressCb = onStatus;
    let result;
    try {
      result = await worker.recognize(big, {}, { blocks: true });
    } finally {
      ocrProgressCb = null;
    }

    const data = result.data || {};
    // Tesseract v5 מחזיר words; בגרסאות חדשות יותר המילים נמצאות רק בתוך blocks
    const words = data.words || (data.blocks || []).flatMap((b) =>
      b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
    for (const w of words) {
      // ניקוי תווים מיותרים ושמירה על קודי פריט (מספרים/אותיות)
      const cleaned = (w.text || '').replace(/[^a-zA-Z0-9\-_\/\.]/g, '').trim();
      // סינון: לפחות 2 תווים ומכיל לפחות ספרה אחת (או קוד אלפאנומרי ברור)
      if (cleaned.length >= 2 && /\d/.test(cleaned)) {
        detected.push({
          text: cleaned,
          bbox: {
            x0: Math.round(w.bbox.x0 / OCR_SCALE),
            y0: Math.round(w.bbox.y0 / OCR_SCALE),
            x1: Math.round(w.bbox.x1 / OCR_SCALE),
            y1: Math.round(w.bbox.y1 / OCR_SCALE)
          },
          confidence: Math.round(w.confidence || 0),
          type: 'ocr'
        });
      }
    }
  }

  // התמונה נמחקה בזמן הסריקה – לא לשחזר אותה
  if (!photos.some((p) => p.id === photo.id)) return detected;

  photo.codes = detected;
  photo.scanned = true;
  await savePhotoToDB(photo);
  return detected;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// שמירת קובץ תמונה אחד כתמונת מדף חדשה באחסון הפנימי
async function addPhotoFromFile(file, extra = {}) {
  const { dataUrl, thumbUrl, width, height } = await fileToDataURL(file);
  const newPhoto = {
    id: 'photo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: file.name || ('צילום מדף ' + new Date().toLocaleTimeString('he-IL')),
    shelf: 'מדף כללי',
    createdAt: Date.now(),
    dataUrl,
    thumbUrl,
    width,
    height,
    scanned: false,
    codes: [],
    ...extra
  };
  await savePhotoToDB(newPhoto);
  photos.unshift(newPhoto);
  return newPhoto;
}

// הוספת קבצים חדשים לאחסון הפנימי
async function handleFilesUpload(fileList) {
  if (!fileList || fileList.length === 0) return;
  const added = [];
  let failed = 0;
  for (const file of Array.from(fileList)) {
    if (!file.type.startsWith('image/')) continue;
    try {
      added.push(await addPhotoFromFile(file));
    } catch (err) {
      console.error('Upload failed:', file.name, err);
      failed++;
    }
  }
  if (failed > 0) {
    alert(`${failed} קבצים לא נשמרו (פורמט שהדפדפן לא תומך בו, למשל HEIC, או שאין מספיק מקום באחסון).`);
  }

  if (added.length > 0) {
    selectedPhotoId = added[0].id;
    renderAll();
    // סריקה אוטומטית של התמונות שהועלו כעת
    await scanBatch(added);
  }
}

// פס התקדמות משותף לסריקה ולהורדה מ-Google Drive
let progressHideTimer = null;
function setProgress(text, pct) {
  clearTimeout(progressHideTimer);
  document.getElementById('progressWrap').style.display = 'block';
  if (text !== null) document.getElementById('progressText').textContent = text;
  document.getElementById('progressPercent').textContent = pct + '%';
  document.getElementById('progressFill').style.width = pct + '%';
}

function hideProgressSoon() {
  progressHideTimer = setTimeout(() => {
    document.getElementById('progressWrap').style.display = 'none';
  }, 2500);
}

// סריקת קבוצת תמונות עם פס התקדמות (סריקות נכנסות לתור ורצות אחת אחרי השנייה)
let scanQueue = Promise.resolve();
function scanBatch(listToScan) {
  if (!listToScan || listToScan.length === 0) return scanQueue;
  scanQueue = scanQueue.then(() => runScan(listToScan));
  return scanQueue;
}

async function runScan(listToScan) {
  if (!window.Tesseract) {
    alert('מנוע זיהוי הטקסט (OCR) לא נטען – בדוק את החיבור לאינטרנט. כרגע יזוהו רק ברקודים (במכשירים שתומכים בכך).');
  }
  let failed = 0;
  for (let i = 0; i < listToScan.length; i++) {
    const p = listToScan[i];
    setProgress(`סורק תמונה ${i + 1} מתוך ${listToScan.length}: ${p.name}...`, Math.round((i / listToScan.length) * 100));
    try {
      await scanPhotoCodes(p, (subPct) => {
        setProgress(null, Math.round(((i + subPct / 100) / listToScan.length) * 100));
      });
    } catch (err) {
      console.error('Scan failed:', p.name, err);
      failed++;
    }
    renderAll();
  }

  setProgress(failed > 0
    ? `הסריקה הסתיימה – ${failed} תמונות לא נסרקו (נסה שוב עם "סרוק תמונה זו").`
    : 'הסריקה והמיפוי הושלמו בהצלחה!', 100);
  hideProgressSoon();
}

// בדיקה האם קוד מתאים לחיפוש הנוכחי
function isCodeMatch(codeText, query) {
  if (!query) return false;
  return codeText.toLowerCase().includes(query.toLowerCase().trim());
}

// רינדור כללי של הממשק
function renderAll() {
  const totalCodes = photos.reduce((acc, p) => acc + (p.codes ? p.codes.length : 0), 0);
  document.getElementById('statsBadge').textContent = `${photos.length} תמונות | ${totalCodes} קודי פריט מזוהים`;

  renderPhotoList();
  renderViewer();
}

function renderPhotoList() {
  const listEl = document.getElementById('photoList');
  listEl.innerHTML = '';

  const q = currentSearch.trim();
  let matchedPhotosCount = 0;
  let matchedCodesTotal = 0;

  // מיון כך שתמונות עם התאמה לחיפוש יופיעו ראשונות!
  const sorted = [...photos].sort((a, b) => {
    if (!q) return b.createdAt - a.createdAt;
    const aMatches = (a.codes || []).filter(c => isCodeMatch(c.text, q)).length;
    const bMatches = (b.codes || []).filter(c => isCodeMatch(c.text, q)).length;
    if (bMatches !== aMatches) return bMatches - aMatches;
    return b.createdAt - a.createdAt;
  });

  // בחירה אוטומטית בתמונה הראשונה שבה נמצא הפריט (לפני הציור, כדי שהסימון ברשימה יתאים)
  if (q) {
    const firstMatched = sorted.find(p => (p.codes || []).some(c => isCodeMatch(c.text, q)));
    const selected = photos.find(x => x.id === selectedPhotoId);
    if (firstMatched && !(selected?.codes || []).some(c => isCodeMatch(c.text, q))) {
      selectedPhotoId = firstMatched.id;
    }
  }

  for (const p of sorted) {
    const matchingCodes = q ? (p.codes || []).filter(c => isCodeMatch(c.text, q)) : [];
    if (matchingCodes.length > 0) {
      matchedPhotosCount++;
      matchedCodesTotal += matchingCodes.length;
    }

    const item = document.createElement('div');
    item.className = 'photo-item' +
      (p.id === selectedPhotoId ? ' active' : '') +
      (matchingCodes.length > 0 ? ' matched' : '');

    const statusLabel = p.scanned
      ? `${(p.codes || []).length} קודים זוהו`
      : 'טרם נסרק';

    const pillsHtml = (p.codes || []).slice(0, 6).map(c => {
      const match = isCodeMatch(c.text, q);
      return `<span class="code-pill ${match ? 'highlight' : ''}">${esc(c.text)}</span>`;
    }).join('');

    item.innerHTML = `
      <img class="photo-thumb" alt="${esc(p.name)}" />
      <div class="photo-info">
        <div class="photo-title">📍 ${esc(p.shelf || 'מדף כללי')} – ${esc(p.name)}</div>
        <div class="photo-meta">${statusLabel} ${matchingCodes.length > 0 ? `• 🎯 נמצא (${matchingCodes.length})` : ''}</div>
        <div class="codes-pills">${pillsHtml}</div>
      </div>
    `;
    // תמונה ממוזערת דרך מאפיין ולא דרך HTML – מהיר גם עם הרבה תמונות
    item.querySelector('img').src = p.thumbUrl || p.dataUrl;

    item.onclick = () => {
      selectedPhotoId = p.id;
      focusedCodeBox = null;
      renderAll();
    };
    listEl.appendChild(item);
  }

  const summaryEl = document.getElementById('searchSummary');
  if (q) {
    if (matchedPhotosCount > 0) {
      summaryEl.style.color = 'var(--accent)';
      summaryEl.textContent = `✅ קוד "${q}" אותר ב-${matchedPhotosCount} תמונות מדף (${matchedCodesTotal} סימונים על המדף)!`;
    } else {
      summaryEl.style.color = 'var(--danger)';
      summaryEl.textContent = `❌ קוד "${q}" לא נמצא בתמונות שנסרקו. נסה לסרוק את התמונות או להוסיף סימון ידני.`;
    }
  } else {
    summaryEl.textContent = '';
  }
}

let loadedViewerImg = null;
let loadedViewerPhotoId = null;

async function renderViewer() {
  const photo = photos.find(p => p.id === selectedPhotoId) || photos[0];
  const controls = document.getElementById('viewerControls');
  const titleEl = document.getElementById('viewerTitle');
  const statusEl = document.getElementById('viewerStatus');
  const shelfInput = document.getElementById('shelfNameInput');
  const codesListEl = document.getElementById('detectedCodesList');
  const canvas = document.getElementById('shelfCanvas');
  const ctx = canvas.getContext('2d');

  if (!photo) {
    selectedPhotoId = null;
    controls.style.display = 'none';
    titleEl.textContent = 'אין תמונות עדיין – צלם או העלה תמונות מדפים';
    statusEl.textContent = '';
    codesListEl.innerHTML = '';
    canvas.width = 600;
    canvas.height = 320;
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#64748b';
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('צלם תמונה או העלה תמונות מהאחסון הפנימי כדי להתחיל', canvas.width / 2, canvas.height / 2);
    return;
  }

  selectedPhotoId = photo.id;
  controls.style.display = 'flex';
  titleEl.textContent = `📍 ${photo.shelf || 'מדף כללי'} — ${photo.name}`;
  statusEl.textContent = photo.scanned
    ? `נסרק • זוהו ${(photo.codes || []).length} קודי פריט`
    : 'ממתין לסריקה (לחץ על "סרוק תמונה זו" או "סרוק והמר את כל התמונות")';
  shelfInput.value = photo.shelf || '';

  if (loadedViewerPhotoId !== photo.id) {
    loadedViewerImg = await loadImageElement(photo.dataUrl);
    loadedViewerPhotoId = photo.id;
  }

  drawAnnotatedCanvas(photo, loadedViewerImg);

  // רשימת הקודים שזוהו בתמונה
  codesListEl.innerHTML = '';
  const codes = photo.codes || [];
  if (codes.length === 0) {
    codesListEl.innerHTML = '<span style="color:var(--muted); font-size:0.9rem;">טרם זוהו קודים בתמונה זו. לחץ על "סרוק תמונה זו" או לחץ ישירות על התמונה להוספת קוד ידני.</span>';
  } else {
    codes.forEach((c, idx) => {
      const matched = isCodeMatch(c.text, currentSearch);
      const chip = document.createElement('div');
      chip.className = 'detected-chip' + (matched ? ' matched' : '');
      chip.innerHTML = `
        <span>${matched ? '🎯' : '🏷️'} ${esc(c.text)}</span>
        <span title="מחק קוד זה" data-del="${idx}" style="color:#ef4444; margin-right:6px; font-weight:bold;">×</span>
      `;
      chip.onclick = (e) => {
        if (e.target.dataset.del !== undefined) {
          photo.codes.splice(idx, 1);
          savePhotoToDB(photo).then(renderAll);
          return;
        }
        focusedCodeBox = c.bbox;
        drawAnnotatedCanvas(photo, loadedViewerImg);
      };
      codesListEl.appendChild(chip);
    });
  }
}

// ציור התמונה וסימון קודי הפריט שנמצאו על גבי המדף
function drawAnnotatedCanvas(photo, img) {
  if (!img) return;
  const canvas = document.getElementById('shelfCanvas');
  const ctx = canvas.getContext('2d');

  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const q = currentSearch.trim();
  const codes = photo.codes || [];

  // אם יש חיפוש פעיל, נכהה מעט את שאר התמונה כדי שהפריט המסומן יקפוץ לעין במדף!
  const hasMatches = q && codes.some(c => isCodeMatch(c.text, q));
  if (hasMatches) {
    ctx.fillStyle = 'rgba(2, 6, 23, 0.45)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  codes.forEach((c) => {
    const { x0, y0, x1, y1 } = c.bbox;
    const w = Math.max(24, x1 - x0);
    const h = Math.max(20, y1 - y0);
    const matched = isCodeMatch(c.text, q);
    const isFocused = focusedCodeBox &&
      focusedCodeBox.x0 === x0 && focusedCodeBox.y0 === y0;

    if (matched || isFocused) {
      const pad = 10 + Math.sin(pulsePhase) * 4;
      // חשיפת האזור המקורי בבהירות מלאה
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 - pad, y0 - pad, w + pad * 2, h + pad * 2);
      ctx.clip();
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      // מסגרת ירוקה/צהובה זוהרת סביב קוד הפריט במדף
      ctx.save();
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = Math.max(4, Math.round(canvas.width / 220));
      ctx.shadowColor = '#10b981';
      ctx.shadowBlur = 18;
      ctx.strokeRect(x0 - pad, y0 - pad, w + pad * 2, h + pad * 2);

      // תווית בולטת מעל הקוד עם חץ הכוונה
      const fontSize = Math.max(16, Math.round(canvas.width / 45));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'left'; // הקנבס יורש RTL מהדף – בלי זה התווית נכתבת מחוץ למלבן שלה
      const label = `🎯 קוד פריט: ${c.text} (${photo.shelf || 'במדף'})`;
      const textWidth = ctx.measureText(label).width;
      const boxX = Math.max(8, Math.min(canvas.width - textWidth - 24, x0 - pad));
      const boxY = Math.max(fontSize + 16, y0 - pad - 12);

      ctx.fillStyle = '#10b981';
      ctx.fillRect(boxX, boxY - fontSize - 10, textWidth + 20, fontSize + 14);
      ctx.fillStyle = '#052e16';
      ctx.fillText(label, boxX + 10, boxY - 8);
      ctx.restore();
    } else if (!q) {
      // סימון עדין לכל הקודים שזוהו בתמונה כאשר אין חיפוש פעיל
      ctx.save();
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.85)';
      ctx.lineWidth = Math.max(2, Math.round(canvas.width / 400));
      ctx.strokeRect(x0 - 3, y0 - 3, w + 6, h + 6);
      ctx.restore();
    }
  });
}

// אנימציית הבהוב לעיגול/מסגרת הסימון כאשר מחפשים פריט
setInterval(() => {
  if (currentSearch.trim() || focusedCodeBox) {
    pulsePhase += 0.35;
    const photo = photos.find(p => p.id === selectedPhotoId);
    if (photo && loadedViewerImg) {
      drawAnnotatedCanvas(photo, loadedViewerImg);
    }
  }
}, 90);

// הוספת קוד פריט ידנית בלחיצה על מיקום בתמונת המדף
document.getElementById('shelfCanvas').addEventListener('click', async (e) => {
  const photo = photos.find(p => p.id === selectedPhotoId);
  if (!photo || !loadedViewerImg) return;

  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  const clickX = Math.round((e.clientX - rect.left) * scaleX);
  const clickY = Math.round((e.clientY - rect.top) * scaleY);

  // בדיקה אם המשתמש לחץ על קוד קיים
  const clickedExisting = (photo.codes || []).find(c =>
    clickX >= c.bbox.x0 - 10 && clickX <= c.bbox.x1 + 10 &&
    clickY >= c.bbox.y0 - 10 && clickY <= c.bbox.y1 + 10
  );

  if (clickedExisting) {
    const updated = prompt('ערוך קוד פריט במיקום זה (או השאר ריק למחיקה):', clickedExisting.text);
    if (updated === null) return;
    if (updated.trim() === '') {
      photo.codes = photo.codes.filter(c => c !== clickedExisting);
    } else {
      clickedExisting.text = updated.trim();
      clickedExisting.manual = true;
    }
    await savePhotoToDB(photo);
    renderAll();
    return;
  }

  const newCode = prompt('הזן קוד פריט לסימון בנקודה זו על המדף:');
  if (newCode && newCode.trim()) {
    const boxW = Math.round(canvas.width * 0.08);
    const boxH = Math.round(canvas.height * 0.05);
    photo.codes = photo.codes || [];
    photo.codes.push({
      text: newCode.trim(),
      bbox: {
        x0: Math.max(0, clickX - Math.round(boxW / 2)),
        y0: Math.max(0, clickY - Math.round(boxH / 2)),
        x1: Math.min(canvas.width, clickX + Math.round(boxW / 2)),
        y1: Math.min(canvas.height, clickY + Math.round(boxH / 2))
      },
      confidence: 100,
      manual: true
    });
    photo.scanned = true;
    await savePhotoToDB(photo);
    renderAll();
  }
});

// אירועי כפתורים וחיפוש
document.getElementById('searchInput').addEventListener('input', (e) => {
  currentSearch = e.target.value;
  focusedCodeBox = null;
  renderAll();
});

document.getElementById('clearSearchBtn').addEventListener('click', () => {
  document.getElementById('searchInput').value = '';
  currentSearch = '';
  focusedCodeBox = null;
  renderAll();
});

document.getElementById('uploadFilesBtn').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', (e) => {
  handleFilesUpload(e.target.files);
  e.target.value = '';
});

// פתיחת מצלמה (באנדרואיד או במחשב)
document.getElementById('openCameraBtn').addEventListener('click', async () => {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      const video = document.getElementById('cameraVideo');
      video.srcObject = cameraStream;
      document.getElementById('cameraModal').classList.add('open');
      return;
    } catch (_) {}
  }
  // גיבוי למצלמה המובנית בטלפון
  document.getElementById('mobileCameraInput').click();
});

document.getElementById('mobileCameraInput').addEventListener('change', (e) => {
  handleFilesUpload(e.target.files);
  e.target.value = '';
});

document.getElementById('captureSnapBtn').addEventListener('click', async () => {
  const video = document.getElementById('cameraVideo');
  if (!video.videoWidth) return;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  stopCamera();

  // אותו מסלול כמו העלאת קובץ: שמירה, בחירה וסריקה אוטומטית
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
  const name = 'צילום מצלמה ' + new Date().toLocaleTimeString('he-IL');
  await handleFilesUpload([new File([blob], name, { type: 'image/jpeg' })]);
});

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  document.getElementById('cameraModal').classList.remove('open');
}

document.getElementById('closeCameraBtn').addEventListener('click', stopCamera);

// סריקת כל התמונות הקיימות באחסון
document.getElementById('scanAllBtn').addEventListener('click', async () => {
  if (photos.length === 0) {
    alert('אין תמונות במאגר. צלם או העלה תמונות תחילה.');
    return;
  }
  await scanBatch([...photos]);
});

// סריקה חוזרת לתמונה הנוכחית
document.getElementById('rescanSingleBtn').addEventListener('click', async () => {
  const photo = photos.find(p => p.id === selectedPhotoId);
  if (photo) await scanBatch([photo]);
});

// עדכון שם/מספר מדף
document.getElementById('shelfNameInput').addEventListener('change', async (e) => {
  const photo = photos.find(p => p.id === selectedPhotoId);
  if (photo) {
    photo.shelf = e.target.value.trim() || 'מדף כללי';
    await savePhotoToDB(photo);
    renderAll();
  }
});

// מחיקת תמונה בודדת
document.getElementById('deletePhotoBtn').addEventListener('click', async () => {
  const photo = photos.find(p => p.id === selectedPhotoId);
  if (!photo) return;
  if (!confirm(`למחוק את התמונה "${photo.name}"?`)) return;
  await deletePhotoFromDB(photo.id);
  photos = photos.filter(p => p.id !== photo.id);
  selectedPhotoId = photos[0]?.id || null;
  renderAll();
});

// מחיקת כל התמונות
document.getElementById('deleteAllBtn').addEventListener('click', async () => {
  if (photos.length === 0) return;
  if (!confirm('האם למחוק את כל התמונות והקודים השמורים במכשיר?')) return;
  await clearAllDB();
  photos = [];
  selectedPhotoId = null;
  renderAll();
});

// ייצוא וייבוא מאגר (לסנכרון בין המחשב לטלפון)
document.getElementById('exportBtn').addEventListener('click', () => {
  const choice = prompt('הקלד 1 לייצוא כל התמונות והקודים לקובץ (לסנכרון), או 2 לייבוא קובץ קיים:', '1');
  if (choice === '1') {
    const blob = new Blob([JSON.stringify(photos)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `FindItGo_Backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
  } else if (choice === '2') {
    document.getElementById('importInput').click();
  }
});

document.getElementById('importInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (Array.isArray(imported)) {
        // קבלת רשומות תקינות בלבד מקובץ הגיבוי
        const valid = imported.filter(item => item && typeof item.id === 'string' &&
          typeof item.dataUrl === 'string' && item.dataUrl.startsWith('data:image/'));
        for (const item of valid) {
          item.codes = (Array.isArray(item.codes) ? item.codes : [])
            .filter(c => c && typeof c.text === 'string' && c.bbox);
          await savePhotoToDB(item);
        }
        await loadAllPhotosFromDB();
        selectedPhotoId = photos[0]?.id || null;
        renderAll();
        alert(`יובאו בהצלחה ${valid.length} תמונות מדפים!`);
      }
    } catch (err) {
      alert('שגיאה בקריאת קובץ הייבוא');
    }
  };
  reader.readAsText(file);
});

// ===== Google Drive: ייבוא תמונות מדפים מהחשבון =====
// אפשר להדביק כאן את ה-Client ID כדי שכל המכשירים (מחשב + טלפון) יקבלו אותו אוטומטית
const DRIVE_CLIENT_ID = '';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// לכאן Google מחזיר את המשתמש אחרי ההתחברות – חייב להיות רשום ב-Google Cloud בדיוק כך
const DRIVE_REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');

let driveFolderPath = loadDrivePath();
let driveItems = [];
let driveNextPageToken = null;
let driveRequestSeq = 0;
let driveEditingId = false;
const driveSelected = new Map(); // נשמר גם במעבר בין תיקיות

function getDriveClientId() {
  return localStorage.getItem('finditgo_drive_client_id') || DRIVE_CLIENT_ID;
}

function getDriveToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem('finditgo_drive_token'));
    if (t && t.expiresAt > Date.now() + 60000) return t.token;
  } catch (_) {}
  return null;
}

function loadDrivePath() {
  try {
    const saved = JSON.parse(localStorage.getItem('finditgo_drive_path'));
    if (Array.isArray(saved) && saved.length > 0) return saved;
  } catch (_) {}
  return [{ id: 'root', name: 'האחסון שלי' }];
}

function saveDrivePath() {
  localStorage.setItem('finditgo_drive_path', JSON.stringify(driveFolderPath));
}

function buildDriveAuthUrl() {
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem('finditgo_drive_state', state);
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: getDriveClientId(),
    redirect_uri: DRIVE_REDIRECT_URI,
    response_type: 'token',
    scope: DRIVE_SCOPE,
    include_granted_scopes: 'true',
    state
  });
}

// חזרה מדף ההתחברות של Google: הטוקן מגיע אחרי ה-# בכתובת
function handleDriveRedirect() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('state')) return false;
  history.replaceState(null, '', location.pathname + location.search); // הסרת הטוקן משורת הכתובת
  const expected = sessionStorage.getItem('finditgo_drive_state');
  sessionStorage.removeItem('finditgo_drive_state');
  if (!expected || params.get('state') !== expected) return false; // הגנה מזיוף בקשה
  if (params.get('error')) {
    alert('ההתחברות ל-Google לא הושלמה: ' + params.get('error'));
    return false;
  }
  const granted = params.get('scope');
  if (granted !== null && !granted.split(' ').includes(DRIVE_SCOPE)) {
    alert('לא ניתנה הרשאה לצפייה בקבצי Drive. התחבר שוב וסמן את תיבת ההרשאה.');
    return false;
  }
  if (!params.get('access_token')) return false;
  sessionStorage.setItem('finditgo_drive_token', JSON.stringify({
    token: params.get('access_token'),
    expiresAt: Date.now() + (Number(params.get('expires_in')) || 3600) * 1000
  }));
  return true;
}

async function driveFetch(url) {
  const token = getDriveToken();
  if (!token) throw new Error('auth');
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 401) {
    sessionStorage.removeItem('finditgo_drive_token');
    throw new Error('auth');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error((body && body.error && body.error.message) || 'Drive API ' + res.status);
  }
  return res;
}

function openDriveModal() {
  if (location.protocol === 'file:') {
    alert('חיבור ל-Google Drive עובד רק כשהאפליקציה פתוחה דרך start.cmd (http://localhost:8080) או מכתובת https.');
    return;
  }
  document.getElementById('driveModal').classList.add('open');
  renderDriveStep();
}

function closeDriveModal() {
  document.getElementById('driveModal').classList.remove('open');
}

// איזה שלב להציג: הגדרת Client ID / התחברות / דפדוף בתיקיות
function renderDriveStep() {
  const showSetup = !getDriveClientId() || driveEditingId;
  const token = getDriveToken();
  document.getElementById('driveSetup').hidden = !showSetup;
  document.getElementById('driveLogin').hidden = showSetup || !!token;
  document.getElementById('driveBrowser').hidden = showSetup || !token;
  if (showSetup) {
    document.getElementById('driveOrigin').value = location.origin;
    document.getElementById('driveRedirectUri').value = DRIVE_REDIRECT_URI;
    document.getElementById('driveClientIdInput').value = getDriveClientId();
  } else if (token) {
    loadDriveFolder();
  }
}

async function loadDriveFolder(append = false) {
  const seq = ++driveRequestSeq;
  const folder = driveFolderPath[driveFolderPath.length - 1];
  const grid = document.getElementById('driveGrid');
  renderDriveCrumbs();
  if (!append) {
    driveItems = [];
    driveNextPageToken = null;
    document.getElementById('driveMoreBtn').hidden = true;
    grid.innerHTML = '<p class="drive-note">טוען מ-Google Drive...</p>';
  }
  const params = new URLSearchParams({
    q: `'${folder.id}' in parents and trashed = false and (mimeType = '${FOLDER_MIME}' or mimeType contains 'image/')`,
    fields: 'nextPageToken, files(id, name, mimeType, thumbnailLink)',
    orderBy: 'folder, modifiedTime desc',
    pageSize: '100'
  });
  if (append && driveNextPageToken) params.set('pageToken', driveNextPageToken);
  try {
    const data = await (await driveFetch(`${DRIVE_FILES_API}?${params}`)).json();
    if (seq !== driveRequestSeq) return; // המשתמש כבר עבר לתיקייה אחרת
    driveItems = driveItems.concat(data.files || []);
    driveNextPageToken = data.nextPageToken || null;
    renderDriveGrid();
  } catch (err) {
    if (seq !== driveRequestSeq) return;
    if (err.message === 'auth') {
      renderDriveStep();
      return;
    }
    grid.innerHTML = `<p class="drive-note">שגיאה בטעינה מ-Google Drive: ${esc(err.message)}</p>`;
  }
}

function renderDriveCrumbs() {
  document.getElementById('driveCrumbs').innerHTML = driveFolderPath
    .map((f, i) => `<button data-depth="${i}">${i === 0 ? '☁️ ' : ''}${esc(f.name)}</button>`)
    .join('<span>›</span>');
}

function renderDriveGrid() {
  const imported = new Set(photos.map(p => p.driveId).filter(Boolean));
  const html = driveItems.map((f) => {
    if (f.mimeType === FOLDER_MIME) {
      return `<button class="drive-folder" data-id="${esc(f.id)}" data-name="${esc(f.name)}">📁 <span>${esc(f.name)}</span></button>`;
    }
    const done = imported.has(f.id);
    return `
      <label class="drive-tile${done ? ' imported' : ''}" title="${esc(f.name)}">
        <input type="checkbox" value="${esc(f.id)}"${done ? ' disabled' : ''}${driveSelected.has(f.id) ? ' checked' : ''} />
        <img alt="" loading="lazy" referrerpolicy="no-referrer"${f.thumbnailLink ? ` src="${esc(f.thumbnailLink)}"` : ''} />
        <span class="drive-name">${done ? '✓ יובא · ' : ''}${esc(f.name)}</span>
      </label>`;
  }).join('');
  document.getElementById('driveGrid').innerHTML = html || '<p class="drive-note">אין תמונות או תיקיות בתיקייה זו.</p>';
  document.getElementById('driveMoreBtn').hidden = !driveNextPageToken;
  updateDriveImportBtn();
}

function updateDriveImportBtn() {
  document.getElementById('driveImportBtn').textContent = `⬇️ ייבא וסרוק נבחרות (${driveSelected.size})`;
}

document.getElementById('driveBtn').addEventListener('click', openDriveModal);
document.getElementById('driveCloseBtn').addEventListener('click', closeDriveModal);

document.getElementById('driveSetup').addEventListener('click', (e) => {
  const copyId = e.target.dataset.copy;
  if (!copyId) return;
  const input = document.getElementById(copyId);
  if (navigator.clipboard) navigator.clipboard.writeText(input.value).catch(() => {});
  input.select();
  e.target.textContent = 'הועתק ✓';
});

document.getElementById('driveSaveIdBtn').addEventListener('click', () => {
  const id = document.getElementById('driveClientIdInput').value.trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) {
    alert('ה-Client ID לא תקין – הוא אמור להסתיים ב-.apps.googleusercontent.com');
    return;
  }
  localStorage.setItem('finditgo_drive_client_id', id);
  sessionStorage.removeItem('finditgo_drive_token'); // טוקן של Client ID קודם כבר לא רלוונטי
  driveEditingId = false;
  renderDriveStep();
});

document.getElementById('driveEditIdBtn').addEventListener('click', () => {
  driveEditingId = true;
  renderDriveStep();
});

document.getElementById('driveLoginBtn').addEventListener('click', () => {
  location.href = buildDriveAuthUrl();
});

document.getElementById('driveLogoutBtn').addEventListener('click', () => {
  const token = getDriveToken();
  sessionStorage.removeItem('finditgo_drive_token');
  // ביטול ההרשאה גם בצד של Google
  if (token) {
    fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=' + encodeURIComponent(token)
    }).catch(() => {});
  }
  renderDriveStep();
});

document.getElementById('driveCrumbs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  driveFolderPath = driveFolderPath.slice(0, Number(btn.dataset.depth) + 1);
  saveDrivePath();
  loadDriveFolder();
});

document.getElementById('driveGrid').addEventListener('click', (e) => {
  const folderBtn = e.target.closest('.drive-folder');
  if (!folderBtn) return;
  driveFolderPath.push({ id: folderBtn.dataset.id, name: folderBtn.dataset.name });
  saveDrivePath();
  loadDriveFolder();
});

document.getElementById('driveGrid').addEventListener('change', (e) => {
  const item = driveItems.find(f => f.id === e.target.value);
  if (!item) return;
  if (e.target.checked) driveSelected.set(item.id, item);
  else driveSelected.delete(item.id);
  updateDriveImportBtn();
});

document.getElementById('driveSelectAllBtn').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('#driveGrid input[type="checkbox"]:not(:disabled)')];
  const selectAll = boxes.some(b => !b.checked);
  for (const box of boxes) {
    const item = driveItems.find(f => f.id === box.value);
    box.checked = selectAll;
    if (selectAll) driveSelected.set(item.id, item);
    else driveSelected.delete(item.id);
  }
  updateDriveImportBtn();
});

document.getElementById('driveMoreBtn').addEventListener('click', () => loadDriveFolder(true));

// הורדת התמונות שנבחרו אחת-אחת (חוסך זיכרון בטלפון), שמירה וסריקה אוטומטית
document.getElementById('driveImportBtn').addEventListener('click', async () => {
  const chosen = [...driveSelected.values()];
  if (chosen.length === 0) {
    alert('סמן קודם תמונות לייבוא.');
    return;
  }
  driveSelected.clear();
  closeDriveModal();

  const added = [];
  let failed = 0;
  for (let i = 0; i < chosen.length; i++) {
    const f = chosen[i];
    if (photos.some(p => p.driveId === f.id)) continue; // כבר יובאה
    setProgress(`מוריד מ-Google Drive ${i + 1} מתוך ${chosen.length}: ${f.name}`, Math.round((i / chosen.length) * 100));
    try {
      const blob = await (await driveFetch(`${DRIVE_FILES_API}/${encodeURIComponent(f.id)}?alt=media`)).blob();
      added.push(await addPhotoFromFile(new File([blob], f.name, { type: f.mimeType }), { driveId: f.id }));
    } catch (err) {
      if (err.message === 'auth') {
        alert('פג תוקף ההתחברות ל-Google – התחבר שוב כדי להמשיך לייבא.');
        break;
      }
      console.error('Drive import failed:', f.name, err);
      failed++;
    }
  }
  if (failed > 0) {
    alert(`${failed} תמונות לא יובאו (פורמט שהדפדפן לא תומך בו, למשל HEIC, או שגיאת רשת).`);
  }
  if (added.length === 0) {
    hideProgressSoon();
    return;
  }
  selectedPhotoId = added[0].id;
  renderAll();
  await scanBatch(added);
});

// התקנת PWA באנדרואיד ובמחשב
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById('installBtn');
  btn.style.display = 'inline-flex';
  btn.onclick = async () => {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btn.style.display = 'none';
  };
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// אתחול האפליקציה
const driveJustConnected = handleDriveRedirect();
// אחסון קבוע: הדפדפן לא ימחק את התמונות כשחסר מקום במכשיר
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
initDB().then(loadAllPhotosFromDB).then(() => {
  if (photos.length > 0) selectedPhotoId = photos[0].id;
  renderAll();
  if (driveJustConnected) openDriveModal();
});
