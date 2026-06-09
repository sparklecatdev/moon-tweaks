import axios from 'axios';
import { spawn } from 'child_process';
import { remote } from 'electron';
import { join } from 'path';
import { platform } from 'process';
import constants from '../constants';
import { downloadAndSaveFile } from './downloader';
import Logger from './logger';

const logger = new Logger('updater');

/**
 * Checks for updates (for the launcher)
 */
export async function checkForUpdates() {
  if (platform !== 'win32') return;

  logger.info('Checking for updates...');
  const release = await axios
    .get(constants.links.GITHUB_RELEASES_API)
    .catch((reason) => {
      logger.error('Failed to fetch latest release', reason);
    });
  if (!release?.data) return;

  const launcherVer = parseInt(remote.app.getVersion().replace(/[^0-9]+/g, ''));
  const latestVersion = (release.data.tag_name || '').replace(/^v/i, '');
  const latestVer = parseInt(latestVersion.replace(/[^0-9]+/g, ''));
  const installerAsset = release.data.assets?.find(
    (asset) =>
      asset?.name?.toLowerCase().endsWith('.exe') &&
      !asset.name.toLowerCase().endsWith('.exe.blockmap')
  );

  if (!latestVersion || Number.isNaN(latestVer)) {
    logger.error('Latest release version is invalid', release.data.tag_name);
    return;
  }

  if (!installerAsset?.browser_download_url) {
    logger.error('Latest release has no Windows installer asset');
    return;
  }

  if (launcherVer < latestVer) {
    logger.info(`Launcher is out of date. Latest version is ${latestVersion}`);

    const choice = await remote.dialog.showMessageBox({
      type: 'question',
      title: 'Update available',
      message: `A new version of the launcher is available.\n\nCurrent version: ${remote.app.getVersion()}\nLatest version: ${
        latestVersion
      }\n\nWould you like to update now?`,
      buttons: ['Later', 'Update'],
    });

    if (choice.response !== 1) return; // Later or closed

    remote.dialog.showMessageBox({
      type: 'info',
      title: 'Downloading update...',
      message:
        'Downloading update in the background. Please wait.\n\nThis may take a while depending on your internet speed. You can close this window and use the launcher, we will notify you when the update is ready.',
    });

    const filename = `launcher-${latestVersion}-update-temp.exe`;
    const filePath = join(constants.MOONTWEAKS_DIR, filename);

    await downloadAndSaveFile(
      installerAsset.browser_download_url,
      filePath,
      'blob'
    );

    const choice2 = await remote.dialog.showMessageBox({
      type: 'question',
      title: 'Update ready',
      message: `The update is ready to be installed.`,
      buttons: ['Cancel update', 'Install update'],
    });

    if (choice2.response !== 1) return; // Cancel update or closed

    try {
      const child = spawn(filePath, [], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();
    } catch (error) {
      logger.error('Failed to launch update installer', error);
      await remote.dialog.showMessageBox({
        type: 'error',
        title: 'Update failed',
        message:
          'The update installer could not be started. Please run the downloaded installer manually from your Moon Tweaks folder.',
      });
      return;
    }

    remote.app.quit();
  } else logger.info('Launcher up to date');
}
