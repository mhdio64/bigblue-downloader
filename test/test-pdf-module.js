const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { generateSlidePdf } = require('../src/main/pdf');

app.whenReady().then(async () => {
  try {
    const slidesDir = '/tmp/bbb_job_1789739911795_2h3w0/slides';
    const slideFiles = fs.readdirSync(slidesDir)
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      })
      .map(f => path.join(slidesDir, f));

    console.log(`Testing generateSlidePdf with ${slideFiles.length} slides...`);

    const outPdf = '/tmp/module_test_booklet.pdf';
    const tempDir = '/tmp';

    const result = await generateSlidePdf(slideFiles, {
      title: 'جلسه اول - شبکه و سیستم‌های توزیع‌شده',
      date: '۱۴۰۳/۰۶/۲۸',
      durationFormatted: '02:54:15'
    }, outPdf, tempDir);

    if (result && fs.existsSync(result) && fs.statSync(result).size > 100000) {
      console.log(`[✔] generateSlidePdf test PASSED! Generated PDF size: ${fs.statSync(result).size} bytes at ${result}`);
      app.quit();
    } else {
      throw new Error(`PDF generation failed or file too small: ${result}`);
    }
  } catch (err) {
    console.error('Test error:', err);
    app.exit(1);
  }
});
