// Private builds never select the public CLI or manage shared installation state.
declare const __VELLUM_PRIVATE_CLI_ENTRY__: string;
export const PRIVATE_CANDIDATE = true;
export const PRIVATE_CLI_ENTRY =
  typeof __VELLUM_PRIVATE_CLI_ENTRY__ === "string"
    ? __VELLUM_PRIVATE_CLI_ENTRY__
    : "";
