/**
 * Docker Engine REST API client over Unix socket.
 * No npm dependencies — uses Node.js built-in http module.
 */
import http from 'http';

const SOCKET = '/var/run/docker.sock';
const API_VERSION = 'v1.43';
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJsu]/g;

/**
 * Make a raw HTTP request to the Docker socket.
 * @param {{ method: string, path: string, body?: object }} opts
 * @returns {Promise<{ status: number, buffer: Buffer }>}
 */
function dockerRequest({ method, path, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      { socketPath: SOCKET, method, path, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
      },
    );

    req.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new DockerSocketError('Docker socket not available — restart the gateway with fleet init'));
      } else {
        reject(err);
      }
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Parse Docker's multiplexed log stream format.
 * Each frame: [stream(1B), 0,0,0, size(4B big-endian), payload]
 * @param {Buffer} buf
 * @returns {string}
 */
function demuxDockerStream(buf) {
  const chunks = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    if (i + 8 + size > buf.length) break;
    chunks.push(buf.slice(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(chunks).toString('utf8').replace(ANSI_RE, '');
}

export class DockerSocketError extends Error {
  constructor(msg) { super(msg); this.name = 'DockerSocketError'; this.reasonCode = 'docker:socket-unavailable'; }
}

export class DockerContainerError extends Error {
  constructor(msg, status) { super(msg); this.name = 'DockerContainerError'; this.status = status; if (status === 404) this.reasonCode = 'docker:container-not-found'; }
}

/**
 * Run a command inside a container and return a streaming stdout with an abort handle.
 * Uses Tty:true so output is raw text without multiplexed frame headers.
 * Call abort() to destroy the HTTP stream and stop buffering.
 * @param {string} containerName
 * @param {string[]} cmd
 * @returns {Promise<{ stdout: import('http').IncomingMessage, abort: () => void }>}
 */
export async function dockerExecStream(containerName, cmd) {
  // Step 1: create exec instance (small buffered call)
  const createRes = await dockerRequest({
    method: 'POST',
    path: `/${API_VERSION}/containers/${containerName}/exec`,
    body: { AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd },
  });

  if (createRes.status === 404) {
    throw new DockerContainerError(`Container '${containerName}' not found`, 404);
  }
  if (createRes.status === 409) {
    throw new DockerContainerError(`Container '${containerName}' is not running`, 409);
  }
  if (createRes.status !== 201) {
    throw new Error(`Exec create failed: HTTP ${createRes.status}`);
  }

  const { Id: execId } = JSON.parse(createRes.buffer.toString('utf8'));

  // Step 2: start exec and return the raw response stream
  const reqBody = JSON.stringify({ Detach: false, Tty: true });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        method: 'POST',
        path: `/${API_VERSION}/exec/${execId}/start`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(reqBody),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => reject(new Error(`Exec start failed: HTTP ${res.statusCode}`)));
          return;
        }
        resolve({ stdout: res, abort: () => res.destroy() });
      },
    );
    req.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new DockerSocketError('Docker socket not available — restart the gateway with fleet init'));
      } else {
        reject(err);
      }
    });
    req.write(reqBody);
    req.end();
  });
}

/**
 * Run a command inside a container and return a streaming result with an exit-code
 * promise — analogous to child_process.spawn but for docker exec.
 *
 * After the stdout stream closes, the exec is inspected via GET /exec/{id}/json to
 * obtain the process exit code. The exitCode promise resolves with that code (or 0
 * if the inspect call cannot determine it) and rejects only on inspect I/O failure.
 *
 * @param {string} containerName
 * @param {string[]} cmd
 * @returns {Promise<{ stdout: import('http').IncomingMessage, abort: () => void, exitCode: Promise<number> }>}
 */
