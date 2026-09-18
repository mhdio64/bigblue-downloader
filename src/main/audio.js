const fs = require('fs');
const https = require('https');
const http = require('http');

/**
 * Checks which audio candidate URL is available on the BBB server
 * @param {string} baseUrl e.g. https://domain/presentation/<id>/
 * @returns {Promise<string>} Available audio stream URL
 */
async function findAudioStreamUrl(baseUrl) {
  const candidates = [
    `${baseUrl}video/webcams.webm`,
    `${baseUrl}video/webcams.mp4`,
    `${baseUrl}audio/audio.webm`,
    `${baseUrl}audio/audio.ogg`
  ];

  for (const url of candidates) {
    const exists = await checkUrlExists(url);
    if (exists) {
      return url;
    }
  }

  // Fallback to webcams.webm if head checks fail or are blocked
  return `${baseUrl}video/webcams.webm`;
}

/**
 * Checks if a remote URL returns 200 via HEAD request
 * @param {string} url 
 * @returns {Promise<boolean>}
 */
function checkUrlExists(url) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request(url, { method: 'HEAD', timeout: 7000 }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          checkUrlExists(res.headers.location).then(resolve);
        } else {
          resolve(false);
        }
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

/**
 * Downloads audio stream to target file with progress reporting and cancellation
 * @param {string} streamUrl 
 * @param {string} targetPath 
 * @param {object} options 
 * @param {function} options.onProgress (percent: number, downloadedBytes: number, totalBytes: number) => void
 * @param {AbortSignal} options.signal 
 * @returns {Promise<string>} path to downloaded audio file
 */
function downloadAudioStream(streamUrl, targetPath, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(streamUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const fileStream = fs.createWriteStream(targetPath);

    const req = client.get(streamUrl, { headers: { 'User-Agent': 'BigBlueButton-Downloader/1.0' } }, (res) => {
      // Handle redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fileStream.close();
        fs.unlink(targetPath, () => {});
        return downloadAudioStream(res.headers.location, targetPath, options).then(resolve, reject);
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        fileStream.close();
        fs.unlink(targetPath, () => {});
        return reject(new Error(`Audio download stopped with status code ${res.statusCode}.`));
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        fileStream.write(chunk);
        if (options.onProgress) {
          const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
          options.onProgress(percent, downloadedBytes, totalBytes);
        }
      });

      res.on('end', () => {
        fileStream.end(() => resolve(targetPath));
      });

      res.on('error', (err) => {
        fileStream.close();
        fs.unlink(targetPath, () => {});
        reject(err);
      });
    });

    req.on('error', (err) => {
      fileStream.close();
      fs.unlink(targetPath, () => {});
      reject(new Error(`Audio stream download error: ${err.message}`));
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        req.destroy();
        fileStream.close();
        fs.unlink(targetPath, () => {});
        reject(new Error('Audio download was cancelled.'));
      });
    }
  });
}

module.exports = {
  findAudioStreamUrl,
  downloadAudioStream
};
