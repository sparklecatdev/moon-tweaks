import axios from 'axios';
import { spawn } from 'child_process';
import { remote } from 'electron';
import settings from 'electron-settings';
import extractZip from 'extract-zip';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { machineId as _machineId } from 'node-machine-id';
import { arch } from 'os';
import { join } from 'path';
import process from 'process';
import constants from '../constants';
import store from '../store';
import { downloadLunarAssets } from './assets';
import { disableRPC, login as connectRPC, updateActivity } from './discord';
import { downloadAndSaveFile } from './downloader';
import fs from './fs';
import {
  getCurrentOsRelease,
  getInstallationId,
  getLauncherVersion,
} from './lunar';
import Logger, { createMinecraftLogger } from './logger';

const logger = new Logger('launcher');

function getJavaBinaryName(useWindowless = false) {
  if (process.platform === 'win32') {
    return useWindowless ? 'javaw.exe' : 'java.exe';
  }

  return useWindowless ? 'javaw' : 'java';
}

function getMetadataErrorMessage(payload) {
  const launcherError = payload?.error;

  if (launcherError?.code === 'OUTDATED_LAUNCHER') {
    return 'Official Lunar Client rejected this request as outdated. Update and open the official Lunar Client launcher, then try again.';
  }

  if (typeof launcherError?.message === 'string' && launcherError.message) {
    return launcherError.message;
  }

  if (typeof launcherError?.short === 'string' && launcherError.short) {
    return launcherError.short;
  }

  if (typeof payload?.message === 'string' && payload.message) {
    return payload.message;
  }

  return null;
}

function getLaunchTypeData(metadata) {
  const candidates = [
    metadata?.launchTypeData,
    metadata?.launchType?.data,
    metadata?.launchType,
  ];

  return (
    candidates.find((candidate) => candidate && typeof candidate === 'object') ??
    {}
  );
}

function getArtifacts(metadata) {
  const launchTypeData = getLaunchTypeData(metadata);
  const artifacts = Array.isArray(launchTypeData?.artifacts)
    ? launchTypeData.artifacts
    : Array.isArray(metadata?.artifacts)
      ? metadata.artifacts
      : [];

  return artifacts.filter(
    (artifact) => artifact && typeof artifact.name === 'string'
  );
}

function getJreMetadata(metadata) {
  const candidates = [metadata?.jre, metadata?.javaRuntime, metadata?.java];
  const jre =
    candidates.find((candidate) => candidate && typeof candidate === 'object') ??
    {};

  const extraArguments = Array.isArray(jre?.extraArguments)
    ? jre.extraArguments
    : Array.isArray(jre?.extra_arguments)
      ? jre.extra_arguments
      : Array.isArray(metadata?.extraArguments)
        ? metadata.extraArguments
        : [];

  return {
    ...jre,
    extraArguments,
  };
}

function normalizeLaunchMetadata(metadata) {
  const launchTypeData = getLaunchTypeData(metadata);
  const artifacts = getArtifacts(metadata);
  const jre = getJreMetadata(metadata);
  const mainClass =
    typeof launchTypeData?.mainClass === 'string' && launchTypeData.mainClass
      ? launchTypeData.mainClass
      : typeof metadata?.mainClass === 'string'
        ? metadata.mainClass
        : null;

  return {
    ...metadata,
    launchTypeData: {
      ...launchTypeData,
      artifacts,
      mainClass,
    },
    jre,
    licenses: Array.isArray(metadata?.licenses) ? metadata.licenses : [],
  };
}

function unwrapLaunchMetadata(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Lunar metadata response was empty');
  }

  if (payload.success === false) {
    throw new Error(
      getMetadataErrorMessage(payload) ?? 'Failed to fetch Lunar metadata'
    );
  }

  const metadata =
    payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const normalized = normalizeLaunchMetadata(metadata);

  if (
    !normalized?.launchTypeData ||
    !normalized?.jre ||
    !Array.isArray(normalized.launchTypeData.artifacts)
  ) {
    throw new Error(
      getMetadataErrorMessage(payload) ?? 'Lunar metadata response was invalid'
    );
  }

  return normalized;
}

