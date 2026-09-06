#include "shell.h"

#include <QAction>
#include <QApplication>
#include <QCoreApplication>
#include <QColor>
#include <QCursor>
#include <QDBusArgument>
#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusMessage>
#include <QDBusReply>
#include <QDBusVirtualObject>
#include <QDesktopServices>
#include <QObject>
#include <QRegion>
#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QIcon>
#include <QMargins>
#include <QMenu>
#include <QMetaObject>
#include <QPalette>
#include <QRect>
#include <QScreen>

#ifdef HATCH_HAS_LAYER_SHELL
#include <LayerShellQt/Window>
#endif
#ifdef HATCH_HAS_KWINDOW_EFFECTS
#include <KWindowEffects>
#include <QPainterPath>
#endif
#include <QRegularExpression>
#include <QStandardPaths>
#include <QStyleHints>
#include <QSystemTrayIcon>
#include <QTextStream>
#include <QTimer>
#include <QUrl>
#include <QWebEngineSettings>
#include <QWebEngineView>
#include <QWindow>

#include <QEvent>

namespace {

HatchKdeCallbacks g_callbacks{};
void *g_user = nullptr;
QWebEngineView *g_popover = nullptr;
QSystemTrayIcon *g_tray = nullptr;
QString g_icon_on_dark;
QString g_icon_on_light;
QRect g_last_popover;
QTimer *g_follow_timer = nullptr;
bool g_follow_tick = false;
bool g_panel_unfloated = false;

void place_popover(const QRect &popover);
int panel_thickness();
int panel_attach_margin(const QRect &output, int reserved, int thick);
void start_panel_follow();
void stop_panel_follow();
void connect_screen_follow();

QString color_css(const QColor &color);
QString plasma_native_script();

bool system_is_dark() {
  const auto scheme = QGuiApplication::styleHints()->colorScheme();
  if (scheme == Qt::ColorScheme::Dark) {
    return true;
  }
  if (scheme == Qt::ColorScheme::Light) {
    return false;
  }
  return QGuiApplication::palette().color(QPalette::Window).lightness() < 128;
}

void apply_system_theme() {
  const bool dark = system_is_dark();
  if (g_tray) {
    const QString &path = dark ? g_icon_on_dark : g_icon_on_light;
    if (!path.isEmpty()) {
      g_tray->setIcon(QIcon(path));
    }
  }
  if (!g_popover) {
    return;
  }
  const QString script = dark
    ? QStringLiteral(
        "document.documentElement.dataset.theme='dark';"
        "document.documentElement.classList.add('dark');"
        "document.documentElement.classList.remove('light');"
        "document.documentElement.style.colorScheme='dark';"
        "if(document.body){document.body.dataset.theme='dark';document.body.classList.add('dark');document.body.classList.remove('light');}"
      )
    : QStringLiteral(
        "document.documentElement.dataset.theme='light';"
        "document.documentElement.classList.add('light');"
        "document.documentElement.classList.remove('dark');"
        "document.documentElement.style.colorScheme='light';"
        "if(document.body){document.body.dataset.theme='light';document.body.classList.add('light');document.body.classList.remove('dark');}"
      );
  g_popover->page()->runJavaScript(script + plasma_native_script());
}

QString color_css(const QColor &color) {
  // CSS 8-digit hex is #RRGGBBAA. Qt HexArgb is #AARRGGBB, which Chromium
  // reads as a different colour at ~16% alpha — that is the washed pink text.
  return QStringLiteral("rgba(%1, %2, %3, 1)")
    .arg(color.red())
    .arg(color.green())
    .arg(color.blue());
}

QString plasma_native_script() {
  const QPalette pal = QGuiApplication::palette();
  const QColor window = pal.color(QPalette::Window);
  const QColor text = pal.color(QPalette::WindowText);
  const QColor highlight = pal.color(QPalette::Highlight);
  const QColor highlighted_text = pal.color(QPalette::HighlightedText);
  return QStringLiteral(
           "document.documentElement.classList.add('plasma-native');"
           "if(document.body){document.body.classList.add('plasma-native');}"
           "document.documentElement.style.setProperty('--plasma-window','%1');"
           "document.documentElement.style.setProperty('--plasma-window-text','%2');"
           "document.documentElement.style.setProperty('--plasma-highlight','%3');"
           "document.documentElement.style.setProperty('--plasma-highlighted-text','%4');"
         )
    .arg(color_css(window), color_css(text), color_css(highlight), color_css(highlighted_text));
}

#ifdef HATCH_HAS_KWINDOW_EFFECTS
void apply_plasma_effects() {
  if (!g_popover) {
    return;
  }
  if (!g_popover->windowHandle()) {
    g_popover->winId();
  }
  QWindow *window = g_popover->windowHandle();
  if (!window) {
    return;
  }
  QPainterPath path;
  path.addRoundedRect(QRectF(QPointF(0, 0), window->size()), 8, 8);
  const QRegion region(path.toFillPolygon().toPolygon());
  if (KWindowEffects::isEffectAvailable(KWindowEffects::BlurBehind)) {
    KWindowEffects::enableBlurBehind(window, true, region);
  }
  if (KWindowEffects::isEffectAvailable(KWindowEffects::BackgroundContrast)) {
    // Plasma applet defaults (libplasma Dialog): keep text readable over blur.
    KWindowEffects::enableBackgroundContrast(window, true, 0.3, 1.0, 2.0, region);
  }
  // Do not slideWindow(BottomEdge): KWin then parks the surface on the
  // exclusive-zone strut, which is why margin changes never appeared.
}
#endif

class BlurFilter : public QObject {
public:
  using QObject::QObject;

protected:
  bool eventFilter(QObject *watched, QEvent *event) override {
    if (event->type() == QEvent::WindowDeactivate && g_callbacks.on_blur) {
      g_callbacks.on_blur(g_user);
    }
    return QObject::eventFilter(watched, event);
  }
};

class ThemeFilter : public QObject {
public:
  using QObject::QObject;

protected:
  bool eventFilter(QObject *watched, QEvent *event) override {
    if (event->type() == QEvent::ApplicationPaletteChange || event->type() == QEvent::ThemeChange) {
      apply_system_theme();
    }
    return QObject::eventFilter(watched, event);
  }
};

QScreen *anchor_screen(const QPoint &hint) {
  if (QScreen *screen = QGuiApplication::screenAt(hint)) {
    return screen;
  }
  return QGuiApplication::primaryScreen();
}

bool plausible_tray_rect(const QRect &rect, const QRect &output) {
  if (!rect.isValid() || rect.width() < 8 || rect.height() < 8) {
    return false;
  }
  // Wayland SNI often reports a dummy rect at the output origin.
  if (rect.x() <= output.x() + 2 && rect.y() <= output.y() + 2) {
    return false;
  }
  return output.intersects(rect);
}

QRect tray_anchor() {
  QScreen *screen = QGuiApplication::primaryScreen();
  const QRect output = screen ? screen->geometry() : QRect(0, 0, 1920, 1080);
  const QRect available = screen ? screen->availableGeometry() : output;

  if (g_tray) {
    const QRect geometry = g_tray->geometry();
    if (plausible_tray_rect(geometry, output)) {
      return geometry;
    }
  }

  const QPoint cursor = QCursor::pos();
  const bool cursor_usable = cursor.x() > output.x() + 24 || cursor.y() > output.y() + 24;
  if (cursor_usable && output.contains(cursor, false)) {
    return QRect(cursor.x() - 11, cursor.y() - 11, 22, 22);
  }

  // Plasma's default panel puts the system tray on the right of a bottom bar.
  return QRect(available.right() - 36, available.bottom() - 4, 22, 22);
}

void fire_toggle() {
  if (!g_callbacks.on_toggle) {
    return;
  }
  const QRect anchor = tray_anchor();
  g_callbacks.on_toggle(anchor.x(), anchor.y(), anchor.width(), anchor.height(), g_user);
}

bool on_wayland() {
  return QGuiApplication::platformName().contains(QLatin1String("wayland"));
}

#ifdef HATCH_HAS_LAYER_SHELL
LayerShellQt::Window *layer_shell_window() {
  if (!g_popover) {
    return nullptr;
  }
  if (!g_popover->windowHandle()) {
    g_popover->setAttribute(Qt::WA_NativeWindow, true);
  }
  QWindow *handle = g_popover->windowHandle();
  if (!handle) {
    return nullptr;
  }
  return LayerShellQt::Window::get(handle);
}

void ensure_layer_shell() {
  LayerShellQt::Window *layer = layer_shell_window();
  if (!layer) {
    return;
  }
  layer->setLayer(LayerShellQt::Window::LayerTop);
  layer->setKeyboardInteractivity(LayerShellQt::Window::KeyboardInteractivityOnDemand);
  layer->setScope(QStringLiteral("popover"));
  layer->setCloseOnDismissed(false);
  layer->setExclusiveZone(-1);
  layer->setWantsToBeOnActiveScreen(false);
  layer->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorBottom) | LayerShellQt::Window::AnchorRight);
  layer->setMargins(QMargins(0, 0, 8, panel_thickness()));
}

