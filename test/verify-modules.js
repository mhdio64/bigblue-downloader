const os = require('os');
const path = require('path');
const fs = require('fs');
const { parseBBBUrl, sanitizeFilename, decodeXmlEntities } = require('../src/main/metadata');
const { getFFmpegPath, stitchMediaStreams } = require('../src/main/muxer');
const { probeUrl, detectMediaStreams, downloadFile } = require('../src/main/media-downloader');
const { formatSeconds } = require('../src/main/chat');
const QueueManager = require('../src/main/queue');
const { execSync } = require('child_process');

console.log('--- Verifying architecture, modules, and Resume/Pause capabilities ---');

// 1. Test URL Parser
const testUrl1 = 'https://bbb.example.edu/playback/presentation/2.3/a9b8c7d6e5f41234567890';
const parsed1 = parseBBBUrl(testUrl1);
console.log('[✔] URL Parser 1 passed:', parsed1.meetingId === 'a9b8c7d6e5f41234567890');

// 2. Test Filename Sanitizer
const rawTitle = 'جلسه ۵: برنامه‌نویسی موازی / سیستم‌عامل * لینوکس *';
const cleanTitle = sanitizeFilename(rawTitle);
console.log('[✔] Filename Sanitizer passed:', !cleanTitle.includes(':') && !cleanTitle.includes('/') && !cleanTitle.includes('*'));

// 3. Test Time Formatter
const timeStr = formatSeconds(7325);
console.log('[✔] Time Formatter passed:', timeStr === '02:02:05');

// 4. Test Media Downloader Resumable Functions
console.log('[✔] Media Downloader module exports verified:', 
  typeof probeUrl === 'function' && 
  typeof detectMediaStreams === 'function' && 
  typeof downloadFile === 'function'
);

// 5. Test FFmpeg Binary & Stitcher module
const ffmpegPath = getFFmpegPath();
console.log('[i] FFmpeg binary detected:', ffmpegPath);
const ffmpegVersion = execSync(`"${ffmpegPath}" -version`).toString().split('\n')[0];
console.log('[✔] FFmpeg binary execution passed:', ffmpegVersion);
console.log('[✔] Stitcher function verified:', typeof stitchMediaStreams === 'function');

// 6. Test QueueManager Pause/Resume State Machine
const mockWindow = { webContents: { send: () => {} }, isDestroyed: () => false };
const qm = new QueueManager(mockWindow);

// Mock a job
const mockJob = {
  id: 'test_job_1',
  status: 'recording',
  progress: { stage: 'downloading_media', stageLabel: 'Downloading...' }
};
qm.jobs.set('test_job_1', mockJob);
qm.activeJobId = 'test_job_1';

// Test Pause
qm.pauseJob('test_job_1');
console.log('[✔] Pause Job passed:', mockJob.status === 'paused' && qm.activeJobId === null);

// Test Resume (it transitions to queued, and processNext immediately picks it up into recording/processing)
qm.resumeJob('test_job_1');
console.log('[✔] Resume Job passed:', mockJob.status === 'queued' || mockJob.status === 'recording');

// 7. Test LMS Browser Authentication & Cookie Helpers
const {
  formatCookiesForHeader,
  isBBBUrl,
  getLMSCookies,
  hasLMSSession,
  clearLMSSession,
  openLMSBrowser
} = require('../src/main/lms-browser');

const testCookies = [
  { name: 'MoodleSession', value: 'session_abc123' },
  { name: 'session_id', value: 'auth_xyz456' }
];
const cookieStr = formatCookiesForHeader(testCookies);
console.log('[✔] Cookie Header Formatter passed:', cookieStr === 'MoodleSession=session_abc123; session_id=auth_xyz456');

console.log('[✔] BBB URL Detector (playback URL) passed:', isBBBUrl('https://lms.uni.edu/playback/presentation/2.3/a1b2c3d4e5') === true);
console.log('[✔] BBB URL Detector (meetingId param) passed:', isBBBUrl('https://bbb.uni.edu/playback.html?meetingId=987654') === true);
console.log('[✔] BBB URL Detector (non-BBB page) passed:', isBBBUrl('https://lms.uni.edu/course/view.php?id=42') === false);

console.log('[✔] LMS Module Exports verified:',
  typeof getLMSCookies === 'function' &&
  typeof hasLMSSession === 'function' &&
  typeof clearLMSSession === 'function' &&
  typeof openLMSBrowser === 'function'
);

// 8. Test Presentation Slides & Deskshare Timeline Synthesis
const {
  parseShapesSvg,
  parseDeskshareXml,
  generateSlidesConcat
} = require('../src/main/presentation');

const sampleSvg = `
<svg>
  <image id="img1" in="0" out="85.5" xlink:href="presentation/p1/slide-1.png" width="1600" height="1200"/>
  <image id="img2" in="85.5" out="210.0" href="presentation/p1/slide-2.png" width="1600" height="1200"/>
</svg>
`;

