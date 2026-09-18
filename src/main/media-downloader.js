const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

/**
 * Checks if a remote URL exists using HEAD request
 * @param {string} url 
 * @returns {Promise<{ exists: boolean, size: number, finalUrl: string }>}
 */
function probeUrl(url, options = {}) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const headers = { 'User-Agent': 'BigBlueButton-Downloader/1.0' };
      if (options.cookies) {
        headers['Cookie'] = options.cookies;
      }
      try {
        headers['Referer'] = parsed.origin;
      } catch {}

      const req = client.request(url, { method: 'HEAD', headers, timeout: 7000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          return probeUrl(redirectUrl, options).then(resolve);
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const size = parseInt(res.headers['content-length'] || '0', 10);
          resolve({ exists: true, size, finalUrl: url });
        } else {
          resolve({ exists: false, size: 0, finalUrl: url });
        }
      });
      req.on('error', () => resolve({ exists: false, size: 0, finalUrl: url }));
      req.on('timeout', () => { req.destroy(); resolve({ exists: false, size: 0, finalUrl: url }); });
      req.end();
    } catch {
      resolve({ exists: false, size: 0, finalUrl: url });
    }
  });
}

/**
 * Detects all available media files (deskshare, webcam, audio) on the BBB server
 * @param {string} baseUrl e.g. https://domain/presentation/<id>/
 * @returns {Promise<{ deskshareUrl: string|null, webcamUrl: string|null, audioUrl: string|null }>}
 */
async function detectMediaStreams(baseUrl, options = {}) {
  const result = {
    deskshareUrl: null,
    webcamUrl: null,
    audioUrl: null
  };

  // 1. Check deskshare (screen share video)
  const deskshareCandidates = [
    `${baseUrl}deskshare/deskshare.webm`,
    `${baseUrl}deskshare/deskshare.mp4`
  ];
  for (const candidate of deskshareCandidates) {
    const probe = await probeUrl(candidate, options);
    if (probe.exists) {
      result.deskshareUrl = probe.finalUrl;
      break;
    }
  }

  // 2. Check webcam (webcam video + embedded audio)
  const webcamCandidates = [
    `${baseUrl}video/webcams.webm`,
    `${baseUrl}video/webcams.mp4`
  ];
  for (const candidate of webcamCandidates) {
    const probe = await probeUrl(candidate, options);
    if (probe.exists) {
      result.webcamUrl = probe.finalUrl;
      break;
    }
  }

  // 3. Check standalone audio track if available
  const audioCandidates = [
    `${baseUrl}audio/audio.webm`,
    `${baseUrl}audio/audio.ogg`
  ];
  for (const candidate of audioCandidates) {
    const probe = await probeUrl(candidate, options);
    if (probe.exists) {
      result.audioUrl = probe.finalUrl;
      break;
    }
  }

  // 4. Check presentation slides (shapes.svg)
  const shapesProbe = await probeUrl(`${baseUrl}shapes.svg`, options);
  result.hasSlides = shapesProbe.exists;

  return result;
}

/**
 * Sleeps for specified milliseconds, cleanly abortable via AbortSignal
 * @param {number} ms 
 * @param {AbortSignal} [signal] 
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('DOWNLOAD_ABORTED'));
    let onAbort = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('DOWNLOAD_ABORTED'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Performs a single HTTP GET download attempt with Range header support
 * @param {string} fileUrl 
 * @param {string} targetPath 
 * @param {object} options 
 * @returns {Promise<string>}
 */
