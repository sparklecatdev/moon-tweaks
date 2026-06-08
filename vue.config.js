module.exports = {
  pluginOptions: {
    electronBuilder: {
      nodeIntegration: true,
      outputDir: 'dist',
      builderOptions: {
        appId: 'dev.sparklecat.moontweaks.launcher',
        productName: 'Moon Tweaks',
        win: {
          target: 'nsis',
          icon: 'build/icons/win/icon.ico',
          publisherName: 'Moon Tweaks',
          verifyUpdateCodeSignature: true,
        },
        nsis: {
          oneClick: true,
          perMachine: true,
          installerIcon: 'build/icons/win/icon.ico',
          uninstallerIcon: 'build/icons/win/icon.ico',
          installerHeaderIcon: 'build/icons/win/icon.ico',
          runAfterFinish: true,
        },
        linux: {
          target: 'AppImage',
          maintainer: 'Moon Tweaks',
          vendor: 'Moon Tweaks',
          icon: 'build/icons/linux/1024x1024.png',
          synopsis: 'Moon Tweaks',
          description: 'Moon Tweaks',
          category: 'Game',
        },
        mac: {
          category: 'Game',
          target: 'dmg',
          icon: 'build/icons/macos/icon.icns',
        },
      },
    },
  },
};
