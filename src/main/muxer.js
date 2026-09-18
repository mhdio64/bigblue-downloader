const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Gets path to the bundled or system FFmpeg binary
 * @returns {string}
 */
function getFFmpegPath() {
  try {
    let ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) {
      const unpacked = ffmpegStatic.split('app.asar').join('app.asar.unpacked');
      if (fs.existsSync(unpacked)) {
        return unpacked;
      }
      if (fs.existsSync(ffmpegStatic)) {
        return ffmpegStatic;
      }
    }
  } catch {
    // fallback
  }
  return 'ffmpeg';
}

/**
 * Parses time string HH:MM:SS.ms to seconds
 * @param {string} timeStr 
 * @returns {number}
 */
function parseFFmpegTime(timeStr) {
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const mins = parseFloat(parts[1]) || 0;
    const secs = parseFloat(parts[2]) || 0;
    return hours * 3600 + mins * 60 + secs;
  }
  return 0;
}

/**
 * Stitches downloaded BBB media tracks (slides, deskshare, webcams, audio) into a single cohesive MP4
 * 
 * @param {object} params
 * @param {string|null} [params.desksharePath] Path to downloaded deskshare.webm
 * @param {string|null} [params.webcamPath] Path to downloaded webcams.webm
 * @param {string|null} [params.audioPath] Path to separate audio file if present
 * @param {string|null} [params.slidesConcatPath] Path to generated ffconcat file for slides
 * @param {Array<{ start: number, stop: number }>} [params.deskshareIntervals] Active screen share time ranges
 * @param {string} params.outputPath Destination .mp4 file
 * @param {object} options
 * @param {number} options.totalDuration Meeting duration in seconds for progress calculation
 * @param {boolean} [options.includeWebcamVideo]
 * @param {function} [options.onProgress] (percent: number) => void
 * @param {AbortSignal} [options.signal] 
 * @returns {Promise<string>} Path to final MP4
 */
/**
 * Builds FFmpeg command line arguments for stitching BBB media tracks
 * 
 * @param {object} params
 * @param {string|null} [params.desksharePath]
 * @param {string|null} [params.webcamPath]
 * @param {string|null} [params.audioPath]
 * @param {string|null} [params.slidesConcatPath]
 * @param {Array<{ start: number, stop: number }>} [params.deskshareIntervals]
 * @param {string} params.outputPath
 * @param {object} options
 * @param {boolean} [options.includeWebcamVideo]
 * @returns {string[]}
 */
