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

// A destination is [pageRef, /Fit…, …]. Only the variants that carry a target
// point are mapped; the others fall back to the top of the placed content.
function destinationPoint(destination) {
  const kind = destination[1]?.name;
  const at = index => Number.isFinite(destination[index]) ? destination[index] : null;
  if (kind === 'XYZ') return { x: at(2), y: at(3) };
  if (kind === 'FitH' || kind === 'FitBH') return { x: null, y: at(2) };
  if (kind === 'FitV' || kind === 'FitBV') return { x: at(2), y: null };
  if (kind === 'FitR') return { x: at(2), y: at(5) };
  return { x: null, y: null };
}

export async function extractOutline(previewDoc) {
  const items = await previewDoc.getOutline().catch(() => null);
  if (!items?.length) return [];
  const pageIndexes = new Map();
  const resolve = async destination => {
    const explicit = typeof destination === 'string'
      ? await previewDoc.getDestination(destination).catch(() => null) : destination;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const reference = explicit[0];
    let pageIndex = null;
    if (Number.isInteger(reference)) pageIndex = reference;
    else if (reference && typeof reference === 'object') {
      const key = `${reference.num}R${reference.gen}`;
      if (!pageIndexes.has(key)) pageIndexes.set(key, await previewDoc.getPageIndex(reference).catch(() => null));
      pageIndex = pageIndexes.get(key);
    }
    if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
    return { pageIndex, ...destinationPoint(explicit) };
  };
  const walk = async nodes => {
    const result = [];
    for (const node of nodes) {
      const target = node.dest ? await resolve(node.dest) : null;
      const children = node.items?.length ? await walk(node.items) : [];
      // Keep headings whose target is missing as long as they still lead
      // somewhere, so the structure of the outline survives.
      if (!target && !children.length && !node.url) continue;
      result.push({ title: node.title || '', url: node.url || null, target, children,
        open: Boolean(node.count && node.count > 0), bold: Boolean(node.bold), italic: Boolean(node.italic),
        color: node.color?.length === 3 ? Array.from(node.color, value => value / 255) : null });
    }
    return result;
  };
  return walk(items).catch(() => []);
}

function outlineAction(item, output, placements, PDFLib) {
  const { PDFName } = PDFLib;
  const context = output.context;
  const placement = item.target && placements[item.target.pageIndex];
  if (placement) {
    const [a, b, c, d, e, f] = placement.matrix;
    const { x, y, contentWidth, contentHeight } = placement.layout;
    // Destinations such as /FitH carry only one coordinate; the missing one
    // falls back to the page origin and the result is clamped onto the content.
    const [px, py] = [item.target.x ?? 0, item.target.y ?? 0];
    const point = item.target.x === null && item.target.y === null
      ? [x, y + contentHeight]
      : [a * px + c * py + e, b * px + d * py + f];
    return { key: 'Dest', value: context.obj([output.getPage(item.target.pageIndex).ref, PDFName.of('XYZ'),
      clamp(point[0], x, x + contentWidth), clamp(point[1], y, y + contentHeight), null]) };
  }
  if (item.url) return { key: 'A', value: context.obj({ Type: 'Action', S: 'URI', URI: PDFLib.PDFString.of(item.url) }) };
  return null;
}

// pdf-lib has no outline API, so the /Outlines tree is written by hand.
export function applyOutline({ output, outline, placements, PDFLib }) {
  if (!outline?.length) return;
  const { PDFName, PDFNumber, PDFHexString, PDFDict } = PDFLib;
  const context = output.context;
  const build = (items, parent) => {
    const refs = items.map(() => context.nextRef());
    let visible = 0;
    items.forEach((item, index) => {
      const entries = new Map([[PDFName.of('Title'), PDFHexString.fromText(item.title)], [PDFName.of('Parent'), parent]]);
      if (index > 0) entries.set(PDFName.of('Prev'), refs[index - 1]);
      if (index < refs.length - 1) entries.set(PDFName.of('Next'), refs[index + 1]);
      const action = outlineAction(item, output, placements, PDFLib);
      if (action) entries.set(PDFName.of(action.key), action.value);
      if (item.color) entries.set(PDFName.of('C'), context.obj(item.color));
      if (item.bold || item.italic) entries.set(PDFName.of('F'), PDFNumber.of((item.italic ? 1 : 0) + (item.bold ? 2 : 0)));
      const children = item.children.length ? build(item.children, refs[index]) : null;
      if (children) {
        entries.set(PDFName.of('First'), children.first);
        entries.set(PDFName.of('Last'), children.last);
        // A negative count marks a subtree that opens collapsed.
        entries.set(PDFName.of('Count'), PDFNumber.of(item.open ? children.visible : -children.visible));
      }
      context.assign(refs[index], PDFDict.fromMapWithContext(entries, context));
      visible += 1 + (children && item.open ? children.visible : 0);
    });
    return { first: refs[0], last: refs[refs.length - 1], visible };
  };
  const root = context.nextRef();
  const { first, last, visible } = build(outline, root);
  context.assign(root, context.obj({ Type: 'Outlines', First: first, Last: last, Count: visible }));
  output.catalog.set(PDFName.of('Outlines'), root);
  output.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

export async function buildLandscape({ sourceDoc, previewDoc, crops, options, outline, PDFLib, rasterize, onProgress = () => {} }) {
  const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;
  const output = await PDFDocument.create();
  output.setTitle('PDF with room for notes');
  output.setCreator('PDF Tool');
  const placements = [];
  const pattern = getNotesPattern(options);
  const patternRef = pattern && embedNotesPattern(output, pattern, PDFLib);
  for (let i = 0; i < previewDoc.numPages; i++) {
    const page = await previewDoc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 1 });
    const layout = getLayout(viewport, crops[i], options);
    const target = output.addPage([layout.width, layout.height]);
    if (patternRef) target.pushOperators(pushGraphicsState(), drawObject(target.node.newXObject('NotesPattern', patternRef)), popGraphicsState());
    const { bounds, matrix } = getEmbedding(viewport, layout);
    placements[i] = { layout, matrix };
    const annotations = await page.getAnnotations({ intent: 'display' });
    if (annotations.some(annotation => annotation.subtype !== 'Link')) {
      // Page embedding omits annotation appearances. Render these pages so that
      // existing highlights, ink and form values match the preview.
      const image = await output.embedPng(await rasterize(page, layout));
      target.drawImage(image, { x: layout.x, y: layout.y, width: layout.contentWidth, height: layout.contentHeight });
    } else if (sourceDoc.getPage(i).node.Contents()) {
      const embedded = await output.embedPage(sourceDoc.getPage(i), bounds, [1, 0, 0, 1, 0, 0]);
      target.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));
      target.drawPage(embedded);
      target.pushOperators(popGraphicsState());
    }
    onProgress(i + 1, previewDoc.numPages);
    // Yield between pages so progress and the interface can update.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  applyOutline({ output, outline, placements, PDFLib });
  return output.save();
}
