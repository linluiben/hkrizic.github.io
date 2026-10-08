// All crop coordinates are fractions of the visible, rotated source page.
export const FULL_CROP = Object.freeze({ left: 0, top: 0, right: 1, bottom: 1 });
export const MIN_CROP = 0.05;
export const PAPER_SIZES = Object.freeze({ a4: [841.89, 595.28], a3: [1190.55, 841.89], letter: [792, 612] });
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

export async function buildLandscape({ sourceDoc, previewDoc, crops, options, PDFLib, rasterize, onProgress = () => {} }) {
  const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = PDFLib;
  const output = await PDFDocument.create();
  output.setTitle('PDF with room for notes');
  output.setCreator('PDF Tool');
  const pending = [];
  for (let i = 0; i < previewDoc.numPages; i++) {
    const page = await previewDoc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 1 });
    const layout = getLayout(viewport, crops[i], options);
    const target = output.addPage([layout.width, layout.height]);
    const annotations = await page.getAnnotations({ intent: 'display' });
    if (annotations.some(annotation => annotation.subtype !== 'Link')) {
      // Page embedding omits annotation appearances. Render these pages so that
      // existing highlights, ink and form values match the preview.
      const image = await output.embedPng(await rasterize(page, layout));
      target.drawImage(image, { x: layout.x, y: layout.y, width: layout.contentWidth, height: layout.contentHeight });
    } else if (sourceDoc.getPage(i).node.Contents()) {
      pending.push({ index: i, target, ...getEmbedding(viewport, layout) });
    }
    onProgress(i + 1, previewDoc.numPages);
    // Yield between pages so progress and the interface can update.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  // Embedding the pages in one call copies what they share - fonts above all -
  // into the output once instead of once per page, which decides the file size
  // of a long document far more than its page count does.
  const embedded = pending.length ? await output.embedPages(
    pending.map(page => sourceDoc.getPage(page.index)),
    pending.map(page => page.bounds),
    pending.map(() => [1, 0, 0, 1, 0, 0])) : [];
  pending.forEach(({ target, matrix }, order) => {
    target.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));
    target.drawPage(embedded[order]);
    target.pushOperators(popGraphicsState());
  });
  return output.save();
}