async function getLocalPatcherConfig() {
  const customizations = await settings.get('customizations');
  const config = {
    metadata: {
      isEnabled: true,
      removeCalls: [],
    },
  };

  (Array.isArray(customizations) ? customizations : []).forEach(
    (customization) => {
      if (!customization || typeof customization !== 'object') return;

      if (Array.isArray(customization.privacyModules)) {
        customization.privacyModules.forEach((module) => {
          if (typeof module !== 'string' || !module) return;
          config[module] = {
            isEnabled: false,
          };
        });
        return;
      }

      if (
        typeof customization.internal !== 'string' ||
        !customization.internal ||
        customization.internal === 'metadata'
      ) {
        return;
      }

      config[customization.internal] = {
        isEnabled: false,
        ...(customization.values &&
        typeof customization.values === 'object' &&
        !Array.isArray(customization.values)
          ? customization.values
          : {}),
      };
    }
  );

  return config;
}

async function getRemotePatcherConfig() {
  return axios
    .get(constants.PATCHER.CONFIG_EXAMPLE_URL)
    .then((response) =>
      response?.data && typeof response.data === 'object' ? response.data : null
    )
    .catch((error) => {
      logger.warn('Failed to fetch patcher config template', error);
      return null;
    });
}

async function ensurePatcherConfigFile(configPath) {
  const remoteConfig = await getRemotePatcherConfig();
  const config = remoteConfig ?? (await getLocalPatcherConfig());

  await writeFile(configPath, JSON.stringify(config, null, 2));
  logger.info(
    remoteConfig
      ? 'Created default patcher config'
      : 'Created local fallback patcher config'
  );
}

/**
 * Checks if the `.lunarclient` directory is valid
 */
export async function setupLunarClientDirectory() {
  logger.info('Checking .lunarclient directory');

  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'CHECKING LC FOLDER...',
    icon: 'fa-solid fa-folder',
  });

  const folders = [
    {
      name: 'licenses',
      path: join(constants.DOTLUNARCLIENT, 'licenses'),
    },
    {
      name: 'offline',
      path: join(constants.DOTLUNARCLIENT, 'offline'),
    },
    {
      name: 'jre',
      path: join(constants.DOTLUNARCLIENT, 'jre'),
    },
    {
      name: 'moontweaks',
      path: constants.MOONTWEAKS_DIR,
    },
  ];

  await mkdir(constants.DOTLUNARCLIENT, { recursive: true })
    .then(() => {
      logger.debug('Checked .lunarclient directory');
    })
    .catch((error) => {
      logger.error("Can't create .lunarclient directory", error);
      throw error;
    });

  logger.debug('Checking .lunarclient subdirectories');

  for (const [index, folder] of folders.entries()) {
    // Launch state
    store.commit('setLaunchingState', {
      title: 'LAUNCHING...',
      message: `CHECKING ${folder.name.toUpperCase()} FOLDER ${index + 1}/${folders.length}...`,
      icon: 'fa-solid fa-folder',
    });

    logger.debug(`Checking ${folder.path}`);
    await mkdir(folder.path, { recursive: true }).catch((error) => {
      logger.error(`Can't create ${folder.name} subdirectory`, error);
      throw error;
    });

    const folderStat = await stat(folder.path).catch((error) => {
      logger.error(`Can't stat ${folder.name} subdirectory`, error);
      throw error;
    });

    if (!folderStat.isDirectory()) {
      const error = new Error(`${folder.path} exists but is not a directory`);
      logger.error(error.message);
      throw error;
    }
  }
}

/**
 * Checks if the JRE is valid
 */