void remake_as_layer_shell() {
  ensure_layer_shell();
  QWindow *handle = g_popover ? g_popover->windowHandle() : nullptr;
  if (handle && handle->handle()) {
    // Already mapped as xdg_toplevel. Destroy so the next show() creates a
    // zwlr_layer_surface and our anchors/margins actually apply.
    handle->destroy();
  }
  ensure_layer_shell();
}
#endif

QRect plasma_work_area(QScreen *screen) {
  const QRect fallback = screen ? screen->availableGeometry() : QRect();
  if (!screen) {
    return fallback;
  }
  QDBusInterface iface(
    QStringLiteral("org.kde.plasmashell"),
    QStringLiteral("/StrutManager"),
    QStringLiteral("org.kde.PlasmaShell.StrutManager"),
    QDBusConnection::sessionBus()
  );
  if (!iface.isValid()) {
    return fallback;
  }
  const QDBusMessage reply = iface.call(QStringLiteral("availableScreenRect"), screen->name());
  if (reply.type() != QDBusMessage::ReplyMessage || reply.arguments().isEmpty()) {
    return fallback;
  }
  const QVariant value = reply.arguments().first();
  if (value.canConvert<QRect>()) {
    const QRect rect = value.value<QRect>();
    if (rect.isValid()) {
      return rect;
    }
  }
  if (value.canConvert<QDBusArgument>()) {
    const QDBusArgument arg = value.value<QDBusArgument>();
    int x = 0, y = 0, w = 0, h = 0;
    arg.beginStructure();
    arg >> x >> y >> w >> h;
    arg.endStructure();
    const QRect rect(x, y, w, h);
    if (rect.isValid()) {
      return rect;
    }
  }
  return fallback;
}

