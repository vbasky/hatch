import { useLayoutEffect, useState } from "react";

/** Tray overlays must portal into the opaque `.app-shell`, not `document.body`.
 *  Hatch's window is transparent; a body portal paints the dimmer onto glass and
 *  leaves Settings fully visible behind the dialog. */
export function overlayPortalContainer(): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLElement>(".app-shell") ?? undefined;
}

export function useOverlayPortalContainer(): HTMLElement | undefined {
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined);
  useLayoutEffect(() => {
    setContainer(overlayPortalContainer() ?? document.body);
  }, []);
  return container;
}