export async function checkJRE() {
  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'CHECKING JRE...',
    icon: 'fa-solid fa-folder',
  });

  const jrePath = await settings.get('jrePath');
  const javaName = getJavaBinaryName();

  const exists = {
    jre: await stat(jrePath).catch(() => false), // Bin folder
    java: await stat(join(jrePath, javaName)).catch(() => false), // Java binary
  };

  // If one of them is missing
  if (!exists.jre || !exists.java) {
    logger.warn(
      'JRE not found! Showing error dialog and aborting launch process'
    );

    const choice = await remote.dialog.showMessageBox({
      type: 'error',
      title: 'JRE not found',
      message:
        'The JRE you selected was not found or is invalid.\n\nPlease select a valid JRE in the settings page or download one using the JRE downloader.\n\nMake sure you selected the bin folder inside of the JRE.',
      buttons: ['Select JRE', 'Cancel launch'],
    });

    if (choice.response === 0) {
      // Set new folder
      const folder = await remote.dialog.showOpenDialog({
        title: `Select the new JRE for Lunar Client (Select the bin folder)`,
        defaultPath: jrePath,
        properties: ['dontAddToRecent', 'openDirectory'],
      });

      if (folder.canceled) return;

      await settings.set('jrePath', folder.filePaths[0]);
      await checkJRE();
    } else {
      // Cancel launch or closed
      store.commit('setLaunchingState', {
        title: `LAUNCH ${await settings.get('version')}`,
        message: 'READY TO LAUNCH',
        icon: 'fa-solid fa-gamepad',
      });
      store.commit('setLaunching', false);
      throw new Error('JRE not found');
    }
  }
}

/**
 * Fetches metadata from Lunar's API
 * @param {boolean} [skipLaunchingState=false] Skip or not the launching state
 * @param {string} [overrideVersion=null] Minecraft version override
 * @returns {Promise<Object>}
 */
export async function fetchMetadata(
  skipLaunchingState = false,
  overrideVersion = null
) {
  if (!skipLaunchingState) {
    // Launch state
    store.commit('setLaunchingState', {
      title: 'LAUNCHING...',
      message: 'FETCHING METADATA...',
      icon: 'fa-solid fa-download',
    });
  }

  // Fetch metadata
  logger.info('Fetching metadata...');
  const machineId = await _machineId();
  const version = overrideVersion ?? (await settings.get('version'));
  const installationId = await getInstallationId();
  const launcherVersion = await getLauncherVersion();

  if (!installationId) {
    throw new Error(
      'Official Lunar Client installation metadata is missing. Open the official Lunar Client launcher once, then try again.'
    );
  }

  if (!launcherVersion) {
    throw new Error(
      'Official Lunar Client launcher version is missing. Open the official Lunar Client launcher once, then try again.'
    );
  }

  return new Promise((resolve, reject) => {
    axios
      .post(
        constants.links.LC_METADATA_ENDPOINT,
        {
          hwid: machineId,
          installation_id: installationId,
          os: process.platform,
          os_release: getCurrentOsRelease(),
          arch: arch(),
          version: version,
          branch: 'master',
          launch_type: 'OFFLINE',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': launcherVersion
              ? `Lunar Client/${launcherVersion}`
              : 'MoonTweaks',
          },
        }
      )
      .then((response) => {
        logger.debug('Fetched metadata');
        resolve(unwrapLaunchMetadata(response.data));
      })
      .catch((error) => {
        logger.error('Failed to fetch metadata', error);
        reject(
          new Error(
            getMetadataErrorMessage(error?.response?.data) ??
              error.message ??
              'Failed to fetch Lunar metadata'
          )
        );
      });
  });
}

/**
 * Checks license (and downloads if needed)
 * @param {Object} metadata Metadata from Lunar's API
 * @returns {Promise<void>}
 */
export async function checkLicenses(metadata) {
  const licenses = Array.isArray(metadata?.licenses) ? metadata.licenses : [];
  logger.info('Checking licenses...');
  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: `CHECKING ${licenses.length} LICENSES ...`,
    icon: 'fa-solid fa-gavel',
  });
  for (const index in licenses) {
    const license = licenses[index];
    logger.debug(
      `Checking license ${parseInt(index) + 1}/${licenses.length}`
    );
    const licensePath = join(
      constants.DOTLUNARCLIENT,
      'licenses',
      license.file
    );

    if (!(await fs.exists(licensePath))) {
      await downloadAndSaveFile(
        license.url,
        join(constants.DOTLUNARCLIENT, 'licenses', license.file),
        'text',
        license.sha1,
        'sha1'
      ).catch((error) => {
        logger.error(`Failed to download ${license.file}`, error);
      });
    }
  }
}

/**
 * Checks the game files (and downloads if needed)
 * @param {Object} metadata Metadata from Lunar's API
 * @returns {Promise<void>}
 */
