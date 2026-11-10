/** OS-specific filesystem boundary. Injected contract results are not OS acceptance. */
export interface RuntimeStorePlatform {
  bind(directory: string): string;
  assertRoot(): void;
  assertDatabase(path: string): void;
  syncCreatedDatabase(path: string): void;
  close(): void;
}
