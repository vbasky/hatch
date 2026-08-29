import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNotifier } from "../src/main/notifier";

describe("notifier", () => {
  const show = vi.fn();
  const isSupported = vi.fn(() => true);

  beforeEach(() => {
    vi.clearAllMocks();
    isSupported.mockReturnValue(true);
  });

  it("shows a native notification with title and body", () => {
    createNotifier({ isSupported, show })({ title: "CPU high", body: "95%" });

    expect(show).toHaveBeenCalledWith({ title: "CPU high", body: "95%" });
  });

  it("does nothing without a title or when notifications are unsupported", () => {
    const notify = createNotifier({ isSupported, show });

    notify({ title: "" });
    isSupported.mockReturnValue(false);
    notify({ title: "ignored" });

    expect(show).not.toHaveBeenCalled();
  });
});
