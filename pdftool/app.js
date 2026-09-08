import { FULL_CROP, MIN_CROP, clamp, normalizeCrop, getLayout, paintNotesPattern, detectContentCrop, buildLandscape } from './pdf-core.mjs';

const $ = id => document.getElementById(id);
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.624/';
let libraries;
let sourceDoc = null, previewDoc = null, currentFile = null;
let crops = [], pageIndex = 0, currentPage = null, sourceCanvas = null;
let busy = false, rendering = false, renderVersion = 0, renderTask = null;
let drag = null, downloadURL = null;
const options = { side: 'left', paper: 'a4', margin: 8, pattern: 'none', patternSize: 5 };

async function loadLibraries() {
  if (!libraries) {
    libraries = Promise.all([
      import(PDFJS_BASE + 'build/pdf.min.mjs'),
      new Promise((resolve, reject) => {
        if (window.PDFLib) return resolve(window.PDFLib);
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
        script.onload = () => resolve(window.PDFLib);
        script.onerror = () => { script.remove(); reject(new Error('LIBRARY_LOAD')); };
        document.head.append(script);
      }),
    ]).then(([pdfjs, PDFLib]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.min.mjs';
      return { pdfjs, PDFLib };
    }).catch(() => {
      libraries = null;
      throw new Error('The PDF tools could not be loaded. Please check your internet connection and try again.');
    });
  }
  return libraries;
}

function showError(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function syncControls() {
  $('choose-file').disabled = busy;
  $('replace-file').disabled = busy;
  $('download').disabled = busy || rendering || !sourceCanvas;
  $('open-crop').disabled = busy || rendering || !sourceCanvas;
  $('previous').disabled = busy || pageIndex === 0;
  $('next').disabled = busy || !previewDoc || pageIndex >= previewDoc.numPages - 1;
  $('page-number').disabled = busy;
  $('paper').disabled = busy;
  $('margin').disabled = busy;
  $('notes-pattern').disabled = busy;
  $('pattern-size').disabled = busy || options.pattern === 'none';
  document.querySelectorAll('input[name=side]').forEach(input => { input.disabled = busy; });
  $('preview-stage').setAttribute('aria-busy', String(rendering));
}

function updateCropSummary() {
  const crop = crops[pageIndex];
  if (!crop) return;
  const changed = crop.left > .0001 || crop.top > .0001 || crop.right < .9999 || crop.bottom < .9999;
  $('crop-summary').textContent = changed ? `Page ${pageIndex + 1}: crop adjusted` : `Page ${pageIndex + 1}: full page`;
}

async function openFile(file) {
  if (!file || busy) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    showError('Please choose a PDF file.'); return;
  }
  if (!file.size) { showError('This file is empty. Please choose another PDF.'); return; }
  if (file.size > 150 * 1024 * 1024) { showError('Please choose a PDF under 150 MB so your browser can process it reliably.'); return; }
  showError();
  busy = true;
  syncControls();
  $('status').textContent = 'Opening PDF …';
  let candidateTask = null;
  try {
    const { pdfjs, PDFLib } = await loadLibraries();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const candidateSource = await PDFLib.PDFDocument.load(bytes);
    // Reject encrypted PDFs rather than claiming to support exporting them.
    if (candidateSource.isEncrypted) throw new Error('ENCRYPTED');
    candidateTask = pdfjs.getDocument({
      data: bytes.slice(), isEvalSupported: false,
      cMapUrl: PDFJS_BASE + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: PDFJS_BASE + 'standard_fonts/', wasmUrl: PDFJS_BASE + 'wasm/',
    });
    candidateTask.onPassword = () => { candidateTask.destroy(); };
    const candidatePreview = await candidateTask.promise;
    if (!candidatePreview.numPages) throw new Error('EMPTY');
    if (candidatePreview.numPages !== candidateSource.getPageCount()) throw new Error('PAGE_COUNT');
    const oldPreview = previewDoc;
    renderVersion++;
    if (renderTask) renderTask.cancel();
    sourceDoc = candidateSource;
    previewDoc = candidatePreview;
    currentFile = file;
    crops = Array.from({ length: previewDoc.numPages }, () => ({ ...FULL_CROP }));
    pageIndex = 0;
    sourceCanvas = null;
    currentPage = null;
    if (oldPreview) await oldPreview.destroy();
    if (downloadURL) { URL.revokeObjectURL(downloadURL); downloadURL = null; }
    $('filename').textContent = file.name;
    $('file-meta').textContent = `${previewDoc.numPages} ${previewDoc.numPages === 1 ? 'page' : 'pages'} · ${(file.size / 1024 / 1024).toLocaleString('en', { maximumFractionDigits: 1 })} MB`;
    $('page-count').textContent = `/ ${previewDoc.numPages}`;
    $('page-number').max = previewDoc.numPages;
    $('upload').hidden = true;
    $('workspace').hidden = false;
    await showPage(0);
  } catch (error) {
    if (candidateTask && candidateTask !== previewDoc?.loadingTask) await candidateTask.destroy().catch(() => {});
    const encrypted = /encrypt|password/i.test(`${error.name} ${error.message}`);
    showError(encrypted ? 'This PDF is password-protected. Please open an unprotected copy.' :
      error.message.startsWith('The PDF tools') ? error.message : 'This PDF could not be opened. It may be damaged or unsupported. Please try another file.');
    $('status').textContent = '';
  } finally {
    busy = false;
    syncControls();
  }
}

