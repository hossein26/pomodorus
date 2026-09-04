/**
 * The Mac shell: a window, a menu bar widget, and launch at login.
 *
 * The renderer owns the timer — every fact about it lives in the page, which
 * is why the page works with no shell around it at all. This process owns
 * three things the page cannot: the tray title with the countdown, the bell
 * while the window is hidden (a hidden renderer's timers are throttled, so it
 * cannot be trusted to ring on time), and the login item.
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  nativeImage,
  ipcMain,
  shell,
} = require("electron");
const path = require("node:path");

const DEV_URL = "http://localhost:5174";

let win = null;
let tray = null;
let quitting = false;
/** The watchdog armed on the running session's end. */
let bellTimer = null;
let bellArmedFor = null;
/** Ring ids already bounced for, so one bell bounces once. */
let bouncedRing = null;
/** The menu the page's last state builds, popped up on demand. */
let trayMenu = null;
/** The last state the page pushed, which the menu is built from. */
let lastTrayState = { mode: "idle", quickStart: null };

app.setName("Pomodorus");

function show() {
  if (win === null) {
    createWindow();
    return;
  }
  if (!win.isVisible()) win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 800,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: "#000000",
    title: "Pomodorus",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The one outbound link opens in the real browser, not in a second window
  // with no chrome and no way back.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (app.isPackaged) {
    void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    void win.loadURL(DEV_URL);
  }

  win.once("ready-to-show", () => win?.show());

  // Headless smoke test: POMODORUS_SMOKE=/tmp/shot.png captures the first
  // paint and exits, so CI can prove the packaged app renders with no display.
  // POMODORUS_ROUTE="#/app" navigates first, to capture past the landing.
  if (process.env.POMODORUS_SMOKE && win !== null) {
    const out = process.env.POMODORUS_SMOKE;
    const route = process.env.POMODORUS_ROUTE;
    win.webContents.once("did-finish-load", () => {
      const go = route
        ? win.webContents.executeJavaScript(`location.hash=${JSON.stringify(route)}`)
        : Promise.resolve();
      void go.finally(() => {
        setTimeout(() => {
          win?.webContents
            .capturePage()
            .then((image) => require("node:fs").writeFileSync(out, image.toPNG()))
            .then(
              () => {
                quitting = true;
                app.exit(0);
              },
              () => {
                quitting = true;
                app.exit(1);
              },
            );
        }, 3000);
      });
    });
  }

  // Closing the window parks the app in the menu bar rather than quitting:
  // the countdown keeps living in the tray title, and the bell still rings.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

function trayIcon() {
  // Unpacked: beside the shell. Packaged: electron-builder's extraResources.
  // The @2x sibling is picked up automatically on a retina bar.
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets", "tray.png")
    : path.join(__dirname, "..", "build", "tray.png");
}

function createTray() {
  // The app's own icon, in full colour: a template image would reduce the
  // dark tile to a solid black square. The tile is dark with a faint edge,
  // so it reads on light bars and dark ones alike.
  const image = nativeImage.createFromPath(trayIcon());
  tray = new Tray(image);
  tray.setToolTip("Pomodorus");
  tray.setTitle("", { fontType: "monospacedDigit" });
  paintMenu();
  // Left-click opens the widget's menu — the full management without opening
  // the window. Right-click is the play/pause toggle.
  tray.on("click", () => {
    if (trayMenu) tray.popUpContextMenu(trayMenu);
  });
  tray.on("right-click", onToggle);
}

/**
 * Play/pause on one gesture: with nothing live it starts the picked timer on
 * the spot; with something running it stops it (cancel a pomodoro, skip a
 * break); with something ringing it ends the ring. The page applies each to
 * the live session it finds, so a tap that raced the bell simply lands
 * nowhere.
 */
function onToggle() {
  const state = lastTrayState;
  if (state.mode === "idle") {
    if (!state.quickStart) {
      if (trayMenu) tray.popUpContextMenu(trayMenu);
      return;
    }
    sendCommand("quick-start");
    new Notification({
      title: "شروع شد",
      body: state.quickStart.label,
    }).show();
    return;
  }
  if (state.mode === "running") {
    sendCommand("cancel");
    return;
  }
  sendCommand("confirm");
}

function loginEnabled() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setLogin(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch {
    // A choice the OS refuses is still stored by the page, and applied again
    // on the next launch.
  }
  paintMenu();
}

