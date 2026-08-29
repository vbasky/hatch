import { WidgetHost } from "./WidgetHost";

export function MenuSurface() {
  return (
    <section className="menu-surface" aria-label="menu widgets">
      <WidgetHost />
    </section>
  );
}