async function showPage(index) {
  if (!previewDoc) return;
  const version = ++renderVersion;
  if (renderTask) renderTask.cancel();
  pageIndex = clamp(index, 0, previewDoc.numPages - 1);
  $('page-number').value = pageIndex + 1;
  rendering = true;
  sourceCanvas = null;
  syncControls();
  updateCropSummary();
  $('status').textContent = `Loading page ${pageIndex + 1} …`;
  try {
    const page = await previewDoc.getPage(pageIndex + 1);
    if (version !== renderVersion) return;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1800 / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const { pdfjs } = await loadLibraries();
    if (version !== renderVersion) return;
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)', annotationMode: pdfjs.AnnotationMode.ENABLE });
    await renderTask.promise;
    if (version !== renderVersion) return;
    sourceCanvas = canvas;
    currentPage = page;
    drawPreviews();
    $('status').textContent = '';
    showError();
  } catch (error) {
    if (version !== renderVersion || error.name === 'RenderingCancelledException') return;
    $('status').textContent = '';
    showError('This page could not be displayed. Try another page or reopen the PDF.');
  } finally {
    if (version === renderVersion) {
      rendering = false;
      renderTask = null;
      syncControls();
    }
  }
}

function drawLandscape(canvas, maxWidth) {
  if (!sourceCanvas || !currentPage) return;
  const crop = crops[pageIndex];
  const layout = getLayout(currentPage.getViewport({ scale: 1 }), crop, options);
  canvas.width = maxWidth;
  canvas.height = Math.round(maxWidth * layout.height / layout.width);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  const sx = canvas.width / layout.width, sy = canvas.height / layout.height;
  paintNotesPattern(ctx, layout, options, sx, sy);
  ctx.drawImage(sourceCanvas,
    crop.left * sourceCanvas.width, crop.top * sourceCanvas.height,
    (crop.right - crop.left) * sourceCanvas.width, (crop.bottom - crop.top) * sourceCanvas.height,
    layout.x * sx, layout.y * sy, layout.contentWidth * sx, layout.contentHeight * sy);
}

function drawPreviews() {
  drawLandscape($('preview'), 1500);
  if ($('crop-dialog').open) drawLandscape($('crop-preview'), 800);
  $('left-label').textContent = options.side === 'left' ? 'Your PDF' : 'Room for notes';
  $('right-label').textContent = options.side === 'left' ? 'Room for notes' : 'Your PDF';
  updateCropSummary();
}

function syncCrop() {
  const crop = crops[pageIndex];
  Object.assign($('crop-box').style, { left: `${crop.left * 100}%`, top: `${crop.top * 100}%`, width: `${(crop.right - crop.left) * 100}%`, height: `${(crop.bottom - crop.top) * 100}%` });
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    const value = (edge === 'right' || edge === 'bottom' ? 1 - crop[edge] : crop[edge]) * 100;
    $(`crop-${edge}`).value = Number(value.toFixed(1));
  }
  drawPreviews();
}

