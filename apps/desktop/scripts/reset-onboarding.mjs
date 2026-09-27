import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const configPath = path.join(os.homedir(), '.chatealm', 'config.json');

if (!fs.existsSync(configPath)) {
  console.log('No config file found at', configPath);
  console.log('The wizard will show on first launch anyway.');
  process.exit(0);
}

const raw = fs.readFileSync(configPath, 'utf8');
const cfg = JSON.parse(raw);
cfg.onboarding = { completed: false, completed_at: null };
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
console.log('Onboarding reset. The setup wizard will appear on next launch.');
