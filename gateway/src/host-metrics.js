import os from 'os';

function sumTicks(times) {
  return times.user + times.nice + times.sys + times.idle + times.irq;
}

export async function getHostMetrics() {
  const snapshot1 = os.cpus();

  await new Promise(resolve => setTimeout(resolve, 100));

  const snapshot2 = os.cpus();

  let totalIdle = 0;
  let totalTicks = 0;

  for (let i = 0; i < snapshot1.length; i++) {
    const idleDelta = snapshot2[i].times.idle - snapshot1[i].times.idle;
    const totalDelta = sumTicks(snapshot2[i].times) - sumTicks(snapshot1[i].times);
    totalIdle += idleDelta;
    totalTicks += totalDelta;
  }

  const cpuPercent =
    totalTicks === 0
      ? 0
      : Math.max(0, Math.min(100, 100 * (1 - totalIdle / totalTicks)));

  const memTotalMB = Math.round(os.totalmem() / 1024 / 1024);
  const memFreeMB = Math.round(os.freemem() / 1024 / 1024);

  return {
    cpuPercent,
    cpuCores: snapshot1.length,
    memTotalMB,
    memFreeMB,
    memUsedMB: memTotalMB - memFreeMB,
  };
}
