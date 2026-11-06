// A promise queue: tasks run one at a time, in the order they were added. A failing task never blocks the next one.
// Used by the window host so two settings saves never run their read-edit-rename child processes at the same time.
/**
 * @returns {(task: () => Promise<any>) => Promise<any>} add(task): resolves/rejects with the task's own result once it has run.
 */
function createQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

module.exports = { createQueue };
