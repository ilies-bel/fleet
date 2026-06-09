import path from 'path';
import fs from 'fs';

/** Railpack frontend builder image — pinned tag for reproducible plan-based builds. */
const RAILPACK_FRONTEND_IMAGE = 'ghcr.io/railwayapp/railpack-frontend:latest';

/**
 * Select and run the correct docker build command for a feature subproject.
 *
 * Branches on plan presence:
 *   - railpack-plan.json present under fleetDir/subName
 *     → docker buildx build --load --no-cache
 *          --build-arg BUILDKIT_SYNTAX=<railpack-frontend>
 *          -t <imageTag> -f <planPath> <projectRoot/subName>
 *   - absent
 *     → docker build --load --no-cache
 *          -t <imageTag> -f Dockerfile.feature-base <contextDir>
 *       Dockerfile resolved: fleetDir/Dockerfile.feature-base first,
 *       then contextDir/Dockerfile.feature-base.
 *
 * @param {object}   opts
 * @param {string}   opts.subName     Feature key (subproject directory name).
 * @param {string}   opts.imageTag    Docker image tag to produce.
 * @param {string}   opts.contextDir  Build context for the fragment path (FLEET_ROOT).
 * @param {string}   opts.fleetDir    Absolute path to the .fleet directory
 *                                    (typically FLEET_PROJECT_ROOT/.fleet).
 * @param {function} opts.runCommand  (cmd: string, args: string[]) => Promise<void>
 * @returns {Promise<void>}
 */
export async function buildFeatureImage({ subName, imageTag, contextDir, fleetDir, runCommand }) {
  const planPath = path.join(fleetDir, subName, 'railpack-plan.json');

  if (fs.existsSync(planPath)) {
    // Generated build plan — delegate to the railpack frontend builder via buildx.
    const subProjectDir = path.join(path.dirname(fleetDir), subName);
    await runCommand('docker', [
      'buildx', 'build', '--load', '--no-cache',
      '--build-arg', `BUILDKIT_SYNTAX=${RAILPACK_FRONTEND_IMAGE}`,
      '-t', imageTag,
      '-f', planPath,
      subProjectDir,
    ]);
  } else {
    // Fragment (Dockerfile) path — project-local takes precedence over global.
    const projectDockerfile = path.join(fleetDir, 'Dockerfile.feature-base');
    const globalDockerfile = path.join(contextDir, 'Dockerfile.feature-base');
    const dockerfile = fs.existsSync(projectDockerfile) ? projectDockerfile : globalDockerfile;

    if (!fs.existsSync(dockerfile)) {
      throw new Error(
        `rebuild: Dockerfile not found at ${projectDockerfile} or ${globalDockerfile}`,
      );
    }

    await runCommand('docker', [
      'build', '--load', '--no-cache',
      '-t', imageTag,
      '-f', dockerfile,
      contextDir,
    ]);
  }
}
