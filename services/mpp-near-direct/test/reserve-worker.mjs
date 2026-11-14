import { workerData, parentPort } from 'node:worker_threads';
import { Harness } from './authority.mjs';
const h = new Harness(workerData.path);
try { h.reserve(workerData.reservation); parentPort.postMessage('reserved'); }
catch (e) { parentPort.postMessage(e.message); }
finally { h.close(); }
