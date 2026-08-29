import { describe, expect, it } from "vitest";
import { shouldScheduleCoordinatorNotification } from "./notification.js";

describe("coordinator notification scheduling", () => {
  it("serializes delivery while preserving pending work", () => {
    expect(
      shouldScheduleCoordinatorNotification({
        shuttingDown: false,
        pendingUpdates: 1,
        timerActive: false,
        deliveryInFlight: false,
      }),
    ).toBe(true);
    expect(
      shouldScheduleCoordinatorNotification({
        shuttingDown: false,
        pendingUpdates: 1,
        timerActive: false,
        deliveryInFlight: true,
      }),
    ).toBe(false);
    expect(
      shouldScheduleCoordinatorNotification({
        shuttingDown: false,
        pendingUpdates: 1,
        timerActive: true,
        deliveryInFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldScheduleCoordinatorNotification({
        shuttingDown: false,
        pendingUpdates: 0,
        timerActive: false,
        deliveryInFlight: false,
      }),
    ).toBe(false);
  });
});
