export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

type ResponseConsumer<T> = (response: Response) => Promise<T> | T;

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {
    const error = new Error('Kassinão request timed out. Try again in a moment.');
    error.name = 'TimeoutError';
    return error;
  }
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Kassinão request was cancelled.');
  error.name = 'AbortError';
  return error;
}

function waitWithSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(operation).catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Nunca permite redirects nem espera indefinida. O consumidor precisa terminar
 * de ler o body dentro do callback, para o mesmo deadline cobrir headers + body.
 */
export async function strictFetch<T>(
  input: string | URL | Request,
  init: RequestInit,
  consume: ResponseConsumer<T>,
): Promise<T> {
  const explicitSignal = init.signal ?? undefined;
  const controller = new AbortController();
  const signal = controller.signal;
  const forwardExplicitAbort = (): void => controller.abort(explicitSignal?.reason);
  let response: Response | undefined;

  if (explicitSignal?.aborted) forwardExplicitAbort();
  else explicitSignal?.addEventListener('abort', forwardExplicitAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Kassinão request timed out.', 'TimeoutError'));
  }, DEFAULT_HTTP_TIMEOUT_MS);
  timeout.unref();
  try {
    response = await waitWithSignal(fetch(input, { ...init, redirect: 'error', signal }), signal);
    return await waitWithSignal(Promise.resolve(consume(response)), signal);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw error;
  } finally {
    clearTimeout(timeout);
    explicitSignal?.removeEventListener('abort', forwardExplicitAbort);
    if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => undefined);
  }
}
