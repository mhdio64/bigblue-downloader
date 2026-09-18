const fs = require('fs');
const path = require('path');
const { fetchUrlText } = require('./metadata');
const { downloadFile } = require('./media-downloader');

/**
 * Parses shapes.svg content and extracts all slide image entries with timing
 * 
 * @param {string} svgContent 
 * @param {string} baseUrl 
 * @returns {Array<{ in: number, out: number, duration: number, href: string, fullUrl: string }>}
 */
function parseShapesSvg(svgContent, baseUrl) {
  if (!svgContent || typeof svgContent !== 'string') return [];
  const slides = [];

  // Match any <image ...> or <image .../> tags
  const imageRegex = /<image\b([^>]*)\/?>/gi;
  let match;

  while ((match = imageRegex.exec(svgContent)) !== null) {
    const attrs = match[1];

    const inMatch = /\bin=["']([\d.]+)["']/i.exec(attrs);
    const outMatch = /\bout=["']([\d.]+)["']/i.exec(attrs);
    const hrefMatch = /\b(?:xlink:href|href)=["']([^"']+)["']/i.exec(attrs);

    if (inMatch && outMatch && hrefMatch) {
      const inTime = parseFloat(inMatch[1]);
      const outTime = parseFloat(outMatch[1]);
      const rawHref = hrefMatch[1].trim();

      // Only consider image files (png, svg, jpg, jpeg) and valid positive time ranges
      if (!isNaN(inTime) && !isNaN(outTime) && outTime > inTime && rawHref) {
        let fullUrl = '';
        try {
          fullUrl = new URL(rawHref, baseUrl).href;
        } catch {
          fullUrl = baseUrl + rawHref;
        }

        slides.push({
          in: inTime,
          out: outTime,
          duration: outTime - inTime,
          href: rawHref,
          fullUrl
        });
      }
    }
  }

  // Sort slides chronologically
  slides.sort((a, b) => a.in - b.in);

  // De-duplicate any identical consecutive slides
  const cleanSlides = [];
  for (const s of slides) {
    if (cleanSlides.length > 0) {
      const prev = cleanSlides[cleanSlides.length - 1];
      if (prev.fullUrl === s.fullUrl && Math.abs(prev.out - s.in) < 0.5) {
        prev.out = Math.max(prev.out, s.out);
        prev.duration = prev.out - prev.in;
        continue;
      }
    }
    cleanSlides.push(s);
  }

  return cleanSlides;
}

/**
 * Parses deskshare.xml content to find all intervals when screen share was active
 * 
 * @param {string} xmlContent 
 * @param {number} [meetingStartTimeMs] Meeting start epoch ms from metadata
 * @returns {Array<{ start: number, stop: number }>}
 */
function parseDeskshareXml(xmlContent, meetingStartTimeMs = 0) {
  if (!xmlContent || typeof xmlContent !== 'string') return [];
  const intervals = [];

  const eventRegex = /<event\b([^>]*)\/?>/gi;
  let match;

  while ((match = eventRegex.exec(xmlContent)) !== null) {
    const attrs = match[1];
    const startMatch = /\bstart_timestamp=["']([\d.]+)["']/i.exec(attrs);
    const stopMatch = /\bstop_timestamp=["']([\d.]+)["']/i.exec(attrs);

    if (startMatch && stopMatch) {
      let start = parseFloat(startMatch[1]);
      let stop = parseFloat(stopMatch[1]);

      // Epoch timestamp in milliseconds
      if (start > 1e11 && meetingStartTimeMs > 0) {
        start = Math.max(0, (start - meetingStartTimeMs) / 1000);
        stop = Math.max(0, (stop - meetingStartTimeMs) / 1000);
      } else if (start > 1e6) {
        // Relative milliseconds
        start = start / 1000;
        stop = stop / 1000;
      }

      if (!isNaN(start) && !isNaN(stop) && stop > start) {
        intervals.push({ start, stop });
      }
    }
  }

  intervals.sort((a, b) => a.start - b.start);
  return intervals;
}

/**
 * Fetches shapes.svg and parses presentation slide timeline
 * 
 * @param {string} baseUrl 
 * @param {object} [options]
 * @returns {Promise<{ hasSlides: boolean, slides: Array<object> }>}
 */
async function fetchSlideTimeline(baseUrl, options = {}) {
  try {
    const shapesUrl = `${baseUrl}shapes.svg`;
    const svgContent = await fetchUrlText(shapesUrl, options);
    const slides = parseShapesSvg(svgContent, baseUrl);
    return {
      hasSlides: slides.length > 0,
      slides
    };
  } catch (err) {
    return {
      hasSlides: false,
      slides: []
    };
  }
}

/**
 * Fetches deskshare.xml and parses active screen share intervals
 * 
 * @param {string} baseUrl 
 * @param {number} [meetingStartTimeMs]
 * @param {object} [options]
 * @returns {Promise<Array<{ start: number, stop: number }>>}
 */
async function fetchDeskshareTimeline(baseUrl, meetingStartTimeMs = 0, options = {}) {
  const candidates = [
    `${baseUrl}deskshare.xml`,
    `${baseUrl}deskshare/deskshare.xml`
  ];

  for (const url of candidates) {
    try {
      const xml = await fetchUrlText(url, options);
      const intervals = parseDeskshareXml(xml, meetingStartTimeMs);
      if (intervals.length > 0) {
        return intervals;
      }
    } catch {}
  }

  return [];
}

/**
 * Downloads slide images and maps local file paths to each slide entry
 * 
 * @param {Array<object>} slides 
 * @param {string} tempDir 
 * @param {object} [options]
 * @param {function} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<object>>} Updated slides array with localPath
 */
async function downloadPresentationSlides(slides, tempDir, options = {}) {
  if (!slides || slides.length === 0) return [];

  const slidesDir = path.join(tempDir, 'slides');
  if (!fs.existsSync(slidesDir)) {
    fs.mkdirSync(slidesDir, { recursive: true });
  }

  // Deduplicate URLs to download each unique image once
  const urlToLocalMap = new Map();
  let imgIndex = 0;

  for (const s of slides) {
    if (!urlToLocalMap.has(s.fullUrl)) {
      const ext = path.extname(new URL(s.fullUrl).pathname) || '.png';
      const localFile = path.join(slidesDir, `slide_${imgIndex++}${ext}`);
      urlToLocalMap.set(s.fullUrl, localFile);
    }
  }

  const uniqueTasks = Array.from(urlToLocalMap.entries());
  let completed = 0;

  for (const [remoteUrl, localPath] of uniqueTasks) {
    if (options.signal && options.signal.aborted) {
      throw new Error('Slide download cancelled');
    }

    try {
      await downloadFile(remoteUrl, localPath, {
        cookies: options.cookies,
        signal: options.signal
      });
    } catch (err) {
      console.warn(`Failed to download slide ${remoteUrl}:`, err.message);
    }

    completed++;
    if (options.onProgress) {
      options.onProgress({
        completed,
        total: uniqueTasks.length,
        percent: Math.round((completed / uniqueTasks.length) * 100)
      });
    }
  }

  // Map local paths back to slide objects
  const validSlides = [];
  for (const s of slides) {
    const local = urlToLocalMap.get(s.fullUrl);
    if (local && fs.existsSync(local) && fs.statSync(local).size > 0) {
      validSlides.push({
        ...s,
        localPath: local
      });
    }
  }

  return validSlides;
}

/**
 * Creates an ffconcat file that maps each slide to its active display duration
 * 
 * @param {Array<object>} slides Slides with localPath, in, and out
 * @param {number} totalDuration Total meeting duration in seconds
 * @param {string} tempDir 
 * @returns {string|null} Path to concat.txt
 */
function generateSlidesConcat(slides, totalDuration = 0, tempDir) {
  if (!slides || slides.length === 0) return null;

  const concatLines = ['ffconcat version 1.0'];

  for (let i = 0; i < slides.length; i++) {
    const current = slides[i];
    const next = slides[i + 1];

    let start = current.in;
    if (i === 0 && start > 0) {
      // If first slide starts after t=0, show it from t=0
      start = 0;
    }

    let end = current.out;
    if (next) {
      // Cover any gap between current and next slide
      end = Math.max(end, next.in);
    } else if (totalDuration > end) {
      // Cover until end of meeting
      end = totalDuration;
    }

    const duration = Math.max(0.1, end - start);
    // Escape single quotes for ffconcat
    const safePath = current.localPath.replace(/'/g, "'\\''");
    concatLines.push(`file '${safePath}'`);
    concatLines.push(`duration ${duration.toFixed(3)}`);
  }

  // Repeat last image at the end as required by ffconcat specification
  const lastSlide = slides[slides.length - 1];
  const lastSafePath = lastSlide.localPath.replace(/'/g, "'\\''");
  concatLines.push(`file '${lastSafePath}'`);

  const concatFilePath = path.join(tempDir, 'slides_concat.txt');
  fs.writeFileSync(concatFilePath, concatLines.join('\n'));
  return concatFilePath;
}

module.exports = {
  parseShapesSvg,
  parseDeskshareXml,
  fetchSlideTimeline,
  fetchDeskshareTimeline,
  downloadPresentationSlides,
  generateSlidesConcat
};