export async function dockerExecStreamWithExitCode(containerName, cmd) {
  const createRes = await dockerRequest({
    method: 'POST',
    path: `/${API_VERSION}/containers/${containerName}/exec`,
    body: { AttachStdin: false, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd },
  });

  if (createRes.status === 404) {
    throw new DockerContainerError(`Container '${containerName}' not found`, 404);
  }
  if (createRes.status === 409) {
    throw new DockerContainerError(`Container '${containerName}' is not running`, 409);
  }
  if (createRes.status !== 201) {
    throw new Error(`Exec create failed: HTTP ${createRes.status}`);
  }

  const { Id: execId } = JSON.parse(createRes.buffer.toString('utf8'));

  const reqBody = JSON.stringify({ Detach: false, Tty: true });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        method: 'POST',
        path: `/${API_VERSION}/exec/${execId}/start`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(reqBody),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => reject(new Error(`Exec start failed: HTTP ${res.statusCode}`)));
          return;
        }

        let resolveExitCode, rejectExitCode;
        const exitCode = new Promise((rs, rj) => { resolveExitCode = rs; rejectExitCode = rj; });

        res.on('close', () => {
          dockerRequest({ method: 'GET', path: `/${API_VERSION}/exec/${execId}/json` })
            .then((inspectRes) => {
              try {
                const info = JSON.parse(inspectRes.buffer.toString('utf8'));
                resolveExitCode(typeof info.ExitCode === 'number' ? info.ExitCode : 0);
              } catch {
                resolveExitCode(0);
              }
            })
            .catch(rejectExitCode);
        });

        resolve({ stdout: res, abort: () => res.destroy(), exitCode });
      },
    );
    req.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        reject(new DockerSocketError('Docker socket not available — restart the gateway with fleet init'));
      } else {
        reject(err);
      }
    });
    req.write(reqBody);
    req.end();
  });
}

/**
 * Run a command inside a container and return its stdout as a string.
 * Uses Tty:true so output is raw text without multiplexed frame headers.
 * @param {string} containerName
 * @param {string[]} cmd
 * @returns {Promise<string>}
 */
export async function dockerExec(containerName, cmd) {
  const { stdout } = await dockerExecStream(containerName, cmd);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve(Buffer.concat(chunks).toString('utf8').replace(ANSI_RE, ''));
    };
    stdout.on('data', (c) => chunks.push(c));
    stdout.on('end', done);
    stdout.on('close', done);
    stdout.on('error', reject);
  });
}

/**
 * List containers whose name matches the given prefix filter.
 * @param {string} nameFilter  e.g. 'fleet-'
 * @param {{ all?: boolean }} opts  all=true includes stopped containers
 * @returns {Promise<object[]>}  raw Docker container list entries
 */
export async function listRunningContainers(nameFilter, { all = false } = {}) {
  const filters = encodeURIComponent(JSON.stringify({ name: [nameFilter] }));
  const allParam = all ? '&all=1' : '';
  const res = await dockerRequest({
    method: 'GET',
    path: `/${API_VERSION}/containers/json?filters=${filters}${allParam}`,
  });
  if (res.status !== 200) throw new Error(`Container list failed: HTTP ${res.status}`);
  return JSON.parse(res.buffer.toString('utf8'));
}

/**
 * Inspect a single container and return its full JSON descriptor, or null if not found.
 * @param {string} containerName
 * @returns {Promise<object|null>}
 */
