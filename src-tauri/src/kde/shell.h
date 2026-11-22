#ifndef HATCH_KDE_SHELL_H
#define HATCH_KDE_SHELL_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct HatchKdeCallbacks {
  void (*on_toggle)(double x, double y, double w, double h, void *user);
  void (*on_quit)(void *user);
  void (*on_blur)(void *user);
} HatchKdeCallbacks;

int hatch_kde_main(
  const char *icon_on_dark,
  const char *icon_on_light,
  const char *ui_url,
  HatchKdeCallbacks callbacks,
  void *user
);
void hatch_kde_show(double x, double y, double w, double h);
void hatch_kde_hide(void);
int hatch_kde_visible(void);
void hatch_kde_set_bounds(double x, double y, double w, double h);
void hatch_kde_eval(const char *javascript);
void hatch_kde_quit(void);
void hatch_kde_open_url(const char *url);
void hatch_kde_work_area(double x, double y, double *out_x, double *out_y, double *out_w, double *out_h);
void hatch_kde_set_autostart(int enable, const char *exec_path, const char *icon_name);

#ifdef __cplusplus
}
#endif

#endif