int panel_thickness() {
  static int cached = 0;
  if (cached > 0) {
    return cached;
  }
  const QString path = QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation)
    + QStringLiteral("/plasmashellrc");
  QFile file(path);
  if (file.open(QIODevice::ReadOnly | QIODevice::Text)) {
    const QString text = QString::fromUtf8(file.readAll());
    const QRegularExpression re(QStringLiteral("thickness=(\\d+)"));
    const auto match = re.match(text);
    if (match.hasMatch()) {
      cached = match.captured(1).toInt();
    }
  }
  if (cached <= 0) {
    cached = 46;
  }
  return cached;
}

int panel_attach_margin(const QRect &output, int reserved, int thick) {
  if (g_tray) {
    const QRect tray = g_tray->geometry();
    if (plausible_tray_rect(tray, output)) {
      const int from_tray = output.y() + output.height() - tray.top();
      if (from_tray > 0) {
        return from_tray;
      }
    }
  }
  // Floating panel: sit on the 62px window top. Unfloated (app window
  // behind): sit on the 46px visual bar, same as Audio Volume.
  if (g_panel_unfloated && thick > 0) {
    return thick;
  }
  if (reserved > 0) {
    return reserved;
  }
  return qMax(1, thick);
}

void stop_panel_follow() {
  if (g_follow_timer) {
    g_follow_timer->stop();
  }
}

void start_panel_follow() {
  if (!g_follow_timer) {
    g_follow_timer = new QTimer;
    g_follow_timer->setInterval(16);
    QObject::connect(g_follow_timer, &QTimer::timeout, []() {
      if (!g_popover || !g_popover->isVisible()) {
        stop_panel_follow();
        return;
      }
      if (g_last_popover.isValid()) {
        g_follow_tick = true;
        place_popover(g_last_popover);
        g_follow_tick = false;
      }
    });
  }
  g_follow_timer->start();
}

