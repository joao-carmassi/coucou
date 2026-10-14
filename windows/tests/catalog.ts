// Node has no import.meta.glob: read the manifests from disk and feed the pure resolver.
import { readdirSync, readFileSync } from "node:fs";
import { buildCatalog, type Manifest } from "../src/modules/resolve.ts";

const dir = new URL("../src/modules/", import.meta.url);
export const manifests: (Manifest | Manifest[])[] = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => { try { return [JSON.parse(readFileSync(new URL(`${d.name}/manifest.json`, dir), "utf8"))]; } catch { return []; } });

/** The catalog of a debug build (devOnly modules included) or a release one. */
export const catalog = (dev: boolean) => buildCatalog(manifests, dev);
/** What the shipped modules resolve to: the release catalog. */
export const MODULE_INFO = catalog(false);
