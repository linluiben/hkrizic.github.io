// All crop coordinates are fractions of the visible, rotated source page.
export const FULL_CROP = Object.freeze({ left: 0, top: 0, right: 1, bottom: 1 });
export const MIN_CROP = 0.05;
export const PAPER_SIZES = Object.freeze({ a4: [841.89, 595.28], a3: [1190.55, 841.89], letter: [792, 612] });
// Light enough to write over, dark enough to follow on screen and in print.
const NOTES_COLOR = Object.freeze({ red: .68, green: .72, blue: .78 });
const NOTES_LINE_WIDTH = .35, NOTES_DOT_RADIUS = .5;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeCrop(crop) {
  const number = (key, fallback) => Number.isFinite(crop?.[key]) ? crop[key] : fallback;
  const left = clamp(number('left', 0), 0, 1 - MIN_CROP);
  const top = clamp(number('top', 0), 0, 1 - MIN_CROP);
  return { left, top, right: clamp(number('right', 1), left + MIN_CROP, 1), bottom: clamp(number('bottom', 1), top + MIN_CROP, 1) };
}

export function getLayout(viewport, crop, options) {
  crop = normalizeCrop(crop);
  const [width, height] = PAPER_SIZES[options.paper] || PAPER_SIZES.a4;
  const margin = clamp(Number(options.margin) || 0, 0, 25) * 72 / 25.4;
  const cropX = crop.left * viewport.width, cropY = crop.top * viewport.height;
  const cropWidth = (crop.right - crop.left) * viewport.width;
  const cropHeight = (crop.bottom - crop.top) * viewport.height;
  const scale = Math.min((width / 2 - 2 * margin) / cropWidth, (height - 2 * margin) / cropHeight);
  const contentWidth = cropWidth * scale, contentHeight = cropHeight * scale;
  return { width, height, cropX, cropY, cropWidth, cropHeight, scale, contentWidth, contentHeight,
    x: (options.side === 'right' ? width / 2 : 0) + (width / 2 - contentWidth) / 2,
    y: (height - contentHeight) / 2 };
}

export function getEmbedding(viewport, layout) {
  const { cropX, cropY, cropWidth, cropHeight, scale: s, x, y } = layout;
  const points = [[cropX, cropY], [cropX + cropWidth, cropY], [cropX, cropY + cropHeight], [cropX + cropWidth, cropY + cropHeight]].map(p => viewport.convertToPdfPoint(...p));
  const [a, b, c, d, e, f] = viewport.transform;
  return {
    bounds: { left: Math.min(...points.map(p => p[0])), right: Math.max(...points.map(p => p[0])), bottom: Math.min(...points.map(p => p[1])), top: Math.max(...points.map(p => p[1])) },
    // PDF.js uses a top-left origin. Flip Y for PDF output, retaining rotation,
    // CropBox offsets and UserUnit from its viewport instead of guessing them.
    matrix: [s * a, -s * b, s * c, -s * d, x + s * (e - cropX), y + s * (cropHeight - f + cropY)],
  };
}

export function detectContentCrop({ data, width, height }) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 32 && Math.min(data[i], data[i + 1], data[i + 2]) < 242) {
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < left) return null;
  const pad = Math.max(3, Math.round(Math.max(width, height) * .008));
  return normalizeCrop({ left: (left - pad) / width, right: (right + pad + 1) / width, top: (top - pad) / height, bottom: (bottom + pad + 1) / height });
}

// The blank half is the page half the document is not placed on. Its geometry
// only depends on the settings, so preview and export can share it.
export function getNotesPattern(options) {
  if (options.pattern !== 'squared' && options.pattern !== 'dotted') return null;
  const [width, height] = PAPER_SIZES[options.paper] || PAPER_SIZES.a4;
  const spacing = clamp(Number(options.patternSize) || 5, 3, 15) * 72 / 25.4;
  const margin = clamp(Number(options.margin) || 0, 0, 25) * 72 / 25.4;
  const areaWidth = width / 2 - 2 * margin, areaHeight = height - 2 * margin;
  const columns = Math.floor(areaWidth / spacing), rows = Math.floor(areaHeight / spacing);
  if (columns < 1 || rows < 1) return null;
  // Centre the whole grid in the half so partial cells do not sit on one edge.
  return { kind: options.pattern, spacing, columns, rows,
    x: (options.side === 'left' ? width / 2 : 0) + margin + (areaWidth - columns * spacing) / 2,
    y: margin + (areaHeight - rows * spacing) / 2,
    width: columns * spacing, height: rows * spacing };
}

