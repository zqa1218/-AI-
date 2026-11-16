'use strict';
const { app, BrowserWindow, Menu, shell, dialog, screen } = require('electron');
const path = require('path');
const { start } = require('./server');

const PORT = 8765;
let win = null;
app.setAppUserModelId('com.tiaoran.workbench');
/* 高 DPI 适配：200% 缩放下 Chromium 会把页面按 2x 渲染进 1x 窗口，
   出现「界面放大两倍、右侧被裁」。默认固定 1.5 倍兼顾清晰度与可见范围；
   如需还原系统缩放，设环境变量 TIAORAN_SCALE=0；也可指定具体倍数。 */
const UI_SCALE = process.env.TIAORAN_SCALE === '0' ? 0 : Number(process.env.TIAORAN_SCALE || 1.5) || 1.5;
if (UI_SCALE > 0) app.commandLine.appendSwitch('force-device-scale-factor', String(UI_SCALE));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    let port = PORT;
    try {
      const r = await start(PORT);
      port = r.port;
    } catch (e) {
      dialog.showErrorBox('启动失败', '本地服务启动异常：' + e.message);
      app.quit();
      return;
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
      { label: '编辑', submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]},
      { label: '视图', submenu: [
        { role: 'reload', label: '刷新' }, { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
        { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' }
      ]},
      { label: '帮助', submenu: [
        { label: '打开数据目录', click: () => shell.openPath(path.join(process.env.APPDATA || '', 'TiaoranWorkbench')) },
        { label: '关于', click: () => dialog.showMessageBox({ message: '挑染AI工作台', detail: '图片提示词 / 视频提示词 / 出片\n本地服务端口 ' + port }) }
      ]}
    ]));

    win = new BrowserWindow({
      width: 1440, height: 900, minWidth: 960, minHeight: 620,
      title: '挑染AI工作台',
      backgroundColor: '#0d0f13',
      icon: path.join(__dirname, 'assets', 'icon.ico'),
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false }
    });
    win.once('ready-to-show', () => {
      /* 200% 缩放下 maximize() 会把窗口撑成两倍，按工作区（DIP）显式设边界 */
      try {
        const b = screen.getPrimaryDisplay().bounds;
        const scale = UI_SCALE > 0 ? UI_SCALE : 1;
        win.setBounds({ x: 0, y: 0, width: Math.round(b.width / scale), height: Math.round(b.height / scale) });
      } catch (e) { win.maximize(); }
      win.show();
    });
    win.loadURL('http://127.0.0.1:' + port);
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('http://127.0.0.1:' + port)) { e.preventDefault(); shell.openExternal(url); }
    });
    /* 双击标题栏/最大化按钮时，按 1.5 比例换算后铺满，避免被 200% 缩放撑爆 */
    win.on('maximize', () => {
      setTimeout(() => {
        try {
          const b = screen.getPrimaryDisplay().bounds;
          const s = UI_SCALE > 0 ? UI_SCALE : 1;
          win.setBounds({ x: 0, y: 0, width: Math.round(b.width / s), height: Math.round(b.height / s) });
        } catch (e) {}
      }, 30);
    });
    win.on('closed', () => { win = null; });
  });

  app.on('window-all-closed', () => app.quit());
}