function openCrop() {
  if (busy || rendering || !sourceCanvas) return;
  $('crop-title').textContent = `Crop page ${pageIndex + 1}`;
  $('crop-page-info').textContent = `Page ${pageIndex + 1} of ${previewDoc.numPages}`;
  $('crop-status').textContent = '';
  const canvas = $('crop-canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  canvas.getContext('2d').drawImage(sourceCanvas, 0, 0);
  const maxHeight = Math.max(270, Math.min(560, window.innerHeight - 275));
  $('crop-source').style.width = `${Math.min(490, maxHeight * canvas.width / canvas.height)}px`;
  $('crop-dialog').showModal();
  syncCrop();
}

function pointerPosition(event) {
  const rect = $('crop-overlay').getBoundingClientRect();
  return { x: clamp((event.clientX - rect.left) / rect.width, 0, 1), y: clamp((event.clientY - rect.top) / rect.height, 0, 1) };
}

$('crop-overlay').addEventListener('pointerdown', event => {
  if (event.button !== 0 || drag) return;
  event.preventDefault();
  const point = pointerPosition(event);
  drag = { id: event.pointerId, start: point, crop: { ...crops[pageIndex] }, mode: event.target.dataset.handle || (event.target.closest('#crop-box') ? 'move' : 'new') };
  $('crop-overlay').setPointerCapture(event.pointerId);
  $('crop-status').textContent = '';
});

$('crop-overlay').addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.id) return;
  const p = pointerPosition(event), start = drag.start, original = drag.crop;
  let crop = { ...original };
  const dx = p.x - start.x, dy = p.y - start.y;
  if (drag.mode === 'move') {
    const x = clamp(dx, -original.left, 1 - original.right), y = clamp(dy, -original.top, 1 - original.bottom);
    crop = { left: original.left + x, right: original.right + x, top: original.top + y, bottom: original.bottom + y };
  } else if (drag.mode === 'new') {
    if (Math.abs(dx) < MIN_CROP || Math.abs(dy) < MIN_CROP) return;
    crop = { left: Math.min(start.x, p.x), right: Math.max(start.x, p.x), top: Math.min(start.y, p.y), bottom: Math.max(start.y, p.y) };
  } else {
    if (drag.mode.includes('w')) crop.left = clamp(original.left + dx, 0, original.right - MIN_CROP);
    if (drag.mode.includes('e')) crop.right = clamp(original.right + dx, original.left + MIN_CROP, 1);
    if (drag.mode.includes('n')) crop.top = clamp(original.top + dy, 0, original.bottom - MIN_CROP);
    if (drag.mode.includes('s')) crop.bottom = clamp(original.bottom + dy, original.top + MIN_CROP, 1);
  }
  crops[pageIndex] = normalizeCrop(crop);
  syncCrop();
});

for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('crop-overlay').addEventListener(event, () => { drag = null; });
}

for (const edge of ['left', 'right', 'top', 'bottom']) {
  $(`crop-${edge}`).addEventListener('input', event => {
    if (!event.target.value || !Number.isFinite(event.target.valueAsNumber)) return;
    const crop = { ...crops[pageIndex] };
    const v = clamp(event.target.valueAsNumber, 0, 95) / 100;
    if (edge === 'left') crop.left = Math.min(v, crop.right - MIN_CROP);
    if (edge === 'right') crop.right = Math.max(1 - v, crop.left + MIN_CROP);
    if (edge === 'top') crop.top = Math.min(v, crop.bottom - MIN_CROP);
    if (edge === 'bottom') crop.bottom = Math.max(1 - v, crop.top + MIN_CROP);
    crops[pageIndex] = normalizeCrop(crop);
    const editingValue = event.target.value;
    syncCrop();
    event.target.value = editingValue;
  });
  $(`crop-${edge}`).addEventListener('change', syncCrop);
  $(`crop-${edge}`).addEventListener('blur', syncCrop);
}

$('auto-crop').addEventListener('click', () => {
  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const crop = detectContentCrop(ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height));
  if (!crop) { $('crop-status').textContent = 'This page appears to be blank. The crop has not changed.'; return; }
  crops[pageIndex] = crop;
  syncCrop();
  $('crop-status').textContent = 'White margins detected. Please check the crop in the preview.';
});
$('reset-crop').addEventListener('click', () => {
  crops[pageIndex] = { ...FULL_CROP }; syncCrop();
  $('crop-status').textContent = 'The crop for this page has been reset.';
});
$('apply-all').addEventListener('click', () => {
  crops = crops.map(() => ({ ...crops[pageIndex] }));
  $('crop-status').textContent = `Crop applied to all ${crops.length} pages.`;
  updateCropSummary();
});

async function rasterize(page, layout) {
  // Render only the selected area at 3 pixels per output point (216 dpi), with
  // a bounded canvas even for unusually large source pages or very tight crops.
  const scale = Math.min(layout.scale * 3, Math.sqrt(16000000 / (layout.cropWidth * layout.cropHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(layout.cropWidth * scale));
  canvas.height = Math.max(1, Math.ceil(layout.cropHeight * scale));
  const { pdfjs } = await loadLibraries();
  await page.render({
    canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale }),
    transform: [1, 0, 0, 1, -layout.cropX * scale, -layout.cropY * scale],
    background: 'rgb(255,255,255)', annotationMode: pdfjs.AnnotationMode.ENABLE,
  }).promise;
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('The page image could not be created.');
  return new Uint8Array(await blob.arrayBuffer());
}

