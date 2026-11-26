import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');

function resolveStamp(electronExe, icoPath, version) {
  const exeStat = fs.statSync(electronExe);
  const icoStat = fs.statSync(icoPath);
  return {
    electronSize: exeStat.size,
    electronMtimeMs: Math.trunc(exeStat.mtimeMs),
    icoSize: icoStat.size,
    icoMtimeMs: Math.trunc(icoStat.mtimeMs),
    version
  };
}

function stampsEqual(a, b) {
  return (
    a &&
    b &&
    a.electronSize === b.electronSize &&
    a.electronMtimeMs === b.electronMtimeMs &&
    a.icoSize === b.icoSize &&
    a.icoMtimeMs === b.icoMtimeMs &&
    a.version === b.version
  );
}

function patchDevExecutable(electronExe, devExe, icoPath, version) {
  const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit');
  const exe = NtExecutable.from(fs.readFileSync(electronExe), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const iconFile = Data.IconFile.from(fs.readFileSync(icoPath));
  const iconGroups = Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = iconGroups[0]?.id ?? 1;
  const langId = iconGroups[0]?.lang ?? 1033;

  Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groupId,
    langId,
    iconFile.icons.map((item) => item.data)
  );

  const viList = Resource.VersionInfo.fromEntries(res.entries);
  for (const vi of viList) {
    const langs = vi.getAllLanguagesForStringValues?.() ?? [{ lang: langId, codepage: 1200 }];
    for (const lang of langs) {
      vi.setStringValues(lang, {
        ProductName: 'Agente',
        FileDescription: 'Agente',
        InternalName: 'agente-dev',
        OriginalFilename: 'agente-dev.exe',
        ...(version ? { ProductVersion: version, FileVersion: version } : {})
      });
    }
    vi.outputToResourceEntries(res.entries);
  }

  res.outputResource(exe);
  const outBuf = Buffer.from(exe.generate());
  const tmpExe = `${devExe}.tmp-${process.pid}`;
  fs.writeFileSync(tmpExe, outBuf);
  try {
    fs.renameSync(tmpExe, devExe);
  } catch (err) {
    try {
      fs.unlinkSync(tmpExe);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

function prepareWindowsDevElectron() {
  const stockExe = require('electron');
  const distDir = path.dirname(stockExe);
  const devExe = path.join(distDir, 'agente-dev.exe');
  const stampPath = path.join(distDir, '.agente-dev-icon.json');
  const icoPath = path.join(desktopDir, 'build', 'app-icon-dev.ico');
  const pkgPath = path.join(desktopDir, 'package.json');

  if (!fs.existsSync(icoPath)) {
    return { executable: stockExe, prepared: false, cached: false };
  }

  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  const expectedStamp = resolveStamp(stockExe, icoPath, version);
  let currentStamp = null;
  try {
    currentStamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    currentStamp = null;
  }

  if (fs.existsSync(devExe) && stampsEqual(currentStamp, expectedStamp)) {
    return { executable: devExe, prepared: false, cached: true };
  }

  try {
    patchDevExecutable(stockExe, devExe, icoPath, version);
    fs.writeFileSync(stampPath, JSON.stringify(expectedStamp, null, 2) + '\n');
    return { executable: devExe, prepared: true, cached: false };
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : '';
    if ((code === 'EBUSY' || code === 'EPERM') && fs.existsSync(devExe)) {
      console.warn('[dev-electron] agente-dev.exe is currently in use; launching existing binary.');
      return { executable: devExe, prepared: false, cached: true };
    }
    console.warn('[dev-electron] failed to prepare agente-dev.exe, falling back to electron.exe:', err);
    return { executable: stockExe, prepared: false, cached: false };
  }
}

const rawArgs = process.argv.slice(2);
const prepareOnly = rawArgs.includes('--prepare-only');
const forwardArgs = rawArgs.filter((arg) => arg !== '--prepare-only');

const result =
  process.platform === 'win32'
    ? prepareWindowsDevElectron()
    : { executable: require('electron'), prepared: false, cached: false };

if (prepareOnly) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

const child = spawn(result.executable, ['.', ...forwardArgs], {
  cwd: desktopDir,
  stdio: 'inherit'
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