function sendCommand(id) {
  try {
    win?.webContents.send("tray-command", id);
  } catch {
    // The page will pick the state up on its next tick instead.
  }
}

function showAndSend(id) {
  show();
  sendCommand(id);
}

function paintMenu() {
  if (tray === null) return;
  const state = lastTrayState;
  const dynamic = [];

  if (state.mode === "idle") {
    if (state.quickStart) {
      dynamic.push({
        label: state.quickStart.label,
        click: () => sendCommand("quick-start"),
      });
    } else {
      dynamic.push({
        label: String(state.emptyLabel ?? ""),
        enabled: false,
      });
    }
  } else {
    for (const action of state.actions ?? []) {
      dynamic.push({
        label: action.label,
        click: () => sendCommand(action.id),
      });
    }
  }

  trayMenu = Menu.buildFromTemplate([
    ...dynamic,
    { type: "separator" },
    { label: "نمایش تایمر", click: show },
    {
      label: "کارنامه",
      click: () => showAndSend("show-stats"),
    },
    { type: "separator" },
    {
      label: "باز شدن همراه مک",
      type: "checkbox",
      checked: loginEnabled(),
      click: (item) => setLogin(item.checked),
    },
    { type: "separator" },
    {
      label: "خروج",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function disarm() {
  if (bellTimer !== null) {
    clearTimeout(bellTimer);
    bellTimer = null;
  }
  bellArmedFor = null;
}

/**
 * The bell while the window cannot ring for itself.
 *
 * A hidden renderer's timers are throttled to about one callback a minute, so
 * the page is armed with the end instant and this process — whose own timers
 * are not throttled — rings instead. It only ever announces: ending the ring
 * stays the page's deliberate tap.
 */
function armWatchdog(id, endsAt, label) {
  disarm();
  const wait = endsAt - Date.now();
  if (!Number.isFinite(wait) || wait <= 0) return;
  bellArmedFor = id;
  bellTimer = setTimeout(() => {
    bellTimer = null;
    // A visible window rings for itself — sound, notification, title and all.
    // Stepping in as well would double every bell.
    if (win !== null && win.isVisible()) return;
    new Notification({
      title: "تموم شد!",
      body: label !== "" ? label : "برگرد تاییدش کن",
    }).show();
    try {
      app.dock.bounce("informational");
    } catch {
      // Not a dock to bounce on.
    }
  }, wait);
  // A timer must never keep the app alive on its own: quitting while one is
  // armed still quits.
  if (typeof bellTimer.unref === "function") bellTimer.unref();
}

function onTrayState(state) {
  if (tray === null || !state || typeof state !== "object") return;
  lastTrayState = state;
  paintMenu();
  if (state.mode === "idle") {
    disarm();
    tray.setTitle("", { fontType: "monospacedDigit" });
    tray.setToolTip("Pomodorus");
    return;
  }
  if (state.mode === "running") {
    tray.setTitle(String(state.title ?? ""), { fontType: "monospacedDigit" });
    tray.setToolTip(
      typeof state.label === "string" && state.label !== "" ? state.label : "Pomodorus",
    );
    bouncedRing = null;
    if (typeof state.id === "string" && typeof state.endsAt === "number") {
      armWatchdog(state.id, state.endsAt, state.label ?? "");
    }
    return;
  }
  if (state.mode === "ringing") {
    disarm();
    // Prefixed, so a ring reads differently from a countdown at a glance in
    // a bar full of numbers.
    tray.setTitle(`● ${String(state.title ?? "")}`, { fontType: "monospacedDigit" });
    if (state.id !== bouncedRing) {
      bouncedRing = state.id;
      // A visible window is already making all the noise there is. A hidden
      // one gets the dock instead.
      if (win === null || !win.isVisible()) {
        try {
          app.dock.bounce("informational");
        } catch {
          // Not a dock to bounce on.
        }
      }
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", show);

  void app.whenReady().then(() => {
    createWindow();
    createTray();

    ipcMain.on("set-tray", (_event, state) => {
      try {
        onTrayState(state);
      } catch {
        // The menu bar is decoration: it must never break the app.
      }
    });
    ipcMain.on("set-autostart", (_event, enabled) => setLogin(enabled === true));

    app.on("activate", show);
  });

  app.on("window-all-closed", () => {
    // Mac convention: the tray keeps the app alive with no window open.
  });

  app.on("before-quit", () => {
    quitting = true;
    disarm();
  });
}
