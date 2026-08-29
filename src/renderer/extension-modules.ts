// Shared loader for runtime extension modules (`widget.tsx`). One extension
// module can export several surfaces - a widget and a settings section - so the
// host discovers the modules once here and lets each consumer (WidgetHost,
// SettingsView) extract the exports it cares about. Discovery, dynamic import,
// and packaged-mode stylesheet injection all live in one place so the two
// consumers stay in lockstep with the widget delivery pipeline.

export type RuntimeModuleImporter = (moduleUrl: string) => Promise<unknown>;

// Loads every discovered extension module, injecting each one's compiled
// stylesheet (packaged mode) before importing it. Modules that fail to import
// are skipped so one broken extension never blanks the page.
export async function loadExtensionModules(
  importer: RuntimeModuleImporter = importRuntimeModule,
): Promise<unknown[]> {
  let descriptors: Awaited<ReturnType<NonNullable<typeof window.hatch>["widgets"]["list"]>> | undefined;
  try {
    descriptors = await window.hatch?.widgets.list();
  } catch (error) {
    console.error("[hatch] widgets.list failed", error);
    return [];
  }
  if (!descriptors?.length) return [];

  const modules = await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        if (descriptor.cssUrl) ensureWidgetStylesheet(descriptor.cssUrl);
        return await importer(descriptor.moduleUrl);
      } catch (error) {
        console.error(`[hatch] failed to import widget ${descriptor.moduleUrl}`, error);
        return null;
      }
    }),
  );
  return modules.filter((module): module is unknown => module !== null);
}

// Injects a compiled extension's Tailwind stylesheet (packaged mode only). Dev
// mode descriptors carry no cssUrl because utilities come from the global
// stylesheet. Deduplicated by href so loading the same module from both the
// widget host and the settings view only adds the link once.
export function ensureWidgetStylesheet(href: string) {
  if (typeof document === "undefined") return;
  const resolved = toRuntimeModuleHref(href);
  if (document.querySelector(`link[data-hatch-widget-css="${CSS.escape(resolved)}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = resolved;
  link.dataset.hatchWidgetCss = resolved;
  document.head.appendChild(link);
}

const nativeImport = new Function("url", "return import(url)") as (url: string) => Promise<unknown>;

export function toRuntimeModuleHref(moduleUrl: string, base = globalThis.location?.href ?? "http://127.0.0.1/"): string {
  if (/^(https?:|data:|blob:)/i.test(moduleUrl)) return moduleUrl;
  try {
    return new URL(moduleUrl, base).href;
  } catch {
    return moduleUrl;
  }
}

export function importRuntimeModule(moduleUrl: string): Promise<unknown> {
  return nativeImport(toRuntimeModuleHref(moduleUrl));
}