export async function inspectContainer(containerName) {
  const res = await dockerRequest({
    method: 'GET',
    path: `/${API_VERSION}/containers/${containerName}/json`,
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`Container inspect failed: HTTP ${res.status}`);
  return JSON.parse(res.buffer.toString('utf8'));
}

/**
 * Stop a running container. No-op if already stopped (Docker returns 304).
 * @param {string} containerName
 * @returns {Promise<void>}
 */
export async function stopContainer(containerName) {
  const res = await dockerRequest({
    method: 'POST',
    path: `/${API_VERSION}/containers/${containerName}/stop`,
  });
  if (res.status === 404) throw new DockerContainerError(`Container '${containerName}' not found`, 404);
  if (res.status !== 204 && res.status !== 304) {
    throw new Error(`Container stop failed: HTTP ${res.status}`);
  }
}

/**
 * Start a stopped container.
 * @param {string} containerName
 * @returns {Promise<void>}
 */
export async function startContainer(containerName) {
  const res = await dockerRequest({
    method: 'POST',
    path: `/${API_VERSION}/containers/${containerName}/start`,
  });
  if (res.status === 404) throw new DockerContainerError(`Container '${containerName}' not found`, 404);
  if (res.status !== 204 && res.status !== 304) {
    throw new Error(`Container start failed: HTTP ${res.status}`);
  }
}

/**
 * Fetch a one-shot resource stats snapshot for a container.
 * Returns { cpuPercent, memUsageMB, memLimitMB, netRxMB, netTxMB }
 * @param {string} containerName
 * @returns {Promise<{ cpuPercent: number, memUsageMB: number, memLimitMB: number, netRxMB: number, netTxMB: number }>}
 */
export async function getContainerStats(containerName) {
  const res = await dockerRequest({
    method: 'GET',
    path: `/${API_VERSION}/containers/${containerName}/stats?stream=false`,
  });
  if (res.status === 404) throw new DockerContainerError(`Container '${containerName}' not found`, 404);
  if (res.status === 409) throw new DockerContainerError(`Container '${containerName}' is not running`, 409);
  if (res.status !== 200) throw new Error(`Stats failed: HTTP ${res.status}`);

  const s = JSON.parse(res.buffer.toString('utf8'));

  // Some Docker versions return 200 with null cpu_stats for stopped containers
  if (!s.cpu_stats?.cpu_usage) {
    throw new DockerContainerError(`Container '${containerName}' is not running`, 409);
  }

  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
  const numCpus = s.cpu_stats.online_cpus ?? s.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * numCpus * 100 : 0;

  const MB = 1024 * 1024;
  const memUsageMB = (s.memory_stats.usage ?? 0) / MB;
  const memLimitMB = (s.memory_stats.limit ?? 0) / MB;

  let netRxMB = 0;
  let netTxMB = 0;
  if (s.networks) {
    for (const iface of Object.values(s.networks)) {
      netRxMB += (iface.rx_bytes ?? 0) / MB;
      netTxMB += (iface.tx_bytes ?? 0) / MB;
    }
  }

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memUsageMB: Math.round(memUsageMB * 10) / 10,
    memLimitMB: Math.round(memLimitMB),
    netRxMB: Math.round(netRxMB * 100) / 100,
    netTxMB: Math.round(netTxMB * 100) / 100,
  };
}

/**
 * Stop and remove a container (force=true handles running containers).
 * @param {string} containerName
 * @returns {Promise<void>}
 */
export async function removeContainer(containerName) {
  const res = await dockerRequest({
    method: 'DELETE',
    path: `/${API_VERSION}/containers/${containerName}?force=true`,
  });
  if (res.status === 404) throw new DockerContainerError(`Container '${containerName}' not found`, 404);
  if (res.status !== 204) {
    throw new Error(`Container remove failed: HTTP ${res.status}`);
  }
}

/**
 * Fetch container logs (stdout+stderr combined) with optional tail and since filters.
 * @param {string} containerName
 * @param {number} tail  max lines to return
 * @param {number} since unix timestamp in seconds; 0 = no filter
 * @returns {Promise<string>}
 */
export async function dockerLogs(containerName, tail, since) {
  const qs = new URLSearchParams({
    stdout: '1',
    stderr: '1',
    tail: String(tail),
    timestamps: '0',
  });
  if (since > 0) qs.set('since', String(since));

  const res = await dockerRequest({
    method: 'GET',
    path: `/${API_VERSION}/containers/${containerName}/logs?${qs}`,
  });

  if (res.status === 404) {
    throw new DockerContainerError(`Container '${containerName}' not found`, 404);
  }
  if (res.status === 409) {
    throw new DockerContainerError(`Container '${containerName}' is not running`, 409);
  }
  if (res.status !== 200) {
    throw new Error(`Docker logs failed: HTTP ${res.status}`);
  }

  return demuxDockerStream(res.buffer);
}
