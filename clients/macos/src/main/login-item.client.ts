import { app } from "electron";
import { z } from "zod";
import { handle } from "./ipc";
export const installLoginItem = (): void => {};
export const installLoginItemIpc = (): void => {
  handle(
    "vellum:launchAtLogin:get",
    z.tuple([]),
    () => app.getLoginItemSettings().openAtLogin,
  );
  handle("vellum:launchAtLogin:set", z.tuple([z.boolean()]), () => {
    throw new Error("Manage login items after private installation");
  });
};
