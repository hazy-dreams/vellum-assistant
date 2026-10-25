import { z } from "zod";
import { handle } from "./ipc";
export type {
  UpdateState,
  UpdateStatus,
} from "@vellumai/electron-desktop/auto-update";
export const checkForUpdates = (): void => {};
export const installAutoUpdate = (): void => {
  handle("vellum:update:getState", z.tuple([]), () => ({
    status: "idle" as const,
  }));
  handle("vellum:update:check", z.tuple([]), () => {});
  handle("vellum:update:install", z.tuple([]), () => {});
};
