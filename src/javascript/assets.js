import { checkHash, downloadAndSaveFile } from './downloader';
import { join } from 'path';
import fs from './fs';
import store from '../store';
import Logger from './logger';
import constants from '../constants';

const logger = new Logger('launcher');

/**
 * Check asset file hash + other stuff (I totally remember what I done here + I'm not lazy to read it)
 * @param {Object} metadata Metadata from Lunar's API
 * @param {string} data
 * @param {string} index
 * @returns {Promise<void>}
 */
async function checkAsset(metadata, data, index) {
  const asset = data.split('\n')[index];
  const [assetPath, assetSha] = asset.trim().split(/\s+/);
  if (!assetPath || !assetSha || !/[0-9a-f]{40}/.test(assetSha.toLowerCase())) {
    logger.warn(`Invalid line in index file (line ${index + 1})\n${asset}`);
    return;
  }

  const path = join(constants.DOTLUNARCLIENT, 'textures', assetPath);
  const sha1 = assetSha.toLowerCase();
  const exists = await fs.exists(path);

  if (exists) {
    const match = await checkHash(path, sha1, 'sha1');
    if (match) return;
  }

  await downloadAndSaveFile(
    metadata.textures.baseUrl + sha1,
    path,
    'blob',
    sha1,
    'sha1'
  );
}

/**
 * Downloads Lunar Client Assets (cosmetics) with the given metadata
 * @param {Object} metadata Metadata from Lunar's API
 * @returns {Promise<void>}
 */
export async function downloadLunarAssets(metadata) {
  if (
    !metadata?.textures?.indexUrl ||
    !metadata?.textures?.indexSha1 ||
    !metadata?.textures?.baseUrl
  ) {
    logger.error('Missing textures metadata', metadata);
    throw new Error('Launch metadata is missing Lunar assets information');
  }

  store.commit('setLaunchingState', {
    title: 'LAUNCHING...',
    message: 'CHECKING LC ASSETS...',
    icon: 'fa-solid fa-folder',
  });
  return new Promise((resolve, reject) => {
    const postFolderCheck = (resolve, reject) => {
      const indexPath = join(constants.DOTLUNARCLIENT, 'textures', 'index.txt');
      downloadAndSaveFile(
        metadata.textures.indexUrl,
        indexPath,
        'blob',
        metadata.textures.indexSha1,
        'sha1',
        true,
        true
      )
        .then(async () => {
          const data = await fs.readFile(indexPath, 'utf8');
          const asyncTasks = [];
          for (const index in data.split('\n')) {
            asyncTasks.push(checkAsset(metadata, data, index));
          }
          await Promise.all(asyncTasks);
          resolve();
        })
        .catch(reject);
    };
    fs.mkdir(join(constants.DOTLUNARCLIENT, 'textures'))
      .then(() => {
        postFolderCheck(resolve, reject);
      })
      .catch((error) => {
        if (error.code === 'EEXIST') postFolderCheck(resolve, reject);
        else reject(error);
      });
  });
}
