export interface CoordinatorNotificationScheduleState {
  shuttingDown: boolean;
  pendingUpdates: number;
  timerActive: boolean;
  deliveryInFlight: boolean;
  audiencePresent: boolean;
}

export const shouldScheduleCoordinatorNotification = (
  state: CoordinatorNotificationScheduleState,
): boolean =>
  !state.shuttingDown &&
  state.pendingUpdates > 0 &&
  !state.timerActive &&
  !state.deliveryInFlight &&
  state.audiencePresent;
