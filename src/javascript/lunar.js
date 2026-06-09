import axios from 'axios';
import { readdir, readFile, stat } from 'fs/promises';
import { homedir, release as getOsRelease } from 'os';
import { join } from 'path';
import * as process from 'process';
import { platform } from 'process';

const DOT_LUNARCLIENT = join(homedir(), '.lunarclient');
const PROFILES_DIR = join(DOT_LUNARCLIENT, 'profiles');
const JRE_DIR = join(DOT_LUNARCLIENT, 'jre');
const LAUNCHER_SETTINGS = join(DOT_LUNARCLIENT, 'settings', 'launcher.json');
const INSTALLATION_ID_FILE = join(
  DOT_LUNARCLIENT,
  'launcher-cache',
  'installation-id'
);
const OFFICIAL_LAUNCHER_LATEST_URL =
  'https://launcherupdates.lunarclientcdn.com/latest.yml';
const OFFICIAL_LAUNCHER_DOWNLOAD_URLS = [
  'https://api.lunarclientprod.com/site/download?os=linux',
  'https://api.lunarclientprod.com/site/download?os=macos',
];

const DEFAULT_BACKGROUND = 'https://i.ibb.co/dkPrF69/background-images.png';
const VERSION_BACKGROUNDS = {
  '1.18':
    'https://launcherimages.lunarclientcdn.com/versions/1_18.bb8fd4ac31.webp',
  '1.17':
    'https://launcherimages.lunarclientcdn.com/versions/1_17.1632241780.webp',
  '1.16':
    'https://launcherimages.lunarclientcdn.com/versions/1_16.47f82f804b.webp',
  '1.12':
    'https://launcherimages.lunarclientcdn.com/versions/1_12.4d900e6ec3.webp',
  '1.8':
    'https://launcherimages.lunarclientcdn.com/versions/1_8.1a68214027.webp',
  '1.7':
    'https://launcherimages.lunarclientcdn.com/versions/1_7.148c077787.webp',
};

function normalizeVersionForSort(version) {
  return version
    .replace(/^v/i, '')
    .split(/[^\d]+/)
    .filter(Boolean)
    .map((segment) => Number.parseInt(segment, 10));
}

function compareVersionsDesc(left, right) {
  const leftParts = normalizeVersionForSort(left);
  const rightParts = normalizeVersionForSort(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;

    if (leftPart !== rightPart) return rightPart - leftPart;
  }

  return right.localeCompare(left);
}

function extractVersionFromYaml(raw) {
  const match = raw.match(/^version:\s*['"]?([^\r\n'"]+)['"]?\s*$/m);
  return match?.[1]?.trim() || null;
}

function extractVersionFromDownloadUrl(url) {
  const match = url?.match(/[- v](\d+(?:\.\d+)+)(?:[- ][^/]*)?\.(?:dmg|appimage|exe)/i);
  return match?.[1]?.trim() || null;
}

async function getLauncherVersionFromFeed() {
  try {
    const response = await axios.get(OFFICIAL_LAUNCHER_LATEST_URL, {
      responseType: 'text',
      timeout: 5000,
    });
    return extractVersionFromYaml(response?.data);
  } catch {
    return null;
  }
}

async function getLauncherVersionFromDownloadUrl(url) {
  try {
    const response = await axios.get(url, {
      maxRedirects: 0,
      timeout: 5000,
      validateStatus(status) {
        return status >= 200 && status < 400;
      },
    });
    return extractVersionFromDownloadUrl(response?.headers?.location);
  } catch (error) {
    return extractVersionFromDownloadUrl(error?.response?.headers?.location);
  }
}

async function getOfficialLauncherVersion() {
  const versions = await Promise.all([
    getLauncherVersionFromFeed(),
    ...OFFICIAL_LAUNCHER_DOWNLOAD_URLS.map((url) =>
      getLauncherVersionFromDownloadUrl(url)
    ),
  ]);

  return versions.filter(Boolean).sort(compareVersionsDesc)[0] ?? null;
}

function getDotMinecraftDirectory() {
  switch (platform) {
    case 'win32':
      return join(process.env.APPDATA, '.minecraft');
    case 'darwin':
      return join(
        process.env.HOME,
        'Library',
        'Application Support',
        'minecraft'
      );
    case 'linux':
      return join(process.env.HOME, '.minecraft');
    default:
      return join(homedir(), '.minecraft');
  }
}

export async function getInstalledLunarVersions() {
  try {
    const entries = await readdir(PROFILES_DIR, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== 'svc-for-lunar-client'
      )
      .map((entry) => entry.name)
      .sort(compareVersionsDesc);
  } catch {
    return [];
  }
}

export async function getLaunchDirectoriesTemplate() {
  const versions = await getInstalledLunarVersions();
  const fallbackVersions = versions.length > 0 ? versions : ['1.8'];
  const dotMinecraft = getDotMinecraftDirectory();

  return fallbackVersions.map((version) => ({
    version,
    path: dotMinecraft,
  }));
}

export async function getPreferredLunarVersion() {
  const versions = await getInstalledLunarVersions();
  return versions[0] ?? '1.8';
}

async function getJavaExecutablePath(binPath) {
  const javaName = platform === 'win32' ? 'java.exe' : 'java';
  const javaPath = join(binPath, javaName);

  try {
    const javaStat = await stat(javaPath);
    return javaStat.isFile() ? javaPath : null;
  } catch {
    return null;
  }
}

function getJreRank(folderName) {
  const match = folderName.match(/jre(\d+)/i);
  if (match) return Number.parseInt(match[1], 10);

  const leading = folderName.match(/^.*?(\d+)(?:[._-]|$)/);
  return leading ? Number.parseInt(leading[1], 10) : 0;
}

export async function getDetectedJrePath() {
  try {
    const entries = await readdir(JRE_DIR, { withFileTypes: true });
    const candidates = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const binPath = join(JRE_DIR, entry.name, 'bin');
      const javaPath = await getJavaExecutablePath(binPath);
      if (!javaPath) continue;

      candidates.push({
        binPath,
        rank: getJreRank(entry.name),
        name: entry.name,
      });
    }

    candidates.sort(
      (left, right) =>
        right.rank - left.rank || right.name.localeCompare(left.name)
    );

    return candidates[0]?.binPath ?? getLegacyJreFallbackPath();
  } catch {
    return getLegacyJreFallbackPath();
  }
}

function getLegacyJreFallbackPath() {
  const home = platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  return join(
    home,
    '.lunarclient',
    'jre',
    'zulu17.30.15-ca-fx-jre17.0.1-win_x64',
    'bin'
  );
}

export async function getLauncherVersion() {
  let localVersion = null;

  try {
    const raw = await readFile(LAUNCHER_SETTINGS, 'utf8');
    const parsed = JSON.parse(raw);
    localVersion =
      parsed?.__internal__?.migrations?.version ??
      parsed?.launcherVersion ??
      parsed?.version ??
      parsed?.build?.version ??
      null;
  } catch {
    localVersion = null;
  }

  const officialVersion = await getOfficialLauncherVersion();
  if (!localVersion) return officialVersion;
  if (!officialVersion) return localVersion;

  return [localVersion, officialVersion].sort(compareVersionsDesc)[0];
}

export async function getInstallationId() {
  try {
    return (await readFile(INSTALLATION_ID_FILE, 'utf8')).trim();
  } catch {
    return null;
  }
}

export function getVersionBackground(version) {
  return VERSION_BACKGROUNDS[version] ?? DEFAULT_BACKGROUND;
}

export function getCurrentOsRelease() {
  return getOsRelease();
}
