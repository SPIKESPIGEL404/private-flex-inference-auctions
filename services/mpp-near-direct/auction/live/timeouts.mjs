// Bound coordinator waits. A timeout never proves an external effect failed.
export async function bounded(promise, milliseconds = 20000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("original_operation_timeout_unknown")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
