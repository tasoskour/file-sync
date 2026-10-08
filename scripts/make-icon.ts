import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

async function main() {
  const svg = await fsp.readFile(path.join('ui', 'public', 'icon.svg'));
  const images = await Promise.all([16, 24, 32, 48, 64, 128, 256].map(size => sharp(svg).resize(size, size).png().toBuffer()));
  await fsp.mkdir('assets', { recursive: true });
  await fsp.writeFile(path.join('assets', 'FileSync.ico'), await pngToIco(images));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