async function download() {
  if (busy || rendering || !sourceDoc) return;
  busy = true; syncControls(); showError();
  $('export-progress').hidden = false;
  $('export-progress').value = 0;
  $('status').textContent = 'Creating PDF …';
  try {
    const { PDFLib } = await loadLibraries();
    const bytes = await buildLandscape({ sourceDoc, previewDoc, crops, options, PDFLib, rasterize,
      onProgress: (done, total) => {
        $('status').textContent = `Creating PDF: page ${done} of ${total} …`;
        $('export-progress').value = done / total * 100;
      },
    });
    if (downloadURL) URL.revokeObjectURL(downloadURL);
    downloadURL = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = downloadURL;
    link.download = currentFile.name.replace(/\.pdf$/i, '') + '-notes.pdf';
    document.body.append(link);
    link.click();
    link.remove();
    $('status').textContent = 'Done. Your download has started.';
  } catch (error) {
    showError('The PDF could not be created. Please try again or use a smaller, unprotected PDF.');
    $('status').textContent = '';
  } finally {
    busy = false;
    $('export-progress').hidden = true;
    syncControls();
  }
}

function chooseFile() { if (!busy) $('file-input').click(); }
$('choose-file').addEventListener('click', chooseFile);
$('replace-file').addEventListener('click', chooseFile);
$('file-input').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; openFile(file); });
for (const name of ['dragover', 'drop']) {
  // Prevent dropped PDFs from replacing the editor in the browser tab.
  document.addEventListener(name, event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    if (name === 'drop') {
      $('upload').classList.remove('dragging');
      if ($('crop-dialog').open) return;
      if (event.dataTransfer.files.length !== 1) { showError('Please open one PDF at a time.'); return; }
      openFile(event.dataTransfer.files[0]);
    }
  });
}
$('upload').addEventListener('dragenter', () => { if (!busy) $('upload').classList.add('dragging'); });
$('upload').addEventListener('dragleave', event => { if (!$('upload').contains(event.relatedTarget)) $('upload').classList.remove('dragging'); });
$('previous').addEventListener('click', () => showPage(pageIndex - 1));
$('next').addEventListener('click', () => showPage(pageIndex + 1));
$('page-number').addEventListener('change', event => {
  const value = Number(event.target.value);
  if (!Number.isInteger(value) || value < 1 || value > previewDoc.numPages) { event.target.value = pageIndex + 1; return; }
  showPage(value - 1);
});
document.querySelectorAll('input[name=side]').forEach(input => input.addEventListener('change', () => { options.side = input.value; drawPreviews(); }));
$('paper').addEventListener('change', event => { options.paper = event.target.value; drawPreviews(); });
$('notes-pattern').addEventListener('change', event => { options.pattern = event.target.value; syncControls(); drawPreviews(); });
$('pattern-size').addEventListener('input', event => {
  if (Number.isFinite(event.target.valueAsNumber)) { options.patternSize = clamp(event.target.valueAsNumber, 3, 15); drawPreviews(); }
});
$('pattern-size').addEventListener('change', event => { event.target.value = options.patternSize; });
$('margin').addEventListener('input', event => { if (Number.isFinite(event.target.valueAsNumber)) { options.margin = clamp(event.target.valueAsNumber, 0, 25); drawPreviews(); } });
$('margin').addEventListener('change', event => { event.target.value = options.margin; });
$('open-crop').addEventListener('click', openCrop);
for (const id of ['close-crop', 'done-crop']) $(id).addEventListener('click', () => $('crop-dialog').close());
$('crop-dialog').addEventListener('close', () => { drag = null; $('open-crop').focus(); });
$('download').addEventListener('click', download);
document.addEventListener('keydown', event => {
  if (busy || !previewDoc || $('crop-dialog').open || event.altKey || event.ctrlKey || event.metaKey || /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName)) return;
  if (event.key === 'ArrowLeft' && pageIndex > 0) { event.preventDefault(); showPage(pageIndex - 1); }
  if (event.key === 'ArrowRight' && pageIndex < previewDoc.numPages - 1) { event.preventDefault(); showPage(pageIndex + 1); }
});
