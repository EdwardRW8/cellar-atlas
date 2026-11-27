/** Type contract for connection.mjs. */
export declare function pgEnvFromUrl(
  url: string | undefined,
  opts?: { caCertPath?: string | null },
): Record<string, string>;
export declare function isSecureSslmode(mode: string): boolean;
export declare function describeTarget(env: Record<string, string>): string;