class HatchPanelDBus : public QDBusVirtualObject {
public:
  QString introspect(const QString &) const override {
    return QStringLiteral(
      "<interface name=\"org.hatch.Panel\">"
      "<method name=\"setUnfloated\"><arg type=\"b\" direction=\"in\"/></method>"
      "</interface>");
  }
  bool handleMessage(const QDBusMessage &message, const QDBusConnection &connection) override {
    if (message.member() != QLatin1String("setUnfloated")) {
      return false;
    }
    const bool unfloated = message.arguments().value(0).toBool();
    if (g_panel_unfloated != unfloated) {
      g_panel_unfloated = unfloated;
      if (g_popover && g_popover->isVisible() && g_last_popover.isValid()) {
        place_popover(g_last_popover);
      }
    }
    connection.send(message.createReply());
    return true;
  }
};

HatchPanelDBus *g_panel_dbus = nullptr;

void start_panel_watch() {
  auto bus = QDBusConnection::sessionBus();
  bus.registerService(QStringLiteral("org.hatch.Panel"));
  if (!g_panel_dbus) {
    g_panel_dbus = new HatchPanelDBus;
  }
  bus.registerVirtualObject(QStringLiteral("/org/hatch/Panel"), g_panel_dbus);

  const QString path = QDir::temp().filePath(QStringLiteral("hatch-kwin-panel.js"));
  QFile file(path);
  if (file.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
    QTextStream out(&file);
    out << QStringLiteral(
      "function hatchPanelUnfloated() {\n"
      "  var list = workspace.windowList();\n"
      "  var screenH = workspace.virtualScreenSize.height;\n"
      "  for (var i = 0; i < list.length; i++) {\n"
      "    var w = list[i];\n"
      "    if (w.dock) continue;\n"
      "    var cls = '';\n"
      "    try { cls = String(w.resourceClass).toLowerCase(); } catch (e) {}\n"
      "    if (cls.indexOf('hatch') !== -1) continue;\n"
      "    if (cls.indexOf('plasmashell') !== -1) continue;\n"
      "    if (cls.indexOf('kwin') !== -1) continue;\n"
      "    try { if (w.desktopWindow) continue; } catch (e) {}\n"
      "    try { if (w.skipTaskbar) continue; } catch (e) {}\n"
      "    if (w.minimized) continue;\n"
      "    var maxed = false;\n"
      "    try { maxed = !!w.maximized; } catch (e) {}\n"
      "    try { if (w.fullScreen) maxed = true; } catch (e) {}\n"
      "    try {\n"
      "      var g = w.frameGeometry;\n"
      "      if (!maxed && g.y <= 8 && g.height > screenH * 0.85 && g.width > 400) maxed = true;\n"
      "    } catch (e) {}\n"
      "    if (maxed) return true;\n"
      "  }\n"
      "  return false;\n"
      "}\n"
      "function hatchReport() {\n"
      "  callDBus('org.hatch.Panel', '/org/hatch/Panel', 'org.hatch.Panel', 'setUnfloated', hatchPanelUnfloated());\n"
      "}\n"
      "function hatchHook(w) {\n"
      "  try { w.maximizedChanged.connect(hatchReport); } catch (e) {}\n"
      "  try { w.fullScreenChanged.connect(hatchReport); } catch (e) {}\n"
      "  try { w.frameGeometryChanged.connect(hatchReport); } catch (e) {}\n"
      "}\n"
      "workspace.windowAdded.connect(function(w) { hatchHook(w); hatchReport(); });\n"
      "workspace.windowRemoved.connect(hatchReport);\n"
      "var existing = workspace.windowList();\n"
      "for (var i = 0; i < existing.length; i++) hatchHook(existing[i]);\n"
      "hatchReport();\n"
    );
  }
  QDBusInterface scripting(
    QStringLiteral("org.kde.KWin"),
    QStringLiteral("/Scripting"),
    QStringLiteral("org.kde.kwin.Scripting")
  );
  scripting.call(QStringLiteral("unloadScript"), QStringLiteral("hatch-panel-watch"));
  scripting.call(QStringLiteral("loadScript"), path, QStringLiteral("hatch-panel-watch"));
  scripting.call(QStringLiteral("start"));
}