function buildFFmpegArgs({
  desksharePath,
  webcamPath,
  audioPath,
  slidesConcatPath,
  deskshareIntervals = [],
  outputPath
}, options = {}) {
  const args = ['-y'];
  let currentInputIndex = 0;
  const addInput = (...inputFlags) => {
    args.push(...inputFlags);
    const assigned = currentInputIndex;
    currentInputIndex++;
    return assigned;
  };

  // --- Scenario 1: Deskshare is present (Real Screen Share Stream) ---
  if (desksharePath) {
    const deskshareInput = addInput('-i', desksharePath); // Input 0: Deskshare
    let audioInputIndex = null;
    let webcamInputIndex = null;

    if (webcamPath) {
      webcamInputIndex = addInput('-i', webcamPath);
      audioInputIndex = webcamInputIndex;
    }

    if (audioPath) {
      const standaloneAudioInput = addInput('-i', audioPath);
      audioInputIndex = standaloneAudioInput; // Prefer standalone audio track
    }

    if (options.includeWebcamVideo && webcamInputIndex !== null) {
      args.push(
        '-filter_complex',
        `[${webcamInputIndex}:v]scale=360:-1[pip];[${deskshareInput}:v][pip]overlay=main_w-overlay_w-20:main_h-overlay_h-20[outv]`,
        '-map', '[outv]'
      );
    } else {
      args.push('-map', `${deskshareInput}:v`);
    }

    if (audioInputIndex !== null) {
      args.push('-map', `${audioInputIndex}:a?`);
    }
  }
  // --- Scenario 2: Only Slides exist (No Screen Share stream in meeting) ---
  else if (slidesConcatPath) {
    const slidesInput = addInput('-f', 'concat', '-safe', '0', '-i', slidesConcatPath); // Input 0: Slides

    let audioInputIndex = null;
    let webcamInputIndex = null;

    if (webcamPath) {
      webcamInputIndex = addInput('-i', webcamPath);
      audioInputIndex = webcamInputIndex;
    }

    if (audioPath) {
      const standaloneAudioInput = addInput('-i', audioPath);
      audioInputIndex = standaloneAudioInput;
    }

    const filterParts = [
      `[${slidesInput}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[basev]`
    ];

    if (options.includeWebcamVideo && webcamInputIndex !== null) {
      filterParts.push(`[${webcamInputIndex}:v]scale=360:-1[pip]`);
      filterParts.push(`[basev][pip]overlay=main_w-overlay_w-20:main_h-overlay_h-20[outv]`);
      args.push('-filter_complex', filterParts.join(';'));
      args.push('-map', '[outv]');
    } else {
      args.push('-filter_complex', filterParts.join(';'));
      args.push('-map', '[basev]');
    }

    if (audioInputIndex !== null) {
      args.push('-map', `${audioInputIndex}:a?`);
    }
  }
  // --- Scenario 5: Only Webcam ---
  else if (webcamPath) {
    const webcamInput = addInput('-i', webcamPath);

    if (audioPath) {
      const audioInput = addInput('-i', audioPath);
      args.push('-map', `${webcamInput}:v`, '-map', `${audioInput}:a?`);
    } else {
      args.push('-map', `${webcamInput}:v`, '-map', `${webcamInput}:a?`);
    }
  }
  // --- Scenario 6: Only Audio ---
  else if (audioPath) {
    const blackVideoInput = addInput('-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=1');
    const audioInput = addInput('-i', audioPath);
    args.push(
      '-shortest',
      '-map', `${blackVideoInput}:v`,
      '-map', `${audioInput}:a`
    );
  } else {
    throw new Error('No input media files found to compose video and audio.');
  }

  // Standard high-compatibility output flags (H.264 + AAC)
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath
  );

  return args;
}

/**
 * Stitches downloaded BBB media tracks (slides, deskshare, webcams, audio) into a single cohesive MP4
 * 
 * @param {object} params
 * @param {string|null} [params.desksharePath] Path to downloaded deskshare.webm
 * @param {string|null} [params.webcamPath] Path to downloaded webcams.webm
 * @param {string|null} [params.audioPath] Path to separate audio file if present
 * @param {string|null} [params.slidesConcatPath] Path to generated ffconcat file for slides
 * @param {Array<{ start: number, stop: number }>} [params.deskshareIntervals] Active screen share time ranges
 * @param {string} params.outputPath Destination .mp4 file
 * @param {object} options
 * @param {number} options.totalDuration Meeting duration in seconds for progress calculation
 * @param {boolean} [options.includeWebcamVideo]
 * @param {function} [options.onProgress] (percent: number) => void
 * @param {AbortSignal} [options.signal] 
 * @returns {Promise<string>} Path to final MP4
 */
function stitchMediaStreams(params, options = {}) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFFmpegPath();
    const totalDuration = options.totalDuration || 0;

    let args;
    try {
      args = buildFFmpegArgs(params, options);
    } catch (err) {
      return reject(err);
    }

    const child = spawn(ffmpegPath, args);

    let onAbort = null;
    const cleanupSignal = () => {
      if (options.signal && onAbort) {
        options.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };

    if (options.signal) {
      onAbort = () => {
        cleanupSignal();
        child.kill('SIGKILL');
        reject(new Error('Media composition was cancelled.'));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    let stderrBuffer = '';

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;

      const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
      if (timeMatch && totalDuration > 0 && options.onProgress) {
        const currentSecs = parseFFmpegTime(timeMatch[1]);
        const percent = Math.min(99, Math.round((currentSecs / totalDuration) * 100));
        options.onProgress(percent);
      }
    });

    child.on('close', (code) => {
      cleanupSignal();
      if (code === 0) {
        if (options.onProgress) options.onProgress(100);
        resolve(params.outputPath);
      } else {
        reject(new Error(`FFmpeg composition error (code ${code}): ${stderrBuffer.slice(-400)}`));
      }
    });

    child.on('error', (err) => {
      cleanupSignal();
      reject(new Error(`Failed to execute FFmpeg binary: ${err.message}`));
    });
  });
}

module.exports = {
  getFFmpegPath,
  buildFFmpegArgs,
  stitchMediaStreams
};
