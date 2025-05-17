import path from 'path';

let lastProgress = 0;

// Callback function for download progress
export function downloadProgressCallback({ file, progress, total }) {
  if (progress >= 0 && total > 0) {
    if (progress !== lastProgress) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      const fileName = file ? path.basename(file) : 'Model file';
      process.stdout.write(`Downloading ${fileName}: ${progress.toFixed(2)}%`);
      lastProgress = progress;
    }

    if (progress === 100) {
      process.stdout.write(' - Done\n');
      lastProgress = 0;
    }
  } else if (file) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`Downloading ${path.basename(file)}...`);
  }
}