void stop_panel_watch() {
  QDBusInterface scripting(
    QStringLiteral("org.kde.KWin"),
    QStringLiteral("/Scripting"),
    QStringLiteral("org.kde.kwin.Scripting")
  );
  scripting.call(QStringLiteral("unloadScript"), QStringLiteral("hatch-panel-watch"));
}

void connect_screen_follow() {
  static bool connected = false;
  if (connected) {
    return;
  }
  connected = true;
  const auto hook = [](QScreen *screen) {
    if (!screen) {
      return;
    }
    QObject::connect(screen, &QScreen::availableGeometryChanged, qApp, []() {
      if (g_popover && g_popover->isVisible() && g_last_popover.isValid()) {
        place_popover(g_last_popover);
      }
    });
    QObject::connect(screen, &QScreen::geometryChanged, qApp, []() {
      if (g_popover && g_popover->isVisible() && g_last_popover.isValid()) {
        place_popover(g_last_popover);
      }
    });
  };
  for (QScreen *screen : QGuiApplication::screens()) {
    hook(screen);
  }
  QObject::connect(qApp, &QGuiApplication::screenAdded, qApp, [hook](QScreen *screen) { hook(screen); });
}

void place_popover(const QRect &popover) {
  if (!g_popover) {
    return;
  }
  g_last_popover = popover;
  g_popover->resize(popover.size());

#ifdef HATCH_HAS_LAYER_SHELL
  if (on_wayland()) {
    ensure_layer_shell();
    LayerShellQt::Window *layer = layer_shell_window();
    if (layer) {
      const QRect tray = tray_anchor();
      QScreen *screen = anchor_screen(tray.center());
      const QRect output = screen ? screen->geometry() : popover;
      const QRect available = plasma_work_area(screen);
      const QRect work = available.isValid() ? available : output;
      const int top_inset = qMax(0, work.y() - output.y());
      const int left_inset = qMax(0, work.x() - output.x());
      const int right_inset = qMax(0, (output.x() + output.width()) - (work.x() + work.width()));
      const int bottom_inset = qMax(0, (output.y() + output.height()) - (work.y() + work.height()));
      const int thick = panel_thickness();
      const int reserved = bottom_inset >= top_inset ? bottom_inset : qMax(top_inset, qMax(left_inset, right_inset));
      const int attach = panel_attach_margin(output, reserved, thick);
      layer->setExclusiveZone(-1);
      if (!g_follow_tick) {
        QFile log(QStringLiteral("/tmp/hatch-place.log"));
        if (log.open(QIODevice::Append | QIODevice::Text)) {
          QTextStream out(&log);
          const QRect tg = g_tray ? g_tray->geometry() : QRect();
          out << "attach=" << attach << " reserved=" << reserved << " thick=" << thick
              << " unfloated=" << (g_panel_unfloated ? 1 : 0)
              << " zone=" << layer->exclusionZone() << " marginB=" << layer->margins().bottom()
              << " tray=" << tg.x() << "," << tg.y() << " " << tg.width() << "x" << tg.height()
              << " out=" << output.width() << "x" << output.height() << "\n";
        }
      }
      layer->setScreen(screen);
      layer->setDesiredSize(popover.size());
      if (bottom_inset >= top_inset && bottom_inset >= left_inset && bottom_inset >= right_inset) {
        layer->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorBottom) | LayerShellQt::Window::AnchorRight);
        layer->setMargins(QMargins(0, 0, 8, attach));
      } else if (top_inset >= left_inset && top_inset >= right_inset) {
        layer->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorTop) | LayerShellQt::Window::AnchorRight);
        layer->setMargins(QMargins(0, attach, 8, 0));
      } else if (right_inset >= left_inset) {
        layer->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorRight) | LayerShellQt::Window::AnchorBottom);
        layer->setMargins(QMargins(0, 0, attach, qBound(8, output.y() + output.height() - tray.center().y() - popover.height() / 2, output.height() - 8)));
      } else {
        layer->setAnchors(LayerShellQt::Window::Anchors(LayerShellQt::Window::AnchorLeft) | LayerShellQt::Window::AnchorBottom);
        layer->setMargins(QMargins(attach, 0, 0, qBound(8, output.y() + output.height() - tray.center().y() - popover.height() / 2, output.height() - 8)));
      }
