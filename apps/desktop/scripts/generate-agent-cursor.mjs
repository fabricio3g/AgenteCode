// Produces the Win32 cursor resource from the browser cursor source. No GUI.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const source = fs.readFileSync(new URL('../shared/agent-pointer.ts', import.meta.url), 'utf8');
const match = source.match(/AGENT_POINTER_SVG = '([^']+)';/);
if (!match) throw new Error('Agent pointer SVG not found.');
const svg = match[1].replace('width="25" height="30"', 'width="32" height="32"');
const { data } = await sharp(Buffer.from(svg)).resize(32, 32).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const resource = Buffer.alloc(4 + 40 + 4096 + 128);
resource.writeUInt16LE(4, 0); resource.writeUInt16LE(3, 2);
resource.writeUInt32LE(40, 4); resource.writeInt32LE(32, 8); resource.writeInt32LE(64, 12);
resource.writeUInt16LE(1, 16); resource.writeUInt16LE(32, 18); resource.writeUInt32LE(4096, 24);
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const input = (y * 32 + x) * 4, output = 44 + ((31 - y) * 32 + x) * 4;
  resource[output] = data[input + 2]; resource[output + 1] = data[input + 1];
  resource[output + 2] = data[input]; resource[output + 3] = data[input + 3];
  if (!data[input + 3]) resource[44 + 4096 + (31 - y) * 4 + (x >> 3)] |= 128 >> (x % 8);
}
const target = new URL('../../../crates/agente-computer/src/cursor.bin', import.meta.url);
fs.writeFileSync(target, resource);
console.log(`Generated ${fileURLToPath(target)}`);
