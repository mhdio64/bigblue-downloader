const https = require('https');
const http = require('http');

/**
 * Extracts base meeting presentation URL and meetingId from various BBB link formats.
 * e.g., https://bbb.example.com/playback/presentation/2.3/a1b2c3d4e5...
 *       https://bbb.example.com/playback/presentation/2.0/playback.html?meetingId=a1b2c3d4e5...
 * @param {string} rawUrl 
 * @returns {{ baseUrl: string, meetingId: string, playbackUrl: string }}
 */
function parseBBBUrl(rawUrl) {
  const parsed = new URL(rawUrl.trim());
  const pathParts = parsed.pathname.split('/').filter(Boolean);

  let meetingId = '';
  // Check query string for meetingId
  if (parsed.searchParams.has('meetingId')) {
    meetingId = parsed.searchParams.get('meetingId');
  } else {
    // Check if the last path part is the meetingId
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart && lastPart !== 'playback.html') {
      meetingId = lastPart;
    } else if (pathParts.length >= 2) {
      meetingId = pathParts[pathParts.length - 2];
    }
  }

  if (!meetingId) {
    throw new Error('Meeting ID was not found in the provided URL.');
  }

  // Base presentation asset URL: e.g. https://domain/presentation/<meetingId>/
  const presentationBaseUrl = `${parsed.origin}/presentation/${meetingId}/`;
  
  return {
    baseUrl: presentationBaseUrl,
    meetingId,
    playbackUrl: rawUrl.trim()
  };
}

function fetchUrlTextSingle(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const headers = { 
      'User-Agent': 'BigBlueButton-Downloader/1.0',
      ...(options.headers || {})
    };

    if (options.cookies) {
      headers['Cookie'] = options.cookies;
    }
    try {
      headers['Referer'] = new URL(url).origin;
    } catch {}

    const req = client.get(url, { headers }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return resolve(fetchUrlTextSingle(redirectUrl, options));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Server responded with status ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', err => reject(err));
    });

    req.on('error', (err) => reject(new Error(`Server communication error: ${err.message}`)));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Server response timeout.'));
    });
  });
}

/**
 * Simple HTTP/HTTPS GET helper with automatic retry for transient network glitches
 * @param {string} url 
 * @param {object} [options]
 * @returns {Promise<string>}
 */
async function fetchUrlText(url, options = {}) {
  const maxRetries = options.maxRetries || 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchUrlTextSingle(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  throw lastErr;
}

/**
 * Decodes XML and HTML entities, including numeric decimal and hexadecimal entities
 * Commonly used by BigBlueButton metadata.xml for Unicode titles (e.g. Persian/Arabic/CJK)
 * e.g., &#x62C;&#x644;&#x633;&#x647; -> Unicode string
 * @param {string} str 
 * @returns {string}
 */
function decodeXmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  let prev = '';
  let decoded = str;
  let iterations = 0;
  while (decoded !== prev && iterations < 3) {
    prev = decoded;
    iterations++;
    decoded = decoded
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
        try {
          return String.fromCodePoint(parseInt(hex, 16));
        } catch {
          return _;
        }
      })
      .replace(/&#([0-9]+);/g, (_, dec) => {
        try {
          return String.fromCodePoint(parseInt(dec, 10));
        } catch {
          return _;
        }
      })
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return decoded;
}

/**
 * Parses XML tags using simple robust regex (no heavy external XML parser dependency)
 * @param {string} xml 
 * @param {string} tag 
 * @returns {string}
 */
function extractXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXmlEntities(match[1].trim()) : '';
}

/**
 * Cleans string from special characters to form a valid Linux filename
 * @param {string} str 
 * @returns {string}
 */
function sanitizeFilename(str) {
  return decodeXmlEntities(str)
    .replace(/[/\\?%*:|"<>]/g, '-') // Replace illegal chars with dash
    .replace(/[\x00-\x1f\x80-\x9f]/g, '') // Remove control characters
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();
}

/**
 * Fetches and parses metadata.xml from BigBlueButton server
 * @param {string} rawUrl 
 * @returns {Promise<{ meetingId: string, title: string, date: string, durationSeconds: number, baseUrl: string, playbackUrl: string }>}
 */
async function getMeetingMetadata(rawUrl, options = {}) {
  const { baseUrl, meetingId, playbackUrl } = parseBBBUrl(rawUrl);
  const metadataUrl = `${baseUrl}metadata.xml`;

  let xmlContent = '';
  try {
    xmlContent = await fetchUrlText(metadataUrl, options);
  } catch (err) {
    // If /presentation/<id>/metadata.xml fails, try alternative path directly relative to playback url
    const altUrl = playbackUrl.replace(/\/playback\.html.*$/, '') + '/metadata.xml';
    try {
      xmlContent = await fetchUrlText(altUrl, options);
    } catch {
      throw new Error(`Failed to fetch metadata.xml: ${err.message}`);
    }
  }

  // Extract meeting name
  let title = extractXmlTag(xmlContent, 'meetingName') || 
              extractXmlTag(xmlContent, 'meeting_name') || 
              `BBB_Meeting_${meetingId.substring(0, 8)}`;
  title = sanitizeFilename(title);

  // Extract start time & format date
  let date = new Date().toISOString().split('T')[0];
  const startTimeRaw = extractXmlTag(xmlContent, 'start_time') || extractXmlTag(xmlContent, 'startTime');
  if (startTimeRaw) {
    const timestamp = parseInt(startTimeRaw, 10);
    if (!isNaN(timestamp)) {
      const d = new Date(timestamp);
      date = d.toISOString().split('T')[0];
    }
  }

  // Extract duration (in milliseconds or seconds)
  let durationSeconds = 0;
  const durationRaw = extractXmlTag(xmlContent, 'playback') || xmlContent;
  const durationMatch = durationRaw.match(/<duration[^>]*>(\d+)<\/duration>/i);
  if (durationMatch) {
    const durVal = parseInt(durationMatch[1], 10);
    // BBB usually specifies duration in milliseconds
    durationSeconds = durVal > 10000 ? Math.floor(durVal / 1000) : durVal;
  }

  return {
    meetingId,
    title,
    date,
    durationSeconds,
    baseUrl,
    playbackUrl
  };
}

module.exports = {
  parseBBBUrl,
  fetchUrlText,
  decodeXmlEntities,
  sanitizeFilename,
  getMeetingMetadata
};
