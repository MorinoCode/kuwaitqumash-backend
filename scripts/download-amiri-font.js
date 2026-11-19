import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.join(__dirname, '..', 'fonts');

if (!fs.existsSync(FONTS_DIR)) {
  fs.mkdirSync(FONTS_DIR, { recursive: true });
}

const fontsToDownload = [
  {
    name: 'Amiri-Regular.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/amiri/Amiri-Regular.ttf',
  },
  {
    name: 'Amiri-Bold.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/amiri/Amiri-Bold.ttf',
  },
];

const downloadFont = ({ name, url }) => {
  return new Promise((resolve, reject) => {
    const dest = path.join(FONTS_DIR, name);
    const file = fs.createWriteStream(dest);

    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          try {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
          } catch (e) {
            void e;
          }
          return reject(new Error(`Failed to download ${name}: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`${name} saved to ${dest}`);
          resolve();
        });
      })
      .on('error', (err) => {
        try {
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
        } catch (e) {
          void e;
        }
        reject(err);
      });
  });
};

(async () => {
  try {
    for (const font of fontsToDownload) {
      await downloadFont(font);
    }
    console.log('All Amiri fonts downloaded successfully.');
  } catch (err) {
    console.error('Error downloading Amiri fonts:', err.message);
    process.exit(1);
  }
})();
