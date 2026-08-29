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
        audiencePresent: true,
      }),
    ).toBe(true);
    expect(
      shouldScheduleCoordinatorNotification({
        shuttingDown: false,
        pendingUpdates: 1,
        timerActive: false,
        deliveryInFlight: true,
        audiencePresent: true,
      }),
    ).toBe(false);
    expect(
      shouldScheduleCoordinatorNotification({
        shuttingDown: false,
        pendingUpdates: 1,
        timerActive: true,
        deliveryInFlight: false,
        audiencePresent: true,
      }),
    ).toBe(false);
    expect(
      shouldScheduleCoordinatorNotification({
        shuttingDown: false,
        pendingUpdates: 0,
        timerActive: false,
        deliveryInFlight: false,
        audiencePresent: true,
      }),
    ).toBe(false);
    expect(
      shouldScheduleCoordinatorNotification({
        shuttingDown: false,
        pendingUpdates: 1,
        timerActive: false,
        deliveryInFlight: false,
        audiencePresent: false,
      }),
    ).toBe(false);
  });
});
