import {existsSync} from 'node:fs';
import {BUNDLED_SPEC} from '../src/index.js';

const fromEnv = process.env.PZDESK_SPEC && !/^https?:\/\//i.test(process.env.PZDESK_SPEC) ? process.env.PZDESK_SPEC : null;

/** The OpenAPI file the tests run against: PZDESK_SPEC (a file) or the local openapi.yaml copy. */
export const SPEC = fromEnv ?? BUNDLED_SPEC;

/** Pass as test options. The vendor's API description is not part of this repository. */
export const skipWithoutSpec = existsSync(SPEC)
  ? false
  : 'No OpenAPI file. Run "PZDESK_URL=https://your-helpdesk npm run sync" or set PZDESK_SPEC to a swagger.yaml file.';