function downloadChunk(fileUrl, targetPath, options = {}) {
  return new Promise(async (resolve, reject) => {
    if (options.signal && options.signal.aborted) {
      return reject(new Error('DOWNLOAD_ABORTED'));
    }

    let req = null;
    let fileStream = null;
    let inactivityTimer = null;
    let onAbort = null;

    const cleanup = () => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
      if (options.signal && onAbort) {
        options.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };

    if (options.signal) {
      onAbort = () => {
        cleanup();
        if (req) req.destroy();
        if (fileStream) fileStream.close();
        // Preserves partial bytes for resume
        reject(new Error('DOWNLOAD_ABORTED'));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // 1. Probe remote file size
    let remoteSize = options.knownRemoteSize || 0;
    if (!remoteSize) {
      try {
        const probe = await probeUrl(fileUrl, options);
        remoteSize = probe.size;
      } catch {
        remoteSize = 0;
      }
    }

    // 2. Check local file size if partial download exists
    let existingBytes = 0;
    if (fs.existsSync(targetPath)) {
      try {
        existingBytes = fs.statSync(targetPath).size;
      } catch {
        existingBytes = 0;
      }
    }

    // If already completely downloaded, skip
    if (remoteSize > 0 && existingBytes >= remoteSize) {
      cleanup();
      if (options.onProgress) {
        options.onProgress({
          downloadedBytes: remoteSize,
          totalBytes: remoteSize,
          percent: 100,
          speedStr: 'Complete'
        });
      }
      return resolve(targetPath);
    }

    const parsed = new URL(fileUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    const headers = { 'User-Agent': 'BigBlueButton-Downloader/1.0' };
    if (options.cookies) {
      headers['Cookie'] = options.cookies;
    }
    try {
      headers['Referer'] = parsed.origin;
    } catch {}

    let isResuming = false;
    if (existingBytes > 0) {
      headers['Range'] = `bytes=${existingBytes}-`;
      isResuming = true;
    }

    fileStream = fs.createWriteStream(targetPath, { flags: isResuming ? 'a' : 'w' });
    let downloadedBytes = existingBytes;
    let totalBytes = remoteSize || 0;

    let startTime = Date.now();
    let lastTime = startTime;
    let lastBytes = downloadedBytes;
    let currentSpeed = '';

    function resetInactivityTimer() {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        cleanup();
        if (req) req.destroy(new Error('Data transfer timed out (idle connection)'));
      }, 25000); // 25s inactivity timeout
    }

    req = client.get(fileUrl, { headers }, (res) => {
      resetInactivityTimer();

      // Handle redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        cleanup();
        fileStream.close();
        const redirectUrl = new URL(res.headers.location, fileUrl).href;
        return downloadChunk(redirectUrl, targetPath, options).then(resolve, reject);
      }

      // Handle 416 (Range Not Satisfiable)
      if (res.statusCode === 416) {
        cleanup();
        fileStream.close();
        if (existingBytes >= remoteSize && remoteSize > 0) {
          return resolve(targetPath);
        }
        fs.unlink(targetPath, () => {});
        return downloadChunk(fileUrl, targetPath, options).then(resolve, reject);
      }

      // If server does not support Range (returns 200 instead of 206)
      if (res.statusCode === 200 && isResuming) {
        fileStream.close();
        fileStream = fs.createWriteStream(targetPath, { flags: 'w' });
        downloadedBytes = 0;
        existingBytes = 0;
      } else if (res.statusCode !== 200 && res.statusCode !== 206) {
        cleanup();
        fileStream.close();
        return reject(new Error(`Download failed with status ${res.statusCode} (${fileUrl})`));
      }

      // Calculate total bytes from Content-Range or Content-Length
      if (res.headers['content-range']) {
        const parts = res.headers['content-range'].split('/');
        if (parts[1]) {
          totalBytes = parseInt(parts[1], 10);
        }
      } else if (res.headers['content-length']) {
        totalBytes = existingBytes + parseInt(res.headers['content-length'], 10);
      }

      res.on('data', (chunk) => {
        resetInactivityTimer();
        downloadedBytes += chunk.length;
        fileStream.write(chunk);

        const now = Date.now();
        if (now - lastTime >= 500) {
          const timeDiff = (now - lastTime) / 1000;
          const bytesDiff = downloadedBytes - lastBytes;
          const bytesPerSec = bytesDiff / timeDiff;

          if (bytesPerSec > 1024 * 1024) {
            currentSpeed = `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
          } else {
            currentSpeed = `${Math.round(bytesPerSec / 1024)} KB/s`;
          }

          lastTime = now;
          lastBytes = downloadedBytes;

          if (options.onProgress) {
            const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
            options.onProgress({
              downloadedBytes,
              totalBytes,
              percent,
              speedStr: currentSpeed
            });
          }
        }
      });

      res.on('end', () => {
        cleanup();
        fileStream.end(() => resolve(targetPath));
      });

      res.on('error', (err) => {
        cleanup();
        fileStream.close();
        reject(err);
      });
    });

    req.setTimeout(18000, () => {
      cleanup();
      req.destroy(new Error('Connection timed out'));
    });

    req.on('error', (err) => {
      cleanup();
      if (fileStream) fileStream.close();
      reject(new Error(`Network error: ${err.message}`));
    });
  });
}

/**
 * Downloads a single remote file with automatic network reconnection and HTTP Range resume support.
 * Automatically waits and retries for a reasonable duration (up to ~3 minutes) if internet connection drops.
 * 
 * @param {string} fileUrl 
 * @param {string} targetPath 
 * @param {object} options 
 * @param {number} [options.maxRetries=15] Max retry attempts before timing out
 * @param {function} [options.onProgress] ({ downloadedBytes, totalBytes, percent, speedStr, label }) => void
 * @param {AbortSignal} [options.signal] 
 * @returns {Promise<string>} targetPath
 */
async function downloadFile(fileUrl, targetPath, options = {}) {
  const maxRetries = options.maxRetries || 15;
  let attempt = 0;
  let delay = 3000;

  while (true) {
    if (options.signal && options.signal.aborted) {
      throw new Error('DOWNLOAD_ABORTED');
    }

    try {
      return await downloadChunk(fileUrl, targetPath, options);
    } catch (err) {
      if (err.message === 'DOWNLOAD_ABORTED' || (options.signal && options.signal.aborted)) {
        throw err;
      }

      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`Network connection lost. Timeout after ${maxRetries} consecutive retries (${err.message}). Downloaded files are preserved; click Resume once internet reconnects.`);
      }

      const waitSec = Math.round(delay / 1000);
      console.warn(`Download interrupted (${err.message}). Reconnecting in ${waitSec}s (Attempt ${attempt}/${maxRetries})...`);

      if (options.onProgress) {
        let existingBytes = 0;
        if (fs.existsSync(targetPath)) {
          try { existingBytes = fs.statSync(targetPath).size; } catch {}
        }
        options.onProgress({
          downloadedBytes: existingBytes,
          speedStr: 'Reconnecting...',
          label: `Connection lost. Reconnecting in ${waitSec}s (${attempt}/${maxRetries})...`
        });
      }

      await sleep(delay, options.signal);
      delay = Math.min(15000, Math.round(delay * 1.5));
    }
  }
}

/**
 * Downloads all relevant media files for a meeting into the temp folder
 * @param {string} baseUrl e.g. https://domain/presentation/<id>/
 * @param {string} tempDir 
 * @param {object} options 
 * @param {function} options.onProgress ({ label, percent, speedStr }) => void
 * @param {AbortSignal} options.signal 
 * @returns {Promise<{ desksharePath: string|null, webcamPath: string|null, audioPath: string|null }>}
 */
async function downloadMeetingMedia(baseUrl, tempDir, options = {}) {
  const streams = await detectMediaStreams(baseUrl, options);

  if (!streams.deskshareUrl && !streams.webcamUrl && !streams.audioUrl && !streams.hasSlides) {
    throw new Error('No audio, video, or presentation slide files were found for this meeting.');
  }

  const downloadedPaths = {
    desksharePath: null,
    webcamPath: null,
    audioPath: null
  };

  // List of files to download
  const tasks = [];
  if (streams.deskshareUrl) {
    const ext = streams.deskshareUrl.endsWith('.mp4') ? '.mp4' : '.webm';
    const desksharePath = path.join(tempDir, `raw_deskshare${ext}`);
    tasks.push({
      key: 'desksharePath',
      label: 'Downloading screen share (Deskshare)',
      url: streams.deskshareUrl,
      targetPath: desksharePath
    });
  }

  if (streams.webcamUrl) {
    const ext = streams.webcamUrl.endsWith('.mp4') ? '.mp4' : '.webm';
    const webcamPath = path.join(tempDir, `raw_webcam${ext}`);
    tasks.push({
      key: 'webcamPath',
      label: 'Downloading teacher webcam',
      url: streams.webcamUrl,
      targetPath: webcamPath
    });
  }

  if (streams.audioUrl) {
    const ext = streams.audioUrl.endsWith('.ogg') ? '.ogg' : '.webm';
    const audioPath = path.join(tempDir, `raw_audio${ext}`);
    tasks.push({
      key: 'audioPath',
      label: 'Downloading audio stream',
      url: streams.audioUrl,
      targetPath: audioPath
    });
  }

  // Download files sequentially with total progress reporting
  const totalTasks = tasks.length;
  for (let i = 0; i < totalTasks; i++) {
    const task = tasks[i];
    if (options.signal && options.signal.aborted) {
      throw new Error('Download was aborted.');
    }

    await downloadFile(task.url, task.targetPath, {
      cookies: options.cookies,
      signal: options.signal,
      onProgress: (info) => {
        if (options.onProgress) {
          const percentVal = typeof info.percent === 'number' ? info.percent : 0;
          const taskProgress = (i / totalTasks) * 100 + (percentVal / totalTasks);
          const currentLabel = info.label || `${task.label} (${percentVal}%)`;
          options.onProgress({
            label: currentLabel,
            percent: Math.round(taskProgress),
            speedStr: info.speedStr || ''
          });
        }
      }
    });

    downloadedPaths[task.key] = task.targetPath;
  }

  return downloadedPaths;
}

module.exports = {
  probeUrl,
  detectMediaStreams,
  downloadFile,
  downloadMeetingMedia
};