export async function checkGameFiles(metadata) {
  const artifacts = getArtifacts(metadata);
  if (artifacts.length === 0) {
    logger.error('Missing launchTypeData.artifacts in launch metadata', metadata);
    throw new Error('Launch metadata is missing game files');
  }

  logger.info(`Checking game files (MC ${await settings.get('version')})...`);
  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: `CHECKING GAMEFILES (${artifacts.length})...`,
    icon: 'fa-solid fa-file',
  });

  if (
    !(await fs.exists(
      join(constants.DOTLUNARCLIENT, 'offline', await settings.get('version'))
    ))
  ) {
    await fs
      .mkdir(
        join(constants.DOTLUNARCLIENT, 'offline', await settings.get('version'))
      )
      .catch((error) => {
        logger.error('Failed to create version folder', error);
      });
  }

  for (const index in artifacts) {
    const artifact = artifacts[index];
    const gameFilePath = join(
      constants.DOTLUNARCLIENT,
      'offline',
      await settings.get('version'),
      artifact.name
    );
    logger.debug(
      `Checking game file ${parseInt(index) + 1}/${
        artifacts.length
      }`
    );

    if (!(await fs.exists(gameFilePath))) {
      await downloadAndSaveFile(
        artifact.url,
        join(
          constants.DOTLUNARCLIENT,
          'offline',
          await settings.get('version'),
          artifact.name
        ),
        'blob',
        artifact.sha1,
        'sha1'
      ).catch((error) => {
        logger.error(`Failed to download ${artifact.name}`, error);
      });
    }
  }
}

/**
 * Checks natives (and extract if needed)
 * @param {object} metadata Metadata from Lunar's API
 * @returns {Promise<void>}
 */
export async function checkNatives(metadata) {
  logger.info('Checking natives...');

  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'CHECKING NATIVES...',
    icon: 'fa-solid fa-file',
  });

  const artifacts = getArtifacts(metadata);
  const artifact = artifacts.find((entry) => entry.type === 'NATIVES');
  if (!artifact?.name) {
    logger.error('Missing natives artifact in launch metadata', metadata);
    throw new Error('Launch metadata is missing natives');
  }
  if (
    await fs.exists(
      join(
        constants.DOTLUNARCLIENT,
        'offline',
        await settings.get('version'),
        artifact.name
      )
    )
  ) {
    if (
      !(await fs.exists(
        join(
          constants.DOTLUNARCLIENT,
          'offline',
          await settings.get('version'),
          'natives'
        )
      ))
    ) {
      await extractZip(
        join(
          constants.DOTLUNARCLIENT,
          'offline',
          await settings.get('version'),
          artifact.name
        ),
        {
          dir: join(
            constants.DOTLUNARCLIENT,
            'offline',
            await settings.get('version'),
            'natives'
          ),
        }
      )
        .then(() => {
          logger.debug('Extracted natives');
        })
        .catch((error) => {
          logger.error(`Failed to extract natives`, error);
        });
    } else {
      logger.debug('Natives already extracted');
    }
  } else {
    logger.error('Natives not found, this should not happen');
  }
}

/**
 * Check patcher (and download if needed)
 * @returns {Promise<void>}
 */
