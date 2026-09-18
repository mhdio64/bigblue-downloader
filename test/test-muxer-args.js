const { buildFFmpegArgs } = require('../src/main/muxer');

function runTests() {
  console.log('--- Testing FFmpeg Muxer Input Index Mapping & Argument Generation ---');

  // Test 1: Full session with screen share, webcam PIP, and dedicated audio
  const args1 = buildFFmpegArgs({
    desksharePath: '/tmp/raw_deskshare.webm',
    webcamPath: '/tmp/raw_webcam.webm',
    audioPath: '/tmp/raw_audio.ogg',
    outputPath: '/tmp/output_full.mp4'
  }, { includeWebcamVideo: true });

  console.log('Generated Args (Scenario 1):', args1.join(' '));

  // Verify inputs in order:
  // Input 0: desksharePath
  // Input 1: webcamPath
  // Input 2: audioPath
  const inputFiles = [];
  for (let i = 0; i < args1.length; i++) {
    if (args1[i] === '-i') {
      inputFiles.push(args1[i + 1]);
    }
  }
  console.log('[✔] Inputs in order:', inputFiles);
  if (
    inputFiles[0] !== '/tmp/raw_deskshare.webm' ||
    inputFiles[1] !== '/tmp/raw_webcam.webm' ||
    inputFiles[2] !== '/tmp/raw_audio.ogg'
  ) {
    throw new Error(`Unexpected inputs: ${JSON.stringify(inputFiles)}`);
  }

  // Extract all -map arguments
  const maps1 = [];
  for (let i = 0; i < args1.length; i++) {
    if (args1[i] === '-map') {
      maps1.push(args1[i + 1]);
    }
  }
  console.log('[✔] Scenario 1 Maps:', maps1);
  if (!maps1.includes('[outv]') || !maps1.includes('2:a?')) {
    throw new Error(`Expected [outv] and integer audio map '2:a?', got: ${JSON.stringify(maps1)}`);
  }

  // Verify NO non-integer indices exist in -map
  for (const m of maps1) {
    if (m.includes('.')) {
      throw new Error(`Found fractional input index in -map: ${m}`);
    }
  }

  // Test 2: Only Slides + Dedicated Audio (when no screen share video exists)
  const args2 = buildFFmpegArgs({
    slidesConcatPath: '/tmp/slides_concat.txt',
    audioPath: '/tmp/raw_audio.ogg',
    outputPath: '/tmp/output_slides_only.mp4'
  });
  const maps2 = [];
  for (let i = 0; i < args2.length; i++) {
    if (args2[i] === '-map') maps2.push(args2[i + 1]);
  }
  console.log('[✔] Scenario 2 Maps (Slides + Audio):', maps2);
  if (!maps2.includes('[basev]') && !maps2.includes('[outv]')) {
    throw new Error(`Expected visual stream map, got: ${JSON.stringify(maps2)}`);
  }
  if (!maps2.includes('1:a?')) {
    throw new Error(`Expected audio map '1:a?', got: ${JSON.stringify(maps2)}`);
  }

  // Test 3: Deskshare + Webcam (without separate audio track, webcam provides audio)
  const args3 = buildFFmpegArgs({
    desksharePath: '/tmp/raw_deskshare.webm',
    webcamPath: '/tmp/raw_webcam.webm',
    outputPath: '/tmp/output_ds_wc.mp4'
  }, { includeWebcamVideo: true });
  const maps3 = [];
  for (let i = 0; i < args3.length; i++) {
    if (args3[i] === '-map') maps3.push(args3[i + 1]);
  }
  console.log('[✔] Scenario 3 Maps (Deskshare + Webcam):', maps3);
  if (!maps3.includes('[outv]') || !maps3.includes('1:a?')) {
    throw new Error(`Expected [outv] and '1:a?', got: ${JSON.stringify(maps3)}`);
  }

  // Test 4: Deskshare only (with separate audio)
  const args4 = buildFFmpegArgs({
    desksharePath: '/tmp/raw_deskshare.webm',
    audioPath: '/tmp/raw_audio.ogg',
    outputPath: '/tmp/output_ds_audio.mp4'
  });
  const maps4 = [];
  for (let i = 0; i < args4.length; i++) {
    if (args4[i] === '-map') maps4.push(args4[i + 1]);
  }
  console.log('[✔] Scenario 4 Maps (Deskshare + Audio):', maps4);
  if (!maps4.includes('0:v') || !maps4.includes('1:a?')) {
    throw new Error(`Expected '0:v' and '1:a?', got: ${JSON.stringify(maps4)}`);
  }

  console.log('\n========================================');
  console.log('✔ All FFmpeg index and arg tests PASSED!');
  console.log('========================================');
}

runTests();