#ifdef HATCH_HAS_KWINDOW_EFFECTS
      if (!g_follow_tick) {
        apply_plasma_effects();
      }
#endif
      return;
    }
  }
#endif

  g_popover->setGeometry(popover);
#ifdef HATCH_HAS_KWINDOW_EFFECTS
  if (!g_follow_tick) {
    apply_plasma_effects();
  }
#endif
}

} // namespace

int hatch_kde_main(
  const char *icon_on_dark,
  const char *icon_on_light,
  const char *ui_url,
  HatchKdeCallbacks callbacks,
  void *user
) {
  g_callbacks = callbacks;
  g_user = user;
  g_icon_on_dark = QString::fromUtf8(icon_on_dark ? icon_on_dark : "");
  g_icon_on_light = QString::fromUtf8(icon_on_light && icon_on_light[0] != '\0' ? icon_on_light : icon_on_dark);

  static int argc = 1;
  static char arg0[] = "hatch";
  static char *argv[] = {arg0, nullptr};
  QApplication app(argc, argv);
  QCoreApplication::setApplicationName("Hatch");
  QCoreApplication::setOrganizationName("hatch");
  QGuiApplication::setDesktopFileName("hatch");
  QApplication::setQuitOnLastWindowClosed(false);

  auto *popover = new QWebEngineView;
  popover->setObjectName("hatch-popover");
  popover->setWindowTitle("Hatch");
  popover->setWindowFlags(
    Qt::Tool | Qt::FramelessWindowHint | Qt::WindowStaysOnTopHint | Qt::NoDropShadowWindowHint
  );
  popover->setAttribute(Qt::WA_TranslucentBackground, true);
  popover->setAttribute(Qt::WA_NativeWindow, true);
  popover->resize(504, 620);
  popover->setAttribute(Qt::WA_X11NetWmWindowTypeUtility, true);
  popover->hide();
  popover->installEventFilter(new BlurFilter(popover));
  popover->page()->setBackgroundColor(Qt::transparent);
  popover->settings()->setAttribute(QWebEngineSettings::JavascriptEnabled, true);
  popover->settings()->setAttribute(QWebEngineSettings::LocalContentCanAccessRemoteUrls, true);
  g_popover = popover;
#ifdef HATCH_HAS_LAYER_SHELL
  if (on_wayland()) {
    remake_as_layer_shell();
  }
#endif
  popover->setUrl(QUrl(QString::fromUtf8(ui_url)));
  popover->hide();
#ifdef HATCH_HAS_LAYER_SHELL
  if (on_wayland()) {
    remake_as_layer_shell();
  }
#endif

  auto *tray = new QSystemTrayIcon;
  tray->setToolTip(QStringLiteral("Hatch"));
  g_tray = tray;
  apply_system_theme();
  QObject::connect(QGuiApplication::styleHints(), &QStyleHints::colorSchemeChanged, [](Qt::ColorScheme) {
    apply_system_theme();
  });
  app.installEventFilter(new ThemeFilter(&app));

  auto *menu = new QMenu;
  auto *toggle = menu->addAction(QStringLiteral("Toggle Hatch"));
  auto *quit = menu->addAction(QStringLiteral("Quit Hatch"));
  QObject::connect(toggle, &QAction::triggered, []() { fire_toggle(); });
  QObject::connect(quit, &QAction::triggered, []() {
    if (g_callbacks.on_quit) {
      g_callbacks.on_quit(g_user);
    }
  });
  tray->setContextMenu(menu);
  QObject::connect(tray, &QSystemTrayIcon::activated, [](QSystemTrayIcon::ActivationReason reason) {
    if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick) {
      fire_toggle();
    }
  });
  QObject::connect(popover, &QWebEngineView::loadFinished, [](bool) {
    apply_system_theme();
#ifdef HATCH_HAS_KWINDOW_EFFECTS
    apply_plasma_effects();
#endif
  });
  tray->show();
  connect_screen_follow();
  start_panel_watch();

  if (qEnvironmentVariableIntValue("HATCH_OPEN_POPOVER_ON_START") == 1) {
    QTimer::singleShot(0, []() { fire_toggle(); });
  }

  return QApplication::exec();
}