export async function checkPatcher() {
  logger.info('Checking patcher...');

  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'CHECKING PATCHER...',
    icon: 'fa-solid fa-file',
  });

  const release = await axios
    .get(constants.links.GITHUB_RELEASES_API)
    .catch((reason) => {
      logger.error('Failed to fetch latest release', reason);
    });
  if (!release?.data) return;

  const patcherAsset = release.data.assets?.find(
    (asset) =>
      asset?.name === constants.PATCHER.RELEASE_ASSET_NAME ||
      asset?.label === constants.PATCHER.RELEASE_ASSET_NAME ||
      (asset?.name?.startsWith('moon-patcher-') &&
        asset.name.endsWith('.jar')) ||
      (asset?.name?.startsWith('solar-patcher-') &&
        asset.name.endsWith('.jar'))
  );
  if (!patcherAsset?.browser_download_url) {
    logger.error('Latest release has no patcher asset');
    return;
  }

  const patcherPath = join(
    constants.DOTLUNARCLIENT,
    'moontweaks',
    constants.PATCHER.PATCHER
  );
  const latestVer = `${release.data.tag_name || ''}:${patcherAsset.name}`;
  if (!release.data.tag_name) {
    logger.error('Latest release version is invalid', release.data.tag_name);
    return;
  }

  // Check if the patcher file exists
  if (
    !(await stat(
      join(constants.MOONTWEAKS_DIR, constants.PATCHER.PATCHER)
    ).catch(() => false))
  ) {
    await downloadAndSaveFile(
      patcherAsset.browser_download_url,
      patcherPath,
      'blob'
    );
    await settings.set('patcherVersion', latestVer);
    return; // No need to check for updates, we just downloaded the latest version
  }

  const patcherVer = await settings.get('patcherVersion');

  if (patcherVer === latestVer)
    return logger.info(`Patcher is up to date ${patcherVer}`);

  await downloadAndSaveFile(
    patcherAsset.browser_download_url,
    patcherPath,
    'blob'
  );

  logger.info(`Patcher updated to ${latestVer}`);
  await settings.set('patcherVersion', latestVer);

  const configPath = join(
    constants.DOTLUNARCLIENT,
    'moontweaks',
    constants.PATCHER.CONFIG
  );
  const config = await readFile(configPath, 'utf8').catch(() => null);
  if (!config) {
    await ensurePatcherConfigFile(configPath);
    return;
  }

  logger.debug('Updating config.json file to match new patcher config...');
  const defaultConfigFile =
    (await getRemotePatcherConfig()) ?? (await getLocalPatcherConfig());

  function merge(obj1, obj2) {
    const newObj = { ...obj1, ...obj2 };
    for (const key in newObj)
      if (
        newObj[key] &&
        typeof newObj[key] === 'object' &&
        !Array.isArray(newObj[key])
      )
        newObj[key] = merge(obj1?.[key] ?? {}, obj2?.[key] ?? {});

    return newObj;
  }

  const newConfig = merge(defaultConfigFile, JSON.parse(config));
  await writeFile(configPath, JSON.stringify(newConfig, null, 2));
}

/**
 * Check patcher config file (and download if needed)
 * @returns {Promise<void>}
 */
export async function checkPatcherConfig() {
  const configPath = join(
    constants.DOTLUNARCLIENT,
    'moontweaks',
    constants.PATCHER.CONFIG
  );
  await stat(configPath).catch(async () => {
    await ensurePatcherConfigFile(configPath);
  });
}

/**
 * Edit the `config.json` file for the Java Agent
 * @returns {Promise<void>}
 */
export async function patchGame() {
  logger.info('Patching game...');

  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'PATCHING GAME...',
    icon: 'fa-solid fa-cog',
  });

  const filePath = join(
    constants.DOTLUNARCLIENT,
    'moontweaks',
    constants.PATCHER.CONFIG
  );

  logger.debug(`Reading ${filePath}`);
  const configRaw = await fs.readFile(filePath).catch((reason) => {
    logger.error('Failed to read config.json', reason);
  });
  if (!configRaw) return;

  const config = JSON.parse(configRaw);
  const customizations = await settings.get('customizations');

  if (!config?.metadata) {
    logger.error('Patcher config is missing metadata section', config);
    throw new Error('Patcher config is invalid');
  }

  config.metadata.removeCalls = [];
  config.metadata.isEnabled = true;

  (Array.isArray(customizations) ? customizations : []).forEach((customization) => {
    // Privacy module
    if (Object.prototype.hasOwnProperty.call(customization, 'privacyModules')) {
      customization.privacyModules.forEach((module) => {
        if (!Object.prototype.hasOwnProperty.call(config, module)) return;
        config[module].isEnabled = customization.enabled;
      });
      return;
    }

    if (!Object.keys(config).includes(customization.internal)) return;

    // Metadata module
    if (customization.internal === 'metadata') {
      config.metadata.removeCalls.push(customization.call);
      return;
    }

    config[customization.internal].isEnabled = customization.enabled;
    if (Object.prototype.hasOwnProperty.call(customization, 'values')) {
      for (const key in customization.values) {
        config[customization.internal][key] = customization.values[key];
      }
    }
  });

  logger.debug(`Writing ${filePath}`);
  await fs
    .writeFile(filePath, JSON.stringify(config, null, 2))
    .then(() => {
      logger.debug('Successfully wrote config.json');
    })
    .catch((reason) => {
      logger.error('Failed to write config.json', reason);
    });
}

