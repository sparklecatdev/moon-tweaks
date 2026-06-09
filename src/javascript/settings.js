import settings from 'electron-settings';
import Logger from './logger';
import {
  getDetectedJrePath,
  getLaunchDirectoriesTemplate,
  getPreferredLunarVersion,
} from './lunar';
const logger = new Logger('settings');

/**
 * Setup settings for the application
 * Also check if the settings need to be reseted to default
 */
export default async function setupSettings() {
  logger.info('Setting up settings...');
  const defaults = await getDefaultSettings();

  // User's submitted servers
  if (!(await settings.has('servers'))) {
    await settings.set('servers', defaults.servers);
  }

  // User's selected customizations
  if (!(await settings.has('customizations'))) {
    await settings.set('customizations', defaults.customizations);
  }

  // User's selected version
  if (!(await settings.has('version'))) {
    await settings.set('version', defaults.version);
  }

  // User's selected launch directories
  if (!(await settings.has('launchDirectories'))) {
    await settings.set('launchDirectories', defaults.launchDirectories);
  } else {
    await settings.set(
      'launchDirectories',
      await mergeLaunchDirectories(await settings.get('launchDirectories'))
    );
  }

  // User's selected ram
  if (!(await settings.has('ram'))) {
    await settings.set('ram', defaults.ram);
  }

  // User's selected resolution
  if (!(await settings.has('resolution'))) {
    await settings.set('resolution', defaults.resolution);
  }

  // User's selected action after launch
  if (!(await settings.has('actionAfterLaunch'))) {
    await settings.set('actionAfterLaunch', defaults.actionAfterLaunch);
  }

  // User's custom JVM arguments
  if (!(await settings.has('jvmArguments'))) {
    await settings.set('jvmArguments', defaults.jvmArguments);
  }

  // User's selected JRE Path
  if (!(await settings.has('jrePath'))) {
    await settings.set('jrePath', defaults.jrePath);
  }

  // Launch in debug mode
  if (!(await settings.has('debugMode'))) {
    await settings.set('debugMode', defaults.debugMode);
  }

  // Skip launch checks
  if (!(await settings.has('skipChecks'))) {
    await settings.set('skipChecks', defaults.skipChecks);
  }

  // Downloaded JREs
  if (!(await settings.has('downloadedJres'))) {
    await settings.set('downloadedJres', defaults.downloadedJres);
  }

  const version = await settings.get('version');
  const storedLaunchDirectories = await settings.get('launchDirectories');
  const launchDirectories = Array.isArray(storedLaunchDirectories)
    ? storedLaunchDirectories
    : defaults.launchDirectories;
  if (!launchDirectories.find((directory) => directory.version === version)) {
    await settings.set('version', defaults.version);
  }

  logger.info('Settings setup');
}

async function mergeLaunchDirectories(existingDirectories = []) {
  const template = await getLaunchDirectoriesTemplate();
  const directories = Array.isArray(existingDirectories) ? existingDirectories : [];
  const existingByVersion = new Map(
    directories.map((directory) => [directory.version, directory.path])
  );

  return template.map((directory) => ({
    version: directory.version,
    path: existingByVersion.get(directory.version) ?? directory.path,
  }));
}

export const defaultSettings = {
  servers: [
    { name: 'Hypixel', ip: 'hypixel.net', background: 7 },
    { name: 'Minemen Club', ip: 'na.minemen.club', background: 3 },
    { name: 'Lunar Network', ip: 'lunar.gg', background: 1 },
    { name: 'ViperMC', ip: 'play.vipermc.net', background: 5 },
    { name: 'BWHub', ip: 'bwhub.net', background: 4 },
  ],
  customizations: [],
  version: '1.8',
  launchDirectories: [{ version: '1.8', path: '' }],
  ram: 4000,
  resolution: {
    width: 854,
    height: 480,
  },
  actionAfterLaunch: 'close',
  jvmArguments: '-XX:+DisableAttachMechanism',
  jrePath: '',
  debugMode: false,
  skipChecks: false,
  downloadedJres: [],
};

export async function getDefaultSettings() {
  return {
    ...defaultSettings,
    version: await getPreferredLunarVersion(),
    launchDirectories: await getLaunchDirectoriesTemplate(),
    jrePath: await getDetectedJrePath(),
  };
}

export async function getDefaultLaunchDirectories() {
  return (await getDefaultSettings()).launchDirectories;
}

export async function getDefaultJrePath() {
  return (await getDefaultSettings()).jrePath;
}
