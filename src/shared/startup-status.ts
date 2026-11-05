export type StartupStatus = {
  mode: "writable" | "readOnly";
  message?: string;
  syncMessage?: string;
};