/**
 * Get the Java arguments to launch the game
 * @param {Object} metadata Metadata from Lunar's API
 * @param {string} [serverIp=null] Server IP to connect to
 * @param {string} [overrideVersion=null] Version to use (overrides settings)
 * @param {boolean} [shortcut=false] Whether or not the arguments are for a shortcut
 */
export async function getJavaArguments(
  metadata,
  serverIp = null,
  overrideVersion = null,
  shortcut = false
) {
  let version = await settings.get('version');
  if (overrideVersion) version = overrideVersion;

  const natives = join(
    constants.DOTLUNARCLIENT,
    'offline',
    version,
    'natives'
  );

  const extraArguments = getJreMetadata(metadata).extraArguments;
  if (!Array.isArray(extraArguments)) {
    logger.error('Missing jre.extraArguments in launch metadata', metadata);
    throw new Error('Launch metadata is missing Java arguments');
  }

  const args = [...extraArguments];

  const nativesArgument = args.findIndex((value) => value.includes('natives'));
  if (nativesArgument !== -1) {
    args[nativesArgument] = args[nativesArgument].replace(
      'natives',
      `"${natives}"`
    );
  }

  const lunarJarFile = async (filename) =>
    `"${join(constants.DOTLUNARCLIENT, 'offline', version, filename)}"`;

  const launchDirectories = await settings.get('launchDirectories');
  const gameDir = (Array.isArray(launchDirectories) ? launchDirectories : []).find(
    (directory) => directory.version === version
  )?.path;
  if (!gameDir) throw new Error(`Missing launch directory for version ${version}`);

  const resolution = await settings.get('resolution');
  const width = Number.parseInt(resolution?.width, 10);
  const height = Number.parseInt(resolution?.height, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('Launch resolution is invalid');
  }

  const jvmArguments = await settings.get('jvmArguments');
  const patcherPath = join(
    constants.DOTLUNARCLIENT,
    'moontweaks',
    constants.PATCHER.PATCHER
  );

  // Make sure the patcher exists, or else the game will crash (jvm init error)
  await stat(patcherPath)
    .then(() =>
      args.push(
        `-javaagent:"${patcherPath}"="${join(
          constants.DOTLUNARCLIENT,
          'moontweaks',
          constants.PATCHER.CONFIG
        )}"`
      )
    )
    .catch((e) =>
      logger.warn(
        `Not adding patcher in arguments; ${patcherPath} does not exist! ${e}`
      )
    );

  const classPathArtifacts = getArtifacts(metadata).filter(
    (artifact) => artifact.type !== 'NATIVES'
  );
  if (classPathArtifacts.length === 0) {
    logger.error('No classpath artifacts found in launch metadata', metadata);
    throw new Error('Launch metadata is missing classpath files');
  }

  const classPath = [];
  for (const artifact of classPathArtifacts) {
    classPath.push(await lunarJarFile(artifact.name));
  }

  if (!metadata?.launchTypeData?.mainClass) {
    logger.error('Missing launchTypeData.mainClass in launch metadata', metadata);
    throw new Error('Launch metadata is missing the main class');
  }

  args.push(
    ...(typeof jvmArguments === 'string'
      ? jvmArguments.split(' ').filter(Boolean)
      : []),
    `-Xmx${await settings.get('ram')}m`,
    `-Djava.library.path="${natives}"`,
    `-Dsolar.launchType=${shortcut ? 'shortcut' : 'launcher'}`,
    '-cp',
    classPath.join(process.platform == 'win32' ? ';' : ':'),
    metadata?.launchTypeData?.mainClass,
    '--version',
    version,
    '--accessToken',
    '0',
    '--assetIndex',
    version === '1.7' ? '1.7.10' : version,
    '--userProperties',
    '{}',
    '--gameDir',
    `"${gameDir}"`,
    // '--assetsDir',
    // `"${join(gameDir, 'assets')}"`,
    '--texturesDir',
    `"${join(constants.DOTLUNARCLIENT, 'textures')}"`,
    '--width',
    width,
    '--height',
    height
  );

  if (serverIp) args.push('--server', `"${serverIp}"`);

  return args.map((arg) => (!shortcut ? `${arg}`.replace(/"/g, '') : arg));
}
/**
 * Launch the game
 * @param {Object} metadata Metadata from Lunar's API
 * @param {string} [serverIp=null] Server IP to connect to
 * @param {boolean} [debug=false] Launch in debug mode (show console)
 */
export async function launchGame(metadata, serverIp = null, debug = false) {
  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'STARTING JVM...',
    icon: 'fa-solid fa-gamepad',
  });

  const version = await settings.get('version');
  const args = await getJavaArguments(metadata, serverIp);

  logger.debug('Launching game with args', args);

  const javaPath = join(await settings.get('jrePath'), getJavaBinaryName());
  const proc = await spawn(javaPath, args, {
    cwd: join(constants.DOTLUNARCLIENT, 'offline', version),
    detached: true,
    shell: debug,
  });

  async function commitLaunch() {
    updateActivity('In the launcher');
    store.commit('setLaunchingState', {
      title: `LAUNCH ${version}`,
      message: 'READY TO LAUNCH',
      icon: 'fa-solid fa-gamepad',
    });
    store.commit('setLaunching', false);
  }

  if (debug) return await commitLaunch();

  proc.on('error', (error) => {
    logger.error(error);
  });

  proc.stdout.on('error', (error) => {
    logger.error('Failed to launch game', error);
  });

  proc.stderr.on('error', (error) => {
    logger.error('Failed to launch game', error);
  });

  proc.stdout.once('end', () => {
    remote.getCurrentWindow().show();
    connectRPC();
  });

  proc.stdout.once('data', async (/* data */) => {
    await disableRPC();
    switch (await settings.get('actionAfterLaunch')) {
      case 'close':
      default:
        remote.getCurrentWindow().close();
        break;
      case 'hide':
        remote.getCurrentWindow().hide();
        break;
      case 'keep':
        break;
    }
    setTimeout(async () => {
      await commitLaunch();
    }, 1500);
  });

  const minecraftLogger = await createMinecraftLogger(version);
  logger.debug(
    `Created Minecraft Logger for version ${version}. Log file path: ${minecraftLogger.path}`
  );
  proc.stdout.pipe(minecraftLogger);
  proc.stderr.pipe(minecraftLogger);
}

/**
 * Run all the checks and launch the game
 * @param {string} [serverIp=null] Server IP to connect to
 */
// eslint-disable-next-line no-unused-vars
export async function checkAndLaunch(serverIp = null) {
  store.commit('setLaunching', true);
  updateActivity('In the launcher', 'Launching game');

  // Fetching metadata
  const metadata = await fetchMetadata().catch((error) => {
    store.commit('setLaunchingState', {
      title: 'Error',
      message: error.message,
      icon: 'fa-solid fa-exclamation-triangle',
    });
  });
  if (!metadata) {
    store.commit('setLaunching', false);
    return;
  }

  try {
    if (!(await settings.get('skipChecks'))) {
      // Check JRE
      await checkJRE();

      // Check game directory
      await setupLunarClientDirectory();

      // Check licenses
      await checkLicenses(metadata);

      // Check game files
      await checkGameFiles(metadata);

      // Check natives
      await checkNatives(metadata);

      // Check LC assets
      await downloadLunarAssets(metadata);

      // Check patcher
      await checkPatcher().catch((error) =>
        logger.error('Failed to check patcher, skipping patcher check.', error)
      );

      // Patcher config
      await checkPatcherConfig().catch(() =>
        logger.error(
          'Failed to check patcher config, is GitHub down? Have we messed up while publishing the release? Skipping patcher check.'
        )
      );
    }

    // Update patcher config file
    await patchGame();

    // Launch game
    await launchGame(metadata, serverIp, await settings.get('debugMode'));

    // Trackers
    const version = await settings.get('version');
    await axios
      .post(`${constants.API_URL}${constants.ENDPOINTS.LAUNCH}`, {
        item: 'launcher',
        version: version === '1.18' ? '1.18.1' : version,
      })
      .catch((error) =>
        logger.warn(
          "Failed to track launcher launch, ignoring it, it's not important.",
          error
        )
      );
  } catch (error) {
    logger.error('Launch checks failed', error);
    store.commit('setLaunchingState', {
      title: 'Error',
      message: error?.message ?? 'Launch failed',
      icon: 'fa-solid fa-exclamation-triangle',
    });
    store.commit('setLaunching', false);
  }
}
