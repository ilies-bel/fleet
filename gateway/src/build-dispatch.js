import path from 'path';
import fs from 'fs';

/** Railpack frontend builder image — pinned tag for reproducible plan-based builds. */
const RAILPACK_FRONTEND_IMAGE = 'ghcr.io/railwayapp/railpack-frontend:latest';

/**
 * Select and run the correct docker build command for a feature subproject.
 *
 * Requires a railpack plan file under fleetDir/subName/railpack-plan.json.
 * Throws if the plan is absent — fragment Dockerfiles are no longer supported.
 *
 *   - railpack-plan.json present under fleetDir/subName
 *     → docker buildx build --load --no-cache
 *          --build-arg BUILDKIT_SYNTAX=<railpack-frontend>
 *          -t <imageTag> -f <planPath> <projectRoot/subName>
 *   - absent → throws Error with a clear message.
 *
 * @param {object}   opts
 * @param {string}   opts.subName     Feature key (subproject directory name).
 * @param {string}   opts.imageTag    Docker image tag to produce.
 * @param {string}   opts.contextDir  Build context (FLEET_ROOT).
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
    throw new Error(`no railpack plan for ${subName}`);
  }
}