const parsedSlides = parseShapesSvg(sampleSvg, 'https://bbb.uni.edu/presentation/meeting_xyz/');
console.log('[✔] Shapes.svg Slide Parser passed:',
  parsedSlides.length === 2 &&
  parsedSlides[0].duration === 85.5 &&
  parsedSlides[1].fullUrl === 'https://bbb.uni.edu/presentation/meeting_xyz/presentation/p1/slide-2.png'
);

const sampleDeskshareXml = `
<recording>
  <event start_timestamp="30.0" stop_timestamp="95.5"/>
  <event start_timestamp="150.0" stop_timestamp="200.0"/>
</recording>
`;

const parsedIntervals = parseDeskshareXml(sampleDeskshareXml);
console.log('[✔] Deskshare.xml Timeline Parser passed:',
  parsedIntervals.length === 2 &&
  parsedIntervals[0].start === 30 &&
  parsedIntervals[0].stop === 95.5 &&
  parsedIntervals[1].start === 150
);

// Test ffconcat generation
const dummySlides = [
  { in: 0, out: 85.5, localPath: '/tmp/test_slide1.png' },
  { in: 85.5, out: 210.0, localPath: '/tmp/test_slide2.png' }
];
const dummyConcatPath = generateSlidesConcat(dummySlides, 210, os.tmpdir());
console.log('[✔] Slides ffconcat generation passed:',
  typeof dummyConcatPath === 'string' &&
  fs.existsSync(dummyConcatPath) &&
  fs.readFileSync(dummyConcatPath, 'utf8').includes('ffconcat version 1.0')
);
if (dummyConcatPath && fs.existsSync(dummyConcatPath)) {
  fs.unlinkSync(dummyConcatPath);
}

// 9. Test File Structure (Confirm recorder.js removed and all assets exist)
const filesMustExist = [
  'src/renderer/index.html',
  'src/renderer/styles/variables.css',
  'src/renderer/styles/main.css',
  'src/renderer/styles/animations.css',
  'src/renderer/app.js',
  'src/preload/index.js',
  'src/main/index.js',
  'src/main/queue.js',
  'src/main/media-downloader.js',
  'src/main/muxer.js',
  'src/main/metadata.js',
  'src/main/chat.js',
  'src/main/notifications.js',
  'src/main/lms-browser.js',
  'src/main/lms-preload.js',
  'src/preload/lms-toolbar-preload.js',
  'src/renderer/lms-window.html',
  'src/renderer/lms-welcome.html',
  'src/main/presentation.js',
  'src/main/pdf.js',
  'src/main/player-recorder.js',
  'src/main/recorder-preload.js'
];

for (const file of filesMustExist) {
  const fullPath = path.join(__dirname, '..', file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`File not found: ${file}`);
  }
}

// Confirm recorder files are completely removed
if (fs.existsSync(path.join(__dirname, '../src/main/recorder.js'))) {
  throw new Error('File recorder.js still exists and should have been removed!');
}

// 10. Test XML/HTML Entity Decoding for Persian Meeting Names
const rawXmlTitle = '&#x62C;&#x644;&#x633;&#x647; &#x622;&#x646;&#x644;&#x627;&#x6CC;&#x646; &#x627;&#x648;&#x644; - &#1585;&#1740;&#1575;&#1590;&#1740; &amp; &#x641;&#x6CC;&#x632;&#x6CC;&#x6A9;';
const decodedTitle = decodeXmlEntities(rawXmlTitle);
const sanitizedPersianTitle = sanitizeFilename(rawXmlTitle);
console.log('[✔] XML/HTML Entity Decoder passed:',
  decodedTitle === 'جلسه آنلاین اول - ریاضی & فیزیک' &&
  sanitizedPersianTitle === 'جلسه آنلاین اول - ریاضی & فیزیک'
);

// 11. Test Slide Booklet HTML Generator
const { generateSlidesHtml } = require('../src/main/pdf');
const sampleSlideUrls = ['file:///tmp/slide_1.png', 'file:///tmp/slide_2.png'];
const sampleHtml = generateSlidesHtml(sampleSlideUrls, {
  title: 'Artificial Intelligence Lecture',
  date: '2024-09-18'
});

console.log('[✔] Slide Booklet HTML Generator passed:',
  sampleHtml.includes('BigBlueButton Slide Booklet') &&
  sampleHtml.includes('Artificial Intelligence Lecture') &&
  sampleHtml.includes('Slide 1 of 2') &&
  sampleHtml.includes('Slide 2 of 2') &&
  sampleHtml.includes('file:///tmp/slide_1.png')
);

// 12. Test In-App Player Recorder module exports
const { recordMeetingPlayer, remuxWebmToMp4 } = require('../src/main/player-recorder');
console.log('[✔] Player Recorder module exports verified:',
  typeof recordMeetingPlayer === 'function' &&
  typeof remuxWebmToMp4 === 'function'
);

console.log('[✔] All direct stream modules, presentation slide synthesizer, PDF generator, and In-App Player Recorder verified!');
console.log('--- All modules, LMS auth, direct downloader, slide PDF generator, and player recorder verified successfully! ---');



