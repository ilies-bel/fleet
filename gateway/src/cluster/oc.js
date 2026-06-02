/**
 * OpenShift/Kubernetes cluster operations wrapper.
 *
 * All cluster access routes through this module so RBAC/auth handling lives
 * in exactly one place. Set FLEET_OC_BIN to override the oc binary path
 * (useful for testing).
 */

import { spawn } from 'node:child_process';

const ocBin = () => process.env.FLEET_OC_BIN || 'oc';

/**
 * Run an oc command, collecting stdout. Resolves with stdout, rejects on non-zero exit.
 * @param {string[]} args
 * @param {{ stdin?: string }} [opts]
 * @returns {Promise<string>}
 */
function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ocBin(), args);
    const stdoutBufs = [];
    const stderrBufs = [];
    child.stdout.on('data', chunk => stdoutBufs.push(chunk));
    child.stderr.on('data', chunk => stderrBufs.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        const msg = Buffer.concat(stderrBufs).toString().trim();
        reject(new Error(`oc ${args[0]} exited with code ${code}: ${msg}`));
      } else {
        resolve(Buffer.concat(stdoutBufs).toString());
      }
    });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/**
 * Apply a manifest to the cluster via stdin.
 * @param {string} manifest - YAML or JSON manifest string
 * @returns {Promise<string>} oc output
 */
export function apply(manifest) {
  return run(['apply', '-f', '-'], { stdin: manifest });
}

/**
 * Get the phase of a pod.
 * @param {string} name - pod name
 * @param {string} ns - namespace
 * @returns {Promise<string>} pod phase (e.g. "Running")
 */
export async function getPodStatus(name, ns) {
  const out = await run(['get', 'pod', name, '-n', ns, '-o', 'jsonpath={.status.phase}']);
  return out.trim();
}

/**
 * Rsync a local directory to a pod path, streaming progress lines to a logger.
 * Rejects if oc rsync exits with a non-zero code.
 * @param {string} localDir - local source directory
 * @param {string} podName - target pod name
 * @param {string} podPath - destination path inside the pod
 * @param {string} ns - namespace
 * @param {{ info: Function }} [logger] - optional logger (defaults to console)
 * @returns {Promise<void>}
 */
export function rsync(localDir, podName, podPath, ns, logger = console) {
  return new Promise((resolve, reject) => {
    const child = spawn(ocBin(), ['rsync', localDir, `${podName}:${podPath}`, '-n', ns]);
    child.stdout.on('data', chunk => logger.info(chunk.toString()));
    child.stderr.on('data', chunk => logger.info(chunk.toString()));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`oc rsync exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Execute a command inside a pod.
 * @param {string} podName - pod name
 * @param {string} ns - namespace
 * @param {string[]} argv - command and arguments to execute in the pod
 * @returns {Promise<string>} stdout output
 */
export function exec(podName, ns, argv) {
  return run(['exec', podName, '-n', ns, '--', ...argv]);
}

/**
 * Port-forward a service to a kernel-assigned local port.
 *
 * Uses local port 0 (0:<remotePort>) so the kernel picks a free port.
 * Parses the assigned port from oc's "Forwarding from 127.0.0.1:PORT" line.
 * The returned stop() sends SIGTERM and waits for the child to exit.
 *
 * @param {string} svcName - service name
 * @param {string} ns - namespace
 * @param {number} remotePort - remote port to forward
 * @returns {Promise<{localPort: number, stop: () => Promise<void>}>}
 */
export function portForward(svcName, ns, remotePort) {
  return new Promise((resolve, reject) => {
    const child = spawn(ocBin(), ['port-forward', `svc/${svcName}`, `0:${remotePort}`, '-n', ns]);
    let resolved = false;
    let lineBuf = '';

    child.stdout.on('data', chunk => {
      if (resolved) return;
      // Buffer output to handle partial chunks across TCP boundaries.
      lineBuf += chunk.toString();
      const match = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(lineBuf);
      if (!match) return;
      resolved = true;
      const localPort = parseInt(match[1], 10);
      // exitPromise resolves (with the exit code) whenever the child exits,
      // whether expectedly (after stop()) or unexpectedly (crash). Callers
      // that need crash-detection should watch this promise.
      const exitPromise = new Promise(res => child.once('close', res));
      resolve({
        localPort,
        exitPromise,
        stop: () => {
          if (child.exitCode !== null) return Promise.resolve();
          return new Promise(res => {
            child.once('close', res);
            child.kill('SIGTERM');
          });
        },
      });
    });

    child.on('error', err => {
      if (!resolved) reject(err);
    });

    child.on('close', code => {
      if (!resolved) {
        reject(new Error(`oc port-forward exited with code ${code} before port was bound`));
      }
    });
  });
}

/**
 * Delete a pod.
 * @param {string} name - pod name
 * @param {string} ns - namespace
 * @returns {Promise<string>} oc output
 */
export function deletePod(name, ns) {
  return run(['delete', 'pod', name, '-n', ns]);
}

/**
 * Delete a service.
 * @param {string} name - service name
 * @param {string} ns - namespace
 * @returns {Promise<string>} oc output
 */
export function deleteService(name, ns) {
  return run(['delete', 'service', name, '-n', ns]);
}