void hatch_kde_show(double x, double y, double w, double h) {
  if (!g_popover) {
    return;
  }
  QMetaObject::invokeMethod(
    g_popover,
    [x, y, w, h]() {
#ifdef HATCH_HAS_LAYER_SHELL
      if (on_wayland()) {
        ensure_layer_shell();
      }
#endif
      place_popover(QRect(int(x), int(y), int(w), int(h)));
      g_popover->show();
      place_popover(QRect(int(x), int(y), int(w), int(h)));
#ifdef HATCH_HAS_KWINDOW_EFFECTS
      apply_plasma_effects();
#endif
      g_popover->raise();
      g_popover->activateWindow();
      start_panel_follow();
    },
    Qt::QueuedConnection
  );
}

void hatch_kde_hide(void) {
  if (!g_popover) {
    return;
  }
  QMetaObject::invokeMethod(
    g_popover,
    []() {
      stop_panel_follow();
      g_popover->hide();
    },
    Qt::QueuedConnection
  );
}

int hatch_kde_visible(void) {
  return g_popover && g_popover->isVisible() ? 1 : 0;
}

void hatch_kde_set_bounds(double x, double y, double w, double h) {
  if (!g_popover) {
    return;
  }
  QMetaObject::invokeMethod(
    g_popover,
    [x, y, w, h]() { place_popover(QRect(int(x), int(y), int(w), int(h))); },
    Qt::QueuedConnection
  );
}

void hatch_kde_eval(const char *javascript) {
  if (!g_popover || !javascript) {
    return;
  }
  const QString script = QString::fromUtf8(javascript);
  QMetaObject::invokeMethod(
    g_popover,
    [script]() { g_popover->page()->runJavaScript(script); },
    Qt::QueuedConnection
  );
}

void hatch_kde_quit(void) {
  QMetaObject::invokeMethod(qApp, []() {
    stop_panel_watch();
    QCoreApplication::quit();
  }, Qt::QueuedConnection);
}

void hatch_kde_open_url(const char *url) {
  if (!url) {
    return;
  }
  const QUrl parsed = QUrl(QString::fromUtf8(url));
  QMetaObject::invokeMethod(
    qApp,
    [parsed]() { QDesktopServices::openUrl(parsed); },
    Qt::QueuedConnection
  );
}

void hatch_kde_work_area(double x, double y, double *out_x, double *out_y, double *out_w, double *out_h) {
  QRect area(0, 0, 1440, 900);
  if (QGuiApplication::instance()) {
    const QPoint point{int(x), int(y)};
    QScreen *screen = QGuiApplication::screenAt(point);
    if (!screen) {
      screen = QGuiApplication::primaryScreen();
    }
    if (screen) {
      area = screen->availableGeometry();
    }
  }
  if (out_x) *out_x = area.x();
  if (out_y) *out_y = area.y();
  if (out_w) *out_w = area.width();
  if (out_h) *out_h = area.height();
}

void hatch_kde_set_autostart(int enable, const char *exec_path, const char *icon_name) {
  const QString dir = QStandardPaths::writableLocation(QStandardPaths::ConfigLocation) + QStringLiteral("/autostart");
  QDir().mkpath(dir);
  const QString file_path = dir + QStringLiteral("/hatch.desktop");
  if (!enable) {
    QFile::remove(file_path);
    return;
  }
  QFile file(file_path);
  if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate | QIODevice::Text)) {
    return;
  }
  QTextStream out(&file);
  out << QStringLiteral("[Desktop Entry]\n")
      << QStringLiteral("Type=Application\n")
      << QStringLiteral("Name=Hatch\n")
      << QStringLiteral("Comment=Ask for a menu and help it hatch\n")
      << QStringLiteral("Exec=") << QString::fromUtf8(exec_path ? exec_path : "hatch") << '\n'
      << QStringLiteral("Icon=") << QString::fromUtf8(icon_name ? icon_name : "hatch") << '\n'
      << QStringLiteral("Terminal=false\n")
      << QStringLiteral("Categories=Utility;\n")
      << QStringLiteral("StartupNotify=false\n")
      << QStringLiteral("X-KDE-autostart-after=panel\n");
}
