export function nextLocalOccurrence(hour: number, from: Date): Date {
  const next = new Date(from);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export interface DailyTask {
  stop(): void;
}

export function scheduleDailyLocal(
  hour: number,
  task: () => void | Promise<void>,
  opts: { now?: () => number; onError?: (e: unknown) => void } = {},
): DailyTask {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    const now = opts.now?.() ?? Date.now();
    const delayMs = Math.max(0, nextLocalOccurrence(hour, new Date(now)).getTime() - now);
    timer = setTimeout(() => {
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => opts.onError?.(error))
        .finally(arm);
    }, delayMs);
    timer.unref();
  };

  arm();
  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
