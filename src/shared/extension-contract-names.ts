// The public, extension-facing slice of the Hatch contract surface.
//
// Extensions cannot see src/shared/contracts.ts (it lives inside the app bundle,
// not in the extension workspace), so the host ships these types into the
// workspace as the `@hatch/contracts` virtual module declared in
// extensions/hatch-env.d.ts. This list is the single source of truth for
// which names that module exposes: tests/extension-contract-surface.test.ts
// fails the moment the declaration file or contracts.ts drifts from it, the same
// way UI_EXPORT_NAMES guards the @hatch/ui surface.
//
// Every name here must be an exported type in src/shared/contracts.ts. Keep the
// host-only surfaces (git, agent, settings, app, recipes, widget loading) out.
export const EXTENSION_CONTRACT_NAMES = [
  // Widget and settings descriptors exported from widget.tsx.
  "HatchWidget",
  "RefreshableHatchWidget",
  "HatchSettingsSection",
  // Root layout.tsx surface: the canvas component and the props the host passes it.
  "HatchLayout",
  "HatchLayoutProps",
  "HatchLayoutWidget",
  // server.ts surface: the action/background context and what it carries.
  "HatchServerContext",
  "HatchDatabase",
  "HatchNotification",
  "HatchBackgroundTask",
  "SqlParams",
  "SqlRunResult",
  // Bridge data shapes widgets receive over window.hatch.
  "HatchCapabilityDescriptor",
  "BackgroundTaskUpdate",
  "PopoverVisibilityState",
  // The window.hatch subset widgets call.
  "HatchExtensionApi",
] as const;

export type ExtensionContractName = (typeof EXTENSION_CONTRACT_NAMES)[number];
