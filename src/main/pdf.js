const fs = require('fs');
const path = require('path');

/**
 * Generates formatted HTML for the slide booklet
 * 
 * @param {Array<string>} slideImageUrls Array of local file:// URLs or relative image paths
 * @param {object} metadata
 * @param {string} metadata.title
 * @param {string} [metadata.date]
 * @param {string} [metadata.durationFormatted]
 * @returns {string} HTML content
 */
function generateSlidesHtml(slideImageUrls, metadata = {}) {
  const title = metadata.title || 'BigBlueButton Presentation Slides';
  const date = metadata.date || '';
  const totalSlides = slideImageUrls ? slideImageUrls.length : 0;

  return `<!DOCTYPE html>
<html dir="ltr" lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} - Slide Booklet</title>
  <style>
    @page {
      size: A4 landscape;
      margin: 0;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .cover-page {
      width: 100vw;
      height: 100vh;
      page-break-after: always;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      background: radial-gradient(circle at center, #1e293b 0%, #0f172a 100%);
      text-align: center;
      padding: 48px;
    }
    .badge {
      display: inline-block;
      padding: 8px 20px;
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.35);
      color: #38bdf8;
      border-radius: 9999px;
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 28px;
      letter-spacing: 0.5px;
    }
    .title {
      font-size: 34px;
      font-weight: 800;
      margin-bottom: 20px;
      color: #ffffff;
      line-height: 1.45;
      max-width: 82%;
    }
    .meta-box {
      display: flex;
      gap: 32px;
      margin-top: 32px;
      padding: 14px 30px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      font-size: 15px;
      color: #94a3b8;
    }
    .meta-item strong {
      color: #f1f5f9;
      margin-right: 6px;
    }
    .slide-page {
      width: 100vw;
      height: 100vh;
      page-break-after: always;
      page-break-inside: avoid;
      display: flex;
      flex-direction: column;
      background: #ffffff;
      position: relative;
    }
    .slide-page:last-child {
      page-break-after: avoid;
    }
    .slide-header {
      height: 38px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      font-size: 12px;
      color: #64748b;
    }
    .slide-header-title {
      max-width: 70%;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .slide-container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
      background: #f1f5f9;
      overflow: hidden;
    }
    .slide-img {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      object-fit: contain;
      box-shadow: 0 4px 14px rgba(0,0,0,0.09);
      border-radius: 4px;
      background: #ffffff;
    }
    .slide-footer {
      height: 34px;
      background: #f8fafc;
      border-top: 1px solid #e2e8f0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 24px;
      font-size: 12px;
      color: #475569;
    }
    .page-number {
      font-weight: 700;
      color: #0284c7;
      background: rgba(2, 132, 199, 0.12);
      padding: 3px 12px;
      border-radius: 6px;
    }
  </style>
</head>
<body>
  <!-- Cover Page -->
  <div class="cover-page">
    <div class="badge">BigBlueButton Slide Booklet</div>
    <h1 class="title">${escapeHtml(title)}</h1>
    <div class="meta-box">
      ${date ? `<div class="meta-item"><span>Date:</span> <strong>${escapeHtml(date)}</strong></div>` : ''}
      <div class="meta-item"><span>Total Slides:</span> <strong>${totalSlides} Slides</strong></div>
    </div>
  </div>

  <!-- Slide Pages -->
  ${slideImageUrls.map((src, idx) => `
    <div class="slide-page">
      <div class="slide-header">
        <span class="slide-header-title">${escapeHtml(title)}</span>
        <span>BigBlueButton</span>
      </div>
      <div class="slide-container">
        <img class="slide-img" src="${src}" alt="Slide ${idx + 1}" />
      </div>
      <div class="slide-footer">
        <span>Presentation Slide Booklet</span>
        <span class="page-number">Slide ${idx + 1} of ${totalSlides}</span>
      </div>
    </div>
  `).join('\n')}
</body>
</html>`;
}

function toPersianDigits(num) {
  return String(num);
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generates a clean, high-resolution PDF booklet from slide image files
 * 
 * @param {Array<string>} slideImagePaths Absolute paths to local slide images
 * @param {object} metadata
 * @param {string} metadata.title
 * @param {string} [metadata.date]
 * @param {string} outputPath Target path for the PDF file
 * @param {string} tempDir Temporary working directory
 * @returns {Promise<string|null>} Generated PDF path or null if skipped/failed
 */
async function generateSlidePdf(slideImagePaths, metadata, outputPath, tempDir) {
  if (!slideImagePaths || slideImagePaths.length === 0) {
    return null;
  }

  // Filter existing files
  const validImagePaths = slideImagePaths.filter(p => p && fs.existsSync(p));
  if (validImagePaths.length === 0) {
    return null;
  }

  // Map to absolute file:// URLs
  const slideUrls = validImagePaths.map(p => `file://${path.resolve(p)}`);
  const htmlContent = generateSlidesHtml(slideUrls, metadata);
  const tempHtmlPath = path.join(tempDir, 'slides_booklet.html');
  fs.writeFileSync(tempHtmlPath, htmlContent, 'utf-8');

  // If outside Electron (e.g. CLI or unit test runner), return null or test fallback
  if (!process.versions.electron) {
    return null;
  }

  const { BrowserWindow } = require('electron');

  const win = new BrowserWindow({
    show: false,
    width: 1600,
    height: 900,
    webPreferences: {
      offscreen: true,
      webSecurity: false // Required to load local file:// images in Chromium
    }
  });

  try {
    await win.loadFile(tempHtmlPath);

    // Wait until all images are fully loaded in DOM
    await win.webContents.executeJavaScript(`
      Promise.all(Array.from(document.images).map(img => {
        if (img.complete) return Promise.resolve();
        return new Promise(resolve => {
          img.onload = resolve;
          img.onerror = resolve;
        });
      }))
    `);

    const pdfBuffer = await win.webContents.printToPDF({
      landscape: true,
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none' }
    });

    const targetDir = path.dirname(outputPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, pdfBuffer);
    return outputPath;
  } finally {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
}

module.exports = {
  generateSlidesHtml,
  generateSlidePdf,
  escapeHtml,
  toPersianDigits
};