// Paints the same pattern onto a canvas so the preview matches the export.
export function paintNotesPattern(ctx, layout, options, sx, sy) {
  const pattern = getNotesPattern(options);
  if (!pattern) return;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = `rgb(${[NOTES_COLOR.red, NOTES_COLOR.green, NOTES_COLOR.blue].map(value => Math.round(value * 255)).join(',')})`;
  // The canvas draws from the top left, the layout is measured from the bottom.
  const left = pattern.x * sx, top = (layout.height - pattern.y - pattern.height) * sy;
  ctx.beginPath();
  if (pattern.kind === 'squared') {
    ctx.lineWidth = Math.max(.5, NOTES_LINE_WIDTH * sx);
    for (let column = 0; column <= pattern.columns; column++) {
      ctx.moveTo(left + column * pattern.spacing * sx, top);
      ctx.lineTo(left + column * pattern.spacing * sx, top + pattern.height * sy);
    }
    for (let row = 0; row <= pattern.rows; row++) {
      ctx.moveTo(left, top + row * pattern.spacing * sy);
      ctx.lineTo(left + pattern.width * sx, top + row * pattern.spacing * sy);
    }
    ctx.stroke();
  } else {
    const radius = Math.max(.6, NOTES_DOT_RADIUS * sx);
    for (let column = 0; column <= pattern.columns; column++) {
      for (let row = 0; row <= pattern.rows; row++) {
        const x = left + column * pattern.spacing * sx, y = top + row * pattern.spacing * sy;
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
      }
    }
    ctx.fill();
  }
  ctx.restore();
}

function notesPatternOperators(pattern, PDFLib) {
  const { moveTo, lineTo, stroke, fill, closePath, appendBezierCurve, setLineWidth, setStrokingColor, setFillingColor, rgb } = PDFLib;
  const { x, y, width, height, spacing, columns, rows } = pattern;
  const color = rgb(NOTES_COLOR.red, NOTES_COLOR.green, NOTES_COLOR.blue);
  if (pattern.kind === 'squared') {
    const operators = [setLineWidth(NOTES_LINE_WIDTH), setStrokingColor(color)];
    for (let column = 0; column <= columns; column++) operators.push(moveTo(x + column * spacing, y), lineTo(x + column * spacing, y + height));
    for (let row = 0; row <= rows; row++) operators.push(moveTo(x, y + row * spacing), lineTo(x + width, y + row * spacing));
    // One path for the whole grid keeps the shared pattern object small.
    return [...operators, stroke()];
  }
  const operators = [setFillingColor(color)];
  const r = NOTES_DOT_RADIUS, k = r * .5523;
  for (let column = 0; column <= columns; column++) {
    for (let row = 0; row <= rows; row++) {
      const dotX = x + column * spacing, dotY = y + row * spacing;
      operators.push(moveTo(dotX - r, dotY),
        appendBezierCurve(dotX - r, dotY + k, dotX - k, dotY + r, dotX, dotY + r),
        appendBezierCurve(dotX + k, dotY + r, dotX + r, dotY + k, dotX + r, dotY),
        appendBezierCurve(dotX + r, dotY - k, dotX + k, dotY - r, dotX, dotY - r),
        appendBezierCurve(dotX - k, dotY - r, dotX - r, dotY - k, dotX - r, dotY),
        closePath());
    }
  }
  return [...operators, fill()];
}

// The pattern is identical on every page, so it is stored once as a compressed
// form XObject that each page only references.
function embedNotesPattern(output, pattern, PDFLib) {
  const context = output.context;
  const content = notesPatternOperators(pattern, PDFLib).map(operator => operator.toString()).join('\n');
  return context.register(context.flateStream(content, { Type: 'XObject', Subtype: 'Form',
    BBox: [pattern.x, pattern.y, pattern.x + pattern.width, pattern.y + pattern.height], Resources: {} }));
}

export async function buildLandscape({ sourceDoc, previewDoc, crops, options, PDFLib, rasterize, onProgress = () => {} }) {
  const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;
  const output = await PDFDocument.create();
  output.setTitle('PDF with room for notes');
  output.setCreator('PDF Tool');
  const pattern = getNotesPattern(options);
  const patternRef = pattern && embedNotesPattern(output, pattern, PDFLib);
  for (let i = 0; i < previewDoc.numPages; i++) {
    const page = await previewDoc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 1 });
    const layout = getLayout(viewport, crops[i], options);
    const target = output.addPage([layout.width, layout.height]);
    if (patternRef) target.pushOperators(pushGraphicsState(), drawObject(target.node.newXObject('NotesPattern', patternRef)), popGraphicsState());
    const annotations = await page.getAnnotations({ intent: 'display' });
    if (annotations.some(annotation => annotation.subtype !== 'Link')) {
      // Page embedding omits annotation appearances. Render these pages so that
      // existing highlights, ink and form values match the preview.
      const image = await output.embedPng(await rasterize(page, layout));
      target.drawImage(image, { x: layout.x, y: layout.y, width: layout.contentWidth, height: layout.contentHeight });
    } else if (sourceDoc.getPage(i).node.Contents()) {
      const { bounds, matrix } = getEmbedding(viewport, layout);
      const embedded = await output.embedPage(sourceDoc.getPage(i), bounds, [1, 0, 0, 1, 0, 0]);
      target.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));
      target.drawPage(embedded);
      target.pushOperators(popGraphicsState());
    }
    onProgress(i + 1, previewDoc.numPages);
    // Yield between pages so progress and the interface can update.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return output.save();
}
