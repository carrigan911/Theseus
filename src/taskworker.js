// Runs repo.tasksRead off the main process (repo.js viaWorker): a big transcript is ~0.5 s of parsing.
const { parentPort } = require('worker_threads');
const { tasksRead } = require('./repo');
parentPort.on('message', async ({ id, file }) => {
  let r = null; try { r = await tasksRead(file); } catch {}   // null: the main process reads it itself
  parentPort.postMessage({ id, r });
});
